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

## Comparison

`compare <file>` accepts JSON containing `left`, `right`, and optional `policy` as defined in `reconcile.ts`. Provide values already normalized to equivalent scopes. The result retains candidates and distinguishes same-publisher duplicates from cross-publisher comparisons. The comparison command does not modify reports.

## Coverage

`coverage` inventories fields in the shipped JSON artifacts and lists evidence predicates. Strict coverage intentionally fails until remaining gaps are closed. The working location adapter set covers Census, one NWS station, EIA Atlas plant counts, HIFLD counts, and optional hourly EIA demand and fuel. Full asset regeneration, historical bulk adapters, automated provider reconciliation, and operator imports remain pending.
