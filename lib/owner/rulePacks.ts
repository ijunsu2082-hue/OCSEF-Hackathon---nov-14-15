// Rule packs and per-segment jurisdiction resolution (INFRASTRUCTURE-LIFECYCLE §3).
// (The owner portal's agency filing catalog is a separate module, ./rules.ts.)
//
// Pure and deterministic: no clock, no randomness. Rules express applicability
// questions; they never make legal determinations. Missing, unknown, or
// conflicting inputs always produce "indeterminate", never "does_not_apply".
// Jurisdiction is resolved per route segment, never by centroid or majority area.

import { isUnknown, type Fact, type FactValue } from "./planTypes";

export type RuleResult = "applies" | "does_not_apply" | "indeterminate";

export type RuleOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "exists";

/** Declarative condition over a named input fact predicate. All conditions in a rule are ANDed. */
export interface RuleCondition { input: string; op: RuleOp; value?: number | string | boolean | (number | string | boolean)[] }

export interface Rule {
  id: string;
  /** Activities this rule screens (e.g. "trenching"); empty/undefined means any activity. */
  activities?: string[];
  /** Phases this rule screens (e.g. "construction"); empty/undefined means any phase. */
  phases?: string[];
  requirement: string;
  when: RuleCondition[];
  sourceIds: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface RulePack {
  id: string;
  jurisdictionId: string;
  domain: string;
  version: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "draft" | "reviewed" | "active" | "superseded";
  reviewedBy: string | null;
  rules: Rule[];
}

export interface RuleEvaluation {
  ruleId: string;
  result: RuleResult;
  missingInputs: string[];
  evidence: string[];
  segmentId: string;
  /** null when the segment's jurisdiction could not be resolved. */
  jurisdictionId: string | null;
  domain: string;
  rulePackId: string | null;
  rulePackVersion: string | null;
  activity: string;
  phase: string;
  /** Date used for effective-date selection (activity/decision date), as passed in. */
  effectiveDate: string;
  explanation: string;
}

export interface ProjectSegment {
  segmentId: string;
  role: "site" | "interconnection" | "route" | "access" | "water" | "other";
  /** Jurisdictions this segment lies in. An Unknown marker means boundary/geometry unresolved. */
  jurisdictionIds: string[] | import("./planTypes").Unknown;
  activities: string[];
  phase: string;
}

export interface CoverageIssue { segmentId: string; domain: string; jurisdictionId: string | null; reason: "unresolved_boundary" | "no_source" | "expired_pack" | "pending_review" | "unsupported_domain" }

// ---------------------------------------------------------------------------
// Segment-by-segment jurisdiction resolution for linear assets.

export type LonLat = [number, number];
export interface JurisdictionArea { id: string; /** Outer ring, lon/lat, closed or open. */ ring: LonLat[] }
export interface RouteGeometry { id: string; vertices: LonLat[] }

function pointInRing(p: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function jurisdictionsAt(p: LonLat, areas: JurisdictionArea[]): string[] {
  return areas.filter((a) => pointInRing(p, a.ring)).map((a) => a.id).sort();
}

/**
 * Split a route polyline into segments by jurisdiction. Each edge is sampled at
 * both endpoints and its midpoint (not the route centroid). Consecutive edges in
 * the same jurisdiction set merge into one segment; points in no known area
 * produce a segment with an Unknown jurisdiction (coverage issue, not a default).
 */
export function segmentRouteByJurisdiction(route: RouteGeometry, areas: JurisdictionArea[], activities: string[], phase: string): ProjectSegment[] {
  const out: ProjectSegment[] = [];
  const keyOf = (ids: string[]) => (ids.length ? ids.join("|") : "?");
  let current: { key: string; ids: string[]; from: number; to: number } | null = null;
  const flush = () => {
    if (!current) return;
    out.push({
      segmentId: `${route.id}#${current.from}-${current.to}:${current.key}`,
      role: "route",
      jurisdictionIds: current.ids.length ? current.ids : { state: "unknown", reason: `route vertices ${current.from}-${current.to} fall outside every supplied jurisdiction boundary` },
      activities: [...activities],
      phase,
    });
  };
  for (let i = 0; i < route.vertices.length - 1; i++) {
    const a = route.vertices[i];
    const b = route.vertices[i + 1];
    const mid: LonLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // An edge whose samples disagree contributes to every jurisdiction it touches:
    // start, (a distinct midpoint sliver), and end. The edge is never collapsed to one.
    const ja = jurisdictionsAt(a, areas);
    const jm = jurisdictionsAt(mid, areas);
    const jb = jurisdictionsAt(b, areas);
    const parts: string[][] = [ja];
    if (keyOf(jm) !== keyOf(ja) && keyOf(jm) !== keyOf(jb)) parts.push(jm);
    parts.push(jb);
    for (const ids of parts) {
      const key = keyOf(ids);
      if (current && current.key === key) {
        current.to = i + 1;
      } else {
        flush();
        current = { key, ids, from: i, to: i + 1 };
      }
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Rule evaluation.

function t(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid ISO time: ${iso}`);
  return ms;
}

function inEffect(from: string, to: string | null, at: string): boolean {
  const x = t(at);
  return t(from) <= x && (to === null || x < t(to));
}

type Lookup = { value: FactValue; factIds: string[]; evidence: string[] } | { missing: string } ;

/** Current (non-superseded) facts for subject+predicate. Conflicting values → missing (conflict). */
function lookup(facts: Fact[], subjects: string[], predicate: string): Lookup {
  const superseded = new Set(facts.map((f) => f.supersedes).filter((s): s is string => !!s));
  for (const subject of subjects) {
    const live = facts.filter((f) => f.subject === subject && f.predicate === predicate && !superseded.has(f.id));
    if (live.length === 0) continue;
    const values = new Set(live.map((f) => JSON.stringify(f.value)));
    if (values.size > 1) return { missing: `${predicate} (conflicting facts: ${live.map((f) => f.id).sort().join(", ")})` };
    const v = live[0].value;
    if (isUnknown(v)) return { missing: `${predicate} (${v.state}: ${v.reason})` };
    return { value: v, factIds: live.map((f) => f.id).sort(), evidence: [...new Set(live.flatMap((f) => f.evidence))].sort() };
  }
  return { missing: predicate };
}

function holds(cond: RuleCondition, v: FactValue): boolean {
  const c = cond.value;
  switch (cond.op) {
    case "exists": return true;
    case "eq": return v === c;
    case "neq": return v !== c;
    case "gt": return typeof v === "number" && typeof c === "number" && v > c;
    case "gte": return typeof v === "number" && typeof c === "number" && v >= c;
    case "lt": return typeof v === "number" && typeof c === "number" && v < c;
    case "lte": return typeof v === "number" && typeof c === "number" && v <= c;
    case "in": return Array.isArray(c) && (c as unknown[]).includes(v);
  }
}

export interface EvaluateRulesInput {
  projectId: string;
  segments: ProjectSegment[];
  packs: RulePack[];
  /** Facts with subject = segmentId (preferred) or projectId. */
  facts: Fact[];
  domains: string[];
  /** Activity/decision date used for effective-date selection. */
  effectiveDate: string;
}

export interface EvaluateRulesOutput { evaluations: RuleEvaluation[]; coverage: CoverageIssue[] }

/**
 * Evaluate every (segment × jurisdiction × domain × rule × activity × phase).
 * A segment crossing two jurisdictions yields evaluations for both.
 */
export function evaluateRules(input: EvaluateRulesInput): EvaluateRulesOutput {
  const evaluations: RuleEvaluation[] = [];
  const coverage: CoverageIssue[] = [];
  const segments = [...input.segments].sort((a, b) => a.segmentId.localeCompare(b.segmentId));
  const domains = [...input.domains].sort();
  for (const seg of segments) {
    const activities = [...seg.activities].sort();
    if (!Array.isArray(seg.jurisdictionIds) || seg.jurisdictionIds.length === 0) {
      const reason = Array.isArray(seg.jurisdictionIds) ? "no jurisdiction recorded" : `${seg.jurisdictionIds.state}: ${seg.jurisdictionIds.reason}`;
      for (const domain of domains) {
        coverage.push({ segmentId: seg.segmentId, domain, jurisdictionId: null, reason: "unresolved_boundary" });
        for (const activity of activities) {
          evaluations.push({
            ruleId: `coverage:${domain}`, result: "indeterminate", missingInputs: ["jurisdiction"], evidence: [],
            segmentId: seg.segmentId, jurisdictionId: null, domain, rulePackId: null, rulePackVersion: null,
            activity, phase: seg.phase, effectiveDate: input.effectiveDate,
            explanation: `Jurisdiction unresolved for segment (${reason}); applicability cannot be screened.`,
          });
        }
      }
      continue;
    }
    for (const jurisdictionId of [...seg.jurisdictionIds].sort()) {
      for (const domain of domains) {
        const candidates = input.packs.filter((p) => p.jurisdictionId === jurisdictionId && p.domain === domain);
        const pack = candidates
          .filter((p) => (p.status === "active" || p.status === "reviewed") && p.reviewedBy && inEffect(p.effectiveFrom, p.effectiveTo, input.effectiveDate))
          .sort((a, b) => t(b.effectiveFrom) - t(a.effectiveFrom) || b.version.localeCompare(a.version))[0];
        if (!pack) {
          const reason: CoverageIssue["reason"] = candidates.length === 0 ? "no_source"
            : candidates.some((p) => p.status === "draft" || !p.reviewedBy) ? "pending_review" : "expired_pack";
          coverage.push({ segmentId: seg.segmentId, domain, jurisdictionId, reason });
          for (const activity of activities) {
            evaluations.push({
              ruleId: `coverage:${domain}`, result: "indeterminate", missingInputs: ["rule pack"], evidence: [],
              segmentId: seg.segmentId, jurisdictionId, domain, rulePackId: null, rulePackVersion: null,
              activity, phase: seg.phase, effectiveDate: input.effectiveDate,
              explanation: `No active reviewed ${domain} rule pack for ${jurisdictionId} on ${input.effectiveDate} (${reason}).`,
            });
          }
          continue;
        }
        const rules = [...pack.rules].sort((a, b) => a.id.localeCompare(b.id));
        for (const rule of rules) {
          if (!inEffect(rule.effectiveFrom, rule.effectiveTo, input.effectiveDate)) continue;
          if (rule.phases && rule.phases.length && !rule.phases.includes(seg.phase)) continue;
          for (const activity of activities) {
            if (rule.activities && rule.activities.length && !rule.activities.includes(activity)) continue;
            const missing: string[] = [];
            const evidence = new Set<string>(rule.sourceIds);
            let allTrue = true;
            for (const cond of rule.when) {
              const got = lookup(input.facts, [seg.segmentId, input.projectId], cond.input);
              if ("missing" in got) { missing.push(got.missing); continue; }
              got.evidence.forEach((e) => evidence.add(e));
              if (!holds(cond, got.value)) allTrue = false;
            }
            // A false condition only yields does_not_apply when every input was known.
            const result: RuleResult = missing.length ? "indeterminate" : allTrue ? "applies" : "does_not_apply";
            evaluations.push({
              ruleId: rule.id, result, missingInputs: missing, evidence: [...evidence].sort(),
              segmentId: seg.segmentId, jurisdictionId, domain, rulePackId: pack.id, rulePackVersion: pack.version,
              activity, phase: seg.phase, effectiveDate: input.effectiveDate,
              explanation: missing.length
                ? `Indeterminate: missing ${missing.join("; ")}. Screening only; not a legal determination.`
                : `${result === "applies" ? "Screened as applicable" : "Screened as not applicable"}: ${rule.requirement} (pack ${pack.id}@${pack.version}). Screening only; not a legal determination.`,
            });
          }
        }
      }
    }
  }
  return { evaluations, coverage };
}

/** Stable key used to match a rule evaluation to an authorization record. */
export function evaluationKey(e: Pick<RuleEvaluation, "ruleId" | "segmentId" | "jurisdictionId" | "activity" | "phase">): string {
  return `${e.ruleId}@${e.segmentId}@${e.jurisdictionId ?? "?"}@${e.activity}@${e.phase}`;
}
