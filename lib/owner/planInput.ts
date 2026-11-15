/**
 * Normalized owner-plan input + adapters from both Area Scan result shapes.
 *
 * - HEAD shape: `ScanResult` in lib/scan/areaScan.ts (flat totals, 5 scan factors).
 * - PR #2 shape: `ScanResult` from origin/app/area-scan lib/scan/types.ts
 *   (nested `totals`, `rating_site`, `cases`, `events`). Typed here as a local
 *   structural type so this module does not depend on that file's presence.
 *
 * Both adapters score risk through lib/scan/risk.ts `computeRisk`, so the six
 * factor keys and weights come from that module, never from constants here.
 * Sector is always an explicit argument; an electrical scan never becomes the
 * risk basis for water, wastewater, transport or telecom.
 */

import type { ScanResult as HeadScanResult } from "../scan/areaScan";
import type { DailyRating, LineRatingNow } from "../scan/types";
import { computeRisk } from "../scan/risk";
import { digest } from "../evidence/canonical";
import type {
  Evidence,
  Fact,
  GateId,
  OptionKind,
  PlanTarget,
  Sector,
  StageId,
  Unknown,
} from "./types";

type RiskArgs = Parameters<typeof computeRisk>;
type RiskTotals = RiskArgs[0];
type RiskSite = RiskArgs[1];
type RiskCases = RiskArgs[2];
type RiskEvents = RiskArgs[3];

/** One weighted factor as scored by lib/scan/risk.ts, plus whether the scan could actually assess it. */
export interface PlanRiskFactor {
  key: string;
  label: string;
  score: number;
  weight: number;
  detail: string;
  assessed: boolean;
  reason?: string;
}

export interface PlanRisk {
  score: number;
  factors: PlanRiskFactor[];
  /** Where the factor math ran. */
  method: "lib/scan/risk.ts#computeRisk";
}

export interface GridRiskPair {
  baseline: PlanRisk;
  heatwave: PlanRisk;
}

/** A sector-specific risk declared explicitly by the input (fixture or owner), never inferred from a grid scan. */
export interface SectorRiskInput {
  id: string;
  title: string;
  detail: string;
  score: number;
  /** Score under the heatwave scenario, when the owner declared heat sensitivity. */
  heatwaveScore?: number;
  factors: Record<string, number>;
  evidence: string[];
}

export interface SustainabilityInput {
  id: string;
  title: string;
  detail: string;
  score?: number;
  evidence: string[];
}

export interface OptionInput {
  id: string;
  kind: OptionKind;
  title: string;
  assumptions: Fact[];
  addresses?: string[];
  tradeoffs: string;
}

/** A dated scenario/baseline milestone. `forecast` holds a reforecast date; `due` stays the immutable baseline. */
export interface PlanMilestone {
  id: string;
  title: string;
  stage: StageId;
  gate?: GateId;
  /** Baseline date, YYYY-MM-DD. */
  due: string;
  /** Reforecast date after a disruption, YYYY-MM-DD. */
  forecast?: string;
  forecastReason?: string;
  /** Generated task id this milestone constrains; defaults to the gate task of `stage`. `null` = informational only. */
  taskId?: string | null;
  evidence: string[];
}

/** Whether a named data requirement (see ownerPlan REQUIREMENTS) is in hand. */
export interface DataRequirementStatus {
  key: string;
  available: boolean | Unknown;
  evidence?: string[];
}

export interface PlanInput {
  schema: "gridsentinel.plan-input/1";
  target: PlanTarget;
  /** Lifecycle stage the initiative is in now. */
  stage: StageId;
  scope: string;
  origin: "head_area_scan" | "pr2_area_scan" | "fixture";
  /** True when values are scenario inputs, not reported project facts. */
  synthetic: boolean;
  facts: Fact[];
  evidence: Evidence[];
  /** Six-factor grid risk (electric sector only). */
  gridRisk: GridRiskPair | null;
  sectorRisks: SectorRiskInput[];
  sustainability: SustainabilityInput[];
  data: DataRequirementStatus[];
  /** Case-specific options; the planner fills any missing required kinds. */
  options: OptionInput[];
  /** Planning assumption for which option to expand when the owner has not selected one. */
  provisionalOption: string | null;
  milestones: PlanMilestone[];
  /** Back-scheduling anchor, YYYY-MM-DD. Defaults to the latest milestone. */
  targetDate: string | null;
  /** Owner-defined acceptance criteria copied into the commissioning task. */
  acceptanceCriteria: string[];
}

/** Local structural type for PR #2's `ScanResult` (origin/app/area-scan lib/scan/types.ts). */
export interface Pr2ScanResultLike {
  area: { lat: number; lon: number; radius_mi: number };
  area_label: string;
  inside_coverage: boolean;
  lines: unknown[];
  cases: RiskCases;
  events: RiskEvents;
  totals: RiskTotals;
  risk: { score: number; level: string; factors: { key: string; label: string; score: number; weight: number; detail: string }[] };
  rating_site: RiskSite & { distance_mi: number };
  upgrade_ideas: string[];
}

export interface AdapterContext {
  /** Required: the owner states the sector; it is never inferred from the scan. */
  sector: Sector;
  /** ISO time the scan ran (evidence retrieval time). */
  scannedAt: string;
  live?: LineRatingNow | null;
  daily?: DailyRating[] | null;
  stage?: StageId;
  targetDate?: string | null;
  label?: string;
}

const SECTORS: readonly Sector[] = ["electric", "water", "wastewater", "transport", "telecom"];

function assertSector(sector: unknown): asserts sector is Sector {
  if (typeof sector !== "string" || !(SECTORS as readonly string[]).includes(sector)) {
    throw new Error(`planInput: sector must be stated explicitly (got ${String(sector)})`);
  }
}

const unknown = (reason: string, state: Unknown["state"] = "unknown"): Unknown => ({ state, reason });

function toPlanRisk(
  r: ReturnType<typeof computeRisk>,
  unassessed: Record<string, string>,
): PlanRisk {
  return {
    score: r.score,
    method: "lib/scan/risk.ts#computeRisk",
    factors: r.factors.map((f) => {
      const reason = unassessed[f.key];
      return {
        key: f.key,
        label: f.label,
        score: f.score,
        weight: f.weight,
        detail: f.detail,
        assessed: reason === undefined,
        ...(reason === undefined ? {} : { reason }),
      };
    }),
  };
}

function ratingFacts(
  subject: string,
  live: LineRatingNow | null | undefined,
  daily: DailyRating[] | null | undefined,
  asOf: string,
  evidence: Evidence[],
): { facts: Fact[]; liveAvailable: boolean; dailyAvailable: boolean } {
  const facts: Fact[] = [];
  if (live) {
    const evId = `e.rating.live`;
    evidence.push({
      id: evId,
      kind: "model_run",
      title: `Screening line rating from ${live.weather.source} weather (IEEE 738 simplified)`,
      source: { publisher: "GridSentinel lib/scan/rating.ts", locator: live.weather.time },
      retrievedAt: asOf,
      observedAt: live.weather.time,
      freshness: "unknown",
      provenance: "model",
    });
    facts.push({ id: "f.rating.live_ratio", subject, predicate: "live_dlr_conservative_vs_static", value: live.ratio, unit: "ratio", provenance: "model", evidence: [evId], asOf });
    facts.push({ id: "f.rating.live_static_A", subject, predicate: "static_rating", value: live.static_A, unit: "A", provenance: "model", evidence: [evId], asOf });
  } else {
    facts.push({ id: "f.rating.live_ratio", subject, predicate: "live_dlr_conservative_vs_static", value: unknown("No live line rating supplied to the planner."), provenance: "model", evidence: [], asOf });
  }
  if (daily && daily.length > 0) {
    const evId = `e.rating.daily`;
    const sorted = [...daily].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    evidence.push({
      id: evId,
      kind: "model_run",
      title: `Historical daily ratings ${sorted[0].date} to ${sorted[sorted.length - 1].date}`,
      source: { publisher: "GridSentinel line_rating archive", locator: `${sorted.length} days` },
      retrievedAt: asOf,
      freshness: "unknown",
      provenance: "model",
    });
    const below = sorted.filter((d) => d.worst_A < d.static_A).length;
    const worst = sorted.reduce((m, d) => (d.static_A > 0 && d.worst_A / d.static_A < m.r ? { r: d.worst_A / d.static_A, d } : m), { r: Infinity, d: sorted[0] });
    facts.push({ id: "f.rating.daily_days_below_static", subject, predicate: "days_worst_rating_below_static", value: below, unit: "days", provenance: "model", evidence: [evId], asOf });
    facts.push({ id: "f.rating.daily_worst_ratio", subject, predicate: "worst_daily_rating_vs_static", value: Number.isFinite(worst.r) ? Math.round(worst.r * 1000) / 1000 : unknown("Static rating was zero in every row."), unit: "ratio", provenance: "model", evidence: [evId], asOf });
  } else {
    facts.push({ id: "f.rating.daily_days_below_static", subject, predicate: "days_worst_rating_below_static", value: unknown("No historical daily ratings supplied."), provenance: "model", evidence: [], asOf });
  }
  return { facts, liveAvailable: !!live, dailyAvailable: !!daily && daily.length > 0 };
}

function scanEvidence(id: string, title: string, locator: string, scannedAt: string, payloadHash: string): Evidence {
  return {
    id,
    kind: "snapshot",
    title,
    source: { publisher: "GridSentinel Area Scan (EIA-860 plants, OpenStreetMap grid)", locator, sha256: payloadHash },
    retrievedAt: scannedAt,
    freshness: "unknown",
    provenance: "public_source",
  };
}

function gridFacts(subject: string, t: RiskTotals, asOf: string, ev: string): Fact[] {
  const f = (id: string, predicate: string, value: number | Unknown, unit?: string): Fact => ({
    id: `f.scan.${id}`, subject, predicate, value, ...(unit ? { unit } : {}), provenance: "public_source", evidence: [ev], asOf,
  });
  return [
    f("plant_count", "plant_count", t.plant_count, "plants"),
    f("nameplate_mw", "nameplate_capacity", t.nameplate_mw, "MW"),
    f("fossil_mw", "fossil_nameplate", t.fossil_mw, "MW"),
    f("renewable_mw", "renewable_nameplate", t.renewable_mw, "MW"),
    f("storage_mw", "storage_nameplate", t.storage_mw, "MW"),
    f("renewable_pct", "renewable_share_of_nameplate", t.renewable_pct, "%"),
    f("evening_cover_pct", "storage_vs_solar_nameplate", t.evening_cover_pct ?? unknown("No solar nameplate in the circle.", "not_applicable"), "%"),
    f("cap_weighted_age", "capacity_weighted_age", t.cap_weighted_age ?? unknown("No plants with age in the circle.", "not_applicable"), "years"),
    f("planned_retirement_mw", "planned_retirement_nameplate", t.planned_retirement_mw, "MW"),
    f("substation_count", "substation_count", t.substation_count, "substations"),
    f("hv_substation_count", "hv_substation_count", t.hv_substation_count, "substations"),
    f("line_miles", "line_miles", t.line_miles, "mi"),
    // Nameplate is never actual load, emissions or capacity.
    f("actual_load", "actual_load", unknown("Area Scan reports nameplate only; actual load needs metered data.", "not_assessed"), "MW"),
    f("emissions", "annual_emissions", unknown("Area Scan reports nameplate only; emissions need metered generation or a utility factor.", "not_assessed"), "tCO2e"),
  ];
}

function baseInput(target: PlanTarget, ctx: AdapterContext, origin: PlanInput["origin"], scope: string): PlanInput {
  return {
    schema: "gridsentinel.plan-input/1",
    target,
    stage: ctx.stage ?? "feasibility",
    scope,
    origin,
    synthetic: false,
    facts: [],
    evidence: [],
    gridRisk: null,
    sectorRisks: [],
    sustainability: [],
    data: [],
    options: [],
    provisionalOption: null,
    milestones: [],
    targetDate: ctx.targetDate ?? null,
    acceptanceCriteria: [],
  };
}

function nonElectricNote(input: PlanInput, sector: Sector, asOf: string): PlanInput {
  input.facts.push({
    id: "f.scan.sector_scope",
    subject: input.target.label ?? "target",
    predicate: `${sector}_risk_from_electrical_scan`,
    value: unknown(`The Area Scan measures electrical assets only; it is not used as ${sector} risk evidence.`, "not_applicable"),
    provenance: "model",
    evidence: [],
    asOf,
  });
  return input;
}

function sustainabilityFromTotals(t: RiskTotals, ev: string): SustainabilityInput[] {
  const out: SustainabilityInput[] = [];
  if (t.nameplate_mw > 0) {
    const cover = t.evening_cover_pct;
    out.push({
      id: "s.grid.clean_shift",
      title: cover === null || cover < 50 ? "Pair storage with local solar for the evening ramp" : "Shift fossil peaking to storage already in the area",
      detail:
        `Nameplate mix: ${Math.round(t.renewable_pct)}% renewable, ${Math.round(t.storage_mw)} MW storage, ${Math.round(t.fossil_mw)} MW fossil` +
        (cover === null ? "; no solar nameplate." : `; storage equals ${Math.round(cover)}% of solar nameplate.`) +
        " Nameplate share is not energy or emissions; quantify savings only from metered data.",
      evidence: [ev],
    });
  }
  return out;
}

/** Adapter: HEAD `ScanResult` (lib/scan/areaScan.ts). */
export function planInputFromHeadScan(result: HeadScanResult, ctx: AdapterContext): PlanInput {
  assertSector(ctx.sector);
  const target: PlanTarget = {
    lat: result.point.lat, lon: result.point.lon, radius_miles: result.point.radius_mi,
    sector: ctx.sector, label: ctx.label ?? result.label,
  };
  const input = baseInput(target, ctx, "head_area_scan", `Area Scan ${result.point.radius_mi} mi around ${result.label}`);
  const subject = target.label ?? "target";
  const ev = "e.scan.head";
  input.evidence.push(scanEvidence(ev, `Area Scan: ${result.label}`, `${result.point.lat},${result.point.lon} r=${result.point.radius_mi}mi`, ctx.scannedAt, digest(result)));
  if (ctx.sector !== "electric") return nonElectricNote(input, ctx.sector, ctx.scannedAt);

  // Map the flat HEAD totals onto risk.ts inputs. Values the HEAD shape does not carry are recorded as unassessed.
  const totals = {
    plant_count: result.plant_count,
    nameplate_mw: result.nameplate_mw,
    mw_by_source: result.mw_by_source,
    renewable_mw: result.renewable_mw,
    storage_mw: result.storage_mw,
    fossil_mw: result.fossil_mw,
    renewable_pct: result.renewable_pct,
    cap_weighted_age: result.cap_weighted_age,
    oldest: result.oldest_plant ? { name: result.oldest_plant.name, year: result.oldest_plant.year } : null,
    planned_retirement_mw: result.planned_retirement_mw,
    retired_mw: 0,
    proposed_mw: 0,
    proposed_storage_mw: 0,
    line_miles: result.line_miles,
    line_miles_by_kv: result.line_miles_by_kv,
    substation_count: result.substation_count,
    hv_substation_count: result.hv_substation_count,
    evening_cover_pct: result.evening_cover_pct,
  } as RiskTotals;
  const hottest = result.wire?.hottest ?? null;
  const site: RiskSite = {
    key: result.wire?.site ?? "none", name: result.wire?.site ?? "no rating site",
    lat: result.point.lat, lon: result.point.lon,
    median_conservative_dlr_vs_static: result.wire?.median_ratio ?? NaN,
    pct_hours_conservative_dlr_above_static: result.wire?.pct_hours_above_still_air ?? NaN,
    summer_4to8pm_median_wind_gain_over_aar: NaN,
    hottest_hour: hottest?.time ?? "",
    hottest_temp_c: hottest?.temp_c ?? NaN,
    // HEAD wire ratio is breeze/still-air at the same hour: the closest available proxy for risk.ts's hottest-hour ratio.
    hottest_hour_dlr_vs_static: hottest?.ratio ?? NaN,
  };
  const lineCount = result.line_miles > 0 ? 1 : 0;
  const unassessed: Record<string, string> = {
    hazard: "HEAD Area Scan carries no hazard case list; hazard history not assessed.",
  };
  if (!hottest) unassessed.heat = "Conductor archive not loaded in this scan; baseline heat stress not assessed.";
  const turnoverNote = "HEAD Area Scan carries planned retirements only; recent retirements not counted.";
  const base = toPlanRisk(computeRisk(totals, site, [], [], lineCount), unassessed);
  const heat = toPlanRisk(computeRisk(totals, site, [], [], lineCount, { heatwave: true }), { hazard: unassessed.hazard });
  for (const r of [base, heat]) for (const f of r.factors) if (f.key === "turnover") f.detail = `${f.detail} ${turnoverNote}`;
  input.gridRisk = { baseline: base, heatwave: heat };
  input.facts.push(...gridFacts(subject, totals, ctx.scannedAt, ev));
  input.facts.push({ id: "f.scan.head_composite", subject, predicate: "area_scan_composite_score_5_factor", value: result.risk.score, unit: "0-100", provenance: "model", evidence: [ev], asOf: ctx.scannedAt });
  const rf = ratingFacts(subject, ctx.live, ctx.daily, ctx.scannedAt, input.evidence);
  input.facts.push(...rf.facts);
  input.sustainability = sustainabilityFromTotals(totals, ev);
  input.data = [
    { key: "interval_meter", available: unknown("Area Scan has no customer interval-meter feed.") },
    { key: "live_rating", available: rf.liveAvailable, evidence: rf.liveAvailable ? ["e.rating.live"] : [] },
    { key: "hazard_history", available: unknown(unassessed.hazard, "not_assessed") },
    { key: "one_line", available: unknown("Single-line diagram is owner or utility data, not in the scan.") },
  ];
  return input;
}

/** Adapter: PR #2 `ScanResult` (origin/app/area-scan lib/scan/types.ts), via a local structural type. */
export function planInputFromPr2Scan(result: Pr2ScanResultLike, ctx: AdapterContext): PlanInput {
  assertSector(ctx.sector);
  const target: PlanTarget = {
    lat: result.area.lat, lon: result.area.lon, radius_miles: result.area.radius_mi,
    sector: ctx.sector, label: ctx.label ?? result.area_label,
  };
  const input = baseInput(target, ctx, "pr2_area_scan", `Area Scan ${result.area.radius_mi} mi around ${result.area_label}`);
  const subject = target.label ?? "target";
  const ev = "e.scan.pr2";
  input.evidence.push(scanEvidence(ev, `Area Scan: ${result.area_label}`, `${result.area.lat},${result.area.lon} r=${result.area.radius_mi}mi`, ctx.scannedAt, digest(result)));
  if (ctx.sector !== "electric") return nonElectricNote(input, ctx.sector, ctx.scannedAt);

  const lineCount = result.lines.length;
  const unassessed: Record<string, string> = {};
  if (!Number.isFinite(result.rating_site.hottest_hour_dlr_vs_static)) unassessed.heat = "Rating site has no hottest-hour ratio.";
  const base = toPlanRisk(computeRisk(result.totals, result.rating_site, result.cases, result.events, lineCount), unassessed);
  const heat = toPlanRisk(computeRisk(result.totals, result.rating_site, result.cases, result.events, lineCount, { heatwave: true }), {});
  input.gridRisk = { baseline: base, heatwave: heat };
  input.facts.push(...gridFacts(subject, result.totals, ctx.scannedAt, ev));
  input.facts.push({ id: "f.scan.events", subject, predicate: "generation_events_in_circle", value: result.events.length, unit: "events", provenance: "public_source", evidence: [ev], asOf: ctx.scannedAt });
  input.facts.push({ id: "f.scan.hazard_cases", subject, predicate: "hazard_cases_in_circle", value: result.cases.length, unit: "cases", provenance: "public_source", evidence: [ev], asOf: ctx.scannedAt });
  const rf = ratingFacts(subject, ctx.live, ctx.daily, ctx.scannedAt, input.evidence);
  input.facts.push(...rf.facts);
  input.sustainability = sustainabilityFromTotals(result.totals, ev);
  input.data = [
    { key: "interval_meter", available: unknown("Area Scan has no customer interval-meter feed.") },
    { key: "live_rating", available: rf.liveAvailable, evidence: rf.liveAvailable ? ["e.rating.live"] : [] },
    { key: "hazard_history", available: true, evidence: [ev] },
    { key: "one_line", available: unknown("Single-line diagram is owner or utility data, not in the scan.") },
  ];
  return input;
}
