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

## Known limitations to keep visible

- Strict coverage exits 1: full asset regeneration, field-level seed/case
  provenance, hourly rating CSV regeneration, simulator input inventory and
  operator imports are open.
- Production build stalled at "Creating an optimized production build ..." at the
  previous handoff and was not re-run after this tranche.
- A successful fetch of an old observation stays stale; an empty successful
  inventory query and a failed query are different outcomes and must not collapse.
