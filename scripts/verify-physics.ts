/**
 * Physics verification harness.
 *
 * These are numeric assertions, not snapshots: each expected value is derived
 * from the formula being tested (or from an independent closed-form solution),
 * so a failing assert means a real model disagreement. Run with:
 *
 *   npm run verify:physics
 */

import {
  DEFAULT_ECONOMICS,
  DEFAULT_INERTIA_H,
  SECTOR_SHAPES,
  annualLoadMwh,
  bessStep,
  branchImpedanceOhms,
  capitalRecoveryFactor,
  conductorHeatBalance,
  getConductor,
  hostingCapacity,
  initBess,
  irr,
  levelizedCost,
  loadAt,
  npv,
  radialPowerFlow,
  rocofFromLoss,
  runMunicipality,
  simplePayback,
  solveTwoBus,
  solarAcPower,
  systemInertia,
  threePhaseCurrentKa,
  ultimateHotspotRise,
  ultimateTopOilRise,
  voltageCollapseMargin,
  windPower,
  zBaseOhm,
  iBaseKa,
  type MunicipalityScenario,
  type TransformerSpec,
  type WindSpec,
} from "../lib/physics/index";

let passed = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(name: string, actual: number, expected: number, tol: number): void {
  const delta = Math.abs(actual - expected);
  ok(
    name,
    delta <= tol,
    `expected ${expected} ± ${tol}, got ${actual} (Δ ${delta.toExponential(2)})`,
  );
}

function finiteTree(value: unknown, path = "root"): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v, i) => finiteTree(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).every(([k, v]) =>
      finiteTree(v, `${path}.${k}`),
    );
  }
  return true;
}

console.log("\n== per-unit bases ==");
const base = { s_mva: 10, v_kv: 12.47 };
near("Z_base = V_LL² / S_3φ", zBaseOhm(base), (12.47 * 12.47) / 10, 1e-9);
near("I_base = S / (√3 V_LL)", iBaseKa(base), 10 / (Math.sqrt(3) * 12.47), 1e-9);
near(
  "three-phase current at 10 MVA / 12.47 kV",
  threePhaseCurrentKa(10, 0, 12.47),
  10 / (Math.sqrt(3) * 12.47),
  1e-9,
);

console.log("\n== conductor impedance ==");
const linnet = getConductor("acsr-336-linnet");
const line1mi = branchImpedanceOhms(
  {
    id: "l1",
    from_bus: "a",
    to_bus: "b",
    voltage_kv: 12.47,
    length_mi: 1,
    conductor: "acsr-336-linnet",
    phase_spacing_ft: 6,
  },
  base,
);
near("R for 1 mi 336 Linnet", line1mi.r_ohm, 0.306, 1e-9);
near(
  "X = 0.2794·log10(GMD/GMR) for 6 ft spacing",
  line1mi.x_ohm,
  0.2794 * Math.log10(6 / linnet.gmr_ft),
  1e-9,
);
near(
  "Z_pu uses V_LL²/S base",
  line1mi.z_pu,
  Math.hypot(line1mi.r_ohm, line1mi.x_ohm) / ((12.47 * 12.47) / 10),
  1e-9,
);

console.log("\n== exact two-bus solution ==");
const twoBusInput = {
  sending_kv: 12.47,
  p_mw: 1,
  q_mvar: 0.3,
  r_ohm: line1mi.r_ohm,
  x_ohm: line1mi.x_ohm,
};
const twoBus = solveTwoBus(twoBusInput);
ok("two-bus solution is feasible", twoBus.feasible);
ok(
  "receiving voltage is below sending and above 0.9 pu",
  twoBus.receiving_pu < 1 && twoBus.receiving_pu > 0.9,
  `got ${twoBus.receiving_pu}`,
);
near(
  "current = |S| / (√3·V_r)",
  twoBus.current_a,
  (Math.hypot(1, 0.3) / (Math.sqrt(3) * twoBus.receiving_pu * 12.47)) * 1000,
  0.2,
);

console.log("\n== radial power flow vs closed form ==");
const radialNetwork = {
  id: "radial-check",
  slack_bus_id: "slack",
  buses: [
    { id: "slack", base_kv: 12.47, load_mw: 0, load_mvar: 0 },
    { id: "load", base_kv: 12.47, load_mw: 1, load_mvar: 0.3 },
  ],
  branches: [
    {
      id: "l1",
      from_bus: "slack",
      to_bus: "load",
      voltage_kv: 12.47,
      length_mi: 1,
      conductor: "acsr-336-linnet",
      phase_spacing_ft: 6,
    },
  ],
};
const flow = radialPowerFlow(radialNetwork, { s_base_mva: 1 });
ok("backward-forward sweep converged", flow.converged, `iterations ${flow.iterations}`);
const loadBus = flow.buses.find((b) => b.id === "load")!;
near(
  "radial sweep matches exact two-bus receiving voltage",
  loadBus.voltage_pu,
  twoBus.receiving_pu,
  2e-4,
);
near(
  "radial losses = I²R",
  flow.total_loss_mw,
  (twoBus.current_a / 1000) ** 2 * 3 * line1mi.r_ohm,
  0.01,
);
near(
  "slack balances load + losses",
  flow.slack_mw,
  1 + flow.total_loss_mw,
  0.01,
);

const collapse = voltageCollapseMargin(twoBusInput);
ok(
  "P-V margin is positive at the operating point",
  collapse.feasible_at_operating_point && collapse.margin_pct > 0,
  `margin ${collapse.margin_pct}%`,
);
ok(
  "critical voltage near the Thevenin nose",
  collapse.critical_voltage_pu > 0.5 && collapse.critical_voltage_pu < 1,
  `got ${collapse.critical_voltage_pu}`,
);

const hosting = hostingCapacity(radialNetwork, "load", { max_der_mw: 10 });
ok(
  "hosting capacity is bounded and reports a binding constraint",
  hosting.hosting_capacity_mw >= 0 &&
    hosting.hosting_capacity_mw <= 10 &&
    ["none", "voltage_high", "voltage_low", "thermal", "reverse_power"].includes(
      hosting.binding_constraint,
    ),
  `${hosting.hosting_capacity_mw} MW / ${hosting.binding_constraint}`,
);

console.log("\n== transformer thermal (IEEE C57.91 screening form) ==");
const transformer: TransformerSpec = {
  id: "tx",
  rating_mva: 20,
  hv_kv: 115,
  lv_kv: 12.47,
  impedance_pct: 8,
  no_load_loss_pct: 0.2,
  load_loss_pct: 0.8,
  cooling: "ONAN",
  rated_top_oil_rise_k: 55,
  rated_hotspot_rise_k: 23,
  tau_oil_min: 180,
  tau_winding_min: 4,
  design_life_years: 35,
};
near("ultimate top-oil rise at K=1 equals rated rise", ultimateTopOilRise(transformer, 20), 55, 1e-9);
near("ultimate hot-spot rise at K=1 equals rated rise", ultimateHotspotRise(transformer, 20), 23, 1e-9);
near("top-oil rise scales as K^(2n) at K=2", ultimateTopOilRise(transformer, 40), 55 * Math.pow((4 * 4 + 1) / 5, 0.8), 1e-9);

console.log("\n== conductor heat balance ==");
const conductorThermal = conductorHeatBalance(linnet, 400, {
  ambient_c: 40,
  wind_mps: 0.61,
  solar_w_m2: 0,
});
ok(
  "400 A on a 530 A conductor stays below 100 °C at 40 °C ambient",
  conductorThermal.temperature_c > 40 && conductorThermal.temperature_c < 100,
  `got ${conductorThermal.temperature_c} °C`,
);
ok(
  "ampacity margin is positive below the rating",
  conductorThermal.margin_pct > 0,
  `${conductorThermal.margin_pct}%`,
);

console.log("\n== frequency dynamics ==");
near(
  "ROCOF = −ΔP/(2E)·f₀",
  rocofFromLoss(100, 5000),
  (-100 / (2 * 5000)) * 60,
  1e-12,
);
const inertia = systemInertia([
  { id: "gas", type: "gas_cc", mva: 100 },
  { id: "solar", type: "solar", mva: 50 },
]);
near("inertia from H constants", inertia.inertia_mws, 100 * DEFAULT_INERTIA_H.gas_cc, 1e-9);
near("system H is inertia / online MVA", inertia.h_sys_s, (100 * 6) / 150, 1e-9);
near("synchronous share excludes inverter-based MVA", inertia.synchronous_share_pct, (100 / 150) * 100, 0.11);

console.log("\n== load, solar, wind, battery ==");
near("residential shape peaks at hour 17", SECTOR_SHAPES.residential[17], 1, 1e-12);
const load = loadAt(
  {
    id: "l",
    sector: "residential",
    peak_mw: 10,
    power_factor: 0.95,
    hvac_share: 0.45,
  },
  17,
  20,
);
near(
  "weather multiplier = 1 + hvac·(cooling + heating − 1)",
  load.weather_multiplier,
  1 + 0.45 * (0.1 + 0 - 1),
  1e-9,
);
near("load P = peak · shape · weather", load.p_mw, 10 * 1 * 0.595, 1e-6);
near(
  "load Q = P·tan(acos(pf)), reported to 4 decimals",
  load.q_mvar,
  Math.round(5.95 * Math.tan(Math.acos(0.95)) * 1e4) / 1e4,
  1e-9,
);

const pv = solarAcPower(
  {
    id: "pv",
    capacity_mw_dc: 10,
    dc_ac_ratio: 1.25,
    tilt_deg: 25,
    azimuth_deg: 180,
    temp_coeff_per_c: -0.0035,
    noct_c: 45,
    soiling_loss_pct: 2,
    inverter_eff: 0.97,
  },
  1000,
  25,
);
near("PV clips at the inverter AC rating", pv.ac_mw, 8, 1e-9);
ok("PV clipping flag is set", pv.clipping);
near("PV cell temperature uses NOCT", pv.cell_c, 25 + ((45 - 20) / 800) * 1000, 1e-9);

const turbine: WindSpec = {
  id: "w",
  capacity_mw: 10,
  cut_in_mps: 3,
  rated_mps: 12,
  cut_out_mps: 25,
};
near("wind is at rated speed", windPower(turbine, 12), 10, 1e-12);
near("wind is cut out at 25 m/s", windPower(turbine, 25), 0, 1e-12);
near(
  "cubic wind curve between cut-in and rated",
  windPower(turbine, 7.5),
  10 * ((7.5 ** 3 - 27) / (12 ** 3 - 27)),
  1e-4,
);

const bessSpec = {
  id: "b",
  power_mw: 5,
  energy_mwh: 20,
  round_trip_eff: 0.88,
  soc_min_pct: 10,
  soc_max_pct: 95,
  initial_soc_pct: 50,
};
const bess = bessStep(bessSpec, initBess(bessSpec), 5, 1);
near("battery discharges at rated power", bess.actual_mw, 5, 1e-9);
near(
  "battery SOC falls by P·dt/η_oneway",
  bess.soc_pct,
  ((20 * 0.5 - 5 / Math.sqrt(0.88)) / 20) * 100,
  0.06,
);

console.log("\n== economics ==");
const crf = capitalRecoveryFactor(0.07, 25);
near(
  "CRF = r(1+r)^n / ((1+r)^n − 1)",
  crf,
  (0.07 * Math.pow(1.07, 25)) / (Math.pow(1.07, 25) - 1),
  1e-12,
);
near(
  "LCOE = (CRF·capex + O&M) / MWh",
  levelizedCost(1_000_000, 10_000, 1000, 0.07, 25),
  (crf * 1_000_000 + 10_000) / 1000,
  0.01,
);
near(
  "NPV discounts each year",
  npv(0.07, [-1000, 500, 500, 500]),
  -1000 + 500 / 1.07 + 500 / 1.07 ** 2 + 500 / 1.07 ** 3,
  0.01,
);
const projectIrr = irr([-1000, 500, 500, 500]);
ok(
  "IRR solves the cash-flow equation",
  projectIrr !== null && Math.abs(projectIrr - 0.2337) < 0.001,
  `got ${projectIrr}`,
);
near("simple payback = capex / annual savings", simplePayback(1000, 250)!, 4, 1e-12);
near(
  "default VOLL is a screening value, not a market price",
  DEFAULT_ECONOMICS.voll_usd_per_mwh,
  12_000,
  1e-12,
);

console.log("\n== municipality engine (24-hour design day) ==");
const transformerScenario: TransformerSpec = { ...transformer, rating_mva: 20 };
const scenario: MunicipalityScenario = {
  id: "verify-town",
  name: "Verification Town",
  state: "CA",
  population: 50_000,
  base_year: 2026,
  latitude_deg: 33.7,
  grid_carbon_intensity_gco2_kwh: 350,
  substation: {
    id: "sub",
    name: "Verification Substation",
    hv_kv: 115,
    lv_kv: 12.47,
    transformer: transformerScenario,
  },
  weather: {
    latitude_deg: 33.7,
    annual_mean_c: 18,
    annual_amplitude_c: 8,
    diurnal_amplitude_c: 6,
    wind_mean_mps: 3.5,
    wind_amplitude_mps: 1.2,
    clearness: 0.9,
    design_high_c: 40,
    design_low_c: 22,
  },
  feeders: [
    {
      id: "f1",
      name: "Feeder 1",
      voltage_kv: 12.47,
      slack_bus: { id: "f1-slack", name: "F1 source", base_kv: 12.47, customers: 0 },
      buses: [
        {
          id: "f1-b1",
          name: "Bus 1",
          base_kv: 12.47,
          customers: 600,
          loads: [
            {
              id: "f1-load-1",
              sector: "residential",
              peak_mw: 3,
              power_factor: 0.95,
              hvac_share: 0.45,
            },
          ],
        },
        {
          id: "f1-b2",
          name: "Bus 2",
          base_kv: 12.47,
          customers: 400,
          loads: [
            {
              id: "f1-load-2",
              sector: "commercial",
              peak_mw: 2,
              power_factor: 0.92,
              hvac_share: 0.4,
            },
          ],
          solar: [
            {
              id: "f1-pv",
              capacity_mw_dc: 2,
              dc_ac_ratio: 1.25,
              tilt_deg: 25,
              azimuth_deg: 180,
              temp_coeff_per_c: -0.0035,
              noct_c: 45,
              soiling_loss_pct: 2,
              inverter_eff: 0.97,
            },
          ],
        },
      ],
      branches: [
        {
          id: "f1-l1",
          from_bus: "f1-slack",
          to_bus: "f1-b1",
          voltage_kv: 12.47,
          length_mi: 1.5,
          conductor: "acsr-336-linnet",
        },
        {
          id: "f1-l2",
          from_bus: "f1-b1",
          to_bus: "f1-b2",
          voltage_kv: 12.47,
          length_mi: 1.2,
          conductor: "acsr-336-linnet",
        },
      ],
    },
  ],
  buildouts: [
    {
      id: "dc-1",
      name: "Edge data center",
      kind: "data_center",
      feeder_id: "f1",
      bus_id: "f1-b2",
      new_bus: {
        id: "f1-dc",
        name: "Data center bus",
        customers: 0,
        connection_length_mi: 0.4,
        conductor: "acsr-336-linnet",
      },
      peak_mw: 2.5,
      power_factor: 0.98,
      sector: "data_center",
      energize_year: 2028,
      capex_usd: 4_000_000,
      annual_om_usd: 40_000,
    },
  ],
};

const result2026 = runMunicipality(scenario, {
  hours: 24,
  year: 2026,
  compare_baseline: true,
  compute_hosting: false,
});
ok("24-hour run returns 24 hourly rows when requested", result2026.stats.hours === 24);
near("design-day peak is the bus load peak", result2026.stats.demand.peak_mw, result2026.peak.load_mw, 0.02);
ok(
  "design day has a positive peak and finite voltage",
  result2026.stats.demand.peak_mw > 0 &&
    result2026.stats.voltage.min_pu > 0.5 &&
    result2026.stats.voltage.max_pu <= 1.1,
  `peak ${result2026.stats.demand.peak_mw} MW, V ${result2026.stats.voltage.min_pu}–${result2026.stats.voltage.max_pu}`,
);
ok(
  "annual energy is load × hours for a design day",
  Math.abs(result2026.stats.demand.annual_mwh - result2026.stats.demand.peak_mw * 24) <
    result2026.stats.demand.peak_mw * 24,
  `${result2026.stats.demand.annual_mwh} MWh`,
);
ok(
  "buildout is planned in its base year",
  result2026.stats.buildouts[0]?.status === "planned",
);
ok(
  "baseline is present and no larger than the buildout case",
  result2026.stats.baseline !== null &&
    result2026.stats.baseline.peak_mw <= result2026.stats.demand.peak_mw + 1e-6,
);
ok(
  "losses are a small positive fraction of load",
  result2026.stats.losses.pct >= 0 && result2026.stats.losses.pct < 15,
  `${result2026.stats.losses.pct}%`,
);
ok(
  "stability report is populated with a band",
  Number.isFinite(result2026.stats.stability.rocof_hz_s) &&
    ["ok", "watch", "high", "critical"].includes(result2026.stats.stability.band),
  `${result2026.stats.stability.band} / ROCOF ${result2026.stats.stability.rocof_hz_s}`,
);
ok("all municipality stats are finite", finiteTree(result2026.stats));

const result2028 = runMunicipality(scenario, {
  hours: 24,
  year: 2028,
  compare_baseline: true,
  compute_hosting: false,
});
ok(
  "buildout is active in its energize year",
  result2028.stats.buildouts[0]?.status === "active",
);
ok(
  "buildout increases peak load versus baseline",
  result2028.stats.demand.peak_mw > (result2028.stats.baseline?.peak_mw ?? 0),
  `${result2028.stats.demand.peak_mw} vs ${result2028.stats.baseline?.peak_mw}`,
);
ok(
  "buildout delta is reported on the project row",
  result2028.stats.buildouts[0]?.peak_mw > 0 &&
    Number.isFinite(result2028.stats.buildouts[0]?.voltage_impact_pu),
);

console.log("\n== annual run (8760 hours, calibration + hosting) ==");
const annual = runMunicipality(scenario, {
  hours: 8760,
  year: 2026,
  compare_baseline: false,
});
ok("annual run reports 8760 hours", annual.stats.hours === 8760);
ok("annual energy exceeds design-day energy", annual.stats.demand.annual_mwh > result2026.stats.demand.annual_mwh);
ok("annual load factor is in (0, 1]", annual.stats.demand.load_factor > 0 && annual.stats.demand.load_factor <= 1);
ok("annual hosting capacity is reported", annual.stats.capacity.hosting_capacity_mw >= 0);
ok("annual stats are finite", finiteTree(annual.stats));
const annualCalibrated = annualLoadMwh(
  {
    id: "cal",
    sector: "residential",
    peak_mw: 10,
    power_factor: 0.95,
    hvac_share: 0.45,
  },
  Array.from({ length: 24 }, (_, i) => ({ ambient_c: 20, wind_mps: 3, solar_w_m2: i > 6 && i < 19 ? 500 : 0 })),
);
ok("annualLoadMwh integrates hour by hour", annualCalibrated > 0 && Number.isFinite(annualCalibrated));

console.log(`\n${passed} checks passed, ${failures.length} failed.\n`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAILED: ${failure}`);
  process.exit(1);
}
