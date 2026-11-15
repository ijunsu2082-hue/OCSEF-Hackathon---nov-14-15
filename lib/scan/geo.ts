import type { KvBand } from "./types";

export const CENTER: { lat: number; lon: number; name: string } = { lat: 33.7538, lon: -118.0111, name: "Westminster HS" };
export const COVERAGE_MI: number = 100;

const R_MI = 3958.7613;
const RAD = Math.PI / 180;

export function haversineMi(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Degrees of latitude / longitude spanned by `mi` miles at latitude `lat` (for bbox prefilters). */
export function degSpan(mi: number, lat: number): { dLat: number; dLon: number } {
  const dLat = mi / 69.0;
  const cos = Math.max(0.01, Math.cos(lat * RAD));
  return { dLat, dLon: mi / (69.172 * cos) };
}

export function kvBand(kv: number | null): KvBand {
  if (kv === null || !Number.isFinite(kv)) return "unknown";
  if (kv >= 500) return "500+";
  if (kv >= 200) return "200-499";
  if (kv >= 100) return "100-199";
  return "<100";
}

export function lineWeight(kv: number | null): number {
  switch (kvBand(kv)) {
    case "500+": return 3;
    case "200-499": return 2;
    case "100-199": return 1.25;
    default: return 0.75;
  }
}

export const clamp = (x: number, lo = 0, hi = 100): number =>
  Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;

export const round = (x: number, d = 1): number => {
  const f = 10 ** d;
  return Number.isFinite(x) ? Math.round(x * f) / f : 0;
};
