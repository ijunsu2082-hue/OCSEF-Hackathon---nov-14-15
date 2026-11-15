# Workflow telemetry deployment

This pipeline stores public upstream weather and market observations in a dedicated TimescaleDB instance. Supabase remains the app's Clerk-linked workflow store; its hosted PostgreSQL service does not provide the Timescale extension required here. Do not point this migration at the Supabase database.

## Services and secrets

- TimescaleDB 2.x on PostgreSQL 17, with TLS enabled. Apply `supabase/migrations/timescale/0001_workflow_telemetry.sql` using an administrator. The API should use a read-only database role. The worker needs SELECT on targets and INSERT/SELECT on observations.
- Redis with TLS. The collector uses an expiring distributed lease so only one worker collects a target at a time.
- Configure separate `WORKFLOW_TELEMETRY_API_DATABASE_URL` (read only), `WORKFLOW_TELEMETRY_WORKER_DATABASE_URL` (target read plus observation insert), `WORKFLOW_TELEMETRY_OPERATOR_DATABASE_URL` (freeze and pending measurement insert), and `WORKFLOW_TELEMETRY_REVIEW_DATABASE_URL` (qualification, replay, review, and calibration writes). Add `WORKFLOW_TELEMETRY_REDIS_URL` and `WORKFLOW_TELEMETRY_REDIS_TOKEN` to the worker. Set a descriptive `NWS_USER_AGENT` with an operator contact.
- Provision enabled rows in `workflow_telemetry_targets` for each authorized workspace: stable key, workspace id, point coordinates, and the exact CAISO OASIS `NODE` name. Use a node or trading hub explicitly selected by the operator. Do not silently replace it with a regional average.

## Run

Install the app's locked dependencies, then run `npm run workflow-telemetry:worker` as a long-running worker process. It polls NWS station observations and CAISO OASIS interval LMP every five minutes. OASIS data is revisioned and can be delayed; keep both observation time and fetch time, plus market and source revision fields. Provider values retain their source units and source links.

The `/api/owner/workflows/telemetry` route is Clerk workspace scoped and uses read-only Timescale credentials. It returns durable public-provider observations and a calibration state. It accepts no measurements, frozen predictions, or review writes. Provider feed verification means only that a source returned parseable data. It does not establish an instrument's calibration or a commissioned asset's operational performance.

## Commissioning and review gate

Calibration begins as `pending-commissioning`. Leave it there until an authorized operator provides commissioning records and matched pre/post measurements. The `workflow-telemetry:calibration` CLI stores frozen predictions and their input snapshot, creates pending measurement records, allows a separate reviewer to qualify measurements, persists the replay result, and stores an independent engineer's decision with credential and evidence reference. Its replay matches same-target and same-unit measurements within five minutes, and only predictions frozen before each measurement. It reports sample count, bias, MAE and RMSE by pre/post commissioning period; each period needs at least three qualified matches before the replay can be reviewed. A reviewer identity must differ from the freeze author, replay author, and measurement authors. Frozen input and prediction rows are immutable. A numeric acceptance rule still requires engineering/operator sign-off; the replay does not auto-approve model fitness. No operator measurements or commissioning evidence were available at implementation time.

Run calibration commands only in a restricted operator/reviewer environment with SSO-injected `WORKFLOW_TELEMETRY_ACTOR_ID` and the minimum role's database URL. Do not expose operator/review credentials to the web app, browser, or general worker. Payloads are JSON strings; for example: `npm run workflow-telemetry:calibration -- replay '{"workspaceId":"…","assetKey":"line-123","freezeId":"…","commissioningAt":"2026-01-01T00:00:00Z"}'`. Record an accepted or rejected decision only after inspecting the frozen inputs, all qualifying evidence, exclusions, operating conditions, missing intervals, and pre-agreed tolerance criteria.

## Operations

Monitor worker heartbeat, provider error counts, Redis lease contention, collection lag, OASIS revision changes, and Timescale storage/retention. Back up the Timescale service independently of Supabase and test restore before production use. Keep secrets out of logs and browser responses. The worker does not alter dispatch, protection settings, or operating limits.
