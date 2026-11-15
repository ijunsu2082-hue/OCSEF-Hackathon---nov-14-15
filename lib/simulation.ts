import type { FacilityProperties, SimResult } from "./types";

const HW = { util: 1.35, utilCap: 105, draw: 1.45, ci: 1.25 };
const SOLAR_CAPACITY_FACTOR = 0.28; // Southern California utility-scale
const HOURS = 24;
const DAYS = 365;
const CO2_DIVISOR = 1_000_000;
const MWH_PER_HOME = 10.5;

function round(v: number, digits = 2): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

export interface SimulationOptions {
  heatwave_active?: boolean;
  added_solar_mw?: number;
  vfd_retrofit?: boolean;
}

/**
 * Pure electrical operating model. Every displayed number flows through here.
 *
 * Two traps this code exists to avoid:
 *  - dailyMWh is daily and gets ×365; annualMWh and postMWh are already annual.
 *  - baseline_draw_mw is display-only (nameplate × utilization). The math starts
 *    from nameplate_draw_mw and applies loadRatio, never baseline × utilization.
 */
export function simulate(
  properties: FacilityProperties,
  options: SimulationOptions = {},
): SimResult {
  const heatwave = options.heatwave_active ?? false;
  const solarMW = Math.max(0, options.added_solar_mw ?? 0);
  const vfd = options.vfd_retrofit ?? false;

  const infra = properties.infrastructure;
  const energy = properties.energy_profile;
  const upgrade = properties.upgrade_potential;

  const nameplate = infra.nameplate_draw_mw;
  const utilization = infra.utilization_pct;
  const baseCI = energy.carbon_intensity_gco2_kwh;

  // 1. stress-adjusted operating point
  const stressedUtil = heatwave
    ? Math.min(utilization * HW.util, HW.utilCap)
    : utilization;
  const loadRatio = stressedUtil / 100;
  const overload = heatwave && utilization * HW.util > 100;
  // Baseline draw is the frozen nameplate × utilization value. Using it for the
  // un-stressed case keeps the panel, the region totals and README §4.4 in
  // agreement instead of drifting by the seed's rounding of utilization.
  const effectiveDraw = heatwave
    ? nameplate * loadRatio * HW.draw
    : energy.baseline_draw_mw;
  const carbonIntensity = baseCI * (heatwave ? HW.ci : 1);

  // 2. energy + carbon
  const dailyMWh = effectiveDraw * HOURS;
  const annualMWh = dailyMWh * DAYS;
  const annualCO2Tons = (dailyMWh * 1000 * carbonIntensity * DAYS) / CO2_DIVISOR;
  const baselineCO2Tons =
    (energy.baseline_draw_mw * HOURS * 1000 * baseCI * DAYS) / CO2_DIVISOR;

  // 3. upgrades
  const postDraw = effectiveDraw * (1 - (vfd ? upgrade.efficiency_gain_pct / 100 : 0));
  const gridOffset = Math.min(postDraw, solarMW * SOLAR_CAPACITY_FACTOR);
  const postMWh = annualMWh * (postDraw > 0 ? (postDraw - gridOffset) / postDraw : 0);
  const postCO2 = (postMWh * 1000 * carbonIntensity) / CO2_DIVISOR;
  const co2Avoided = annualCO2Tons - postCO2;
  const capex =
    solarMW * upgrade.solar_capex_per_mw_usd + (vfd ? upgrade.vfd_capex_usd : 0);
  const savings =
    solarMW * upgrade.solar_savings_per_mw_usd + (vfd ? upgrade.vfd_savings_usd : 0);
  const payback = savings > 0 ? capex / savings : null;

  // 4. homes equivalent
  const homesEquivalent = Math.round(annualMWh / MWH_PER_HOME);

  return {
    node_id: properties.id,
    heatwave_active: heatwave,
    nameplate_mw: nameplate,
    utilization_pct: utilization,
    load_ratio: round(loadRatio, 4),
    overload,
    effective_draw_mw: round(effectiveDraw, 3),
    daily_mwh: round(dailyMWh, 1),
    annual_mwh: round(annualMWh, 0),
    carbon_intensity: round(carbonIntensity, 1),
    annual_co2_tons: round(annualCO2Tons, 1),
    baseline_annual_co2_tons: round(baselineCO2Tons, 1),
    co2_delta_tons: round(annualCO2Tons - baselineCO2Tons, 1),
    homes_equivalent: homesEquivalent,
    upgraded:
      solarMW > 0 || vfd
        ? {
            draw_mw: round(postDraw, 3),
            solar_mw: round(solarMW, 2),
            grid_offset_mw: round(gridOffset, 3),
            annual_co2_tons: round(postCO2, 1),
            co2_avoided_tons: round(co2Avoided, 1),
            capex_usd: Math.round(capex),
            annual_savings_usd: Math.round(savings),
            payback_years: payback === null ? null : round(payback, 2),
          }
        : null,
    risk_score: 0,
  };
}

/**
 * Modelled 24-hour draw shape: overnight trough, morning shoulder, 4 pm peak.
 * One source of truth for the telemetry curve and the behind-the-meter phase.
 */
export function dailyProfile(sim: SimResult): number[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const evening = Math.exp(-Math.pow((hour - 16) / 4.2, 2));
    const morning = 0.5 * Math.exp(-Math.pow((hour - 8) / 3, 2));
    return sim.effective_draw_mw * (0.72 + 0.28 * evening + 0.16 * morning);
  });
}

/** Cumulative net cash position per year, starting at −capex. */
export function paybackCurve(sim: SimResult, years = 15): { year: number; net: number }[] {
  const up = sim.upgraded;
  if (!up) return [];
  const points: { year: number; net: number }[] = [];
  for (let y = 0; y <= years; y += 1) {
    points.push({ year: y, net: Math.round(-up.capex_usd + up.annual_savings_usd * y) });
  }
  return points;
}
