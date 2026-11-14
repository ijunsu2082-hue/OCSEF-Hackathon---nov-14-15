# GridSentinel competitive teardown — Part 1

**What the multi-billion-dollar grid platforms actually sell, and what we should rip.**

Status: research / brainstorm, 2026-11-14. No application code changed by this document.
Companion: [`docs/FEATURE-BACKLOG.md`](./FEATURE-BACKLOG.md) (gap map, ranked backlog, optimizations, demo script, sources, formulas).
Ground truth for our numbers: `README.md` §4, `docs/GRID-MODEL.md`, `docs/PHYSICS-HANDOFF.md`.

---

## 0. Five corrections before we copy anything

The other session's product list is directionally right, but several claims need tightening before they become pitch lines. Our entire thesis is provenance; a borrowed fact with no source is worse than no feature.

| # | Claim to correct | What the record actually says | What we should do instead |
|---|---|---|---|
| 1 | "Palantir Foundry is a grid management platform." | PG&E's PSPS annex says its **PSPS Situational Intelligence Platform (PSIP)** is built on Foundry, connects to **50+ source systems** (GIS, SAP, customer care/billing), and **does not replace those systems of record**. Foundry is the integration/analytics/workflow layer. | Copy the **situation report, scope-as-it-changes, trace/connectivity and case-file** patterns. Never imply we are SCADA/ADMS. Position as *system of insight over systems of record*. |
| 2 | "GE Vernova GridOS / SmartSignal does predictive asset health and 2D/3D visualization." | SmartSignal is sold under **APM**, not GridOS. It produces **residuals** (actual vs. predicted normal), prioritized alerts, likely cause and time-to-action. FLISR, state estimation and contingency analysis live in **GridOS ADMS/AEMS**, not SmartSignal. | Attribute each pattern to the right module. Rip **residual health** from SmartSignal and **N-1/FLISR** from ADMS/AEMS as two separate features. |
| 3 | "AVEVA CONNECT / Schneider EcoStruxure unify grid data." | AVEVA **PI** is operational data infrastructure: time-series storage, PI AF asset context, PI Vision dashboards/trends/alarms. Schneider **EcoStruxure ADMS** is the grid operations product; **ArcFM** is utility GIS/design/workflow. PG&E's published example integrates GIS → ADMS → **PI AF** topology metadata linked to SCADA. | Rip **asset hierarchy + trend/alarm cards** from PI, **ETR/storm/crew/design packages** from Schneider, and keep the product boundaries honest. |
| 4 | "Enterprise tools combine variables into a single 0–100 score." | Only a few publish reproducible math: **IBM Maximo** (`risk = ((100 − health)/100) × criticality`), **FEMA NRI** (`risk = EAL × community risk factor`, percentile-scored), **Technosylva** (0–1 composite; `expected risk = POF × consequence`, `RAIL = POF × POI × consequence`). Neara, AiDash, LiveEO, Overstory, Gridware, C3 AI and SmartSignal publish **factor lists, not weights**. | Adopt a **likelihood × consequence** structure, show the decomposition, and label the weights as **our screening assumptions**. Do not call them industry-standard. |
| 5 | The proposed demo examples — "Cajon Pass 500 kV", "Mojave Solar Farm", "Central LA Substation", "12,400 residential customers". | None of those names or numbers exist in our dataset. Our 11 assets are **water/desal load centers**; our 9 ties are **modeled** segments. Cajon Pass is inside the 100-mile ring, but the 500 kV claim, the solar farm and the customer count need sources we do not have. | Use Hyperion, Carlsbad, Jensen, LAAFP, etc. Put the wildfire story on a **real OSM corridor inside an FHSZ polygon**, and derive customers from **ACS block-group data** with a `modeled` tag. |

### 0.1 A real topology bug the cascade feature would expose

`data/nodes.json` has **9 edges over 11 nodes**, which is **two connected components**, not one:

```
component A (2): node-oc-01, node-oc-02
component B (9): node-la-01 … node-la-08, node-sd-01
```

The Orange County pair is electrically floating from the LA/San Diego tree. The README claims "one connected component" — that line is wrong. Before we ship any N-1, cascade, PSPS or "trace upstream/downstream" feature, we must either:

1. add one sourced OC↔LA tie (the Fountain Valley–Westminster 69 kV corridor is the obvious candidate), or
2. render and report the two islands honestly, with the OC pair labeled "islanded / no modeled tie".

This matters because a cascade demo on a **tree** is not a cascade — removing an edge simply de-energizes a subtree. To show rerouting and overload propagation we need at least one **loop** (one extra tie). Any added tie must be tagged `modeled` in the data and the UI.

### 0.2 The heatwave already contains a better cascade story than the invented one

Computed from `data/nodes.json` with the README §4.2 formulas (corridor throughput = larger connected draw; capacity = `mva × 0.88` under heatwave):

| Corridor | Base loading | Heatwave loading | Status at 105 °F |
|---|---:|---:|---|
| `flow-oc-02-oc-01` Fountain Valley 69 kV tie | 60.0 % | **133.5 %** | critical (islanded pair) |
| `flow-la-05-la-06` West Basin 69 kV tie | 54.0 % | **120.1 %** | critical |
| `flow-la-05-la-07` Harbor 115 kV trunk | 48.0 % | **106.8 %** | critical |
| `flow-la-04-sd-01` SDCWA emergency intertie | 35.6 % | 73.0 % | high |
| `flow-la-08-la-02` Castaic 230 kV | 27.0 % | 60.1 % | watch |
| remaining four | 9–14.4 % | 20–32 % | ok |

Three corridors cross 100 % **without inventing a single number**. That is the cascade demo: heatwave pushes West Basin and Harbor over rating, Hyperion is the load center behind both, and the OC pair is already islanded. Add one modeled OC↔LA tie and one loop (for example a modeled `la-06 ↔ la-07` West Basin/Harbor 69 kV tie), and the N-1 story becomes: trip one tie → flow reroutes → the parallel tie goes over rating → protection trips it → subtree de-energizes.

---

## 1. What we already have (do not re-buy it)

| Capability | Where it lives | Maturity vs. enterprise | Notes |
|---|---|---|---|
| 2D command-center map, 100-mile ring, 11 load centers, 9 flows | `components/shell/MapView.tsx`, `MapCanvas.tsx`, `data/nodes.json` | Good demo, below GIS-grade | Leaflet + CARTO raster; real EIA-860 plants, OSM transmission/substations in `public/layers` |
| Composite energy risk score (0–100) | `lib/risk.ts` | Screening only | 40 % fossil, 25 % CI, 20 % motor inefficiency, 15 % age; +8 heatwave |
| Heatwave demand shock + theme | `lib/simulation.ts`, `Workspace.tsx`, `design/tokens.css` | Good | 1.35× utilization capped at 105 %, 1.45× draw, 1.25× CI |
| Solar + VFD upgrade simulator, payback chart | `simulation.ts`, `UpgradeSimulatorTab.tsx` | Good | Per-asset sliders; bundle economics are screening estimates |
| Six-phase grid chain with diagnostics + pathways | `lib/grid.ts`, `GridChainTab.tsx` | Strong for a hackathon, below ADMS | Generation → transmission → substation → distribution → behind-meter → market; real layers + physics |
| Radial power flow, two-bus exact, voltage collapse | `lib/physics/network.ts` | Real engineering math | Backward-forward sweep; throws on meshed/mixed-voltage networks |
| Short circuit / SCR / hosting capacity | `network.ts` | Real screening math | `hostingCapacity()` binary-searches against V limits, branch loading, reverse flow |
| Transformer thermal + IEEE C57.91 aging | `physics/thermal.ts` | Real screening math | Top-oil, hot-spot, loss-of-life |
| Conductor heat balance, sag risk, DLR | `physics/thermal.ts`, `public/layers/line_rating_2024_westminster_hs.csv` | Real screening math | IEEE 738 screening form |
| Frequency dynamics, ROCOF, nadir, UFLS | `physics/dynamics.ts` | Real screening math | Single aggregated control area |
| Load/PV/BESS/weather, 8760 | `physics/load.ts`, `municipality.ts` | Real screening math | Sector shapes, Erbs diffuse, PV cell temp, battery SOC |
| Economics: CRF, LCOE, NPV, IRR, payback, VOLL, carbon cost | `physics/economics.ts` | Real screening math | Not yet wired into the upgrade tab |
| Evidence bundle: 4 claim methods, hashes, verifier | `lib/evidence/*`, `public/evidence/westminster-100mi.json` | **Ahead of most enterprise demos** | observed / derived / modeled / inferred; content-addressed ids; citations in the drawer |
| Click-anywhere area scan | `lib/scan/areaScan.ts`, `AreaScanPanel.tsx` | Distinctive | Real EIA/OSM aggregation, risk factors, ideas, report |
| Niche local cases (wildfire, heat, water-energy) | `lib/niche.ts`, `public/layers/niche_cases.json` | Distinctive | Every stat tagged measured/modeled with a source |
| AI memo + email dispatch with offline fallback | `lib/ai/brief.ts`, `lib/email/dispatch.ts` | Good | Gemini + Resend, deterministic fallback |
| Zero-key, single-deploy, static data | `README.md` §1 | **Huge demo advantage** | No API key on the happy path |

### 1.1 Where we are genuinely ahead

1. **Provenance.** Four claim methods, content hashes, a verifier, and citations next to numbers. Palantir's lineage story is the enterprise analog; most competitors show a number with no path back to bytes.
2. **Physics depth.** We have a real radial solver, thermal aging, conductor heat balance, frequency dynamics and hosting capacity — in pure TypeScript, no Python service. Most hackathon "digital twins" stop at multiplication.
3. **Local specificity.** Real sites, verified coordinates and in-service years, real EIA/OSM layers, real line-rating CSV.
4. **Demo resilience.** Zero env vars, static data, deterministic fallbacks. The README's risk register is unusually honest.

### 1.2 Where we are structurally behind — the five gaps that matter

| Gap | What it means | Enterprise reference | Why judges feel it |
|---|---|---|---|
| **Consequence** | We report MW, MWh, tCO₂ and homes-equivalent — not **people, critical services, dollars at risk, or duration**. | Palantir PSIP situation report; SDG&E/Liberty PSPS consequence models; FEMA NRI | "So what?" A 20 MW overload matters because a hospital loses water, not because 20 MW is large. |
| **Closed loop** | We detect → analyze → recommend → email. We never **assign, execute, verify or close**. | Maximo/ArcFM work orders; GE Visual Intelligence crew assignment; Palantir case management | Judges ask "what happens after the memo?" We have no answer. |
| **Operations** | No N-1, no restoration sequence, no switching proposal, no damage assessment, no inspection queue. | GridOS ADMS/AEMS, Spectrum Power FISR, Schneider Grid Operation | We look like a planning dashboard, not an operations tool. |
| **Economics realism** | No demand charges, TOU, ITC/adders, incentives, marginal emissions, uncertainty, portfolio budget. | DSIRE, NREL SAM/ATB, WattTime/Cambium, PLEXOS/GenX | Our 5-year paybacks are too clean; a judge who knows solar will ask about ITC and demand charges. |
| **Productization** | No export/share link, no PDF/CSV, no API, no roles, no audit log, no mobile. | PI Vision, Palantir Workshop, Esri Experience Builder | The demo ends when the laptop closes. Nothing tangible is handed over. |

---

## 2. Vendor deep dives, module by module

### 2.1 Siemens — Spectrum Power ADMS + Gridscale X

Siemens' own module catalogue groups the ADMS into *Monitor & Operate*, *Analyze & Optimize* and *Track & Restore*: SCADA, **GIS Data Import Management (GDIM)**, **Outage Management**, **Fault Location**, **Fault Isolation and Service Restoration (FISR)**, **Volt/Var Control (VVC)**, switching procedures, crew tasking, and load/renewable forecasting. Gridscale X is a **portfolio** that extends those systems, not a single product.

| Module | What it actually does | Our closest analog | What to rip |
|---|---|---|---|
| **Spectrum Power ADMS** | SCADA + OMS + DMS; network tracing, alarms/control, outage location, affected-customer identification, crew tasking, switching procedures | Map + grid chain + memo | Fault → isolate → restore **sequence**; switching proposal validation; affected-customer count |
| **Gridscale X Network Model Manager** | Consistent network model repository; model/project workflows; **versioned REST/OpenAPI** | `data/nodes.json` + evidence bundle | "Model as of" badge; **model diff**; versioned read API; change log |
| **LV Insights** | Continuously updated low-voltage digital twin from existing data; topology/state; critical segments | Area scan | **Coverage/confidence** per area; "what data is missing here"; critical-segment ranking |
| **LV Management** | Planned/unplanned outage workflows; predicted outage location/impact; validated switching proposals; transformer overload identification/resolution | None | N-1/PSPS scope; **overload resolution** pathway; switching proposal preview |
| **DER Insights** | Behind-the-meter DER visibility, behavior, equipment impact | `source_mix`, solar upgrade | DER share per load center; hosting-capacity context |
| **Flexibility Manager** | Forecasts constraints; identifies flexibility from EVs, heat pumps, batteries, DG; curtailment plans; flexible connection agreements | VPP/DR pathways in `lib/grid.ts` | **Non-wires alternative** comparison: flexibility procurement vs. capex |
| **"Autonomous grid"** | Closed-loop detect → decide → act | None | Only the **recommend → validate → execute** framing; do not claim automation |

**Rip list (highest value first):** model versioning + diff; switching/restoration sequence; overload resolution; data coverage/confidence; flexibility-vs-capex; versioned API.
**Do not rip:** SCADA control, autonomous switching, real-time state estimation. We have no telemetry and no authority.

### 2.2 GE Vernova — GridOS, Smallworld, SmartSignal

GE's GridOS is a portfolio: **Smallworld Geo Network Management** (as-built geo-connected model), **ADMS** (DMS + OMS + DERMS, FLISR, field mobility/damage assessment), **AEMS** (EMS/WAMS, state estimation, contingency analysis, renewables forecasting, restoration), **DERMS** (Model Manager, Program Manager, Gateway, Operations, Forecasting, Optimization, Markets Orchestration), **Visual Intelligence** (imagery/LiDAR over the network, trimming risk, image attached to a work order, crew assignment). **SmartSignal** is APM: residuals vs. predicted normal, prioritized alerts, apparent cause, time-to-action.

| Module | What it actually does | Our closest analog | What to rip |
|---|---|---|---|
| **Smallworld GNM** | As-built, geo-connected network model used for planning, simulation, disruption response, vegetation | OSM layers + `flows` | **Connectivity trace** (upstream/downstream); asset hierarchy; "as-built vs. as-modeled" badge |
| **GridOS ADMS** | DMS + OMS + DERMS; FLISR; field mobility; damage assessment | Grid chain + memo | **FLISR sequence** (pinpoint → isolate → restore healthy blocks); damage checklist; crew status |
| **GridOS AEMS** | EMS/WAMS; state estimation; **contingency analysis**; forecasting; restoration | Physics layer, unused in UI | **N-1 contingency screen**; pseudo-state from nameplate × utilization; restoration order |
| **GridOS DERMS** | Model/Program/Gateway/Operations/Forecasting/Optimization/Markets | Solar/VFD, VPP pathway | Program enrollment/status; forecast → optimize; **market revenue** line |
| **Visual Intelligence** | Imagery/LiDAR risk layers; trimming risk color; work order with image; crew assignment | Niche wildfire cases | **Inspection work order** with evidence/photo; vegetation risk only where FHSZ/OSM supports it |
| **SmartSignal** | Residuals; prioritized diagnostic alerts; likely cause; time-to-action | None | **Expected vs. reported residual** card; "time to limit" from thermal aging; alert prioritization |

**Rip list:** N-1 contingency; FLISR/restoration sequence; residual health + time-to-action; visual-risk → work order; trace; DER program status.
**Do not rip:** WAMS/PMU, state estimation claims, 3D LiDAR. We have no sensor stream.

### 2.3 AVEVA CONNECT / PI + Schneider Electric EcoStruxure / ArcFM

| Product | What it actually does | Our closest analog | What to rip |
|---|---|---|---|
| **AVEVA CONNECT** | Cloud integration/sharing of industrial data, models, apps, analytics | Evidence bundle (lineage) | Source catalog + **coverage %**; "shared model" version |
| **PI Server / PI AF** | Time-series + asset context hierarchy; PG&E linked GIS→ADMS→PI AF topology metadata to SCADA | `lib/types.ts`, `flows` | **Asset hierarchy tree** (region → corridor → load center → phase); context on every number |
| **PI Vision** | Browser dashboards, trends, gauges, symbols, visual alarms | Recharts + Sparkline | **Trend cards** (24 h / 8760); alarm strip; "last updated" |
| **EcoStruxure ADMS** | DMS + OMS on a common network model; monitoring, analysis, control, optimization, planning, training | Grid chain | Common-model framing; planning vs. operations views |
| **EcoStruxure Grid Operation** | OMS, switching, crew/storm management, **estimated restoration time**, damage assessment, outage prediction from calls/AMI/SCADA; FLISR add-on | None | **ETR** from scope + crew/travel assumptions; storm/crew board; damage assessment |
| **EcoStruxure DERMS** | Monitoring, forecasting, control, **hosting capacity**, constraints, flexibility, optimization, planning, dispatch | Physics hosting capacity | Hosting-capacity heatmap; queue; dispatch scenario |
| **ArcFM XI** | Editor/Mobile/Web/Designer; GIS validation; graphic work design; design lifecycle; field assignments; work-management/OMS integration | None | **Design package**: scope, BOM, cost, permits, approval state; work order |

**Rip list:** asset hierarchy; trends/alarms; ETR; storm/crew board; design package; hosting capacity.
**Do not rip:** GIS editing, field mobility, storm restoration at utility scale.

### 2.4 Palantir Foundry at PG&E and SCE

Foundry is the **integration/analytics/workflow layer** on top of systems of record. PG&E's PSIP uses 50+ sources and explicitly does **not** replace GIS, SAP or customer care/billing. Named workflows:

- **Internal Situation Report** — de-energization impacts from planning through restoration.
- **Distribution Asset Health Specialist (DAHS) Dashboard** — asset/vegetation tags against meteorological guidance.
- **PSPS Viewer** — EDGIS tracing/connectivity, transformer identification, abnormal configurations such as microgrids and backfeeds.
- **Notification campaigns** — scope changes as the event evolves; SCE connects campaigns to its Emergency Outage Notifications System (EONS), which actually sends.
- **Wildfire risk cubes** — probability/consequence/risk data presented through Slate, Contour, Maps and Workshop.
- **Transformer failure investigation** — GIS + sensor + environmental + outage + work-management + inspection data → high-risk list and investigation workflow.
- **WMP program management / work planning.**

| Pattern | Why it works | Our cheap version |
|---|---|---|
| **Situation report** | One page an executive can read during an event: scope, customers, critical facilities, duration, actions | A generated **one-pager** from existing sim + census + queue, printable/PDF, with sources |
| **Scope as it changes** | PSPS scope is not static; notifications must follow the current operating configuration | A scenario timeline with 3 states (plan / armed / de-energized) and a notification-list diff |
| **Trace / connectivity** | "Which customers are downstream of this transformer?" | Graph traversal on our `flows`; highlight subtree; count load centers/MW |
| **Case file** | Investigation state, evidence, owner, notes | Per-asset case with status, owner, evidence links, decision log |
| **Risk cube** | Slice risk by likelihood, consequence, geography, asset class | Faceted filter on the facility rail (bucket × type × operator × age) |
| **"Does not replace systems of record"** | Credibility; avoids control-room comparisons | Say it explicitly on the method tab and in the pitch |

**Rip list:** situation report; scope-as-it-changes; trace; case file; risk cube filters; notification list.
**Do not rip:** 50-system integration, Foundry itself, customer notification sending.

### 2.5 The five patterns that repeat across all four vendors

1. **System of record vs. system of insight.** The platform on top explains, prioritizes and orchestrates; it does not pretend to be SCADA. We should adopt this positioning *hard*.
2. **One common network model, versioned.** Siemens NMM, GE Smallworld, Schneider ADMS, Palantir's EDGIS trace. Our `nodes.json` is the model; it needs a version, a diff and a "as of" badge.
3. **Risk = likelihood × consequence, with criticality.** Maximo multiplies health by criticality; Technosylva multiplies POF × POI × consequence; FEMA NRI multiplies EAL by community risk. Our score is likelihood-only.
4. **Closed loop.** Detect → triage → assign → execute → verify → close. We stop at "send memo".
5. **A situation report and an export.** Every enterprise platform has a one-page artifact for people who will never open the map. We have nothing to hand over.

---

## 3. The four proposed features, expanded into buildable specs

Each spec below is written so another session can pick it up without re-deriving the design. Ownership follows the README §0 path rules: `lib/types.ts` stays frozen; new pure logic goes in `lib/`; new UI gets its own component file.

### 3.1 Composite Asset Risk Index v2 — from "score" to "decision"

**The other session's version:** `Risk = Age + Thermal Load % + Wildfire/Weather Tier`, shown as a circular gauge.

**Why that is not enough:** it mixes likelihood and consequence into one sum, has no criticality, no dollars, no uncertainty, no peer context, and no explanation of which factor moved the number. A judge cannot interrogate it, and a utility engineer will not trust it.

**What the published formulas actually do:**

| Source | Formula | What it gets right | What we should borrow |
|---|---|---|---|
| IBM Maximo | `risk = ((100 − health)/100) × criticality`; health = RUL score + open work orders + open service requests; criticality 1–5 | Separates **asset condition** from **business importance** | The multiplication; criticality as a first-class input |
| Technosylva | `expected risk = POF × consequence`; `RAIL = POF × POI × consequence`; composite 0–1; percentiles; explicitly a screening tool | Separates **failure likelihood**, **ignition likelihood given failure**, and **consequence** | Three-factor structure for wildfire corridors; percentile display |
| FEMA NRI | `risk = expected annual loss × community risk factor`; national percentiles; 18 hazards | Dollarizes consequence; separates social vulnerability/resilience | EAL framing; percentile; equity factor |
| ENERGY STAR Portfolio Manager | 1–100 score, peer benchmark, property-type caveat | Makes a score legible to non-engineers | Percentile + "not comparable across types" caveat |

**Proposed model (screening, three visible layers):**

```
L  = likelihood / exposure (0–100)
     = 40·fossilShare + 25·clamp((CI−200)/200) + 20·clamp((0.85−motorEff)/0.35)
       + 15·clamp((age−20)/60) + heatwavePenalty(0–8)
       + overloadPenalty(0–10)          // new: heatwave corridor/asset overload
C  = consequence / criticality (1–5)
     = 1 + 4 · normalized( downstream population served
                        + criticalFacilities weight
                        + water-service dependency
                        + MW share )
     default 3 when no customer/CFI data, labeled "assumed"
R  = clamp(L × C / 3, 0, 100)            // C = 3 is neutral, so defaults keep today's score
EAL = (L/100) × baselineFailureRate × consequence$   // $/yr, screening only
```

- **Do not hide the axes.** Show `L` and `C` separately in the facility rail (a 2×2 or 5×5 matrix) and show `R` as the headline. This is more honest than a single gauge and more useful: two assets can share `R = 60` for opposite reasons.
- **Confidence** is a separate badge: `high` when the asset has observed layer data + evidence claims; `medium` when one input is modeled; `low` when customers/CFI are assumed.
- **Peer percentile** within the region and within type ("worse than 7 of 11 load centers"; "2nd of 4 desalination loads").
- **Risk removed per $** is the bridge to the upgrade tab: `ΔR × consequence / capex`. This is the Neara "risk removed per dollar" pattern and the single most useful number for a budget conversation.
- **Decomposition** must sum to the score: five factor bars plus the criticality multiplier. Hovering a bar names the input and its source claim.

**UI landing spots:**

| Where | Change | File |
|---|---|---|
| Drawer header | Keep `RiskPill`; add `L 72 · C 4 · R 96` and confidence dot | `AnalyzerDrawer.tsx` |
| Telemetry tab | Replace the single stat with a **gauge + factor waterfall + "why" chips**; add percentile | `TelemetryTab.tsx` |
| Facility rail | Add a tiny `L/C` matrix or two-axis dot; sort by `R`, `L`, `EAL` | `FacilityRail.tsx` |
| Upgrade tab | Add "risk removed / $" next to payback | `UpgradeSimulatorTab.tsx` |
| Control bar | Optional: `N assets above R 60` instead of only overload count | `ControlBar.tsx` |

**New pure modules:** `lib/criticality.ts` (population/CFI/dependency → C), `lib/riskV2.ts` (or extend `lib/risk.ts` with new exports; keep `energyRisk` for backward compatibility).

**Acceptance checks:**

1. All 11 nodes produce finite `L`, `C`, `R`; no `NaN`/`Infinity`.
2. Factor decomposition sums to `L` within 0.1 (rounding declared).
3. Heatwave preserves the README **L-ranking** story: Hyperion remains the exposure leader; Carlsbad remains the utilization leader. (The `C` multiplier can change the `R` order — that is the point, and the matrix must show it.)
4. Unknown criticality → `C = 3`, `confidence = low`, visibly labeled "assumed".
5. `R` is monotonic in `L` at fixed `C` and monotonic in `C` at fixed `L`.
6. `EAL` is zero when consequence data is absent — never invented.
7. Snapshot test against the README §4.4 values for the unchanged factors.

**Claims discipline:** call it a **screening index**, never a failure probability. Say "weights are our assumptions, shown so you can change them." Do not call it "industry-standard."

**Handoff prompt (copy-paste):**

> Implement Risk Index v2 in `lib/risk.ts` + new `lib/criticality.ts`, with UI in `TelemetryTab`, `FacilityRail`, `AnalyzerDrawer`, `UpgradeSimulatorTab`. Keep `lib/types.ts` frozen. `L` = existing `energyRisk` factors + overload penalty; `C` = 1–5 from downstream population/CFI/water dependency/MW with default 3; `R = clamp(L × C / 3, 0, 100)`; expose decomposition, confidence, percentile, and risk-removed-per-$. Add golden tests for all 11 nodes and a "C assumed" label. Do not call it a probability.

---

### 3.2 PSPS Impact Simulator — "who gets hurt if we de-energize this?"

**The other session's version:** red buffer around high-risk lines, banner "de-energizing 115 kV cuts power to 3 pumping stations and 12,400 customers."

**What is missing:** wind/red-flag trigger, FHSZ tier, actual customer allocation, medical-baseline and critical-facility weighting, duration, dollar consequence, DAC overlay, notification list, and a "surgical" alternative. Also: our region is coastal urban; the wildfire exposure is on the **corridors in the foothills/mountains**, not at the load centers. The demo must say that.

**Inputs we have vs. need:**

| Input | Status | Source / note |
|---|---|---|
| Load centers, MW, ties, connectivity | Have | `data/nodes.json` |
| Corridor loading and age | Have | `lib/grid.ts`, `lib/gridAssets.ts` |
| Population / households per block group | **Need snapshot** | Census ACS 5-yr API (free); one fixture already exists for the school point |
| Critical facilities (hospitals, schools, fire, water/wastewater) | **Need snapshot** | OSM Overpass (free, ODbL) — already used for substations |
| Medical baseline / disability proxy | **Need snapshot** | ACS disability + age 65+; label **proxy**, not utility MBL |
| Fire hazard tier | **Need snapshot** | CAL FIRE FHSZ (public); hazard, not risk |
| DAC / disadvantaged community | **Need snapshot** | CEJST or CalEnviroScreen; tract-level |
| Wind / red-flag scenario | **Scenario input** | User slider (mph) or a documented assumption; no live weather needed |
| Utility PSPS thresholds | **Assumption** | Label as a scenario, not a utility rule |

**Model:**

```
1. Trigger tier per corridor:
   tier = worst( FHSZ class, wind band, asset age/health, vegetation proxy )
   Wind bands: <25 mph watch, 25–40 high, >40 critical (assumption, shown)

2. De-energize selected corridor(s):
   remove edges from the graph; BFS components; affected load centers =
   component not containing the modeled source/slack.

3. Customers:
   allocate block-group households to nearest load center (Voronoi / nearest
   centroid); sum affected; label "modeled service area".

4. Weighted impact (published utility structure):
   weighted = 30 × MBL_proxy + 30 × CFI + 1 × other   (Liberty 2026–28 WMP)
   or consequence multipliers 20/10/30 for CFI, 5/1/1 for MBL (SDG&E).
   Use one, show the formula, cite it.

5. Duration and dollars:
   hours = user input, default 18 h (Liberty average PSPS duration)
   unserved MWh = affected MW × hours
   $ = unserved MWh × VOLL + customer interruption cost
   VOLL from `DEFAULT_ECONOMICS` (physics/economics.ts)

6. Surgical alternative:
   greedy search over corridor subsets that removes the highest FHSZ tier
   while minimizing weighted customers; show the trade-off curve.

7. Notification preview:
   count of customers/CFI by language/access proxy; "24–48 h notice" assumption.
```

**UI:**

- Control bar: a second scenario toggle `PSPS / RED FLAG` next to heatwave, with a wind slider. It must visibly change the map (red corridor buffers, de-energized subtree dimmed, affected load centers pulsing).
- Map: FHSZ polygons (very high / high), corridor tier color, buffer, de-energized segments dashed, affected load centers ringed.
- Drawer/banner: **situation report** card — corridors de-energized, load centers affected, MW, modeled customers, MBL proxy, CFI count, duration, $ consequence, DAC share, notice window.
- A `Surgical alternative` toggle that shows the smaller scope and the customers saved.
- A `Copy notification list` / `Export situation report` action (CSV/PDF/print).

**New modules:** `lib/psps.ts` (scope, weighting, dollars), `lib/serviceArea.ts` (block-group allocation), `components/psps/PspsPanel.tsx`, map overlay in `MapView.tsx` or a new `PspsLayer.tsx`.

**Acceptance checks:**

1. Tripping a leaf corridor affects exactly its downstream subtree; total customers are conserved (sum of components = region total).
2. Weighted-customer formula reproduces a hand calculation for one corridor.
3. `$` consequence is zero when VOLL is zero; no negative values.
4. Every customer/CFI number carries a `modeled` badge and a source tooltip.
5. The surgical alternative never has a higher weighted impact than the full scope.
6. Heatwave and PSPS can be on together without double-counting load (define precedence: PSPS de-energizes, heatwave changes remaining load).
7. No claim of utility MBL, actual switching orders or real-time customer counts.

**Claims discipline:** "This is a **screening drill** using public census/OSM data, not a utility's PSPS tool. Customer counts are modeled service-area allocations, not billing records. FHSZ is hazard, not risk. We do not issue switching orders."

**Handoff prompt:**

> Build a PSPS screening panel. New `lib/psps.ts`: corridor tier from FHSZ + wind + age; graph removal → affected components; block-group household allocation to nearest load center; weighted customers using Liberty's `30×MBL + 30×CFI + others` (cite); duration default 18 h; `$ = unserved MWh × VOLL`; greedy surgical alternative. UI: red-flag toggle, FHSZ overlay, de-energized subtree, situation-report card, export. Label all customer/CFI/MBL values `modeled`; no utility MBL claim.

---

### 3.3 Cascading failure propagation — N-1, reroute, restore

**The other session's version:** a static node path `Mojave Solar → Cajon Pass 500 kV → Central LA Substation` with a bottleneck star.

**What is wrong:** those assets are not in our model; a tree cannot cascade (it islands); and a pretty path is not a simulation. We can do better with the physics we already have.

**What we can honestly simulate:**

| Layer | Method | Output |
|---|---|---|
| **N-1 de-energization** | Remove each edge; BFS components; identify the component without a modeled source/slack | Unserved load centers, MW, modeled customers |
| **Reroute / overload cascade** | Only if the graph has a loop: redistribute flow to the parallel path; compare loading to `mva × thermal derate`; trip the highest-loading edge; repeat (max 5) | Ordered cascade: T+0 trip → T+1 parallel overload → T+2 protection → subtree lost |
| **Frequency event** | `frequencyEvent()` from `physics/dynamics.ts` with EIA-860 inertia inside the ring; trip largest infeed | ROCOF, nadir, UFLS stages latched, steady-state frequency |
| **Restoration** | Order load centers by criticality; estimate crew travel + switching time (assumption); ETR | Restoration sequence and ETR band |
| **Cost** | Unserved MWh × VOLL + customer interruption | $ consequence, screening |

**Prerequisite data fix:** add one **modeled** OC↔LA tie (Fountain Valley–Westminster 69 kV) and one **modeled** loop tie (West Basin/Harbor 69 kV, `la-06 ↔ la-07`). Tag both `modeled: true` with a note. Without the loop, the feature is "N-1 de-energization", not "cascade" — still useful, but label it correctly.

**Demo trigger (real numbers from §0.2):**

1. Heatwave on: West Basin tie at **120.1 %**, Harbor at **106.8 %**, OC tie at **133.5 %**.
2. Trip the Harbor tie. Flow reroutes to West Basin. West Basin goes from 120 % to >150 % → protection trips.
3. `node-la-06` (E.C. Little) and `node-la-07` (Terminal Island) island. `node-la-05` (Hyperion) remains but loses two downstream loads.
4. Frequency event: largest infeed loss → ROCOF/nadir; does UFLS stage 1 latch?
5. Restoration: Terminal Island (small, low criticality) vs. E.C. Little (recycled water) ordered by consequence; ETR 4–8 h.

**UI:**

- `Grid chain` tab: a `Trip this corridor` button on each corridor row.
- Map: tripped edge red/dashed, islanded subtree dimmed, bottleneck star on the overloaded parallel tie, restoration order numbered.
- Drawer: a **cascade timeline** (`T+0`, `T+1`, `T+2`, `T+restore`) with the event, MW lost, customers, and the protection/crew assumption.
- A `Run N-1 screen` button that runs all 9 edges and ranks the worst by unserved MW/customers.

**New module:** `lib/contingency.ts` (graph + reroute + cascade + restoration), pure and deterministic. Keep `lib/grid.ts` for diagnostics; do not mutate stored properties.

**Acceptance checks:**

1. For every edge, `served + unserved = total` within rounding.
2. Removing a leaf edge never reports a cascade — only a de-energization.
3. The loop scenario produces a deterministic sequence; no oscillation (cap at 5 trips).
4. Frequency event matches `physics/dynamics` unit tests.
5. The N-1 ranking is stable and reproducible; ties broken by id.
6. UI labels every added tie and every crew/travel assumption as `modeled`.

**Claims discipline:** "A screening N-1/cascade drill on a 9-segment model, not an AC contingency analysis, protection coordination study or state estimator. Added ties are modeled."

**Handoff prompt:**

> Build `lib/contingency.ts` and a `Grid chain` "trip corridor" interaction. Use `data/nodes.json` graph; add two `modeled` ties (OC↔LA, la-06↔la-07 loop) with notes. Implement: edge removal → components → unserved; loop reroute → loading vs `mva×0.88` → trip highest → repeat max 5; `frequencyEvent()` for largest-infeed loss; restoration order by criticality; `$ = unserved MWh × VOLL`. UI: map highlight, cascade timeline, N-1 ranking. Label it screening, not AC contingency.

---

### 3.4 Interconnection queue + hosting capacity — "what unblocks the queue?"

**The other session's version:** a queue layer with planned solar/battery projects near the Inland Empire and an "Add Substation Bay" button that clears the queue.

**What is right:** queue congestion is a real, current, visually compelling story, and we already have the hard part — `hostingCapacity()` in `lib/physics/network.ts`.

**What is missing:** a real queue snapshot, a constraint model, upgrade costs, and a budget trade-off. Also, the queue is not a utility's whole queue; it must be a filtered snapshot with a date and source.

**Data:**

| Input | Source | Access / caveat |
|---|---|---|
| Interconnection queue projects | CAISO public queue reports / ISO queue CSV; LBNL "Queued Up" for context | Public downloads; cite snapshot date. Do **not** bulk-scrape `interconnection.fyi` (terms prohibit scraping/redistribution; full data is paid). |
| Project location / county | Queue report + geocode | Some queue records are county-level only; mark `approximate` |
| Nearest substation/bus | OSM substations + `lib/gridAssets.ts` | ODbL attribution |
| Hosting capacity | `hostingCapacity()` per bus | Screening binary search, not a cluster study |
| Upgrade cost | `UNIT` table in `lib/grid.ts` (substation $/MVA, bay, feeder) | Screening estimates; label |
| Queue duration / status | Queue report dates | Public; status changes frequently |

**Model:**

```
For each queued project p at bus b:
  HC_b = hostingCapacity(network_b, b)          // MW, existing limits
  constrained = p.mw > HC_b
  upgrade_mw  = max(0, p.mw − HC_b)
  upgrade_cost = upgrade_mw × $/MVA (UNIT) + fixed bay cost (assumption)
  queue_years = today − p.queue_date
  unblock_ratio = p.mw / (HC_b + upgrade_mw)

Aggregate:
  total_queued_mw, constrained_mw, $ to clear, $/MW, median queue age
  constrained_by_type (solar / wind / storage / hybrid)

Budget scenario:
  user sets $ budget → greedy knapsack by MW cleared per $ (or by
  risk/MW) → list of projects that fit; animation of queue shrinking.
```

**UI:**

- New map layer `Interconnection queue` in `LayerPicker`: sized dots by MW, color by constrained/unconstrained, cluster by county.
- A queue panel/tab: total MW, constrained MW, $ to clear, median years, top 10 constrained projects, "what unblocks it" detail.
- A budget slider; the queue table filters to projects that fit; "cleared MW" counter.
- Clicking a project highlights the nearest substation and the limiting constraint (voltage / thermal / reverse flow) from `hostingCapacity` diagnostics.

**New modules:** `data/queue.json` (snapshot + citation + `approximate` flags), `lib/queue.ts`, `components/queue/QueuePanel.tsx`, `QueueLayer.tsx`.

**Acceptance checks:**

1. Queue totals reconcile to the snapshot (count and MW).
2. Each project's `constrained` flag is recomputed from `hostingCapacity`, not hard-coded.
3. Budget allocation is deterministic and never exceeds the budget.
4. Every project carries source, snapshot date and location precision.
5. The feature works with zero network calls after the snapshot is committed.
6. No claim that an upgrade is approved, funded or will actually clear the queue.

**Claims discipline:** "A snapshot of public queue data + a screening hosting-capacity calculation. Real interconnection requires a cluster study, network upgrades and utility approval. Costs are planning estimates."

**Handoff prompt:**

> Add an interconnection queue layer and panel. Commit `data/queue.json` from a public CAISO/ISO snapshot with source + date + precision. New `lib/queue.ts`: nearest bus, `hostingCapacity()`, constrained flag, upgrade MW/cost from `UNIT`, queue age, greedy budget allocation. UI: layer, table, budget slider, constraint detail. Do not scrape interconnection.fyi; cite the snapshot. Label as screening, not a cluster study.

---

**Continue to Part 2:** [`docs/FEATURE-BACKLOG.md`](./FEATURE-BACKLOG.md) — the competitors the brainstorm missed, the 32-item capability gap map, the ranked backlog, performance optimizations, the upgraded demo script, claims discipline, sources and formulas.
