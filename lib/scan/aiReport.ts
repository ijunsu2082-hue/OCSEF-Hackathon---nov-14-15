// Client side of the AI report: builds a compact facts object (only real numbers from the scan)
// and streams the report text from the Netlify Function at /api/ai-report. No API key here.
import type { LineRatingNow, ScanResult } from "./types";
import type { ReportTarget } from "./target";
import type { HazardId, ReportDraft } from "./compliance";
import { HAZARDS } from "./compliance";
import { FUEL_LABELS } from "./colors";
import { heatwaveWeather, rateLine } from "./rating";
import { kvLabel, lineMiles, lineName, substationName } from "./labels";

export const AI_REPORT_URL = "/api/ai-report";
const MAX_FACTS_BYTES = 4000;

export interface AiFacts {
  asset: { kind: ReportTarget["kind"]; name: string; details: string[] };
  location: string;
  area: {
    name: string;
    radius_mi: number;
    plants: number;
    total_mw: number;
    renewable_pct: number;
    storage_pct: number;
    fossil_pct: number;
    capacity_weighted_age_years?: number;
    planned_retirement_mw: number;
    retired_mw: number;
    proposed_mw: number;
    proposed_storage_mw: number;
    line_miles: number;
    substations_200kv_plus: number;
  };
  line_rating_now?: { ratio: number; meaning: string; weather: string };
  heatwave: { ratio: number; scenario: string; heatwave_mode_on: boolean };
  risk: { score: number; level: string; top_factors: { label: string; score: number; detail: string }[] };
  upgrade_ideas: string[];
  nearby_stories: { title: string; shock_line: string }[];
  checks: { severity: string; text: string }[];
  hazards: string[];
  note?: string;
  contact: { name: string; url: string };
}

const r0 = (x: number) => Math.round(x);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? r1((part / whole) * 100) : 0);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const cToF = (c: number) => (c * 9) / 5 + 32;

function assetFacts(target: ReportTarget, result: ScanResult): AiFacts["asset"] {
  if (target.kind === "plant") {
    const p = target.plant;
    const fuel = FUEL_LABELS[p.primary_source] ?? "Other";
    const details = [
      `${r1(p.nameplate_mw)} MW ${fuel.toLowerCase()} power plant`,
      p.utility_name ? `owner: ${p.utility_name}` : null,
      p.capacity_weighted_age_years !== null ? `capacity-weighted age ${r0(p.capacity_weighted_age_years)} years` : null,
      p.planned_retirement_mw > 0 ? `planned retirement ${r1(p.planned_retirement_mw)} MW` : null,
      p.generator_count > 0 ? `${p.generator_count} generators` : null,
    ];
    const name = p.plant_name.trim() || `${fuel} power plant${p.city ? ` in ${p.city}` : ""}`;
    return { kind: "plant", name, details: details.filter((d): d is string => !!d) };
  }
  if (target.kind === "substation") {
    const s = target.substation;
    const details = [kvLabel(s.voltage_kv, s.kv_inferred), s.operator ? `operator: ${s.operator}` : null];
    return { kind: "substation", name: substationName(s), details: details.filter((d): d is string => !!d) };
  }
  if (target.kind === "line") {
    const l = target.line;
    const details = [
      kvLabel(l.voltage_kv, l.kv_inferred),
      `${r1(lineMiles(l))} mi long`,
      l.operator ? `operator: ${l.operator}` : null,
      l.circuits ? `circuits: ${l.circuits}` : null,
    ];
    return { kind: "line", name: lineName(l), details: details.filter((d): d is string => !!d) };
  }
  return { kind: "area", name: `The area within ${r0(result.area.radius_mi)} mi of ${result.area_label}`, details: [] };
}

/** Compact facts for the AI writer. Every value comes from the scan, the clicked asset, or the user. */
export function buildFacts(
  target: ReportTarget,
  result: ScanResult,
  live: LineRatingNow | null,
  heatwave: boolean,
  draft: ReportDraft,
  hazards: HazardId[],
  note: string,
): AiFacts {
  const t = result.totals;
  const hw = rateLine(heatwaveWeather());
  const top = [...result.risk.factors]
    .sort((a, b) => b.score * b.weight - a.score * a.weight)
    .slice(0, 3)
    .map((f) => ({ label: f.label, score: r0(f.score), detail: clip(f.detail, 160) }));

  const facts: AiFacts = {
    asset: assetFacts(target, result),
    location: draft.location.text,
    area: {
      name: result.area_label,
      radius_mi: r1(result.area.radius_mi),
      plants: t.plant_count,
      total_mw: r1(t.nameplate_mw),
      renewable_pct: pct(t.renewable_mw, t.nameplate_mw),
      storage_pct: pct(t.storage_mw, t.nameplate_mw),
      fossil_pct: pct(t.fossil_mw, t.nameplate_mw),
      ...(t.cap_weighted_age !== null ? { capacity_weighted_age_years: r1(t.cap_weighted_age) } : {}),
      planned_retirement_mw: r1(t.planned_retirement_mw),
      retired_mw: r1(t.retired_mw),
      proposed_mw: r1(t.proposed_mw),
      proposed_storage_mw: r1(t.proposed_storage_mw),
      line_miles: r1(t.line_miles),
      substations_200kv_plus: t.hv_substation_count,
    },
    heatwave: {
      ratio: r2(hw.ratio),
      scenario: "105 °F, almost no wind, full sun; ratio = safe load / fixed line rating (modeled, typical wire)",
      heatwave_mode_on: heatwave,
    },
    risk: { score: r0(result.risk.score), level: result.risk.level, top_factors: top },
    upgrade_ideas: result.upgrade_ideas.slice(0, 3).map((u) => clip(u, 200)),
    nearby_stories: result.cases.slice(0, 3).map((c) => ({ title: clip(c.title, 90), shock_line: clip(c.shock_line, 160) })),
    checks: draft.issues.map((i) => ({ severity: i.severity, text: clip(i.text, 220) })),
    hazards: hazards.map((id) => HAZARDS.find((h) => h.id === id)?.label).filter((x): x is string => !!x),
    contact: { name: draft.contact.name, url: draft.contact.url },
  };
  if (live && Number.isFinite(live.ratio)) {
    const w = live.weather;
    const src =
      w.source === "open-meteo-live" ? "live weather" : w.source === "heatwave-scenario" ? "heat-wave scenario" : "2025 weather sample";
    facts.line_rating_now = {
      ratio: r2(live.ratio),
      meaning: "safe load right now / fixed line rating (modeled, typical wire); above 1 = spare room",
      weather: `${src}: ${r0(cToF(w.temp_c))} °F, wind ${r1(w.wind_ms)} m/s, sun ${r0(w.sun_wm2)} W/m²`,
    };
  }
  const n = note.trim();
  if (n) facts.note = clip(n, 600);

  // Keep the request small: trim the longest optional parts until it fits.
  const size = () => new TextEncoder().encode(JSON.stringify(facts)).byteLength;
  if (size() > MAX_FACTS_BYTES) facts.nearby_stories = facts.nearby_stories.map((s) => ({ ...s, shock_line: clip(s.shock_line, 80) }));
  if (size() > MAX_FACTS_BYTES) facts.checks = facts.checks.map((c) => ({ ...c, text: clip(c.text, 120) }));
  if (size() > MAX_FACTS_BYTES) facts.upgrade_ideas = facts.upgrade_ideas.map((u) => clip(u, 100));
  if (size() > MAX_FACTS_BYTES) facts.risk.top_factors = facts.risk.top_factors.map((f) => ({ ...f, detail: clip(f.detail, 80) }));
  if (size() > MAX_FACTS_BYTES && facts.note) facts.note = clip(facts.note, 300);
  return facts;
}

export type AiReportResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Streams the report. onText gets the whole text so far after every chunk.
 * Never throws: any failure (503 when no key, 404 under plain `next dev`, network, abort) is { ok: false }.
 */
export async function streamAiReport(
  facts: AiFacts,
  onText: (textSoFar: string) => void,
  signal?: AbortSignal,
): Promise<AiReportResult> {
  let res: Response;
  try {
    res = await fetch(AI_REPORT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(facts),
      signal,
    });
  } catch {
    return { ok: false, reason: signal?.aborted ? "aborted" : "network" };
  }
  if (!res.ok) return { ok: false, reason: `http_${res.status}` };
  if (!(res.headers.get("content-type") ?? "").startsWith("text/plain") || !res.body) {
    return { ok: false, reason: "bad_response" };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      onText(text);
    }
    text += dec.decode();
  } catch {
    return { ok: false, reason: signal?.aborted ? "aborted" : "stream_error" };
  }
  text = text.trim();
  return text ? { ok: true, text } : { ok: false, reason: "empty" };
}
