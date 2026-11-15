import type { Line, Substation } from "./types";
import { haversineMi } from "./geo";

/*
 * Display names for map assets. Never returns placeholder words for missing
 * data: falls back to "near <city>" and then to the plain asset type.
 */

export function substationName(s: Substation): string {
  if (s.name) return s.name;
  if (s.near) return `Substation near ${s.near}`;
  return "Substation";
}

export function lineName(l: Line): string {
  if (l.name) return l.name;
  if (l.near) {
    return l.voltage_kv != null && Number.isFinite(l.voltage_kv)
      ? `${Math.round(l.voltage_kv)} kV power line near ${l.near}`
      : `Power line near ${l.near}`;
  }
  return "Power line";
}

/** null when kv is missing, so callers omit the row instead of printing a placeholder. */
export function kvLabel(kv: number | null, inferred?: boolean): string | null {
  if (kv == null || !Number.isFinite(kv)) return null;
  const base = `${Math.round(kv)} kV`;
  return inferred ? `${base} (from connected lines)` : base;
}

export function lineMiles(l: Line): number {
  let mi = 0;
  const c = l.coords;
  for (let i = 1; i < c.length; i++) mi += haversineMi(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
  return mi;
}
