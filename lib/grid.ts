/**
 * Six-phase grid chain — one exposure report per load center.
 *
 * Every grid fact in here is either read off a real layer (EIA-860 plants, OSM
 * transmission and substations, via `lib/gridAssets.ts`) or computed by the
 * physics in `lib/physics` (IEEE 738 conductor ratings, inertia, project
 * economics). The only modelled numbers left are the load center's own
 * simulated demand — the app's existing contract — and the intervention unit
 * costs, which are labelled screening estimates.
 *
 * Cut on purpose: derived generation MW from `source_mix`, invented tie MVA
 * loading, transformer DGA / top-oil scores, SAIDI/SAIFI, phase imbalance and
 * nodal price / reserve figures. Each of those either duplicated a real layer
 * or claimed a measurement this repo does not have.
 */

import { dailyProfile } from "./simulation";
import { inertiaBand } from "./physics/dynamics";
import { DEFAULT_ECONOMICS, capacityValue, carbonCost, simplePayback } from "./physics/economics";
import { reconductorScreen, thermalScreen, type RealGridAssets } from "./gridAssets";
import type { FacilityProperties, SimResult } from "./types";

export type Severity = "ok" | "watch" | "high" | "critical";

export const SEVERITY_COLOR: Record<Severity, string> = {
  ok: "#2DD4A7",
  watch: "#E8A33D",
  high: "#F97316",
  critical: "#F04D5E",
};

const SEVERITY_RANK: Record<Severity, number> = {
  ok: 0,
  watch: 1,
  high: 2,
  critical: 3,
};

/** Large power transformer design life, years. */
export const TRANSFORMER_DESIGN_LIFE = 35;
/** Current industry lead time for a replacement LPT, weeks. */
export const LPT_LEAD_TIME_WEEKS = 130;
const MWH_PER_HOME = 10.5;

/** Screening unit costs for interventions. Not claims about the grid. */
const UNIT = {
  bess_mw: 1_350_000,
  bess_mw_savings: 260_000,
  inverter_mw_capex: 62_000,
  inverter_mw_savings: 11_000,
  dlr_mva_capex: 45_000,
  reconductor_mva_capex: 210_000,
  substation_monitor_capex: 210_000,
  substation_monitor_per_bank: 46_000,
  substation_mva_capex: 165_000,
  substation_mva_savings: 32_000,
  recloser_capex: 145_000,
  recloser_savings: 62_000,
  feeder_tx_capex: 380_000,
  feeder_tx_savings: 72_000,
  vpp_mw_capex: 28_000,
  vpp_mw_savings: 6_000,
  charging_mw_capex: 16_000,
  charging_mw_savings: 3_600,
  dr_mw_capex: 120_000,
  dr_mw_savings: 95_000,
  arbitrage_mw_capex: 1_350_000,
  arbitrage_mw_savings: 240_000,
};

export interface Diagnostic {
  id: string;
  label: string;
  detail: string;
  severity: Severity;
}

export interface Pathway {
  id: string;
  label: string;
  detail: string;
  capex_usd: number;
  annual_savings_usd: number;
  co2_avoided_tons: number;
  payback_years: number | null;
}

export interface PhaseState {
  phase: number;
  id: string;
  name: string;
  short: string;
  headline: string;
  /** Where the numbers come from, shown in the UI so the cut is visible. */
  provenance: string;
  telemetry: { label: string; value: string }[];
  diagnostics: Diagnostic[];
  pathways: Pathway[];
  severity: Severity;
}

export interface PhaseExposure {
  phase: number;
  id: string;
  name: string;
  short: string;
  severity: Severity;
  alerts: number;
  at_risk_mw: number;
  share_pct: number;
  capex_usd: number;
  annual_savings_usd: number;
  payback_years: number | null;
}

export interface GridContext {
  /** Summaries of the real layers around this load center; null until loaded. */
  assets: RealGridAssets | null;
}

// ---- helpers ----------------------------------------------------------------

function nf(value: number, digits = 1): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

function money(value: number): number {
  return Math.max(0, Math.round(value));
}

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

function band(value: number, watch: number, high: number, critical: number): Severity {
  if (value >= critical) return "critical";
  if (value >= high) return "high";
  if (value >= watch) return "watch";
  return "ok";
}

function pathway(p: Omit<Pathway, "payback_years">): Pathway {
  return { ...p, payback_years: simplePayback(p.capex_usd, p.annual_savings_usd) };
}

function worstSeverity(diagnostics: Diagnostic[]): Severity {
  return diagnostics.reduce<Severity>(
    (acc, d) => (SEVERITY_RANK[d.severity] > SEVERITY_RANK[acc] ? d.severity : acc),
    "ok",
  );
}

function listNames(items: { name: string; mw: number }[]): string {
  return items.map((item) => `${item.name} (${nf(item.mw, 0)} MW)`).join(", ");
}

type PhaseBase = Pick<PhaseState, "phase" | "id" | "name" | "short" | "headline" | "provenance">;

function unavailable(base: PhaseBase, layer: string): PhaseState {
  const diagnostics: Diagnostic[] = [
    {
      id: "layer-missing",
      label: `${layer} layer not loaded`,
      detail: `This phase reads ${layer}. The layer has not arrived yet, so the panel reports nothing rather than a modelled stand-in.`,
      severity: "watch",
    },
  ];
  return { ...base, telemetry: [], pathways: [], diagnostics, severity: "watch" };
}

// ---- phase 1: generation & primary supply -----------------------------------

function phaseGeneration(sim: SimResult, assets: RealGridAssets | null): PhaseState {
  const base = {
    phase: 1,
    id: "generation",
    name: "Generation & primary supply",
    short: "Generation",
    provenance: "EIA-860 2025 · physics inertia",
  };
  const g = assets?.generation;
  if (!g) return unavailable({ ...base, headline: "—" }, "EIA-860 plant");

  const fossilShare = pct(g.fossil_mw, g.total_mw);
  const retireShare = pct(g.retiring_mw, g.total_mw);
  const hSys = g.total_mw > 0 ? g.inertia_mws / g.total_mw : 0;
  const largest = g.largest;

  const diagnostics: Diagnostic[] = [
    {
      id: "fossil-share",
      label: "Fossil share inside the ring",
      detail: `${g.fossil_mw.toLocaleString("en-US")} MW of ${g.total_mw.toLocaleString("en-US")} MW within ${g.radius_mi} mi is gas or oil${
        largest ? `; the largest plant is ${largest.name} at ${nf(largest.mw, 0)} MW, ${largest.distance_mi} mi out` : ""
      }.`,
      severity: band(fossilShare, 40, 55, 70),
    },
    {
      id: "retirements",
      label: "Planned retirements",
      detail:
        g.retiring_mw > 0
          ? `${g.retiring_mw.toLocaleString("en-US")} MW (${nf(retireShare, 1)}% of ring capacity) is scheduled to retire — ${listNames(g.retiring)}.`
          : `No generator inside ${g.radius_mi} mi carries a planned retirement date in the EIA-860 table.`,
      severity: band(retireShare, 4, 10, 20),
    },
    {
      id: "fleet-age",
      label: "Capacity-weighted fleet age",
      detail:
        g.fleet_age_years === null
          ? "The layer carries no capacity-weighted year for these plants."
          : `${nf(g.fleet_age_years, 1)} years, weighted by nameplate MW. Weighting by capacity keeps one old peaker from standing in for the fleet.`,
      severity: g.fleet_age_years === null ? "ok" : band(g.fleet_age_years, 25, 35, 45),
    },
    {
      id: "inertia",
      label: "Synchronous share & stored inertia",
      detail: `${nf(g.synchronous_share_pct, 1)}% of ring MVA is synchronous, storing ${g.inertia_mws.toLocaleString("en-US")} MW·s (H = ${nf(hSys, 2)} s). Inverter-based MW contribute no inertia unless the controls provide it.`,
      severity: hSys > 0 ? inertiaBand(hSys) : "ok",
    },
  ];

  const draw = sim.effective_draw_mw;
  const bessMW = nf(Math.max(0.5, draw * 0.25), 1);

  return {
    ...base,
    headline: `${nf(fossilShare, 0)}% fossil`,
    telemetry: [
      { label: "Plants", value: `${g.plant_count} ≤ ${g.radius_mi} mi` },
      { label: "Ring capacity", value: `${g.total_mw.toLocaleString("en-US")} MW` },
      { label: "Fossil", value: `${g.fossil_mw.toLocaleString("en-US")} MW` },
      { label: "Storage", value: `${g.storage_mw.toLocaleString("en-US")} MW` },
      { label: "Retiring", value: `${g.retiring_mw.toLocaleString("en-US")} MW` },
    ],
    diagnostics,
    pathways: [
      pathway({
        id: "bess",
        label: `Co-located BESS · ${nf(bessMW, 1)} MW / 4 h`,
        detail:
          "Absorbs the midday surplus and discharges into the evening ramp. Shifts energy rather than abating it, so the carbon credit sits with the solar it makes dispatchable.",
        capex_usd: money(bessMW * UNIT.bess_mw),
        annual_savings_usd: money(bessMW * UNIT.bess_mw_savings),
        co2_avoided_tons: 0,
      }),
      pathway({
        id: "grid-forming",
        label: "Synthetic-inertia inverter retrofit",
        detail:
          "Grid-forming controls on the region's inverter fleet restore frequency and voltage response without new rotating mass.",
        capex_usd: money(draw * UNIT.inverter_mw_capex),
        annual_savings_usd: money(draw * UNIT.inverter_mw_savings),
        co2_avoided_tons: 0,
      }),
    ],
    severity: "ok", // replaced by gridChain
  };
}

// ---- phase 2: high-voltage transmission -------------------------------------

function phaseTransmission(sim: SimResult, assets: RealGridAssets | null): PhaseState {
  const base = {
    phase: 2,
    id: "transmission",
    name: "High-voltage transmission",
    short: "Transmission",
    provenance: "OSM circuits · IEEE 738",
  };
  const t = assets?.transmission;
  if (!t || !t.thermal) return unavailable({ ...base, headline: "—" }, "OSM transmission");

  const thermal = t.thermal;
  const nearest = t.nearest[0] ?? null;
  const kv = thermal.voltage_kv;
  const coverage: Severity = kv >= 230 ? "ok" : kv >= 115 ? "watch" : "high";

  const diagnostics: Diagnostic[] = [
    {
      id: "thermal-derate",
      label: "Thermal rating at 105 °F",
      detail: `${thermal.conductor} at ${kv} kV rates ${thermal.rating_mva_25c} MVA at 25 °C and ${thermal.rating_mva_105f} MVA at 40.6 °C — ${nf(thermal.derate_pct, 1)}% lower, from the IEEE 738 heat balance. Holding the 25 °C rating through that afternoon would push the conductor to ${nf(thermal.conductor_temp_c_at_rating, 0)} °C against a ${thermal.max_temp_c} °C limit.`,
      severity: band(thermal.derate_pct, 8, 14, 20),
    },
    {
      id: "redundancy",
      label: "Circuits at the top voltage",
      detail: `${t.top_voltage_count} of ${t.line_count} tagged circuits inside ${t.radius_mi} mi run at ${kv} kV; the remaining ${t.line_count - t.top_voltage_count} sit at lower classes.`,
      severity:
        t.top_voltage_count >= 8
          ? "ok"
          : t.top_voltage_count >= 4
            ? "watch"
            : t.top_voltage_count >= 2
              ? "high"
              : "critical",
    },
    {
      id: "coverage",
      label: "Voltage coverage at the site",
      detail: `${t.line_count} tagged circuits inside ${t.radius_mi} mi; the highest is ${kv} kV.${
        nearest ? ` Nearest: ${nearest.name}${nearest.operator ? ` (${nearest.operator})` : ""}, ${nearest.distance_mi} mi.` : ""
      }`,
      severity: coverage,
    },
    {
      id: "dlr",
      label: "Dynamic line rating headroom",
      detail: `The same conductor rates ${thermal.dlr_rating_mva} MVA in a 3 m/s breeze at 105 °F — ${thermal.dlr_uplift_mva} MVA that a static rating leaves on the table.`,
      severity: "ok",
    },
  ];

  const reconductor = reconductorScreen(kv);
  const capacityValueUsd = (mw: number) => capacityValue(mw, 45_000);

  return {
    ...base,
    headline: `${kv} kV`,
    telemetry: [
      { label: "Circuits", value: `${t.line_count} ≤ ${t.radius_mi} mi` },
      { label: "Highest", value: `${kv} kV` },
      { label: "105 °F rating", value: `${thermal.rating_mva_105f} MVA` },
      { label: "DLR headroom", value: `+${thermal.dlr_uplift_mva} MVA` },
    ],
    diagnostics,
    pathways: [
      pathway({
        id: "dlr",
        label: `Dynamic line rating · +${thermal.dlr_uplift_mva} MVA`,
        detail:
          "Sensors plus weather modelling release the thermal headroom the static rating already gives up on a breezy afternoon.",
        capex_usd: money(kv * UNIT.dlr_mva_capex),
        annual_savings_usd: money(capacityValueUsd(thermal.dlr_uplift_mva)),
        co2_avoided_tons: 0,
      }),
      pathway({
        id: "reconductor",
        label: `Reconductoring · +${reconductor.uplift_mva} MVA`,
        detail: `Replace ${reconductor.from} with ${reconductor.to}: ${reconductor.rating_mva_105f} MVA at 105 °F, with the voltage class and structures kept.`,
        capex_usd: money(reconductor.uplift_mva * UNIT.reconductor_mva_capex),
        annual_savings_usd: money(capacityValueUsd(reconductor.uplift_mva)),
        co2_avoided_tons: 0,
      }),
    ],
    severity: "ok",
  };
}

// ---- phase 3: substations & transformation ----------------------------------

function phaseSubstation(p: FacilityProperties, sim: SimResult, assets: RealGridAssets | null): PhaseState {
  const base = {
    phase: 3,
    id: "substation",
    name: "Substations & transformation",
    short: "Substation",
    provenance: "OSM substations · site vintage",
  };
  const s = assets?.substations;
  if (!s) return unavailable({ ...base, headline: "—" }, "OSM substation");

  const nearest = s.nearest_named[0] ?? null;
  const age = p.infrastructure.age_years;
  const distance = nearest?.distance_mi ?? null;

  const diagnostics: Diagnostic[] = [
    {
      id: "nearest-transmission",
      label: "Nearest transmission-class substation",
      detail: nearest
        ? `${nearest.name}${nearest.voltage_kv !== null ? ` at ${nearest.voltage_kv} kV` : ""}${
            nearest.operator ? `, operated by ${nearest.operator}` : ""
          }, ${nf(nearest.distance_mi, 1)} mi from the site. ${s.transmission_count} transmission-class substations sit inside ${s.radius_mi} mi.`
        : `No named transmission substation inside ${s.radius_mi} mi; OSM tags ${s.count} substation outlines nearby without a name or voltage.`,
      severity:
        distance === null
          ? "watch"
          : distance <= 2
            ? "ok"
            : distance <= 5
              ? "watch"
              : distance <= 10
                ? "high"
                : "critical",
    },
    {
      id: "voltage-coverage",
      label: "Transformation voltage available",
      detail:
        s.max_kv !== null
          ? `The highest tagged voltage within ${s.radius_mi} mi is ${s.max_kv} kV across ${s.named_count} named substations.`
          : "OSM carries no voltage tag for these substation outlines — the layer cannot support a voltage claim here.",
      severity: s.max_kv === null ? "watch" : s.max_kv >= 230 ? "ok" : s.max_kv >= 115 ? "watch" : "high",
    },
    {
      id: "site-vintage",
      label: "Site vintage against transformer design life",
      detail: `${age} years in service. OSM carries no transformer age, DGA trend or nameplate MVA — the ${TRANSFORMER_DESIGN_LIFE}-yr design life is applied to the site's vintage, not to a named unit.`,
      severity: age > 60 ? "critical" : age > 45 ? "high" : age > TRANSFORMER_DESIGN_LIFE ? "watch" : "ok",
    },
    {
      id: "lead-time",
      label: `${LPT_LEAD_TIME_WEEKS}-week replacement lead time`,
      detail:
        "A failed large power transformer cannot be replaced inside a quarter. Long-lead spares and monitoring are the only mitigations that fit that supply chain.",
      severity: age > TRANSFORMER_DESIGN_LIFE ? "high" : "watch",
    },
  ];

  const mva = nf(Math.max(1, p.infrastructure.nameplate_draw_mw * 2), 0);
  const banks = Math.max(1, Math.ceil(mva / 120));

  return {
    ...base,
    headline: s.max_kv !== null ? `${s.max_kv} kV` : `${s.count} subs`,
    telemetry: [
      { label: "Substations", value: `${s.count} ≤ ${s.radius_mi} mi` },
      { label: "Named", value: `${s.named_count}` },
      { label: "Transmission class", value: `${s.transmission_count}` },
      { label: "Site vintage", value: `${age} yr` },
    ],
    diagnostics,
    pathways: [
      pathway({
        id: "dga-monitoring",
        label: "Continuous DGA fibre-optic monitoring",
        detail:
          "Online gas and thermal monitoring turns a 130-week replacement queue into a planned outage with a spare on the shelf.",
        capex_usd: money(UNIT.substation_monitor_capex + banks * UNIT.substation_monitor_per_bank),
        annual_savings_usd: money(sim.effective_draw_mw * 9_500 + 40_000),
        co2_avoided_tons: 0,
      }),
      pathway({
        id: "modular-substation",
        label: "Modular substation retrofit",
        detail:
          "Skid-mounted transformer, breaker and busbar modules replace a vintage bank with a shorter build and a smaller footprint.",
        capex_usd: money(mva * UNIT.substation_mva_capex),
        annual_savings_usd: money(mva * UNIT.substation_mva_savings),
        co2_avoided_tons: 0,
      }),
    ],
    severity: "ok",
  };
}

// ---- phase 4: distribution networks -----------------------------------------

function phaseDistribution(p: FacilityProperties, assets: RealGridAssets | null): PhaseState {
  const base = {
    phase: 4,
    id: "distribution",
    name: "Distribution networks",
    short: "Distribution",
    provenance: "OSM distribution substations",
  };
  const s = assets?.substations;
  if (!s) return unavailable({ ...base, headline: "—" }, "OSM substation");

  const nearest = s.nearest_distribution_mi;
  const nameplate = p.infrastructure.nameplate_draw_mw;
  const feeders = Math.max(2, Math.ceil(nameplate / 8));

  const diagnostics: Diagnostic[] = [
    {
      id: "distribution-density",
      label: "Distribution substation density",
      detail: `${s.distribution_count} of the ${s.count} substations inside ${s.radius_mi} mi are tagged distribution (${s.named_count} carry a name). OSM coverage thins away from cities, so this is a floor, not a census.`,
      severity:
        s.distribution_count >= 8 ? "ok" : s.distribution_count >= 4 ? "watch" : s.distribution_count >= 1 ? "high" : "critical",
    },
    {
      id: "nearest-distribution",
      label: "Nearest distribution substation",
      detail:
        nearest === null
          ? `No substation tagged distribution inside ${s.radius_mi} mi.`
          : `${nf(nearest, 1)} mi to the nearest distribution substation outline.`,
      severity:
        nearest === null ? "critical" : nearest <= 1 ? "ok" : nearest <= 3 ? "watch" : nearest <= 6 ? "high" : "critical",
    },
    {
      id: "reliability-gap",
      label: "No reliability claim",
      detail:
        "OSM does not publish SAIDI, SAIFI or feeder topology. The chain does not invent them; reliability work needs the utility's outage data.",
      severity: "ok",
    },
  ];

  return {
    ...base,
    headline: `${s.distribution_count} distribution subs`,
    telemetry: [
      { label: "Distribution subs", value: `${s.distribution_count}` },
      { label: "Nearest", value: nearest === null ? "—" : `${nf(nearest, 1)} mi` },
      { label: "Feeder estimate", value: `${feeders}` },
      { label: "Site nameplate", value: `${nf(nameplate, 1)} MW` },
    ],
    diagnostics,
    pathways: [
      pathway({
        id: "reclosers",
        label: "Automated smart-switching reclosers",
        detail:
          "Sectionalising reclosers isolate the faulted span and restore the healthy blocks in seconds instead of a truck roll.",
        capex_usd: money(feeders * UNIT.recloser_capex),
        annual_savings_usd: money(feeders * UNIT.recloser_savings),
        co2_avoided_tons: 0,
      }),
      pathway({
        id: "feeder-transformers",
        label: "Right-sized distribution transformers",
        detail:
          "Replace pole and pad units with the correct kVA class so the feeder stops carrying transformer losses and heat.",
        capex_usd: money(feeders * UNIT.feeder_tx_capex),
        annual_savings_usd: money(feeders * UNIT.feeder_tx_savings),
        co2_avoided_tons: 0,
      }),
    ],
    severity: "ok",
  };
}

// ---- phase 5: behind-the-meter consumption ----------------------------------

function phaseBehindMeter(p: FacilityProperties, sim: SimResult): PhaseState {
  const draw = sim.effective_draw_mw;
  const profile = dailyProfile(sim);
  const peak = Math.max(...profile);
  const trough = Math.min(...profile);
  const rampMW = nf(peak - trough, 2);
  const rampPct = nf(pct(rampMW, peak || 1), 1);
  const nameplate = p.infrastructure.nameplate_draw_mw;
  const peakDraw = p.energy_profile.peak_draw_mw;

  const diagnostics: Diagnostic[] = [
    {
      id: "evening-ramp",
      label: "Evening ramp",
      detail: `${nf(rampMW, 1)} MW must arrive across the 4 pm ramp (${nf(rampPct, 1)}% of peak) in the modelled 24-hour shape — the site's own load, not a grid measurement.`,
      severity: "watch",
    },
    {
      id: "load-shock",
      label: "Multi-megawatt load shock",
      detail: `Peak draw is ${nf(peakDraw, 1)} MW against ${nf(nameplate, 1)} MW nameplate: a swing the local feeder sees as one step.`,
      severity: band(nameplate, 10, 20, 30),
    },
  ];

  return {
    phase: 5,
    id: "behind-meter",
    name: "Behind-the-meter consumption",
    short: "Load",
    provenance: "modelled site load",
    headline: `${nf(rampPct, 0)}% ramp`,
    telemetry: [
      { label: "Peak draw", value: `${nf(peak, 1)} MW` },
      { label: "Evening ramp", value: `${nf(rampMW, 1)} MW` },
      { label: "Homes eq.", value: `${Math.round(sim.annual_mwh / MWH_PER_HOME).toLocaleString("en-US")}` },
      { label: "Heatwave draw", value: `${nf(draw, 1)} MW` },
    ],
    diagnostics,
    pathways: [
      pathway({
        id: "vpp",
        label: "Virtual power plant aggregation",
        detail:
          "Bundle the site's flexible cells, pumps and batteries into one dispatchable block the utility can call instead of a peaker.",
        capex_usd: money(draw * UNIT.vpp_mw_capex),
        annual_savings_usd: money(draw * UNIT.vpp_mw_savings),
        co2_avoided_tons: Math.round((sim.annual_mwh * 0.02 * sim.carbon_intensity) / 1000),
      }),
      pathway({
        id: "managed-charging",
        label: "Managed smart-charging protocol",
        detail:
          "Shift EV depot and fleet charging out of the 4–9 pm window; the same kWh, a flatter net load and no new wires.",
        capex_usd: money(draw * UNIT.charging_mw_capex),
        annual_savings_usd: money(draw * UNIT.charging_mw_savings),
        co2_avoided_tons: Math.round((sim.annual_mwh * 0.015 * sim.carbon_intensity) / 1000),
      }),
    ],
    severity: "ok",
  };
}

// ---- phase 6: market operations & dispatch ----------------------------------

function phaseMarket(sim: SimResult, assets: RealGridAssets | null): PhaseState {
  const base = {
    phase: 6,
    id: "market",
    name: "Market operations & dispatch",
    short: "Dispatch",
    provenance: "EIA-860 MW · planner assumptions",
  };
  const g = assets?.generation;
  if (!g) return unavailable({ ...base, headline: "—" }, "EIA-860 plant");

  const variable = (g.by_source.solar ?? 0) + (g.by_source.wind ?? 0);
  const storageRatio = pct(g.storage_mw, variable);
  const gapMW = Math.max(0, g.retiring_mw - g.storage_mw);
  const annualCost = sim.annual_mwh * DEFAULT_ECONOMICS.energy_price_usd_per_mwh;
  const co2Cost = carbonCost(sim.annual_co2_tons);

  const diagnostics: Diagnostic[] = [
    {
      id: "retirement-gap",
      label: "Retirement against storage in the ring",
      detail: `${g.retiring_mw.toLocaleString("en-US")} MW retiring against ${g.storage_mw.toLocaleString("en-US")} MW of battery in the same ring — a ${gapMW.toLocaleString("en-US")} MW firm-capacity gap if nothing else is built.`,
      severity: gapMW <= 0 ? "ok" : band(pct(gapMW, Math.max(1, g.total_mw)), 3, 8, 15),
    },
    {
      id: "storage-ratio",
      label: "Storage against variable generation",
      detail: `${nf(storageRatio, 1)}% storage-to-variable ratio (${g.storage_mw.toLocaleString("en-US")} MW battery, ${variable.toLocaleString("en-US")} MW solar + wind).`,
      severity: storageRatio >= 25 ? "ok" : storageRatio >= 12 ? "watch" : storageRatio >= 5 ? "high" : "critical",
    },
    {
      id: "cost-exposure",
      label: "Annual energy cost at the planner price",
      detail: `${sim.annual_mwh.toLocaleString("en-US")} MWh/yr at $${DEFAULT_ECONOMICS.energy_price_usd_per_mwh}/MWh (a planning assumption, not a market quote) is about $${Math.round(annualCost / 1_000_000)}M/yr, plus $${Math.round(co2Cost / 1000)}k/yr at $${DEFAULT_ECONOMICS.carbon_price_usd_per_ton}/t CO₂.`,
      severity: "ok",
    },
  ];

  const curtailableMW = nf(sim.effective_draw_mw * 0.12, 1);
  const arbitrageMW = nf(Math.max(0.5, sim.effective_draw_mw * 0.1), 1);

  return {
    ...base,
    headline: `${g.storage_mw.toLocaleString("en-US")} MW storage`,
    telemetry: [
      { label: "Ring storage", value: `${g.storage_mw.toLocaleString("en-US")} MW` },
      { label: "Retiring", value: `${g.retiring_mw.toLocaleString("en-US")} MW` },
      { label: "Planner price", value: `$${DEFAULT_ECONOMICS.energy_price_usd_per_mwh}/MWh*` },
      { label: "Carbon", value: `$${DEFAULT_ECONOMICS.carbon_price_usd_per_ton}/t*` },
    ],
    diagnostics,
    pathways: [
      pathway({
        id: "demand-response",
        label: `Automated demand response · ${nf(curtailableMW, 1)} MW`,
        detail:
          "Curtail the flexible block on a price or reserve signal instead of buying the peak; dispatch is automated, not a phone call.",
        capex_usd: money(curtailableMW * UNIT.dr_mw_capex),
        annual_savings_usd: money(curtailableMW * UNIT.dr_mw_savings),
        co2_avoided_tons: Math.round((sim.annual_mwh * 0.025 * sim.carbon_intensity) / 1000),
      }),
      pathway({
        id: "arbitrage",
        label: `BESS price arbitrage · ${nf(arbitrageMW, 1)} MW`,
        detail:
          "Buy in the solar belly, sell into the evening peak; the same battery that stabilises the site earns a spread.",
        capex_usd: money(arbitrageMW * UNIT.arbitrage_mw_capex),
        annual_savings_usd: money(arbitrageMW * UNIT.arbitrage_mw_savings),
        co2_avoided_tons: 0,
      }),
    ],
    severity: "ok",
  };
}

// ---- public API -------------------------------------------------------------

/** The six phases for one load center, ordered generation → market. */
export function gridChain(
  properties: FacilityProperties,
  sim: SimResult,
  ctx: GridContext,
): PhaseState[] {
  const assets = ctx.assets;
  const states = [
    phaseGeneration(sim, assets),
    phaseTransmission(sim, assets),
    phaseSubstation(properties, sim, assets),
    phaseDistribution(properties, assets),
    phaseBehindMeter(properties, sim),
    phaseMarket(sim, assets),
  ];

  return states.map((state) => ({
    ...state,
    severity: worstSeverity(state.diagnostics),
  }));
}

/**
 * Region-wide rollup: which phase is the binding constraint across every load
 * center, how much demand sits behind it, and what the primary fix costs.
 */
export function phaseExposure(
  entries: { draw_mw: number; states: PhaseState[] }[],
): PhaseExposure[] {
  const rows: PhaseExposure[] = [];

  for (let phase = 1; phase <= 6; phase += 1) {
    let severity: Severity = "ok";
    let alerts = 0;
    let atRiskMW = 0;
    let capex = 0;
    let savings = 0;
    let name = "";
    let short = "";
    let id = "";

    for (const entry of entries) {
      const state = entry.states.find((s) => s.phase === phase);
      if (!state) continue;
      name = state.name;
      short = state.short;
      id = state.id;
      if (SEVERITY_RANK[state.severity] > SEVERITY_RANK[severity]) severity = state.severity;
      const phaseAlerts = state.diagnostics.filter(
        (d) => d.severity === "high" || d.severity === "critical",
      ).length;
      alerts += phaseAlerts;
      if (SEVERITY_RANK[state.severity] >= SEVERITY_RANK.high) {
        atRiskMW += entry.draw_mw;
        capex += state.pathways[0]?.capex_usd ?? 0;
        savings += state.pathways[0]?.annual_savings_usd ?? 0;
      }
    }

    rows.push({
      phase,
      id,
      name,
      short,
      severity,
      alerts,
      at_risk_mw: nf(atRiskMW, 1),
      share_pct: 0,
      capex_usd: money(capex),
      annual_savings_usd: money(savings),
      payback_years: simplePayback(capex, savings),
    });
  }

  const maxRisk = Math.max(1, ...rows.map((row) => row.at_risk_mw));
  return rows.map((row) => ({
    ...row,
    share_pct: Math.round((row.at_risk_mw / maxRisk) * 100),
  }));
}
