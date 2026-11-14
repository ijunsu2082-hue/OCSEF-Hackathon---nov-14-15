// Port of research/scripts/line_rating.py (simplified IEEE Std 738 steady-state heat balance).
// Conductor ACSR 795 kcmil "Drake", max conductor temp 75 C. Screening model, NOT an operating rating.
import type { GridData, LineRatingNow, WeatherNow } from "./types";
import { loadRatingCsv, nearestSite } from "./data";

const D = 0.02814; // conductor diameter, m
const R25 = 7.283e-5, R75 = 8.688e-5; // ohm/m AC resistance at 25 C and 75 C
const TC = 75.0;
const EPS = 0.8, ALPHA = 0.8;
const ELEV = 100.0;
const STATIC = { ta: 40.0, wind: 0.61, sun: 1000.0, angle: 90.0 };
const AAR_WIND = 0.61;

const rAt = (tc: number) => R25 + ((R75 - R25) * (tc - 25)) / 50;

export function ampacity(ta: number, wind: number, sun: number, angleDeg: number, tc = TC): number {
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
  return net > 0 ? Math.sqrt(net / rAt(tc)) : 0;
}

const STATIC_A = ampacity(STATIC.ta, STATIC.wind, STATIC.sun, STATIC.angle);

export function rateLine(w: WeatherNow): LineRatingNow {
  const ta = Number.isFinite(w.temp_c) ? w.temp_c : STATIC.ta;
  const ws = Number.isFinite(w.wind_ms) ? w.wind_ms : 0;
  const sun = Number.isFinite(w.sun_wm2) ? w.sun_wm2 : 0;
  const aar = ampacity(ta, AAR_WIND, sun, 90);
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
