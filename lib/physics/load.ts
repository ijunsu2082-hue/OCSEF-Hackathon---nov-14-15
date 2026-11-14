/**
 * Load, weather and distributed-resource profiles.
 *
 * These are the inputs to the network and thermal equations: a municipality's
 * sector load shape, the weather that turns a design day into a heatwave, the
 * solar resource on a tilted plane, and a battery state machine. They are
 * deliberately deterministic — the same hour always produces the same MW — so
 * a judge can reproduce every number on screen.
 */

import {
  HOURS_PER_YEAR,
  clamp,
  interpolate,
  normalizeShape,
  roundTo,
} from "./units";

export type Sector =
  | "residential"
  | "commercial"
  | "industrial"
  | "municipal"
  | "data_center"
  | "agricultural";

export const SECTOR_LABELS: Record<Sector, string> = {
  residential: "Residential",
  commercial: "Commercial",
  industrial: "Industrial",
  municipal: "Municipal",
  data_center: "Data center",
  agricultural: "Agricultural",
};

/** 24-hour shape normalized to a peak of 1.0. */
export const SECTOR_SHAPES: Record<Sector, number[]> = {
  residential: normalizeShape([
    0.55, 0.5, 0.48, 0.46, 0.48, 0.55, 0.65, 0.75, 0.8, 0.82, 0.8, 0.8,
    0.82, 0.82, 0.8, 0.82, 0.9, 1.0, 1.0, 0.95, 0.88, 0.8, 0.7, 0.6,
  ]),
  commercial: normalizeShape([
    0.45, 0.42, 0.4, 0.4, 0.42, 0.48, 0.6, 0.75, 0.9, 1.0, 1.0, 1.0,
    1.0, 1.0, 1.0, 0.98, 0.92, 0.85, 0.78, 0.7, 0.62, 0.55, 0.5, 0.47,
  ]),
  industrial: normalizeShape([
    0.85, 0.82, 0.8, 0.8, 0.82, 0.88, 0.94, 0.98, 1.0, 1.0, 1.0, 0.98,
    0.96, 0.98, 1.0, 1.0, 0.98, 0.96, 0.94, 0.9, 0.88, 0.86, 0.85, 0.85,
  ]),
  municipal: normalizeShape([
    0.2, 0.18, 0.18, 0.18, 0.2, 0.3, 0.5, 0.8, 1.0, 1.0, 1.0, 1.0,
    0.95, 0.95, 1.0, 1.0, 0.9, 0.7, 0.5, 0.4, 0.3, 0.25, 0.22, 0.2,
  ]),
  data_center: normalizeShape([
    0.97, 0.96, 0.95, 0.95, 0.96, 0.97, 0.98, 0.99, 1.0, 1.0, 1.0, 1.0,
    1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.99, 0.99, 0.98, 0.98, 0.97, 0.97,
  ]),
  agricultural: normalizeShape([
    0.35, 0.3, 0.28, 0.28, 0.3, 0.4, 0.6, 0.8, 0.95, 1.0, 1.0, 1.0,
    1.0, 1.0, 1.0, 1.0, 0.95, 0.85, 0.7, 0.55, 0.45, 0.4, 0.38, 0.36,
  ]),
};

export function sectorShape(sector: Sector, hour: number): number {
  const shape = SECTOR_SHAPES[sector] ?? SECTOR_SHAPES.commercial;
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  return shape[h];
}

// ---- Weather ---------------------------------------------------------------

export interface WeatherPoint {
  ambient_c: number;
  wind_mps: number;
  solar_w_m2: number;
}

export interface WeatherScenario {
  latitude_deg: number;
  annual_mean_c: number;
  annual_amplitude_c: number;
  diurnal_amplitude_c: number;
  wind_mean_mps: number;
  wind_amplitude_mps: number;
  /** Fraction of clear-sky irradiance that actually arrives, 0–1. */
  clearness: number;
  /** Optional explicit 8760-hour series; wins over the synthetic model. */
  hourly?: WeatherPoint[];
}

export function dateToDayOfYear(month: number, day: number): number {
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const m = clamp(Math.floor(month), 1, 12);
  const d = clamp(Math.floor(day), 1, days[m - 1]);
  let n = d;
  for (let i = 0; i < m - 1; i += 1) n += days[i];
  return n;
}

export interface SolarPosition {
  altitude_deg: number;
  azimuth_deg: number; // 0 = north, 90 = east, 180 = south, 270 = west
  declination_deg: number;
  hour_angle_deg: number;
}

/** NOAA-style solar position for a latitude, day of year and solar hour. */
export function solarPosition(
  latitudeDeg: number,
  dayOfYear: number,
  solarHour: number,
): SolarPosition {
  const lat = (latitudeDeg * Math.PI) / 180;
  const declination =
    23.45 *
    Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365) *
    (Math.PI / 180);
  const hourAngle = ((15 * (solarHour - 12)) * Math.PI) / 180;
  const sinAlt =
    Math.sin(lat) * Math.sin(declination) +
    Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  const altitude = Math.asin(clamp(sinAlt, -1, 1));
  const cosAlt = Math.cos(altitude);
  const cosAz =
    cosAlt === 0
      ? 0
      : (Math.sin(declination) - Math.sin(altitude) * Math.sin(lat)) /
        Math.max(1e-9, cosAlt * Math.cos(lat));
  let azimuth = Math.acos(clamp(cosAz, -1, 1)) * (180 / Math.PI);
  if (hourAngle > 0) azimuth = 360 - azimuth;
  return {
    altitude_deg: (altitude * 180) / Math.PI,
    azimuth_deg: azimuth,
    declination_deg: (declination * 180) / Math.PI,
    hour_angle_deg: (hourAngle * 180) / Math.PI,
  };
}

/**
 * Clear-sky GHI from the Meinel/air-mass model:
 *   GHI = 1367 · sin(alt) · 0.7^(AM^0.678), AM = 1/sin(alt)
 */
export function clearSkyGhi(latitudeDeg: number, dayOfYear: number, hour: number): number {
  const position = solarPosition(latitudeDeg, dayOfYear, hour);
  const sinAlt = Math.sin((position.altitude_deg * Math.PI) / 180);
  if (sinAlt <= 0.02) return 0;
  const airMass = 1 / sinAlt;
  return 1367 * sinAlt * Math.pow(0.7, Math.pow(airMass, 0.678));
}

/** Erbs diffuse-fraction correlation. */
export function erbsDiffuseFraction(
  ghi: number,
  extraterrestrialHorizontal: number,
): number {
  if (extraterrestrialHorizontal <= 0 || ghi <= 0) return 1;
  const kt = clamp(ghi / extraterrestrialHorizontal, 0, 1);
  if (kt <= 0.22) return 1 - 0.09 * kt;
  if (kt <= 0.8) {
    return clamp(
      0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4,
      0,
      1,
    );
  }
  return 0.165;
}

export interface PoaResult {
  poa_w_m2: number;
  dni_w_m2: number;
  dhi_w_m2: number;
  incidence_deg: number;
}

/** Plane-of-array irradiance using an isotropic sky and Erbs diffuse split. */
export function poaIrradiance(
  ghi: number,
  latitudeDeg: number,
  dayOfYear: number,
  hour: number,
  tiltDeg: number,
  azimuthDeg: number,
  albedo = 0.2,
): PoaResult {
  const position = solarPosition(latitudeDeg, dayOfYear, hour);
  const alt = (position.altitude_deg * Math.PI) / 180;
  const sinAlt = Math.sin(alt);
  if (sinAlt <= 0.02 || ghi <= 0) {
    return { poa_w_m2: 0, dni_w_m2: 0, dhi_w_m2: 0, incidence_deg: 90 };
  }
  const extraterrestrial = 1367 * sinAlt;
  const df = erbsDiffuseFraction(ghi, extraterrestrial);
  const dhi = ghi * df;
  const dni = Math.max(0, (ghi - dhi) / Math.max(1e-6, sinAlt));
  const tilt = (tiltDeg * Math.PI) / 180;
  const panelAz = (azimuthDeg * Math.PI) / 180;
  const sunAz = (position.azimuth_deg * Math.PI) / 180;
  const cosIncidence =
    Math.sin(alt) * Math.cos(tilt) +
    Math.cos(alt) * Math.sin(tilt) * Math.cos(sunAz - panelAz);
  const poa =
    dni * Math.max(0, cosIncidence) +
    dhi * ((1 + Math.cos(tilt)) / 2) +
    ghi * albedo * ((1 - Math.cos(tilt)) / 2);
  return {
    poa_w_m2: Math.max(0, poa),
    dni_w_m2: dni,
    dhi_w_m2: dhi,
    incidence_deg: (Math.acos(clamp(cosIncidence, -1, 1)) * 180) / Math.PI,
  };
}

/** Synthetic weather for one day, useful for the real-time design-day view. */
export function syntheticWeatherDay(
  scenario: Pick<WeatherScenario, "latitude_deg" | "annual_mean_c" | "diurnal_amplitude_c"> & {
    high_c: number;
    low_c: number;
    wind_mean_mps?: number;
    clearness?: number;
    day_of_year?: number;
  },
  dayOfYear = scenario.day_of_year ?? 230,
): WeatherPoint[] {
  const mean = (scenario.high_c + scenario.low_c) / 2;
  const amplitude = (scenario.high_c - scenario.low_c) / 2;
  const clearness = scenario.clearness ?? 0.9;
  return Array.from({ length: 24 }, (_, hour) => {
    const ambient =
      mean + amplitude * Math.sin((2 * Math.PI * (hour - 9)) / 24);
    const ghi = clearSkyGhi(scenario.latitude_deg, dayOfYear, hour) * clearness;
    const wind =
      (scenario.wind_mean_mps ?? 3.5) +
      1.2 * Math.sin((2 * Math.PI * (hour - 14)) / 24);
    return {
      ambient_c: roundTo(ambient, 2),
      wind_mps: roundTo(Math.max(0, wind), 2),
      solar_w_m2: roundTo(ghi, 1),
    };
  });
}

/** Synthetic 8760-hour weather year. Deterministic and data-free. */
export function syntheticWeatherYear(scenario: WeatherScenario): WeatherPoint[] {
  if (scenario.hourly && scenario.hourly.length > 0) return scenario.hourly;
  const points: WeatherPoint[] = [];
  for (let day = 1; day <= 365; day += 1) {
    const seasonal =
      scenario.annual_amplitude_c *
      Math.cos((2 * Math.PI * (day - 200)) / 365);
    for (let hour = 0; hour < 24; hour += 1) {
      const diurnal =
        scenario.diurnal_amplitude_c *
        Math.sin((2 * Math.PI * (hour - 9)) / 24);
      const ghi =
        clearSkyGhi(scenario.latitude_deg, day, hour) * scenario.clearness;
      const wind =
        scenario.wind_mean_mps +
        scenario.wind_amplitude_mps *
          Math.sin((2 * Math.PI * (day + hour / 24 - 40)) / 365);
      points.push({
        ambient_c: roundTo(scenario.annual_mean_c + seasonal + diurnal, 2),
        wind_mps: roundTo(Math.max(0, wind), 2),
        solar_w_m2: roundTo(ghi, 1),
      });
    }
  }
  return points;
}

// ---- Load ------------------------------------------------------------------

export interface LoadSpec {
  id: string;
  sector: Sector;
  /** Peak MW at the design weather condition. */
  peak_mw: number;
  power_factor: number;
  /** Share of peak that is weather-sensitive HVAC. */
  hvac_share: number;
  cooling_balance_c?: number;
  cooling_design_c?: number;
  heating_balance_c?: number;
  heating_design_c?: number;
  /** Optional custom 24-hour shape, normalized to peak 1. */
  shape?: number[];
  /** Optional annual calibration; if present, the load is scaled to it. */
  annual_mwh?: number;
}

export const SECTOR_HVAC_SHARE: Record<Sector, number> = {
  residential: 0.45,
  commercial: 0.4,
  industrial: 0.15,
  municipal: 0.3,
  data_center: 0.06,
  agricultural: 0.2,
};

export function weatherMultiplier(
  spec: Pick<
    LoadSpec,
    | "hvac_share"
    | "cooling_balance_c"
    | "cooling_design_c"
    | "heating_balance_c"
    | "heating_design_c"
  >,
  ambientC: number,
): number {
  const coolBalance = spec.cooling_balance_c ?? 18;
  const coolDesign = spec.cooling_design_c ?? 38;
  const heatBalance = spec.heating_balance_c ?? 15;
  const heatDesign = spec.heating_design_c ?? 2;
  const cooling = clamp(
    (ambientC - coolBalance) / Math.max(1, coolDesign - coolBalance),
    0,
    1.8,
  );
  const heating = clamp(
    (heatBalance - ambientC) / Math.max(1, heatBalance - heatDesign),
    0,
    1.8,
  );
  const hvac = clamp(spec.hvac_share, 0, 0.9);
  return clamp(1 + hvac * (cooling + heating - 1), 0.15, 2.5);
}

export interface LoadPoint {
  p_mw: number;
  q_mvar: number;
  power_factor: number;
  weather_multiplier: number;
}

/** Load at a given hour and ambient temperature. */
export function loadAt(spec: LoadSpec, hour: number, ambientC: number): LoadPoint {
  const shape = spec.shape
    ? normalizeShape(spec.shape)[((Math.floor(hour) % 24) + 24) % 24]
    : sectorShape(spec.sector, hour);
  const mult = weatherMultiplier(spec, ambientC);
  const p = Math.max(0, spec.peak_mw * shape * mult);
  const pf = clamp(spec.power_factor, 0.5, 1);
  const q = p * Math.tan(Math.acos(pf));
  return {
    p_mw: roundTo(p, 4),
    q_mvar: roundTo(q, 4),
    power_factor: pf,
    weather_multiplier: roundTo(mult, 4),
  };
}

/** Annual MWh of a load spec under a weather year. */
export function annualLoadMwh(
  spec: LoadSpec,
  weather: readonly WeatherPoint[],
): number {
  let mwh = 0;
  for (let i = 0; i < weather.length; i += 1) {
    const hour = i % 24;
    mwh += loadAt(spec, hour, weather[i].ambient_c).p_mw;
  }
  return roundTo(mwh, 1);
}

/** Scale a load's peak so its simulated annual energy matches a target. */
export function calibrateLoadPeak(
  spec: LoadSpec,
  weather: readonly WeatherPoint[],
  targetAnnualMwh: number,
): LoadSpec {
  const current = annualLoadMwh(spec, weather);
  if (current <= 0 || targetAnnualMwh <= 0) return spec;
  return { ...spec, peak_mw: spec.peak_mw * (targetAnnualMwh / current) };
}

// ---- Solar -----------------------------------------------------------------

export interface SolarSpec {
  id: string;
  capacity_mw_dc: number;
  dc_ac_ratio: number;
  tilt_deg: number;
  azimuth_deg: number;
  temp_coeff_per_c: number;
  noct_c: number;
  soiling_loss_pct: number;
  inverter_eff: number;
  albedo?: number;
}

export const SOLAR_DEFAULTS: Omit<SolarSpec, "id" | "capacity_mw_dc"> = {
  dc_ac_ratio: 1.25,
  tilt_deg: 25,
  azimuth_deg: 180,
  temp_coeff_per_c: -0.0035,
  noct_c: 45,
  soiling_loss_pct: 2,
  inverter_eff: 0.97,
  albedo: 0.2,
};

export interface SolarPoint {
  ac_mw: number;
  dc_mw: number;
  poa_w_m2: number;
  cell_c: number;
  clipping: boolean;
}

/** PV output from plane-of-array irradiance and cell temperature. */
export function solarAcPower(
  spec: SolarSpec,
  poaWM2: number,
  ambientC: number,
): SolarPoint {
  const poa = Math.max(0, poaWM2);
  const cell = ambientC + ((spec.noct_c - 20) / 800) * poa;
  const tempFactor = 1 + spec.temp_coeff_per_c * (cell - 25);
  const soiling = 1 - clamp(spec.soiling_loss_pct / 100, 0, 0.3);
  const dc = Math.max(
    0,
    spec.capacity_mw_dc * (poa / 1000) * tempFactor * soiling,
  );
  const acRating = spec.capacity_mw_dc / Math.max(0.5, spec.dc_ac_ratio);
  const acUnclipped = dc * clamp(spec.inverter_eff, 0.8, 1);
  const ac = Math.min(acRating, acUnclipped);
  return {
    ac_mw: roundTo(ac, 4),
    dc_mw: roundTo(dc, 4),
    poa_w_m2: roundTo(poa, 1),
    cell_c: roundTo(cell, 2),
    clipping: acUnclipped > acRating + 1e-6,
  };
}

export function solarAt(
  spec: SolarSpec,
  weather: WeatherPoint,
  latitudeDeg: number,
  dayOfYear: number,
  hour: number,
): SolarPoint {
  const poa = poaIrradiance(
    weather.solar_w_m2,
    latitudeDeg,
    dayOfYear,
    hour,
    spec.tilt_deg,
    spec.azimuth_deg,
    spec.albedo ?? 0.2,
  );
  return solarAcPower(spec, poa.poa_w_m2, weather.ambient_c);
}

/** Simple capacity-factor estimate from a weather year. */
export function solarCapacityFactor(
  spec: SolarSpec,
  weather: readonly WeatherPoint[],
  latitudeDeg: number,
): number {
  if (weather.length === 0) return 0;
  let energy = 0;
  for (let i = 0; i < weather.length; i += 1) {
    const day = Math.floor(i / 24) + 1;
    const hour = i % 24;
    energy += solarAt(spec, weather[i], latitudeDeg, day, hour).ac_mw;
  }
  return roundTo(energy / (weather.length * Math.max(1, spec.capacity_mw_dc)), 4);
}

// ---- Wind ------------------------------------------------------------------

export interface WindSpec {
  id: string;
  capacity_mw: number;
  cut_in_mps: number;
  rated_mps: number;
  cut_out_mps: number;
}

export const WIND_DEFAULTS: Omit<WindSpec, "id" | "capacity_mw"> = {
  cut_in_mps: 3,
  rated_mps: 12,
  cut_out_mps: 25,
};

/** Cubic wind turbine power curve, clipped by cut-in/rated/cut-out. */
export function windPower(spec: WindSpec, windMps: number): number {
  const v = Math.max(0, windMps);
  if (v < spec.cut_in_mps || v >= spec.cut_out_mps) return 0;
  if (v >= spec.rated_mps) return spec.capacity_mw;
  const v3 = v ** 3;
  const in3 = spec.cut_in_mps ** 3;
  const rated3 = spec.rated_mps ** 3;
  return roundTo(
    spec.capacity_mw * ((v3 - in3) / Math.max(1e-9, rated3 - in3)),
    4,
  );
}

// ---- Battery ---------------------------------------------------------------

export interface BessSpec {
  id: string;
  power_mw: number;
  energy_mwh: number;
  round_trip_eff: number;
  soc_min_pct: number;
  soc_max_pct: number;
  initial_soc_pct: number;
}

export const BESS_DEFAULTS: Omit<BessSpec, "id" | "power_mw" | "energy_mwh"> = {
  round_trip_eff: 0.88,
  soc_min_pct: 10,
  soc_max_pct: 95,
  initial_soc_pct: 50,
};

export interface BessState {
  soc_mwh: number;
}

export function initBess(spec: BessSpec): BessState {
  return { soc_mwh: (spec.energy_mwh * spec.initial_soc_pct) / 100 };
}

export interface BessStep {
  state: BessState;
  /** Positive discharge, negative charge, MW. */
  actual_mw: number;
  limited: boolean;
  soc_pct: number;
}

/**
 * One battery step. `requestMw` is positive to discharge and negative to
 * charge. Charge and discharge are limited by power, state of charge and
 * one-way efficiency.
 */
export function bessStep(
  spec: BessSpec,
  state: BessState,
  requestMw: number,
  dtHours: number,
): BessStep {
  const dt = Math.max(0, dtHours);
  const eta = Math.sqrt(clamp(spec.round_trip_eff, 0.5, 1));
  const socMin = (spec.energy_mwh * spec.soc_min_pct) / 100;
  const socMax = (spec.energy_mwh * spec.soc_max_pct) / 100;
  const soc = clamp(state.soc_mwh, socMin, socMax);
  const maxDischarge = Math.min(
    spec.power_mw,
    dt > 0 ? Math.max(0, (soc - socMin) * eta) / dt : 0,
  );
  const maxCharge = Math.min(
    spec.power_mw,
    dt > 0 ? Math.max(0, socMax - soc) / (eta * dt) : 0,
  );
  const actual = clamp(requestMw, -maxCharge, maxDischarge);
  const nextSoc =
    actual >= 0
      ? soc - (actual * dt) / eta
      : soc + (-actual * eta * dt);
  const bounded = clamp(nextSoc, socMin, socMax);
  return {
    state: { soc_mwh: roundTo(bounded, 3) },
    actual_mw: roundTo(actual, 3),
    limited: Math.abs(actual - requestMw) > 1e-6,
    soc_pct: spec.energy_mwh > 0 ? roundTo((bounded / spec.energy_mwh) * 100, 1) : 0,
  };
}

/** Peak-shave dispatch: discharge above the threshold, charge below it. */
export function peakShaveRequest(
  netLoadMw: number,
  thresholdMw: number,
  powerMw: number,
): number {
  return clamp(netLoadMw - thresholdMw, -powerMw, powerMw);
}

/** Piecewise-linear interpolation helper for custom dispatch tables. */
export function dispatchFromTable(
  table: readonly [number, number][],
  hour: number,
): number {
  return interpolate(table, hour);
}

export const HOURS = HOURS_PER_YEAR;
