# Location ETL

Run from the repository root with project dependencies installed.

```powershell
npx tsx research/etl/cli.ts collect --lat 34.0522 --lon -118.2437 --radius 100 --respondent CISO
npx tsx research/etl/cli.ts verify <location-id> <revision>
npx tsx research/etl/cli.ts replay <location-id> <revision>
npx tsx research/etl/cli.ts coverage --strict
```

Collection prints the location ID and pinned revision to stderr and the report to stdout. The Next.js JSON endpoint accepts `?revision=<revision>`. Collection stores final source responses locally before parsing and records rejected captures separately. Sources use their configured refresh intervals. Failed attempts retain the previous capture if its checksum and parser replay succeed.

Set `EIA_API_KEY` for EIA hourly telemetry and `NWS_USER_AGENT` to a contact-bearing user agent. Passing a respondent specifies the reporting authority for the query. The location center alone does not establish the respondent.

## Backup and restore

Set `ETL_BACKUP_KEY` to a securely generated 32-byte hex key. Store it separately from encrypted backup files. Use an independently mounted destination for backup files.

```powershell
npx tsx research/etl/cli.ts backup <location-id> <revision> <destination-file>
$env:ETL_STATE_NAMESPACE = "restore-drill"
npx tsx research/etl/cli.ts restore <destination-file>
npx tsx research/etl/cli.ts verify <location-id> <restored-revision>
```

Restore verifies hashes and reconstructs the report before publishing a pinned revision in the target namespace. Claim IDs persist across namespaces. The full revision hash reflects restored capture paths. Run backup per published revision through the deployment scheduler.

## Comparison

`compare <file>` accepts JSON containing `left`, `right`, and optional `policy` as defined in `reconcile.ts`. Provide values already normalized to equivalent scopes. The result retains candidates and distinguishes same-publisher duplicates from cross-publisher comparisons. The comparison command does not modify reports.

## Coverage

`coverage` inventories fields in the shipped JSON artifacts and lists evidence predicates. Strict coverage intentionally fails until remaining gaps are closed. The working location adapter set covers Census, one NWS station, EIA Atlas plant counts, HIFLD counts, and optional hourly EIA demand and fuel. Full asset regeneration, historical bulk adapters, automated provider reconciliation, and operator imports remain pending.
