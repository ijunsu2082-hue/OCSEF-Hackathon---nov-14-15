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

Status as of 2026-11-14 (integration pass). "Verified" below means a test or a
command was run and its output observed; anything else is called out.

- Location collection and replay: `research/etl/pipeline.ts`. Immutable
  checksummed captures, quarantine, fallback to last verified snapshot, pinned
  revisions, evidence verification, deterministic offline replay.
- Feeds in `research/etl/sources.ts`: Census geography, one NWS station
  observation, NWS active alerts (verified zero vs failed fetch, paginated
  responses rejected rather than partially counted), EIA Atlas plant count, HIFLD
  substation and 69 kV+ transmission counts, optional EIA-930 hourly demand and
  fuel by explicit respondent. Freshness uses observation time. EIA
  `frequency=hourly` periods are UTC hour-ending (route metadata plus a recorded
  API-vs-bulk match: CISO 2026-11-14T08 = 22,227 MW in both), so EIA ages are
  computed on a UTC basis.
- CAISO Today's Outlook five-minute demand and supply (`caiso.ts`), opt-in with
  `--caiso` (CLI) or `"caiso": true` (service). Captures use the `csv.table`
  parser so `/rows/<i>/<j>` locators verify; tests build a verified report from
  real CAISO fixture files. Supply header drift below a threshold fails closed.
- CAISO OASIS nodal LMP (`oasis.ts`), opt-in with `--oasis-node <NODE>`: RTM
  `PRC_INTVL_LMP` (last full UTC hour, newest interval) and DAM `PRC_LMP` (hour
  containing the capture), $/MWh, capture-time URLs replayed offline. Tested on
  real OASIS ZIP fixtures. Requests to `oasis.caiso.com` are spaced 6 s apart by
  default (`ETL_HTTP_HOST_MIN_INTERVAL_MS`).
- Request layer `http.ts` (16 tests): in-process dedupe, per-host cap, typed
  retry classification, slot released during backoff, byte-capped LRU validator
  cache, per-feed redirect allowlists, per-host start spacing.
- Shared dedupe `shared-dedupe.ts` + `resp.ts`: Redis lease protocol, installed
  by every CLI command when `REDIS_URL` is set (an unusable URL prints a warning
  and continues process-local). Tested only against an in-test RESP2 server.
- Assets: `research/etl/assets.ts` captures ArcGIS object-ID inventories and
  feature pages, verifies completeness, replays offline. `load-assets.ts`
  normalizes fields, keeps per-field and per-geometry citations, records
  `field_notes`, nulls HIFLD `<TYPE><ID>` placeholder names and `-999999`
  sentinels, clips lines to the study circle (`study_clip`, per-dataset
  `mileage`, `dc` band), and publishes an immutable inventory revision with a
  `latest` pointer. The HIFLD transmission count and index use a 64-vertex WGS84
  study polygon because the layer's server-side distance is about 3.28x too large.
  First live capture of all three ArcGIS layers: `docs/HIFLD-LIVE-CAPTURE.md`.
- Report-to-inventory binding: reports bind the verified latest loaded
  inventory; `GET /api/location-report/<id>/assets` serves only the bound
  revision (`409` on mismatch); a corrupt inventory is quarantined, not served.
- Substation audit: `research/etl/substation-audit.ts` requires reviewed
  OSM-HIFLD crosswalks tied to captured records, keeps owner separate from
  operator and HIFLD `MAX_VOLT` separate from OSM voltage tags.
  `crosswalk-candidates` proposes unreviewed pairs (offline replay of the HIFLD
  manifest); the audit ignores unreviewed rows.
- Weather: `research/etl/weather-history.ts` stores Open-Meteo ERA5 bytes,
  validates hourly coverage and units, labels the product `modeled_reanalysis`,
  keeps the grid cell and locators. Numeric values are copied unmodified.
- Line ratings: `ratings.ts` regenerates hourly line-rating CSVs from a
  hash-verified weather archive through `lib/scan/rating.ts` `rateLine`.
  `ratings parity public/layers/line_rating_2025_westminster_hs.csv` matches all
  8,760 rows with max absolute difference 0 A in every column (run in this pass).
- EIA-930 bulk backfill: `backfill eia930 <respondent> <file> [--url]`, opt-in
  over a local six-month BALANCE file (the server ignores `Range`, so it is not
  in the five-minute loop). Blank-demand hours are skipped and counted.
- Reconciliation: `reconcile-report.ts` evaluates 4 reviewed policies
  (`reconcile-policies.ts`) per report revision and persists a digest-sealed
  sidecar at `reconciliations/<id>/<report-rev>.json`; statuses `agreement`,
  `within_tolerance`, `conflict`, `incomparable`; never averaged. Served by
  `GET /api/location-report/<id>/reconciliation`. CLI `reconcile` was run in
  this pass on a copied stored report: 4 comparisons, all `incomparable` with
  stated reasons, byte-identical on re-run.
- Operator imports: `operator-import.ts`, kinds `topology`, `equipment_rating`,
  `equipment_condition`, `meter_series`, `quote`; issuer, offset-bearing issue
  time, scope, effective period and visibility (`private`/`shared`/`public`)
  required; stored beside public records with `method: "operator"`, never
  merged. CLI run in this pass on `fixtures/operator/quote.json` and the
  meter-series CSV fixture in a scratch namespace.
- Backup/restore: `research/etl/backup.ts` (AES-256-GCM) for reports (with the
  bound inventory embedded), loaded assets and weather archives; restore verifies
  checksums and republishes.
- Service: `research/etl/service.py` runs separate opt-in telemetry and inventory
  workers. Telemetry has a per-location fixed-rate cadence (300 s with CAISO,
  600 s otherwise), no self-overlap, a shared concurrency cap, and reads the
  result from the last `@@GRIDSENTINEL_RESULT@@` stderr line. Redis Pub/Sub on a
  per-location channel, separate latest keys for state and inventory, both
  replayed to reconnecting clients. 19 pytest cases.
- Coverage: `research/etl/coverage.ts` computes every gap from evidence on disk
  and in code (`coverage.test.ts`); `coverage --strict` exits 1 iff a gap is open.

Verification in this pass (2026-11-14, run from the repo root):
- `npm run test:etl`: 288 tests in 29 files, 288 pass on the second run. The
  first run had 1 failure, `http.test.ts` "concurrent requests to a spaced host
  start at least the interval apart" (start 2 came 149 ms after the previous,
  limit 150 ms); five isolated re-runs of `http.test.ts` passed. Treat it as a
  timer-precision flake until fixed.
- `npm run verify:owner`: 6 scripts, all exit 0. `verify-owner-sources.ts`
  does live lookups and reported 2 of 12 unresolved on one run and 1 of 12 on
  the next.
- `npm run test:service` with Python 3.13 and `requirements-dev.txt`: 19 passed.
  The system `python3` here is 3.9 with no pytest, so the default invocation fails.
- `npm run evidence:verify:files`: 378 claims from 5 snapshots reproduced,
  267 locators re-resolved.
- `tsc --noEmit`: clean.
- `coverage --strict`: exit 1, open gaps `seed-case-field-attribution` and
  `simulator-input-inventory`; the other 4 are closed.

## Added in the paused tranche (now wired and tested)

The paused tranche is finished. Everything it added is wired and has tests:
`http.ts` (`http.test.ts`), `caiso.ts` (`caiso.test.ts`, reachable through
`--caiso` and the service `caiso` field), `geometry.ts` (`geometry.test.ts`,
called by `load-assets.ts`), and the CAISO predicates in
`lib/evidence/predicates.ts`. The geometry header now states the measured
local-plane error (about +/-0.33% at 100 miles at Westminster, 99.67 to 100.32
great-circle miles) instead of 0.03%.

Added after the pause and now wired into `cli.ts`: `oasis.ts` + `zip.ts`
(`--oasis-node`), `eia930-bulk.ts` (`backfill eia930`), `reconcile-report.ts` +
`reconcile-policies.ts` (`reconcile`), `crosswalk-candidates.ts`
(`crosswalk-candidates`), `ratings.ts` (`ratings generate|compare|parity`),
`operator-import.ts` (`operator-import`), `shared-dedupe.ts` (startup), and,
loaded on demand, `osm-regen.ts` + `osm-pbf.ts` (`osm-regen pin|regen`) and
`eia860.ts` + `xlsx.ts` (`eia860 pin|regen`). Regeneration results are in
`docs/OSM-REGENERATION-DIFF.md` (substations 1,271/1,271 unchanged; transmission
5,331 committed vs 5,338 regenerated, every difference attributed to OSM edits
after the snapshot) and `docs/EIA860-REGENERATION-DIFF.md` (697/697 plants
matched, 2 `distance_mi` differences from the committed script's Earth radius).
Those two documents and modules were written by a parallel executor; this pass
only checked that the exports exist and that bad arguments exit 1. It did not
re-run either regeneration.

## Remaining work, in the order it should be taken

1. Field-level attribution (coverage gap `seed-case-field-attribution`): no
   record in `public/layers/niche_cases.json` (39) or `data/nodes.json` (11
   features) carries a `field_sources` map, so case and seed outputs are not
   attributable field by field.
2. Simulator input inventory (coverage gap `simulator-input-inventory`): the
   simulator reads `data/nodes.json` (through `lib/region.ts`), which holds
   operator records or scenario assumptions (example.com contacts, "modeled"
   ties) with no per-input provenance. Physics constants in `lib/physics` are
   not inventoried either. Loaded assets and operator imports do not feed the
   simulator yet.
3. Live feeds still missing.
   - NOAA NCEI station history distinct from gridded weather. No adapter. The
     orchestrator reports that nearby stations have no 2025+ data; this pass did
     not re-check that.
   - CPUC fire-threat polygons as an ETL feed. Only an owner-sources lookup
     exists (`lib/owner/ownerSources.ts`, CPUC HFTD query); nothing in
     `research/etl` captures or replays it.
   - eGRID boundaries and factors, EPA CAMPD emissions, EIA-923 (not imported;
     `docs/EIA860-REGENERATION-DIFF.md`), FERC-714 as a historical cross-check.
     None started.
   - The FastAPI `Location` model has no `oasis_node`, so the service cannot
     schedule OASIS prices yet.
4. Crosswalk review. `crosswalk-candidates` produced 1,155 candidate rows for 982
   of 1,271 OSM substations on the live HIFLD capture; none is reviewed, so the
   audit corroborates nothing. A person has to review them.
5. HIFLD re-capture. The pinned transmission manifest predates the
   study-polygon fix (1,784 features, 694 in radius); a fresh capture should
   return 694. A pinned count replays its old 1,784.
6. Delivery and recovery proof.
   - Real Redis: shared dedupe and the service's Pub/Sub have never run against
     a real Redis server.
   - Redis to browser WebSocket delivery, reconnect and skipped-event recovery,
     and the reconciliation badge in a browser: never exercised.
   - A second U.S. region: no live proof.
   - Serverless deployment: the app reads ETL state from local disk, so a
     serverless build serves no reports. Needs a persistent host or state bucket.
   - `npm run build` was not run in this pass.

## Commands

```bash
git status --short
node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false
npm run test:etl
npm run verify:owner
PYTHON=<python3.10+ with requirements-dev.txt> npm run test:service
npm run evidence:verify:files
node node_modules/tsx/dist/cli.mjs research/etl/cli.ts coverage --strict
npx tsx research/etl/cli.ts collect --lat 33.7538 --lon -118.0111 --radius 100 --respondent CISO
npx tsx research/etl/cli.ts assets hifld-transmission 33.7538 -118.0111 100
npx tsx research/etl/cli.ts load-assets <asset-manifest-path>
npm run build
```

Env: `EIA_API_KEY`, `NWS_USER_AGENT` (contact-bearing), `ETL_LOCATIONS`,
`ETL_ASSET_LOCATIONS`, `ETL_BACKUP_KEY` (32-byte hex), `ETL_BACKUP_DIRECTORY`,
`ETL_STATE_NAMESPACE`, `REDIS_URL`, `ETL_BROWSER_ORIGINS`, `ETL_HTTP_*`
(including `ETL_HTTP_HOST_MIN_INTERVAL_MS` and `ETL_HTTP_SHARED_*`).
See `research/etl/README.md` for semantics.

## Concerns found while landing this branch

Each item is marked fixed (with how it was verified) or open (with why).

### Bugs

1. Fixed. `http.ts` retry classification matched message text. It now
   classifies by error `name` and `cause.code`. Verified by `http.test.ts`
   "transport errors retry by type; other errors do not".
2. Fixed. `http.ts` held the host slot during backoff. Verified by
   `http.test.ts` "a request in backoff releases its host slot".
3. Fixed. The validator cache is capped by bytes (`ETL_HTTP_CACHE_MAX_BYTES`,
   default 64 MiB, LRU). Verified by `http.test.ts` "validator cache is bounded
   by bytes with LRU eviction".
4. Fixed. Redirects fail closed by default; a feed opts in with an HTTPS origin
   allowlist. Verified by `http.test.ts` "redirects are refused by default" and
   "follow policy walks allowlisted hops and rejects others".
5. Fixed. `service.py` reads the last `@@GRIDSENTINEL_RESULT@@` stderr line
   (and still accepts the legacy JSON line). Verified by `test_service.py`
   sentinel and noisy-stderr backup tests (19 passed, Python 3.13).
6. Fixed. Telemetry cadence moved into the worker: per-location fixed-rate
   ticks, no overlap, missed ticks skipped, shared concurrency cap. Verified by
   `test_service.py` scheduling tests.
7. Fixed. The report assets route serves only the bound inventory revision and
   returns `409` on a mismatched `?revision=`. Verified by `pipeline.test.ts`
   "location reports bind the loaded asset inventory revision they were built
   against".
8. Fixed in this pass. Tests leaked `research/etl-state/test-*` and
   `restore-*` namespaces: `pipeline.test.ts` (3 tests) and `assets.test.ts`
   (6 namespaces) never removed them. Both now remove their namespaces in
   `t.after`. Verified by listing `research/etl-state` before and after each
   suite (0 new directories) and after a full `npm run test:etl` (0 new).
9. Open. `http.test.ts` spacing test flaked once (149 ms vs a 150 ms floor).
   Either the spacing logic can start up to 1 ms early or the test's
   `Date.now()` sampling is too tight. Not investigated.
10. Open. `resp.ts` accepts only `redis://`, so `enableSharedDedupeFromEnv`
   throws for a `rediss://` URL. The CLI catches that, prints one warning line
   and continues process-local. The service's redis-py client accepts
   `rediss://`, so a TLS deployment gets Pub/Sub without cross-process dedupe.

### Data correctness and provenance

1. Open. Of 1,271 bundled OSM substations, 799 have no name. A live HIFLD
   capture now exists (`docs/HIFLD-LIVE-CAPTURE.md`) and candidates are
   generated, but no crosswalk row is reviewed, so nothing is corroborated. Do
   not present an OSM name or operator as verified, and do not infer a missing
   asset from a missing record.
2. Partly fixed. Real provider bytes were captured for HIFLD and EIA Atlas
   (live, per `docs/HIFLD-LIVE-CAPTURE.md`) and as fixtures for CAISO Today's
   Outlook, OASIS RTM/DAM and the EIA API/EIA-930 bulk files. A scheduled live
   collection of every feed, and any second-region run, has not been shown.
3. Fixed. The CAISO adapter parses real fixture files, and a minimum recognized
   supply-column threshold fails closed. Verified by `caiso.test.ts`.
4. Fixed. EIA hourly clock basis is UTC hour-ending. Verified by
   `pipeline.test.ts` "EIA hourly periods are UTC; invalid and local-time periods
   are rejected" and `eia930-bulk.test.ts` "bulk and API agree for the
   overlapping UTC hours".
5. Open by design. `coverage --strict` exits 1: gaps are now computed, and
   `seed-case-field-attribution` and `simulator-input-inventory` are open. The
   other 4 gaps close on code and doc evidence.
6. Fixed. `load-assets` records clipped in-radius mileage and keeps provider
   geometry for citation. Verified by `assets.test.ts` "loaded transmission
   lines carry inside-radius mileage and keep provider geometry".
7. Standing caveat. CAISO values are system-wide telemetry and CAISO states
   they do not reconcile to OASIS. OASIS LMPs are nodal wholesale prices. Never
   present either as local demand, local mix or local price.
8. Fixed. The HIFLD transmission server-side distance was about 3.28x too large
   (state plane in US feet); the count and index now use a WGS84 study polygon.
   Verified live (count 694) per `docs/HIFLD-LIVE-CAPTURE.md` and by
   `assets.test.ts` URL checks.
9. Fixed in this pass. The `geometry.ts` header understated the local-plane
   error. It was recomputed by mapping the 100-mile local circle back to WGS84
   at 3,600 bearings: 99.67 to 100.32 great-circle miles at Westminster
   (+/-0.33%), +/-0.49% at 45 N, +/-0.23% at 25 N. The comment now states this.

### Merge and coordination risk

Not re-checked in this pass; left as found.

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
   `research/etl`, which now has its own `eia860.ts`. Pick one owner before
   merging.
3. `origin/main` is 6 commits behind local `main`, and PR #1/#2/#3 are unmerged.
   Anything merged from this branch lands without PR #2's scan work, so check
   merge order before the app is assumed whole.
4. Local worktrees `.worktrees/pr2`, `.worktrees/pr2-optimization`,
   `.worktrees/pr2-upstream` and `.merge-wt` (~140 MB) still exist and hold
   branch checkouts. They are untracked; `.merge-wt`, `.playwright-cli` and
   `shots` are now gitignored. Removing the worktrees is the owner's call.

### Unverified

1. `npm run build` has not been run since the tranche (it stalled at "Creating
   an optimized production build ..." earlier). Use a dedicated
   `NEXT_DIST_DIR` so build output cannot re-enter git.
2. `/location-report/<id>` against live ETL state, the reconciliation badge,
   and Redis to WebSocket delivery (reconnect, skipped-event recovery,
   stale/fallback banners) have never been exercised in a browser.
3. Shared dedupe and service Pub/Sub have never run against a real Redis.
4. The app reads ETL state from local disk (`research/etl-state`), so a deployed
   serverless build serves no reports. The pilot needs a persistent host or a
   state bucket before any public link.
5. No second U.S. region has a live run.
6. `osm-regen regen` and `eia860 regen` were not re-run in this pass; their
   results come from the two regeneration documents.

### Expectations to state out loud

1. Updates are source-paced, not real time: CAISO 5 minutes, NWS 10 minutes, EIA
   hourly (typically about an hour after the operating hour), inventory daily.
   Site-level telemetry requires an authorized operator feed and does not exist
   here.
2. The WebSocket gateway authenticates by Origin allowlist only
   (`ETL_BROWSER_ORIGINS`, default localhost) and any valid location id can be
   subscribed. It is not multi-tenant safe.
3. `http.ts` deduplication is process-local. Cross-process dedupe exists only
   when `REDIS_URL` (`redis://`) is set, and it has not been exercised against a
   real Redis.

## Known limitations to keep visible

- Strict coverage exits 1: field-level seed/case attribution and the simulator
  input inventory are open (computed; see `coverage --strict`).
- Production build stalled at "Creating an optimized production build ..." at an
  earlier handoff and has not been re-run.
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
