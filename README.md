# GridSentinel — Regional Energy Infrastructure Intelligence

A dark-mode "command center" for a region's **energy infrastructure**: where the power comes from (real power plants, renewable and fossil), how it moves (real transmission lines and substations), and who draws it (large load centers). For every asset it shows **output / power draw, capacity, energy cycle, age of infrastructure and upgrade potential**, scores grid risk, simulates a 105 °F heatwave, models upgrades with live ROI, and drafts + dispatches an AI energy-audit memo.

On top of the map sit **Niche Cases**: real, local stories that show a hidden problem and a fix. The first one is **The Wire That Breathes**: power lines are rated as if every hour were a hot, windless afternoon, so on most hours they could safely carry far more power, and on the worst heat-wave hours the fixed rating is not safe enough. See §4.7.

**Scope:** a **100-mile radius around Westminster High School**, Westminster CA (`33.7538, -118.0111`). **Region id:** `westminster-100mi`.

**What is on the map (four layers, §4.6):**

| Layer | What | Source | Real or modeled |
| --- | --- | --- | --- |
| **Generation** | 697 operating power plants (≈39.5 GW): gas, solar, batteries, wind, hydro, biogas | EIA-860 (2025) | **Real** MW, fuel, in-service year, planned retirements |
| **Transmission** | High-voltage lines + substations | OpenStreetMap | **Real** geometry and voltage where tagged |
| **Load centers** | The 11 seeded sites below: the region's largest public water/wastewater plants, treated as **electricity users** | §4.1 | Sites and coordinates real; **MW ratings modeled** |
| **Niche cases** | Featured stories with real data behind them (§4.7) | `research/` | Real, sourced; models labeled as models |

The load-center model claims only one thing about each site: **how much electricity it draws, what it costs, and what it emits**. Every nameplate MW there is a modeled electrical rating derived from the site's published scale, not an operator-published figure; say so in the UI footer.

Swapping `data/nodes.json` + `data/regions.json` and the region id relocates the whole platform; every formula, endpoint and component is region-agnostic.

---

## 0. Parallel work: read this first

Four sessions work in this repo at once. **The only way this stays mergeable is strict path ownership.** Read Section 3 before you write a single file.

| Rule | Detail |
| --- | --- |
| **One owner per path** | If a file is not in your row of the ownership table, you do not edit it. Need a change there? Message the owner; they make it. |
| **Contract first** | `lib/types.ts`, this README, and the API JSON shapes in §5 are frozen. Build against them, not against another dev's guess. |
| **No cross-imports upward** | `lib/**` never imports from `components/**` or `app/**`. Components take props only — no component imports another tab's component. |
| **Stub, don't block** | Every boundary has a documented shape in §5. If your dependency does not exist yet, code against the shape and use the fallback value noted in §5.5. |
| **Commit small, on your branch** | `git checkout -b dev1-map` (etc.). Never commit on `main`; the integrator merges in the order in §8. |
| **Never run `git checkout`/`reset` on files you don't own** | Discards another session's in-flight work. |

### G0 status — already committed, do not rewrite

| Path | State |
| --- | --- |
| `lib/types.ts` | **Frozen contract**, energy-native (nameplate MW, utilization %, MVA power flows). Import it; never fork it. §3 below is generated from it. |
| `design/tokens.css` | Delivered: dark + `[data-stress="true"]` heatwave tokens, Tailwind `@theme` bridge, `.pill-*` risk semantics, `.flow-line` animation. |
| `components/primitives/` | Delivered: `Panel`, `Stat`, `RiskPill`, `Sparkline`, `cx`. Props-only, zero dependencies. |
| Scaffold | `package.json` (+lock), `tsconfig`, `next.config`, `postcss`, `.env.example`, `.gitignore`. |

### Ownership table

| Owner | Paths (exclusive) | Deliverables |
| --- | --- | --- |
| **Dev 1 — Geospatial & shell** | `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `components/shell/**` (`ControlBar.tsx`, `MapCanvas.tsx`, `MapView.tsx`, `AnalyzerDrawer.tsx`, `Tabs.tsx`, `StatusBadge.tsx`) | Dark Leaflet map + 100-mile ring, risk-colored markers, animated power-flow lines, 64 px control bar, 65/35 split, heatwave theme switch, tab routing |
| **Dev 2 — Data & simulation** | `data/**`, `lib/simulation.ts`, `lib/risk.ts`, `lib/region.ts`, `lib/format.ts`, `app/api/region/**`, `app/api/simulate/**`, `components/energy/**` (`TelemetryTab.tsx`, `UpgradeSimulatorTab.tsx`, `charts/**`) | `nodes.json`/`regions.json` for `westminster-100mi`, all math, Recharts energy-mix + payback charts, region/simulate APIs |
| **Dev 3 — AI & outreach** | `lib/ai/**`, `lib/email/**`, `app/api/generate-brief/**`, `app/api/send-audit/**`, `components/outreach/**` (`ProviderActionTab.tsx`, `MemoPreview.tsx`, `DispatchForm.tsx`) | Gemini memo generation with offline fallback, Resend dispatch with simulated fallback, memo UI |
| **Dev 4 — Design & pitch** | `components/primitives/**`, `design/tokens.css`, `docs/**` | Tokens + primitives (**done**), `docs/DEMO.md` + `docs/PITCH.md`, final consistency pass (report, not edits) |
| **Research — real-grid data & niche cases** | `research/**` | Real plant / line / substation layers (GeoJSON), weather + line-rating data, `research/NICHE_CASES.md`, `research/layers/niche_cases.json` |

Rendering the new layers and niche cases is split along the existing lines: **Dev 1** draws the layers and the niche-case markers on the map (`components/shell/**`); **Dev 2** owns `components/energy/NicheCaseTab.tsx` (the drawer view of one case) and any math on the layer data.

---

## 1. Stack decisions (locked — no relitigating)

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | Next.js 15 App Router + React 19 + TypeScript | One repo, one deploy, server routes for secrets |
| Styling | **Tailwind CSS v4** (`@import "tailwindcss"`, `@tailwindcss/postcss`) | No config file; theme lives in `design/tokens.css` |
| Map | **Leaflet 1.9 + react-leaflet 5** with CARTO `dark_all` raster tiles | **No API key.** Mapbox needs a token we don't have, and a basemap that 404s on stage is unrecoverable |
| Charts | Recharts 3 | Stacked bars + area charts, matches spec |
| Backend | Next.js Route Handlers (`app/api/**`) | No second process, no CORS, no API base URL |
| AI | `@google/genai` → Gemini (`GEMINI_MODEL`, default `gemini-2.5-flash`) | Server-side only; falls back to a deterministic memo |
| Email | `resend` v6 | Server-side only; falls back to a simulated dispatch receipt |
| Data | Static GeoJSON in `data/nodes.json` | Instant, offline-safe, judges can inspect it |

**Non-negotiable demo property:** the app must be fully usable with **zero** env vars. Missing keys degrade to deterministic fallbacks that are visibly labeled, never to a broken button.

### Commands

```bash
npm install
npm run dev          # http://localhost:3000
npx tsc --noEmit     # the only check anyone needs before pushing
npm run build        # integrator runs this before the demo
```

---

## 2. Repo layout (target state)

```
app/
  layout.tsx                  Dev 1
  page.tsx                    Dev 1   (server component: loads region, composes the 3 zones)
  globals.css                 Dev 1   (@import "tailwindcss" + ../design/tokens.css)
  api/
    region/[regionId]/route.ts   Dev 2   GET
    simulate/route.ts            Dev 2   POST
    generate-brief/route.ts      Dev 3   POST
    send-audit/route.ts          Dev 3   POST
components/
  shell/       ControlBar · MapCanvas · MapView · AnalyzerDrawer · Tabs · StatusBadge   Dev 1
  energy/      TelemetryTab · UpgradeSimulatorTab · charts/EnergyMixChart · charts/PaybackChart   Dev 2
  outreach/    ProviderActionTab · MemoPreview · DispatchForm   Dev 3
  primitives/  Panel · Stat · RiskPill · Sparkline · cx         Dev 4  (done)
lib/
  types.ts     frozen contract                                  G0    (done)
  simulation.ts risk.ts region.ts format.ts                     Dev 2
  ai/brief.ts  email/dispatch.ts                                Dev 3
data/
  nodes.json   GeoJSON FeatureCollection + `flows`              Dev 2
  regions.json region metadata (center, radius, bounds)         Dev 2
design/tokens.css                                               Dev 4 (done)
docs/DEMO.md docs/PITCH.md                                      Dev 4
research/                                                       Research
  layers/                 map-ready files (§4.6), copied to public/layers/ at integration
    plants.geojson          EIA-860 power plants in the radius
    transmission.geojson    OSM power lines (≥ 69 kV)
    substations.geojson     OSM substations
    niche_cases.json        Niche-case cards (§4.7)
  NICHE_CASES.md          every niche case, with sources
  data/                   full CSVs (generators, retirements, proposed, hourly line ratings, weather)
  scripts/                Python that rebuilds every file from the public sources
```

---

## 3. Shared contract — `lib/types.ts` (frozen)

This section is a verbatim copy of the committed `lib/types.ts`, generated from the file itself. If they ever differ, the file wins and this section is the bug.

```ts
/**
 * Shared domain contract — frozen. Owned by the G0 contract (see README §3).
 * Every layer imports from here; nobody redefines these shapes.
 *
 * ENERGY-ONLY MODEL: every asset is an electrical load center. Capacity,
 * output and efficiency are all electrical — nothing in this contract models
 * a process throughput. Site names identify physical locations; the platform
 * makes no claim about what those sites do with the electricity.
 */

// ---- Domain -----------------------------------------------------------------
export type FacilityType =
  | "Continuous Process"
  | "High-Duty Process"
  | "Pumping Load"
  | "Desalination Load";

export interface SourceMix {
  natural_gas: number;
  solar: number;
  hydro: number;
  wind: number;
  other: number; // percent, sums to 100
}

export interface Infrastructure {
  year_built: number;
  age_years: number; // computed at load time from current year
  /** Electrical efficiency of the motor/process train, 0–1 (0.85 is the benchmark). */
  motor_efficiency_rating: number;
  /** Electrical demand at 100 % utilization, MW. The basis of every energy formula. */
  nameplate_draw_mw: number;
  /** Current share of nameplate in use, 0–100. Replaces the old output/capacity ratio. */
  utilization_pct: number;
}

export interface EnergyProfile {
  /** Average actual draw today (nameplate × utilization). Display value only — see README §4.2. */
  baseline_draw_mw: number;
  peak_draw_mw: number;
  grid_zone: string; // e.g. "US-CAL-LDWP"
  carbon_intensity_gco2_kwh: number;
  source_mix: SourceMix;
}

export interface UpgradePotential {
  recommended_intervention: string;
  solar_capacity_add_mw: number;
  efficiency_gain_pct: number; // percent, e.g. 18
  capex_estimate_usd: number;
  annual_savings_usd: number;
  // --- unit economics drive the sliders -----------------------------------
  solar_capex_per_mw_usd: number;
  solar_savings_per_mw_usd: number;
  vfd_capex_usd: number;
  vfd_savings_usd: number;
}

export interface FacilityProperties {
  id: string;
  name: string;
  type: FacilityType;
  provider: { utility_name: string; contact_email: string };
  infrastructure: Infrastructure;
  energy_profile: EnergyProfile;
  upgrade_potential: UpgradePotential;
}

export type FacilityFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] }; // [lon, lat]
  properties: FacilityProperties;
};

/** An electrical distribution segment between two load centers. */
export interface PowerFlow {
  id: string;
  from: string; // facility id
  to: string; // facility id
  label: string; // "East Branch 230 kV trunk"
  mva: number; // sizes the animated line
}

// ---- Simulation -------------------------------------------------------------
export interface SimInput {
  node_id: string;
  heatwave_active: boolean;
  added_solar_mw: number; // 0 … 2 × recommended
  vfd_retrofit: boolean;
}

export interface SimResult {
  node_id: string;
  heatwave_active: boolean;
  nameplate_mw: number;
  utilization_pct: number;
  /** effective utilization / 100, after the heatwave surge and its 105 % ceiling. */
  load_ratio: number;
  overload: boolean; // heatwave pushed demand past nameplate
  effective_draw_mw: number;
  daily_mwh: number;
  annual_mwh: number;
  carbon_intensity: number;
  annual_co2_tons: number;
  baseline_annual_co2_tons: number; // no heatwave, no upgrades
  co2_delta_tons: number; // result − baseline (negative = avoided)
  homes_equivalent: number;
  /** Post-upgrade state, only when solar/vfd requested (else === baseline values) */
  upgraded: {
    draw_mw: number;
    solar_mw: number;
    grid_offset_mw: number;
    annual_co2_tons: number;
    co2_avoided_tons: number;
    capex_usd: number;
    annual_savings_usd: number;
    payback_years: number | null; // null when savings <= 0
  } | null;
  risk_score: number; // 0–100, see README §4.3
}

// ---- Region payload (GET /api/region/[regionId]) ----------------------------
export interface RegionPayload {
  region: {
    id: string;
    name: string;
    state: string;
    /** [[south, west], [north, east]] for Leaflet fitBounds. */
    bounds: [[number, number], [number, number]];
    grid_zone: string;
    /** Map focal point — Westminster High School, Westminster CA. */
    center: [number, number];
    /** Coverage radius in miles around the focal point. */
    radius_miles: number;
  };
  nodes: { type: "FeatureCollection"; features: FacilityFeature[] };
  flows: PowerFlow[];
  grid: {
    carbon_intensity_gco2_kwh: number; // load-weighted regional mean
    source_mix: SourceMix; // MW-weighted mean
  };
  kpis: {
    total_draw_mw: number;
    total_annual_co2_tons: number;
    total_annual_mwh: number;
    total_nameplate_mw: number;
    facility_count: number;
  };
  generated_at: string; // ISO
}

// ---- AI + outreach ----------------------------------------------------------
export interface BriefRequest {
  node_id: string;
  simulation: SimResult;
  tone?: "technical" | "executive";
}
export interface BriefResponse {
  node_id: string;
  brief: string; // ~200 words, plain text with section labels
  source: "gemini" | "fallback";
  model: string | null;
  generated_at: string;
}
export interface AuditRequest {
  node_id: string;
  brief: string;
  to: string; // recipient email
  simulation?: SimResult;
}
export interface AuditResponse {
  delivered: boolean;
  mode: "live" | "simulated";
  provider_id: string | null; // Resend message id
  to: string;
  subject: string;
  detail: string; // human-readable reason / next step
  sent_at: string;
}
```

### 3.1 Migration from the water contract (do this in your own files)

An earlier commit shipped a water-domain contract; the G0 commit replaced it. Any code written before that will not typecheck. Owners fix **their own** files; the mechanical map is:

| Old | New |
| --- | --- |
| `Infrastructure.capacity_mgd` | `Infrastructure.nameplate_draw_mw` |
| `Infrastructure.current_output_mgd` | `Infrastructure.utilization_pct` (0–100) |
| `Infrastructure.pump_efficiency_rating` | `Infrastructure.motor_efficiency_rating` |
| `Flow` / `flows` | `PowerFlow`, `mgd` → `mva` |
| `SimResult.capacity_mgd` | `SimResult.nameplate_mw` |
| `SimResult.effective_output_mgd` | drop it — `effective_draw_mw` carries the post-stress load |
| `kpis.total_capacity_mgd` | `kpis.total_nameplate_mw` |
| `kpis.total_output_mgd` | drop it — `kpis.total_draw_mw` is the live figure |
| `"Treatment Plant"` / `"Reclamation Plant"` / `"Pumping Station"` | `"Continuous Process"` / `"High-Duty Process"` / `"Pumping Load"` / `"Desalination Load"` |
| `output / capacity` ratio | `utilization_pct / 100` |

Anyone still on the old field names is unblocked by §4.2: `loadRatio` replaces the output/capacity ratio and `nameplate_draw_mw` replaces capacity.

---

## 4. Data + math (Dev 2; everyone else consumes these numbers)

### 4.1 Region + seed assets — `westminster-100mi`

```jsonc
// data/regions.json
{ "id": "westminster-100mi", "name": "Westminster 100-Mile Radius", "state": "CA",
  "center": [33.7538, -118.0111], "radius_miles": 100,
  "bounds": [[33.10, -118.60], [34.50, -117.28]], "grid_zone": "US-CAL-CAMX" }
```

Eleven real sites, every one inside 100 miles of Westminster High School (**farthest** is Carlsbad at ~58 mi). Coordinates and in-service years were verified against operator/agency records.

| id | Load center (site) | Type | Operator | Nameplate MW | Util % | Live MW | Yr | CI g/kWh | Motor eff | gas/solar/hydro/wind/other |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `node-oc-01` | Groundwater Replenishment System | Continuous Process | Orange County Water District | 24.0 | 75.0 | 18.00 | 2008 | 284 | 0.86 | 22/30/6/12/30 |
| `node-oc-02` | Sanitation District Plant No. 1 | High-Duty Process | OC San | 25.0 | 66.0 | 16.50 | 1954 | 312 | 0.64 | 52/14/8/6/20 |
| `node-la-01` | Los Angeles Aqueduct Filtration Plant | Continuous Process | LADWP | 21.0 | 69.0 | 14.49 | 1987 | 310 | 0.68 | 48/22/15/10/5 |
| `node-la-02` | Joseph Jensen Filtration Plant | Continuous Process | MWD of Southern California | 24.0 | 67.5 | 16.20 | 1972 | 305 | 0.76 | 44/20/18/13/5 |
| `node-la-03` | F.E. Weymouth Filtration Plant | Continuous Process | MWD of Southern California | 15.0 | 62.6 | 9.39 | 1941 | 322 | 0.61 | 52/16/14/12/6 |
| `node-la-04` | Robert B. Diemer Filtration Plant | Continuous Process | MWD of Southern California | 16.5 | 65.5 | 10.81 | 1963 | 318 | 0.72 | 46/21/16/12/5 |
| `node-la-05` | Hyperion Water Reclamation Plant | High-Duty Process | LA Sanitation & Environment | 31.4 | 68.8 | 21.60 | 1950 | 341 | 0.58 | 55/14/12/11/8 |
| `node-la-06` | Edward C. Little Recycling Facility | Continuous Process | West Basin MWD | 4.0 | 77.5 | 3.10 | 1995 | 268 | 0.84 | 22/41/16/14/7 |
| `node-la-07` | Terminal Island Reclamation Plant | Continuous Process | LA Sanitation & Environment | 4.0 | 65.0 | 2.60 | 1935 | 330 | 0.66 | 50/18/13/13/6 |
| `node-la-08` | Rio Vista (Gladbach) Treatment Plant | Pumping Load | Santa Clarita Valley Water | 3.5 | 68.6 | 2.40 | 1995 | 296 | 0.71 | 40/24/18/12/6 |
| `node-sd-01` | Claude "Bud" Lewis Carlsbad Desalination Plant | Desalination Load | Poseidon Resources / IDE | 38.0 | 84.2 | 32.00 | 2015 | 402 | 0.79 | 58/12/2/6/22 |

Coordinates (lon, lat) for `nodes.json`, all verified:

```
oc-01  -117.9456, 33.6912    oc-02  -117.9377, 33.6940    sd-01  -117.3387, 33.1382
la-01  -118.4886, 34.3053    la-02  -118.4960, 34.3118    la-03  -117.7800, 34.1131
la-04  -117.8202, 33.9123    la-05  -118.4307, 33.9255    la-06  -118.3940, 33.9097
la-07  -118.2658, 33.7445    la-08  -118.5181, 34.4371
```

**Corrections applied from the fact-check** (previous values were wrong): Diemer entered service **1963**, not 1965, at 33.9123/−117.8202 — the old coordinate was ~4 mi off; Weymouth sits at −117.7800; LAAFP entered service **1987** (construction completed 1986) at 34.3053/−118.4886; Jensen is at 34.3118/−118.4960; Terminal Island dates to **1935**, not 1972; Hyperion moved ~4 km south to 33.9255/−118.4307; E.C. Little sits at 33.9097/−118.3940; Rio Vista is at 34.4371/−118.5181 and took the Gladbach name in 2024.

Per-asset upgrade economics (all recommended bundles land a **4.9–5.9 year** simple payback):

| id | solar rec MW | eff gain % | solar $/MW | solar sav/MW | VFD capex | VFD sav | bundle capex | bundle sav | payback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| oc-01 | 6.0 | 10 | 1,320,000 | 208,000 | 1,900,000 | 420,000 | 9,820,000 | 1,668,000 | 5.89 |
| oc-02 | 5.5 | 20 | 1,340,000 | 215,000 | 2,300,000 | 520,000 | 9,670,000 | 1,702,500 | 5.68 |
| la-01 | 4.5 | 18 | 1,340,000 | 215,000 | 1,900,000 | 420,000 | 7,930,000 | 1,387,500 | 5.72 |
| la-02 | 6.0 | 14 | 1,340,000 | 215,000 | 1,900,000 | 420,000 | 9,940,000 | 1,710,000 | 5.81 |
| la-03 | 3.0 | 22 | 1,380,000 | 222,000 | 1,400,000 | 470,000 | 5,540,000 | 1,136,000 | 4.88 |
| la-04 | 3.5 | 16 | 1,340,000 | 215,000 | 1,700,000 | 400,000 | 6,390,000 | 1,152,500 | 5.54 |
| la-05 | 8.0 | 24 | 1,340,000 | 215,000 | 2,500,000 | 700,000 | 13,220,000 | 2,420,000 | 5.46 |
| la-06 | 1.2 | 9 | 1,420,000 | 230,000 | 420,000 | 95,000 | 2,124,000 | 371,000 | 5.73 |
| la-07 | 1.0 | 20 | 1,420,000 | 230,000 | 500,000 | 150,000 | 1,920,000 | 380,000 | 5.05 |
| la-08 | 1.5 | 15 | 1,400,000 | 226,000 | 680,000 | 155,000 | 2,780,000 | 494,000 | 5.63 |
| sd-01 | 9.5 | 12 | 1,300,000 | 210,000 | 2,400,000 | 520,000 | 14,750,000 | 2,515,000 | 5.86 |

Invariant (assert it after editing the JSON): `capex_estimate_usd === solar_capacity_add_mw × solar_capex_per_mw_usd + vfd_capex_usd` and `annual_savings_usd === solar_capacity_add_mw × solar_savings_per_mw_usd + vfd_savings_usd`.

```bash
node -e "const d=require('./data/nodes.json');for(const f of d.features){const p=f.properties.upgrade_potential;const c=p.solar_capacity_add_mw*p.solar_capex_per_mw_usd+p.vfd_capex_usd;const s=p.solar_capacity_add_mw*p.solar_savings_per_mw_usd+p.vfd_savings_usd;if(c!==p.capex_estimate_usd||s!==p.annual_savings_usd)console.log('MISMATCH',f.properties.id,c,s)}"
```

**Power flows** (`flows` in `nodes.json`, MVA sizes the line — one directed segment per tie, no reverse duplicates):

`oc-02 → oc-01` Fountain Valley 69 kV tie (30) · `la-08 → la-02` Castaic 230 kV (60) · `la-02 → la-01` East Branch 230 kV trunk (180) · `la-03 → la-04` Rampart 230 kV trunk (120) · `la-03 → la-01` Upper feeder 230 kV (140) · `la-01 → la-05` Sylmar–Playa del Rey 230 kV (150) · `la-05 → la-06` West Basin 69 kV tie (40) · `la-05 → la-07` Harbor 115 kV trunk (45) · `la-04 → sd-01` SDCWA emergency intertie 230 kV (90).

That is **9 segments over 11 nodes**, one connected component, no pair linked twice. `la-04 → sd-01` is the long southern leg that keeps Carlsbad on the network instead of floating alone on the map.

> ⚠️ **These 9 flows are illustrative, not real power lines.** No public source shows, for example, a 230 kV "SDCWA emergency intertie" from Diemer to Carlsbad. An energy judge can check this. Render them dashed and labelled **"modeled tie (illustrative)"** in the tooltip and legend, and never present them as real circuits. The **real** grid is the transmission layer in §4.6; it is the one to point at on stage.

### 4.2 Formulas (§3 of the spec, energy units — `lib/simulation.ts`, pure)

```ts
const HW = { util: 1.35, utilCap: 105, draw: 1.45, ci: 1.25 };
const SOLAR_CAPACITY_FACTOR = 0.28;   // Southern California utility-scale, 24–30 % typical
const CO2_DIVISOR = 1_000_000;

// 1. stress-adjusted operating point
loadRatio       = (heatwave ? min(utilization_pct * 1.35, 105) : utilization_pct) / 100;
overload        = heatwave && utilization_pct * 1.35 > 100;
effectiveDraw   = nameplate_draw_mw * loadRatio * (heatwave ? 1.45 : 1);
carbonIntensity = CI * (heatwave ? 1.25 : 1);

// 2. energy + carbon — the ONLY place a 365 appears
dailyMWh        = effectiveDraw * 24;
annualMWh       = dailyMWh * 365;
annualCO2Tons   = dailyMWh * 1000 * carbonIntensity * 365 / CO2_DIVISOR;   // spec §3, exact
baselineCO2Tons = nameplate_draw_mw * (utilization_pct / 100) * 24 * 1000 * CI * 365 / CO2_DIVISOR;

// 3. upgrades
postDraw   = effectiveDraw * (1 - (vfd ? efficiency_gain_pct / 100 : 0));
gridOffset = min(postDraw, added_solar_mw * SOLAR_CAPACITY_FACTOR);       // MW actually displaced
postMWh    = annualMWh * (postDraw > 0 ? (postDraw - gridOffset) / postDraw : 0);  // already annual
postCO2    = postMWh * 1000 * carbonIntensity / CO2_DIVISOR;              // no extra 365
co2Avoided = annualCO2Tons - postCO2;
capex      = added_solar_mw * solar_capex_per_mw_usd + (vfd ? vfd_capex_usd : 0);
savings    = added_solar_mw * solar_savings_per_mw_usd + (vfd ? vfd_savings_usd : 0);
payback    = savings > 0 ? capex / savings : null;

// 4. homes equivalent (annual MWh / 10.5 MWh per US home-year)
homesEquivalent = round(annualMWh / 10.5);
```

> **Two traps.** (1) `dailyMWh` is a daily figure and gets the `× 365`; `annualMWh` and `postMWh` are already annual — never multiply them by 365 again. (2) `baseline_draw_mw` is **display only**: it already equals `nameplate × utilization`, so the math must start from `nameplate_draw_mw`. Multiplying baseline by utilization again understates demand by ~31 %.

### 4.3 Energy Risk Score (`lib/risk.ts`, 0–100, higher = worse)

```ts
risk = 40 * fossilShare                                        // (100 - solar - hydro - wind) / 100
     + 25 * clamp((CI - 200) / 200, 0, 1)
     + 20 * clamp((0.85 - motorEff) / 0.35, 0, 1)
     + 15 * clamp((age - 20) / 60, 0, 1)
// buckets: <35 LOW · 35–59 WATCH · 60–79 HIGH · ≥80 CRITICAL
// heatwave: recompute with the stressed CI, then add a flat +8 stress penalty.
// Display-only escalation — never mutate the stored properties.
```

### 4.4 Expected values (use as G1 assertions)

Every figure below is computed from the `Live MW` column in §4.1, which sums to **147.09 → 147.1 MW**. Do not recompute from nameplate and re-round; derive from the same live values and the table, panel and assertions stay in agreement.

| Assertion | Expected |
| --- | --- |
| Nameplate | **206.4 MW** |
| Live regional draw | **147.1 MW** (147.09 exact) |
| Daily energy | **3,530.16 MWh** |
| Annual energy | **1,288,508 MWh** |
| Annual CO₂ | **427,338 t** |
| Load-weighted grid CI | **331.7 gCO₂/kWh** |
| Homes equivalent | **122,715** |
| Heatwave draw | **283.1 MW** (×1.92) |
| Heatwave annual CO₂ | **1,024,592 t** (+139.8 %) |
| Overloads during heatwave | **3** — `node-oc-01`, `node-la-06`, `node-sd-01` (utilization × 1.35 > 100) |

Risk scores: `oc-01 31.3 · oc-02 67.8 · la-01 49.4 · la-02 46.4 · la-03 67.2 · la-04 53.3 · la-05 72.3 · la-06 23.4 · la-07 64.5 · la-08 41.2 · sd-01 60.4` → **2 LOW · 4 WATCH · 5 HIGH · 0 CRITICAL**. The story is deliberate: Hyperion is the risk leader (72.3) while Carlsbad is the most *utilized* (84.2 %), so the heatwave surfaces different failures than the baseline ranking does.

### 4.5 Tab 1 & 2 content (Dev 2)

- **Telemetry:** site name/type/operator, in-service year, utilization bar (live MW vs nameplate), live MW, `homesEquivalent`, stacked `EnergyMixChart` (Recharts `BarChart`, `stackId`, five sources), `RiskPill`, CO₂/yr.
- **Upgrade Simulator:** two controls — *Solar array* `0…2×rec` step 0.25 MW, *Drive retrofit (VFD)* toggle. Live readouts: post-upgrade draw, grid offset, CO₂ avoided, capex, annual savings, **payback years**. `PaybackChart` = Recharts `AreaChart` of cumulative net position over 15 years: it starts at `−capex` and crosses zero at payback — that crossing is the story. Sliders compute locally from `lib/simulation.ts`; **do not** round-trip `/api/simulate` on drag.

### 4.6 Real-grid layers (`research/layers/`, Research)

Static GeoJSON in WGS84 `[lon, lat]`, already clipped to 100 mi of Westminster HS. They live in `research/layers/`; Next.js only serves files from `public/`, so the integrator runs `mkdir -p public/layers && cp research/layers/* public/layers/` once, and the map fetches them client-side (`fetch("/layers/plants.geojson")`). They never touch `RegionPayload` or `lib/types.ts`. Rebuild them any time with `research/scripts/` (commands in `research/README.md`).

| File | Feature | Properties the UI uses |
| --- | --- | --- |
| `plants.geojson` | Point per power plant (operating generators summed) | `plant_name`, `utility_name`, `nameplate_mw`, `primary_source` (`natural_gas` / `solar` / `battery` / `wind` / `hydro` / `biogas` / …), `mw_by_source`, `oldest_year`, `newest_year`, `capacity_weighted_age_years`, `planned_retirement_mw`, `technologies`, `distance_mi` |
| `transmission.geojson` | LineString per OSM `power=line`, ≥ 69 kV | `voltage_kv`, `operator`, `name` (often empty) |
| `substations.geojson` | Point per OSM `power=substation` | `name`, `operator`, `voltage_kv` |
| `niche_cases.json` | Array of `NicheCase` (§4.7) | all |

Rules:
- **Plants:** marker area ∝ `nameplate_mw`, colour by `primary_source` (Dev 4 adds `--src-gas/solar/battery/wind/hydro/other` tokens; source colours must stay distinct from the risk ramp). Tooltip: name, MW, fuel, in-service years, planned retirement MW. These numbers are **real EIA data**, unlike the modeled load centers, so the tooltip footer says "EIA-860 2025".
- **Transmission:** `weight` by voltage (500 kV 3 px, 230 kV 2 px, 115–138 kV 1.25 px, 69 kV 0.75 px), `--muted` at 45 % opacity so the risk-coloured markers stay on top. Untagged voltage → 69 kV style.
- **Layer toggles** in the map legend card: Plants · Transmission · Substations · Load centers · Niche cases. Default on: Load centers + Niche cases + Transmission.
- Headline numbers for the intro beat (from `plants.geojson`): **697 plants, ≈39.5 GW operating**; by fuel ≈ 18.6 GW gas, 7.1 GW solar, 6.9 GW batteries, 4.0 GW wind, 2.4 GW hydro. Recompute from the file before quoting.

### 4.7 Niche Cases

A niche case is a pinned, real, local story: a specific place, the hidden problem there, the fix, and the numbers behind both. Clicking its map marker opens `NicheCaseTab` in the drawer. Shape of each entry in `research/layers/niche_cases.json`:

```ts
interface NicheCase {
  id: string;                          // "wire-that-breathes"
  title: string;
  category: "Transmission" | "Generation" | "Storage" | "Load" | "Water-Energy" | "Gas" | "Wildfire" | "Heat" | "Distributed";
  location: { name: string; lat: number; lon: number; distance_mi: number };   // distance from Westminster HS
  one_liner: string;                   // what a judge remembers
  problem: string;                     // plain English, 2–4 sentences
  fix: string;                         // the concrete solution
  shock_line: string;                  // what the presenter says on stage
  stats: { label: string; value: string; kind: "measured" | "modeled"; source: string }[];
  team_bullets: ("output_draw" | "capacity" | "energy_cycle" | "infra_age" | "upgrade_potential")[];
  chart?: { kind: "line_rating"; data_url: string };   // optional hourly series for the tab
}
```

`NicheCaseTab` shows: title + location, one-liner, problem / fix, the `stats` list with a **MEASURED** or **MODELED** tag on every number and its source, and the optional chart. No number without its tag.

**Case 1: The Wire That Breathes** (category Transmission)
- **Problem:** most lines carry a fixed "static" rating that assumes a 40 °C, almost windless, full-sun afternoon all year. Real limit = how hot the wire gets, and that depends on the weather.
- **Fix:** rate each line hour by hour from real weather (dynamic line rating). On most hours that frees capacity on wires that already exist, with no construction. On the worst heat hours it also flags when the fixed rating is too generous.
- **Data (modeled, IEEE 738 heat balance, ACSR "Drake" conductor at 75 °C, real 2024 hourly weather, wind halved for safety):** at Westminster HS the safe rating sits **above** the static rating in 100 % of 2024 hours, with a median of **≈1.58× static**. FERC Order 881 already requires the temperature part (ambient-adjusted ratings). The wind part is optional, and it adds a further **≈20 % median during summer 4–8 pm**, the evening peak. Flip side: in downtown LA on **6 Sep 2024, 1 pm (45.7 °C in the reanalysis)** the modeled safe rating was **≈0.90× static**, about 10 % *below* the fixed number. Source files: `research/data/line_ratings/summary.json` and the hourly CSVs next to it.
- **Say on stage:** "The wires aren't full. We just pretend every hour is a hot, still afternoon, and on the one afternoon that really is, the fixed number isn't even safe."
- **Honesty line:** these are screening estimates for a typical conductor, not utility operating ratings. Real ratings need line-specific conductor, clearance surveys and at-line sensors.
- **Physical demo (optional):** a 1 m nichrome "line" over an LED city sags into a "tree" under load and lifts when a fan blows on it. The sag goes from about 10 mm to about 40 mm, enough to see.

More cases with sources are in `research/NICHE_CASES.md`; promote the best 2–3 into `niche_cases.json`.

---

## 5. API contract (frozen JSON)

All handlers: `export const runtime = "nodejs"`; `export const dynamic = "force-dynamic"` where they read env. Never leak keys or stack traces; return `{ error: { code, message } }` with 4xx/5xx.

### 5.1 `GET /api/region/[regionId]` → `RegionPayload` (200) · 404 unknown region

### 5.2 `POST /api/simulate` — body `SimInput` → `SimResult` (200)
Validate: `node_id` exists (404), `added_solar_mw` finite 0–100 (422). Defaults: `heatwave_active=false`, `added_solar_mw=0`, `vfd_retrofit=false` — a bare `{ "node_id": "node-la-05" }` must work for the curl demo.

### 5.3 `POST /api/generate-brief` — body `BriefRequest` → `BriefResponse`

**Memo shape (fallback and LLM must emit the same labels):**

```
To: <operator> — Energy & Sustainability
From: GridSentinel Audit Desk
Re: <site name> (<load type>, <age> yr) — grid-risk and decarbonization screen

RECOMMENDATION  <the intervention, one sentence, with MW and % named>
FINDINGS        <live MW, utilization vs nameplate, carbon intensity, motor efficiency vs the 0.85 benchmark>
ECONOMICS       <capex, annual savings, simple payback, CO₂ avoided t/yr — mark as screening estimates>
RISK            <heatwave exposure: demand vs nameplate, overload status>
NEXT STEP       <one concrete request: 15-minute interval data + site verification, funding path>
```

Prompt: system instruction = utility energy-audit memo voice; user content = compact JSON of the asset + `SimResult`. Ask for **~200 words** in exactly those five labeled sections, plain text (no markdown tables). `temperature: 0.4`, `maxOutputTokens: 400`.

If no key or the call fails: return `source: "fallback"` with a template-built memo from the same numbers (never an error page). Log only `err.message`.

### 5.4 `POST /api/send-audit` — body `AuditRequest` → `AuditResponse`
- No `RESEND_API_KEY` → **200** `{ delivered: false, mode: "simulated", ... }` with a detail telling the operator to add the key. The UI shows a "simulated dispatch" receipt so the demo never dead-ends.
- Key present → `resend.emails.send({ from: AUDIT_FROM_EMAIL, to, subject, html, text })`; handle `{ error }` as 502 with a sanitized message; `provider_id = data.id`.
- `from` defaults to `GridSentinel Audits <audits@resend.dev>`; without a verified domain Resend only delivers to the account owner's address — say so in the UI under the recipient field.
- Only send to addresses matching a sane email regex; reject otherwise (400). One recipient, no CC/BCC, no arrays.

### 5.5 UI-side fallback values (so shell work never blocks)

`ControlBar` KPIs before data: `— MW`, `— g/kWh`, `— t`; `MapCanvas` renders a "loading telemetry" skeleton over the dark base tiles; `AnalyzerDrawer` shows "Select an asset". Dev 1 may keep a local `RegionPayload` fixture in `components/shell/__fixtures__.ts` (Dev 1-owned) until Dev 2 merges — delete it before ship.

---

## 6. Design system (`design/tokens.css`, committed)

Tokens as CSS custom properties; `[data-stress="true"]` on `<html>` retints the entire app with no component changes.

| Token | Dark default | Heatwave |
| --- | --- | --- |
| `--bg` | `#080B12` | `#0C0709` |
| `--panel` | `#0E1420` | `#150C0E` |
| `--panel-raised` | `#141C2B` | `#1C1013` |
| `--border` | `#22304A` | `#4A2318` |
| `--text` | `#EDF2F8` | `#FDF3EC` |
| `--muted` | `#8FA0B8` | `#C4A79C` |
| `--accent` | `#38D6C4` | `#FFB020` |
| `--accent-2` | `#4C8DFF` | `#FF6B3D` |
| `--ok` | `#2DD4A7` | `#2DD4A7` |
| `--warn` | `#E8A33D` | `#FFB020` |
| `--high` | `#F97316` | `#FF6B3D` |
| `--critical` | `#F04D5E` | `#FF2E4D` |
| `--grid-line` | `rgba(56,214,196,.10)` | `rgba(255,176,32,.12)` |

Risk ramp is green → amber → vermilion → crimson and **always paired with a text label** (`LOW/WATCH/HIGH/CRITICAL`) via `RiskPill`, never color alone. Numbers use `.num` (tabular figures); the value is dominant, units smaller and muted.

Layout: top bar `64px`; `display:flex` with canvas `flex: 1 1 65%` and drawer `flex: 0 0 35%; min-width: 400px`; under `lg` the drawer becomes a full-height overlay. The drawer is the only scrolling region.

Anti-goals: gradients for their own sake, neon glow on body text, purple SaaS gradients, animated counters, icon fonts. Texture allowed: the 24 px `--grid-line` grid, 1 px hairlines, monospace for ids/timestamps only.

### Control bar contents

Left: product mark + region selector (one option, `Westminster 100-Mile Radius`). Center: three `Stat` KPIs — **TOTAL GRID DRAW (MW)**, **GRID CARBON INTENSITY (gCO₂/kWh)**, **ANNUAL CO₂ (t)**. Right: heatwave toggle `SIMULATE 105 °F HEATWAVE` and an `N OVERLOAD` pill that appears only when an asset overloads. Toggling sets `data-stress` on `<html>` and threads a `useHeatwave` prop to the map and tabs.

### Map

- Base: `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`, attribution `&copy; OpenStreetMap contributors &copy; CARTO`, `maxZoom 19`, `center [33.7538, -118.0111]`, `zoom 9`, `fitBounds` on the region bounds.
- **Home marker at Westminster High School** plus a 100-mile radius circle (`L.circle(center, { radius: 160934, weight: 1, dashArray: "4 6" })` in `--accent`, 4 % fill) — the single most legible "we scoped our own region" signal on stage.
- Load markers: `L.divIcon` dot sized `10 + nameplate/8` px, fill = risk color, 2 px ring in `--bg`; selected gets an accent halo + `bringToFront`; include an invisible ≥28 px hit target.
- Power flows: `L.polyline([[lat,lon],…], { className: "flow-line", weight: 1 + mva/90, opacity: .55 })`. `design/tokens.css` already animates `.flow-line` (`stroke-dasharray: 2 10`, 1.2 s) and retints it to `--flow` under stress (0.5 s) — no JS needed for the recolour.
- Avoid SSR: `MapCanvas` uses `dynamic(() => import("./MapView"), { ssr: false })`; import `"leaflet/dist/leaflet.css"` inside `MapView`. Call `map.invalidateSize()` when the drawer or tabs change.
- Legend card (bottom-left): risk ramp + `power flow direction` + the radius scale + the layer toggles from §4.6.
- Real-grid layers (§4.6) render **under** the load-center markers: transmission first, then substations, then plants, then load centers, then niche-case markers on top. Niche-case markers use a distinct shape (a diamond `divIcon` in `--accent-2`) so they never read as a risk dot.

---

## 7. Sprint plan (gates, not clocks)

| Gate | Who | Exit criteria |
| --- | --- | --- |
| **G0 — Contract** | G0 commit | ✅ `lib/types.ts`, `design/tokens.css`, `components/primitives/*` committed. Everyone unblocked. |
| **G1 — Data spine** | Dev 2 | `nodes.json` + `regions.json` valid GeoJSON; §4.4 assertions reproduce exactly; `/api/simulate` returns sane numbers for `node-la-05` under heatwave. |
| **G2 — Shell on screen** | Dev 1 | Dark map, 100-mile ring, 11 markers, 9 flows, control bar, 3-tab drawer, KPIs wired to `RegionPayload`. |
| **G2b — Real grid on screen** | Dev 1 + Research | `research/layers/*` copied to `public/layers/` and loading; transmission, substations and plants render with toggles; niche-case markers open `NicheCaseTab`. |
| **G3 — Analytics live** | Dev 2 | Tabs 1–2 render real charts; sliders move payback instantly; no `NaN`/`Infinity` anywhere; `NicheCaseTab` renders The Wire That Breathes with MEASURED/MODELED tags. |
| **G4 — Outreach live** | Dev 3 | Memo generates (fallback if no key), dispatch returns a receipt, button has pending/done/error states. |
| **G5 — Integration** | All | `npx tsc --noEmit` clean, `npm run build` clean, one browser pass heatwave on/off × three tabs × one dispatch. |
| **G6 — Pitch** | Dev 4 | `docs/DEMO.md` rehearsed twice; screen numbers match `docs/PITCH.md`; fallback path tested with no API keys. |

**Blocking order:** G0 ✅ → G1/G2 in parallel → G3 after G2 → G4 after G1 → G5 → G6.

---

## 8. Merge order

1. ✅ `feat/g0-contract` (tokens, primitives, types)
2. `feat/dev2-data-sim` (data, simulation, APIs, tabs 1–2)
3. `feat/dev1-shell` (layout, page, globals, map, control bar, drawer)
4. `feat/dev3-outreach` (AI, email, tab 3)
5. Integrator wires `app/page.tsx` (Dev 1-owned), adds the tokens import to `app/globals.css`, deletes `components/shell/__fixtures__.ts`, and copies `research/layers/*` into `public/layers/`.

`app/page.tsx` is the single composition point and is owned by Dev 1 only — everyone else ships self-contained components taking the props in §3.

---

## 9. Environment (all optional)

```bash
cp .env.example .env.local
```

| Var | Effect if missing |
| --- | --- |
| `GEMINI_API_KEY` | Memo falls back to the deterministic template, banner reads "template memo" |
| `GEMINI_MODEL` | Defaults to `gemini-2.5-flash` |
| `RESEND_API_KEY` | Dispatch returns `mode: "simulated"` |
| `AUDIT_FROM_EMAIL` | `GridSentinel Audits <audits@resend.dev>` |
| `DEMO_INBOX_EMAIL` | Recipient field starts empty with a placeholder |

Secrets stay server-side and out of git.

---

## 10. Demo script (Dev 4 finalises in `docs/DEMO.md`)

| Time | Beat |
| --- | --- |
| 0:00–0:20 | Transmission + plants layers on. "Everything that makes, moves and uses power within 100 miles of this school: 697 real power plants, about 39.5 GW, and the high-voltage lines between them." |
| 0:20–0:50 | Click Hyperion (risk 72.3, 341 g/kWh, 58 % motor efficiency vs the 85 % benchmark). "High fossil reliance plus worn drives." |
| 0:50–1:20 | Hit **105 °F HEATWAVE**: draw 147 → 283 MW, carbon +140 %, three assets overload — Carlsbad pins at its 105 % ceiling. |
| 1:20–1:55 | Upgrade Simulator on Hyperion: 8 MW solar + drive retrofit → 21.6 → 16.4 MW, CO₂ avoided, 5.5-year payback, cashflow line crosses zero. |
| 1:55–2:40 | **Niche case: The Wire That Breathes.** Click the diamond. "This wire is rated as if every hour were 104 °F with no wind. Using real 2024 weather, it could safely carry about 1.6× that on a typical hour, and on 6 Sep 2024, the one afternoon it really was that hot, the fixed rating wasn't even safe." Optional: fan on the physical rig. |
| 2:40–3:05 | Provider Action → generate memo → **Dispatch**; the email lands in the demo inbox live. |
| 3:05–3:20 | "Same engine, any region. The study that took a consultant a quarter now takes a click." |

Rehearse against the live screen; never read numbers from memory.

---

## 11. Risk register

| Risk | Mitigation |
| --- | --- |
| No Mapbox token | Leaflet + CARTO (decided) |
| No Gemini key on the demo laptop | Deterministic fallback memo, visibly labeled |
| Resend domain not verified | `onboarding@resend.dev` to the account owner; simulated mode otherwise |
| Venue wifi dies | All data static; no external calls on the happy path |
| Parallel sessions stomping files | Ownership table §0 + single composition point |
| Slider math shows `Infinity` | `payback_years: null` + "n/a" render; unit-check `savings = 0` |
| MW figures challenged as invented | Footer: sites and coordinates verified, electrical ratings modeled. Point judges at the **real** EIA-860 plant layer for hard numbers. |
| Illustrative flows mistaken for real circuits | Dashed + "modeled tie (illustrative)" label (§4.1); the real network is the transmission layer |
| Line-rating numbers over-claimed | Every niche-case number carries MEASURED / MODELED; say "screening estimate for a typical conductor" out loud |
| Layer files too heavy for the demo laptop | Transmission is filtered to ≥ 69 kV and coordinates rounded to 5 decimals; all layers are local static files |
