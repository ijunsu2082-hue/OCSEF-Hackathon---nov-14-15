// "Line right now": weather on one selected power line, with the real wind angle to the wire.
// Pure helpers (no fetch, no React). Ratings come from lib/scan/rating.ts (ampacityFor, DRAKE, STATIC,
// aarSun) so the numbers match the hero; only the wind angle differs from rateLine(), which assumes 45 deg.
import { DRAKE, STATIC, aarSun, ampacityFor, heatwaveWeather } from "./rating";
import type { WeatherNow } from "./types";

const R_KM = 6371.0088;
const AAR_WIND = 0.61;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance (km) between two [lat, lon] points. */
function distKm(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a -> b, degrees clockwise from north, 0..360. Points are [lat, lon]. */
function bearing(a: [number, number], b: [number, number]): number {
  const p1 = rad(a[0]), p2 = rad(b[0]), dl = rad(b[1] - a[1]);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Segment index holding the half-length point, and the fraction along it. Null for < 2 distinct points. */
function midSegment(coords: [number, number][]): { i: number; f: number } | null {
  if (coords.length < 2) return null;
  const lens = coords.slice(1).map((p, i) => distKm(coords[i], p));
  const total = lens.reduce((s, l) => s + l, 0);
  if (!(total > 0)) return null;
  let left = total / 2;
  for (let i = 0; i < lens.length; i++) {
    if (left <= lens[i] || i === lens.length - 1) return { i, f: lens[i] > 0 ? Math.min(1, left / lens[i]) : 0 };
    left -= lens[i];
  }
  return null;
}

/**
 * Point halfway along the line (by length), [lat, lon] like Line.coords.
 * Linear interpolation inside the segment, fine for spans of a few km.
 */
export function corridorMidpoint(coords: [number, number][]): [number, number] | null {
  if (coords.length === 0) return null;
  const m = midSegment(coords);
  if (!m) return [coords[0][0], coords[0][1]];
  const a = coords[m.i], b = coords[m.i + 1];
  return [a[0] + (b[0] - a[0]) * m.f, a[1] + (b[1] - a[1]) * m.f];
}

/** Bearing (0..360, clockwise from north) of the segment at the line's midpoint. Null if the line has no length. */
export function corridorBearingDeg(coords: [number, number][]): number | null {
  const m = midSegment(coords);
  return m ? bearing(coords[m.i], coords[m.i + 1]) : null;
}

/**
 * Angle between the wind and the wire, 0..90 deg (0 = wind along the line, 90 = straight across).
 * A line has no direction, and wind from either side cools the same, so the result folds to 0..90.
 */
export function windAngleToLine(windFromDeg: number, lineBearingDeg: number): number {
  const d = (((windFromDeg - lineBearingDeg) % 180) + 180) % 180; // 0..180
  return d > 90 ? 180 - d : d;
}

/**
 * IEEE Std 738 wind-direction factor, φ = angle between wind and conductor axis:
 *   K_angle = 1.194 − cos φ + 0.194 cos 2φ + 0.368 sin 2φ
 * 1.0 at 90° (crosswind), about 0.388 at 0° (wind along the wire).
 * Same formula ampacityFor() in rating.ts applies internally; exported here for display and tests.
 */
export function kAngle(angleDeg: number): number {
  const p = rad(angleDeg);
  return 1.194 - Math.cos(p) + 0.194 * Math.cos(2 * p) + 0.368 * Math.sin(2 * p);
}

/** Fixed worst-case rating of the typical wire (Drake), A. About 723 A. Same as rateLine().static_A. */
export const FIXED_A = ampacityFor(DRAKE, STATIC.ta, STATIC.wind, STATIC.sun, STATIC.angle);

/** rateLine() assumes this angle when the real wind direction is unknown. */
export const DEFAULT_ANGLE = 45;

export interface CorridorRating {
  fixed_A: number;
  /** Real temp + sun, real wind halved for safety, at `angle_deg` to the line. */
  now_A: number;
  now_ratio: number;
  /** Still air (0.61 m/s crosswind), real temp, day/night sun: the hero's temperature-only rating. */
  still_A: number;
  still_ratio: number;
  /** 105 °F heatwave scenario (heatwaveWeather()), its wind halved, at the same angle. */
  hot_A: number;
  hot_ratio: number;
  angle_deg: number;
  /** False when the wind direction was unknown and DEFAULT_ANGLE was used. */
  angle_known: boolean;
}

/**
 * Rate the typical wire on this line with the real wind angle. `angleDeg` null -> 45° like rateLine().
 * Thin wrapper over ampacityFor(); no new heat-balance math.
 */
export function rateCorridor(w: WeatherNow, angleDeg: number | null): CorridorRating {
  const angle_known = angleDeg !== null && Number.isFinite(angleDeg);
  const angle = angle_known ? Math.min(90, Math.max(0, angleDeg as number)) : DEFAULT_ANGLE;
  const ta = Number.isFinite(w.temp_c) ? w.temp_c : STATIC.ta;
  const ws = Number.isFinite(w.wind_ms) ? w.wind_ms : 0;
  const sun = Number.isFinite(w.sun_wm2) ? w.sun_wm2 : 0;
  const hw = heatwaveWeather();
  const now_A = ampacityFor(DRAKE, ta, ws * 0.5, sun, angle);
  const still_A = ampacityFor(DRAKE, ta, AAR_WIND, aarSun(sun), 90);
  const hot_A = ampacityFor(DRAKE, hw.temp_c, hw.wind_ms * 0.5, hw.sun_wm2, angle);
  const r = (a: number) => (FIXED_A > 0 ? a / FIXED_A : 0);
  return {
    fixed_A: FIXED_A,
    now_A, now_ratio: r(now_A),
    still_A, still_ratio: r(still_A),
    hot_A, hot_ratio: r(hot_A),
    angle_deg: angle,
    angle_known,
  };
}
