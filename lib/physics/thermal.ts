/**
 * Thermal physics: IEEE C57.91-style transformer hot-spot and insulation
 * aging, plus a steady-state conductor heat balance for line rating and sag
 * screening.
 *
 * The transformer model is the screening form of IEEE C57.91 clause 7:
 * exponential top-oil rise and a winding hot-spot rise that follows K^(2m).
 * It is accurate enough to rank assets and to show a loss-of-life curve; it is
 * not a replacement for the manufacturer's thermal duplicate or a DGA trend.
 */

import {
  SIGMA_SB,
  cToK,
  clamp,
  roundTo,
} from "./units";
import type { ConductorSpec } from "./network";

export type CoolingClass = "ONAN" | "ONAF" | "OFAF" | "ODAF";

export interface TransformerSpec {
  id: string;
  rating_mva: number;
  hv_kv: number;
  lv_kv: number;
  /** Short-circuit impedance, percent on rating. */
  impedance_pct: number;
  /** No-load loss, percent of rating. */
  no_load_loss_pct: number;
  /** Load loss at rated current, percent of rating. */
  load_loss_pct: number;
  cooling: CoolingClass;
  /** Rated top-oil rise over ambient, K. */
  rated_top_oil_rise_k: number;
  /** Rated hot-spot rise over top oil, K. */
  rated_hotspot_rise_k: number;
  /** Top-oil thermal time constant, minutes. */
  tau_oil_min: number;
  /** Winding hot-spot time constant, minutes. */
  tau_winding_min: number;
  design_life_years: number;
}

export interface TransformerState {
  top_oil_c: number;
  hotspot_c: number;
  /** Equivalent years of 110 °C aging consumed so far. */
  equivalent_aging_years: number;
  load_mva: number;
  loading_pct: number;
  aging_factor: number;
}

export const TRANSFORMER_DEFAULTS: Omit<TransformerSpec, "id" | "rating_mva" | "hv_kv" | "lv_kv"> = {
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

/** IEEE C57.91 exponents by cooling class. */
export function coolingExponents(cooling: CoolingClass): { n: number; m: number } {
  switch (cooling) {
    case "ONAF":
      return { n: 0.9, m: 0.8 };
    case "OFAF":
      return { n: 1.0, m: 0.8 };
    case "ODAF":
      return { n: 1.0, m: 0.8 };
    case "ONAN":
    default:
      return { n: 0.8, m: 0.8 };
  }
}

export function transformerLossRatio(spec: TransformerSpec): number {
  if (spec.no_load_loss_pct <= 0) return 6;
  return Math.max(1, spec.load_loss_pct / spec.no_load_loss_pct);
}

/**
 * Ultimate top-oil rise over ambient:
 *   Δθ_TO = Δθ_TO,R · ((K²R + 1)/(R + 1))^n
 */
export function ultimateTopOilRise(spec: TransformerSpec, loadMva: number): number {
  const { n } = coolingExponents(spec.cooling);
  const k = Math.max(0, loadMva / Math.max(0.01, spec.rating_mva));
  const r = transformerLossRatio(spec);
  return spec.rated_top_oil_rise_k * Math.pow((k * k * r + 1) / (r + 1), n);
}

/**
 * Ultimate hot-spot rise over top oil:
 *   Δθ_HS = Δθ_HS,R · K^(2m)
 */
export function ultimateHotspotRise(spec: TransformerSpec, loadMva: number): number {
  const { m } = coolingExponents(spec.cooling);
  const k = Math.max(0, loadMva / Math.max(0.01, spec.rating_mva));
  return spec.rated_hotspot_rise_k * Math.pow(k, 2 * m);
}

export function initTransformerState(ambientC: number): TransformerState {
  return {
    top_oil_c: ambientC,
    hotspot_c: ambientC,
    equivalent_aging_years: 0,
    load_mva: 0,
    loading_pct: 0,
    aging_factor: 0,
  };
}

/**
 * Advance the transformer thermal state by `dt_hours`.
 *
 * The oil rise is a first-order lag with the top-oil time constant. The
 * winding hot-spot is treated as quasi-steady over the hour (its time constant
 * is minutes), which is the conservative choice for hourly planning data.
 */
export function stepTransformer(
  spec: TransformerSpec,
  state: TransformerState,
  loadMva: number,
  ambientC: number,
  dtHours: number,
): TransformerState {
  const dt = Math.max(0, dtHours);
  const k = Math.max(0, loadMva / Math.max(0.01, spec.rating_mva));
  const riseTarget = ultimateTopOilRise(spec, loadMva);
  const targetOil = ambientC + riseTarget;
  const tauHours = Math.max(0.01, spec.tau_oil_min / 60);
  const alpha = 1 - Math.exp(-dt / tauHours);
  const topOil = state.top_oil_c + (targetOil - state.top_oil_c) * alpha;
  const hotspotRise = ultimateHotspotRise(spec, loadMva);
  const hotspot = topOil + hotspotRise;

  // IEC 60216 / IEEE C57.91 Arrhenius aging at a 110 °C reference hot-spot.
  const agingFactor = Math.exp(15000 / 383 - 15000 / (hotspot + 273.15));
  const equivalentAging = state.equivalent_aging_years + (agingFactor * dt) / 8760;

  return {
    top_oil_c: roundTo(topOil, 2),
    hotspot_c: roundTo(hotspot, 2),
    equivalent_aging_years: roundTo(equivalentAging, 5),
    load_mva: roundTo(loadMva, 3),
    loading_pct: roundTo((loadMva / Math.max(0.01, spec.rating_mva)) * 100, 2),
    aging_factor: roundTo(agingFactor, 4),
  };
}

/** Per-unit insulation life consumed, 0–100 %. */
export function transformerLossOfLifePct(
  spec: TransformerSpec,
  equivalentAgingYears: number,
): number {
  if (spec.design_life_years <= 0) return 0;
  return roundTo((equivalentAgingYears / spec.design_life_years) * 100, 4);
}

/** Remaining equivalent life, years, after the simulated duty. */
export function transformerRemainingLifeYears(
  spec: TransformerSpec,
  equivalentAgingYears: number,
): number {
  return roundTo(Math.max(0, spec.design_life_years - equivalentAgingYears), 2);
}

export type ThermalSeverity = "ok" | "watch" | "high" | "critical";

export function transformerThermalBand(state: TransformerState): ThermalSeverity {
  if (state.hotspot_c >= 140 || state.top_oil_c >= 110) return "critical";
  if (state.hotspot_c >= 120 || state.top_oil_c >= 100) return "high";
  if (state.hotspot_c >= 110 || state.top_oil_c >= 90) return "watch";
  return "ok";
}

// ---- Conductors -------------------------------------------------------------

export interface WeatherConditions {
  ambient_c: number;
  /** Wind speed at conductor height, m/s. */
  wind_mps: number;
  /** Global horizontal irradiance, W/m². */
  solar_w_m2: number;
  /** Solar absorptivity of the conductor surface, 0–1. */
  absorptivity?: number;
  /** Long-wave emissivity, 0–1. */
  emissivity?: number;
}

export interface ConductorThermalResult {
  temperature_c: number;
  ampacity_a: number;
  /** Thermal margin at the supplied current, percent of ampacity. */
  margin_pct: number;
  joule_w_per_m: number;
  convection_w_per_m: number;
  radiation_w_per_m: number;
  solar_w_per_m: number;
  /** True when the heat balance has no solution below 300 °C. */
  runaway: boolean;
}

function conductorResistancePerM(conductor: ConductorSpec, tempC: number): number {
  const r25PerMi = conductor.resistance_ohm_per_mi_25c;
  const rPerMi = r25PerMi * (1 + conductor.alpha_per_c * (tempC - 25));
  return Math.max(1e-9, rPerMi / 1609.344);
}

/**
 * Steady-state conductor heat balance:
 *
 *   I²R(Tc) + q_s = q_c + q_r
 *
 * Convection uses h = 5.7 + 3.8·v (W/m²K), radiation uses the
 * Stefan-Boltzmann law and solar gain is absorptivity × irradiance × diameter.
 * This is a screening form of IEEE 738, not the full forced-convection
 * correlation; it errs toward a warmer conductor in low wind.
 */
export function conductorHeatBalance(
  conductor: ConductorSpec,
  currentA: number,
  weather: WeatherConditions,
): ConductorThermalResult {
  const diameterM = conductor.diameter_in * 0.0254;
  const absorptivity = weather.absorptivity ?? 0.5;
  const emissivity = weather.emissivity ?? 0.5;
  const wind = Math.max(0, weather.wind_mps);
  const h = 5.7 + 3.8 * wind;
  const solar = absorptivity * Math.max(0, weather.solar_w_m2) * diameterM;

  const heat = (tc: number): {
    f: number;
    joule: number;
    convection: number;
    radiation: number;
  } => {
    const r = conductorResistancePerM(conductor, tc);
    const joule = currentA * currentA * r;
    const convection = Math.PI * diameterM * h * (tc - weather.ambient_c);
    const radiation =
      Math.PI *
      diameterM *
      emissivity *
      SIGMA_SB *
      (Math.pow(cToK(tc), 4) - Math.pow(cToK(weather.ambient_c), 4));
    return {
      f: joule + solar - convection - radiation,
      joule,
      convection,
      radiation,
    };
  };

  const low = weather.ambient_c;
  const high = 300;
  const fLow = heat(low).f;
  const fHigh = heat(high).f;
  let temperature = high;
  let runaway = false;
  if (fLow <= 0) {
    temperature = low;
  } else if (fHigh > 0) {
    temperature = high;
    runaway = true;
  } else {
    let a = low;
    let b = high;
    for (let i = 0; i < 80; i += 1) {
      const mid = (a + b) / 2;
      if (heat(mid).f > 0) a = mid;
      else b = mid;
      if (b - a < 0.005) break;
    }
    temperature = (a + b) / 2;
  }

  const atTemp = heat(temperature);
  const ampacity = conductorAmpacity(conductor, weather, conductor.max_temp_c);
  return {
    temperature_c: roundTo(temperature, 2),
    ampacity_a: roundTo(ampacity, 0),
    margin_pct:
      ampacity > 0 ? roundTo(((ampacity - currentA) / ampacity) * 100, 1) : 0,
    joule_w_per_m: roundTo(atTemp.joule, 2),
    convection_w_per_m: roundTo(atTemp.convection, 2),
    radiation_w_per_m: roundTo(atTemp.radiation, 2),
    solar_w_per_m: roundTo(solar, 2),
    runaway,
  };
}

/** Ampacity at a target conductor temperature, A. */
export function conductorAmpacity(
  conductor: ConductorSpec,
  weather: WeatherConditions,
  maxTempC = conductor.max_temp_c,
): number {
  const diameterM = conductor.diameter_in * 0.0254;
  const absorptivity = weather.absorptivity ?? 0.5;
  const emissivity = weather.emissivity ?? 0.5;
  const wind = Math.max(0, weather.wind_mps);
  const h = 5.7 + 3.8 * wind;
  const solar = absorptivity * Math.max(0, weather.solar_w_m2) * diameterM;
  const convection =
    Math.PI * diameterM * h * (maxTempC - weather.ambient_c);
  const radiation =
    Math.PI *
    diameterM *
    emissivity *
    SIGMA_SB *
    (Math.pow(cToK(maxTempC), 4) - Math.pow(cToK(weather.ambient_c), 4));
  const netCooling = convection + radiation - solar;
  if (netCooling <= 0) return 0;
  const r = conductorResistancePerM(conductor, maxTempC);
  return Math.sqrt(netCooling / r);
}

/**
 * Rough sag-risk band from conductor temperature. A hot conductor is closer
 * to its clearance limit; the actual sag needs span, tension and creep data.
 */
export function conductorSagRisk(
  temperatureC: number,
  maxTempC = 100,
): ThermalSeverity {
  const ratio = temperatureC / Math.max(1, maxTempC);
  if (ratio >= 1.0) return "critical";
  if (ratio >= 0.92) return "high";
  if (ratio >= 0.82) return "watch";
  return "ok";
}

/** Conductor temperature from a pre-computed current and weather state. */
export function conductorTemperature(
  conductor: ConductorSpec,
  currentA: number,
  weather: WeatherConditions,
): number {
  return conductorHeatBalance(conductor, currentA, weather).temperature_c;
}

/**
 * Steady-state line rating at a target temperature, MVA.
 * `circuits` and `bundle` multiply the per-conductor ampacity.
 */
export function lineRatingMva(
  conductor: ConductorSpec,
  voltageKv: number,
  weather: WeatherConditions,
  options: { circuits?: number; bundle?: number; max_temp_c?: number } = {},
): number {
  const ampacity = conductorAmpacity(
    conductor,
    weather,
    options.max_temp_c ?? conductor.max_temp_c,
  );
  const circuits = Math.max(1, options.circuits ?? 1);
  const bundle = Math.max(1, options.bundle ?? 1);
  return (Math.sqrt(3) * voltageKv * ampacity * circuits * bundle) / 1000;
}

/** Clamp a load into a sensible range before thermal math. */
export function clampLoadMva(value: number, ratingMva: number): number {
  return clamp(value, 0, Math.max(0.01, ratingMva) * 2);
}
