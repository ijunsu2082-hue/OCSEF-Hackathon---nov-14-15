/**
 * Six-phase grid chain — the end-to-end electrical data model, one exposure
 * report per load center.
 *
 * Every phase carries the telemetry that drives it, the diagnostics it can
 * trip, and two priced upgrade pathways with a simple payback. The pathway
 * catalogue is what the app was missing: co-located BESS and inverter
 * retrofits (phase 1), dynamic line rating and reconductoring (phase 2),
 * DGA monitoring and modular substations (phase 3), smart reclosers and
 * right-sized feeder transformers (phase 4), VPP aggregation and managed
 * charging (phase 5), demand response and price arbitrage (phase 6).
 *
 * Pure: no I/O, no React. Screening estimates only — the same caveat as
 * `lib/simulation.ts`.
 */

import { clamp } from "./risk";
import type { FacilityProperties, PowerFlow, SimResult } from "./types";

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

/** 105 °F: conductors sag, so a line's thermal rating falls ~12 %. */
export const HEATWAVE_LINE_DERATE = 0.88;
/** Large power transformer design life, years. */
export const TRANSFORMER_DESIGN_LIFE = 35;
/** Current industry lead time for a replacement LPT, weeks. */
export const LPT_LEAD_TIME_WEEKS = 130;
const MWH_PER_HOME = 10.5;

/** Screening unit economics. Every pathway lands somewhere in a 1–6 year band. */
const UNIT = {
  bess_mw: 1_350_000,
  bess_mw_savings: 260_000,
  inverter_mw_capex: 62_000,
  inverter_mw_savings: 11_000,
  dlr_mva_capex: 45_000,
  dlr_release_pct: 0.15,
  reconductor_mva_capex: 210_000,
  reconductor_release_pct: 0.3,
  capacity_value_mw_yr: 120_000,
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
  telemetry: { label: string; value: string }[];
  diagnostics: Diagnostic[];
  pathways: Pathway[];
  severity: Severity;
}

export interface CorridorLoading {
  id: string;
  label: string;
  from: string;
  to: string;
  mva: number;
  capacity_mva: number;
  throughput_mw: number;
  loading_pct: number;
  loss_pct: number;
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
  flows: PowerFlow[];
  sims: Record<string, SimResult>;
}

// ---- helpers ----------------------------------------------------------------

function num(value: number, digits = 1): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

function money(value: number): number {
  return Math.max(0, Math.round(value));
}

function band(value: number, watch: number, high: number, critical: number): Severity {
  if (value >= critical) return "critical";
  if (value >= high) return "high";
  if (value >= watch) return "watch";
  return "ok";
}

function paybackYears(capex: number, savings: number): number | null {
  return savings > 0 ? num(capex / savings, 2) : null;
}

function pathway(p: Omit<Pathway, "payback_years">): Pathway {
  return { ...p, payback_years: paybackYears(p.capex_usd, p.annual_savings_usd) };
}

function worstSeverity(diagnostics: Diagnostic[]): Severity {
  return diagnostics.reduce<Severity>(
    (acc, d) => (SEVERITY_RANK[d.severity] > SEVERITY_RANK[acc] ? d.severity : acc),
    "ok",
  );
}

/** Line loss fraction rises with the square of loading — a modelled I²R proxy. */
function lineLossPct(loadingPct: number): number {
  return 0.7 + 1.6 * Math.pow(loadingPct / 100, 2);
}

/**
 * Corridor throughput proxy: the larger of the two connected draws. These MVA
 * ratings size ties between load centers, so the bigger endpoint is the load
 * the tie actually carries. Under the heatwave the rating is derated.
 */
export function corridorLoadings(
  flows: PowerFlow[],
  sims: Record<string, SimResult>,
  heatwave: boolean,
): CorridorLoading[] {
  return flows.map((flow) => {
    const a = sims[flow.from]?.effective_draw_mw ?? 0;
    const b = sims[flow.to]?.effective_draw_mw ?? 0;
    const throughput = Math.max(a, b);
    const capacity = flow.mva * (heatwave ? HEATWAVE_LINE_DERATE : 1);
    const loading = capacity > 0 ? (throughput / capacity) * 100 : 0;
    return {
      id: flow.id,
      label: flow.label,
      from: flow.from,
      to: flow.to,
      mva: flow.mva,
      capacity_mva: num(capacity, 1),
      throughput_mw: num(throughput, 2),
      loading_pct: num(loading, 1),
      loss_pct: num(lineLossPct(loading), 2),
      severity: band(loading, 55, 70, 85),
    };
  });
}

function servingCorridor(
  nodeId: string,
  flows: PowerFlow[],
  sims: Record<string, SimResult>,
  heatwave: boolean,
): CorridorLoading | null {
  const touching = corridorLoadings(flows, sims, heatwave).filter(
    (c) => c.from === nodeId || c.to === nodeId,
  );
  if (touching.length === 0) return null;
  return touching.sort((x, y) => y.loading_pct - x.loading_pct)[0];
}

function voltageClass(label: string): string {
  const match = label.match(/(\d{2,3})\s*kV/);
  return match ? `${match[1]} kV` : "modeled tie";
}

// ---- phase 1: generation & primary supply ------------------------------------

function phaseGeneration(p: FacilityProperties, sim: SimResult): PhaseState {
  const mix = p.energy_profile.source_mix;
  const draw = sim.effective_draw_mw;
  const annualMWh = sim.annual_mwh;

  const renewablePct = mix.solar + mix.hydro + mix.wind;
  const fossilPct = Math.max(0, 100 - renewablePct);
  const renewableMW = (draw * renewablePct) / 100;
  const fossilMW = draw - renewableMW;
  const variablePct = mix.solar + mix.wind;
  const curtailPct = Math.max(0, variablePct - 25) * 0.25;
  const curtailMWh = (annualMWh * renewablePct * curtailPct) / 10_000;

  const bessMW = num(Math.max(0.5, draw * 0.25), 1);
  const bessCapex = money(bessMW * UNIT.bess_mw);
  const bessSavings = money(bessMW * UNIT.bess_mw_savings);

  const diagnostics: Diagnostic[] = [
    {
      id: "curtailment",
      label: "Renewable curtailment risk",
      detail:
        curtailPct > 0
          ? `${num(curtailMWh, 0).toLocaleString("en-US")} MWh/yr of solar and wind output sits behind a ${variablePct}% variable share with no dispatchable storage on site — it gets curtailed at the midday belly.`
          : `${variablePct}% of supply is variable and currently absorbed; the surplus window is thin rather than absent.`,
      severity: band(curtailPct, 1, 4, 7),
    },
    {
      id: "baseload-cliff",
      label: "Baseload cliff",
      detail: `${mix.natural_gas}% of supply is natural gas (${num((draw * mix.natural_gas) / 100, 1)} MW live). Retiring or re-rating that block strands ${num(fossilMW, 1)} MW of fossil supply the site still depends on.`,
      severity: band(mix.natural_gas, 38, 45, 52),
    },
    {
      id: "inertia",
      label: "Inertia shortfall",
      detail: `${num(renewableMW, 1)} MW of inverter-based supply against ${num(fossilMW, 1)} MW of synchronous machines — grid-forming inverters are the cheap way back to frequency response.`,
      severity: band(renewablePct, 55, 65, 75),
    },
  ];

  return {
    phase: 1,
    id: "generation",
    name: "Generation & primary supply",
    short: "Generation",
    headline: `${num(fossilPct, 0)}% fossil`,
    telemetry: [
      { label: "Live supply", value: `${num(draw, 1)} MW` },
      { label: "Fossil", value: `${num(fossilMW, 1)} MW` },
      { label: "Renewable", value: `${num(renewableMW, 1)} MW` },
      { label: "Curtailed", value: `${num(curtailMWh, 0).toLocaleString("en-US")} MWh` },
    ],
    diagnostics,
    pathways: [
      pathway({
        id: "bess",
        label: `Co-located BESS · ${num(bessMW, 1)} MW / 4 h`,
        detail:
          "Absorbs the midday surplus and discharges into the evening ramp. Shifts energy rather than abating it, so the carbon credit sits with the solar it makes dispatchable.",
        capex_usd: bessCapex,
        annual_savings_usd: bessSavings,
        co2_avoided_tons: 0,
      }),
      pathway({
        id: "grid-forming",
        label: "Synthetic-inertia inverter retrofit",
        detail:
          "Grid-forming controls on the existing inverter fleet restore frequency and voltage response without new rotating mass.",
        capex_usd: money(draw * UNIT.inverter_mw_capex),
        annual_savings_usd: money(draw * UNIT.inverter_mw_savings),
        co2_avoided_tons: 0,
      }),
    ],
    severity: "ok", // replaced below
  };
}

// ---- phase 2: high-voltage transmission --------------------------------------

function phaseTransmission(
  p: FacilityProperties,
  sim: SimResult,
  corridor: CorridorLoading | null,
): PhaseState {
  const mva = corridor?.mva ?? num(p.infrastructure.nameplate_draw_mw * 2, 0);
  const capacity = corridor?.capacity_mva ?? mva;
  const loading = corridor?.loading_pct ?? 0;
  const throughput = corridor?.throughput_mw ?? sim.effective_draw_mw;
  const lossPct = lineLossPct(loading);
  const lossMWh = (sim.annual_mwh * lossPct) / 100;
  const kV = corridor ? voltageClass(corridor.label) : "modeled tie";

  const releasedDLR = (mva * UNIT.dlr_release_pct) / 1;
  const releasedReconductor = (mva * UNIT.reconductor_release_pct) / 1;

  const diagnostics: Diagnostic[] = [
    {
      id: "thermal",
      label: "Thermal loading & sag",
      detail: `${num(loading, 1)}% of the ${num(capacity, 0)} MVA rating at 105 °F (rating derated ${Math.round((1 - HEATWAVE_LINE_DERATE) * 100)}%); ${num(throughput, 1)} MW is riding on the ${corridor?.label ?? "serving tie"}.`,
      severity: band(loading, 55, 70, 85),
    },
    {
      id: "losses",
      label: "Resistive line loss",
      detail: `${num(lossPct, 2)}% of throughput, ${num(lossMWh, 0).toLocaleString("en-US")} MWh/yr lost as heat at the current operating point.`,
      severity: band(lossPct, 1.4, 1.8, 2.2),
    },
    {
      id: "wildfire",
      label: "Wildfire ignition exposure",
      detail: sim.heatwave_active
        ? `${num(loading, 1)}% loading in a 105 °F drought window — sag, conductor slap and vegetation contact are the ignition path on this corridor.`
        : `Southern California corridor at ${num(loading, 1)}% loading; the ignition window opens when the heatwave scenario is on.`,
      severity: sim.heatwave_active
        ? band(loading, 55, 75, 90)
        : band(loading, 85, 100, 120),
    },
  ];

  return {
    phase: 2,
    id: "transmission",
    name: "High-voltage transmission",
    short: "Transmission",
    headline: `${num(loading, 0)}% loaded`,
    telemetry: [
      { label: "Serving tie", value: `${mva} MVA` },
      { label: "Voltage", value: kV },
      { label: "Loading", value: `${num(loading, 1)}%` },
      { label: "Loss", value: `${num(lossPct, 2)}%` },
    ],
    diagnostics,
    pathways: [
      pathway({
        id: "dlr",
        label: `Dynamic line rating · +${num(releasedDLR, 1)} MW headroom`,
        detail:
          "Sensors plus weather modelling release thermal headroom that the static rating leaves unused, deferring a reconductoring cycle.",
        capex_usd: money(mva * UNIT.dlr_mva_capex),
        annual_savings_usd: money(releasedDLR * UNIT.capacity_value_mw_yr),
        co2_avoided_tons: Math.round((lossMWh * 0.3 * sim.carbon_intensity) / 1000),
      }),
      pathway({
        id: "reconductor",
        label: `Composite reconductoring · +${num(releasedReconductor, 1)} MW`,
        detail:
          "Advanced composite conductor replaces the existing phase conductors in place, cutting sag and resistive loss at the same voltage.",
        capex_usd: money(mva * UNIT.reconductor_mva_capex),
        annual_savings_usd: money(releasedReconductor * UNIT.capacity_value_mw_yr),
        co2_avoided_tons: Math.round((lossMWh * 0.45 * sim.carbon_intensity) / 1000),
      }),
    ],
    severity: "ok",
  };
}

// ---- phase 3: substations & transformation -----------------------------------

function phaseSubstation(
  p: FacilityProperties,
  sim: SimResult,
  corridor: CorridorLoading | null,
): PhaseState {
  const mva = num(
    Math.max((corridor?.mva ?? 0) * 1.15, p.infrastructure.nameplate_draw_mw * 2),
    1,
  );
  const banks = Math.max(1, Math.ceil(mva / 120));
  const ratingPct = mva > 0 ? (sim.effective_draw_mw / mva) * 100 : 0;
  const age = p.infrastructure.age_years;
  const remaining = TRANSFORMER_DESIGN_LIFE - age;
  const dga = Math.round(
    clamp(100 - Math.max(0, age - 25) * 1.1 - Math.max(0, ratingPct - 75) * 0.35, 5, 99),
  );
  const oilC = num(52 + ratingPct * 0.42 + (sim.heatwave_active ? 12 : 0), 1);

  const diagnostics: Diagnostic[] = [
    {
      id: "design-life",
      label: "Past 35-year design life",
      detail:
        remaining < 0
          ? `${age} years in service, ${Math.abs(remaining)} years past the ${TRANSFORMER_DESIGN_LIFE}-yr design life. Failure risk now rises faster than maintenance spend.`
          : `${age} years in service, ${remaining} years of design life left.`,
      severity:
        remaining < -10
          ? "critical"
          : remaining < 0
            ? "high"
            : remaining < 7
              ? "watch"
              : "ok",
    },
    {
      id: "dga",
      label: "DGA health score",
      detail: `${dga}/100 from dissolved-gas trend, age and thermal duty — ${
        dga < 45
          ? "multiple fault gases indicate incipient winding distress."
          : dga < 70
            ? "watch the acetylene and ethylene channels each quarter."
            : "clean gas signature at the current load."
      }`,
      severity: dga < 45 ? "critical" : dga < 60 ? "high" : dga < 75 ? "watch" : "ok",
    },
    {
      id: "oil-temp",
      label: "Top-oil temperature",
      detail: `${num(oilC, 1)} °C estimated at ${num(ratingPct, 0)}% of the ${num(mva, 0)} MVA bank${banks > 1 ? "s" : ""}${sim.heatwave_active ? ", including the 105 °F ambient lift" : ""}.`,
      severity: band(oilC, 85, 95, 105),
    },
    {
      id: "lead-time",
      label: `${LPT_LEAD_TIME_WEEKS}-week replacement lead time`,
      detail: `A failed ${num(mva, 0)} MVA unit cannot be replaced inside a quarter — long-lead spares and monitoring are the only mitigation that fits the supply chain.`,
      severity: age > 35 ? "high" : "watch",
    },
  ];

  return {
    phase: 3,
    id: "substation",
    name: "Substations & transformation",
    short: "Substation",
    headline: `DGA ${dga}`,
    telemetry: [
      { label: "Banks", value: `${banks} · ${num(mva, 0)} MVA` },
      { label: "Rating used", value: `${num(ratingPct, 0)}%` },
      { label: "Age", value: `${age} yr` },
      { label: "Top oil", value: `${num(oilC, 0)} °C` },
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
          "Skid-mounted transformer, breaker and busbar modules replace the vintage bank with a shorter build and a smaller footprint.",
        capex_usd: money(mva * UNIT.substation_mva_capex),
        annual_savings_usd: money(mva * UNIT.substation_mva_savings),
        co2_avoided_tons: 0,
      }),
    ],
    severity: "ok",
  };
}

// ---- phase 4: distribution networks -----------------------------------------

function phaseDistribution(p: FacilityProperties, sim: SimResult): PhaseState {
  const draw = sim.effective_draw_mw;
  const feeders = Math.max(2, Math.ceil(draw / 8));
  const feederCapacity = feeders * 12;
  const loading = feederCapacity > 0 ? (draw / feederCapacity) * 100 : 0;
  const age = p.infrastructure.age_years;
  const saidi = num(96 + age * 0.85 + Math.max(0, loading - 70) * 2.2, 0);
  const saifi = num(1.2 + age * 0.012 + Math.max(0, loading - 70) * 0.03, 2);
  const imbalance = num(Math.max(0, 0.85 - p.infrastructure.motor_efficiency_rating) * 62, 1);

  const diagnostics: Diagnostic[] = [
    {
      id: "feeder-loading",
      label: "Feeder overload",
      detail: `${num(draw, 1)} MW over ${feeders} feeders rated ${feederCapacity} MVA total — ${num(loading, 1)}% loaded${loading > 100 ? ", past the emergency rating" : ""}.`,
      severity: band(loading, 70, 85, 100),
    },
    {
      id: "reliability",
      label: "SAIDI / SAIFI reliability",
      detail: `${num(saidi, 0)} customer-minutes and ${num(saifi, 2)} interruptions per year, modelled from feeder age and loading.`,
      severity: band(saidi, 120, 150, 180),
    },
    {
      id: "radial",
      label: "Single point of failure",
      detail: `Radial topology: one open feeder or blown cutout drops the whole load block until a crew arrives. No automated tie switch exists on this run.`,
      severity: "watch",
    },
    {
      id: "imbalance",
      label: "Phase imbalance",
      detail: `${num(imbalance, 1)}% modelled current unbalance from the motor load mix — neutral current and transformer heating follow it.`,
      severity: band(imbalance, 4, 7, 10),
    },
  ];

  return {
    phase: 4,
    id: "distribution",
    name: "Distribution networks",
    short: "Distribution",
    headline: `${num(loading, 0)}% feeder`,
    telemetry: [
      { label: "Feeders", value: `${feeders}` },
      { label: "Feeder load", value: `${num(loading, 0)}%` },
      { label: "SAIDI", value: `${num(saidi, 0)} min` },
      { label: "SAIFI", value: `${num(saifi, 2)}` },
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
          "Replace the overloaded pole and pad units with the correct kVA class so the feeder stops carrying transformer losses and heat.",
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
  const solarShare = p.energy_profile.source_mix.solar;
  // Same evening-bell shape as the telemetry curve: trough overnight, ramp to a
  // 4 pm peak, which is the duck-curve mechanism in one line.
  const peak = draw;
  const trough = draw * 0.72;
  const rampMW = num(peak - trough, 2);
  const rampPct = num((rampMW / (peak || 1)) * 100, 1);
  const nameplate = p.infrastructure.nameplate_draw_mw;
  const derShare = solarShare;

  const diagnostics: Diagnostic[] = [
    {
      id: "duck-curve",
      label: "Evening duck-curve ramp",
      detail: `${num(rampMW, 1)} MW must arrive inside four hours (${num(rampPct, 1)}% of peak) while ${derShare}% of supply is behind-meter solar that is fading.`,
      severity: derShare >= 30 ? "high" : "watch",
    },
    {
      id: "load-shock",
      label: "Multi-megawatt load shock",
      detail: `A single process start, fleet charge or cooling pull moves ${num(nameplate, 1)} MW at nameplate — a swing the local feeder sees as one step.`,
      severity: band(nameplate, 10, 20, 30),
    },
    {
      id: "der",
      label: "DER penetration without dispatch",
      detail:
        derShare >= 30
          ? `${derShare}% of delivered kWh is modelled behind-meter solar with no dispatchable battery, so the site cannot shape its own net load.`
          : `${derShare}% behind-meter solar; the site still leans on the grid for the evening peak.`,
      severity: band(derShare, 30, 38, 45),
    },
  ];

  return {
    phase: 5,
    id: "behind-meter",
    name: "Behind-the-meter consumption",
    short: "Load",
    headline: `${num(rampPct, 0)}% ramp`,
    telemetry: [
      { label: "Peak draw", value: `${num(peak, 1)} MW` },
      { label: "Evening ramp", value: `${num(rampMW, 1)} MW` },
      { label: "Solar share", value: `${derShare}%` },
      { label: "Homes eq.", value: `${Math.round(sim.annual_mwh / MWH_PER_HOME).toLocaleString("en-US")}` },
    ],
    diagnostics,
    pathways: [
      pathway({
        id: "vpp",
        label: "Virtual power plant aggregation",
        detail:
          "Bundle the site's flexible cells, pumps and batteries into one dispatchable block that the utility can call instead of a peaker.",
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

function phaseMarket(
  p: FacilityProperties,
  sim: SimResult,
  corridor: CorridorLoading | null,
): PhaseState {
  const ci = sim.carbon_intensity;
  const loading = corridor?.loading_pct ?? 0;
  const congestion = Math.max(0, loading - 70) * 0.6;
  const lmp = num(
    34 + clamp((ci - 250) * 0.11, 0, 26) + (sim.heatwave_active ? 9 : 0) + congestion,
    1,
  );
  const nameplate = p.infrastructure.nameplate_draw_mw;
  const spareMW = Math.max(0, nameplate - sim.effective_draw_mw);
  const reservePct = nameplate > 0 ? num((spareMW / nameplate) * 100, 1) : 0;
  const curtailableMW = num(sim.effective_draw_mw * 0.12, 1);
  const arbitrageMW = num(Math.max(0.5, sim.effective_draw_mw * 0.1), 1);

  const diagnostics: Diagnostic[] = [
    {
      id: "congestion",
      label: "Transmission congestion premium",
      detail: `${num(loading, 1)}% corridor loading adds $${num(congestion, 2)}/MWh to the ${p.energy_profile.grid_zone} nodal price; the site pays it on every megawatt-hour.`,
      severity: band(loading, 55, 70, 85),
    },
    {
      id: "reserve",
      label: "Peaker reserve depletion",
      detail: sim.heatwave_active
        ? `${num(spareMW, 1)} MW of local headroom (${reservePct}%) while the 45% draw surge pulls fossil peakers online at the worst carbon intensity of the day.`
        : `${num(spareMW, 1)} MW of local headroom (${reservePct}%) before the site itself is the constraint.`,
      severity: sim.heatwave_active ? (sim.overload ? "critical" : "watch") : "ok",
    },
    {
      id: "price",
      label: "Wholesale price exposure",
      detail: `$${num(lmp, 2)}/MWh modelled locational marginal price against ${num(sim.annual_mwh, 0).toLocaleString("en-US")} MWh/yr of consumption.`,
      severity: band(lmp, 50, 60, 80),
    },
  ];

  return {
    phase: 6,
    id: "market",
    name: "Market operations & dispatch",
    short: "Market",
    headline: `$${num(lmp, 0)}/MWh`,
    telemetry: [
      { label: "LMP", value: `$${num(lmp, 2)}` },
      { label: "Congestion", value: `+$${num(congestion, 2)}` },
      { label: "Reserve", value: `${reservePct}%` },
      { label: "Zone", value: p.energy_profile.grid_zone },
    ],
    diagnostics,
    pathways: [
      pathway({
        id: "demand-response",
        label: `Automated demand response · ${num(curtailableMW, 1)} MW`,
        detail:
          "Curtail the flexible block on a price or reserve signal instead of buying the peak; dispatch is automated, not a phone call.",
        capex_usd: money(curtailableMW * UNIT.dr_mw_capex),
        annual_savings_usd: money(curtailableMW * UNIT.dr_mw_savings),
        co2_avoided_tons: Math.round((sim.annual_mwh * 0.025 * sim.carbon_intensity) / 1000),
      }),
      pathway({
        id: "arbitrage",
        label: `BESS price arbitrage · ${num(arbitrageMW, 1)} MW`,
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
  const corridor = servingCorridor(
    properties.id,
    ctx.flows,
    ctx.sims,
    sim.heatwave_active,
  );

  const states = [
    phaseGeneration(properties, sim),
    phaseTransmission(properties, sim, corridor),
    phaseSubstation(properties, sim, corridor),
    phaseDistribution(properties, sim),
    phaseBehindMeter(properties, sim),
    phaseMarket(properties, sim, corridor),
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
      at_risk_mw: num(atRiskMW, 1),
      share_pct: 0, // filled below
      capex_usd: money(capex),
      annual_savings_usd: money(savings),
      payback_years: paybackYears(capex, savings),
    });
  }

  const maxRisk = Math.max(1, ...rows.map((row) => row.at_risk_mw));
  return rows.map((row) => ({
    ...row,
    share_pct: Math.round((row.at_risk_mw / maxRisk) * 100),
  }));
}
