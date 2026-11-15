// Port of research/scripts/line_rating.py (simplified IEEE Std 738 steady-state heat balance).
// Default conductor ACSR 795 kcmil "Drake", max conductor temp 75 C. Screening model, NOT an operating rating.
import type { GridData, LineRatingNow, WeatherNow } from "./types";
import { loadRatingCsv, nearestSite } from "./data";

export interface Conductor {
  key: string;
  /** Plain name, e.g. "Drake (795 kcmil)". */
  name: string;
  /** Outside diameter, m. */
  D: number;
  /** AC resistance at 25 C and 75 C, ohm/m. */
  R25: number;
  R75: number;
}

/*
 * Common ACSR conductors. Diameter and AC resistance from the Prysmian (General Cable)
 * TransPowr ACSR Bare Overhead Conductor (US) data sheet, "Electrical properties" table
 * (ohm/kft, 60 Hz; 1 kft = 304.8 m; 1 in = 0.0254 m):
 * https://na.prysmian.com/sites/na.prysmian.com/files/media/documents/TransPowr%C2%AE%20ACSR%20Bare%20Overhead%20Conductor%20%28US%29.pdf
 *   Linnet   336.4 kcmil 26/7  O.D. 0.720 in  AC 25 C 0.0514  AC 75 C 0.0615 ohm/kft
 *   Drake    795   kcmil 26/7  O.D. 1.108 in  AC 25 C 0.0219  AC 75 C 0.0262 ohm/kft
 *   Cardinal 954   kcmil 54/7  O.D. 1.196 in  AC 25 C 0.0187  AC 75 C 0.0230 ohm/kft
 * Drake keeps the IEEE Std 738 worked-example values used by research/scripts/line_rating.py
 * (D 28.14 mm, 7.283e-5 / 8.688e-5 ohm/m), within about 1.5% of the data sheet, so the 2025 CSVs still match.
 * At the 75 C limit the rating ratio (real weather / worst case) depends only on diameter: resistance cancels.
 */
export const DRAKE: Conductor = { key: "drake", name: "Drake (795 kcmil)", D: 0.02814, R25: 7.283e-5, R75: 8.688e-5 };
export const CONDUCTORS: Conductor[] = [
  { key: "linnet", name: "Linnet (336.4 kcmil)", D: 0.720 * 0.0254, R25: 0.0514 / 304.8, R75: 0.0615 / 304.8 },
  DRAKE,
  { key: "cardinal", name: "Cardinal (954 kcmil)", D: 1.196 * 0.0254, R25: 0.0187 / 304.8, R75: 0.0230 / 304.8 },
];

const TC = 75.0;
const EPS = 0.8, ALPHA = 0.8;
const ELEV = 100.0;
/** Worst-case fixed ("static") rating weather: 40 C air, 0.61 m/s (2 ft/s) crosswind, full sun. */
export const STATIC = { ta: 40.0, wind: 0.61, sun: 1000.0, angle: 90.0 } as const;
const AAR_WIND = 0.61;

/**
 * Sun used for the ambient-adjusted rating. FERC Order 881 defines an AAR by air temperature plus
 * day/night only (not measured sun): worst-case 1000 W/m2 by day, none at night. "Day" = any measured sun.
 * Same rule as aar_sun() in research/scripts/line_rating.py.
 */
export const aarSun = (sun: number): number => (sun > 0 ? STATIC.sun : 0);

const rAt = (c: Conductor, tc: number) => c.R25 + ((c.R75 - c.R25) * (tc - 25)) / 50;

/** IEEE 738 steady-state ampacity (A) of conductor `c` at conductor temperature `tc`. */
export function ampacityFor(c: Conductor, ta: number, wind: number, sun: number, angleDeg: number, tc = TC): number {
  const D = c.D;
  const tf = (tc + ta) / 2;
  const mu = (1.458e-6 * (tf + 273) ** 1.5) / (tf + 383.4);
  const rho = (1.293 - 1.525e-4 * ELEV + 6.379e-9 * ELEV ** 2) / (1 + 0.00367 * tf);
  const kf = 2.424e-2 + 7.477e-5 * tf - 4.407e-9 * tf ** 2;
  const phi = (angleDeg * Math.PI) / 180;
  const kAng = 1.194 - Math.cos(phi) + 0.194 * Math.cos(2 * phi) + 0.368 * Math.sin(2 * phi);
  const dt = tc - ta;
  if (dt <= 0) return 0;
  const nre = (D * rho * Math.max(wind, 0)) / mu;
  const qc1 = (1.01 + 1.35 * nre ** 0.52) * kf * kAng * dt;
  const qc2 = 0.754 * nre ** 0.6 * kf * kAng * dt;
  const qcn = 3.645 * rho ** 0.5 * D ** 0.75 * dt ** 1.25;
  const qc = Math.max(qc1, qc2, qcn);
  const qr = 17.8 * D * EPS * (((tc + 273) / 100) ** 4 - ((ta + 273) / 100) ** 4);
  const qs = ALPHA * Math.max(sun, 0) * D;
  const net = qc + qr - qs;
  return net > 0 ? Math.sqrt(net / rAt(c, tc)) : 0;
}

/** Drake ampacity (A). Signature kept for existing callers and tests. */
export function ampacity(ta: number, wind: number, sun: number, angleDeg: number, tc = TC): number {
  return ampacityFor(DRAKE, ta, wind, sun, angleDeg, tc);
}

const STATIC_A = ampacity(STATIC.ta, STATIC.wind, STATIC.sun, STATIC.angle);

export function rateLine(w: WeatherNow): LineRatingNow {
  const ta = Number.isFinite(w.temp_c) ? w.temp_c : STATIC.ta;
  const ws = Number.isFinite(w.wind_ms) ? w.wind_ms : 0;
  const sun = Number.isFinite(w.sun_wm2) ? w.sun_wm2 : 0;
  const aar = ampacity(ta, AAR_WIND, aarSun(sun), 90);
  const dlr = ampacity(ta, ws, sun, 45);
  const dlrc = ampacity(ta, ws * 0.5, sun, 45);
  const ratio = STATIC_A > 0 ? dlrc / STATIC_A : 0;
  return {
    static_A: Math.round(STATIC_A),
    aar_A: Math.round(aar),
    dlr_A: Math.round(dlr),
    dlr_conservative_A: Math.round(dlrc),
    ratio: Math.round(ratio * 1000) / 1000,
    extra_pct: Math.round((ratio - 1) * 1000) / 10,
    weather: w,
  };
}

/**
 * Temperature-only rating ratio (ambient-adjusted rating, AAR, as FERC Order 881 defines it):
 * real air temperature, day/night sun (1000 W/m2 by day, 0 at night), wind held at the worst-case 0.61 m/s.
 */
export function aarRatio(live: Pick<LineRatingNow, "aar_A" | "static_A">): number | null {
  return live.static_A > 0 && Number.isFinite(live.aar_A) ? live.aar_A / live.static_A : null;
}

/**
 * Plain sentence on what today's real wind (and real sun, since the AAR assumes worst-case sun by day)
 * adds over the temperature-adjusted rating.
 */
export function windSentence(aar: number, dlr: number): string {
  const gain = Math.round((dlr / aar - 1) * 100);
  if (gain >= 1) return `Today's real wind and sun add about ${gain}% more on top of temperature.`;
  if (gain <= -1) {
    return dlr < 1
      ? "With wind halved and a less helpful angle assumed for safety, wind adds nothing extra, and the wind-based rating falls below the fixed rating."
      : "With wind halved and a less helpful angle assumed for safety, wind adds nothing extra.";
  }
  return aar >= 1 ? "Today's wind adds nothing extra; temperature does the work." : "Today's wind adds nothing extra.";
}

/** "1.40–1.43×", or "0.99× for all three" when the ends round the same. */
export function ratioRange(min: number, max: number, x = "x"): string {
  const a = min.toFixed(2), b = max.toFixed(2);
  return a === b ? `${a}${x} for all three` : `${a}–${b}${x}`;
}

export interface ConductorRating {
  key: string; name: string;
  static_A: number;   // this wire's own worst-case rating
  aar_ratio: number;  // temperature-adjusted / static
  dlr_ratio: number;  // conservative DLR (wind halved) / static
}

export interface ConductorRange {
  rows: ConductorRating[];
  aar_min: number; aar_max: number;
  dlr_min: number; dlr_max: number;
}

/**
 * Same weather, three common wire sizes. Each ratio divides by that wire's OWN static rating
 * under the same worst case (40 C, 0.61 m/s, 1000 W/m2), so the range shows how much the
 * answer depends on which wire is up there.
 */
export function conductorRange(w: WeatherNow, conductors: Conductor[] = CONDUCTORS): ConductorRange {
  const ta = Number.isFinite(w.temp_c) ? w.temp_c : STATIC.ta;
  const ws = Number.isFinite(w.wind_ms) ? w.wind_ms : 0;
  const sun = Number.isFinite(w.sun_wm2) ? w.sun_wm2 : 0;
  const rows = conductors.map((c) => {
    const st = ampacityFor(c, STATIC.ta, STATIC.wind, STATIC.sun, STATIC.angle);
    const aar = ampacityFor(c, ta, AAR_WIND, aarSun(sun), 90);
    const dlrc = ampacityFor(c, ta, ws * 0.5, sun, 45);
    return {
      key: c.key, name: c.name, static_A: Math.round(st),
      aar_ratio: st > 0 ? aar / st : 0,
      dlr_ratio: st > 0 ? dlrc / st : 0,
    };
  });
  const a = rows.map((r) => r.aar_ratio), d = rows.map((r) => r.dlr_ratio);
  return {
    rows,
    aar_min: Math.min(...a), aar_max: Math.max(...a),
    dlr_min: Math.min(...d), dlr_max: Math.max(...d),
  };
}

export function heatwaveWeather(): WeatherNow {
  return { temp_c: 40.6, wind_ms: 0.3, sun_wm2: 1000, time: new Date().toISOString(), source: "heatwave-scenario" };
}

/** Month-day-hour key in the 2025 CSVs, which use a fixed UTC-8 offset (no DST). 2025 has no Feb 29, so it maps to Feb 28. */
function csvKeyFor(now: Date): string {
  const t = new Date(now.getTime() - 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const m = t.getUTCMonth() + 1;
  const d = m === 2 && t.getUTCDate() === 29 ? 28 : t.getUTCDate();
  return `2025-${p(m)}-${p(d)}T${p(t.getUTCHours())}:00`;
}

async function fallbackWeather(lat: number, lon: number, data: GridData): Promise<WeatherNow> {
  const site = nearestSite(data.ratingSites, lat, lon);
  const rows = await loadRatingCsv(site.key);
  const key = csvKeyFor(new Date());
  const row = rows.find((r) => r.time === key) ?? rows.find((r) => r.time.slice(5) === key.slice(5)) ?? rows[0];
  return { temp_c: row.temp_c, wind_ms: row.wind_ms, sun_wm2: row.sun_wm2, time: row.time, source: "fallback-2025" };
}

export async function fetchWeatherNow(lat: number, lon: number, data: GridData): Promise<WeatherNow> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const url =
      "https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(4) + "&longitude=" + lon.toFixed(4) +
      "&current=temperature_2m,wind_speed_10m,shortwave_radiation&wind_speed_unit=ms&timezone=America%2FLos_Angeles";
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const j = (await res.json()) as {
      current?: { time?: string; temperature_2m?: number; wind_speed_10m?: number; shortwave_radiation?: number };
    };
    const c = j.current;
    if (!c || ![c.temperature_2m, c.wind_speed_10m, c.shortwave_radiation].every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new Error("open-meteo: missing current fields");
    }
    return {
      temp_c: c.temperature_2m as number,
      wind_ms: c.wind_speed_10m as number,
      sun_wm2: c.shortwave_radiation as number,
      time: c.time ?? new Date().toISOString(),
      source: "open-meteo-live",
    };
  } catch {
    return fallbackWeather(lat, lon, data);
  } finally {
    clearTimeout(timer);
  }
}
