import type { PrefillField } from "@/lib/owner/types";

/*
 * Pure date, iCalendar and CSV helpers for the owner screens. All dates are
 * ISO calendar dates (YYYY-MM-DD) compared as local calendar days, no time zones.
 */

/** Today's local date as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isoToUtcMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((isoToUtcMs(b) - isoToUtcMs(a)) / 86_400_000);
}

export function addDaysIso(iso: string, n: number): string {
  const t = new Date(isoToUtcMs(iso) + n * 86_400_000);
  return t.toISOString().slice(0, 10);
}

export type Urgency = "overdue" | "soon" | "later" | "done";

/** Overdue = past due and not filed; soon = due within 30 days. */
export function urgency(due: string, today: string, filed: boolean): Urgency {
  if (filed) return "done";
  const d = daysBetween(today, due);
  if (d < 0) return "overdue";
  if (d <= 30) return "soon";
  return "later";
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-12" -> "December 2026". */
export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** "2026-12-31" -> "Dec 31, 2026". */
export function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`;
}

/** Group items by YYYY-MM of their due date, months in date order. */
export function groupByMonth<T extends { due: string }>(items: T[]): { month: string; items: T[] }[] {
  const map = new Map<string, T[]>();
  for (const it of [...items].sort((a, b) => a.due.localeCompare(b.due))) {
    const k = it.due.slice(0, 7);
    const list = map.get(k);
    if (list) list.push(it);
    else map.set(k, [it]);
  }
  return [...map.entries()].map(([month, list]) => ({ month, items: list }));
}

/* ---------------------------------------------------------------- iCalendar (RFC 5545) */

export interface IcsEvent {
  uid: string;
  date: string; // YYYY-MM-DD, all-day
  summary: string;
  description?: string;
  url?: string;
}

/** Escape TEXT values (RFC 5545 3.3.11). */
export function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold a content line at 75 octets without splitting a UTF-8 character (RFC 5545 3.1). */
export function icsFold(line: string): string {
  const enc = new TextEncoder();
  const parts: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
      limit = 74; // continuation lines start with one space
    }
    cur += ch;
    curBytes += b;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function buildIcs(events: IcsEvent[], now: Date = new Date()): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Mapergy//Owner filings//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Owner filings",
  ];
  const dtstamp = stamp(now);
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(e.uid)}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${e.date.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${addDaysIso(e.date, 1).replace(/-/g, "")}`,
      `SUMMARY:${icsEscape(e.summary)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push("TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

/* ---------------------------------------------------------------- CSV */

function csvCell(s: string): string {
  // Neutralize spreadsheet formulas from public-data text (=, +, -, @, tab, CR).
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function prefillCsv(fields: PrefillField[]): string {
  const rows = [["Field", "Value", "Source"], ...fields.map((f) => [f.label, f.value, f.source])];
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Trigger a browser download of text content. */
export function downloadText(filename: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "filing";
}
