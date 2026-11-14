# GridSentinel — Water Infrastructure Energy Intelligence

A dark-mode "command center" for water-utility infrastructure: it maps every facility in a region, scores its energy risk, simulates a 105 °F heatwave stress event, models decarbonization upgrades with live ROI, and drafts + dispatches an AI utility-audit memo.

**Event:** OCSEF Hackathon, Nov 14–15. **Region seeded:** Greater Los Angeles Basin (`la-basin`).

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

### Ownership table

| Owner | Paths (exclusive) | Deliverables |
| --- | --- | --- |
| **Dev 1 — Geospatial & shell** | `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `components/shell/**` (`ControlBar.tsx`, `MapCanvas.tsx`, `MapView.tsx`, `AnalyzerDrawer.tsx`, `Tabs.tsx`, `StatusBadge.tsx`) | Dark Leaflet map, risk-colored markers, animated flow lines, 64 px control bar, 65/35 split, heatwave theme switch, tab routing |
| **Dev 2 — Data & simulation** | `data/**`, `lib/types.ts`, `lib/simulation.ts`, `lib/risk.ts`, `lib/region.ts`, `lib/format.ts`, `app/api/region/**`, `app/api/simulate/**`, `components/energy/**` (`TelemetryTab.tsx`, `UpgradeSimulatorTab.tsx`, `charts/**`) | `nodes.json` (8 real facilities), all math, Recharts energy-mix + payback charts, region/simulate APIs |
| **Dev 3 — AI & outreach** | `lib/ai/**`, `lib/email/**`, `app/api/generate-brief/**`, `app/api/send-audit/**`, `components/outreach/**` (`ProviderActionTab.tsx`, `MemoPreview.tsx`, `DispatchForm.tsx`) | Gemini memo generation with offline fallback, Resend dispatch with simulated fallback, memo UI |
| **Dev 4 — Design & pitch** | `components/primitives/**` (`Panel.tsx`, `Stat.tsx`, `RiskPill.tsx`, `Sparkline.tsx`), `design/tokens.css`, `docs/**` | Token sheet delivered **first**, UI primitives, `docs/DEMO.md` + `docs/PITCH.md`, final consistency pass (report, not edits) |

**Already scaffolded (do not re-create):** `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `.env.example`, `.gitignore`.

---

## 1. Stack decisions (locked — no relitigating)

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | Next.js 15 App Router + React 19 + TypeScript | One repo, one deploy, server routes for secrets |
| Styling | **Tailwind CSS v4** (`@import "tailwindcss"`, `@tailwindcss/postcss`) | No `tailwind.config.js` needed; theme lives in `app/globals.css` `@theme` |
| Map | **Leaflet 1.9 + react-leaflet 5** with CARTO `dark_all` raster tiles | **No API key.** Mapbox needs a token we don't have and a demo that 404s on stage is worse than raster tiles |
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
npx tsc --noEmit     # the only check anyone needs to run before pushing
npm run build        # integrator runs this before the demo
```

`npm install` has already been kicked off with these versions. If it fails on a peer conflict, `--legacy-peer-deps` is acceptable **only** for `react-leaflet`/`recharts` peer mismatches — note it in the commit.

---

## 2. Repo layout (target state)

```
app/
  layout.tsx                  Dev 1
  page.tsx                    Dev 1   (server component: loads region, renders 3 zones)
  globals.css                 Dev 1   (Tailwind import + tokens from design/tokens.css)
  api/
    region/[regionId]/route.ts   Dev 2   GET
    simulate/route.ts            Dev 2   POST
    generate-brief/route.ts      Dev 3   POST
    send-audit/route.ts          Dev 3   POST
components/
  shell/       ControlBar · MapCanvas · MapView · AnalyzerDrawer · Tabs · StatusBadge   Dev 1
  energy/      TelemetryTab · UpgradeSimulatorTab · charts/EnergyMixChart · charts/PaybackChart   Dev 2
  outreach/    ProviderActionTab · MemoPreview · DispatchForm   Dev 3
  primitives/  Panel · Stat · RiskPill · Sparkline   Dev 4
lib/
  types.ts simulation.ts risk.ts region.ts format.ts     Dev 2
  ai/brief.ts  email/dispatch.ts                        Dev 3
data/
  nodes.json    (GeoJSON FeatureCollection + `flows`)   Dev 2
design/tokens.css                                       Dev 4
docs/DEMO.md docs/PITCH.md                              Dev 4
```

---

## 3. Shared contract — `lib/types.ts` (Dev 2 writes this verbatim, everyone imports it)

```ts
// ---- Domain -----------------------------------------------------------------
export type FacilityType = "Treatment Plant" | "Reclamation Plant" | "Pump Station";

export interface SourceMix {
  natural_gas: number; solar: number; hydro: number; wind: number; other: number; // percent, sums to 100
}

export interface Infrastructure {
  year_built: number;
  age_years: number;              // computed at load time from current year
  pump_efficiency_rating: number; // 0–1
  capacity_mgd: number;
  current_output_mgd: number;
}

export interface EnergyProfile {
  baseline_draw_mw: number;
  peak_draw_mw: number;
  grid_zone: string;               // e.g. "US-CAL-LDWP"
  carbon_intensity_gco2_kwh: number;
  source_mix: SourceMix;
}

export interface UpgradePotential {
  recommended_intervention: string;
  solar_capacity_add_mw: number;
  efficiency_gain_pct: number;      // percent, e.g. 18
  capex_estimate_usd: number;
  annual_savings_usd: number;
  // --- extensions beyond the base spec (unit economics drive the sliders) ---
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

export interface Flow {
  id: string;
  from: string;                 // facility id
  to: string;                   // facility id
  label: string;                // "Colorado River Aqueduct → Diemer"
  mgd: number;                  // sized line width
}

// ---- Simulation -------------------------------------------------------------
export interface SimInput {
  node_id: string;
  heatwave_active: boolean;
  added_solar_mw: number;        // 0 … 2 × recommended
  vfd_retrofit: boolean;
}

export interface SimResult {
  node_id: string;
  heatwave_active: boolean;
  capacity_mgd: number;
  effective_output_mgd: number;
  load_ratio: number;            // effective_output / capacity
  overload: boolean;             // heatwave pushed output past nameplate
  effective_draw_mw: number;
  daily_mwh: number;
  annual_mwh: number;
  carbon_intensity: number;
  annual_co2_tons: number;
  baseline_annual_co2_tons: number;   // no heatwave, no upgrades
  co2_delta_tons: number;             // result − baseline (negative = avoided)
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
    payback_years: number | null;   // null when savings <= 0
  } | null;
  risk_score: number;            // 0–100, see §4.3
}

// ---- Region payload (GET /api/region/[regionId]) ----------------------------
export interface RegionPayload {
  region: { id: string; name: string; state: string; bounds: [[number, number], [number, number]]; grid_zone: string };
  nodes: { type: "FeatureCollection"; features: FacilityFeature[] };
  flows: Flow[];
  grid: {
    carbon_intensity_gco2_kwh: number;  // output-weighted regional mean
    source_mix: SourceMix;              // MW-weighted mean
  };
  kpis: {
    total_draw_mw: number;
    total_annual_co2_tons: number;
    total_annual_mwh: number;
    total_capacity_mgd: number;
    total_output_mgd: number;
    facility_count: number;
  };
  generated_at: string;          // ISO
}

// ---- AI + outreach ----------------------------------------------------------
export interface BriefRequest {
  node_id: string;
  simulation: SimResult;
  tone?: "technical" | "executive";
}
export interface BriefResponse {
  node_id: string;
  brief: string;                 // ~200 words, plain text with section labels
  source: "gemini" | "fallback";
  model: string | null;
  generated_at: string;
}
export interface AuditRequest {
  node_id: string;
  brief: string;
  to: string;                    // recipient email
  simulation?: SimResult;
}
export interface AuditResponse {
  delivered: boolean;
  mode: "live" | "simulated";
  provider_id: string | null;    // Resend message id
  to: string;
  subject: string;
  detail: string;                // human-readable reason / next step
  sent_at: string;
}
```

---

## 4. Data + math (Dev 2; everyone else consumes these numbers)

### 4.1 Seed facilities — `data/nodes.json`

Real facilities, real approximate coordinates, plausible specs. **Label the numbers illustrative in the UI footer** — they are seeded for the demo, not metered.

| id | name | type | operator | MGD cap | year | lat, lon |
| --- | --- | --- | --- | --- | --- | --- |
| `node-la-01` | Los Angeles Aqueduct Filtration Plant | Treatment Plant | LADWP Water System | 600 | 1986 | 34.2981, -118.4851 |
| `node-la-02` | Joseph Jensen Filtration Plant | Treatment Plant | MWD of Southern California | 750 | 1972 | 34.2762, -118.4747 |
| `node-la-03` | Weymouth Filtration Plant | Treatment Plant | MWD of Southern California | 400 | 1941 | 34.1131, -117.7647 |
| `node-la-04` | Robert B. Diemer Filtration Plant | Treatment Plant | MWD of Southern California | 400 | 1965 | 33.8896, -117.7591 |
| `node-la-05` | Hyperion Water Reclamation Plant | Reclamation Plant | LA Sanitation & Environment | 450 | 1950 | 33.9601, -118.4296 |
| `node-la-06` | Edward C. Little Water Recycling Facility | Reclamation Plant | West Basin Municipal Water District | 30 | 1995 | 33.9271, -118.3852 |
| `node-la-07` | Terminal Island Water Reclamation Plant | Reclamation Plant | LA Sanitation & Environment | 30 | 1972 | 33.7703, -118.2477 |
| `node-la-08` | Rio Vista Water Treatment Plant | Treatment Plant | Santa Clarita Valley Water | 60 | 1980 | 34.4212, -118.5592 |

Baseline draws must total **80.6 MW** (per-node values below) so the top bar reads a stable number:

`14.5 · 16.2 · 9.4 · 10.8 · 21.6 · 3.1 · 2.6 · 2.4`

Other per-node seed values (keep these; they make the story cohesive):

| id | CI g/kWh | pump eff | output MGD | solar rec MW | eff gain % | gas/solar/hydro/wind/other |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | 310 | 0.68 | 420 | 4.5 | 18 | 48/22/15/10/5 |
| 02 | 305 | 0.76 | 505 | 6.0 | 14 | 44/20/18/13/5 |
| 03 | 322 | 0.61 | 150 | 3.0 | 22 | 52/16/14/12/6 |
| 04 | 318 | 0.72 | 210 | 3.5 | 16 | 46/21/16/12/5 |
| 05 | 341 | 0.58 | 275 | 8.0 | 24 | 55/14/12/11/8 |
| 06 | 268 | 0.84 | 22 | 1.2 | 9 | 22/41/16/14/7 |
| 07 | 330 | 0.66 | 19 | 1.0 | 20 | 50/18/13/13/6 |
| 08 | 296 | 0.71 | 41 | 1.5 | 15 | 40/24/18/12/6 |

Expected top-bar values with these seeds (use them as assertions in G1): total draw **80.6 MW**, MW-weighted regional CI **318 gCO₂/kWh**, total annual CO₂ **≈136,200 t** (facilities run at 27–76 % of nameplate, so this is well under the 80.6 MW × 8 760 h ceiling), total annual energy **≈429,400 MWh**, 2,720 MGD nameplate vs 1,642 MGD delivered. Expected §4.3 risk scores: `01 49.7 · 02 46.4 · 03 67.2 · 04 52.8 · 05 72.3 · 06 23.4 · 07 58.0 · 08 44.9` — one LOW, five WATCH, two HIGH; the heatwave must visibly escalate 03/05/07.

`flows` (draw rivers/projects, direction = water movement):
`01 → 05` Hyperion collection trunk · `02 → 01` MWD East Branch delivery · `03 → 04` Weymouth/Rampart trunk · `04 → 07` Harbor distribution trunk · `05 → 06` Hyperion effluent → West Basin recycling · `08 → 02` Castaic Lake supply · `03 → 01` Upper feeder.

### 4.2 Formulas (§3 of the spec, exact — `lib/simulation.ts`, pure)

```ts
const HW = { output: 1.35, outputCap: 1.05, draw: 1.45, ci: 1.25 };
const SOLAR_CAPACITY_FACTOR = 0.28;   // SoCal utility-scale, 24–30% typical
const HOURS = 24, DAYS = 365, CO2_DIVISOR = 1_000_000;

// 1. stress-adjusted operating point
effectiveOutput = heatwave ? min(output * 1.35, capacity * 1.05) : output;
overload        = heatwave && output * 1.35 > capacity;
loadRatio       = effectiveOutput / capacity;
effectiveDraw   = baselineDraw * (heatwave ? 1.45 : 1);
carbonIntensity = CI * (heatwave ? 1.25 : 1);

// 2. energy + carbon  (these two lines are the ONLY place a 365 appears)
dailyMWh        = effectiveDraw * 24 * loadRatio;
annualMWh       = dailyMWh * 365;
annualCO2Tons   = dailyMWh * 1000 * carbonIntensity * 365 / 1_000_000;  // spec §3, exact
baselineCO2Tons = baselineDraw * 24 * (output / capacity) * 1000 * CI * 365 / 1e6;

// 3. upgrades
postDraw   = effectiveDraw * (1 - (vfd ? effGainPct / 100 : 0));
solarMW    = max(0, addedSolarMw);
gridOffset = min(postDraw, solarMW * SOLAR_CAPACITY_FACTOR);   // MW actually displaced
postMWh    = annualMWh * (postDraw > 0 ? (postDraw - gridOffset) / postDraw : 0);  // already annual
postCO2    = postMWh * 1000 * carbonIntensity / 1e6;            // no extra 365 — postMWh is annual
co2Avoided = annualCO2Tons - postCO2;
capex      = solarMW * solar_capex_per_mw_usd + (vfd ? vfd_capex_usd : 0);
savings    = solarMW * solar_savings_per_mw_usd + (vfd ? vfd_savings_usd : 0);
payback    = savings > 0 ? capex / savings : null;

// 4. homes equivalent (annual MWh / 10.5 MWh per US home-year)
homesEquivalent = round(annualMWh / 10.5);
```

> **One conversion rule, no exceptions:** `dailyMWh` is a *daily* figure, so it gets the `× 365`. `annualMWh` is already annual — never multiply it by 365 again (that is the classic 365× bug in this build). `postMWh` above is annual by construction, hence `/ 1e6` with no days.

`solar_savings_per_mw_usd` ≈ **215,000/yr**, `solar_capex_per_mw_usd` ≈ **1,340,000/MW** (≈6.2 yr solar-only payback), VFD ≈ **1.9 M capex / 0.42 M annual savings**. Tune the per-facility unit costs so every recommended bundle lands a **4–8 year** simple payback. `capex_estimate_usd` and `annual_savings_usd` in the JSON **must equal** the sum for the recommended bundle:
`capex = rec_solar_mw × solar_capex_per_mw + vfd_capex`, `savings = rec_solar_mw × solar_savings_per_mw + vfd_savings`.
Scale per facility by size: big plants (01, 02, 05) as above; small plants (06, 07, 08) use cheaper VFDs (0.35–0.6 M) and lower savings. Verify with a one-liner before committing:

```bash
node -e "const d=require('./data/nodes.json');for(const f of d.features){const p=f.properties.upgrade_potential;const c=p.solar_capacity_add_mw*p.solar_capex_per_mw_usd+p.vfd_capex_usd;const s=p.solar_capacity_add_mw*p.solar_savings_per_mw_usd+p.vfd_savings_usd;if(c!==p.capex_estimate_usd||s!==p.annual_savings_usd)console.log('MISMATCH',f.properties.id,c,s)}"
```

### 4.3 Energy Risk Score (`lib/risk.ts`, 0–100, higher = worse)

```ts
risk = 40 * fossilShare          // (100 - solar - hydro - wind) / 100
     + 25 * clamp((CI - 200) / 200, 0, 1)
     + 20 * clamp((0.85 - pumpEff) / 0.35, 0, 1)
     + 15 * clamp((age - 20) / 60, 0, 1)
// buckets: <35 LOW · 35–59 WATCH · 60–79 HIGH · ≥80 CRITICAL
// heatwave mode: recompute with the stressed CI, then add a flat +8 stress penalty.
// Display-only escalation — never mutate the stored properties.
```

### 4.4 Tab 1 & 2 content (Dev 2)

- **Telemetry:** facility name/type/operator, age, capacity vs output bar, current MW, `homesEquivalent`, stacked `EnergyMixChart` (Recharts `BarChart` with `stackId`, five sources, legend = mix legend), mini risk pill, CO₂/yr.
- **Upgrade Simulator:** two sliders — *Solar array* `0…2×rec` step 0.25 MW, *VFD retrofit* toggle. Live readouts: new draw, grid offset, CO₂ avoided, capex, annual savings, **payback years**. `PaybackChart` = Recharts `AreaChart`: cumulative net position over 15 years (a `-capex` line that crosses zero at payback; the crossing is the story). Sliders update instantly from `lib/simulation.ts` on the client — **do not** round-trip `/api/simulate` for slider drags; that endpoint exists for the memo pipeline and judges' curl.

---

## 5. API contract (frozen JSON)

All handlers: `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"` where they read env. Never leak keys or stack traces; return `{ error: { code, message } }` with 4xx/5xx.

### 5.1 `GET /api/region/[regionId]` → `RegionPayload` (200) · 404 unknown region

### 5.2 `POST /api/simulate` — body `SimInput` → `SimResult` (200)
Validate: `node_id` exists (404), `added_solar_mw` finite 0–100 (422). Defaults: `heatwave_active=false`, `added_solar_mw=0`, `vfd_retrofit=false` — so a bare `{ "node_id": "node-la-05" }` works for a curl demo.

### 5.3 `POST /api/generate-brief` — body `BriefRequest` → `BriefResponse`
**Memo shape (the exact contract, so the fallback and the LLM output match):**

```
To: <utility_name> — Sustainability & Operations
From: GridSentinel Audit Desk
Re: <facility name> (<type>, <age> yr) — energy resilience & decarbonization screen

RECOMMENDATION  <the intervention, in one sentence, with MW and % named>
FINDINGS        <baseline MW, load factor, carbon intensity, pump efficiency vs 0.85 benchmark>
ECONOMICS       <capex, annual savings, simple payback, CO₂ avoided t/yr — mark as screening estimates>
RISK            <heatwave exposure: projected output vs nameplate, overload status>
NEXT STEP       <one concrete request: interval data + site verification, funding path>
```

Prompt: system instruction = utility energy-audit memo voice; user content = compact JSON of the facility + simulation. Ask for **~200 words** in exactly those five labeled sections, plain text (no markdown tables, no bullet glyphs required), grade-level and decision-oriented. `temperature: 0.4`, `maxOutputTokens: 400`. The deterministic fallback must emit the **same five labels** so the UI never needs two renderers.

If no key or the call fails: return `source: "fallback"` with a template-built memo from the same numbers (never an error page). Log only `err.message`.

### 5.4 `POST /api/send-audit` — body `AuditRequest` → `AuditResponse`
- No `RESEND_API_KEY` → **200** `{ delivered: false, mode: "simulated", ... }` with a detail telling the operator to add the key. The UI shows a "simulated dispatch" receipt so the demo never dead-ends.
- Key present → `resend.emails.send({ from: AUDIT_FROM_EMAIL, to, subject, html, text })`; handle `{ error }` as 502 with a sanitized message; `provider_id = data.id`.
- `from` defaults to `GridSentinel Audits <audits@resend.dev>`; without a verified domain Resend only delivers to the account owner's address — say so in the UI under the recipient field.
- Only send to addresses matching a sane email regex; reject otherwise (400). No CC/BCC, no arrays, max one recipient.

### 5.5 UI-side fallback values (so shell work never blocks)

`ControlBar` KPIs before data: `— MW`, `— g/kWh`, `— t`; `MapCanvas` renders a "loading telemetry" skeleton on the dark base tiles; `AnalyzerDrawer` shows the empty state "Select a facility". Dev 1 must render the shell with `RegionPayload` fixtures of their own if Dev 2 is not merged yet — keep the fixture in `components/shell/__fixtures__.ts` (Dev 1-owned) so it is deleted before ship.

---

## 6. Design system (Dev 4 delivers `design/tokens.css` in the first hour)

Tokens as CSS custom properties, consumed in `app/globals.css` via `@import "../../design/tokens.css";` (Dev 1 adds that one line). Tailwind v4 `@theme` maps them to utilities.

| Token | Dark default | Heatwave (`[data-stress="true"]`) |
| --- | --- | --- |
| `--bg` | `#080B12` | `#0C0709` |
| `--panel` | `#0E1420` | `#150C0E` |
| `--panel-raised` | `#141C2B` | `#1C1013` |
| `--border` | `#22304A` | `#4A2318` |
| `--text` | `#EDF2F8` | `#FDF3EC` |
| `--muted` | `#8FA0B8` | `#C4A79C` |
| `--accent` | `#38D6C4` (teal) | `#FFB020` (amber) |
| `--accent-2` | `#4C8DFF` | `#FF6B3D` |
| `--ok` | `#2DD4A7` | `#2DD4A7` |
| `--warn` | `#E8A33D` | `#FFB020` |
| `--high` | `#F97316` | `#FF6B3D` |
| `--critical` | `#F04D5E` | `#FF2E4D` |
| `--grid-line` | `rgba(56,214,196,.10)` | `rgba(255,176,32,.12)` |

Risk ramp is **green → amber → vermilion → crimson** and **always paired with a text label** (`LOW/WATCH/HIGH/CRITICAL`), never color alone. Numerics use `font-variant-numeric: tabular-nums`; values are the dominant element, units smaller and muted.

Layout: top bar `height:64px`, main `display:flex`, canvas `flex: 1 1 65%`, drawer `flex: 0 0 35%; min-width: 400px` — collapse under `lg` (drawer becomes a full-height overlay). The drawer is the only scrolling region.

Anti-goals: no gradients-for-gradients'-sake, no neon glow on body text, no purple SaaS gradients, no animated counters, no icon fonts. Texture allowed: 24 px grid overlay at `--grid-line`, 1 px hairlines, monospace for IDs/timestamps only.

### Control bar contents

Left: product mark + region selector (single option `Greater Los Angeles Basin`, a real `<select>` so it looks extensible). Center: three `Stat` KPIs — **TOTAL GRID DRAW (MW)**, **GRID CARBON INTENSITY (gCO₂/kWh)**, **ANNUAL CO₂ (t)**. Right: heatwave toggle switch labeled `SIMULATE 105 °F HEATWAVE`, and an `N OVERLOAD` pill that appears only when any facility overloads. Toggling sets `data-stress` on `<html>` and a `useHeatwave` prop threaded to map + tabs.

### Map

- Base: `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`, attribution `&copy; OpenStreetMap contributors &copy; CARTO`, `maxZoom 19`, initial center `[34.05, -118.25]`, zoom `9`.
- Markers: `L.divIcon` dot sized `10 + capacity/60` px, fill = risk color, `2px` ring in `--bg`; selected marker gets an accent halo + `bringToFront`. Include an invisible larger click target (min 28 px).
- Flow lines: `L.polyline([[lat,lon],…], { className: "flow-line", color: "var(--accent)", weight: 1 + mgd/120, opacity: .55 })`, CSS `@keyframes dash { to { stroke-dashoffset: -24 } }`, `stroke-dasharray: 2 10`, `animation: dash 1.2s linear infinite`. Heatwave: `animation-duration: .5s`, color `--warn`. Compass/legend card (bottom-left): risk ramp + `flow direction` note; heatwave legend note.
- Avoid SSR: `MapCanvas` does `dynamic(() => import("./MapView"), { ssr: false })`; `import "leaflet/dist/leaflet.css"` inside `MapView`. Call `map.invalidateSize()` on drawer/tab changes.

---

## 7. Sprint plan (gates, not clocks)

| Gate | Who | Exit criteria |
| --- | --- | --- |
| **G0 — Contract** | Dev 4 + Dev 2 | `design/tokens.css` + `components/primitives/*` exist; `lib/types.ts` committed. Everyone unblocked. (~45 min) |
| **G1 — Data spine** | Dev 2 | `data/nodes.json` valid GeoJSON, totals match §4.1, `lib/simulation.ts` + `/api/simulate` return sane numbers for `node-la-05` in heatwave. |
| **G2 — Shell on screen** | Dev 1 | Dark map + 8 markers + flows + control bar + working 3-tab drawer navigation, KPIs wired to `RegionPayload`. |
| **G3 — Analytics live** | Dev 2 | Tabs 1–2 render real charts; sliders change payback instantly; no `NaN`/`Infinity` in any readout. |
| **G4 — Outreach live** | Dev 3 | Memo generates (fallback if no key), dispatch returns a receipt; button shows pending/done/error states. |
| **G5 — Integration** | All | `npx tsc --noEmit` clean, `npm run build` clean, one browser pass with heatwave on/off, three tabs, one dispatch. |
| **G6 — Pitch** | Dev 4 | `docs/DEMO.md` rehearsed twice; numbers on screen match `docs/PITCH.md`; one fallback path tested (no API keys). |

**Blocking order:** G0 → G1/G2 in parallel → G3 after G2 → G4 after G1 → G5 → G6. Dev 3 can build the entire memo UI against `SimResult` fixtures before G1.

---

## 8. Merge order

1. `feat/dev4-tokens` (tokens + primitives + docs)
2. `feat/dev2-data-sim` (types, data, lib, APIs, tab 1–2 components)
3. `feat/dev1-shell` (layout, page, globals, map, control bar, drawer)
4. `feat/dev3-outreach` (AI, email, tab 3)
5. Integrator applies dev1's one-line tokens import, wires tabs to components, deletes `components/shell/__fixtures__.ts`.

`app/page.tsx` is the single composition point **and is owned by Dev 1 only** — everyone else ships self-contained components that take the props documented in §3.

---

## 9. Environment (all optional)

```bash
cp .env.example .env.local
```

| Var | Effect if missing |
| --- | --- |
| `GEMINI_API_KEY` | Memo falls back to deterministic template, banner reads "template memo" |
| `GEMINI_MODEL` | Defaults to `gemini-2.5-flash` |
| `RESEND_API_KEY` | Dispatch returns `mode: "simulated"` receipt |
| `AUDIT_FROM_EMAIL` | `GridSentinel Audits <audits@resend.dev>` |
| `DEMO_INBOX_EMAIL` | Recipient field starts empty with placeholder |

Secrets stay server-side and out of git. `.env.local` is ignored.

---

## 10. Demo script (Dev 4 owns the final version in `docs/DEMO.md`)

| Time | Beat |
| --- | --- |
| 0:00–0:20 | "Water is a 4 %-of-US-electricity industry, and its risk is invisible until something fails. This is the region's 8 largest facilities, colored by energy risk." |
| 0:20–0:55 | Click Hyperion (worst CI, oldest pumps). Telemetry: 21.6 MW, ~341 g/kWh, X homes, 24 % pump inefficiency. |
| 0:55–1:30 | Hit **105 °F HEATWAVE**. Theme shifts amber, output pushes past nameplate → **OVERLOAD**, draw +45 %. "This is the afternoon a peaker plant gets called." |
| 1:30–2:15 | Upgrade Simulator: 8 MW solar + VFD → draw falls, CO₂ avoided, payback ~5 yrs, cumulative-cashflow line crosses zero on screen. |
| 2:15–2:45 | Provider Action → generate memo → **Dispatch**. Email lands in the demo inbox live. |
| 2:45–3:00 | "Same pipeline, every region. The analysis that took a consultant a quarter now takes a click." |

Numbers must be checked against the live screen in rehearsal — no reading from memory.

---

## 11. Risk register

| Risk | Mitigation |
| --- | --- |
| No Mapbox token | Leaflet + CARTO (decided) |
| No Gemini key on demo laptop | Deterministic fallback memo, labeled |
| Resend domain not verified | `onboarding@resend.dev` to account owner; simulated mode otherwise |
| Spectator wifi dies | All data static, no external calls on the happy path |
| Parallel sessions stomping files | Ownership table §0, single composition point |
| Slider math shows `Infinity` | `payback_years: null` + "n/a" render; Dev 2 unit-checks `savings = 0` |
| Numbers called out as fake | Footer disclaimer "seeded demo data — facilities real, telemetry modeled" |
