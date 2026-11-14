// Compliance report engine. Pure (no React). Every auto-issue is built only from real fields
// on the clicked asset or the scan result; nothing is guessed. Wording is for a 10-year-old.
import type { LineRatingNow, ScanResult } from "./types";
import type { ReportTarget } from "./target";
import { FUEL_CATEGORY, FUEL_LABELS } from "./colors";
import { haversineMi } from "./geo";
import { heatwaveWeather, rateLine } from "./rating";
import { kvLabel, lineName, substationName } from "./labels";
import { cToF, fmtCoord, fmtNum, fmtPowerText, isNum } from "@/components/scan/panel/format";

export type Severity = "info" | "warn" | "danger";

export interface ReportIssue { text: string; severity: Severity }

export interface ReportContact { name: string; url: string }

export interface ReportDraft {
  title: string;
  assetLabel: string;
  location: { lat: number; lon: number; text: string };
  issues: ReportIssue[];
  contact: ReportContact;
  createdAt?: string;
}

export type HazardId = "tree" | "wire_down" | "sparks" | "outage" | "old_broken" | "other";

export const HAZARDS: { id: HazardId; label: string }[] = [
  { id: "tree", label: "Tree touching a wire" },
  { id: "wire_down", label: "Wire on the ground" },
  { id: "sparks", label: "Sparks or fire" },
  { id: "outage", label: "Power is out" },
  { id: "old_broken", label: "Looks old or broken" },
  { id: "other", label: "Something else" },
];

/** A report the user filed (saved on this device). */
export interface FiledReport extends ReportDraft {
  id: string;
  createdAt: string; // ISO
  hazards: HazardId[];
  note: string;
  /** Report body written by Claude (POST /api/ai-report). Absent on rule-based and older reports. */
  aiText?: string;
}

export const REPORTS_KEY = "gs-reports-v1";
export const SAFETY_LINE = "If a wire is down or anyone is in danger, call 911 first.";

/* ------------------------------------------------------------- contacts */

export const CONTACTS = {
  sce: { name: "Southern California Edison (SCE)", url: "https://www.sce.com/outage-center" },
  ladwp: { name: "Los Angeles Department of Water and Power (LADWP)", url: "https://www.ladwp.com/outages" },
  sdge: { name: "San Diego Gas & Electric (SDG&E)", url: "https://www.sdge.com/outage-map" },
  cpuc: { name: "California Public Utilities Commission (CPUC)", url: "https://www.cpuc.ca.gov/consumer-support/file-a-complaint" },
} as const satisfies Record<string, ReportContact>;

type UtilityKey = "sce" | "ladwp" | "sdge";

function matchUtility(text: string | null | undefined): UtilityKey | null {
  if (!text) return null;
  if (/southern california edison|socal edison|\bSCE\b/i.test(text)) return "sce";
  if (/los angeles department of water|\bLADWP\b/i.test(text)) return "ladwp";
  if (/san diego gas|\bSDG&?E\b/i.test(text)) return "sdge";
  return null;
}

/** Contact for one operator/utility text; CPUC when it is not SCE, LADWP or SDG&E. */
export function contactFor(text: string | null | undefined): ReportContact {
  const k = matchUtility(text);
  return k ? CONTACTS[k] : CONTACTS.cpuc;
}

/** Area contact: the utility named most often by the lines and substations inside the scan. */
function areaContact(result: ScanResult): ReportContact {
  const counts: Record<UtilityKey, number> = { sce: 0, ladwp: 0, sdge: 0 };
  for (const l of result.lines) { const k = matchUtility(l.operator); if (k) counts[k]++; }
  for (const s of result.substations) { const k = matchUtility(s.operator); if (k) counts[k]++; }
  const best = (Object.keys(counts) as UtilityKey[]).sort((a, b) => counts[b] - counts[a])[0];
  return counts[best] > 0 ? CONTACTS[best] : CONTACTS.cpuc;
}

/* ------------------------------------------------------------- helpers */

const pctOf = (ratio: number) => fmtNum(ratio * 100, 0);

function lineLengthMi(coords: [number, number][]): number {
  let mi = 0;
  for (let i = 1; i < coords.length; i++) {
    mi += haversineMi(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return mi;
}

/** Heat-wave screening check (105 °F, almost no wind, full sun; typical ACSR "Drake" wire). */
function heatwaveIssue(heatwave: boolean, subject: string, plural = false): ReportIssue | null {
  const hw = rateLine(heatwaveWeather());
  if (!isNum(hw.ratio) || hw.ratio >= 1) return null;
  const tempF = fmtNum(cToF(hw.weather.temp_c), 0);
  return {
    severity: heatwave ? "warn" : "info",
    text:
      `${subject} would overheat on a ${tempF} °F day with almost no wind if ${plural ? "they" : "it"} carried ` +
      `${plural ? "their" : "its"} normal load. ${plural ? "They" : "It"} could safely carry only about ` +
      `${pctOf(hw.ratio)}% of normal. (Computer estimate for a typical wire.)`,
  };
}

/** Live weather check, only when the weather really is live (not the 2025 fallback or the heat-wave scenario). */
function liveIssue(live: LineRatingNow | null, heatwave: boolean, subject: string): ReportIssue | null {
  if (heatwave || !live || live.weather.source !== "open-meteo-live") return null;
  if (!isNum(live.ratio) || live.ratio >= 1) return null;
  return {
    severity: "warn",
    text:
      `Right now it is ${fmtNum(cToF(live.weather.temp_c), 0)} °F here. ${subject} can safely carry only about ` +
      `${pctOf(live.ratio)}% of normal in this weather. (Computer estimate for a typical wire.)`,
  };
}

function missingIssue(kind: string, missing: string[]): ReportIssue | null {
  if (missing.length === 0) return null;
  const what = missing.join(" and ");
  return { severity: "info", text: `This ${kind}'s ${what} ${missing.length > 1 ? "are" : "is"} missing from public records.` };
}

function finish(issues: (ReportIssue | null)[]): ReportIssue[] {
  const out = issues.filter((x): x is ReportIssue => x !== null);
  if (!out.some((i) => i.severity !== "info")) {
    out.push({ severity: "info", text: "Nothing serious found in the public data we checked." });
  }
  return out;
}

/* ------------------------------------------------------------- buildDraft */

export function buildDraft(
  target: ReportTarget,
  result: ScanResult,
  live: LineRatingNow | null,
  heatwave: boolean,
): ReportDraft {
  if (target.kind === "plant") {
    const p = target.plant;
    const fuel = FUEL_LABELS[p.primary_source] ?? "Other";
    const name = p.plant_name.trim() || `${fuel} power plant${p.city ? ` in ${p.city}` : ""}`;
    const age = p.capacity_weighted_age_years;
    const issues: (ReportIssue | null)[] = [];
    if (isNum(age) && age >= 40) {
      issues.push({
        severity: age >= 60 ? "danger" : "warn",
        text: `Most of this plant's machines are about ${fmtNum(age, 0)} years old. That is ${age >= 60 ? "very old" : "old"} for a power plant.`,
      });
    }
    if (isNum(p.planned_retirement_mw) && p.planned_retirement_mw > 0) {
      issues.push({ severity: "info", text: `The owner plans to shut down ${fmtPowerText(p.planned_retirement_mw)} here.` });
    }
    if (FUEL_CATEGORY[p.primary_source] === "fossil") {
      issues.push({ severity: "info", text: `It mostly burns ${fuel.toLowerCase()}, which puts pollution and CO2 into the air.` });
    }
    const missing: string[] = [];
    if (!p.plant_name.trim()) missing.push("name");
    if (p.grid_voltage_kv === null) missing.push("grid voltage");
    issues.push(missingIssue("plant", missing));
    const place = [p.city, p.county ? `${p.county} County` : ""].filter(Boolean).join(", ");
    return {
      title: `Problem report: ${name}`,
      assetLabel: `${name} (${fmtPowerText(p.nameplate_mw)} ${fuel.toLowerCase()} power plant${p.utility_name ? `, owner: ${p.utility_name}` : ""})`,
      location: { lat: p.lat, lon: p.lon, text: place ? `${place} (${fmtCoord(p.lat, p.lon)})` : fmtCoord(p.lat, p.lon) },
      issues: finish(issues),
      contact: contactFor(p.utility_name),
    };
  }

  if (target.kind === "substation") {
    const s = target.substation;
    const name = substationName(s);
    const missing: string[] = [];
    if (!s.name) missing.push("name");
    if (s.voltage_kv === null) missing.push("voltage");
    const details = [kvLabel(s.voltage_kv, s.kv_inferred), s.operator ? `run by ${s.operator}` : null].filter(Boolean);
    const label = /substation/i.test(name) ? name : `${name} substation`;
    return {
      title: `Problem report: ${name}`,
      assetLabel: details.length ? `${label}, ${details.join(", ")}` : label,
      location: { lat: s.lat, lon: s.lon, text: fmtCoord(s.lat, s.lon) },
      issues: finish([missingIssue("substation", missing)]),
      contact: contactFor(s.operator),
    };
  }

  if (target.kind === "line") {
    const l = target.line;
    const name = lineName(l);
    const mid = l.coords[Math.floor(l.coords.length / 2)] ?? [result.area.lat, result.area.lon];
    const missing: string[] = [];
    if (!l.name) missing.push("name");
    if (l.voltage_kv === null) missing.push("voltage");
    const len = lineLengthMi(l.coords);
    const label = /line/i.test(name) ? name : `${name} power line`;
    const details = [
      /\bkV\b/.test(name) ? null : kvLabel(l.voltage_kv, l.kv_inferred),
      `${fmtNum(len, 1)} mi long`,
      l.operator ? `run by ${l.operator}` : null,
    ].filter(Boolean);
    return {
      title: `Problem report: ${name}`,
      assetLabel: `${label}, ${details.join(", ")}`,
      location: { lat: mid[0], lon: mid[1], text: `Middle of the line: ${fmtCoord(mid[0], mid[1])}` },
      issues: finish([
        heatwaveIssue(heatwave, "This power line"),
        liveIssue(live, heatwave, "This power line"),
        missingIssue("power line", missing),
      ]),
      contact: contactFor(l.operator),
    };
  }

  // area
  const a = result.area;
  const issues: (ReportIssue | null)[] = [];
  const lvl = result.risk.level;
  if (lvl === "HIGH" || lvl === "CRITICAL") {
    const top = [...result.risk.factors].sort((x, y) => y.score * y.weight - x.score * x.weight)[0];
    issues.push({
      severity: lvl === "CRITICAL" ? "danger" : "warn",
      text:
        `GridSentinel's own risk index rated this area ${lvl === "CRITICAL" ? "critical" : "high"}: ${fmtNum(result.risk.score, 0)} out of 100.` +
        (top ? ` The biggest reason: ${top.label.toLowerCase()}.` : ""),
    });
  }
  if (result.lines.length > 0) {
    const n = result.lines.length;
    issues.push(n === 1 ? heatwaveIssue(heatwave, "The power line here") : heatwaveIssue(heatwave, `The ${fmtNum(n, 0)} power lines here`, true));
    issues.push(liveIssue(live, heatwave, "Power lines here"));
  }
  if (isNum(result.totals.planned_retirement_mw) && result.totals.planned_retirement_mw > 0) {
    issues.push({
      severity: "info",
      text: `Power plant owners here plan to shut down ${fmtPowerText(result.totals.planned_retirement_mw)} of power.`,
    });
  }
  return {
    title: `Problem report: ${result.area_label} (area)`,
    assetLabel: `The area within ${fmtNum(a.radius_mi, 0)} mi of ${result.area_label}`,
    location: { lat: a.lat, lon: a.lon, text: `Center: ${fmtCoord(a.lat, a.lon)}` },
    issues: finish(issues),
    contact: areaContact(result),
  };
}

/* ------------------------------------------------------------- text, email */

const SEVERITY_WORD: Record<Severity, string> = { info: "Note", warn: "Watch", danger: "Serious" };
export const severityWord = (s: Severity) => SEVERITY_WORD[s];

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function reportText(r: FiledReport): string {
  const mapUrl = `https://www.openstreetmap.org/?mlat=${r.location.lat.toFixed(5)}&mlon=${r.location.lon.toFixed(5)}#map=16/${r.location.lat.toFixed(5)}/${r.location.lon.toFixed(5)}`;
  if (r.aiText && r.aiText.trim()) {
    const head: string[] = [
      r.title,
      `Filed: ${fmtWhen(r.createdAt)}`,
      `What: ${r.assetLabel}`,
      `Where: ${r.location.text}`,
      `Map: ${mapUrl}`,
      `Who to contact: ${r.contact.name} - ${r.contact.url}`,
    ];
    if (r.note.trim()) head.push(`Reporter's note: ${r.note.trim()}`);
    return [
      ...head,
      "",
      r.aiText.trim(),
      "",
      SAFETY_LINE,
      "Made with GridSentinel. Report written by Claude from public data.",
    ].join("\n");
  }
  const hazards = r.hazards
    .map((id) => HAZARDS.find((h) => h.id === id)?.label)
    .filter((x): x is string => !!x);
  const lines: string[] = [
    r.title,
    `Filed: ${fmtWhen(r.createdAt)}`,
    "",
    `What: ${r.assetLabel}`,
    `Where: ${r.location.text}`,
    `Map: ${mapUrl}`,
    "",
    "What's wrong:",
    ...(hazards.length ? hazards.map((h) => `- ${h}`) : ["- (nothing picked)"]),
  ];
  if (r.note.trim()) lines.push("", `Note: ${r.note.trim()}`);
  lines.push(
    "",
    "What we checked (from public data):",
    ...r.issues.map((i) => `- [${SEVERITY_WORD[i.severity]}] ${i.text}`),
    "",
    `Who to contact: ${r.contact.name} - ${r.contact.url}`,
    "",
    SAFETY_LINE,
    "Made with GridSentinel.",
  );
  return lines.join("\n");
}

export const MAIL_BODY_MAX = 1800;

/** mailto: with an empty recipient so the user's own email app opens and they pick who to send to. */
export function mailtoHref(r: FiledReport): string {
  let body = reportText(r);
  if (body.length > MAIL_BODY_MAX) {
    const tail = "\n... (full report in the download)";
    body = body.slice(0, MAIL_BODY_MAX - tail.length) + tail;
  }
  return `mailto:?subject=${encodeURIComponent(r.title)}&body=${encodeURIComponent(body)}`;
}

export function reportFileName(r: FiledReport): string {
  const slug = r.title.replace(/^Problem report:\s*/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `gridsentinel-report-${slug || "report"}-${r.createdAt.slice(0, 10)}.txt`;
}

/* ------------------------------------------------------------- storage */

function isFiled(x: unknown): x is FiledReport {
  if (!x || typeof x !== "object") return false;
  const r = x as Partial<FiledReport>;
  return (
    typeof r.id === "string" && typeof r.title === "string" && typeof r.createdAt === "string" &&
    typeof r.assetLabel === "string" && !!r.location && typeof r.location.lat === "number" &&
    typeof r.location.lon === "number" && Array.isArray(r.issues) && Array.isArray(r.hazards) &&
    !!r.contact && typeof r.contact.url === "string"
  );
}

/** Reports saved on this device, newest first. Returns [] when storage is unavailable or broken. */
export function loadReports(): FiledReport[] {
  try {
    const raw = window.localStorage.getItem(REPORTS_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(isFiled)
      .map((r) => {
        const { aiText, ...rest } = r;
        return {
          ...rest,
          note: typeof r.note === "string" ? r.note : "",
          ...(typeof aiText === "string" && aiText.trim() ? { aiText } : {}),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

/** Returns false when the browser blocks storage (private mode, full, etc.). */
export function saveReports(reports: FiledReport[]): boolean {
  try {
    window.localStorage.setItem(REPORTS_KEY, JSON.stringify(reports));
    return true;
  } catch {
    return false;
  }
}

export function fileReport(
  draft: ReportDraft,
  hazards: HazardId[],
  note: string,
  now = new Date(),
  aiText?: string,
): FiledReport {
  const createdAt = now.toISOString();
  return {
    ...draft,
    id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt,
    hazards: [...hazards],
    note: note.trim(),
    ...(aiText && aiText.trim() ? { aiText: aiText.trim() } : {}),
  };
}
