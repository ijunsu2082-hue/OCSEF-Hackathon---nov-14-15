# Mapergy

Mapergy is a regional energy infrastructure screening app. It combines an area scan, a regional grid workspace, facility-level simulations, physical grid models, and source-linked evidence. Current sample region centers on Westminster High School in Westminster, California.

## Run locally

Requirements: Node.js and npm.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The scan and workspace use bundled data when optional services are not configured. Add credentials in `.env.local` only for features that need them; never commit secrets.

## Main pages

| Path | Purpose |
| --- | --- |
| `/` | Area scan with map layers, location search, weather and hazard context, and shareable reports. |
| `/workspace` | Regional grid workspace with risk analysis, grid and annual views, upgrade simulation, evidence, and provider actions. |
| `/location-report/[id]` | Shareable report for one location. |
| `/owner` | Authenticated infrastructure-owner portal for claims, tasks, and workflows. |
| `/owner/admin` | Admin tools for reviewing owner claims. |

## Project map

```text
app/                    Next.js pages and API route handlers
components/             Scan, map, workspace, evidence, energy, and owner UI
lib/                    Domain logic, data access, evidence, physics, simulation
data/                   Bundled region, facility, and grant data
public/layers/           Static map layers and fallback datasets
research/               Evidence research, ETL, source notes, and rebuild tools
scripts/                 Data sync, physics verification, telemetry workers
supabase/migrations/     Database migrations
tests/                  Node test suite
docs/                   Detailed model and feature documentation
```

## Data and models

The app uses Westminster-area seed data in `data/` and `public/layers/`. When configured, Supabase serves read-only reference data; loaders fall back to local files if credentials are missing or a query fails. Some site capacity and grid values are modeled screening estimates, not utility operating data. Evidence labels and sources are shown in the app. See [research/README.md](research/README.md), [research/EVIDENCE-FRAMEWORK.md](research/EVIDENCE-FRAMEWORK.md), and [docs/GRID-MODEL.md](docs/GRID-MODEL.md) for source, verification, and model details.

## Environment

Start from `.env.example`. Common optional integrations:

- **Supabase**: reference data and private owner claims. Owner features also need Clerk credentials and the required database migrations.
- **Resend**: live audit email delivery. Configure a verified sender; otherwise dispatch uses a simulated receipt.
- **Workflow telemetry**: dedicated database and Redis credentials for the telemetry collector and worker.
- **Weather**: set `NWS_USER_AGENT` to identify live National Weather Service requests.

Keep private credentials server-side. `NEXT_PUBLIC_*` values are public browser configuration and must not contain secrets.

## Useful commands

```bash
npm run dev
npm test
npm run typecheck
npm run verify:physics
npm run build
```

Evidence workflows:

```bash
npm run evidence:build
npm run evidence:verify
npm run evidence:verify:files
```

`evidence:verify:files` rechecks source snapshots and evidence locators. Other available workflows include `evidence:discover`, `evidence:report`, `evidence:hash`, `evidence:sources`, and `evidence:profiles`.

## Notes for contributors

- Shared types live in `lib/types.ts`; evidence schemas live in `lib/evidence/`.
- Keep domain logic in `lib/`, separate from app routes and UI components.
- Keep generated evidence and data changes reproducible; document source and method.
- Read the detailed [grid model](docs/GRID-MODEL.md) before changing physics assumptions.
