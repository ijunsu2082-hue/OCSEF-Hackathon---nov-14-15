/**
 * Deterministic scan-to-owner-plan builder.
 *
 * PURE: no clock, no randomness, no I/O. Every date derives from `opts.asOf`
 * and the input's dated milestones. Hashes are SHA-256 of canonical JSON
 * (lib/evidence/canonical.ts, browser-safe).
 *
 * Specification: docs/INFRASTRUCTURE-IMPLEMENTATION-HANDOFF.md,
 * docs/INFRASTRUCTURE-LIFECYCLE.md, docs/INFRASTRUCTURE-WORKFLOWS.md, and the
 * procedure codes in docs/INFRASTRUCTURE-PROCEDURES-*.md.
 */

import { digest } from "../evidence/canonical";
import type { PlanInput, PlanMilestone, PlanRisk } from "./planInput";
import type {
  DraftEdits,
  DraftReport,
  Evidence,
  Fact,
  Finding,
  GateId,
  OptionKind,
  OwnerPlan,
  OwnerPlanExtras,
  OwnerTaskWithNotes,
  PlanOption,
  PlanTarget,
  Sector,
  StageId,
  TaskEdit,
  Unknown,
} from "./planTypes";
import { isUnknown } from "./planTypes";

export type Scenario = "baseline" | "heatwave";

export interface BuildOptions {
  scenario: Scenario;
  /** ISO timestamp the plan is computed "as of". The only clock the planner sees. */
  asOf: string;
  edits?: DraftEdits;
}

export type BuiltOwnerPlan = Omit<OwnerPlan, "tasks"> & OwnerPlanExtras & { tasks: OwnerTaskWithNotes[] };

// Compile-time: a built plan is still a valid OwnerPlan.
const _isOwnerPlan = (p: BuiltOwnerPlan): OwnerPlan => p;
void _isOwnerPlan;

// ---------------------------------------------------------------- dates

const DAY_MS = 86_400_000;

function dayOf(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`ownerPlan: not an ISO date: ${iso}`);
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

function isoDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- keys

/** Stable per-target key. Drafts are scoped to it so two targets never share edits. */
export function planKey(target: PlanTarget): string {
  return `${target.sector}:${target.lat.toFixed(5)},${target.lon.toFixed(5)}:r${target.radius_miles}`;
}

/** Suggested localStorage key for a draft. */
export function draftStorageKey(target: PlanTarget): string {
  return `gridsentinel.owner-draft/1:${planKey(target)}`;
}

// ---------------------------------------------------------------- evidence requirements

interface Requirement {
  key: string;
  label: string;
  /** Named evidence-task title. */
  task: string;
  role: string;
  output: string;
  acceptance: string[];
  recovery: string;
  durationDays: number;
  heat?: boolean;
}

const R = (key: string, label: string, task: string, role: string, output: string, acceptance: string[], recovery: string, durationDays: number, heat = false): Requirement =>
  ({ key, label, task, role, output, acceptance, recovery, durationDays, heat });

/** Catalog of named evidence requirements. A missing or unknown one becomes a gap finding and a named task. */
export const REQUIREMENTS: Record<string, Requirement> = {
  interval_meter: R("interval_meter", "Interval meter data", "Obtain interval meter data", "Facilities energy manager",
    "12 months of 15-minute interval data for the service account(s)", ["Utility or meter-vendor export with account ID and date range", "Gap report (missing intervals flagged)"],
    "If the utility cannot export, install temporary logging and record the substitute basis.", 30),
  one_line: R("one_line", "Single-line diagram", "Obtain single-line diagram and protected circuit list", "Owner electrical engineer",
    "Current single-line diagram with protected/critical circuit list", ["Drawing with revision and date, owner-verified against field walkdown"],
    "If drawings are missing or stale, commission a field survey before design basis.", 21),
  live_rating: R("live_rating", "Live line rating", "Connect live weather for line rating", "Grid analyst",
    "Live weather-based screening rating for the highest-voltage tie", ["Rating run with weather source and timestamp"],
    "If the live feed is down, fall back to the archived hottest-hour rating and label it historical.", 3, true),
  hazard_history: R("hazard_history", "Hazard history", "Compile hazard history for the area", "Risk analyst",
    "Wildfire, gas and heat event list with sources", ["Each event cites an official or published source with date"],
    "If no source covers the area, record hazard history as not assessed with reason.", 10),
  load_history_15min: R("load_history_15min", "15-minute load history", "Obtain 15-minute load history", "Utility planning engineer",
    "15-minute substation load history covering at least two summer peaks", ["SCADA/historian export with date range and metering point"],
    "If historian data has gaps, use feeder-head meters and document the substitution.", 21, true),
  n1_study: R("n1_study", "N-1 contingency study", "Run N-1 contingency study", "Utility planning engineer",
    "N-1 study with forecast peak and contingency loading", ["Study report with model version and assumptions"], "If the model is unavailable, commission an external study and hold the M1 decision.", 45),
  utility_requirements: R("utility_requirements", "Utility interconnection requirements", "Obtain written utility interconnection requirements", "Interconnection lead",
    "Written utility requirements for the selected configuration", ["Utility correspondence on letterhead or portal record"], "If the utility has not responded, log the request date and escalate at 30 days.", 45),
  break_records: R("break_records", "Geocoded break records", "Obtain geocoded break records", "Water asset manager",
    "Five-year main break records geocoded to segment", ["Work-order export with dates, locations and failure mode"], "If records are incomplete, reconcile with customer complaint logs and flag gaps.", 21),
  pressure_loggers: R("pressure_loggers", "Pressure logger data", "Obtain pressure logger data", "Water operations supervisor",
    "Pressure logger data across peak-demand weeks", ["Logger files with calibration date and location"], "If loggers are not installed, deploy temporary loggers for 4 weeks.", 30, true),
  condition_survey: R("condition_survey", "Condition survey", "Commission CCTV/acoustic leak and condition survey", "Water engineering lead",
    "Condition survey of the trunk main", ["Survey report with segment condition scores"], "If access is blocked, prioritise high-consequence segments and survey the rest later.", 45),
  influent_characterization: R("influent_characterization", "Influent characterization", "Obtain 12-month influent characterization", "Plant process engineer",
    "12 months of daily influent flow and nutrient load data", ["Lab data with chain of custody"], "If months are missing, extend sampling and keep the design load provisional.", 30),
  blower_power: R("blower_power", "Blower power data", "Obtain blower power curves and submetering", "Plant maintenance lead",
    "Blower power curves and kWh/MG submetering", ["Meter export and vendor curves with model numbers"], "If submetering is absent, install temporary power loggers.", 21, true),
  permit_history: R("permit_history", "Permit history", "Compile discharge permit history", "Compliance lead",
    "Discharge permit, limits and compliance history", ["Permit copy and regulator correspondence"], "If records conflict, request the regulator file copy.", 14),
  inspection_load_rating: R("inspection_load_rating", "Inspection and load rating", "Obtain hands-on inspection and load rating", "Bridge engineer",
    "Hands-on inspection and current load rating", ["Signed inspection report and load-rating calculation"], "If access needs a closure, schedule a night closure and keep the posting review open.", 45),
  traffic_counts: R("traffic_counts", "Traffic counts", "Obtain classified traffic counts", "Traffic engineer",
    "Classified counts including heavy-vehicle share", ["Count report with dates and station"], "If counts are older than 3 years, run a new 7-day count.", 14),
  scour_assessment: R("scour_assessment", "Scour assessment", "Commission scour assessment", "Hydraulic engineer",
    "Scour assessment for piers and abutments", ["Assessment report"], "If high-flow access is unsafe, use the last post-flood inspection and flag uncertainty.", 30),
  eligibility_map: R("eligibility_map", "Address eligibility map", "Obtain address-level eligibility map", "Broadband program manager",
    "Address-level serviceability/eligibility map", ["Map export with source and as-of date"], "If the official map conflicts with field data, file a challenge and keep both.", 21),
  speed_tests: R("speed_tests", "Speed tests", "Collect premises speed tests", "Network engineer",
    "Speed-test sample across the route", ["Test logs with timestamps and locations"], "If response is low, add drive tests and anchor-site tests.", 21),
  pole_loading: R("pole_loading", "Pole loading", "Obtain pole loading and make-ready survey", "Outside plant engineer",
    "Pole loading analysis and make-ready estimate", ["Pole owner survey results"], "If pole owner delays, stage underground segments where permitted.", 45),
  backup_power: R("backup_power", "Hut backup power", "Test hut cooling and backup power", "Network operations", "Backup power and cooling test results", ["Test log"], "If tests fail, add temporary generation and re-test.", 7, true),
};

const SECTOR_DEFAULT_REQUIREMENTS: Record<Sector, string[]> = {
  electric: ["interval_meter", "one_line"],
  water: ["break_records", "pressure_loggers", "condition_survey"],
  wastewater: ["influent_characterization", "blower_power"],
  transport: ["inspection_load_rating", "traffic_counts"],
  telecom: ["eligibility_map", "pole_loading"],
};

const HEAT_TASK: Record<Sector, { title: string; role: string; output: string }> = {
  electric: { title: "Set heat-event operating limits for the highest-voltage tie", role: "Grid operations lead", output: "Heat-event operating limits and load-shed priority list" },
  water: { title: "Prepare heat-demand pressure and supply plan", role: "Water operations supervisor", output: "Peak-demand pressure plan with hospital minimum-pressure check" },
  wastewater: { title: "Confirm aeration capacity and standby power for the heat event", role: "Plant operator in charge", output: "Aeration and standby power readiness check" },
  transport: { title: "Inspect expansion joints and bearings before the heat event", role: "Bridge maintenance supervisor", output: "Joint/bearing inspection record and closure criteria" },
  telecom: { title: "Test hut cooling and backup power before the heat event", role: "Network operations", output: "Hut cooling and backup power test log" },
};

// ---------------------------------------------------------------- generic options

const OPTION_ORDER: OptionKind[] = ["repair", "operating_change", "replacement", "defer", "do_nothing"];

const GENERIC_OPTIONS: Record<Sector, Record<OptionKind, { title: string; tradeoffs: string }>> = {
  electric: {
    repair: { title: "Repair and maintain existing service equipment", tradeoffs: "Lowest cost; leaves capacity and resilience gaps unchanged." },
    operating_change: { title: "Operating change: managed load, dynamic ratings and load-shed plan", tradeoffs: "Fast and cheap; depends on dispatch and does not add firm capacity." },
    replacement: { title: "Replace or expand equipment", tradeoffs: "Adds capacity and life; highest capital, permits and lead time." },
    defer: { title: "Defer with monitored triggers", tradeoffs: "Preserves capital; risk persists until a trigger is crossed." },
    do_nothing: { title: "Do nothing (baseline)", tradeoffs: "Reference case for comparing options; risk unmanaged." },
  },
  water: {
    repair: { title: "Spot repair of failed segments", tradeoffs: "Lowest disruption now; high-consequence segments remain." },
    operating_change: { title: "Operating change: pressure management and valve exercising", tradeoffs: "Reduces break stress; does not renew pipe." },
    replacement: { title: "Rehabilitate or replace the main", tradeoffs: "Longest life; most excavation and capital." },
    defer: { title: "Defer with break-rate trigger", tradeoffs: "Preserves capital; outages continue." },
    do_nothing: { title: "Do nothing (baseline)", tradeoffs: "Reference case; break rate and losses continue." },
  },
  wastewater: {
    repair: { title: "Repair failed blowers and screens in kind", tradeoffs: "Restores service; no energy or redundancy gain." },
    operating_change: { title: "Operating change: aeration setpoints and DO control tuning", tradeoffs: "Low cost energy savings; limited by existing equipment." },
    replacement: { title: "Replace or upgrade process equipment", tradeoffs: "Energy and permit margin; capital and shutdown risk." },
    defer: { title: "Defer with permit-margin trigger", tradeoffs: "Preserves capital; bypass exposure persists." },
    do_nothing: { title: "Do nothing (baseline)", tradeoffs: "Reference case; permit and bypass risk unmanaged." },
  },
  transport: {
    repair: { title: "Patch and maintain under posting", tradeoffs: "Minimal closure; load restriction remains." },
    operating_change: { title: "Operating change: load posting and heavy-vehicle routing", tradeoffs: "Protects structure; adds freight detours." },
    replacement: { title: "Rehabilitate or replace the structure", tradeoffs: "Restores capacity and life; detour and embodied carbon." },
    defer: { title: "Defer with condition-rating trigger", tradeoffs: "Preserves capital; posting likely." },
    do_nothing: { title: "Do nothing (baseline)", tradeoffs: "Reference case; deterioration continues." },
  },
  telecom: {
    repair: { title: "Repair existing backhaul and outside plant", tradeoffs: "Restores availability; no coverage gain." },
    operating_change: { title: "Operating change: traffic engineering and wholesale leases", tradeoffs: "Fast; depends on third-party capacity." },
    replacement: { title: "Build or replace network segments", tradeoffs: "Coverage and capacity; easements and make-ready." },
    defer: { title: "Defer with demand trigger", tradeoffs: "Preserves capital; unserved premises remain." },
    do_nothing: { title: "Do nothing (baseline)", tradeoffs: "Reference case; coverage gap persists." },
  },
};

// ---------------------------------------------------------------- task skeleton

interface Step {
  id: string;
  code: string;
  stage: StageId;
  gate?: GateId;
  title: string;
  role: string;
  deps: string[];
  durationDays: number;
  inputs: string[];
  output: string;
  evidence: string[];
  recovery: string;
}

function buildSteps(kind: OptionKind | null, optionTitle: string, acceptance: string[]): Step[] {
  const s: Step[] = [];
  const opt = optionTitle;
  s.push({ id: "t.dev.need", code: "DEV-04", stage: "feasibility", title: "Confirm need statement and appraisal frame", role: "Sponsor / planning lead", deps: [], durationDays: 10,
    inputs: ["Findings in this plan", "Service objective"], output: "Need statement with objective, scope and appraisal weights",
    evidence: ["Need statement accepted by sponsor (dated)"], recovery: "If the need is not confirmed, close as no-go with rationale and a revisit date." });
  s.push({ id: "t.dev.alternatives", code: "DEV-05", stage: "feasibility", gate: "M1", title: "Compare options and record the preferred alternative", role: "Sponsor / investment authority", deps: ["t.dev.need"], durationDays: 20,
    inputs: ["Option assumptions register", "Evidence task outputs"], output: "Decision record selecting the preferred option (or documented no-go)",
    evidence: ["Alternatives analysis with assumptions and sensitivities", "Signed decision record with conditions"], recovery: "If no option is viable, record no-go; if evidence is still missing, make a provisional choice that lists open studies." });
  if (kind === null) return s;
  if (kind === "defer" || kind === "do_nothing") {
    s.push({ id: "t.ops.monitor", code: "OPS-02", stage: "operations", title: `Monitor triggers for "${opt}"`, role: "Operations owner", deps: ["t.dev.alternatives"], durationDays: 30,
      inputs: ["Decision record", "Risk findings"], output: "Trigger register with thresholds and review cadence",
      evidence: ["Monthly trigger review log"], recovery: "If a trigger trips, reopen M1 and re-run the alternatives comparison." });
    s.push({ id: "t.dev.revisit", code: "DEV-06", stage: "feasibility", gate: "M8", title: "Revisit the decision on trigger or date", role: "Sponsor / planning lead", deps: ["t.ops.monitor"], durationDays: 5,
      inputs: ["Trigger register"], output: "Revisit decision (continue deferral or reopen alternatives)",
      evidence: ["Dated revisit decision record"], recovery: "If the revisit is missed, escalate to the investment authority." });
    return s;
  }
  const build = kind !== "operating_change";
  if (build) {
    s.push({ id: "t.land.site_control", code: "DEV-07", stage: "site_control", gate: "M2", title: `Screen site/route and secure control path for "${opt}"`, role: "Land / real-estate lead", deps: ["t.dev.alternatives"], durationDays: 45,
      inputs: ["Preferred option footprint"], output: "Site control path (title, lease, easement or right-of-entry) with status",
      evidence: ["Title, easement or right-of-entry record, owner-verified"], recovery: "If control fails, return to M1 and re-screen an alternate site or route." });
  }
  s.push({ id: "t.grants.discovery", code: "GR-01", stage: "grants", title: "Find and qualify grant and incentive opportunities", role: "Grants lead", deps: ["t.dev.alternatives"], durationDays: 15,
    inputs: ["Preferred option scope and cost range"], output: "Opportunity register: source, applicant/activity fit, deadline, match, missing evidence",
    evidence: ["Official program page link with retrieval date per opportunity"], recovery: "If a window is missed, record the miss and target the next cycle or an alternate program." });
  s.push({ id: "t.grants.application", code: "GR-02", stage: "grants", title: "Register, gather letters and quotes, and submit grant application", role: "Grants lead", deps: ["t.grants.discovery"], durationDays: 30,
    inputs: ["Opportunity register", "Cost quote", "Support letters", "Internal approval"], output: "Submitted application packet with confirmation receipt",
    evidence: ["Portal submission receipt", "Applicant registration confirmed active"], recovery: "If submission is late or rejected, log it, notify finance, and re-plan funding under CAP-02." });
  s.push({ id: "t.cap.funding", code: "CAP-02", stage: "capital", gate: "M3", title: `Approve budget and funding path for "${opt}"`, role: "Finance lead", deps: ["t.dev.alternatives", "t.grants.application"], durationDays: 30,
    inputs: ["Cost baseline", "Grant status"], output: "Sources-and-uses with status-labeled funding and residual gap",
    evidence: ["Budget approval or appropriation record", "Signed funding notice (pending awards excluded from committed total)"], recovery: "If funding is short, phase scope or revisit the option at M1; never count pending awards." });
  s.push({ id: "t.permits.applicability", code: "PER-02", stage: "permits", title: "Identify authorities and verify permit/agreement applicability", role: "Permitting / compliance lead", deps: ["t.dev.alternatives"], durationDays: 20,
    inputs: ["Option scope", "Site/route"], output: "Requirement set with a disposition per instrument (required / not applicable with rationale / unknown)",
    evidence: ["Authority contact record or official rule citation per item"], recovery: "Unknown applicability stays open as a named question to the authority; never assume exemption." });
  s.push({ id: "t.eng.design_basis", code: "DEV-10", stage: "engineering", title: `Establish design basis for "${opt}"`, role: "Owner engineer", deps: build ? ["t.dev.alternatives", "t.land.site_control"] : ["t.dev.alternatives"], durationDays: 30,
    inputs: ["Evidence task outputs", "Site control status"], output: "Design basis and requirements baseline",
    evidence: ["Design basis memo reviewed by owner engineer"], recovery: "If inputs change, issue a revised basis and flag affected permits and quotes." });
  s.push({ id: "t.eng.design", code: "DEV-11", stage: "engineering", title: "Complete design package", role: "Design consultant / EPC", deps: ["t.eng.design_basis"], durationDays: 60,
    inputs: ["Design basis"], output: "Issued-for-permit design package",
    evidence: ["Design review comments dispositioned"], recovery: "If review fails, issue a revised package and re-run affected permit items." });
  s.push({ id: "t.permits.dossier", code: "PER-03", stage: "permits", gate: "M4", title: "Prepare and submit permit and agreement dossiers", role: "Permitting / compliance lead", deps: ["t.permits.applicability", "t.eng.design"], durationDays: 45,
    inputs: ["Requirement set", "Design package"], output: "Instruments recorded with conditions, expiry and renewal dates",
    evidence: ["Issued instrument from the authority (reference number); app task completion is not an approval"], recovery: "If denied or conditioned, record conditions and route the design change back to engineering." });
  s.push({ id: "t.proc.package", code: "PROC-01", stage: "procurement", title: "Scope packages, qualify nearby contractors, and list compatible equipment", role: "Procurement lead", deps: ["t.eng.design"], durationDays: 30,
    inputs: ["Design package", "Long-lead list"], output: "Solicitation with qualified bidder list and compatible equipment candidates",
    evidence: ["Contractor license class verified against scope at the licensing board", "At least one alternate supplier per long-lead item"],
    recovery: "If a contractor license mismatches the scope, disqualify and re-solicit; if equipment is unavailable, switch to the alternate supplier." });
  s.push({ id: "t.proc.award", code: "PROC-04", stage: "procurement", gate: "M5", title: "Compare quotes and execute contract", role: "Procurement lead", deps: ["t.proc.package", "t.cap.funding", "t.permits.dossier"], durationDays: 30,
    inputs: ["Quotes", "Funding status", "Instruments"], output: "Executed contract and notice-to-proceed readiness",
    evidence: ["Quote comparison", "Signed contract", "Funding encumbrance"], recovery: "If prices exceed budget or a protest is filed, re-bid or rescope and hold NTP." });
  if (build) {
    s.push({ id: "t.const.mobilize", code: "CONST-01", stage: "construction", title: "Mobilize and start construction", role: "Construction manager", deps: ["t.proc.award"], durationDays: 15,
      inputs: ["Contract", "Permit conditions"], output: "Mobilization readiness record", evidence: ["Pre-construction meeting minutes", "Permit conditions posted"],
      recovery: "If mobilization is blocked by a permit condition, hold and resolve with the authority before work." });
    s.push({ id: "t.const.complete", code: "CONST-06", stage: "construction", gate: "M6", title: "Reach substantial completion and classify punch list", role: "Construction manager", deps: ["t.const.mobilize"], durationDays: 120,
      inputs: ["Field records", "Inspections"], output: "Substantial completion record with classified punch list",
      evidence: ["Inspection and test records for critical items", "No unresolved critical nonconformance"], recovery: "A critical nonconformance blocks the gate: correct, re-inspect, and revise the baseline by approved change." });
  }
  s.push({ id: "t.turn.commission", code: "TURN-02", stage: "commissioning", title: "Execute commissioning tests", role: "Commissioning agent", deps: [build ? "t.const.complete" : "t.proc.award"], durationDays: 20,
    inputs: ["Commissioning plan"], output: "Commissioning test results against pass criteria",
    evidence: ["Signed test results; a failed test is never shown as passed"], recovery: "Failed commissioning: correct, retest, and record the retest as a new result." });
  s.push({ id: "t.turn.accept", code: "TURN-05", stage: "commissioning", gate: "M7", title: "Accept into service and hand over to operations", role: "Asset owner", deps: ["t.turn.commission"], durationDays: 10,
    inputs: ["Test results", "Handover dossier"], output: "Acceptance record with named operational custodian",
    evidence: [...acceptance, "Handover dossier complete or exceptions dispositioned"], recovery: "Conditional acceptance only with named owner, limits and review date." });
  s.push({ id: "t.ops.baseline", code: "OPS-01", stage: "operations", title: "Set asset baseline and recurring maintenance plan", role: "Operations owner", deps: ["t.turn.accept"], durationDays: 30,
    inputs: ["Handover dossier"], output: "Asset baseline and maintenance plan", evidence: ["Maintenance plan accepted by operations owner"],
    recovery: "If telemetry is missing, schedule manual inspections and flag data freshness." });
  s.push({ id: "t.ops.renewal", code: "OPS-03", stage: "operations", gate: "M8", title: "Track warranty and permit renewals and plan lifecycle renewal", role: "Asset manager", deps: ["t.ops.baseline"], durationDays: 30,
    inputs: ["Instrument register", "Warranty terms"], output: "Renewal register and renewal/retirement decision date",
    evidence: ["Renewal dates copied from each instrument", "Annual renewal forecast review"], recovery: "If a post-handover renewal is missed, record the lapse, file the late renewal, and restrict affected operation." });
  s.push({ id: "t.ret.plan", code: "RET-01", stage: "decommissioning", gate: "M9", title: "Plan retirement, disposition and records archive", role: "Asset manager", deps: ["t.ops.renewal"], durationDays: 60,
    inputs: ["Renewal register", "Obligations"], output: "Retirement plan with disposition, obligations and archive",
    evidence: ["Accepted dispositions for asset, obligations and records"], recovery: "An open obligation blocks closure unless an authorized waiver with rationale is recorded." });
  return s;
}

// ---------------------------------------------------------------- helpers

const FRESH_DAYS: Record<Evidence["kind"], number> = { snapshot: 30, model_run: 30, observation: 90, document: 365, attestation: 365 };

function freshness(e: Evidence, asOfDay: number): Evidence["freshness"] {
  if (!/^\d{4}-\d{2}-\d{2}/.test(e.retrievedAt)) return "unknown";
  return asOfDay - dayOf(e.retrievedAt) > FRESH_DAYS[e.kind] ? "stale" : "fresh";
}

function riskFor(input: PlanInput, scenario: Scenario): PlanRisk | null {
  if (!input.gridRisk) return null;
  return scenario === "heatwave" ? input.gridRisk.heatwave : input.gridRisk.baseline;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function reqFor(key: string): Requirement {
  return REQUIREMENTS[key] ?? R(key, key.replace(/_/g, " "), `Obtain ${key.replace(/_/g, " ")}`, "Analyst", `${key.replace(/_/g, " ")} with source and date`,
    ["Source document with date"], "If unavailable, record as unknown with reason and proceed provisionally.", 14);
}

function missingReason(v: boolean | Unknown | undefined): string | null {
  if (v === true) return null;
  if (v === undefined) return "Not stated in the plan input.";
  if (v === false) return "Stated as unavailable.";
  if (v.state === "not_applicable") return null;
  return `${v.state}: ${v.reason}`;
}

// ---------------------------------------------------------------- main

export function buildOwnerPlan(input: PlanInput, opts: BuildOptions): BuiltOwnerPlan {
  const { scenario, asOf } = opts;
  const asOfDay = dayOf(asOf);
  const asOfDate = isoDay(asOfDay);
  const key = planKey(input.target);
  const sector = input.target.sector;
  const inputsHash = digest({ input, scenario, asOf, edits: opts.edits ?? null });

  // ---- draft scoping
  let edits: DraftEdits | null = opts.edits ?? null;
  let rejected: string | null = null;
  if (edits && edits.planKey !== key) {
    rejected = `Draft belongs to ${edits.planKey}, not ${key}; not applied.`;
    edits = null;
  }

  // ---- evidence freshness (recomputed against asOf)
  const evidence: Evidence[] = input.evidence.map((e) => ({ ...e, freshness: freshness(e, asOfDay) }));
  const scanEvidenceIds = evidence.filter((e) => e.id.startsWith("e.scan")).map((e) => e.id);

  // ---- facts
  const facts: Fact[] = [...input.facts];
  facts.push({ id: "f.plan.scope", subject: input.target.label ?? key, predicate: "plan_scope", value: input.scope, provenance: input.origin === "fixture" ? "user_assertion" : "model", evidence: [], asOf });
  facts.push({ id: "f.plan.synthetic", subject: input.target.label ?? key, predicate: "synthetic_scenario_inputs", value: input.synthetic, provenance: "user_assertion", evidence: [], asOf });
  const risk = riskFor(input, scenario);
  if (risk) {
    for (const f of risk.factors) {
      facts.push({ id: `f.risk.${f.key}`, subject: input.target.label ?? key, predicate: `risk_factor_${f.key}`,
        value: f.assessed ? f.score : { state: "not_assessed", reason: f.reason ?? "Not assessed." }, unit: "0-100", provenance: "model", evidence: scanEvidenceIds, asOf });
    }
    facts.push({ id: "f.risk.composite", subject: input.target.label ?? key, predicate: "risk_composite_six_factor", value: risk.score, unit: "0-100", provenance: "model", evidence: scanEvidenceIds, asOf });
  } else {
    facts.push({ id: "f.risk.grid_factors", subject: input.target.label ?? key, predicate: "risk_factor_six_grid",
      value: { state: "not_applicable", reason: sector === "electric" ? "No Area Scan supplied for this electric target." : `Six grid factors score electrical scans only; ${sector} risk uses sector evidence.` },
      provenance: "model", evidence: [], asOf });
  }
  for (const m of input.milestones) {
    facts.push({ id: `f.milestone.${m.id}.baseline`, subject: m.id, predicate: "milestone_baseline_date", value: m.due, provenance: "user_assertion", evidence: m.evidence, asOf });
    if (m.forecast && m.forecast !== m.due) {
      facts.push({ id: `f.milestone.${m.id}.forecast`, subject: m.id, predicate: "milestone_forecast_date", value: m.forecast, provenance: "user_assertion", evidence: m.evidence, asOf, supersedes: `f.milestone.${m.id}.baseline` });
    }
  }
  for (const ef of edits?.facts ?? []) {
    const prior = facts.find((f) => f.subject === ef.subject && f.predicate === ef.predicate && f.id !== ef.id);
    facts.push(prior && !ef.supersedes ? { ...ef, supersedes: prior.id } : ef);
  }

  // ---- findings
  const riskFindings: Finding[] = [];
  const heatFindingIds = new Set<string>();
  if (risk) {
    const ranked = [...risk.factors].sort((a, b) => b.score * b.weight - a.score * a.weight || cmp(a.key, b.key));
    const contributions: Record<string, number> = {};
    for (const f of risk.factors) contributions[f.key] = round2(f.score * f.weight);
    for (const f of ranked.slice(0, 2)) {
      const id = `r.grid.${f.key}`;
      if (f.key === "heat") heatFindingIds.add(id);
      riskFindings.push({
        id, kind: "risk", title: `${f.label}: ${f.score}/100 (weight ${f.weight})`, score: f.score, factors: { ...contributions }, evidence: scanEvidenceIds,
        detail: `${f.detail} Composite ${risk.score}/100 from six weighted factors (${risk.method}); factors map holds each factor's weighted contribution.${f.assessed ? "" : ` Not assessed: ${f.reason}`} Scope: ${input.scope}. Provenance: model.`,
      });
    }
  }
  const sectorRanked = [...input.sectorRisks]
    .map((r) => ({ r, s: scenario === "heatwave" && r.heatwaveScore !== undefined ? r.heatwaveScore : r.score }))
    .sort((a, b) => b.s - a.s || cmp(a.r.id, b.r.id));
  for (const { r, s } of sectorRanked) {
    if (scenario === "heatwave" && r.heatwaveScore !== undefined && r.heatwaveScore > r.score) heatFindingIds.add(r.id);
    riskFindings.push({ id: r.id, kind: "risk", title: r.title, score: s, factors: { ...r.factors }, evidence: r.evidence,
      detail: `${r.detail}${scenario === "heatwave" && r.heatwaveScore !== undefined ? ` Heatwave score ${r.heatwaveScore} (baseline ${r.score}).` : ""} Scope: ${input.scope}.` });
  }

  const sustFindings: Finding[] = [...input.sustainability]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || cmp(a.id, b.id))
    .map((s) => ({ id: s.id, kind: "sustainability" as const, title: s.title, ...(s.score !== undefined ? { score: s.score } : {}), evidence: s.evidence, detail: s.detail }));

  const gapFindings: Finding[] = [];
  const missingReqs: Requirement[] = [];
  const reqKeys: string[] = [];
  for (const k of [...SECTOR_DEFAULT_REQUIREMENTS[sector], ...input.data.map((d) => d.key)]) if (!reqKeys.includes(k)) reqKeys.push(k);
  for (const k of reqKeys) {
    const status = input.data.find((d) => d.key === k)?.available;
    const why = missingReason(status);
    if (why === null) continue;
    const req = reqFor(k);
    missingReqs.push(req);
    gapFindings.push({ id: `g.data.${k}`, kind: "gap", title: `Missing: ${req.label}`, evidence: [], detail: `${why} Named evidence task: "${req.task}".` });
  }
  if (sustFindings.length === 0) {
    gapFindings.push({ id: "g.sustainability", kind: "gap", title: "Sustainability baseline not assessed", evidence: [], detail: "No energy, emissions or material baseline in the input; nameplate is not used as a proxy." });
  }
  const stale = evidence.filter((e) => e.freshness === "stale");
  for (const e of stale) gapFindings.push({ id: `g.stale.${e.id}`, kind: "gap", title: `Stale evidence: ${e.title}`, evidence: [e.id], detail: `Retrieved ${e.retrievedAt.slice(0, 10)}; older than ${FRESH_DAYS[e.kind]} days at ${asOfDate}.` });
  if (risk) for (const f of risk.factors) if (!f.assessed) gapFindings.push({ id: `g.factor.${f.key}`, kind: "gap", title: `Risk factor not assessed: ${f.label}`, evidence: scanEvidenceIds, detail: f.reason ?? "Not assessed." });
  if (scenario === "heatwave") {
    gapFindings.sort((a, b) => {
      const ha = missingReqs.find((r) => `g.data.${r.key}` === a.id)?.heat ? 0 : 1;
      const hb = missingReqs.find((r) => `g.data.${r.key}` === b.id)?.heat ? 0 : 1;
      return ha - hb;
    });
  }
  const findings = [...riskFindings, ...sustFindings, ...gapFindings];
  const riskIds = riskFindings.map((f) => f.id);

  // ---- options
  const options: PlanOption[] = input.options.map((o) => ({ id: o.id, kind: o.kind, title: o.title, assumptions: o.assumptions, addresses: o.addresses ?? riskIds, tradeoffs: o.tradeoffs }));
  const needed: OptionKind[] = ["repair", "operating_change", "replacement", "defer"];
  if (input.stage === "intake" || input.stage === "feasibility") needed.push("do_nothing");
  for (const kind of needed) {
    if (options.some((o) => o.kind === kind)) continue;
    const g = GENERIC_OPTIONS[sector][kind];
    options.push({ id: `o.generic.${kind}`, kind, title: g.title, addresses: kind === "do_nothing" ? [] : riskIds, tradeoffs: g.tradeoffs,
      assumptions: [{ id: `f.option.${kind}.capital`, subject: `o.generic.${kind}`, predicate: "capital_cost", value: { state: "not_assessed", reason: "Generic option; no cost basis yet." }, unit: "USD", provenance: "model", evidence: [], asOf }] });
  }
  options.sort((a, b) => OPTION_ORDER.indexOf(a.kind) - OPTION_ORDER.indexOf(b.kind) || cmp(a.id, b.id));

  const requested = edits && edits.selectedOption !== undefined ? edits.selectedOption : input.provisionalOption;
  const selected = requested !== null && options.some((o) => o.id === requested) ? requested : null;
  const selOpt = options.find((o) => o.id === selected) ?? null;

  // ---- tasks
  const steps = buildSteps(selOpt?.kind ?? null, selOpt?.title ?? "", input.acceptanceCriteria);
  const evSteps: (Step & { heat: boolean })[] = missingReqs.map((r) => ({
    id: `t.evidence.${r.key}`, code: "DEV-03", stage: "feasibility" as StageId, title: r.task, role: r.role, deps: [], durationDays: r.durationDays,
    inputs: ["Data request to the record holder"], output: r.output, evidence: r.acceptance, recovery: r.recovery, heat: !!r.heat,
  }));
  for (const e of stale) {
    evSteps.push({ id: `t.refresh.${e.id}`, code: "DEV-03", stage: "feasibility", title: `Refresh stale evidence: ${e.title}`, role: "Analyst", deps: [], durationDays: 5,
      inputs: [e.title], output: "Re-retrieved evidence with new retrieval date and hash", evidence: ["New snapshot with retrieval timestamp"],
      recovery: "If the source is gone, keep the stale copy labeled stale and find a replacement source.", heat: false });
  }
  const alt = steps.find((x) => x.id === "t.dev.alternatives");
  if (alt) alt.deps = [...alt.deps, ...evSteps.map((e) => e.id)];
  const heatSteps: (Step & { heat: boolean })[] = [];
  if (scenario === "heatwave") {
    const h = HEAT_TASK[sector];
    heatSteps.push({ id: "t.heat.interim", code: "OPS-02", stage: "operations", title: h.title, role: h.role, deps: [], durationDays: 7,
      inputs: ["Heatwave scenario findings"], output: h.output, evidence: ["Dated readiness record signed by the operations lead"],
      recovery: "If readiness cannot be confirmed before the event, apply the conservative limit and notify the owner.", heat: true });
  }
  const all: (Step & { heat: boolean })[] = [...heatSteps, ...evSteps, ...steps.map((x) => ({ ...x, heat: false }))];
  const byId = new Map(all.map((x) => [x.id, x]));

  // milestone → task constraints
  const constraint = new Map<string, number>();
  const msTask = new Map<string, string | null>();
  for (const m of input.milestones) {
    // taskId === null marks an informational milestone (dated, reported, constrains no task).
    const tid = m.taskId === null ? null : m.taskId && byId.has(m.taskId) ? m.taskId : gateTaskFor(m, steps);
    msTask.set(m.id, tid);
    if (!tid) continue;
    const d = dayOf(m.forecast ?? m.due);
    constraint.set(tid, Math.min(constraint.get(tid) ?? Infinity, d));
  }
  let anchor: number | null = null;
  if (input.targetDate) anchor = dayOf(input.targetDate);
  else if (input.milestones.length) anchor = Math.max(...input.milestones.map((m) => dayOf(m.forecast ?? m.due)));
  if (input.targetDate && anchor !== null) {
    const anchorTask = byId.has("t.turn.accept") ? "t.turn.accept" : byId.has("t.dev.revisit") ? "t.dev.revisit" : "t.dev.alternatives";
    if (!constraint.has(anchorTask)) constraint.set(anchorTask, anchor);
  }

  // topological order (deterministic)
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const d of byId.get(id)!.deps) if (byId.has(d)) visit(d);
    order.push(id);
  };
  for (const x of all) visit(x.id);
  const succ = new Map<string, string[]>();
  for (const x of all) for (const d of x.deps) succ.set(d, [...(succ.get(d) ?? []), x.id]);

  // backward pass
  const lf = new Map<string, number>();
  const ls = new Map<string, number>();
  for (const id of [...order].reverse()) {
    let f = constraint.get(id) ?? Infinity;
    for (const s of succ.get(id) ?? []) if (ls.has(s)) f = Math.min(f, ls.get(s)!);
    if (f !== Infinity) { lf.set(id, f); ls.set(id, f - byId.get(id)!.durationDays); }
  }
  // forward pass for tasks with no downstream date
  const start = new Map<string, number>();
  const finish = new Map<string, number>();
  for (const id of order) {
    const x = byId.get(id)!;
    if (ls.has(id)) { start.set(id, ls.get(id)!); finish.set(id, lf.get(id)!); continue; }
    const es = Math.max(asOfDay, ...x.deps.filter((d) => finish.has(d)).map((d) => finish.get(d)!));
    start.set(id, es);
    finish.set(id, es + x.durationDays);
  }

  // merge edits
  const taskEdits = edits?.tasks ?? {};
  const applied: string[] = [];
  const tasks: OwnerTaskWithNotes[] = all.map((x) => {
    const e: TaskEdit | undefined = taskEdits[x.id];
    const t: OwnerTaskWithNotes = {
      id: x.id, code: x.code, title: x.title, role: x.role, stage: x.stage, ...(x.gate ? { gate: x.gate } : {}), dependsOn: x.deps.filter((d) => byId.has(d)),
      offsetDays: start.get(x.id)! - asOfDay, durationDays: x.durationDays, inputs: x.inputs, output: x.output, evidence: x.evidence, recovery: x.recovery,
      due: isoDay(finish.get(x.id)!), status: "not_started",
    };
    if (e) {
      applied.push(x.id);
      if (e.title !== undefined) t.title = e.title;
      if (e.owner !== undefined) t.owner = e.owner;
      if (e.due !== undefined) t.due = e.due;
      if (e.status !== undefined) t.status = e.status;
      if (e.evidence !== undefined) t.evidence = e.evidence;
      if (e.notes !== undefined) t.notes = e.notes;
    }
    return t;
  });
  const orphaned = Object.keys(taskEdits).filter((id) => !byId.has(id)).sort(cmp).map((taskId) => ({ taskId, edit: taskEdits[taskId] }));
  applied.sort(cmp);

  // priority: heat work first under heatwave, then evidence, then the delivery chain
  const rank = (x: Step & { heat: boolean }) => (scenario === "heatwave" && x.heat ? 0 : x.id.startsWith("t.evidence.") || x.id.startsWith("t.refresh.") ? 1 : 2);
  const idx = new Map(all.map((x, i) => [x.id, i]));
  tasks.sort((a, b) => rank(byId.get(a.id)!) - rank(byId.get(b.id)!) || a.offsetDays - b.offsetDays || idx.get(a.id)! - idx.get(b.id)!);

  const status = new Map(tasks.map((t) => [t.id, t.status]));
  const next = tasks.find((t) => (t.status === "not_started" || t.status === "in_progress") && t.dependsOn.every((d) => status.get(d) === "done")) ?? null;
  const waitingOn = tasks.filter((t) => t.status === "waiting" || t.status === "blocked").map((t) => `${t.title} (${t.owner ?? t.role}, ${t.status})`);

  const deadlines: { taskId: string; due: string; kind: string }[] = [];
  for (const m of input.milestones) {
    const tid = msTask.get(m.id);
    deadlines.push({ taskId: tid ?? m.id, due: m.forecast ?? m.due, kind: `milestone:${m.id}${tid ? "" : m.taskId === null ? ":info" : ":unmapped"}` });
  }
  for (const t of tasks) {
    if (t.status === "done") continue;
    if (t.offsetDays < 0 && ls.has(t.id)) deadlines.push({ taskId: t.id, due: isoDay(start.get(t.id)!), kind: "late_start" });
    if (taskEdits[t.id]?.due !== undefined) deadlines.push({ taskId: t.id, due: t.due!, kind: "owner_due" });
  }
  deadlines.sort((a, b) => cmp(a.due, b.due) || cmp(a.taskId, b.taskId) || cmp(a.kind, b.kind));

  const draft: DraftReport = { planKey: edits?.planKey ?? opts.edits?.planKey ?? key, applied, orphaned, rejected };
  const body = {
    schema: "gridsentinel.owner-plan/1" as const,
    target: input.target,
    scenario,
    findings,
    options,
    selectedOption: selected,
    tasks,
    nextAction: next ? `${next.title} (${next.owner ?? next.role}, due ${next.due})` : null,
    nextTaskId: next?.id ?? null,
    waitingOn,
    deadlines,
    facts,
    evidence,
    draft,
    scheduleAnchor: anchor === null ? null : isoDay(anchor),
    scheduleMode: (anchor === null && input.milestones.length === 0 ? "forward" : "back") as "back" | "forward",
    inputsHash,
  };
  return { ...body, outputHash: digest(body) };
}

function gateTaskFor(m: PlanMilestone, steps: Step[]): string | null {
  const inStage = steps.filter((x) => x.stage === m.stage);
  if (!inStage.length) return null;
  const gated = m.gate ? inStage.find((x) => x.gate === m.gate) : undefined;
  return (gated ?? inStage.find((x) => x.gate) ?? inStage[inStage.length - 1]).id;
}

/** Pure reforecast: returns a new input whose named milestones carry forecast dates. Baselines are never overwritten. */
export function reforecastMilestones(input: PlanInput, moves: { id: string; to: string; reason: string }[]): PlanInput {
  const ids = new Set(input.milestones.map((m) => m.id));
  for (const mv of moves) if (!ids.has(mv.id)) throw new Error(`reforecastMilestones: unknown milestone ${mv.id}`);
  return {
    ...input,
    milestones: input.milestones.map((m) => {
      const mv = moves.find((x) => x.id === m.id);
      return mv ? { ...m, forecast: mv.to, forecastReason: mv.reason } : m;
    }),
  };
}

export { isUnknown };
