# GridSentinel competitive teardown — Part 2

**The competitors the brainstorm missed, the full gap map, the ranked backlog, and the optimizations.**

Status: research / brainstorm, 2026-11-14. No application code changed.
Part 1: [`docs/COMPETITIVE-TEARDOWN.md`](./COMPETITIVE-TEARDOWN.md).

---

## 4. TL;DR — the ten things we are actually missing

Ranked by how much they change the demo, not by how hard they are.

| # | Missing thing | Who already does it | Cheapest honest version for us | Effort |
|---|---|---|---|---|
| 1 | **Consequence** — people, critical services, dollars, duration | Palantir PSIP; SDG&E/Liberty PSPS models; FEMA NRI | Criticality index from ACS + OSM; `$ = unserved MWh × VOLL`; PSPS impact card | M |
| 2 | **Closed loop** — assign, execute, verify, close | Maximo, ArcFM, GE Visual Intelligence, Palantir cases | Case/work-order state machine with owner, status, evidence link, close-out | S/M |
| 3 | **N-1 / restoration / cascade** | GridOS AEMS, Spectrum Power FISR, Schneider Grid Operation | `lib/contingency.ts` on our graph + physics; cascade timeline; ETR | M |
| 4 | **Queue + hosting capacity** | Siemens LV/DER, Schneider DERMS, Kevala, GridUnity | Public queue snapshot + existing `hostingCapacity()` + budget slider | M |
| 5 | **Portfolio optimization** — "here is $50 M, what do we fund?" | PLEXOS, GenX, Palantir Workshop | Greedy/knapsack over existing pathways by risk removed per $ | S |
| 6 | **Economics realism** — demand charges, ITC, incentives, marginal CI | DSIRE, NREL SAM/ATB, WattTime/Cambium | Wire `physics/economics` NPV/IRR/LCOE; add demand-charge and ITC lines | S/M |
| 7 | **Live/forecast strip** — "the grid right now" | GridStatus, Electricity Maps, CAISO Today's Outlook | One free API strip with timestamp + "indicative" label | S |
| 8 | **Situation report / export / share** | Palantir, PI Vision, Esri Experience Builder | Printable one-pager + CSV + URL-encoded scenario | S |
| 9 | **Data coverage / freshness / uncertainty** | Siemens NMM, Collibra/Alation, Monte Carlo | Coverage badge, snapshot age, P50/P90 band, "assumed" labels | S/M |
| 10 | **Performance / productization** | Every enterprise platform | Vector tiles, precompute, worker, error boundaries, API | M |

---

## 5. Competitors the brainstorm missed

The other session named four enterprise suites. The market is wider, and several categories are closer to what we actually built than Siemens or Palantir are. The table is deliberately broad; the deep cuts after it explain which ones matter.

### 5.1 The full map (grouped by job, not by vendor size)

| Product / project | Category | The screen or workflow it sells | The one thing to steal | Free analog |
|---|---|---|---|---|
| **Siemens Spectrum Power ADMS / Gridscale X** | Enterprise ADMS + model mgmt | SCADA, OMS, FISR, VVC, LV twin, DER/flexibility | Model versioning; switching sequence; coverage | — |
| **GE GridOS / Smallworld / AEMS / DERMS** | Enterprise ADMS/EMS/GIS | FLISR, contingency, state estimation, DER programs, visual risk | N-1; residual health; work order from imagery | — |
| **Schneider EcoStruxure ADMS / Grid Operation / ArcFM** | Enterprise ADMS/GIS | OMS, switching, ETR, storm/crew, design packages, hosting capacity | ETR; design package; storm board | — |
| **AVEVA CONNECT / PI / PI Vision** | Industrial data + visualization | Time-series, asset hierarchy, trends, alarms | Asset hierarchy; trend cards; context | — |
| **Palantir Foundry (PG&E PSIP, SCE)** | Integration/analytics/workflow | Situation report, PSPS scope, trace, risk cubes, cases | Situation report; scope-as-it-changes; trace | — |
| **Survalent ADMS** | Utility SCADA/ADMS | Distribution SCADA, OMS, FLISR | Operator alarm/event stream | — |
| **OSI monarch (AspenTech)** | EMS/ADMS | Transmission/distribution control, SCADA, contingency | Contingency ranking | — |
| **Hexagon G/Technology** | Utility GIS/ADMS | Network model, outage, mobile | As-built vs. as-operated model | — |
| **Esri ArcGIS Utility Network** | Geospatial platform | Connectivity model, tracing, versioning, field apps | Trace + versioned network + shareable web app | ArcGIS free tier |
| **Bentley OpenUtilities** | Utility GIS/design | Network design, analysis, work management | Design-to-construction package | — |
| **IQGeo** | Network management | Fiber/power network records, field workflows | Field-first asset records | — |
| **Trimble Unity** | Field/asset management | Work orders, inspections, GIS | Inspection lifecycle | — |
| **IBM Maximo Health** | Asset performance/EAM | Health %, RUL, work orders, criticality, risk | `risk = ((100−health)/100) × criticality` | — |
| **GE SmartSignal** | APM | Residuals, prioritized alerts, time-to-action | Expected-vs-actual residual; time-to-limit | — |
| **C3 AI Reliability** | APM | Anomaly risk, failure mode, evidence package, work order | "Evidence package" per alert | — |
| **Siemens Senseye** | APM | Condition monitoring, predictive maintenance | Remaining-useful-life framing | — |
| **Augury** | Machine health | Vibration/ultrasound diagnostics | Fault-mode-specific recommendations | — |
| **Uptake** | Industrial AI | Asset health, work prioritization | "Fix this first" queue | — |
| **Emerson AMS** | Asset management | Valve/equipment diagnostics | Instrument-level health | — |
| **Bentley AssetWise** | Asset lifecycle | Inspection, risk, reliability | Linear-asset inspection records | — |
| **Technosylva FireSight / FireRisk** | Wildfire risk | POF × POI × consequence; RAIL; percentiles; PSPS | Three-factor risk; percentile display | CalFire FHSZ (hazard only) |
| **Neara** | 3D network digital twin | Pole/span loading, clearance, ignition risk, risk removed per $ | Risk-removed-per-dollar ranking | — |
| **AiDash CRIS / IVMS** | Vegetation/wildfire | Daily risk maps, 72 h–7 day forecast, surgical PSPS | "Surgical" de-energization; forecast horizon | — |
| **LiveEO Treeline** | Satellite vegetation | Span/feeder/system risk; work orders | Risk tier by span; API to work mgmt | Sentinel-2 (free, coarse) |
| **Overstory** | Satellite vegetation | 3D risk score, hazard trees, outage/ignition likelihood | Horizontal + vertical proximity scoring | — |
| **Gridware Gridscope** | Line sensors | Fault type/location, ignition risk, de-energized line monitoring | "Dead line" state; span-level fault | — |
| **LineVision LineRate / LineHealth** | DLR + conductor health | Real-time rating, forecast, annealing, remaining strength | DLR vs. static; remaining life | Our `line_rating` CSV + IEEE 738 |
| **Pano AI** | Fire detection | Camera + satellite + human-verified alerts | Verified incident feed (skip if no cameras) | — |
| **GridStatus** | Market/grid data | ISO load, fuel mix, prices, queues | Live strip; queue library | Open-source `gridstatus` (BSD) |
| **Electricity Maps** | Carbon intensity | Live/historical CI + generation mix | Live CI; cleanest-hour recommendation | Free tier (key, 24 h history) |
| **WattTime** | Marginal emissions | Marginal CI, forecasts, historical | Marginal vs. average distinction | Free basic (CAISO_NORTH) |
| **CAISO OASIS / Today's Outlook** | ISO operations | Demand, supply, prices, outages, emissions | "Indicative" live demand/supply | Public |
| **EIA API v2** | Official energy data | Generation, demand, prices, plants | Regional context; plant registry | Free key |
| **Yes Energy** | Market analytics | Nodal prices, congestion, forecasts | LMP/congestion framing | — |
| **ABB Velocity Suite** | Market data | Price/load forecasts, asset valuation | Scenario valuation | — |
| **Enverus** | Energy analytics | Asset/portfolio intelligence | Portfolio view | — |
| **PLEXOS** | Production-cost/capacity expansion | Dispatch, prices, buildout optimization | Optimization instead of simulation | — |
| **EnCompass** | Production cost | Unit commitment, markets | Scenario comparison | — |
| **PROMOD** | Production cost | Market simulation | Congestion/price scenarios | — |
| **GridView** | Production cost | Market/asset analysis | Scenario library | — |
| **Aurora Energy Research** | Subscription analytics | Price/capacity outlooks | Long-run scenario framing | — |
| **NREL ReEDS** | Capacity expansion | U.S. buildout scenarios | Public scenario data | Free |
| **GenX** | Capacity expansion | Least-cost buildout | Optimization formulation | Open source |
| **PyPSA** | Power system optimization | Dispatch, storage, network constraints | Open optimization engine | Open source |
| **Sienna** | Power system simulation | Production cost, dynamics | Julia-based simulation patterns | Open source |
| **PowerModels.jl** | Optimization | AC/DC OPF | OPF formulation | Open source |
| **pandapower** | Power system analysis | Power flow, short circuit, state estimation | Short-circuit/state-estimation test cases | Open source |
| **OpenDSS** | Distribution simulation | Feeder planning, DER, hosting capacity | Hosting-capacity workflow | Free (EPRI) |
| **GridLAB-D** | Distribution co-simulation | End-use loads, DER, markets | Agent-based load behavior | Open source |
| **Kevala** | Distribution planning | Hosting capacity, DER adoption, grid needs | HC heatmap + adoption forecast | — |
| **GridUnity** | Interconnection workflow | Queue management, studies, approvals | Queue state machine | — |
| **Pearl Street** | Interconnection | Queue analytics, site selection | Queue congestion ranking | — |
| **Camus Energy** | DERMS/ops | Flexibility, dispatch, settlements | Flexibility market view | — |
| **Utilidata** | Grid edge | Distributed intelligence, voltage optimization | Edge measurement framing | — |
| **Xylem Vue (GoAigua)** | Water utility digital twin | Water + energy optimization, leaks, pumping | Water-energy KPI; pump scheduling | — |
| **Autodesk Innovyze** | Water modeling | Hydraulics, asset planning | Network model + scenario | — |
| **Bentley OpenFlows** | Water modeling | Hydraulics, water quality | Pump/energy simulation | — |
| **EPA EPANET** | Water hydraulics | Network hydraulics/quality | Outage → pressure/service impact | Public domain / MIT |
| **TaKaDu** | Water analytics | Anomaly detection, non-revenue water | Event detection from telemetry | — |
| **Emagin** | Water/energy AI | Pump scheduling, energy optimization | Energy-per-MG optimization | — |
| **Fracta** | Water pipe risk | Pipe condition/failure risk | Asset risk from condition | — |
| **Aquatic Informatics** | Water data management | Time-series, compliance reporting | Data validation workflow | — |
| **ENERGY STAR Portfolio Manager** | Benchmarking | 1–100 score, peer comparison | Percentile + comparability caveat | Free (approval) |
| **EnergyCAP** | Energy management | Bills, M&V, benchmarking | Measurement & verification | — |
| **Arcadia / UtilityAPI** | Utility data access | Meter/bill data aggregation | Interval data ingestion | Paid |
| **DSIRE** | Incentives | Rebates, tax credits, policies | ITC/adder/incentive lines | Public site; API paid |
| **NREL SAM / PVWatts / ATB** | Solar/finance/cost | Production, project finance, tech costs | PVWatts CF; SAM cashflow; ATB costs | Free |
| **OpenEEmeter / CalTRACK** | M&V | Normalized savings | Verify savings after upgrade | Open source |
| **First Street** | Climate risk | Flood/wildfire/wind/heat scores | Hazard score per asset | Contract |
| **Jupiter Intelligence** | Climate risk | Asset-level physical risk | Scenario/return-period framing | Paid |
| **Climate X** | Climate risk | Asset damage/risk | Damage curves | Paid |
| **XDI** | Cross-dependency risk | Infrastructure interdependency | Water-energy dependency graph | Paid |
| **Munich Re Location Risk** | Insurance risk | Natural hazard scores | Insurance-grade framing | Paid |
| **FEMA NRI** | Public risk | EAL × community risk factor; percentiles | EAL + equity | Free |
| **CalFire FHSZ** | Public hazard | Moderate/High/Very High zones | Wildfire tier | Free |
| **CEJST / CalEnviroScreen** | Public equity | Disadvantaged community flags | DAC overlay | Free |
| **Collibra / Alation** | Data catalog/lineage | Ownership, lineage, quality | Coverage + freshness badges | — |
| **Monte Carlo** | Data observability | Freshness/volume/schema alerts | "Stale layer" banner | — |
| **ServiceNow FSM / Salesforce Field Service** | Field service | Dispatch, schedule, close-out | Work-order lifecycle | — |
| **Mapbox / Felt / Kepler.gl / deck.gl** | Visualization | Web maps, collaboration, large layers | Vector tiles; share links; WebGL | MapLibre/PMTiles/Protomaps |

### 5.2 Deep cuts — the twelve that actually change our product

**1. IBM Maximo Health — the cleanest published risk formula.** `risk = ((100 − health)/100) × criticality`, health built from remaining-useful-life score, open work orders and open service requests; criticality is an asset priority normalized 1–5. This is exactly the two-axis idea we need, and it is citable. It also gives us a natural place for **work-order count as a health input**, which turns our memo into a case.

**2. Technosylva — three-factor wildfire risk with percentiles.** Expected risk = POF × consequence; RAIL = POF × POI × consequence; over 200 metrics collapsed to a 0–1 composite; explicitly a screening tool, not a mitigation justification. Percentiles matter: a raw score of 0.42 means nothing; "97th percentile in the territory" means something. Our risk UI should show percentile, not just a bucket.

**3. FEMA NRI — dollarized consequence and equity.** Risk = expected annual loss × community risk factor, where the factor reflects social vulnerability and community resilience; scores are national percentiles. This is the best public template for "risk to people, not just assets", and it gives us a defensible way to weight disadvantaged communities without inventing a social model.

**4. SDG&E and Liberty PSPS consequence weights.** SDG&E publishes multipliers: critical facilities/infrastructure 20 safety / 10 financial / 30 reliability; medical baseline 5 / 1 / 1; other customers 1. Liberty publishes `PSPS Safety Multiplier = (30 × MBL + 30 × CFI + other customers) / customer count`. These are the only public, reproducible PSPS weighting schemes we found. Use one, cite it, show the formula.

**5. Palantir PSIP — the situation report and scope-as-it-changes.** PSIP sits on 50+ source systems and does not replace them; it produces an Internal Situation Report from planning through restoration, a DAHS dashboard, a PSPS Viewer using EDGIS tracing, and notification campaigns that follow the current operating configuration. The lesson is not "build Foundry"; it is **one page that stays correct as the scope changes**, with a trace behind every count.

**6. Siemens Network Model Manager — model versioning and a read API.** A consistent network-model repository with versioned REST/OpenAPI and collaborative project workflows. We already have content-addressed evidence; we are one step away from "model v2026-11-14, diff vs. v2026-10-01". That single badge would make our numbers feel maintained rather than hard-coded.

**7. GE FLISR + Visual Intelligence — the restoration sequence and the work order.** FLISR is pinpoint → isolate → restore healthy blocks; Visual Intelligence attaches an image to a work order and assigns a crew. We can implement the **sequence** on our graph and the **work order** as a local state machine. We cannot implement the imagery or the crew dispatch, and we should not pretend to.

**8. Schneider Grid Operation — ETR, storm board, design package.** Estimated restoration time from outage scope + crew/travel assumptions; storm/crew management; damage assessment; FLISR as an add-on. The design package (scope, BOM, cost, permits, approval state) is the natural evolution of our "Upgrade plan" tab: from slider to **shovel-ready package**.

**9. AVEVA PI — the asset hierarchy and trends.** PI AF gives every number a context path; PI Vision gives trends, gauges and alarms. Our drawer is flat. An `Region → Corridor → Load center → Phase → Asset` tree, plus a 24 h / 8760 trend card, would make the app feel like an operational system rather than a report.

**10. LineVision — DLR and conductor health.** Real-time rating vs. static rating, 240 h forecast, annealing damage, remaining tensile strength, projected end of life. We already have IEEE 738 screening and a line-rating CSV; surfacing "static 100 MVA vs. dynamic 128 MVA vs. annealed remaining life" is a strong engineering-credibility feature.

**11. Neara — risk removed per dollar and 3D clearance.** Pole/span loading, sag/sway, blow-in/fall-in/grow-in, clearance violations, inspection sequencing, SAIDI/SAIFI and risk-removed-per-dollar rankings. We cannot do 3D LiDAR. We can do **risk removed per dollar** on our pathways, which is the number a capital planner actually uses.

**12. Xylem Vue / EPANET — the water-energy nexus.** Pump energy is `ρgQH/η`; EPANET simulates the water network; Xylem Vue optimizes pumping against energy price and demand. Our load centers are water plants. A "kWh per million gallons" card and an outage → water-service impact would differentiate us from every generic grid dashboard in the room.

### 5.3 Free / open analogs worth using (and their catch)

| Need | Free option | Catch |
|---|---|---|
| Live carbon intensity | Electricity Maps free tier | API key; 24 h history only; 150 req/min default |
| Marginal emissions | WattTime basic | Free for noncommercial; full regions paid; CAISO_NORTH free |
| ISO load/fuel mix/prices | GridStatus open-source library | Hosted API free tier 250 req/month; source terms differ |
| Plant/queue/market context | EIA API v2 | Free key; ~9,000 req/h guideline |
| Grid topology | OpenStreetMap / Overpass | ODbL attribution + share-alike on adapted DB |
| Transmission/substations | HIFLD archives | HIFLD Open shut down Aug 2025; use archived snapshots; accuracy caveat |
| Wildfire hazard | CalFire FHSZ | Hazard, not risk; 30–50 yr horizon |
| Equity | CEJST / CalEnviroScreen | Tract-level; different vintages |
| Climate loss | FEMA NRI | County/tract; national percentiles |
| Solar production | NREL PVWatts | Free key; 1,000 req/h/key |
| Project finance | NREL SAM | Desktop/registration; check license |
| Tech costs | NREL ATB | Download; check exact release license |
| Incentives | DSIRE public site | API is paid; cite the public page |
| Water hydraulics | EPA EPANET | Public domain / MIT; not electric |
| Distribution simulation | OpenDSS / GridLAB-D | License varies; separate runtime |
| Optimization | PyPSA / GenX / PowerModels | Python/Julia; not deployable in our Next.js app without a service |
| Benchmarking | ENERGY STAR Portfolio Manager | Free but EPA approval + property sharing |
| Outages | ORNL ODIN | County-level public; historical needs registration |
| Queue | CAISO public reports | Snapshot, not API; interconnection.fyi bulk is paid and no-scrape |

---

## 6. The 32-item capability gap map

“Us today” is what the repo actually does, not what the pitch implies.

| # | Capability | Enterprise reference | Us today | Cheapest honest version | Effort |
|---|---|---|---|---|---|
| 1 | Consequence / criticality | Maximo, FEMA NRI, PSPS models | None | `C` 1–5 from ACS + OSM + MW; default 3 labeled | S/M |
| 2 | Customer impact | Palantir PSIP, SDG&E/Liberty | Homes-equivalent only (energy) | Block-group households allocated to nearest load center | M |
| 3 | Critical facilities | Palantir DAHS, CPUC CFI | None | OSM hospitals/schools/fire/water within buffer | S |
| 4 | Equity / DAC | CEJST, CalEnviroScreen | None | Tract overlay + share of affected population | S |
| 5 | PSPS scope | Palantir, AiDash, Technosylva | None | Corridor removal → affected subtree → weighted customers | M |
| 6 | N-1 contingency | GridOS AEMS, Spectrum Power | Physics exists, UI does not | `lib/contingency.ts` + trip button + ranking | M |
| 7 | Cascade / overload propagation | AEMS, digital twins | None | Loop tie + loading-based trip sequence, max 5 | M |
| 8 | Restoration / FLISR | GridOS ADMS, Schneider | None | Pinpoint → isolate → restore sequence + ETR | M |
| 9 | Switching proposal validation | Spectrum Power, Grid Operation | None | Pre-check: de-energized scope, overloads, critical loads | M |
| 10 | Frequency / UFLS | AEMS, dynamics | Physics tests, no UI | "Trip largest infeed" button + ROCOF/nadir/UFLS | S |
| 11 | Hosting capacity | DERMS, Kevala, OpenDSS | `hostingCapacity()` exists, not surfaced | Bus HC card + heatmap | S/M |
| 12 | Interconnection queue | GridUnity, Pearl Street | None | Public snapshot + constraint + budget clearing | M |
| 13 | DER / VPP dispatch | GridOS DERMS, Camus | Pathways only | Dispatch scenario + settlement estimate | M |
| 14 | Demand response / flexibility | Siemens Flexibility Manager | Pathway line | Flexibility-vs-capex comparison | S |
| 15 | Work orders | Maximo, ArcFM, ServiceNow | Memo email only | Local case: owner, status, due, evidence, close | S |
| 16 | Inspections / vegetation | GE Visual Intelligence, LiveEO | Niche cases only | Inspection queue from FHSZ + corridor age | M |
| 17 | Asset registry / hierarchy | PI AF, Smallworld | Flat `nodes.json` | Tree view + asset fields + parent/child | S/M |
| 18 | Trends / time series | PI Vision, GridStatus | Sparkline only | 24 h + 8760 profile from physics load model | S |
| 19 | Forecasting | AEMS, DERMS, AiDash | Heatwave scenario only | 24 h peak/CI forecast from synthetic weather | M |
| 20 | Live grid strip | GridStatus, Electricity Maps | None | One free API strip, timestamp, indicative label | S |
| 21 | Marginal emissions | WattTime, Cambium | Average CI only | Toggle average/marginal; explain decision use | S |
| 22 | Tariffs / demand charges | EnergyCAP, utility bills | Energy-only payback | Demand charge + TOU line; show delta | S |
| 23 | Incentives / ITC | DSIRE, SAM | None | ITC/adder input + net capex + NPV/IRR | S |
| 24 | Uncertainty | PLEXOS, Monte Carlo | Deterministic point values | P50/P90 on CI, load, capex; tornado chart | M |
| 25 | Portfolio optimization | PLEXOS, GenX | Per-asset sliders | Greedy knapsack by risk removed per $ under budget | S |
| 26 | Scenario compare | Palantir Workshop, PLEXOS | One scenario at a time | A/B compare with deltas | S/M |
| 27 | Reliability metrics | ADMS, IEEE 1366 | None | SAIDI/SAIFI/CEMI screening from fault rates | M |
| 28 | Resilience / VOLL | Economics, NRI | VOLL constant unused | Unserved MWh × VOLL; customer interruption $ | S |
| 29 | Model versioning | Siemens NMM | Content hashes, no badge | "Model as of" + diff vs. prior snapshot | S |
| 30 | Data coverage / freshness | Collibra, Monte Carlo | Evidence verifier | Coverage % + stale layer banner | S |
| 31 | Export / share / API | PI Vision, Esri, Palantir | Email only | Print one-pager + CSV + URL state + OpenAPI | S/M |
| 32 | Performance at scale | All | 2.7 MB GeoJSON, all physics in render | Vector tiles, precompute, worker, lazy tabs | M |

---

## 7. Ranked backlog

Scoring: **Demo** 1–5 (how much it changes a judge's perception), **Effort** S (< 1 session), M (1–2 sessions), L (> 2), **Data risk** L/M/H (H = needs a new licensed/derived dataset). Ranked by demo value per unit effort, then by dependency order.

| Rank | Feature | Ripped from | Demo | Effort | Data risk | Code touchpoints |
|---:|---|---|---:|---|---|---|
| 1 | Risk Index v2 (L × C, waterfall, percentile, $/risk) | Maximo, Technosylva, FEMA NRI | 5 | S | L | `lib/risk.ts`, `lib/criticality.ts`, `TelemetryTab`, `FacilityRail` |
| 2 | Situation report + export | Palantir PSIP, PI Vision | 5 | S | L | new `lib/report.ts`, `components/report/*` |
| 3 | N-1 trip + cascade timeline | GridOS AEMS, Spectrum Power FISR | 5 | M | L | new `lib/contingency.ts`, `GridChainTab`, `MapView` |
| 4 | Portfolio optimizer under budget | PLEXOS, GenX, Neara | 5 | S | L | new `lib/portfolio.ts`, `UpgradeSimulatorTab` |
| 5 | PSPS impact + surgical alternative | Palantir, SDG&E/Liberty, AiDash | 5 | M | M | new `lib/psps.ts`, `lib/serviceArea.ts`, `PspsPanel` |
| 6 | Queue + hosting capacity | GridUnity, Kevala, DERMS | 4 | M | M | `data/queue.json`, `lib/queue.ts`, `QueuePanel` |
| 7 | Water-energy kWh/MG card | Xylem Vue, EPANET | 4 | S | L | `lib/water.ts`, `TelemetryTab` |
| 8 | Live strip + marginal CI | GridStatus, Electricity Maps, WattTime | 4 | S | M | `app/api/live/*`, `ControlBar` |
| 9 | Demand charges + ITC + NPV/IRR | DSIRE, SAM, EnergyCAP | 4 | S | L | `physics/economics` wiring, `UpgradeSimulatorTab` |
| 10 | Work-order/case lifecycle | Maximo, ArcFM, ServiceNow | 4 | S | L | new `lib/case.ts`, `ActionTab` |
| 11 | Transformer/conductor health cards | SmartSignal, LineVision | 4 | S | L | `physics/thermal`, `GridChainTab` |
| 12 | Frequency event button | AEMS, dynamics | 4 | S | L | `physics/dynamics`, `GridChainTab` |
| 13 | Asset hierarchy + trends | PI AF, PI Vision | 3 | S | L | `AnalyzerDrawer`, `lib/trends.ts` |
| 14 | Scenario A/B compare | Palantir Workshop | 3 | S | L | `Workspace`, URL state |
| 15 | Data coverage / freshness badge | Collibra, Siemens NMM | 3 | S | L | `EvidenceTab`, `ControlBar` |
| 16 | Model version + diff | Siemens NMM | 3 | S | L | `lib/evidence`, `MethodTab` |
| 17 | Critical facilities + DAC overlay | Palantir, CEJST | 3 | S | M | map layer, `lib/community.ts` |
| 18 | Inspection/vegetation queue | Visual Intelligence, LiveEO | 3 | M | H | `lib/inspection.ts`, layer |
| 19 | Reliability metrics (SAIDI/SAIFI) | ADMS, IEEE 1366 | 3 | M | M | `physics/municipality` wiring |
| 20 | P50/P90 uncertainty bands | PLEXOS, Monte Carlo | 3 | M | L | `lib/uncertainty.ts`, charts |
| 21 | DER/VPP dispatch scenario | GridOS DERMS, Camus | 3 | M | M | `gridChain`, new panel |
| 22 | Forecast strip (24 h) | AEMS, AiDash | 3 | M | M | `physics/load`, `lib/forecast.ts` |
| 23 | Share link / CSV / OpenAPI | Esri, PI Vision | 3 | S | L | `app/api`, URL state |
| 24 | Map performance (tiles/clustering) | Mapbox/deck.gl | 3 | M | L | `MapView`, `public/layers` |
| 25 | Mobile field mode (PWA) | ArcFM Mobile, Trimble | 2 | M | L | shell, CSS |
| 26 | Collaboration/annotations | Palantir Workshop, Felt | 2 | M | M | new store |
| 27 | Multi-region benchmark | ENERGY STAR | 2 | M | M | `data/regions`, `lib/benchmark` |
| 28 | Regulatory report templates | CPUC PSPS tables, FERC 881 | 2 | L | H | new `lib/regulatory` |

### 7.1 The seven to build for this demo

If we only get one more work session, do these in this order:

1. **Risk v2 + waterfall + percentile** (S). It upgrades the number every other screen depends on, and it answers "why?" on the spot.
2. **N-1 trip + cascade timeline** (M). The physics is already there; this is the single most "engineering analyzer" moment available.
3. **PSPS impact + surgical alternative** (M). This is the "who gets hurt" story no other hackathon team will have.
4. **Portfolio optimizer under budget** (S). Replaces "drag a slider on one asset" with "here is $50 M, fund the best set."
5. **Situation report export** (S). A tangible PDF/print artifact with sources; judges can hold it.
6. **Queue + hosting capacity** (M). Forward-looking, visually clean, and uses `hostingCapacity()` that already works.
7. **Water-energy kWh/MG card** (S). The differentiator: our assets are water plants, not generic loads.

### 7.2 Do not build (for this demo)

| Don't build | Why |
|---|---|
| SCADA control / switching | We have no telemetry and no authority; a fake control is a credibility bomb |
| Real-time state estimation / WAMS | Requires PMU/SCADA data; "pseudo-state" is the honest ceiling |
| Automated FLISR | Protection coordination is a study, not a button |
| Full AC contingency | Our solver is radial; a meshed AC study needs a different engine |
| 3D LiDAR / vegetation ML | No point clouds, no imagery; FHSZ + OSM proximity is the honest proxy |
| Customer notification sending | Legal/consent/utility authority; a preview list is enough |
| Market bidding / settlements | No market participant status; a price exposure line is enough |
| Multi-tenant auth / billing | Out of scope; the demo is single-region |
| Blockchain / crypto tokens | No problem here needs one |
| A general chat agent over the app | The memo is already the LLM surface; a chat adds risk without a demo beat |

---

## 8. Optimizations worth taking (performance, architecture, cost)

No speedup is claimed here. These are changes to make and then **measure** in DevTools/Next build output before/after.

### 8.1 Map and data loading

| Current pain | Measured/known | Change | What to measure |
|---|---|---|---|
| `transmission.geojson` is **2.7 MB**, plants 451 KB, substations 289 KB, loaded on mount | File sizes from `du` | Simplify geometry (Douglas–Peucker), split by viewport/bbox, serve as **PMTiles/vector tiles**, `preferCanvas` | First interactive map time; transferred bytes; FPS while panning |
| All layers load even if hidden | `Workspace` `Promise.all` on mount | Lazy-load per `LayerPicker` toggle; `requestIdleCallback`; cache in IndexedDB | Time to first marker; memory |
| DOM markers for every asset | Leaflet `divIcon` | Cluster at low zoom; canvas renderer; viewport culling | Marker count; pan FPS |
| CARTO raster tiles need network | README risk: venue wifi | Self-host PMTiles or bundle a low-zoom offline basemap | Offline demo works |
| 3D toggle loads extra work | `view3d` state | Dynamic import; only on toggle | Initial bundle |

### 8.2 Compute

| Current pain | Change | Measure |
|---|---|---|
| `gridChain()` runs for all 11 nodes on every plan/heatwave change; `phaseExposure` loops them | Precompute per node at build; memoize by `(node, heatwave, plan)`; move to a Web Worker | Interaction latency on slider drag |
| Slider recomputes simulation + charts synchronously | `useDeferredValue`, debounce 50–100 ms, compute payback chart only when visible | Dropped frames; input latency |
| Area scan runs on click over 2.7 MB arrays | Spatial index (grid/bbox already partly there); worker; server route for large scans | Scan latency |
| Evidence verify is O(claims) on load | Verify at build; ship a signed summary; verify on demand in the Evidence tab | Page TTFB |

### 8.3 Bundle and rendering

| Change | Why |
|---|---|
| `dynamic(() => import(...))` for Recharts tabs, 3D, queue, PSPS panels | Keep initial route small |
| `optimizePackageImports` for `recharts`/`leaflet` where supported | Tree-shaking |
| Virtualize `FacilityRail` and any long queue table | DOM count |
| Error boundaries around map/tabs/panels with a retry | No blank screen on layer failure |
| `React.memo` on marker/rail rows; stable callbacks | Re-render churn |
| Lazy `EvidenceTab` (400 KB bundle) | Initial payload |

### 8.4 Caching, API and cost

| Change | Why |
|---|---|
| Cache `RegionPayload` and evidence with `revalidate`/ETag | Static data should not be re-read per request |
| Keep `/api/simulate` local-first; never round-trip on drag | README already says this; enforce it |
| Rate-limit and validate `/api/*` | Public deploy safety |
| Use only free tiers; snapshot paid data | Cost control |
| Precompute queue/PSPS/criticality JSON at build | Deterministic, offline, fast |
| Add timing marks (`performance.mark`) around scan/gridChain | Make optimization measurable |

### 8.5 Reliability, accessibility, security

- **Reliability:** error boundaries; fallback skeletons; timeouts on external calls; never let a missing key break a button (already a project property).
- **Accessibility:** risk is already color + text; add keyboard map controls, `aria-live` for scan results, `prefers-reduced-motion` for `.flow-line`, print styles for the situation report.
- **Security:** no secrets in client bundles; validate email/inputs; sanitize memo HTML; CSP for tiles; no `dangerouslySetInnerHTML` on model output.
- **Observability (optional):** Sentry/PostHog free tiers only if the team wants them; otherwise server logs with request ids.

---

## 9. Demo narrative v2 (3:00)

The original README script is good. This version adds the consequence, operations and money beats, and removes invented assets. **Every figure is computed live from the model; the numbers below are beats, not lines to memorize.**

| Time | Beat | What is on screen |
|---|---|---|
| 0:00–0:15 | Scope | 100-mile ring, 11 real water/desal load centers, 206 MW nameplate, 147 MW live, 427 kt CO₂/yr |
| 0:15–0:40 | Risk that explains itself | Click Hyperion: `L 72 · C 4 · R 96`, waterfall (fossil, CI, motor, age, overload), "highest L of 11" |
| 0:40–1:05 | Heatwave | 147 → 283 MW, 3 assets overload, 1.02 Mt CO₂, **3 corridors over 100 %** (133.5 / 120.1 / 106.8) |
| 1:05–1:35 | PSPS / who gets hurt | Red-flag toggle, FHSZ corridor, de-energize West Basin: affected load centers, modeled customers, CFI count, 18 h, $ consequence; "surgical alternative saves X weighted customers" |
| 1:35–2:00 | N-1 cascade | Trip Harbor tie → West Basin overloads → protection trips → E.C. Little + Terminal Island island; cascade timeline; UFLS check; ETR |
| 2:00–2:30 | Money | $50 M budget → optimizer funds the best set, risk removed per $, demand charges + ITC change the payback (computed live) |
| 2:30–2:50 | Queue | Queue snapshot totals, constrained MW, $/MW to clear, budget slider clears the funded set; add-bay scenario |
| 2:50–3:00 | Hand-off | One-page situation report prints with sources; "same engine, any region" |

**If a number is challenged:** open the Evidence tab, show the claim method and snapshot hash. That is the moment the project wins.

### 9.1 Judge Q&A prep

| Question | Answer |
|---|---|
| "Is this real data?" | Split it: observed (sites, coordinates, EIA/OSM layers), derived (formulas), modeled (nameplate ratings, added ties, customer allocation). Every number carries one of four methods in the Evidence tab. |
| "Where do customer counts come from?" | ACS block-group households allocated to the nearest load center by a modeled service area; not utility billing or MBL records. |
| "Is this an ADMS?" | No. It is a system of insight: screening, prioritization and a situation report over systems of record. It would integrate with an ADMS, not replace it. |
| "How is the risk score weighted?" | Show the formula and the decomposition; say the weights are our assumptions and are adjustable; show the percentile and the confidence badge. |
| "Why not just use Palantir/Siemens?" | Cost, integration time, and the 80/20 screen. We do the first-day question — "what is here, what is at risk, what do we fix first?" — with provenance, in one deploy, with no keys. |
| "Does it scale?" | Static JSON now; the data contracts and pure functions port to PostGIS/D1, a queue, and vector tiles. The evidence schema is already content-addressed. |
| "What is the moat?" | Provenance + physics + local specificity + zero-key demo. Most competitors have one of those; we have all four. |
| "What did you cut?" | SCADA, state estimation, vegetation ML, customer notifications, market bidding — because we cannot source them honestly. The method tab lists the cuts. |

---

## 10. Claims discipline

| Say | Don't say |
|---|---|
| "Screening estimate" | "Utility-grade study" |
| "Modeled electrical rating derived from published scale" | "Operator-reported nameplate" |
| "Public census/OSM allocation" | "12,400 customers" (unless sourced) |
| "Fire hazard zone (CAL FIRE FHSZ)" | "Wildfire risk score" (FHSZ is hazard, not risk) |
| "N-1 screening on a 9-segment model" | "Contingency analysis" / "state estimation" |
| "Cascade drill" | "We predict blackouts" |
| "Risk index with our weights" | "Industry-standard risk score" |
| "Situation report" | "Control-room console" |
| "Would integrate with an ADMS" | "Replaces your ADMS" |
| "Modeled service area" | "Billing records" |

---

## 11. Sources

Primary sources used in this teardown. Vendor marketing is cited only for capability lists; formulas are cited to documentation or regulatory filings.

**Vendors and platforms**

- Siemens Spectrum Power ADMS module catalogue — https://assets.new.siemens.com/siemens/assets/api/uuid:6be45822-9bad-4f93-ac98-d4fbee5d622f/interactive-pdf-for-ADMS-modules.pdf
- Siemens Gridscale X Network Model Manager — https://www.siemens.com/en-us/products/gridscale-x/network-model-manager
- Siemens LV Insights — https://www.siemens.com/en-us/products/gridscale-x/lv-insights-x
- Siemens Flexibility Manager — https://www.siemens.com/en-us/products/gridscale-x/flexibility-manager
- GE GridOS for Distribution — https://www.gevernova.com/software/products/gridos-for-distribution
- GE GridOS ADMS — https://www.gevernova.com/software/products/gridos/advanced-distribution-management-system
- GE GridOS AEMS — https://www.gevernova.com/software/products/gridos/advanced-energy-management-system
- GE Smallworld GNM — https://www.gevernova.com/software/products/geospatial-network-management-smallworld-gis
- GE SmartSignal — https://www.ge.com/digital/applications/asset-performance-management-apm-software/equipment-downtime-prevention-ge-smartsignal
- GE GridOS Visual Intelligence solution paper — https://www.gevernova.com/software/sites/default/files/2026-07/gridos_vi-solution-paper.pdf
- AVEVA CONNECT — https://www.aveva.com/en/solutions/connect
- AVEVA PI Vision — https://www.aveva.com/en/products/aveva-pi-vision/
- PG&E / AVEVA PI–ADMS integration — https://www.aveva.com/en/perspectives/presentations/2023/pg-e--aveva--pi-system--adms-integration-and-it-ot-convergence/
- Schneider EcoStruxure ADMS — https://www.se.com/us/en/work/solutions/for-business/electric-utilities/advanced-distribution-management-system-adms
- Schneider EcoStruxure Grid Operation — https://www.se.com/us/en/product-range/152949461-ecostruxure-grid-operation/
- Schneider EcoStruxure DERMS — https://www.se.com/us/en/product-range/89571422-ecostruxure-derms
- Schneider ArcFM XI — https://www.se.com/us/en/work/solutions/for-business/electric-utilities/geographic-information-systems-gis-arcfm
- PG&E PSPS annex (Foundry/PSIP, 50+ sources, situation report, PSPS Viewer) — https://www.pge.com/assets/pge/docs/outages-and-safety/outage-preparedness-and-support/emer-3106m-psps-annex-to-cerp-v9.pdf
- Palantir PSPS scoping use case — https://palantir.com/docs/foundry/use-case-examples/public-safety-power-shutoff-psps-scoping
- Palantir transformer failure use case — https://palantir.com/docs/foundry/use-case-examples/preventing-transformer-failure-via-alerting-and-investigation-support
- SCE Palantir/EONS filing — https://efiling.energysafety.ca.gov/eFiling/Getfile.aspx?fileid=54290&shareable=true

**Risk, PSPS and asset health math**

- IBM Maximo default scores (`risk = ((100−health)/100) × criticality`) — https://www.ibm.com/docs/en/mhmpmh-and-p-u/cd?topic=using-default-scores
- Technosylva composite risk metrics (0–1, POF × POI × consequence) — https://helpcenter.technosylva.com/wfa-firesight/using-composite-risk-metrics
- PacifiCorp wildfire risk governance filing (weights, normalization) — https://efiling.energysafety.ca.gov/eFiling/Getfile.aspx?docket=2023-2025-WMP-DRs&fileid=57829&shareable=true
- SDG&E PSPS consequence multipliers — https://www.sdge.com/sites/default/files/regulatory/JW%20-%20Appendix%20C%20-%20SDGE%202020-2022%20WMP%20Update%20(2022).pdf
- Liberty PSPS safety multiplier — https://california.libertyutilities.com/uploads/Liberty_2026-2028%20Base-WMP_R1.pdf
- FEMA National Risk Index technical documentation — https://www.fema.gov/sites/default/files/documents/fema_national-risk-index_technical-documentation_0.pdf
- CAL FIRE FHSZ — https://osfm.fire.ca.gov/what-we-do/community-wildfire-preparedness-and-mitigation/fire-hazard-severity-zones
- CEJST technical documentation — https://dblew8dgr6ajz.cloudfront.net/data-versions/2.0/data/score/downloadable/cejst-technical-support-document.pdf
- Neara risk-impact scoring — https://neara.com/utilities/digital-asset-management/risk-impact-scoring
- LineVision LineRate — https://www.linevisioninc.com/products/linerate
- LineVision LineHealth — https://www.linevisioninc.com/products/linehealth

**Data and open models**

- Electricity Maps API — https://portal.electricitymaps.com/docs/getting-started
- WattTime API — https://docs.watttime.org/
- EIA API v2 — https://www.eia.gov/opendata/documentation.php
- GridStatus open-source library — https://github.com/gridstatus/gridstatus
- interconnection.fyi terms — https://www.interconnection.fyi/terms
- CAISO OASIS — https://www.caiso.com/systems-applications/portals-applications/open-access-same-time-information-system-oasis
- ORNL ODIN — https://odin.ornl.gov/api-docs/developer-guide/api-access-and-data-availability
- PowerOutage.us API — https://poweroutage.us/use-our-data
- HIFLD — https://www.dhs.gov/gmo/hifld
- OpenStreetMap copyright/license — https://www.openstreetmap.org/copyright
- NREL PVWatts v8 — https://developer.nrel.gov/docs/solar/pvwatts/v8
- NREL SAM — https://sam.nrel.gov/
- NREL ATB — https://atb.nrel.gov/electricity/2025/data
- DSIRE API — https://dsireusa.org/dsire-api
- ENERGY STAR Portfolio Manager web services — https://portfoliomanager.energystar.gov/webservices/home/
- EPA EPANET — https://www.epa.gov/water-research/epanet
- EPRI OpenDSS — https://opendss.epri.com/
- GridLAB-D — https://github.com/gridlab-d/gridlab-d
- PyPSA — https://github.com/PyPSA/PyPSA
- GenX — https://github.com/GenXProject/GenX.jl
- First Street API — https://docs.firststreet.org/api

---

## Appendix A — formulas to reuse

### A.1 Risk Index v2

```
L = 40·fossilShare
  + 25·clamp((CI−200)/200, 0, 1)
  + 20·clamp((0.85−motorEff)/0.35, 0, 1)
  + 15·clamp((age−20)/60, 0, 1)
  + 8·heatwave
  + 10·clamp((corridorLoading−70)/30, 0, 1)

C = 1 + 4·normalize(
      w_pop·populationServed + w_cfi·criticalFacilities
    + w_water·waterServiceDependency + w_mw·MWshare )

R = clamp(L · C / 3, 0, 100)   // C = 3 neutral
EAL = (L/100) · baselineFailureRate · consequence$
```

All weights are screening assumptions, displayed and adjustable.

### A.2 Maximo-style asset risk

```
health = RULscore + openWorkOrders + openServiceRequests   (0–100)
criticality = assetPriority normalized 1–5 (default 1)
risk = ((100 − health)/100) · criticality
```

### A.3 Technosylva-style wildfire risk

```
expectedRisk = POF · consequence
RAIL         = POF · POI · consequence
composite    = normalize(Σ weight_i · metric_i)   // 0–1
display      = percentile within territory
```

### A.4 FEMA NRI

```
risk = expectedAnnualLoss · communityRiskFactor
communityRiskFactor = f(socialVulnerability, communityResilience)
display = national percentile
```

### A.5 PSPS weighted customers

```
Liberty: weighted = 30·MBL + 30·CFI + other
SDG&E:   CFI 20 safety / 10 financial / 30 reliability
         MBL 5 / 1 / 1
         other 1
```

Use one scheme, cite it, show the formula in the UI.

### A.6 N-1 / cascade

```
remove edge e → components
unserved = Σ load in components without a modeled source
loading_i = throughput_i / (mva_i · thermalDerate)
if loading_i > 100% → trip i, repeat (max 5)
unservedMWh = unservedMW · duration
$ = unservedMWh · VOLL + customerInterruptionCost
```

### A.7 Hosting capacity

Already implemented in `lib/physics/network.ts`: binary search the largest injection that keeps `Vmin/Vmax`, branch loading and reverse flow inside limits, with a full converged power flow at each step.

### A.8 Water-energy

```
P_kW = ρ·g·Q·H / (3.6e6 · η_pump · η_motor)     Q in m³/h, H in m
kWh/MG = 3.14 · H_ft / η_total
kWh/kgal = 0.00314 · H_ft / η_total
```

### A.9 Economics

```
CRF(r,n) = r(1+r)^n / ((1+r)^n − 1)
LCOE = (CRF·capex + O&M) / annualMWh
NPV = Σ cashflow_t / (1+r)^t
IRR = r where NPV(r) = 0
payback = capex / annualSavings
bill = energyMWh·$/MWh + peakMW·$/kW-mo·12
netCapex = capex·(1 − ITC − adder)
```

### A.10 Marginal vs. average emissions

```
annual footprint  → average CI (eGRID)
flexible load shift → marginal CI (WattTime/Cambium)
avoided emissions = ΔMWh · marginalCI   (not average)
```

### A.11 Risk removed per dollar

```
ΔR = R_before − R_after
value = ΔR · consequence$ / capex
```

---

## Appendix B — data access quick reference

| Source | Free? | Key? | Published limit | Use | Catch |
|---|---|---|---|---|---|
| Electricity Maps | Yes (individual) | Yes | 150 req/min default; 24 h history | Live CI/mix | Commercial use paid |
| WattTime | Yes (noncommercial) | Yes | 3,000 req / 5 min | Marginal CI | Full regions paid; CAISO_NORTH free |
| EIA v2 | Yes | Yes | ~9,000 req/h guideline | Context | Route limits vary |
| GridStatus hosted | Yes tier | Yes | 250 req/month, 500k rows | Live strip | Source terms differ |
| GridStatus library | Yes (BSD) | No | n/a | Fetch source data | Not a hosted API |
| CAISO OASIS/Today's Outlook | Yes | No | Not verified | CA demand/supply | Telemetry vs. market mismatch |
| ODIN | Yes | No (county) | Not verified | Outage overlay | County-level public |
| PowerOutage.us | No | Yes | Not verified | Outage map | Enterprise paid |
| HIFLD | Archived | No | n/a | Grid layers | Open shutdown Aug 2025 |
| OSM/Overpass | Yes | No | Fair use | Grid/critical facilities | ODbL share-alike |
| PVWatts | Yes | Yes | 1,000 req/h/key | Solar CF | DEMO_KEY 30/h |
| SAM | Yes | Registration | n/a | Project finance | Check license |
| ATB | Yes | No | n/a | Tech costs | Check release license |
| DSIRE | Public site | No | n/a | Incentives | API paid |
| Portfolio Manager | Yes | EPA approval | Published | Benchmark | Property sharing required |
| First Street | No | Contract | n/a | Climate risk | Paid |
| interconnection.fyi | Browse | No | n/a | Queue context | No scraping/bulk; data paid |
| CalFire FHSZ | Yes | No | n/a | Wildfire hazard | Hazard ≠ risk |
| CEJST/CalEnviroScreen | Yes | No | n/a | Equity | Tract vintage |

---

## Appendix C — handoff prompts for the remaining top features

**Situation report**

> Build `lib/report.ts` + `components/report/SituationReport.tsx`. Inputs: region payload, selected scenario, risk v2, PSPS/contingency outputs, evidence bundle. Output: one printable page — scope, MW, CO₂, top 5 risk assets with L/C/R, affected customers/CFI (modeled), $ consequence, top 5 actions with payback, sources + snapshot hashes. Add `window.print()` CSS and a CSV export. No new data.

**Portfolio optimizer**

> Build `lib/portfolio.ts`. Inputs: all facility pathways (solar/VFD/grid phases), risk v2, budget. Greedy + 0/1 knapsack by `ΔR·consequence/capex`; return funded set, total capex, risk removed, CO₂ avoided, blended payback, and the marginal project that just missed the budget. UI: budget slider + ranked table + map highlight. Deterministic tie-break by id.

**Live strip**

> Add `app/api/live/route.ts` with a 60 s cache, calling one free source (Electricity Maps or GridStatus) behind an env var; fall back to a labeled static snapshot. UI: `ControlBar` strip — CI, fuel mix, demand, timestamp, "indicative" label. Never block render; no key → "snapshot" state.

**Water-energy card**

> Add `lib/water.ts`: `kWh/MG = 3.14·H_ft/η`, `P_kW = ρgQH/(3.6e6·η_pump·η_motor)`. Extend the facility type with optional `flow_mgd`/`head_ft` only if sourced; otherwise show a **what-if** card with user inputs, labeled modeled. Add to `TelemetryTab`. Compare pump efficiency to a 0.75 benchmark.

**Work-order case**

> Add `lib/case.ts` + `components/action/CasePanel.tsx`: state machine `open → assigned → scheduled → done → verified → closed`, owner, due date, evidence claim ids, notes, blocked reason. Persist locally (no backend). Create from a pathway or a memo. Show status on the facility rail.

**Trends**

> Add `lib/trends.ts` using `physics/load` to generate a 24 h and 8760 profile per facility; render with the existing `Sparkline` and a small Recharts area. Add "peak / trough / ramp" stats. Label synthetic weather.

---

*End of Part 2.*
