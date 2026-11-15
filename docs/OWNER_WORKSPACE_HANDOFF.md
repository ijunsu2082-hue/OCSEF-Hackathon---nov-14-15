# GridSentinel owner workspace handoff

Local review branch: `pr2-optimization` in `.worktrees/pr2-optimization`.
Verified PR #2 base: `bf777691a04e97b4da5b5513ac0284976f108865`.
Earlier verified base `a4de6bb` advanced during implementation. The review branch was rebased onto `bf77769`, preserving the upstream ETL, Supabase-backed region/evidence loading, and MapLibre 6. Push and deployment await approval.

## Implementation

- `/` serves Area Scan and Optimization. `/scan` redirects with query parameters intact. `/workspace` preserves the separate legacy app and its upstream region/evidence loaders.
- Optimization compares weighted risks and upgrade options and composes selected intervention, funding, and authorization tasks through retirement. The scope includes dated official funding leads, unresolved checks, editable assignments, versioned drafts, exports, and six explicit synthetic scenarios. Non-electric cases use their own evidence requirements.
- Clerk/Supabase workspace membership gates draft, feedback, telemetry, and ranking APIs. Draft writes use optimistic revisions with history. LinUCB uses server-checked screening passes, and owner-only rank controls reset or restore workspace epoch lineage without removing historical feedback.
- The separate worker collects scoped NOAA station and CAISO OASIS price readings. Redis coordinates collection leases; Timescale stores observations. Restricted operator/reviewer commands persist immutable predictions, qualified observations, replay results, and independent review.

## Verification and reproduction

Run from this worktree:

```powershell
npm install
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm test
node node_modules/tsx/dist/cli.mjs --test research/etl/*.test.ts
git diff --check bf77769..HEAD
npm run build
npm start -- --hostname 127.0.0.1 --port 3047
```

- App tests passed 166/166. Upstream ETL tests passed 14/14.
- Browser smoke verified home navigation, keyboard tabs, 2D/3D controls, mobile tab visibility, draft restore and CSV export, funding and authorization sections, and all six selectable scenarios.
- Local PostgreSQL smoke applied the workspace migration twice and checked draft revisions/history, cross-workspace denial, reward precedence/deduplication, CapEx separation, and workspace ranking reset/rollback.
- Local PostgreSQL checked the telemetry migration with Timescale extension calls omitted. Frozen predictions stayed immutable and a calibration record could not become verified without an accepted review. This does not verify the Timescale extension itself.
- Live public adapter probes returned two NOAA KSLI station readings and 12 CAISO SP15 trading-hub LMP intervals. Those provider observations are environmental and economic context.

## Private staging gates

- Configure the approved Clerk/Supabase owner project and server role. Apply the workspace migration in staging, exercise two real workspace roles, and test deployment rollback and backup restoration.
- Provision dedicated TimescaleDB and Redis. Apply the separate Timescale migration and verify worker writes, lease outage recovery, API visibility, and database backup and restore. See `WORKFLOW-TELEMETRY-DEPLOYMENT.md`.
- Verify Gemini with configured workspace credentials. The local fallback remains available without model access.
- Asset calibration stays pending until authorized operator measurements and verified commissioning evidence are available. Run a qualified replay and independent engineer review before relying on calibration status.
