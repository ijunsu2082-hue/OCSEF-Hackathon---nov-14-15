# Location ETL

Run from the repository root with project dependencies installed.

```powershell
npx tsx research/etl/cli.ts collect --lat 34.0522 --lon -118.2437 --radius 100 --respondent CISO
npx tsx research/etl/cli.ts verify <location-id> <revision>
npx tsx research/etl/cli.ts replay <location-id> <revision>
npx tsx research/etl/cli.ts coverage --strict
npx tsx research/etl/cli.ts backfill weather 34.0522 -118.2437 2024-01-01 2024-01-03
npx tsx research/etl/cli.ts assets hifld-transmission 33.7538 -118.0111 100
npx tsx research/etl/cli.ts replay-assets <asset-manifest-path>
npx tsx research/etl/cli.ts load-assets <asset-manifest-path> [additional-manifest-path]
npx tsx research/etl/cli.ts audit-substations public/layers/substations.geojson <hifld-manifest> <crosswalk.json>
```

Collection prints the location ID and pinned revision to stderr and the report to stdout. The Next.js JSON endpoint accepts `?revision=<revision>`. Collection stores final source responses locally before parsing and records rejected captures separately. Sources use their configured refresh intervals. Failed attempts retain the previous capture if its checksum and parser replay succeed.

Asset collection accepts `eia-atlas-plants`, `hifld-substations`, and `hifld-transmission`. It captures the provider's radius-filtered ID list, fetches geometry and attributes by ID, and verifies one returned feature per listed ID before publishing. GeoJSON contains complete intersecting features. Segment clipping and mileage derivation belong to downstream processing. Replay uses only saved response bytes. These manifests are separate from location-report backups.

`load-assets` replays saved manifests for one coordinate and radius, normalizes registered fields, and publishes an immutable JSON asset revision. It retains separate provider datasets, field and geometry citations, and counts of missing fields. Query `GET /api/location-report/<location-id>/assets?revision=<revision>` for a pinned revision or omit the query for the latest loaded assets. A failed transform leaves the previous revision available. Plant generation and retirement metrics still require the EIA workbooks.

The FastAPI service schedules inventory separately from telemetry. Set `ETL_ASSET_LOCATIONS` to a JSON array to opt in; each item needs `lat` and `lon`, with optional `radius` (default `100`) and `sources` (default all three supported asset sources). Keep each coordinate/radius scope unique and each source listed once. Inventory workers collect each source, then publish through `load-assets`; failed attempts retry after 60 seconds and do not replace the last loaded snapshot. Successful cycles wait 86,400 seconds by default. `ETL_ASSET_REFRESH_SECONDS` and `ETL_ASSET_RETRY_SECONDS` set those intervals; `ETL_ASSET_CONCURRENCY` caps simultaneous inventory locations (default `2`). All interval and concurrency values must be positive. Empty `ETL_ASSET_LOCATIONS` keeps inventory scheduling off.

```powershell
$env:ETL_ASSET_LOCATIONS = '[{"lat":33.7538,"lon":-118.0111,"radius":100,"sources":["hifld-substations","hifld-transmission"]}]'
$env:ETL_ASSET_REFRESH_SECONDS = '86400'
$env:ETL_ASSET_RETRY_SECONDS = '60'
$env:ETL_ASSET_CONCURRENCY = '2'
```

Substation crosswalks are reviewed JSON arrays with `osm` (such as `node/123`), `hifld` (such as `hifld-substations:456`), `snapshot` (the HIFLD feature's citation snapshot), and `evidence` (the record establishing common identity). Audit replays the HIFLD captures, compares published names and operators where both exist, and lists unpaired records. Ownership and maximum voltage remain separate HIFLD fields. Use captures covering the same study area when comparing totals.

Set `EIA_API_KEY` for EIA hourly telemetry and `NWS_USER_AGENT` to a contact-bearing user agent. Passing a respondent specifies the reporting authority for the query. The location center alone does not establish the respondent.

## Backup and restore

Set `ETL_BACKUP_KEY` to a securely generated 32-byte hex key. Store it separately from encrypted backup files. Use an independently mounted destination for backup files.

```powershell
npx tsx research/etl/cli.ts backup <location-id> <revision> <destination-file>
$env:ETL_STATE_NAMESPACE = "restore-drill"
npx tsx research/etl/cli.ts restore <destination-file>
npx tsx research/etl/cli.ts verify <location-id> <restored-revision>
```

Restore verifies hashes and reconstructs the report before publishing a pinned revision in the target namespace. Claim IDs persist across namespaces. The full revision hash reflects restored capture paths. Set `ETL_BACKUP_DIRECTORY` on the scheduled FastAPI worker to back up published revisions to a separate mounted destination. Keep the destination and key available after loss of the ingestion host.

Loaded asset revisions and historical weather captures use the same key and encrypted archive format. Asset archives include the normalized revision, its source manifests, and capture blobs. Restore rewrites capture paths for the target state namespace and recalculates the revision hash, so it can differ from the archived revision; the restored revision becomes `latest`. Weather archives include the backfill and its capture bytes; restore replays the original capture before publishing the archive. Keep backup files on storage separate from the ETL state directory, and keep `ETL_BACKUP_KEY` separate from those files.

```powershell
npx tsx research/etl/cli.ts backup-assets <location-id> <asset-revision> <destination-file>
npx tsx research/etl/cli.ts restore-assets <backup-file>
npx tsx research/etl/cli.ts backup-weather <snapshot-id> <destination-file>
npx tsx research/etl/cli.ts restore-weather <backup-file>
```

## Request layer

Every collector fetch goes through `research/etl/http.ts`. Inside one process an identical request is fetched once, per-host concurrency is bounded by `ETL_HTTP_HOST_CONCURRENCY` (default `4`), retryable failures back off from `ETL_HTTP_RETRY_BASE_MS` (default `300`) up to `ETL_HTTP_RETRY_ATTEMPTS` (default `3`) and honour `Retry-After`, and a provider `304` reuses the bytes already captured. State is process-local: two collector processes can still fetch the same URL, so cross-location deduplication still needs shared state.

## CAISO feeds (not yet reachable)

`research/etl/caiso.ts` implements the five-minute Today's Outlook demand and supply CSVs with header-name column matching, system-wide scope in every caveat, and an operating date derived from the capture instant in `America/Los_Angeles`. The feeds are only added when a query opts in with `caiso: true`; the CLI has no `--caiso` flag yet, so this adapter is currently exercised by code only. `research/etl/geometry.ts` provides study-radius line clipping and mileage that `load-assets` does not call yet.

## Comparison

`compare <file>` accepts JSON containing `left`, `right`, and optional `policy` as defined in `reconcile.ts`. Provide values already normalized to equivalent scopes. The result retains candidates and distinguishes same-publisher duplicates from cross-publisher comparisons. The comparison command does not modify reports.

## Compliance forms

`compliance-forms` reads the government form behind every owner filing rule (`lib/owner/rules.ts`) from the agency page named in that rule's citation, and writes `public/compliance/forms.json` for the app's Compliance tab. For each form it records the evidence it relied on (the words it copied from the page), the deadline sentence, whether the filing is filed or signed, and the field labels that actually appear on the page. A field label with no public-data source stays manual, so the UI can list what only a person can fill in.

Pages that cannot be read are recorded honestly: a PDF, a timeout or a block is written as `status: "manual"` with its URL and the reason, never as an extracted field list. `--offline` skips the network entirely and marks every entry manual, so the snapshot still exists for a build without connectivity.

```powershell
npm run compliance:forms                 # read the live agency pages
npm run compliance:forms -- --offline    # no network: seeds only, every entry manual
npm run compliance:forms -- --limit 3    # first three rules, for a quick check
```

The summary prints how many entries came back `extracted`, `partial` and `manual`, plus how many source pages were read and how many failed. `tests/complianceForms.test.ts` covers the extraction, the manual fallback and the prefill/manual split without any network.

## Compliance applicability

`compliance-applicability` reads the agency lists that decide whether a filing applies, and writes `public/compliance/applicability.json` for the Compliance tab. It currently reads EPA's Greenhouse Gas Reporting Program facility list from Envirofacts (no key needed), county by county for the counties in `public/layers/plants.geojson`, and matches a plant to a facility when the two sit on the same site (within 0.25 mi) or within 1.5 mi with a shared name word. The match keeps the facility name and the distance, so the Compliance tab can show what was matched rather than assert it silently. Reported CO2e is not fetched by default: GHGRP membership by itself already means 25,000 t CO2e or more, and the emissions table costs one rate-limited request per facility (`--with-emissions` turns it on). `lib/owner/applicability.ts` then decides each filing: the GHGRP match settles the greenhouse gas report and both CARB thresholds, the county settles the South Coast AQMD item, and fuel, capacity, owner type and planned retirement settle the rest. A filing that only one fact can settle asks that question once, in place.

A match needs both location and name: the same site (within 0.25 mi) or within 1.5 mi with a shared name word. A facility within 1 mi that passes neither test is stored in `ghgrp_near` and becomes a question, not a denial — the coordinates may be off, or the reporter may trade under another name. Every plant also gets its nearest listed facility in `ghgrp_nearest`, so a "does not apply" reads "no facility within 1 mi in the Los Angeles County list, read Nov 15, 2026; the nearest listed facility is 28.7 mi away", which can be checked rather than trusted.

The run is rate limited by EPA, so it pauses between counties and between facility lookups. A county whose rows could not be read is recorded in `unavailable` (for example `ghgrp:Los Angeles`), and the app keeps the question for plants in that county instead of deciding either way.

```powershell
npm run compliance:applicability                    # read EPA's list for live matching
npm run compliance:applicability -- --offline       # no network: every GHGRP item becomes a question
npm run compliance:applicability -- --with-emissions  # also fetch each matched facility's CO2e
npm run compliance:applicability -- --out public/compliance/applicability.json
```

`tests/applicability.test.ts` covers the decisions, the unanswered question and the saved answer without any network.

## Coverage

`coverage` inventories fields in the shipped JSON artifacts and lists evidence predicates. Strict coverage intentionally fails until remaining gaps are closed. The working location adapter set covers Census, one NWS station, EIA Atlas plant counts, HIFLD counts, and optional hourly EIA demand and fuel. Full asset regeneration, historical bulk adapters, automated provider reconciliation, and operator imports remain pending.
