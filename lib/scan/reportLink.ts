import type { ScanArea } from "./types";

/*
 * Shareable report link for one scan circle: /location-report/area_<lat>_<lon>_<radiusMi>,
 * e.g. /location-report/area_33.7538_-118.0111_5. Coordinates keep 4 decimals (about 11 m);
 * the radius is a whole number of miles clamped to the /scan slider range.
 */

/** Same range and step as the radius slider in the /scan top bar. */
export const REPORT_RADIUS_MIN = 1;
export const REPORT_RADIUS_MAX = 30;

export const REPORT_PATH = "/location-report";

/** Whole miles inside the slider range. Non-finite input falls back to the minimum. */
export function clampReportRadius(r: number): number {
  if (!Number.isFinite(r)) return REPORT_RADIUS_MIN;
  return Math.min(REPORT_RADIUS_MAX, Math.max(REPORT_RADIUS_MIN, Math.round(r)));
}

const fix4 = (x: number): string => {
  const s = x.toFixed(4);
  return s === "-0.0000" ? "0.0000" : s;
};

/** "area_33.7538_-118.0111_5" */
export function reportIdFor(lat: number, lon: number, radiusMi: number): string {
  return `area_${fix4(lat)}_${fix4(lon)}_${clampReportRadius(radiusMi)}`;
}

/**
 * Path to the report page, or an absolute URL when `origin` is given
 * (e.g. reportUrl(lat, lon, r, window.location.origin)).
 */
export function reportUrl(lat: number, lon: number, radiusMi: number, origin?: string): string {
  const path = `${REPORT_PATH}/${reportIdFor(lat, lon, radiusMi)}`;
  return origin ? `${origin.replace(/\/+$/, "")}${path}` : path;
}

const ID_RE = /^area_(-?\d{1,3}(?:\.\d{1,8})?)_(-?\d{1,3}(?:\.\d{1,8})?)_(\d{1,4}(?:\.\d{1,4})?)$/;

/**
 * Parse a report id back to a scan circle. Returns null for anything malformed or
 * off the globe; an out-of-range radius is clamped rather than rejected.
 */
export function parseReportId(id: string): ScanArea | null {
  let raw = id;
  try {
    raw = decodeURIComponent(id);
  } catch {
    return null;
  }
  const m = ID_RE.exec(raw.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  const r = Number(m[3]);
  if (![lat, lon, r].every(Number.isFinite)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat: Number(fix4(lat)), lon: Number(fix4(lon)), radius_mi: clampReportRadius(r) };
}
