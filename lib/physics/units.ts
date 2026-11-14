/**
 * Units, per-unit bases and complex arithmetic for the physical grid model.
 *
 * Every formula in this folder is pure. Nothing here reads data, React or the
 * network. The model is deliberately explicit about bases so a 12.47 kV
 * distribution feeder and a 230 kV transmission corridor can be solved with
 * the same code without silently mixing line-to-line and line-to-neutral.
 */

export const SQRT3 = Math.sqrt(3);
export const F_NOMINAL_HZ = 60;
export const SECONDS_PER_HOUR = 3600;
export const HOURS_PER_YEAR = 8760;
export const WEEKS_PER_YEAR = 52;

/** EIA/HUD screening value used by the existing contract (README §4.2). */
export const MWH_PER_HOME_YEAR = 10.5;

/** Stefan-Boltzmann constant, W/(m²·K⁴). */
export const SIGMA_SB = 5.670374419e-8;

/** Standard gravity, m/s². */
export const GRAVITY = 9.80665;

export interface Complex {
  re: number;
  im: number;
}

export const cx = (re: number, im = 0): Complex => ({ re, im });
export const cAdd = (a: Complex, b: Complex): Complex => ({
  re: a.re + b.re,
  im: a.im + b.im,
});
export const cSub = (a: Complex, b: Complex): Complex => ({
  re: a.re - b.re,
  im: a.im - b.im,
});
export const cMul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
export const cScale = (a: Complex, k: number): Complex => ({
  re: a.re * k,
  im: a.im * k,
});
export const cDiv = (a: Complex, b: Complex): Complex => {
  const d = b.re * b.re + b.im * b.im;
  if (d === 0) return cx(0, 0);
  return {
    re: (a.re * b.re + a.im * b.im) / d,
    im: (a.im * b.re - a.re * b.im) / d,
  };
};
export const cConj = (a: Complex): Complex => ({ re: a.re, im: -a.im });
export const cAbs = (a: Complex): number => Math.hypot(a.re, a.im);
export const cArg = (a: Complex): number => Math.atan2(a.im, a.re);
export const cArgDeg = (a: Complex): number => (cArg(a) * 180) / Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function roundTo(value: number, digits = 2): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

/** Linear interpolation over a piecewise-linear table of [x, y] pairs. */
export function interpolate(points: readonly [number, number][], x: number): number {
  if (points.length === 0) return 0;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) {
      if (x1 === x0) return y1;
      return lerp(y0, y1, (x - x0) / (x1 - x0));
    }
  }
  return points[points.length - 1][1];
}

// ---- Per-unit ---------------------------------------------------------------

/**
 * A per-unit base. `s_mva` is three-phase power; `v_kv` is line-to-line RMS.
 * Those are the two conventions that make every equation below consistent.
 */
export interface PerUnitBase {
  s_mva: number;
  v_kv: number;
}

/** Z_base = V_LL² / S_3φ, in ohms. */
export function zBaseOhm(base: PerUnitBase): number {
  if (base.s_mva <= 0) throw new Error("PerUnitBase.s_mva must be > 0");
  return (base.v_kv * base.v_kv) / base.s_mva;
}

/** I_base = S_3φ / (√3 · V_LL), in kA when S is MVA and V is kV. */
export function iBaseKa(base: PerUnitBase): number {
  if (base.v_kv <= 0) throw new Error("PerUnitBase.v_kv must be > 0");
  return base.s_mva / (SQRT3 * base.v_kv);
}

/** Y_base = S_3φ / V_LL², in siemens. */
export function yBaseSiemens(base: PerUnitBase): number {
  if (base.v_kv <= 0) throw new Error("PerUnitBase.v_kv must be > 0");
  return base.s_mva / (base.v_kv * base.v_kv);
}

export function ohmsToPu(ohms: number, base: PerUnitBase): number {
  return ohms / zBaseOhm(base);
}

export function puToOhms(pu: number, base: PerUnitBase): number {
  return pu * zBaseOhm(base);
}

// ---- Three-phase power ------------------------------------------------------

/** Balanced three-phase current, kA. P in MW, Q in Mvar, V line-to-line kV. */
export function threePhaseCurrentKa(pMw: number, qMvar: number, vKv: number): number {
  if (vKv <= 0) return 0;
  return Math.hypot(pMw, qMvar) / (SQRT3 * vKv);
}

/** Balanced three-phase apparent power, MVA. */
export function apparentMva(pMw: number, qMvar: number): number {
  return Math.hypot(pMw, qMvar);
}

/** Power factor from P and Q. */
export function powerFactor(pMw: number, qMvar: number): number {
  const s = Math.hypot(pMw, qMvar);
  return s === 0 ? 1 : Math.abs(pMw) / s;
}

/** Reactive power for a target power factor. Q = P · tan(acos(pf)). */
export function reactiveFromPf(pMw: number, pf: number): number {
  const clamped = clamp(Math.abs(pf), 0.01, 1);
  return pMw * Math.tan(Math.acos(clamped));
}

/** Voltage drop as a percentage of the sending-end voltage. Negative = rise. */
export function voltageDropPct(vFromKv: number, vToKv: number): number {
  if (vFromKv <= 0) return 0;
  return ((vFromKv - vToKv) / vFromKv) * 100;
}

export function puToKv(vPu: number, baseKv: number): number {
  return vPu * baseKv;
}

export function kvToPu(vKv: number, baseKv: number): number {
  return baseKv > 0 ? vKv / baseKv : 0;
}

// ---- Energy / emissions -----------------------------------------------------

/** MWh from a constant MW over a number of hours. */
export function mwhFromMw(mw: number, hours = 1): number {
  return mw * hours;
}

/** Tonnes CO₂ from MWh and an intensity in gCO₂/kWh. 1 g/kWh = 1 kg/MWh. */
export function co2TonsFromMwh(mwh: number, gco2PerKwh: number): number {
  return (mwh * gco2PerKwh) / 1000;
}

export function mwhToKwh(mwh: number): number {
  return mwh * 1000;
}

/** Normalize a 24-value shape so its maximum is 1. */
export function normalizeShape(shape: readonly number[]): number[] {
  const max = Math.max(...shape, 0);
  if (max <= 0) return shape.map(() => 0);
  return shape.map((v) => v / max);
}

/** Average of a numeric series, 0 for an empty series. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Peak-to-average ratio; 0 for an empty or all-zero series. */
export function peakToAverage(values: readonly number[]): number {
  const avg = mean(values);
  if (avg <= 0) return 0;
  return Math.max(...values) / avg;
}

// ---- Temperature ------------------------------------------------------------

export function cToK(c: number): number {
  return c + 273.15;
}

export function fToC(f: number): number {
  return ((f - 32) * 5) / 9;
}

export function cToF(c: number): number {
  return (c * 9) / 5 + 32;
}

/**
 * Air density at ambient temperature and sea-level pressure, kg/m³.
 * Used by conductor cooling; the difference from 1.2 is small but honest.
 */
export function airDensity(tempC: number, pressurePa = 101325): number {
  return pressurePa / (287.05 * cToK(tempC));
}
