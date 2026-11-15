// Deterministic owner procedure catalog.
//
// Every procedure ID defined in the three procedure manuals is encoded here as
// typed `ProcedureStep` data:
//   docs/INFRASTRUCTURE-PROCEDURES-DEVELOPMENT.md    (DEV-01..DEV-19)
//   docs/INFRASTRUCTURE-PROCEDURES-AUTHORIZATIONS.md (CAP, GR, PER, AGR, CHG)
//   docs/INFRASTRUCTURE-PROCEDURES-DELIVERY.md       (PROC, CONST, TURN, OPS, RET)
//
// Faithfulness rules: inputs/outputs/acceptance/recovery paraphrase the doc
// text under the cited heading. Where a doc is silent, the field carries an
// explicit "not specified in <doc>#<heading>" string. Preconditions are
// procedure codes or ids from RULE_IDS; the basis for each is commented
// inline. No doc states durations, so instantiated tasks use the documented
// DEFAULT_DURATION_DAYS placeholder.
//
// This module is pure: no I/O, no clock, no randomness.

import type { GateId, OwnerTask, ProcedureStep, StageId } from "./types";

const DEV_DOC = "docs/INFRASTRUCTURE-PROCEDURES-DEVELOPMENT.md";
const AUTH_DOC = "docs/INFRASTRUCTURE-PROCEDURES-AUTHORIZATIONS.md";
const DEL_DOC = "docs/INFRASTRUCTURE-PROCEDURES-DELIVERY.md";

/** Procedure manuals whose headings define the catalog. */
export const PROCEDURE_DOCS = [DEV_DOC, AUTH_DOC, DEL_DOC] as const;

/** Lifecycle stage order (docs/INFRASTRUCTURE-WORKFLOWS.md#lifecycle-map-and-parallel-work, rows 1-11; row 5 split 5A grants / 5B permits). */
export const STAGE_ORDER: readonly StageId[] = [
  "intake",
  "feasibility",
  "site_control",
  "capital",
  "grants",
  "permits",
  "engineering",
  "procurement",
  "construction",
  "commissioning",
  "operations",
  "decommissioning",
];

/**
 * Stage -> default milestone, from docs/INFRASTRUCTURE-WORKFLOWS.md.
 * The doc has no literal table; this is assembled from the "Default milestones"
 * sentence (#lifecycle-map-and-parallel-work) and each section's
 * "Completion / acceptance" paragraph:
 *   intake M0 (s1 "M0 when accepted"), feasibility M1 (s2 "M1 when"),
 *   site_control M2 ("M2 site/control path"; s3 says "Site-control milestone"),
 *   capital M3 (s4 "M3 requires"), permits M4 (s5B "M4 requirement set"),
 *   engineering M4 ("M4 design and external approvals ready"),
 *   procurement M5 ("M5 notice-to-proceed readiness"; s8 trigger "M5 authorization/readiness and contracted package"),
 *   construction M6 (s8 "M6 when"), commissioning M7 (s9 "M7 requires"),
 *   operations M8 ("M8 renewal/retirement decision"; s10 "remain open until renewal, transfer, or retirement decision"),
 *   decommissioning M9 (s11 "M9 when").
 * grants: s5A names no milestone, so no gate is assigned (null). This table is the
 * single source of truth: lifecycle.ts GATE_STAGE is derived from it, so grants
 * procedures reach no gate (they are marked non_gating). Individual steps whose
 * doc text names a different gate carry `gateOverride` (see GATE_OVERRIDES).
 */
export const STAGE_GATE: Readonly<Record<StageId, GateId | null>> = {
  intake: "M0",
  feasibility: "M1",
  site_control: "M2",
  capital: "M3",
  grants: null,
  permits: "M4",
  engineering: "M4",
  procurement: "M5",
  construction: "M6",
  commissioning: "M7",
  operations: "M8",
  decommissioning: "M9",
};

/** Non-procedure precondition ids. Each names the doc text it encodes. */
export const RULE_IDS: Readonly<Record<string, { description: string; sourceDoc: string }>> = {
  "gate.M5": {
    description: "M5 authorization/readiness recorded (construction trigger: 'M5 authorization/readiness and contracted package').",
    sourceDoc: "docs/INFRASTRUCTURE-WORKFLOWS.md#8-construction",
  },
  "trigger.assurance_configured": {
    description: "Owner-configured risk, novelty, consequence, uncertainty, or decision-gate trigger for independent assurance.",
    sourceDoc: `${DEV_DOC}#dev-16--commission-independent-assurance-and-challenge`,
  },
};

/** Placeholder task duration. No procedure doc states a duration; the docs require dates to come from owner-configured sources. 1 day only orders tasks; it is not a forecast. */
export const DEFAULT_DURATION_DAYS = 1;

/** GitHub-style heading anchor (lowercase, drop punctuation, spaces -> hyphens). */
export function headingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

const notSpecified = (doc: string, heading: string) => `not specified in ${doc}#${headingAnchor(heading)}`;

/** Marker in a Def's acceptance list: the doc section has no acceptance statement. */
const UNSPECIFIED = "\u0000unspecified";

interface Def {
  code: string;
  stage: StageId;
  doc: string;
  heading: string;
  role: string;
  inputs: string[];
  preconditions: string[];
  outputs: string[];
  acceptance: string[];
  /** null -> doc is silent; replaced by an explicit "not specified" string. */
  recovery: string | null;
  blocksGateOn?: string[];
}

function build(d: Def): ProcedureStep {
  const title = d.heading.replace(/^[A-Z]{2,5}-\d{2}\s+—\s+/, "").replace(/\s+\(row \d+\)$/, "");
  const gate = STAGE_GATE[d.stage];
  const step: ProcedureStep = {
    code: d.code,
    stage: d.stage,
    title,
    role: d.role,
    inputs: d.inputs,
    preconditions: d.preconditions,
    outputs: d.outputs,
    acceptance: d.acceptance.map((a) =>
      a === UNSPECIFIED ? `${notSpecified(d.doc, d.heading)} (no acceptance statement in section)` : a,
    ),
    recovery: d.recovery ?? notSpecified(d.doc, d.heading),
    sourceDoc: `${d.doc}#${headingAnchor(d.heading)}`,
  };
  if (gate) step.gate = gate;
  if (d.blocksGateOn && d.blocksGateOn.length) step.blocksGateOn = d.blocksGateOn;
  return step;
}

const DEFS: Def[] = [
  // ---------------------------------------------------------------- intake
  {
    code: "DEV-01", stage: "intake", doc: DEV_DOC, heading: "DEV-01 — Register need or event",
    role: "Intake coordinator (duty lead owns urgent triage; case manager accepts lifecycle)",
    inputs: [
      "Reporter observation in reporter's words, or anonymous flag, with callback channel",
      "Source/channel, received timestamp and time zone",
      "Location geometry or text with coordinate system, positional uncertainty and access restriction",
      "Asset ID or 'unknown'; affected service/population if known",
      "Immediate action already taken and by whom; current service condition",
      "Urgency category from owner-configured list; known hazard; incident/external reference",
      "Attachments with provenance; personal/sensitive data flag",
    ],
    preconditions: [], // entry point
    outputs: [
      "Immutable intake record (report_id) with preserved source evidence",
      "Duplicate candidates linked (never auto-merged)",
      "Disposition: accept, defer, link to existing case, or reject with reason",
      "Assigned duty lead, next action/date, and lifecycle case manager",
      "Handoff packet: report, location uncertainty, condition, affected service, acknowledgements, privacy label, open questions, next update",
    ],
    acceptance: [
      "Source retained, decision recorded, urgency/route set, accountable role assigned, next action and date present",
      "Unresolved critical information has an owner",
      "Emergency branch has response handoff acknowledgement or documented failed-contact escalation",
      "Rejected/deferred cases retain reason and review path",
    ],
    recovery:
      "Anonymous: route by available facts. Unknown asset: create unresolved location task, never invent link. Conflicting accounts: retain both, assign verification. Duplicate: link and state canonical record. Out-of-hours: configured rota/escalation, log contact attempts. Sensitive: restrict, redact, assign custodian. Reporter unreachable: record attempts, proceed on available evidence where authorized.",
  },
  {
    code: "DEV-02", stage: "intake", doc: DEV_DOC, heading: "DEV-02 — Emergency coordination and stabilization record",
    role: "Duty contact / asset owner and operations lead (emergency authorities retain operational command)",
    inputs: [
      "Incoming alert and callback from intake",
      "Event log entries: timestamp/time zone, observed condition and source, affected asset/service/location, severity basis under configured playbook",
      "Current incident commander/response contact role and acknowledgements",
    ],
    preconditions: ["DEV-01"], // DEV-01 step 2: urgent intake is handed to response authority
    outputs: [
      "Event log with each transfer (sender/receiver, state, restrictions, hazards, actions, next report time)",
      "Stabilization review: timeline, interruption/restoration state, temporary measures, hazards, monitoring needs, residual restrictions",
      "Follow-up disposition: capital/renewal case, maintenance work, monitoring task, or no further action",
      "Linked capital case when permanent work is needed (carrying need, chronology, baseline, temporary works, restrictions, commitments)",
    ],
    acceptance: [
      "Response branch closes only on named response authority/asset owner acknowledgement",
      "Current service condition and residual risks recorded; temporary measures assigned; next lifecycle disposition approved",
      "Capital conversion has linked case ID, sponsor, initial scope, funding/authorization path, baseline gaps, accountable project owner",
    ],
    recovery:
      "Do not infer resolution from elapsed time or silence; schedule stabilization review only when response authority declares handoff complete. Emergency choice does not become the preferred permanent design: re-run feasibility and option appraisal. No capital case may silently close incident obligations.",
  },
  {
    code: "DEV-03", stage: "intake", doc: DEV_DOC, heading: "DEV-03 — Triage and establish service baseline",
    role: "Accountable owner with operator, maintainer and data custodian",
    inputs: [
      "Accepted intake",
      "Service boundary, interfaces, coverage, dependent users/assets",
      "Capacity/demand measures with units; observed load with period and source",
      "Performance/reliability measures, outage history, asset condition and inspection date",
      "Critical dependencies, staffing assumptions, constraints, commitments",
    ],
    preconditions: ["DEV-01"], // "Convert accepted intake into a decision-ready description"
    outputs: [
      "Accepted, frozen baseline version (appraisal reference) with as-of date",
      "Responsibility matrix (owner, operator, maintainer, data custodian, design/incident/funding authority, interface owner)",
      "Data-gap register with owner, closure method and interim assumption",
      "Source register and discrepancy notes",
    ],
    acceptance: [
      "Baseline package has service map/boundary, responsibility matrix, dated measures and definitions, source register, gap log, reviewer acceptance, named update owner",
      "Any decision using an unresolved gap cites the gap, sensitivity and revisit trigger",
    ],
    recovery:
      "Record source discrepancies instead of silently selecting one; mark values verified/estimated/reported/stale/disputed/unknown. Commission investigation for critical gaps. Role conflicts go to sponsor/asset owner before the dependent gate. A low-confidence baseline supports only scoped study or provisional options.",
  },
  {
    code: "DEV-14", stage: "intake", doc: DEV_DOC, heading: "DEV-14 — Discover and reconcile asset configuration",
    role: "Asset information manager",
    inputs: [
      "Intake asset reference that cannot be matched, conflicting asset records, or multi-system service boundary",
      "Approved asset, GIS, maintenance, incident, drawing and operator records with extraction dates",
      "Owner/operator confirmation of service boundary and configuration",
    ],
    preconditions: ["DEV-01"], // "Use when intake references an asset that cannot be matched"
    outputs: [
      "Discovery record with candidates marked confirmed/possible/rejected/retired/unknown and reproducible query/extract reference",
      "Provisional asset references with explicit uncertainty and field verification task where no reliable record exists",
      "Reconciled asset map and discrepancy list handed to DEV-03 baseline owner and DEV-04 appraisal team",
    ],
    acceptance: [
      "Asset owner or delegated custodian accepts identity/configuration or explicitly accepts provisional status",
      "Service boundary, lineage, confidence and outstanding verification task linked to case",
      "Handoff recipient acknowledges the exact map/register version",
    ],
    recovery:
      "Conflicting IDs: preserve all candidates, assign reconciliation authority, use temporary case ID. Missing drawings: commission survey/inspection. Asset outside owner's control: route to interface owner. Sensitive map: restrict geometry, generalize for reporting. Unknown configuration does not stop urgent response but blocks design claims relying on it.",
    blocksGateOn: ["Design claims that rely on unknown asset configuration"],
  },
  {
    code: "DEV-15", stage: "intake", doc: DEV_DOC, heading: "DEV-15 — Rank and route intake across portfolio",
    role: "Portfolio coordinator (configured authority sets priority)",
    inputs: [
      "Per case: need, baseline confidence, consequence of delay, options maturity, dependencies, decision requested",
      "Urgency class and source; verified and cited deadlines; effort/cost range and basis; capacity constraints",
    ],
    preconditions: ["DEV-03"], // evidence packet requires baseline confidence
    outputs: [
      "Disposition per case: defer, study, combine, advance, or decline, with rationale and review trigger",
      "Visible queue of unranked/incomplete cases",
      "Accepted priority and resource assumptions fed to case sponsor and dependency planner (DEV-06)",
    ],
    acceptance: [
      "Disposition, rationale, authority, next review, and acknowledged receiving sponsor recorded",
      "Portfolio rank is not approval to spend or proceed",
    ],
    recovery:
      "Conflicting criteria: refer to authority and preserve both views. No capacity: record queue position basis and revisit date. Urgency change: re-triage with timestamp and notify affected owners.",
  },
  // ----------------------------------------------------------- feasibility
  {
    code: "DEV-04", stage: "feasibility", doc: DEV_DOC, heading: "DEV-04 — Define need and appraisal frame",
    role: "Sponsor (decision authority approves appraisal frame)",
    inputs: [
      "Accepted baseline version and linked intake/incident",
      "Desired outcome and measure, horizon, scope, constraints, mandatory owner-configured requirements with source",
      "Screening criteria, method, cost units/base year/currency, risk treatment, impact categories, weights and authority",
    ],
    preconditions: ["DEV-03"], // "Validate need against baseline"
    outputs: [
      "Signed-off need statement",
      "Approved appraisal frame version (baseline/do-nothing plus credible candidate paths, criteria, weights, sources)",
    ],
    acceptance: [
      "Traceable objective; alternatives include baseline and credible candidates or document why not",
      "Criteria, units, weights, source, version and decision authority recorded",
      "Changes to objective or weights create a new appraisal version and explain ranking impact",
    ],
    recovery:
      "If emergency interim response constrains study, state scope and planned permanent reappraisal. Screen fatal constraints separately from preferences and label who confirms each.",
  },
  {
    code: "DEV-05", stage: "feasibility", doc: DEV_DOC, heading: "DEV-05 — Build, compare, and select alternatives",
    role: "Planner (decision authority selects)",
    inputs: [
      "Approved appraisal frame",
      "Option records: scope/phasing, capacity assumptions, land/control path, approvals, interfaces, cost and schedule ranges with basis, impacts, risks, data gaps",
      "Discipline and operations review inputs",
    ],
    preconditions: ["DEV-04"], // "Evaluate against approved frame"
    outputs: [
      "Comparable option records with per-criterion measure, source, uncertainty, assessor",
      "Sensitivity analysis and rank reversals",
      "Decision record: selected option or no-go, rationale, conditions, required studies, authority, review trigger",
      "Preserved candidate and rejected versions",
    ],
    acceptance: [
      "M1 package has approved need/frame, baseline link, comparable options, source-linked appraisal, sensitivity, material risks/gaps, authorized decision",
      "Provisional selection exposes conditions",
    ],
    recovery:
      "No viable option: document constraints and next action, do not force a choice. Incomplete data: label provisional decision with guardrails and study owner. Route/site unavailable: reopen affected options. Demand shift: new baseline/appraisal version. Emergency interim option: separate duration, owner, exit criteria and permanent decision gate.",
    blocksGateOn: ["Downstream commitments that depend on unresolved provisional-selection conditions, unless authority explicitly releases them"],
  },
  {
    code: "DEV-06", stage: "feasibility", doc: DEV_DOC, heading: "DEV-06 — Maintain dependency and decision readiness",
    role: "Case manager",
    inputs: [
      "Milestone/dependency items: predecessor/successor, owner, required input/version, need-by date, lead-time basis/source, status, affected gate",
      "Accepted priority and resource assumptions from DEV-15",
    ],
    preconditions: ["DEV-15"], // DEV-15 feeds "dependency planner (DEV-06)"; DEV-06 states no other trigger
    outputs: [
      "Milestone/dependency register distinguishing hard prerequisites from coordination preferences",
      "Weekly/configured review of critical path, overdue gaps, expiring evidence, unresolved authority, decisions due",
      "Escalations reporting impact and decision needed; reforecasts retaining prior forecast",
    ],
    acceptance: [
      "No gate displays 'ready' while an unaccepted prerequisite is hidden",
      "Authorized conditional release lists scope limits, owner, due date and stop condition",
    ],
    recovery:
      "Escalation reports impact and decision needed, not only lateness; reforecast retains prior forecast, reason, source, approver and affected downstream milestones.",
    blocksGateOn: ["Any unaccepted prerequisite (gate may not display 'ready')"],
  },
  {
    code: "DEV-16", stage: "feasibility", doc: DEV_DOC, heading: "DEV-16 — Commission independent assurance and challenge",
    role: "Sponsor appoints independent reviewer; assurance lead agrees scope",
    inputs: [
      "Decision/gate under review, purpose and scope, criteria/source versions",
      "Controlled evidence versions and source access",
      "Independence/conflict declaration and reviewer competence",
    ],
    preconditions: ["DEV-01", "trigger.assurance_configured"], // case exists + owner-configured trigger
    outputs: [
      "Assurance plan",
      "Findings log (ID, severity, reference, evidence, required response, owner, due date) and author dispositions",
      "Assurance report kept separate from project self-assessment; authority decision on residual findings",
    ],
    acceptance: [
      "Scope, independence check, findings, dispositions, residual actions, authority decision and evidence version archived with gate packet",
    ],
    recovery:
      "Late/unavailable reviewer: escalate schedule/capacity decision, never silently waive. Reviewer conflict: replace or document mitigation. Insufficient evidence: bounded finding and task. Disagreement: preserve both positions, refer to delegated authority.",
    blocksGateOn: ["Residual assurance findings not accepted by decision authority (per local policy)"],
  },
  // ---------------------------------------------------------- site_control
  {
    code: "DEV-07", stage: "site_control", doc: DEV_DOC, heading: "DEV-07 — Screen site, parcel, and route",
    role: "Land lead (sponsor defines footprint)",
    inputs: [
      "Functional footprint and alternatives (option ID)",
      "Geometry with coordinate reference, source/date/accuracy; parcel IDs and boundary source",
      "Recorded owner and verification status; existing easements/rights; constraints and sensitivities",
    ],
    preconditions: ["DEV-04"], // "Define functional footprint and alternatives before parcel-level engagement"
    outputs: [
      "Site register per candidate site/route",
      "Survey/title/utility/environmental diligence plan",
      "Constraint log; route-change impact review when triggered",
    ],
    acceptance: [
      "Each candidate has mapped geometry/provenance, affected parcel list or explicit unknown, ownership verification status, access/diligence plan, constraint log, named decision owner",
      "Map display is not proof of title, boundary, right, or permission",
    ],
    recovery:
      "Route change triggers impact review of affected parcels, consultation, diligence, design interfaces and approvals. Record mapping uncertainty and order diligence as needed; restrict sensitive terms and locations by role.",
  },
  {
    code: "DEV-08", stage: "site_control", doc: DEV_DOC, heading: "DEV-08 — Engage landholders and negotiate control path",
    role: "Land lead (counsel reviews; only authorized signatory executes)",
    inputs: [
      "Site register parcels",
      "Approved first-contact brief",
      "Verified party/role and contact authority",
    ],
    preconditions: ["DEV-07"], // engagement per parcel/site from the site register
    outputs: [
      "Engagement log (separate from community outreach)",
      "Access permission records (scope, dates, conditions, revocation)",
      "Negotiation/status record per parcel with instrument type and status",
      "Executed instrument evidence or documented lack of control",
    ],
    acceptance: [
      "Each parcel has verified/unknown party status, interaction history, access status, proposed instrument path, unresolved terms, accountable owner, next date, and proceed/alternate/hold decision",
      "Site-control gate separately requires executed/verified owner-configured evidence or documented authorized waiver/at-risk decision",
    ],
    recovery:
      "Multiple interests: map each, counsel identifies parties. Unknown owner: record search, restrict assumptions. Refusal/no response: log attempts, assess alternative site/route. Confidential terms: restrict and redact. Changed footprint: invalidate affected review. Dispute: preserve claims, escalate, do not mark secured. Inaccessible land: alternative evidence method.",
    blocksGateOn: ["Site-control gate without executed/verified evidence or authorized waiver/at-risk decision"],
  },
  {
    code: "DEV-09", stage: "site_control", doc: DEV_DOC, heading: "DEV-09 — Community consultation and commitment tracking",
    role: "Community liaison with service owner",
    inputs: [
      "Affected groups and access/language needs with source",
      "Option, impact and uncertainty descriptions for materials",
      "Owner-configured notice obligations",
    ],
    preconditions: ["DEV-04"], // materials describe options identified in the appraisal frame
    outputs: [
      "Consultation plan",
      "Response log with assigned responder and design/option change link or reason no change",
      "Approved response summary",
      "Commitments with owner, due date, evidence, carried into delivery registers",
    ],
    acceptance: [
      "Planned audiences/channels and configured notice obligations evidenced",
      "Submissions dispositioned or tracked with owner/date; response summary approved; commitments carried into delivery registers",
    ],
    recovery:
      "Low response is not consent: document effort and decision risk. Misinformation gets a fact-check task, not deletion. Safety/privacy concerns route to designated reviewer. Language/access barrier triggers alternative channel/support.",
  },
  {
    code: "DEV-17", stage: "site_control", doc: DEV_DOC, heading: "DEV-17 — Coordinate utility conflicts and relocation interfaces",
    role: "Project utility coordinator",
    inputs: [
      "Proposed work geometry and current design revision",
      "Operator records and responses; survey method/date and confidence",
      "Operator requirements for ownership, access, protection/relocation, service window, cost responsibility",
    ],
    preconditions: ["DEV-07", "DEV-10"], // work geometry (DEV-07) compared against current design revision (DEV-10)
    outputs: [
      "Conflict register with disposition and design reference per conflict",
      "Alternatives (avoid, protect, relocate, sequence)",
      "Hold-point release records; as-found/as-built evidence and operator acceptance",
    ],
    acceptance: [
      "Each conflict avoided, resolved, protected, or explicitly risk-accepted by authority, with evidence and downstream owner acknowledgement",
    ],
    recovery:
      "Unknown owner: records search, do not infer from markings. Inaccurate records: stop affected design/work, log verified location. Operator nonresponse: escalate via interface channel, show schedule exposure. Multiple operators: one coordination log. Changed alignment: rerun conflict query, notify reviewers.",
    blocksGateOn: ["Unresolved high-consequence utility conflicts (unless authorized conditional release with limits)"],
  },
  // --------------------------------------------------------------- capital
  {
    code: "CAP-01", stage: "capital", doc: AUTH_DOC, heading: "CAP-01 — Capital plan and sources-and-uses",
    role: "Finance lead (sponsor opens plan; budget authority approves)",
    inputs: [
      "Preferred alternative or candidate with a cost/funding question",
      "Scope boundary, estimate basis/class, currency, base date, horizon, exclusions",
      "Funding source records with status and restrictions; use/cost lines",
    ],
    preconditions: ["DEV-05"], // "Start when a preferred alternative ... has a cost/funding question"
    outputs: [
      "Versioned capital plan with uses by phase/period and separate sources",
      "Source-to-cost-line allocations with restriction reference and basis",
      "Finance review and decision package; approval record (version, ceiling, conditions, delegated authority)",
      "Residual gap stated explicitly",
    ],
    acceptance: [
      "Pending application excluded from committed and available totals",
      "Approval points to an immutable model snapshot with approver, conditions and evidence",
      "Estimate-basis edits create a version and mark prior comparisons incomparable",
      "Gap equals uses less eligible confirmed sources under configured definitions, inspectable",
    ],
    recovery:
      "Currency/base-date mismatch shown as incomparable until normalized with recorded method. Delayed/conditional funding stays outside committed/available totals. Duplicate/over-allocation, incompatible period or unsupported amount raises blocking warning; authorized reviewer may resolve with rationale and evidence, no silent override.",
    blocksGateOn: ["Source allocated beyond its amount or period (unless authorized exception)", "Duplicate allocation or unsupported amount"],
  },
  {
    code: "CAP-02", stage: "capital", doc: AUTH_DOC, heading: "CAP-02 — Cost baseline, funding allocations, and affordability",
    role: "Technical/cost owners with finance",
    inputs: [
      "Phased estimate lines (quantity, basis, date, range, confidence, exclusions, dependencies)",
      "Approved cost codes and funding restrictions",
      "Prior approved baseline",
    ],
    preconditions: ["CAP-01"], // maps lines to approved cost codes/funding restrictions from the capital plan
    outputs: [
      "Per-line, per-period allocations including distinct match relationships",
      "Variance against prior approved baseline with reason code and corrective action",
      "Recalculated funding gap and affordability (labeled with assumptions and decision authority)",
      "Retained original estimate, normalization inputs, approved baseline, forecast, actuals",
    ],
    acceptance: [
      UNSPECIFIED,
    ],
    recovery:
      "Mark orphan cost lines, unassigned funding, restricted/possibly ineligible allocations and duplicate claimed costs. Reallocation requires reason and reviewer and cannot rewrite prior-period history. Route required budget amendment before commitment if owner policy requires.",
  },
  {
    code: "CAP-03", stage: "capital", doc: AUTH_DOC, heading: "CAP-03 — Multi-year appropriations and authorization",
    role: "Budget/appropriation authority (finance maps obligations; budget office confirms authority)",
    inputs: [
      "Forecast obligations and cash needs by fiscal year",
      "Controlling records of each year's authority and permitted commitment period",
      "Linked budget version and configured delegation",
    ],
    preconditions: ["CAP-01"], // authorization fields link to a budget version
    outputs: [
      "Authorization records per year/phase (amount, period, restrictions, ceiling, lapse rule, delegated signer, status)",
      "Authorized/allocated/committed/expended/remaining amounts per fiscal year",
      "Obligation-schedule match against active authority before contract/award acceptance",
    ],
    acceptance: [
      "Out-year forecast never appears as current authority",
      "Partial approval caps commitments at approved amount",
      "Expired/lapsed period cannot be newly committed",
      "Amended authority preserves prior record and recalculates balance from auditable transactions",
    ],
    recovery:
      "Block commitment routing when authority is missing or does not cover scope/period/amount; permit only a policy-authorized exception with approver, rationale and evidence. Renewal/re-appropriation is a new linked decision; do not carry balances forward automatically.",
    blocksGateOn: ["Commitment routing without authority covering scope, period and amount"],
  },
  {
    code: "CAP-04", stage: "capital", doc: AUTH_DOC, heading: "CAP-04 — Cash flow, draw, reimbursement, and reforecast",
    role: "Finance and treasury",
    inputs: [
      "Procurement, construction and grant schedules; debt/equity proceeds; match; reimbursement lag assumptions",
      "Award-specific authorization, date window, cost categories and limits",
      "Invoice/payment/receipt transaction evidence",
    ],
    preconditions: ["CAP-01"], // cash forecast built from the capital plan sources/uses
    outputs: [
      "Period cash forecast (accrual/commitment view separate from cash view)",
      "Draw/reimbursement claims with line mapping, eligible-cost evidence and reconciliation status",
      "Receipt matching with short-pay/rejection/holdback variances assigned",
      "Reforecasts preserving prior forecast",
    ],
    acceptance: [
      "Submitted claim does not increase cash-on-hand; receipt requires transaction evidence",
      "Rejected/short-paid claims remain visible with assigned resolution",
      "Pre-award cost flagged at-risk until instrument-specific permission is reviewed and evidenced",
    ],
    recovery:
      "Never infer pre-award allowability; unverified costs are at-risk and excluded from grant-funded totals. Reforecast on award/appropriation delay, invoice variance, schedule shift, cost change or rejected claim; route revised approval when configured threshold is crossed.",
  },
  {
    code: "CHG-01", stage: "capital", doc: AUTH_DOC, heading: "CHG-01 — Change intake, impact screening, authorization, and record reuse",
    role: "Change owner (assigned by case manager)",
    inputs: [
      "Initiating notice, revised drawing, cost estimate, event, or request",
      "Current baseline version",
      "Domain reviewer returns: affected / not affected with rationale / unknown",
    ],
    preconditions: ["CAP-01"], // change is logged "against the current baseline"; capital plan is the baseline named first
    outputs: [
      "Single change record linked to all affected cases and records",
      "Consolidated impact set and matrix with evidence and owner per link",
      "Internal and external decision states recorded separately",
      "Published approved baseline and effective date; generated tasks after approval",
    ],
    acceptance: [
      "One change packet shows all affected records and missing reviews; unknown impact prevents closure",
      "Approval references exact baseline and change version; external consent separately evidenced",
      "Reused records show original and revalidation status; rejected/deferred changes preserve current baseline",
      "Implementation without prior gate leaves an auditable exception",
    ],
    recovery:
      "Missing source evidence: mark review blocked, name retrieval owner/date. Reviewer disagreement: keep both, escalate. Premature implementation: log as incident/exception, never backdate approval. External approval denied/delayed: retain baseline, hold action, route alternative/no-go/staged decision.",
    blocksGateOn: ["Unknown change impact (prevents closure)"],
  },
  // ---------------------------------------------------------------- grants
  {
    code: "GR-01", stage: "grants", doc: AUTH_DOC, heading: "GR-01 — Opportunity discovery, qualification, and go/no-go",
    role: "Grants lead (delegated applicant/finance authority decides)",
    inputs: [
      "Official notice, amendments and source snapshot",
      "CAP records for match/cost-share and cash-flow mapping",
      "Technical/partner scope validation; counsel/compliance review of unresolved interpretation",
    ],
    preconditions: ["DEV-05", "CAP-01"], // WORKFLOWS 5A "Feasible option and funding need"; step 2 maps to CAP records
    outputs: [
      "Opportunity record with status",
      "Criterion-by-criterion qualification answers with source, evidence, owner, reviewer",
      "Cross-program conflict check and fallback plan",
      "Decision memo: go / no-go / defer / seek clarification",
    ],
    acceptance: [
      "Every criterion has answer, source, evidence or explicit uncertainty, owner and reviewer",
      "Go/no-go includes risks and fallback; deadline time zone and amendments preserved",
      "System never auto-asserts eligibility",
    ],
    recovery:
      "Until a cross-program conflict is resolved, hold only the affected allocation/application claim and do not mark either program a valid fallback. Unresolved legal/eligibility interpretation goes to counsel/compliance with program source or written sponsor clarification.",
  },
  {
    code: "GR-02", stage: "grants", doc: AUTH_DOC, heading: "GR-02 — Application readiness, assembly, review, and submission",
    role: "Grants lead (authorized applicant/signatory approves and submits)",
    inputs: [
      "Go decision and opportunity/version",
      "Registration/profile status and signatory authority evidence",
      "Narrative, budget, work plan, match commitments, partner letters, certifications",
      "CAP allocations for reconciliation",
    ],
    preconditions: ["GR-01", "CAP-02"], // go decision; readiness gate 3 reconciles against CAP allocation
    outputs: [
      "Requirement matrix with per-item state",
      "Independent completeness review with field-level deficiencies",
      "Immutable authorized final package and versioned export manifest",
      "Submission record: version, timestamp/time zone, submitter, receipt/tracking ID",
    ],
    acceptance: [
      "Readiness gates 1-6 passed: intake, requirement matrix, budget reconciled, partner/certification ready, independent completeness review, submission approval",
      "Receipt recorded or status stays 'submission pending confirmation'; no fabricated receipt",
      "Edit after authorization invalidates approval and requires re-review",
    ],
    recovery:
      "Disputed costs stay excluded or at-risk pending authorized resolution. Waived/late exceptions only with configured authorized approver and rationale. Returned deficiencies loop 'correction requested' <-> 'internal review'. Notification failures and late deadlines are explicit.",
  },
  {
    code: "GR-03", stage: "grants", doc: AUTH_DOC, heading: "GR-03 — Award acceptance, conditions, and cost control",
    role: "Grants lead (authorized official accepts within delegation)",
    inputs: [
      "Official award and terms (not the notice of selection)",
      "Submitted request and CAP plan for comparison",
    ],
    preconditions: ["GR-02"], // "Upon selection" of a submitted application
    outputs: [
      "Award record",
      "Obligation item per term/condition with source section, owner, due/trigger, evidence, status",
      "Pre-award spending determination recorded only from award-specific sources",
      "Updated CAP source lines and allocations; fallback activation if declined/reduced",
    ],
    acceptance: [
      "Signed/current terms linked; every condition has owner and due trigger",
      "Each grant-funded cost line maps to applicable term and period",
      "No spending-ready state without configured acceptance/authority checks",
    ],
    recovery:
      "Reduced award, changed scope, match gap or timing change: route revised project plan and allocations. Declined/reduced: activate documented fallback; do not silently substitute another award where terms conflict.",
  },
  {
    code: "GR-04", stage: "grants", doc: AUTH_DOC, heading: "GR-04 — Monitoring, amendments, disputes, and closeout",
    role: "Grants lead (authorized certifier approves reports)",
    inputs: [
      "Executed award terms and reporting calendar",
      "Technical output certifications; finance ledger, match, claims and receipts reconciliation",
    ],
    preconditions: ["GR-03"], // "Create a schedule from executed award terms"
    outputs: [
      "Monitoring schedule and submitted reports with receipts; sponsor acceptance tracked separately",
      "Amendment requests and written sponsor decisions",
      "Dispute/finding records with responses",
      "Closeout checklist and archive manifest",
    ],
    acceptance: [
      "Missed due date escalates with source-defined consequence visible",
      "Report submission is not report acceptance; amendment cannot replace executed terms before approval",
      "Closeout cannot complete with unresolved balance, finding, or condition absent authorized disposition",
      "Archived package shows superseded and current versions",
    ],
    recovery:
      "Late/returned/unsupported/questioned items create exception with risk, owner, escalation, corrective action, review date. Pending amendment: retain current terms. Appeal does not suspend deadlines; owner verifies process from controlling source. Keep award open while sponsor acceptance or disposition is outstanding.",
    blocksGateOn: ["Closeout with unresolved balance, finding, or condition absent documented authorized disposition"],
  },
  {
    code: "CHG-02", stage: "grants", doc: AUTH_DOC, heading: "CHG-02 — Award/subrecipient recovery, permit transfer/surrender, agreement release",
    role: "Single coordinator (each domain retains its own decision authority)",
    inputs: [
      "Trigger: change, withdrawal, loss of funding, partner failure, ownership transfer, or project stop",
      "Frozen award-term version, current instruments and amendments, executed agreement versions",
      "Transaction-level reconciliation of obligated/actual/claimed/received amounts",
    ],
    preconditions: ["CHG-01"], // "handles downstream obligations after a change"
    outputs: [
      "Grant recovery: subrecipient records, formal notices, sponsor decisions, ledger adjustments, revised CAP sources/uses",
      "Permit/license: authority-specific transfer/amendment/surrender package, receipt/docket ID, verified external disposition",
      "Agreement: clause-linked obligations calendar, amendment/release/termination record, handback reconciliation, post-term custodian",
    ],
    acceptance: [
      "Each recovery/transfer/release record identifies controlling source and version, authority, owner, formal notice evidence, effective date or unresolved status, financial reconciliation, surviving obligations and custodian",
      "No award, instrument, subrecipient, or agreement disappears from active reporting because scope changed or funding stopped",
    ],
    recovery:
      "Unclear route: request written authority determination, keep non-determination status and block closure. Until external disposition is verified, retain current holder/status and keep conditions scheduled. Disputes/default: preserve notices and cure periods, continue non-suspended obligations. Escalate overdue sponsor response per owner policy.",
    blocksGateOn: ["Closure while transfer/surrender/recovery route is in non-determination"],
  },
  // --------------------------------------------------------------- permits
  {
    code: "PER-01", stage: "permits", doc: AUTH_DOC, heading: "PER-01 — Authority and instrument identification",
    role: "Permitting coordinator (counsel/compliance accepts determination basis)",
    inputs: [
      "Candidate site/route and concept",
      "Discipline facts by activity/phase/jurisdiction",
      "Authority sources with version and retrieval date",
    ],
    preconditions: ["DEV-07"], // "Start at candidate site/route and concept"
    outputs: [
      "Requirement candidates with applicability, external lifecycle and verification states kept distinct",
      "Authority map with unresolved coverage",
      "Non-determination records (exact unknown, candidate authorities, consultation, owner, due date)",
    ],
    acceptance: [
      "No-issue disposition only with rationale, reviewer and evidence",
      "Internal assessment distinguished from external confirmation; source freshness and reviewer exposed",
      "No hard-coded permit catalog claims completeness",
    ],
    recovery:
      "Unestablished jurisdiction/authority stays open as 'non-determination—authority/source unclear', escalated to counsel/compliance and permitting lead; never auto-close as not applicable. Scoped risk-based exception needs authorized decision-maker, rationale, limits, revisit date. Repeat when scope, activity, phase, jurisdiction, ownership or design changes.",
    blocksGateOn: ["Open non-determination on a gate that requires resolution"],
  },
  {
    code: "PER-02", stage: "permits", doc: AUTH_DOC, heading: "PER-02 — Applicability and verification by activity, phase, jurisdiction",
    role: "Permitting coordinator with discipline leads and reviewer",
    inputs: [
      "Requirement candidates and candidate authorities",
      "Factual scope: location/ownership, activity/methods, timing, equipment, disturbance/emission/connection facts, phase",
    ],
    preconditions: ["PER-01"], // assesses requirement candidates per combination
    outputs: [
      "Per activity x phase x jurisdiction x instrument disposition with source section, facts compared, result, reviewer",
      "Verification records separate from applicability assessments",
      "Impact reviews marking prior assessments 'superseded by change'",
    ],
    acceptance: [
      "Every identified combination has disposition, owner, reviewer and cited basis",
      "'Not applicable' requires explicit rationale and review; unknown geography prevents closed disposition",
      "Activity/phase change surfaces impacted records and prevents silent carry-forward",
    ],
    recovery:
      "Source conflict or authority ambiguity: use non-determination and request clarification. Site/design/activity revision: impact review, mark superseded, re-open work, record whether prior instrument remains valid, needs amendment, or needs fresh confirmation.",
  },
  {
    code: "PER-03", stage: "permits", doc: AUTH_DOC, heading: "PER-03 — Dossier preparation, submission, review, issuance",
    role: "Permitting coordinator (authorized applicant signs; authorized reviewer records verified issuance)",
    inputs: [
      "Applicability disposition, authority, applicant, prerequisites, current submission instructions",
      "Discipline data with source, methods, limits and approved design baseline",
    ],
    preconditions: ["PER-02", "DEV-10"], // confirms applicability disposition; data tied to approved design baseline
    outputs: [
      "Dossier index and frozen package snapshot",
      "Submission record (channel, version, sender, time zone, docket ID, acknowledgement)",
      "Authority request/comment log and response versions",
      "Verified issuance or denial record",
    ],
    acceptance: [
      "Dossier completeness based on configured required items, each inspectable",
      "Submission receipt and instrument are separate evidence types",
      "Issued status requires instrument verification by authorized role",
    ],
    recovery:
      "Unresolved prerequisites: record blocker and seek determination. Changed design/facts during review: impact review, never overwrite submitted package. Denial: decision/appeal workflow, revised design or no-go; cannot be marked issued by internal approval.",
  },
  {
    code: "PER-04", stage: "permits", doc: AUTH_DOC, heading: "PER-04 — Conditions, renewals, changes, disputes, closeout",
    role: "Permitting coordinator / condition owners",
    inputs: [
      "Issued instrument conditions and commitments",
      "Expiry/renewal window as stated by instrument",
      "Site/design/ownership/operator change triggers",
    ],
    preconditions: ["PER-03"], // converts issued instrument conditions
    outputs: [
      "Linked obligation record per condition, as gate dependencies",
      "Renewal planner entries (new linked workflow per renewal)",
      "Change impact assessments with per-item disposition",
      "Dispute/appeal records; final archive manifest on closure",
    ],
    acceptance: [
      "Expired instrument generates visible alert and blocks configured gate",
      "Condition remains open until evidence accepted; renewal cannot silently extend validity",
      "Appeal deadline uses cited source and time zone",
      "Closed record with unresolved obligation rejected unless authorized disposition attached",
    ],
    recovery:
      "Uncertain renewal timing: show 'date to verify' and block calendar confidence. Do not infer transferability. Keep ordinary condition tasks active during disputes unless suspension is documented by authorized source/reviewer.",
    blocksGateOn: ["Expired instrument", "Open instrument conditions before the configured activity"],
  },
  {
    code: "AGR-01", stage: "permits", doc: AUTH_DOC, heading: "AGR-01 — Agreements and commitments",
    role: "Business owner / negotiation lead (authorized signatory executes)",
    inputs: [
      "Agreement type, parties and verified representative authority",
      "Scope, dependencies, template/source, required approvals, target date, risks",
      "Linked permits, funding and cost lines",
    ],
    preconditions: ["DEV-07"], // WORKFLOWS 5B trigger "Candidate site/route and concept exist"
    outputs: [
      "Agreement record and clause/topic issue log with immutable drafts",
      "Internal approval tied to exact final version; signature routing",
      "Executed/effective agreement evidence",
      "Clause-linked obligation, payment, notice and renewal tasks",
    ],
    acceptance: [
      "Executed state requires complete signature evidence and effective-date check",
      "Approved-to-execute references exact approved text hash/version",
      "Amendments preserve old and new text and effective date",
      "Open obligation prevents closeout absent documented disposition",
    ],
    recovery:
      "Unsigned, partially signed, conditional, disputed or expired agreements stay distinct. Missing signatory authority blocks execution routing. Amendment repeats review/approval/execution; prior terms remain until change verified. At expiry/termination verify surviving obligations; do not close solely because term ended.",
    blocksGateOn: ["Missing signatory authority (blocks execution routing)", "Open obligation (blocks closeout)"],
  },
  // ----------------------------------------------------------- engineering
  {
    code: "DEV-10", stage: "engineering", doc: DEV_DOC, heading: "DEV-10 — Establish design basis and requirements baseline",
    role: "Design authority",
    inputs: [
      "Selected option and current requirements",
      "Site/survey inputs, interfaces, existing asset condition",
      "Owner-selected standards with source and edition; permit/contract commitments",
      "Operator/maintainer operability review",
    ],
    preconditions: ["DEV-05"], // "Confirm selected option and current requirements before concept design"
    outputs: [
      "Approved design basis",
      "Requirements register, interface register, assumption/data-gap log",
      "Review plan and traceability matrix",
    ],
    acceptance: [
      "Approved design basis, requirements register, interface register, assumption/data-gap log, review plan, named design authority and traceability matrix exist",
      "Unverified requirements have owner and planned verification point; conflicts escalated, not silently resolved by designer",
    ],
    recovery:
      "Discipline leads identify missing surveys and validate input fitness; conflicts are escalated rather than resolved by the designer. Stage labels alone do not establish completeness.",
  },
  {
    code: "DEV-11", stage: "engineering", doc: DEV_DOC, heading: "DEV-11 — Progress design reviews and control revisions",
    role: "Design authority (originator, reviewers, document controller)",
    inputs: [
      "Approved design basis and review plan",
      "Controlled package versions (drawings, calculations, specifications)",
      "Change requests with impact assessment",
    ],
    preconditions: ["DEV-10"], // reviews follow the approved baseline and review plan
    outputs: [
      "Review comment log with dispositions",
      "Released revisions with transmittal identifying exact revisions and permitted use",
      "Change request decisions and updated drawings/work packages/tests/asset records",
    ],
    acceptance: [
      "Release identifies complete review set, closed/dispositioned comments, approved revision, outstanding deviations/risks with owners, authorized release",
      "Unapproved documents cannot appear as current-for-work",
      "Change closes only when implementation and verification evidence link to new baseline; superseded version stays available",
    ],
    recovery:
      "Freeze baseline reference before change. Emergency field condition uses owner-defined controlled path with retrospective review. Changed interface notifies downstream owners. Field redlines remain provisional until checked, approved and incorporated into as-built set.",
  },
  {
    code: "DEV-12", stage: "engineering", doc: DEV_DOC, heading: "DEV-12 — Long-lead early-release gate",
    role: "Asset owner / design authority approve; engineering, operations, procurement, counsel, finance, project controls check",
    inputs: [
      "Candidate record: lead-time source, required-on-site date, design maturity, specification revision, open assumptions",
      "Cost range, escalation/cancellation exposure and funding authority",
      "Procurement route and contract review",
    ],
    preconditions: ["DEV-11"], // candidate record cites design maturity and specification revision
    outputs: [
      "Release/hold decision record with limited scope, exclusions, exposure ceiling, stop conditions, interface freeze date",
      "Release packet with traceable vendor acknowledgement",
    ],
    acceptance: [
      "Release packet has approved scope/revision, stable envelope, interface owners/dates, exposure, funding/authority evidence, reviewed contract path, risks, stop conditions, vendor acknowledgement",
      "Early release does not authorize construction, installation, energization, or use",
    ],
    recovery:
      "Any changed envelope returns for impact review; unauthorized commitment remains an exception until dispositioned by authority.",
    blocksGateOn: ["Pending funding", "Unapproved commitment authority"],
  },
  {
    code: "DEV-13", stage: "engineering", doc: DEV_DOC, heading: "DEV-13 — Plan service continuity, cutover, and return to service",
    role: "Operations authority (controls service transitions)",
    inputs: [
      "Service/asset boundary, baseline and critical dependencies",
      "Proposed outage/transfer windows, temporary arrangements, contingency",
      "Operator, maintainer, safety and external operator review",
    ],
    preconditions: ["DEV-10"], // "At concept, identify outages" — concept follows design basis
    outputs: [
      "Continuity plan",
      "Cutover work package with hold points, abort/rollback conditions",
      "Readiness review and go/no-go decision log; actual-step records",
      "Restoration verification and operator acceptance",
    ],
    acceptance: [
      "Actual work evidence, deviations dispositioned, service state confirmed by operations",
      "Temporary arrangements removed or assigned with expiry/review; defects and monitoring owned",
      "Asset/configuration records updated; stakeholders notified",
      "Commissioning or physical completion alone is not service acceptance",
    ],
    recovery:
      "Unplanned outage: invoke owner incident process and link case. External operator unavailable: block step or use approved contingency. Temporary system fails: stop/rollback under authorized plan. Changed sequence: re-review hazards, dependencies, notices, approvals. Partial return: record scope, limits, monitoring owner, next update.",
  },
  {
    code: "DEV-18", stage: "engineering", doc: DEV_DOC, heading: "DEV-18 — Seasonal, staged, and fallback delivery planning",
    role: "Sponsor and planner (operations validates service effects)",
    inputs: [
      "Seasonal loads, environmental/access windows, service peaks, supply uncertainty",
      "Technical interfaces from engineering; access/commitment effects from land/community leads",
    ],
    preconditions: ["DEV-10"], // engineering confirms technical interfaces for phases
    outputs: [
      "Scenario register (baseline and adverse) with activation/exit criteria",
      "Phase boundaries, last responsible decision dates, minimum viable service per phase",
      "Fallback verification and temporary-works removal/restoration tasks",
    ],
    acceptance: [
      "Operations accepts interim service limitations and monitoring before phase start",
      "Each phase has authorized start/stop criteria, owner, dependencies and evidence plus documented path to final integrated acceptance",
    ],
    recovery:
      "Unverified fallback is labeled contingency concept and gate stays at risk. Missed seasonal window: reforecast and obtain decision on defer, resequence or revised method; do not compress review steps by schedule assertion.",
    blocksGateOn: ["Unverified fallback (gate kept at risk)"],
  },
  {
    code: "DEV-19", stage: "engineering", doc: DEV_DOC, heading: "DEV-19 — Release construction work package from design baseline",
    role: "Project authority with cross-functional release review",
    inputs: [
      "Exact released drawing/spec revisions",
      "Utility conflict dispositions; land/access and permit conditions",
      "Vendor submittal status; service/outage/cutover links",
      "Funding, contract and release delegation",
    ],
    // Readiness review confirms: released design (DEV-11), outage/cutover (DEV-13),
    // utility conflicts (DEV-17), land access (DEV-08), permit conditions (PER-04),
    // vendor data (PROC-05 submittal register), funding/authority (CAP-03).
    preconditions: ["DEV-11", "DEV-13", "DEV-17", "DEV-08", "PER-04", "PROC-05", "CAP-03"],
    outputs: [
      "Release packet per bounded area/package",
      "Blocker list with owner, due date, affected area, resolution evidence",
      "Release decision with exact revision, scope, conditions, stop-work triggers, recipient acknowledgement",
    ],
    acceptance: [
      "Every required role signs or has documented disposition",
      "Current controlled set transmitted and receiver acknowledges version",
      "Open items have bounded scope/owners; authorization evidence stored",
      "Does not replace notice to proceed, safety permit, statutory approval or contractor method review",
    ],
    recovery:
      "Blocked scope cannot proceed; unaffected packages proceed only with documented interfaces and separation. Field RFI/changed condition routes to DEV-11. Emergency work follows separate authorized path and is retrospectively linked. Superseded package is withdrawn from active use.",
    blocksGateOn: ["Missing access", "Unresolved utility conflict", "Stale survey", "Pending condition", "Unapproved substitution", "Unaccepted outage plan"],
  },
  // ----------------------------------------------------------- procurement
  {
    code: "PROC-01", stage: "procurement", doc: DEL_DOC, heading: "PROC-01 — Strategy, package, readiness",
    role: "Procurement lead (configured authority approves issue)",
    inputs: [
      "Defined package boundaries: scope/exclusions, deliverables/interfaces, design maturity",
      "Estimate with currency/base date and funding status",
      "Evaluation method/criteria, contract form source, issue route",
    ],
    preconditions: ["DEV-10", "CAP-01"], // "defined package boundaries and funding/authorization path"
    outputs: [
      "Approved procurement plan and package baseline",
      "Readiness checklist (criteria frozen before issue, roles, deadline/time zone, Q&A route, access controls)",
      "Issue approval and issue timestamp/channel/recipients",
    ],
    acceptance: ["All required fields and issue authority recorded"],
    recovery:
      "Block issue on configured missing prerequisites unless authorized exception records rationale, risk, approver, scope and review date. Changes after issue require controlled addendum or cancellation/reissue.",
    blocksGateOn: ["Configured missing procurement prerequisites (unless authorized exception)"],
  },
  {
    code: "PROC-02", stage: "procurement", doc: DEL_DOC, heading: "PROC-02 — Solicitation and bid receipt",
    role: "Procurement custodian",
    inputs: ["Issued package and addenda", "Bidder submissions"],
    preconditions: ["PROC-01"], // solicitation follows approved issue
    outputs: [
      "Issue/addendum versions, distribution, acknowledgements, Q&A",
      "Submission receipts with manifest and integrity check, sealed until configured release",
      "Opening event log; exception records for late/corrupt/duplicate/withdrawn/misdirected bids",
    ],
    acceptance: ["Each bid dispositioned", "Authorized evaluators see correct version only"],
    recovery:
      "Never silently alter, discard or cure a bid. Late, corrupted, duplicate, withdrawn or misdirected bid goes to authority with governing source and decision.",
  },
  {
    code: "PROC-03", stage: "procurement", doc: DEL_DOC, heading: "PROC-03 — Evaluation and recommendation",
    role: "Evaluators recommend; procurement review validates; authorized body decides",
    inputs: ["Frozen criteria/weights and solicitation version", "Released bids", "Evaluator assignments and declarations"],
    preconditions: ["PROC-02"], // evaluates received bids
    outputs: [
      "Independent per-criterion scores with rationale and evidence",
      "Moderation and any authorized normalization records",
      "Recommendation (comparative summary, price basis, risks, ranking, funding fit, dissent)",
    ],
    acceptance: ["Result reproducible from saved inputs and method"],
    recovery:
      "Conflict: access pause, recusal, reassignment. Protest/challenge: preserve record and follow owner hold path. No acceptable bid: documented reissue or approved alternative, never default award. Do not add criteria after issue.",
  },
  {
    code: "PROC-04", stage: "procurement", doc: DEL_DOC, heading: "PROC-04 — Award and contract execution",
    role: "Authorized contracting officer/body",
    inputs: ["Evaluation result and recommendation", "Funding and budget authority", "Draft contract"],
    preconditions: ["PROC-03", "CAP-03"], // award uses evaluation; CAP-03 matches obligations before contract acceptance
    outputs: [
      "Award decision record",
      "Execution record with signed version and per-term sources",
      "Obligation matrix transitioned to PROC-05",
    ],
    acceptance: ["Authorized decision, approvals, executed evidence and notice dispositions recorded"],
    recovery: "Award is not a signed contract; keep draft distinct from executed. Log notices where owner process requires.",
  },
  {
    code: "PROC-05", stage: "procurement", doc: DEL_DOC, heading: "PROC-05 — Obligations, delivery, invoice/payment",
    role: "Contract role verifies entitlement; finance authorizes payment",
    inputs: ["Executed contract obligation matrix", "Vendor submittals", "Deliveries", "Invoices"],
    preconditions: ["PROC-04"], // "Transition obligation matrix to PROC-05"
    outputs: [
      "Obligation rows and submittal register",
      "Delivery receipts with accept/partial/reject authority",
      "Invoice reviews with disputed lines segregated; payment references",
      "Issues for missing submittal, delay, vendor failure, claim, disputed invoice or budget gap",
    ],
    acceptance: [
      "Obligation status visible",
      "Invoice ties to contract plus executed changes and accepted basis, or disputed lines held separately",
    ],
    recovery:
      "Each issue records source, contract notice dates, impact, owner, response, interim control and forecast; system does not calculate legal rights. Payment is not turnover or beneficial use and does not imply defect acceptance.",
  },
  {
    code: "PROC-06", stage: "procurement", doc: DEL_DOC, heading: "PROC-06 — Change, claim and closeout",
    role: "Contract authority (finance decides final payment independently)",
    inputs: ["Executed contract and baseline", "Change requests, vendor proposals, claims notices"],
    preconditions: ["PROC-04"], // changes/claims act on an executed contract
    outputs: [
      "Change records through signed change and revised baseline",
      "Claim records separating allegation from accepted liability",
      "Closeout checklist",
    ],
    acceptance: [
      UNSPECIFIED, "Closeout checklist items reconciled and open obligations visible",
    ],
    recovery:
      "RFI, field direction, forecast or submittal does not change contract absent authorized execution. Emergency direction uses configured authority and retrospective record; no silent bypass.",
  },
  {
    code: "PROC-07", stage: "procurement", doc: DEL_DOC, heading: "PROC-07 — Vendor continuity and long-tail obligations (row 7)",
    role: "Contract manager (contract authority decides extension/replacement/termination)",
    inputs: ["Executed agreement and amendments", "Critical vendor/service list"],
    preconditions: ["PROC-04"], // reconciles against executed agreement
    outputs: [
      "Continuity record per critical vendor/service",
      "Renewal/transition decisions, recipient acknowledgements, access removal and final deliverables",
    ],
    acceptance: ["Active long-tail commitments each have source-backed terms, owner, renewal/exit date, continuity path and evidence custodian"],
    recovery:
      "Unclear rights route to counsel/procurement; do not assume service, license or data rights. On provider failure/merger/key-person loss, preserve manuals/configuration and open incidents and assess replacement lead time.",
  },
  // ---------------------------------------------------------- construction
  {
    code: "CONST-01", stage: "construction", doc: DEL_DOC, heading: "CONST-01 — Mobilization readiness",
    role: "Construction manager (owner-authorized role accepts readiness)",
    inputs: [
      "Approved drawing/spec versions, contract/changes",
      "Land/access evidence, permits/conditions, safety/environmental evidence",
      "Inspection/test plan, materials, outages, schedule, cost baseline",
    ],
    preconditions: ["PROC-04", "DEV-19", "gate.M5"], // "after authorized gate and executed package"
    outputs: ["Readiness disposition", "Baselines and named leads", "Authorizations"],
    acceptance: ["Readiness disposition, baselines, named leads and authorizations recorded"],
    recovery:
      "Missing critical access, design, interface or configured prerequisite blocks affected work unless exception specifies scope, controls, approver, owner and expiry.",
    blocksGateOn: ["Missing critical access, design, interface or configured prerequisite"],
  },
  {
    code: "CONST-02", stage: "construction", doc: DEL_DOC, heading: "CONST-02 — Daily field records and progress",
    role: "Contractor reports; owner lead verifies",
    inputs: ["Daily field data: crews, activities, quantities with basis, deliveries, weather, observations, photos", "Weekly lookahead"],
    preconditions: ["CONST-01"],
    outputs: ["Daily reports", "Weekly lookahead", "Minutes with actions", "Owner-verified quantities kept separate from contractor-reported"],
    acceptance: [
      "Percent complete cites quantity or approved weighting method",
      "No subjective percent becomes payment evidence without authorized basis",
    ],
    recovery: "Missing report is an explicit exception.",
  },
  {
    code: "CONST-03", stage: "construction", doc: DEL_DOC, heading: "CONST-03 — Inspection, test, NCR and corrective action",
    role: "Responsible inspector/tester; owner/contract authority dispositions NCR",
    inputs: ["Requirement, drawing revision and criterion source", "Measured values and raw files"],
    preconditions: ["CONST-01"], // inspection/test plan set at mobilization
    outputs: ["Inspection/test records (pass/fail/inconclusive/not performed)", "NCRs with containment, disposition, corrective action and closure evidence"],
    acceptance: [
      UNSPECIFIED, "Actual result never populated from plan",
    ],
    recovery:
      "Failed/ambiguous test, missed witness, instrument issue or systemic defect: preserve evidence, assess affected boundary, hold/release authority, repair/retest. 'Use as-is' needs explicit authority. Corrective action reopens if verification fails.",
  },
  {
    code: "CONST-04", stage: "construction", doc: DEL_DOC, heading: "CONST-04 — RFI and submittal",
    role: "Requester / response owner; submittal reviewer",
    inputs: ["RFI question with drawing/spec version", "Vendor submittals against contract obligations"],
    preconditions: ["CONST-01"],
    outputs: ["RFI responses within delegated scope (baseline impact routed to CONST-05/PROC-06)", "Submittal dispositions"],
    acceptance: [
      UNSPECIFIED, "Superseded revision never shown as current",
    ],
    recovery: "Answer clarifies only within delegated scope; baseline impact routes through CONST-05/PROC-06. Preserve every version.",
  },
  {
    code: "CONST-05", stage: "construction", doc: DEL_DOC, heading: "CONST-05 — Change, delay, outage/interface",
    role: "Authorized change and operations authorities (decide separately)",
    inputs: ["Change origin, baselines, reason, alternatives, cost/schedule impact", "Outage/interface request details"],
    preconditions: ["CONST-01"],
    outputs: ["Change decision, signed change and verification (linked to PROC-06)", "Outage/interface decision and recovery plan", "Issues for discovery, weather, access loss, incident, delay or overrun"],
    acceptance: [
      UNSPECIFIED, "Baseline updated only after authorized decision",
    ],
    recovery: "Pause only affected work when authorized; record restart conditions; forecast is not approved scope. Product does not issue operating commands.",
  },
  {
    code: "CONST-06", stage: "construction", doc: DEL_DOC, heading: "CONST-06 — Completion and punch",
    role: "Owner verifies; authorized owner records completion",
    inputs: ["Contractor submission: scope, as-builts, quality/test records, NCRs, punch, quantities, training, certifications"],
    preconditions: ["CONST-02", "CONST-03"], // completion submission includes field quantities and quality/test records
    outputs: ["Owner walkdown/verification", "Punch list with class, owner, due date, carryover authority", "Construction completion record (separate from contract completion, payment, beneficial use)"],
    acceptance: [
      "M6: configured scope installed, critical inspection/test evidence present, open items dispositioned, approved changes reflected, authorized owner records completion",
      "M6 alone does not authorize operation, payment or service start",
    ],
    recovery: null,
    blocksGateOn: ["Configured scope not installed", "Critical inspection/test evidence missing", "Open items not dispositioned", "Approved changes not reflected"],
  },
  {
    code: "CONST-07", stage: "construction", doc: DEL_DOC, heading: "CONST-07 — Long-duration work preservation and restart (row 8)",
    role: "Owner engineer with quality/safety/operations roles",
    inputs: ["Suspended boundary status, installed/incomplete work, hazards, stored materials"],
    preconditions: ["CONST-01"], // applies to work fronts after mobilization
    outputs: ["Preservation/restart record per area/system", "Restart acceptance with limits, rejected areas and remediation"],
    acceptance: ["Every suspended boundary has custodian and review trigger", "Restart decision names reviewed evidence and exceptions"],
    recovery: "Lost/expired evidence triggers inspection/requalification decision by designated authority; paused work is not presumed acceptable. Log is not formal contract notice.",
  },
  // --------------------------------------------------------- commissioning
  {
    code: "TURN-01", stage: "commissioning", doc: DEL_DOC, heading: "TURN-01 — Boundary, plan, readiness",
    role: "Commissioning authority",
    inputs: ["Asset/system boundaries and interfaces", "Tests and criteria sources", "Construction walkdown, inspection evidence, NCR/defect disposition"],
    preconditions: ["CONST-06"], // WORKFLOWS s9 trigger "Construction reaches turnover readiness"; readiness checks walkdown
    outputs: ["Commissioning plan", "Per-system readiness result (pass/conditional/fail) with scope and limits"],
    acceptance: [
      UNSPECIFIED, "Conditional gate names interim controls, owner, expiry and scope",
    ],
    recovery: null,
  },
  {
    code: "TURN-02", stage: "commissioning", doc: DEL_DOC, heading: "TURN-02 — Test execution and retest",
    role: "Test executor with witness and reviewer",
    inputs: ["Approved test scripts and criteria", "Configuration baseline", "Authorization references for switching/energization"],
    preconditions: ["TURN-01"],
    outputs: ["Test records with expected vs observed results", "Linked retest records", "Deferred-test records with owner, due date, interim control, approver"],
    acceptance: ["Failed test remains failed; retest is a new linked record", "Deferred test never displays as passed"],
    recovery: "Switching, energization and return-to-service follow owner command/authorization process; product does not issue commands.",
  },
  {
    code: "TURN-03", stage: "commissioning", doc: DEL_DOC, heading: "TURN-03 — Defect and conditional acceptance",
    role: "Authorized approver (closure authority per defect)",
    inputs: ["Defects linked to tests/location/boundary"],
    preconditions: ["TURN-02"], // defects link to test records
    outputs: ["Defect records with containment, repair, retest", "Conditional acceptance records (scope, limits, controls, custodian, expiry)"],
    acceptance: ["Unresolved defect cannot become 'pass'"],
    recovery: "If owner has no conditional pathway, gate fails. Expired condition alerts/escalates; no auto-renewal.",
    blocksGateOn: ["No owner conditional pathway for unresolved defect"],
  },
  {
    code: "TURN-04", stage: "commissioning", doc: DEL_DOC, heading: "TURN-04 — Dossier and operations capability",
    role: "Commissioning lead; receiving operations identifies gaps",
    inputs: ["Approved tests/exceptions, as-builts, equipment hierarchy, procedures, maintenance tasks, spares, manuals, training"],
    preconditions: ["TURN-02"], // dossier indexes approved tests/exceptions
    outputs: ["Dossier index with per-item status", "Training and spares records"],
    acceptance: ["Each required item accepted, missing, not applicable with rationale, pending, or exception approved", "Receipt does not prove competence or adequacy"],
    recovery: null,
  },
  {
    code: "TURN-05", stage: "commissioning", doc: DEL_DOC, heading: "TURN-05 — Separate acceptance and service entry",
    role: "Operating acceptance authority; receiving custodian acknowledges",
    inputs: ["Dossier", "Test/defect dispositions"],
    preconditions: ["TURN-03", "TURN-04"], // acceptance needs exceptions dispositioned and dossier
    outputs: [
      "Independent records: technical turnover readiness, commissioning acceptance, operations handover, beneficial use/service start",
      "Contract completion/payment milestone routed to PROC-05/06",
      "Archive manifest",
    ],
    acceptance: ["M7: owner-defined commissioning acceptance, named custodian, exceptions dispositioned", "No one form infers another status"],
    recovery: "Receiving custodian rejects missing records with owner/action. Conditional approval records limits, owner and expiry.",
    blocksGateOn: ["Commissioning acceptance missing", "No named custodian", "Exceptions not dispositioned"],
  },
  {
    code: "TURN-06", stage: "commissioning", doc: DEL_DOC, heading: "TURN-06 — Phased turnover and custody reconciliation (row 9)",
    role: "Commissioning proposes; authorized acceptance authority decides",
    inputs: ["Boundary map, components, interfaces, test/dossier status per boundary"],
    preconditions: ["TURN-01"], // phased boundaries derive from commissioning boundaries
    outputs: ["Boundary register with custodian per boundary", "Per-phase reconciliation and evidence export"],
    acceptance: ["Every component maps to accountable state/custodian or documented shared owner", "Each phase exports its own evidence and open items"],
    recovery: "Boundary change invalidates affected links and requires review. Disputed interface ownership or untestable boundary holds affected phase and assigns joint owner.",
    blocksGateOn: ["Disputed interface ownership or untestable boundary (holds affected phase)"],
  },
  // ------------------------------------------------------------ operations
  {
    code: "OPS-01", stage: "operations", doc: DEL_DOC, heading: "OPS-01 — Asset baseline and recurring plan",
    role: "Asset owner accepts identity and plan",
    inputs: ["Commissioning baseline and in-service decision basis", "Owner-set maintenance rules and sources"],
    preconditions: ["TURN-05"], // asset fields need in-service decision basis and commissioning baseline
    outputs: ["Asset records", "Recurring plan/tasks", "Work orders"],
    acceptance: [
      UNSPECIFIED, "Work order closure means evidence reviewed",
    ],
    recovery: "Reconcile duplicate or mismatched identity before linking events. System must not invent legal or engineering intervals.",
  },
  {
    code: "OPS-02", stage: "operations", doc: DEL_DOC, heading: "OPS-02 — Inspection, maintenance, event/incident",
    role: "Operational authority controls response",
    inputs: ["Plans and work orders", "Telemetry/imported data with sync metadata", "Event reports"],
    preconditions: ["OPS-01"],
    outputs: ["Execution records", "Event records linked to work orders, tests, notices and renewal cases"],
    acceptance: [
      UNSPECIFIED, "Stale/missing data explicit",
    ],
    recovery: "Never infer real-time safety/compliance from stale feed. Restrict sensitive event details.",
  },
  {
    code: "OPS-03", stage: "operations", doc: DEL_DOC, heading: "OPS-03 — Warranty, service and compliance renewals",
    role: "Contract/compliance owner",
    inputs: ["Instruments with source-documented dates", "Owner-configured lead times"],
    preconditions: ["OPS-01"],
    outputs: ["Obligation calendar", "Renewal cases with submission receipts and decisions", "Warranty claims"],
    acceptance: [
      UNSPECIFIED, "Prior version preserved as superseded",
    ],
    recovery:
      "Denied/pending/missed renewal, operator change, disputed coverage, breach, missing report or funding gap escalates to accountable owner with impact, contingency, operating restriction decision, interim control, alternate path, review date. Pending application never implies continued authorization.",
  },
  {
    code: "OPS-04", stage: "operations", doc: DEL_DOC, heading: "OPS-04 — Condition and lifecycle renewal",
    role: "Asset manager recommends; investment authority decides",
    inputs: ["Condition evidence and maintenance history", "Performance/reliability/cost trends"],
    preconditions: ["OPS-02"], // assessment uses maintenance history
    outputs: ["Condition assessment", "Business case comparing maintain/repair/refurbish/upgrade/replace/transfer/retire", "Linked lifecycle case for approved work"],
    acceptance: ["Overdue maintenance/renewal appears in owner view; event evidence links to asset; freshness visible; upgrade preserves old baseline"],
    recovery: "Deferral needs authority, risk, interim control, due/review trigger. Unvalidated score cannot trigger safety classification.",
  },
  {
    code: "OPS-05", stage: "operations", doc: DEL_DOC, heading: "OPS-05 — Multi-year stewardship review (row 10)",
    role: "Asset manager convenes reviewers",
    inputs: ["Maintenance, inspection and incident history", "Trends, obligations, data freshness, prior decisions"],
    preconditions: ["OPS-02"], // reviews completed/deferred maintenance and incident history
    outputs: ["Reproducible snapshot", "Assessed condition/risk and ranked actions", "Recommendations and next review trigger"],
    acceptance: ["Snapshot reproducible; stale/missing data visible", "Actions owned/due; changed assumptions link prior decision"],
    recovery: "Assign data-quality work rather than fill gaps. Material risk change routes to human authority. Conflicting sources remain visible with resolution owner.",
  },
  {
    code: "OPS-06", stage: "operations", doc: DEL_DOC, heading: "OPS-06 — Risk-ranked maintenance backlog and deferral (row 10)",
    role: "Planner sequences; operational/engineering/safety authority accepts risk; finance funds",
    inputs: ["Defects with source and discovery date", "Owner-defined risk method"],
    preconditions: ["OPS-02"], // backlog items come from defects found in execution
    outputs: ["Backlog with original due dates and revisions", "Deferral decisions"],
    acceptance: ["No deferral loses history, control, owner, approver or next review", "Ranking and overrides reproducible"],
    recovery: "Reassess deferral when control fails, condition changes, incident occurs, parts arrive or review date passes. Escalate unowned/expired priority items.",
  },
  {
    code: "OPS-07", stage: "operations", doc: DEL_DOC, heading: "OPS-07 — Owner, operator or service-provider change (row 10)",
    role: "Outgoing and incoming custodians; authorized roles decide effective date",
    inputs: ["Inventory of affected assets, contracts, permits, land rights, grant conditions, access, procedures"],
    preconditions: ["OPS-01"], // inventories asset records
    outputs: ["Transition case", "Versioned handover pack and outstanding-risk schedule", "Incoming acceptance/rejection with limits"],
    acceptance: ["Both sides acknowledge inventory/exceptions", "Each obligation has owner and effective date; access dispositioned; rejected items have resolution owner"],
    recovery: "If right or permit continuity is uncertain, retain current accountable owner pending source-based determination. Restricted records do not copy by default.",
  },
  {
    code: "OPS-08", stage: "operations", doc: DEL_DOC, heading: "OPS-08 — Incident recovery and return to routine (row 10)",
    role: "Incident lead; investigation lead",
    inputs: ["Event record and sourced timeline", "Restoration evidence"],
    preconditions: ["OPS-02"], // builds on the event record
    outputs: ["Decision log and investigation findings", "Return-to-routine decision with scope and limits", "Corrective actions linked to OPS-06"],
    acceptance: ["Event facts, response decisions, findings and corrective closure distinct", "Unresolved action owned with review trigger"],
    recovery: "Incident closure may leave corrective work open; do not clear backlog on event closure. Uncertain cause retains monitoring and review date.",
  },
  {
    code: "OPS-09", stage: "operations", doc: DEL_DOC, heading: "OPS-09 — Obligation applicability and permit/license transfer (row 10)",
    role: "Reviewer/owner per instrument",
    inputs: ["Obligation register", "Current authoritative instrument/issuer record"],
    preconditions: ["OPS-03"], // reconciles the obligation register
    outputs: ["Applicability rows", "Amendment/assignment/surrender filings with receipts and effective instruments"],
    acceptance: ["Each affected instrument has verified status/source, accountable party, effective-date evidence or open exception, next action"],
    recovery: "Current holder remains accountable until effective transfer is recorded. Denial, delay, scope dispute or missed date escalates; pending request is not approval. System never decides applicability.",
  },
  // ------------------------------------------------------- decommissioning
  {
    code: "RET-01", stage: "decommissioning", doc: DEL_DOC, heading: "RET-01 — Assessment and approval",
    role: "Asset owner leads; asset/investment authority approves",
    inputs: ["Asset status and retirement reason/source", "Alternatives, affected services, obligations, restoration, cost/funding"],
    preconditions: ["OPS-01"], // assessment of an in-service asset record
    outputs: ["Retirement assessment", "Approve/reject/defer/condition decision", "Linked successor case"],
    acceptance: [
      UNSPECIFIED, "No shutdown from draft or forecast",
    ],
    recovery: null,
  },
  {
    code: "RET-02", stage: "decommissioning", doc: DEL_DOC, heading: "RET-02 — Transition and shutdown/transfer",
    role: "Designated operations authority executes",
    inputs: ["Approved retirement decision", "Shutdown/transfer plan"],
    preconditions: ["RET-01"], // "No shutdown from draft or forecast"
    outputs: ["Transition plan", "Execution records"],
    acceptance: [
      UNSPECIFIED, "Physical shutdown is not closure",
    ],
    recovery: "Replacement delay, service need, unsafe condition, ownership dispute or residual duty holds affected action and assigns owner/review date.",
  },
  {
    code: "RET-03", stage: "decommissioning", doc: DEL_DOC, heading: "RET-03 — Disposition, restoration, obligations and finance",
    role: "Owners accept evidence; finance/contract approver closes",
    inputs: ["Items and materials from shutdown", "Contracts, grants, permits, land, service obligations"],
    preconditions: ["RET-02"], // dispositions items released by shutdown/transfer
    outputs: ["Disposition records with chain of custody", "Obligation matrix", "Financial/contract closeout"],
    acceptance: [
      UNSPECIFIED, "Blank is never closed",
    ],
    recovery: "Do not infer compliant handling without reviewer/evidence. Accounting/tax disposition is owner-reviewed.",
  },
  {
    code: "RET-04", stage: "decommissioning", doc: DEL_DOC, heading: "RET-04 — Archive and final status",
    role: "Records custodian accepts; authorized owner approves",
    inputs: ["Obligation dispositions", "Archive manifest"],
    preconditions: ["RET-03"],
    outputs: ["Final status certificate", "Custodian-checked archive", "Lessons learned"],
    acceptance: ["M9: asset status, service transition, obligations, contracts, records, residual risks and archive have accepted dispositions", "Archived evidence searchable under configured access/retention"],
    recovery: "Never delete records to close. Open hold/obligation keeps case open unless authorized exception names rationale, custodian, risk/control and review date.",
    blocksGateOn: ["Open obligation (unless authorized waiver)", "Open records hold"],
  },
  {
    code: "RET-05", stage: "decommissioning", doc: DEL_DOC, heading: "RET-05 — Post-closure aftercare and monitoring (row 11)",
    role: "Risk owner; reviewer closes items",
    inputs: ["Restoration, monitoring, warranty tail, unresolved claim, land duty or accepted residual"],
    preconditions: ["RET-03"], // obligation matrix includes restoration/monitoring
    outputs: ["Aftercare register visible after physical closure", "Review records"],
    acceptance: ["Aftercare visible after physical closure", "Overdue work escalates", "Each item has custodian/funding or explicit exception"],
    recovery: "Trigger or adverse trend opens linked case and reopens retirement decision. Lapsed monitoring or lost owner/funding escalates; obligation stays open.",
  },
];

/** Every procedure in the manuals, in stage order then manual order. */
export const PROCEDURES: readonly ProcedureStep[] = Object.freeze(
  DEFS.map(build)
    .map((step, index) => ({ step, index }))
    .sort((a, b) => STAGE_ORDER.indexOf(a.step.stage) - STAGE_ORDER.indexOf(b.step.stage) || a.index - b.index)
    .map(({ step }) => Object.freeze(step) as ProcedureStep),
);

const BY_CODE: ReadonlyMap<string, ProcedureStep> = new Map(PROCEDURES.map((s) => [s.code, s]));
const INDEX: ReadonlyMap<string, number> = new Map(PROCEDURES.map((s, i) => [s.code, i]));

export function procedureByCode(code: string): ProcedureStep | undefined {
  return BY_CODE.get(code);
}

export function proceduresForStage(stage: StageId): ProcedureStep[] {
  return PROCEDURES.filter((s) => s.stage === stage);
}

export interface ProcedureGraph {
  nodes: string[];
  /** from = precondition, to = dependent step. */
  edges: { from: string; to: string }[];
  /** Preconditions that are rule ids, not procedures. */
  ruleEdges: { rule: string; to: string }[];
}

export function procedureGraph(): ProcedureGraph {
  const edges: ProcedureGraph["edges"] = [];
  const ruleEdges: ProcedureGraph["ruleEdges"] = [];
  for (const step of PROCEDURES) {
    for (const pre of step.preconditions) {
      if (BY_CODE.has(pre)) edges.push({ from: pre, to: step.code });
      else ruleEdges.push({ rule: pre, to: step.code });
    }
  }
  return { nodes: PROCEDURES.map((s) => s.code), edges, ruleEdges };
}

/** Deterministic topological order (Kahn, ties broken by catalog order). Throws on cycle. */
export function topologicalOrder(codes: readonly string[] = PROCEDURES.map((s) => s.code)): string[] {
  const set = new Set(codes);
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const c of set) {
    indeg.set(c, 0);
    out.set(c, []);
  }
  for (const c of set) {
    const step = BY_CODE.get(c);
    if (!step) throw new Error(`Unknown procedure code: ${c}`);
    for (const pre of step.preconditions) {
      if (!set.has(pre)) continue;
      indeg.set(c, (indeg.get(c) ?? 0) + 1);
      out.get(pre)!.push(c);
    }
  }
  const byIndex = (a: string, b: string) => (INDEX.get(a) ?? 0) - (INDEX.get(b) ?? 0);
  const ready = [...set].filter((c) => indeg.get(c) === 0).sort(byIndex);
  const order: string[] = [];
  while (ready.length) {
    const c = ready.shift()!;
    order.push(c);
    for (const n of out.get(c)!) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) {
        ready.push(n);
        ready.sort(byIndex);
      }
    }
  }
  if (order.length !== set.size) throw new Error("Procedure precondition graph has a cycle");
  return order;
}

export interface InstantiateContext {
  /** Case key appended to the code, following the delivery doc example ids (e.g. "PROC-01-204"). */
  key: string;
}

/** OwnerTask plus template provenance. Assignable to OwnerTask. */
export interface InstantiatedTask extends OwnerTask {
  code: string;
  sourceDoc: string;
  acceptance: string[];
  /** Preconditions outside the instantiated set (codes or rule ids); not in dependsOn. */
  externalPreconditions: string[];
  durationBasis: "default_placeholder";
}

/**
 * Turn a stage or explicit code list into task objects. Pure and deterministic:
 * same input -> same output, in dependency order. dependsOn only references
 * tasks in the same instantiated set; other preconditions are listed in
 * externalPreconditions. offsetDays = max(dep offset + dep duration), 0 for roots.
 */
export function instantiateTasks(selection: StageId | readonly string[], ctx: InstantiateContext): InstantiatedTask[] {
  if (!ctx || typeof ctx.key !== "string" || ctx.key.trim() === "") throw new Error("instantiateTasks: ctx.key is required");
  const codes =
    typeof selection === "string"
      ? proceduresForStage(selection).map((s) => s.code)
      : [...new Set(selection)];
  for (const c of codes) if (!BY_CODE.has(c)) throw new Error(`Unknown procedure code: ${c}`);
  const order = topologicalOrder(codes);
  const set = new Set(codes);
  const idOf = (c: string) => `${c}-${ctx.key}`;
  const offsets = new Map<string, number>();
  return order.map((code) => {
    const step = BY_CODE.get(code)!;
    const internal = step.preconditions.filter((p) => set.has(p));
    const offsetDays = internal.reduce((m, p) => Math.max(m, offsets.get(p)! + DEFAULT_DURATION_DAYS), 0);
    offsets.set(code, offsetDays);
    const task: InstantiatedTask = {
      id: idOf(code),
      code,
      title: step.title,
      role: step.role,
      stage: step.stage,
      dependsOn: internal.map(idOf),
      offsetDays,
      durationDays: DEFAULT_DURATION_DAYS,
      inputs: [...step.inputs],
      output: step.outputs.join("; "),
      evidence: [],
      recovery: step.recovery,
      status: "not_started",
      sourceDoc: step.sourceDoc,
      acceptance: [...step.acceptance],
      externalPreconditions: step.preconditions.filter((p) => !set.has(p)),
      durationBasis: "default_placeholder",
    };
    if (step.gate) task.gate = step.gate;
    return task;
  });
}
