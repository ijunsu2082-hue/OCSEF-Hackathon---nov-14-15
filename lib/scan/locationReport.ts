// ScanArea and ScanPoint are the same {lat, lon, radius_mi} shape; PR #2 ships
// its own `./types`, this branch has no such module.
import type { ScanPoint as ScanArea } from "./areaScan";

/** Stable, shareable report route for one exact scan area. */
export function locationReportId(area: ScanArea): string {
  return `area_${area.lat.toFixed(4)}_${area.lon.toFixed(4)}_${area.radius_mi.toFixed(1)}`;
}

export function locationReportUrl(area: ScanArea): string {
  return `/location-report/${locationReportId(area)}`;
}

export function parseLocationReportId(id: string): ScanArea | null {
  const match = /^area_(-?\d{1,3}\.\d{4})_(-?\d{1,3}\.\d{4})_(\d{1,3}(?:\.\d)?)$/.exec(id);
  if (!match) return null;
  const area = { lat: Number(match[1]), lon: Number(match[2]), radius_mi: Number(match[3]) };
  if (
    !Number.isFinite(area.lat) || !Number.isFinite(area.lon) || !Number.isFinite(area.radius_mi) ||
    area.lat < -90 || area.lat > 90 || area.lon < -180 || area.lon > 180 ||
    area.radius_mi <= 0 || area.radius_mi > 100
  ) return null;
  return area;
}
