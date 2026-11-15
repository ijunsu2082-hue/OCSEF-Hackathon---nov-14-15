/** Panel number formatting. Every helper returns "—" for null / NaN / Infinity, never "NaN". */

export const DASH = "—";

export function isNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Thousands separators, fixed decimals. */
export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (!isNum(n)) return DASH;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Power: "1.24 GW" above 1000 MW, else MW with 0–1 decimals. */
export function fmtPower(mw: number | null | undefined): { value: string; unit: string } {
  if (!isNum(mw)) return { value: DASH, unit: "" };
  if (Math.abs(mw) >= 1000) return { value: fmtNum(mw / 1000, 2), unit: "GW" };
  if (mw === 0) return { value: "0", unit: "MW" };
  return { value: fmtNum(mw, Math.abs(mw) < 100 ? 1 : 0), unit: "MW" };
}

export function fmtPowerText(mw: number | null | undefined): string {
  const p = fmtPower(mw);
  return p.unit ? `${p.value} ${p.unit}` : p.value;
}

export function fmtPct(n: number | null | undefined, digits = 0): string {
  return isNum(n) ? `${fmtNum(n, digits)}%` : DASH;
}

export function fmtRatio(n: number | null | undefined): string {
  return isNum(n) ? `${n.toFixed(2)}×` : DASH;
}

export function fmtCoord(lat: number, lon: number): string {
  if (!isNum(lat) || !isNum(lon)) return DASH;
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}`;
}

export function cToF(c: number): number {
  return (c * 9) / 5 + 32;
}

/** "2024-09-06T14:00" -> "Sep 6, 2024 · 14:00" (no Date parsing so no TZ drift). */
export function fmtHour(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = months[Number(m[2]) - 1] ?? m[2];
  const base = `${mon} ${Number(m[3])}, ${m[1]}`;
  return m[4] ? `${base} · ${m[4]}:${m[5]}` : base;
}

/** "2024-03-07" -> "Mar" for chart ticks. */
export function monthTick(date: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mm = Number(String(date).slice(5, 7));
  return months[mm - 1] ?? "";
}
