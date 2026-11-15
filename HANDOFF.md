# GridSentinel ETL handoff

Owner of Git: whoever picks this up. Implementation was paused mid-tranche, so read
"Implemented" and "Half-finished" before assuming anything works end to end.

Branch and PR
- Branch `feat/app-verified`, open PR **#4** (`Verified end-to-end app: 3D pillar
  targeting fix, PR #2 data alignment, build cleanup`).
- Do **not** push to `app/area-scan` (PR #2) or `main` from this work.
- Working tree also carries concurrent feature work (README, `app/globals.css`,
  `components/energy/TelemetryTab.tsx`, `lib/risk.ts`, `app/location-report/*`).
  Keep it; it ships with the same feature.
- Never stage `.merge-wt/`, `.playwright-cli/`, `research/etl-state/`, or `shots/`.

## Goal

Deterministic ETL for arbitrary coordinates: verifiable sources, offline replay,
recovery, and source-paced browser updates. Pilot covers Westminster High School,
downtown LA, and a second U.S. region. Publisher scope, interval, units and
timestamps are preserved. Model outputs and operator inputs are labelled. Missing
facts stay unavailable instead of being guessed.

## Implemented and verified

- Location collection and replay: `research/etl/pipeline.ts`. Immutable
  checksummed captures, quarantine, fallback to last verified snapshot, pinned
  revisions, evidence verification, deterministic offline replay.
- Feeds in `research/etl/sources.ts`: Census geography, one NWS station
  observation, NWS active alerts (verified zero vs failed fetch, paginated
  responses rejected rather than partially counted), EIA Atlas plant count, HIFLD
  substation and 69 kV+ transmission counts, optional EIA-930 hourly demand and
  fuel by explicit respondent. Freshness uses observation time; EIA and CAISO
  periods keep their published clock basis.
- Assets: `research/etl/assets.ts` captures ArcGIS object-ID inventories and
  feature pages, verifies completeness, replays offline. `load-assets.ts`
  normalizes fields, keeps per-field and per-geometry citations, publishes an
  immutable inventory revision with `latest` pointer.
- Substation audit: `research/etl/substation-audit.ts` requires reviewed
  OSM↔HIFLD crosswalks tied to captured records, keeps owner separate from
  operator and HIFLD `MAX_VOLT` separate from OSM voltage tags.
- Weather: `research/etl/weather-history.ts` stores Open-Meteo ERA5 bytes,
  validates hourly coverage and units, labels the product `modeled_reanalysis`,
  keeps the grid cell and locators. Numeric values are copied unmodified.
- Backup/restore: `research/etl/backup.ts` (AES-256-GCM) for reports, loaded
  assets and weather archives; restore verifies checksums and republishes.
- Service: `research/etl/service.py` runs separate opt-in telemetry and inventory
  workers, bounded concurrency, Redis Pub/Sub on a per-location channel, separate
  latest keys for state and inventory, both replayed to reconnecting clients.
- Coverage: `research/etl/coverage.ts` inventories shipped artifacts;
  `coverage --strict` exits 1 while gaps remain.

Verification at handoff: `tsc --noEmit` clean; 7 ETL tests pass
(`pipeline.test.ts`, `assets.test.ts`); strict Westminster evidence replay
reproduces 378 claims from 5 snapshots.

## Added in the paused tranche (compiles, not yet wired or tested)

- `research/etl/http.ts` — shared request layer. Identical in-flight requests are
  fetched once per process, per-host concurrency is bounded
  (`ETL_HTTP_HOST_CONCURRENCY`, default 4), failures retry with exponential
  backoff (`ETL_HTTP_RETRY_BASE_MS`, `ETL_HTTP_RETRY_ATTEMPTS`) honouring
  `Retry-After`, and unchanged resources are revalidated with
  `If-None-Match`/`If-Modified-Since` so a 5-minute loop reuses captured bytes on
  `304`. `pipeline.request()` now routes through it and returns `{ bytes, headers }`;
  `assets.ts` and `weather-history.ts` were updated to the new shape.
  **No test file yet.** Write `research/etl/http.test.ts` covering dedupe,
  revalidation, 429 backoff and the host cap (mock `globalThis.fetch`).
- `research/etl/caiso.ts` — CAISO Today's Outlook five-minute feeds
  (`current/demand.csv`, `current/fuelsource.csv`). Header-name column matching
  (never positional), RFC 4180 subset parser, fail-closed on a missing `Time`
  column or ragged rows, system-wide scope in every caveat, negative battery and
  import values preserved. Operating date is derived from the snapshot's
  `retrieved_at` in `America/Los_Angeles` with a midnight rollover guard, so replay
  is stable; `pacificInstant()` resolves DST and rejects impossible wall times.
- Feed contract grew `parser?` and `accept?`, and `observationTime(data, retrievedAt)`
  now receives the capture instant. `pipeline.capture()` honours both.
- `lib/evidence/predicates.ts` gained `caiso.system_demand_mw`,
  `caiso.system_net_demand_mw` and `caiso.supply_<resource>_mw` for the 14
  published resource columns.
- `research/etl/geometry.ts` — study-radius clipping for linear assets:
  `clipLine`, `clipFeature`, `greatCircleMiles`, `polylineMiles`, `voltageBand`.
  Segments crossing the circle with both endpoints outside are clipped correctly;
  mileage is geodesic length of the inside portion through a local tangent plane
  (≈0.03% projection error at 100 mi, documented in the module).

Not yet wired: no `--caiso` CLI flag and no `caiso` field in the FastAPI
`Location` model, so `caisoFeeds()` is currently unreachable outside tests.
`geometry.ts` is not yet imported by `load-assets.ts`, so loaded asset revisions
still contain full provider geometry with no clipped mileage.

## Remaining work, in the order it should be taken

1. Finish the paused tranche.
   - `cli.ts`: accept `--caiso` and pass it as the fifth argument to
     `locationQuery`. `service.py`: add `caiso` to the `Location` model and append
     `--caiso` to the CLI arguments. Document `ETL_HTTP_*` settings.
   - `load-assets.ts`: call `clipFeature(query.center, query.radius_miles, geometry)`
     per record and per dataset `mileage` (total, by voltage band, clipped vs
     outside counts). Add `research/etl/geometry.test.ts` with a synthetic
     crossing line, a fully-inside line, a fully-outside line and a band check.
2. Live feeds still missing.
   - CAISO OASIS (`SingleZip`, `resultformat=6`) returns a ZIP archive; it needs a
     dependency-free inflate reader before `PRC_INTVL_LMP` / `PRC_LMP` market and
     congestion series can be captured. Keep node, market, interval and units
     explicit; never substitute system demand for a nodal price series.
   - EIA-930 bulk-file fallback as same-publisher backup; verify the API time
     convention before reporting observation age; FERC-714 only as a historical
     cross-check after respondent, footprint and interval match.
   - NOAA NCEI station history distinct from gridded/modeled weather; CPUC
     fire-threat polygons; eGRID boundaries and factors; EPA CAMPD emissions.
3. Inventory regeneration.
   - Rebuild `public/layers/*.geojson` from pinned OSM regional extracts (Overpass
     only for small discovery queries), preserving element IDs, versions, raw tags
     and geometry, then diff against the committed artifacts and explain every
     difference.
   - Import EIA-860/860M workbooks and EIA-923 by published plant/generator ID;
     distinguish planned retirements from completed status; reporting year pinned.
   - Obtain a real HIFLD capture, verify field definitions, and build reviewed
     substation crosswalks. 799 of 1,271 bundled OSM substations have no name and
     no successful live HIFLD capture exists yet, so nothing can be corroborated.
4. Transform and load.
   - Join plants/generators/retirements to loaded assets; generate line-rating
     inputs from archived weather through the existing thermal engine; feed loaded
     assets into the map, area scan and simulator (they currently read bundled
     layers only).
   - Automatic provider reconciliation inside reports: `reconcile.ts` exists but is
     only invoked by the `compare` CLI command. Persist comparisons, show
     agreement/conflict/incomparable in the citation UI, and never average a
     disagreement.
   - Operator imports for topology, equipment ratings and condition, meters and
     quotes, with issuer, date, scope and visibility recorded.
5. Delivery and recovery.
   - Cross-process request deduplication (Redis) — `http.ts` is only process-local.
   - Scheduled asset and weather backups alongside report backups.
   - Prove live ingestion in Westminster, downtown LA and a second U.S. region with
     Redis reconnect, browser citation rendering, outage fallback and clean-namespace
     restore. Live provider collection and Redis→browser delivery have **never**
     been verified on this machine: CAISO, NWS and ArcGIS returned `ENOTFOUND`
     from the workspace runtime, no `EIA_API_KEY` was configured, and Docker was
     unavailable, so no Redis was running.

## Commands

```bash
git status --short
node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false
node node_modules/tsx/dist/cli.mjs --test research/etl/assets.test.ts research/etl/pipeline.test.ts
npm run evidence:verify:files
node node_modules/tsx/dist/cli.mjs research/etl/cli.ts coverage --strict
npx tsx research/etl/cli.ts collect --lat 33.7538 --lon -118.0111 --radius 100 --respondent CISO
npx tsx research/etl/cli.ts assets hifld-transmission 33.7538 -118.0111 100
npx tsx research/etl/cli.ts load-assets <asset-manifest-path>
npm run build
```

Env: `EIA_API_KEY`, `NWS_USER_AGENT` (contact-bearing), `ETL_LOCATIONS`,
`ETL_ASSET_LOCATIONS`, `ETL_BACKUP_KEY` (32-byte hex), `ETL_BACKUP_DIRECTORY`,
`ETL_STATE_NAMESPACE`, `REDIS_URL`, `ETL_BROWSER_ORIGINS`, `ETL_HTTP_*`.
See `research/etl/README.md` for semantics.

## Concerns found while landing this branch (fix these)

### Bugs

1. `research/etl/http.ts` retry classification is too narrow. A timeout or abort
   from `fetch` rejects with messages like "The operation was aborted due to
   timeout", which `/^(fetch failed|aborted)/i` does not match, so DNS failures
   and timeouts are never retried. Match on the error `name`
   (`TimeoutError`/`AbortError`/`TypeError`) instead of prose.
2. `research/etl/http.ts` holds the per-host slot while it backs off: the
   `await sleep(wait)` sits in `catch`, which runs before the `finally` that
   releases the slot. One rate-limited request therefore blocks every other
   request to that host for the whole backoff. Release first, then wait.
3. `research/etl/http.ts` revalidates every request by URL + `accept` but keeps
   up to 256 response bodies in memory with no byte accounting; worst case is
   hundreds of MiB on a long inventory run. Cap by total bytes, not entries.
4. `research/etl/http.ts` now forces `redirect: "error"` for all providers. A
   provider that answers with a 302 (CAISO in particular) fails the capture
   outright. Decide per source whether redirects are followed and to which
   allowlisted origin, instead of one global policy.
5. `research/etl/service.py` recovers the published revision with
   `json.loads(stderr.decode().strip().splitlines()[-1])`. Any extra stderr line
   (Node warning, retry notice) breaks the backup step. Parse the whole stderr
   for the last line that is valid JSON, or print the revision on stdout behind
   a delimiter.
6. `research/etl/service.py` spawns one `node` subprocess per location per
   60-second tick, sequentially and without an overlap guard. A slow location
   delays every later one, and per-feed intervals are enforced inside the CLI
   rather than by the scheduler. Move cadence into the worker and bound
   concurrency the way the inventory worker already does.
7. `app/api/location-report/[id]/assets/route.ts` ignores the report's own
   revision linkage: any `?revision=` of that location is served. Acceptable for
   the pilot, wrong for a shared citation: bind the served revision to the one
   the report was built against.

### Data correctness and provenance

1. 799 of 1,271 bundled OSM substations have no name, and no live HIFLD capture
   has ever succeeded on this machine, so nothing has been corroborated. Do not
   present an OSM name or operator as verified, and do not infer a missing asset
   from a missing record.
2. No live provider collection has been proven from here: CAISO, NWS and ArcGIS
   returned `ENOTFOUND`, no `EIA_API_KEY` existed, and Docker/Redis were
   unavailable. Everything time-series is replay-tested only.
3. The CAISO adapter has never parsed a real file. Only `Time` and the demand
   columns are certain; other supply columns are matched by documented header
   name and an unrecognized header is silently unreported, so a CAISO rename
   would under-report instead of failing. Add a minimum-recognized-column check.
4. EIA hourly telemetry still has an unverified clock basis, so it reports
   `local-unknown` and can never be called fresh. Verify the API convention
   before showing an age for it.
5. `coverage --strict` exits 1 by design: hourly rating CSV regeneration,
   field-level seed/case provenance, simulator input inventory and operator
   imports are all still open.
6. `load-assets` publishes whole provider geometry and no clipped mileage, so
   any mileage computed from an asset revision today overstates length for lines
   that only cross the study circle.
7. CAISO values are system-wide telemetry and CAISO states they do not reconcile
   to OASIS. Never present them as local demand, local mix, or market price.

### Merge and coordination risk

1. `lib/scan` exists on both PR #2 (`app/area-scan`) and this branch with
   different contents. PR #2 additionally has `areaScan.ts`, `compliance.ts`,
   `locationReport.ts`, `target.ts`, `useWeatherSample.ts`, `weather.ts` and
   `wire.ts` which this branch does not, while `types.ts`, `sources.ts`,
   `rating.ts` and `risk.ts` are separate copies. `app/location-report/*` is
   edited on both. The copy here came from `.merge-wt` at `6726835`, **not** from
   the PR #2 tip `27a2f02`. Expect a manual reconciliation, not a clean merge.
2. PR #3 (`data/eia860-hifld-pipeline`) ships 50 Python-pipeline paths plus
   `research/clean/*.csv`, `research/layers/*.geojson` and
   `research/manifest.json`. That is a second EIA-860/HIFLD ingest next to
   `research/etl`. Pick one owner before merging; until then those cleaned CSVs
   and layers are the best available fixture set for proving regeneration.
3. `origin/main` is 6 commits behind local `main`, and PR #1/#2/#3 are unmerged.
   Anything merged from this branch lands without PR #2's scan work, so check
   merge order before the app is assumed whole.
4. Local worktrees `.worktrees/pr2`, `.worktrees/pr2-optimization`,
   `.worktrees/pr2-upstream` and `.merge-wt` (~140 MB) still exist and hold
   branch checkouts. They are untracked; `.merge-wt`, `.playwright-cli` and
   `shots` are now gitignored. Removing the worktrees is the owner's call.

### Unverified

1. `npm run build` was not run after this tranche; the previous session stalled
   at "Creating an optimized production build ...". Typecheck passes and no
   client component imports ETL runtime code (`LocationClaims.tsx` imports the
   report type only), but the build is the actual gate. Use a dedicated
   `NEXT_DIST_DIR` so build output cannot re-enter git.
2. `/location-report/<id>` has not been opened in a browser against live ETL
   state, and Redis→WebSocket delivery has never been exercised. Reconnect,
   skipped-event recovery and stale/fallback banners are untested in practice.
3. `http.ts`, `caiso.ts` and `geometry.ts` have no tests. Only `tsc` covers them.
4. The app reads ETL state from local disk (`research/etl-state`), so a deployed
   serverless build serves no reports. The pilot needs a persistent host or a
   state bucket before any public link.

### Expectations to state out loud

1. Updates are source-paced, not real time: CAISO 5 minutes, NWS 10 minutes, EIA
   hourly (typically about an hour after the operating hour), inventory daily.
   Site-level telemetry requires an authorized operator feed and does not exist
   here.
2. The WebSocket gateway authenticates by Origin allowlist only
   (`ETL_BROWSER_ORIGINS`, default localhost) and any valid location id can be
   subscribed. It is not multi-tenant safe.
3. `http.ts` deduplication is process-local. Two collectors still fetch the same
   URL; cross-location dedupe needs shared state.

## Known limitations to keep visible

- Strict coverage exits 1: full asset regeneration, field-level seed/case
  provenance, hourly rating CSV regeneration, simulator input inventory and
  operator imports are open.
- Production build stalled at "Creating an optimized production build ..." at the
  previous handoff and was not re-run after this tranche.
- A successful fetch of an old observation stays stale; an empty successful
  inventory query and a failed query are different outcomes and must not collapse.

## Stack merge into PR #2 (this branch)

This branch is PR #2 (`app/area-scan`) after merging `feat/app-verified` (PR #4).
Fifteen files conflicted. Resolution policy and what it means:

- **PR #2's UI wins.** `app/location-report/[id]/page.tsx`, `LocationReport.tsx`,
  `lib/scan/{colors,data,rating,report,risk,scan,sources,types}.ts`, `lib/grid.ts`
  and the line-rating CSV are PR #2's versions. PR #2's report is the newer
  implementation (scan.css, risk ranges, source categories, `lib/scan/reportLink`);
  PR #4's copy was forked from `.merge-wt` at `6726835`, so taking it would have
  been a UI regression.
- **PR #4's additive work landed.** `research/etl/**`, `lib/evidence/**`,
  `app/api/{location-report,weather}/**`, `components/evidence/**`,
  `components/scan/{AreaScanPanel,CorridorWeatherCallout}.tsx` (both used by
  `components/shell/MapCanvas.tsx`), and the MapLibre/Leaflet map work.
- **No PR #2 component was overwritten.** PR #2 never modified
  `components/shell/*`, `components/energy/*`, `components/grid/*`,
  `components/method/*`, `components/ui/kit.tsx`, `app/page.tsx` or
  `app/globals.css`, so every change there is PR #4's forward work on top of main.
  PR #2's new routes (`/scan`, `/owner/**`, `/location-report/[id]`) all survive.
- **Deleted:** `app/location-report/[id]/LocationClaims.tsx` and
  `location-report.module.css`. They were PR #4's report view, orphaned once PR #2's
  view won. The live WebSocket client therefore exists only on
  `feat/app-verified`; wiring live updates into PR #2's report is open work.
- **Docs split:** `research/README.md` is PR #2's dataset provenance page and
  `research/EVIDENCE-FRAMEWORK.md` is PR #4's 672-line evidence spec, cross-linked.
- **Dependencies:** `maplibre-gl` resolved to `^6.18.0` to match the installed
  package and PR #4's map code; PR #4's `evidence:*`/`typecheck` scripts were kept
  alongside PR #2's `sync-layers`/`predev`/`prebuild`/`test`. `package-lock.json`
  is PR #2's with a fresh install.

Verified on the merged tree: `tsc --noEmit` clean, 14/14 ETL tests pass, and
`next build` (with `NEXT_DIST_DIR=build-verify`) completes with every route
including `/scan` (59.3 kB) and `/location-report/[id]`.

Not verified: no browser pass over `/scan`, `/location-report/<id>` or the owner
routes, so layout, contrast and interaction are unconfirmed. `prebuild` regenerates
`public/layers` via `scripts/sync-layers.mjs`; compare those files before assuming
the shipped layers match the merged sources.
