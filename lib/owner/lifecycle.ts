// Owner lifecycle records, append-only event reducer, and M0–M9 gate evaluation.
//
// Sources: docs/INFRASTRUCTURE-LIFECYCLE.md §2/§4, INFRASTRUCTURE-WORKFLOWS.md
// (gate acceptance per module), INFRASTRUCTURE-PROCEDURES-*.md (state names).
//
// Pure and deterministic: no Date.now, no Math.random. Every time is an ISO
// string with an explicit offset supplied by the caller. State is never mutated;
// `applyEvent` returns a new state with an appended revision. A gate "pass" is
// an internal evidence-readiness result, never an approval, permit, or clearance.

import type { Evidence, Fact, GateId, ProcedureStep, Sector, StageId, Unknown } from "./types";
import { evaluationKey, type RuleEvaluation } from "./rules";

// ---------------------------------------------------------------------------
// Deterministic hashing (non-cryptographic; for replay/state identity only).

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function cyrb53(str: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Deterministic 112-bit (2×56) hex digest of a value's stable JSON. Not cryptographic. */
export function stableHash(value: unknown): string {
  const s = stableStringify(value);
  return `${cyrb53(s, 0)}${cyrb53(s, 0x9e3779b9)}`;
}

// ---------------------------------------------------------------------------
// Time helpers.

const DAY_MS = 86_400_000;

export function parseTime(iso: string, field = "time"): number {
  if (typeof iso !== "string" || !/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso)) {
    throw new LifecycleError("INVALID_TIME", `${field} must be an ISO timestamp with an explicit offset: ${String(iso)}`);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new LifecycleError("INVALID_TIME", `${field} is not a valid ISO timestamp: ${iso}`);
  return ms;
}

// ---------------------------------------------------------------------------
// Typed errors.

export type LifecycleErrorCode =
  | "INVALID_TIME" | "OUT_OF_ORDER" | "DUPLICATE_EVENT" | "DUPLICATE_RECORD" | "UNKNOWN_RECORD"
  | "UNAUTHORIZED" | "ILLEGAL_TRANSITION" | "MISSING_FIELD" | "IMMUTABLE_RECORD" | "IMMUTABLE_BASELINE"
  | "STALE_VERSION" | "NOT_APPLICABLE_REQUIRES_REVIEWER" | "RIGHTS_FROM_OUTREACH" | "PACKAGE_HASH_MISMATCH"
  | "AWARD_BEFORE_SUBMISSION" | "AWARD_BEFORE_APPROVALS" | "LICENSE_MISMATCH" | "LICENSE_EXPIRED"
  | "RETEST_CHAIN" | "WAIVER_REQUIRES_APPROVER" | "EVIDENCE_REQUIRED" | "SUPERSEDES_INVALID";

export class LifecycleError extends Error {
  readonly code: LifecycleErrorCode;
  readonly recordId?: string;
  constructor(code: LifecycleErrorCode, message: string, recordId?: string) {
    super(`${code}: ${message}`);
    this.name = "LifecycleError";
    this.code = code;
    this.recordId = recordId;
  }
}

// ---------------------------------------------------------------------------
// Record vocabularies (exact doc names where the docs name them).

/** PROCEDURES-AUTHORIZATIONS PER-01: six distinct applicability states. */
export const APPLICABILITY_STATES = [
  "not assessed",
  "potentially applicable",
  "confirmed applicable",
  "not applicable with rationale",
  "non-determination—authority/source unclear",
  "superseded by change",
] as const;
export type ApplicabilityState = (typeof APPLICABILITY_STATES)[number];

/** PROCEDURES-AUTHORIZATIONS PER-01: thirteen distinct external lifecycle states. */
export const EXTERNAL_STATES = [
  "not ready",
  "pre-application",
  "in preparation",
  "submitted",
  "receipt confirmed",
  "under review",
  "information requested",
  "issued",
  "denied",
  "withdrawn",
  "appeal/dispute",
  "expired",
  "closed",
] as const;
export type ExternalState = (typeof EXTERNAL_STATES)[number];

const EXTERNAL_TRANSITIONS: Record<ExternalState, ExternalState[]> = {
  "not ready": ["pre-application", "in preparation", "withdrawn", "closed"],
  "pre-application": ["in preparation", "withdrawn", "closed"],
  "in preparation": ["submitted", "withdrawn", "closed"],
  submitted: ["receipt confirmed", "under review", "information requested", "withdrawn"],
  "receipt confirmed": ["under review", "information requested", "withdrawn"],
  "under review": ["information requested", "issued", "denied", "withdrawn"],
  "information requested": ["under review", "submitted", "withdrawn", "denied"],
  issued: ["expired", "appeal/dispute", "closed"],
  denied: ["appeal/dispute", "closed"],
  withdrawn: ["closed"],
  "appeal/dispute": ["issued", "denied", "closed"],
  // Expiry is terminal for this record: renewal is a new linked authorization.
  expired: ["closed"],
  closed: [],
};

export type SubmissionState = "draft" | "submitted" | "acknowledged" | "returned" | "withdrawn" | "closed";
const SUBMISSION_TRANSITIONS: Record<SubmissionState, SubmissionState[]> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["acknowledged", "returned", "withdrawn"],
  acknowledged: ["returned", "withdrawn", "closed"],
  returned: ["closed", "withdrawn"],
  withdrawn: ["closed"],
  closed: [],
};

export type ConditionStatus = "open" | "in_progress" | "evidence_submitted" | "verified" | "waived_by_authority" | "overdue" | "disputed" | "closed";
type StoredConditionStatus = Exclude<ConditionStatus, "overdue">;
const CONDITION_TRANSITIONS: Record<StoredConditionStatus, StoredConditionStatus[]> = {
  open: ["in_progress", "evidence_submitted", "disputed"],
  in_progress: ["evidence_submitted", "disputed"],
  evidence_submitted: ["verified", "in_progress", "disputed"],
  disputed: ["open", "in_progress"],
  verified: ["closed"],
  waived_by_authority: ["closed"],
  closed: [],
};

export type FundingStatus = "identified" | "inquiry" | "applied" | "conditional" | "awarded" | "committed" | "available" | "received" | "repaid" | "withdrawn" | "declined";
const FUNDING_TRANSITIONS: Record<FundingStatus, FundingStatus[]> = {
  identified: ["inquiry", "applied", "withdrawn"],
  inquiry: ["applied", "withdrawn"],
  applied: ["conditional", "awarded", "declined", "withdrawn"],
  conditional: ["awarded", "committed", "declined", "withdrawn"],
  awarded: ["committed", "declined", "withdrawn"],
  committed: ["available", "withdrawn"],
  available: ["received"],
  received: ["repaid"],
  repaid: [],
  withdrawn: [],
  declined: [],
};
/** Only reviewed commitments count toward the committed total; pending funds never do. */
export const COMMITTED_FUNDING: readonly FundingStatus[] = ["committed", "available", "received"];
const EVIDENCED_FUNDING: readonly FundingStatus[] = ["conditional", "awarded", "committed", "available", "received"];

export type AssetStatus = "candidate" | "validated" | "in_service" | "retired" | "transferred";
const ASSET_TRANSITIONS: Record<AssetStatus, AssetStatus[]> = {
  candidate: ["validated"],
  validated: ["in_service", "retired"],
  in_service: ["retired", "transferred"],
  retired: [],
  transferred: [],
};

export type NcrStatus = "open" | "contained" | "dispositioned" | "closed";
const NCR_TRANSITIONS: Record<NcrStatus, NcrStatus[]> = {
  open: ["contained", "dispositioned"],
  contained: ["dispositioned"],
  dispositioned: ["closed", "open"],
  closed: [],
};

export type TestOutcome = "pass" | "fail" | "inconclusive" | "not_run" | "deferred";
export type DecisionOutcome = "proceed" | "hold" | "stop" | "unknown";
export type LandInstrument = "outreach" | "meeting" | "access_request" | "loi_draft" | "term_sheet_draft" | "executed";

// ---------------------------------------------------------------------------
// Records.

export interface CaseRecord {
  id: string; title: string; sector: Sector | null; accepted: boolean; owner: string | null;
  urgency: "routine" | "urgent" | "emergency" | null; nextAction: string | null; nextActionDate: string | null;
  sourceEvidence: string[]; parentCaseId: string | null;
}

export interface DecisionRecord {
  id: string; gate: GateId; kind: "alternative" | "no_go" | "renewal" | "retirement" | "other";
  question: string; owner: string; alternatives: { id: string; label: string; viable: boolean }[];
  outcome: DecisionOutcome; rationale: string; weights: Record<string, number>; assumptions: string[];
  evidence: string[]; decidedAt: string; revisitAt: string | null; version: number;
  signedBy: string | null; signedAt: string | null;
}

export interface Authorization {
  id: string; requirement: string; authority: string; activity: string; phase: string;
  jurisdictionId: string | null; segmentId: string | null; ruleId: string | null;
  /** Gates whose readiness depends on this instrument remaining valid. */
  requiredFor: GateId[];
  applicability: ApplicabilityState; applicabilityBasis: string | null; reviewer: string | null;
  external: ExternalState; instrumentEvidence: string[];
  issuedAt: string | null;
  /** Explicit expiry, or Unknown. state "not_applicable" (with reason) records a non-expiring instrument; "unknown" is never treated as perpetual. */
  expiresAt: string | Unknown;
  renews: string | null; supersedes: string | null;
}

export interface Submission {
  id: string; kind: "grant_application" | "permit_application" | "utility_application" | "other";
  authority: string; packageRevision: string; attachments: { name: string; sha256: string }[];
  /** Frozen at draft time over packageRevision + attachment hashes. */
  packageHash: string; fundingId: string | null; authorizationId: string | null;
  state: SubmissionState; submitter: string | null; sentAt: string | null;
  receipt: { reference: string; evidenceId: string; receivedAt: string } | null; reason: string | null;
}

export interface Condition {
  id: string; sourceRecordId: string; text: string; authority: string; responsibleParty: string;
  dueAt: string | null; trigger: string | null; blocksGates: GateId[];
  status: StoredConditionStatus; evidence: string[]; reviewer: string | null;
  waiver: { approver: string; reason: string; evidence: string[]; at: string } | null;
}

export interface AssetRecord { id: string; assetType: string; status: AssetStatus; custodian: string | null; baselineId: string | null }

export interface Ncr {
  id: string; severity: "critical" | "major" | "minor"; description: string; owner: string | null;
  status: NcrStatus; disposition: string | null; dispositionedBy: string | null; evidence: string[];
}

export interface TestResult {
  id: string; testId: string; stage: "construction" | "commissioning"; critical: boolean;
  outcome: TestOutcome; executedAt: string; executor: string; witness: string | null; reviewedBy: string | null;
  retestOf: string | null; observed: string | null; evidence: string[];
  /** For deferred tests: risk owner and review date (required by TURN-03). */
  deferral: { owner: string; reviewAt: string; control: string } | null;
}

export interface Baseline {
  id: string; kind: "design" | "schedule"; version: number; content: unknown; contentHash: string;
  createdAt: string; supersedes: string | null;
}

export interface LandRecord {
  id: string; parcel: string; instrument: LandInstrument; status: "draft" | "accepted" | "waived";
  evidence: string[]; acceptedBy: string | null; waiver: { by: string; reason: string } | null;
}

export interface FundingSource {
  id: string; provider: string; kind: "grant" | "loan" | "capital" | "rate_base" | "other";
  amount: number; currency: string; status: FundingStatus; evidence: string[]; submissionId: string | null;
}

export interface Budget {
  id: string; amount: number; currency: string; version: number; approvedBy: string; approvedAt: string;
  residualGap: { acknowledgedBy: string; reason: string } | null;
}

export interface Supplier {
  id: string; name: string;
  licenses: { class: string; jurisdictionId: string; expiresAt: string; evidenceId: string }[];
}

export interface EquipmentItem {
  id: string; model: string; supplierId: string | null; longLead: boolean;
  availability: "available" | "unavailable" | "unknown"; leadTimeDays: number | null; evidence: string[];
  substitutedBy: { model: string; supplierId: string; approvedBy: string } | null;
}

export interface ProcurementPackage {
  id: string; scope: string; requiredLicense: { class: string; jurisdictionId: string } | null;
  approvals: { kind: string; by: string; at: string }[];
  award: { supplierId: string; by: string; at: string } | null;
  executedEvidence: string[]; equipment: EquipmentItem[];
}

export interface GateSignoff { gate: GateId; by: string; at: string; evidence: string[] }
export interface ProcedureCompletion { code: string; by: string; at: string; evidence: string[] }
export interface LinkedCase { caseId: string; relation: "renewal" | "replacement" | "incident" | "decommissioning"; fromBaselineId: string | null; trigger: string | null; reason: string; at: string }

/** One immutable revision of a record. */
export interface Rev<T> { revision: number; eventId: string; at: string; by: string; record: T }

// ---------------------------------------------------------------------------
// Configuration (owner-supplied roles and delegations; nothing hard-coded).

export interface LifecycleConfig {
  /** actor id → roles held. */
  roles: Record<string, string[]>;
  /** action → roles permitted to perform it. */
  authority: {
    triage: string[]; decision: string[]; applicabilityReviewer: string[]; instrumentVerifier: string[];
    landRights: string[]; budget: string[]; submission: string[]; award: string[]; waiver: string[];
    conditionReviewer: string[]; designAuthority: string[]; ncrDisposition: string[]; testReviewer: string[];
    gateSignoff: Partial<Record<GateId, string[]>>;
  };
  /** Approval kinds that must be recorded on a package before award (PROC-04). */
  requiredAwardApprovals: string[];
  /** Evidence retrieved more than this many days before asOf is treated as stale. */
  evidenceMaxAgeDays?: number;
}

// ---------------------------------------------------------------------------
// State.

export interface LifecycleState {
  schema: "gridsentinel.owner-lifecycle/1";
  config: LifecycleConfig;
  revision: number;
  lastEventAt: string | null;
  /** Append-only event log; replaying it from the same initial state reproduces this state. */
  log: LifecycleEvent[];
  case: Rev<CaseRecord>[];
  facts: Record<string, Rev<Fact>[]>;
  evidence: Record<string, Rev<Evidence>[]>;
  decisions: Record<string, Rev<DecisionRecord>[]>;
  authorizations: Record<string, Rev<Authorization>[]>;
  submissions: Record<string, Rev<Submission>[]>;
  conditions: Record<string, Rev<Condition>[]>;
  assets: Record<string, Rev<AssetRecord>[]>;
  ncrs: Record<string, Rev<Ncr>[]>;
  tests: Record<string, Rev<TestResult>[]>;
  baselines: Record<string, Rev<Baseline>[]>;
  land: Record<string, Rev<LandRecord>[]>;
  funding: Record<string, Rev<FundingSource>[]>;
  budgets: Record<string, Rev<Budget>[]>;
  suppliers: Record<string, Rev<Supplier>[]>;
  packages: Record<string, Rev<ProcurementPackage>[]>;
  signoffs: Rev<GateSignoff>[];
  procedures: Record<string, Rev<ProcedureCompletion>[]>;
  ruleEvaluations: Record<string, Rev<RuleEvaluation>[]>;
  linkedCases: Rev<LinkedCase>[];
}

export function createLifecycle(init: { caseId: string; title: string; sector?: Sector | null; parentCaseId?: string | null; config: LifecycleConfig }): LifecycleState {
  const c: CaseRecord = {
    id: init.caseId, title: init.title, sector: init.sector ?? null, accepted: false, owner: null, urgency: null,
    nextAction: null, nextActionDate: null, sourceEvidence: [], parentCaseId: init.parentCaseId ?? null,
  };
  return {
    schema: "gridsentinel.owner-lifecycle/1", config: init.config, revision: 0, lastEventAt: null, log: [],
    case: [{ revision: 0, eventId: "init", at: "", by: "system", record: c }],
    facts: {}, evidence: {}, decisions: {}, authorizations: {}, submissions: {}, conditions: {}, assets: {},
    ncrs: {}, tests: {}, baselines: {}, land: {}, funding: {}, budgets: {}, suppliers: {}, packages: {},
    signoffs: [], procedures: {}, ruleEvaluations: {}, linkedCases: [],
  };
}

export function current<T>(revs: Rev<T>[] | undefined): T | undefined {
  return revs && revs.length ? revs[revs.length - 1].record : undefined;
}
function currentAll<T>(map: Record<string, Rev<T>[]>): T[] {
  return Object.keys(map).sort().map((k) => current(map[k]) as T);
}
export function caseRecord(s: LifecycleState): CaseRecord { return current(s.case) as CaseRecord }

/** Deterministic identity of a state (used for replay checks). */
export function stateHash(s: LifecycleState): string { return stableHash(s) }

// ---------------------------------------------------------------------------
// Events.

interface Base { id: string; at: string; actor: string }
export type LifecycleEvent = Base & (
  | { type: "intake_accepted"; owner: string; urgency: "routine" | "urgent" | "emergency"; nextAction: string; nextActionDate: string; sourceEvidence: string[] }
  | { type: "next_action_set"; nextAction: string; nextActionDate: string }
  | { type: "evidence_recorded"; evidence: Evidence }
  | { type: "fact_recorded"; fact: Fact }
  | { type: "decision_recorded"; decision: Omit<DecisionRecord, "version" | "signedBy" | "signedAt"> }
  | { type: "decision_revised"; decisionId: string; changes: Partial<Pick<DecisionRecord, "weights" | "assumptions" | "alternatives" | "outcome" | "rationale" | "evidence" | "revisitAt">> }
  | { type: "decision_signed"; decisionId: string; version: number }
  | { type: "land_record_added"; record: Omit<LandRecord, "status" | "acceptedBy" | "waiver"> }
  | { type: "land_rights_accepted"; recordId: string; evidence: string[] }
  | { type: "land_control_waived"; recordId: string; reason: string }
  | { type: "budget_approved"; budget: Omit<Budget, "version" | "approvedBy" | "approvedAt"> }
  | { type: "funding_source_recorded"; source: Omit<FundingSource, "submissionId"> }
  | { type: "funding_status_changed"; fundingId: string; status: FundingStatus; evidence: string[] }
  | { type: "submission_drafted"; submission: Pick<Submission, "id" | "kind" | "authority" | "packageRevision" | "attachments"> & { fundingId?: string | null; authorizationId?: string | null } }
  | { type: "submission_sent"; submissionId: string; packageHash: string }
  | { type: "submission_receipt_recorded"; submissionId: string; reference: string; evidenceId: string; receivedAt: string }
  | { type: "submission_status_changed"; submissionId: string; state: "returned" | "withdrawn" | "closed"; reason: string }
  | { type: "grant_award_recorded"; submissionId: string; fundingId: string; amount: number; evidence: string[] }
  | { type: "authorization_identified"; authorization: Pick<Authorization, "id" | "requirement" | "authority" | "activity" | "phase"> & { jurisdictionId?: string | null; segmentId?: string | null; ruleId?: string | null; requiredFor?: GateId[]; renews?: string | null; supersedes?: string | null } }
  | { type: "authorization_applicability_set"; authorizationId: string; applicability: ApplicabilityState; basis: string | null }
  | { type: "authorization_external_changed"; authorizationId: string; state: ExternalState; evidence: string[]; issuedAt?: string; expiresAt?: string | Unknown }
  | { type: "condition_recorded"; condition: Omit<Condition, "status" | "evidence" | "reviewer" | "waiver"> }
  | { type: "condition_status_changed"; conditionId: string; status: Exclude<StoredConditionStatus, "waived_by_authority" | "closed">; evidence: string[] }
  | { type: "condition_waived"; conditionId: string; reason: string; evidence: string[] }
  | { type: "condition_closed"; conditionId: string }
  | { type: "asset_registered"; asset: Pick<AssetRecord, "id" | "assetType"> & { baselineId?: string | null } }
  | { type: "asset_custodian_assigned"; assetId: string; custodian: string }
  | { type: "asset_status_changed"; assetId: string; status: AssetStatus }
  | { type: "ncr_raised"; ncr: Pick<Ncr, "id" | "severity" | "description"> & { owner?: string | null; evidence?: string[] } }
  | { type: "ncr_status_changed"; ncrId: string; status: NcrStatus; disposition?: string; evidence?: string[] }
  | { type: "test_result_recorded"; result: TestResult }
  | { type: "baseline_recorded"; baseline: Omit<Baseline, "contentHash"> }
  | { type: "linked_case_opened"; link: Omit<LinkedCase, "at"> }
  | { type: "supplier_registered"; supplier: Supplier }
  | { type: "procurement_package_created"; package: Pick<ProcurementPackage, "id" | "scope" | "requiredLicense"> & { equipment?: Omit<EquipmentItem, "substitutedBy">[] } }
  | { type: "procurement_approval_recorded"; packageId: string; kind: string }
  | { type: "procurement_awarded"; packageId: string; supplierId: string }
  | { type: "contract_executed"; packageId: string; evidence: string[] }
  | { type: "equipment_availability_changed"; packageId: string; equipmentId: string; availability: EquipmentItem["availability"]; leadTimeDays: number | null; evidence: string[] }
  | { type: "equipment_substituted"; packageId: string; equipmentId: string; model: string; supplierId: string }
  | { type: "gate_signoff"; gate: GateId; evidence: string[] }
  | { type: "procedure_step_completed"; code: string; evidence: string[] }
  | { type: "rule_evaluations_recorded"; evaluations: RuleEvaluation[] }
);
export type LifecycleEventType = LifecycleEvent["type"];

/** Every event type the reducer handles (exported for coverage checks). */
export const EVENT_TYPES: readonly LifecycleEventType[] = [
  "intake_accepted", "next_action_set", "evidence_recorded", "fact_recorded", "decision_recorded", "decision_revised",
  "decision_signed", "land_record_added", "land_rights_accepted", "land_control_waived", "budget_approved",
  "funding_source_recorded", "funding_status_changed", "submission_drafted", "submission_sent",
  "submission_receipt_recorded", "submission_status_changed", "grant_award_recorded", "authorization_identified",
  "authorization_applicability_set", "authorization_external_changed", "condition_recorded", "condition_status_changed",
  "condition_waived", "condition_closed", "asset_registered", "asset_custodian_assigned", "asset_status_changed",
  "ncr_raised", "ncr_status_changed", "test_result_recorded", "baseline_recorded", "linked_case_opened",
  "supplier_registered", "procurement_package_created", "procurement_approval_recorded", "procurement_awarded",
  "contract_executed", "equipment_availability_changed", "equipment_substituted", "gate_signoff",
  "procedure_step_completed", "rule_evaluations_recorded",
];

// ---------------------------------------------------------------------------
// Reducer helpers.

function hasAuthority(s: LifecycleState, actor: string, roles: string[] | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  const held = s.config.roles[actor] ?? [];
  return held.some((r) => roles.includes(r));
}
function requireAuthority(s: LifecycleState, actor: string, roles: string[] | undefined, action: string, recordId?: string): void {
  if (!hasAuthority(s, actor, roles)) throw new LifecycleError("UNAUTHORIZED", `${actor} lacks configured authority to ${action}`, recordId);
}
function requireText(v: unknown, field: string, recordId?: string): void {
  if (typeof v !== "string" || v.trim() === "") throw new LifecycleError("MISSING_FIELD", `${field} is required`, recordId);
}
function requireEvidence(ids: string[] | undefined, what: string, recordId?: string): void {
  if (!ids || ids.length === 0) throw new LifecycleError("EVIDENCE_REQUIRED", `${what} requires evidence`, recordId);
}
function get<T>(map: Record<string, Rev<T>[]>, id: string, kind: string): T {
  const r = current(map[id]);
  if (!r) throw new LifecycleError("UNKNOWN_RECORD", `${kind} ${id} does not exist`, id);
  return r;
}
function transition<S extends string>(table: Record<S, S[]>, from: S, to: S, kind: string, id: string): void {
  if (!(table[from] ?? []).includes(to)) throw new LifecycleError("ILLEGAL_TRANSITION", `${kind} ${id}: ${from} → ${to} is not permitted`, id);
}

type MapKey = "facts" | "evidence" | "decisions" | "authorizations" | "submissions" | "conditions" | "assets" | "ncrs" | "tests"
  | "baselines" | "land" | "funding" | "budgets" | "suppliers" | "packages" | "procedures" | "ruleEvaluations";
type RecOf<K extends MapKey> = LifecycleState[K] extends Record<string, Rev<infer T>[]> ? T : never;

function put<K extends MapKey>(s: LifecycleState, key: K, id: string, record: RecOf<K>, ev: LifecycleEvent): LifecycleState {
  const map = s[key] as Record<string, Rev<RecOf<K>>[]>;
  const prior = map[id] ?? [];
  const r: Rev<RecOf<K>> = { revision: s.revision + 1, eventId: ev.id, at: ev.at, by: ev.actor, record };
  return { ...s, [key]: { ...map, [id]: [...prior, r] } };
}
function create<K extends MapKey>(s: LifecycleState, key: K, id: string, record: RecOf<K>, ev: LifecycleEvent, kind: string): LifecycleState {
  requireText(id, `${kind} id`);
  if ((s[key] as Record<string, unknown>)[id]) throw new LifecycleError("DUPLICATE_RECORD", `${kind} ${id} already exists`, id);
  return put(s, key, id, record, ev);
}
function rev<T>(s: LifecycleState, ev: LifecycleEvent, record: T): Rev<T> {
  return { revision: s.revision + 1, eventId: ev.id, at: ev.at, by: ev.actor, record };
}

// ---------------------------------------------------------------------------
// Reducer.

/** Apply one event. Throws LifecycleError on any illegal transition; never mutates `state`. */
export function applyEvent(state: LifecycleState, ev: LifecycleEvent): LifecycleState {
  requireText(ev.id, "event id");
  requireText(ev.actor, "event actor", ev.id);
  const at = parseTime(ev.at, "event.at");
  if (state.lastEventAt !== null && at < parseTime(state.lastEventAt)) {
    throw new LifecycleError("OUT_OF_ORDER", `event ${ev.id} at ${ev.at} precedes last event ${state.lastEventAt}`, ev.id);
  }
  if (state.log.some((e) => e.id === ev.id)) throw new LifecycleError("DUPLICATE_EVENT", `event ${ev.id} already applied`, ev.id);
  const s = reduce(state, ev);
  return { ...s, revision: state.revision + 1, lastEventAt: ev.at, log: [...state.log, ev] };
}

/** Non-throwing variant. */
export function tryApplyEvent(state: LifecycleState, ev: LifecycleEvent): { ok: true; state: LifecycleState } | { ok: false; error: LifecycleError } {
  try {
    return { ok: true, state: applyEvent(state, ev) };
  } catch (e) {
    if (e instanceof LifecycleError) return { ok: false, error: e };
    throw e;
  }
}

/** Replay an event log from an initial state. */
export function replay(initial: LifecycleState, events: LifecycleEvent[]): LifecycleState {
  return events.reduce(applyEvent, initial);
}

function reduce(s: LifecycleState, ev: LifecycleEvent): LifecycleState {
  const cfg = s.config.authority;
  switch (ev.type) {
    case "intake_accepted": {
      requireAuthority(s, ev.actor, cfg.triage, "accept intake");
      const c = caseRecord(s);
      if (c.accepted) throw new LifecycleError("ILLEGAL_TRANSITION", `case ${c.id} already accepted`, c.id);
      requireText(ev.owner, "owner", c.id);
      requireText(ev.nextAction, "nextAction", c.id);
      parseTime(ev.nextActionDate, "nextActionDate");
      requireEvidence(ev.sourceEvidence, "intake acceptance", c.id);
      const rec: CaseRecord = { ...c, accepted: true, owner: ev.owner, urgency: ev.urgency, nextAction: ev.nextAction, nextActionDate: ev.nextActionDate, sourceEvidence: [...ev.sourceEvidence] };
      return { ...s, case: [...s.case, rev(s, ev, rec)] };
    }
    case "next_action_set": {
      const c = caseRecord(s);
      requireText(ev.nextAction, "nextAction", c.id);
      parseTime(ev.nextActionDate, "nextActionDate");
      return { ...s, case: [...s.case, rev(s, ev, { ...c, nextAction: ev.nextAction, nextActionDate: ev.nextActionDate })] };
    }
    case "evidence_recorded": {
      const e = ev.evidence;
      requireText(e.id, "evidence id");
      parseTime(e.retrievedAt, "evidence.retrievedAt");
      if (e.observedAt) parseTime(e.observedAt, "evidence.observedAt");
      // Re-recording an id appends a new revision (e.g. re-retrieved snapshot); history is retained.
      return put(s, "evidence", e.id, { ...e }, ev);
    }
    case "fact_recorded": {
      const f = ev.fact;
      parseTime(f.asOf, "fact.asOf");
      if (f.supersedes) {
        if (!s.facts[f.supersedes]) throw new LifecycleError("SUPERSEDES_INVALID", `fact ${f.id} supersedes unknown fact ${f.supersedes}`, f.id);
        const already = currentAll(s.facts).some((x) => x.supersedes === f.supersedes);
        if (already) throw new LifecycleError("SUPERSEDES_INVALID", `fact ${f.supersedes} is already superseded`, f.id);
      }
      return create(s, "facts", f.id, { ...f }, ev, "fact");
    }
    case "decision_recorded": {
      const d = ev.decision;
      requireText(d.question, "decision.question", d.id);
      requireText(d.owner, "decision.owner", d.id);
      parseTime(d.decidedAt, "decision.decidedAt");
      if (d.outcome === "stop") requireText(d.rationale, "no-go rationale", d.id);
      return create(s, "decisions", d.id, { ...d, version: 1, signedBy: null, signedAt: null }, ev, "decision");
    }
    case "decision_revised": {
      const d = get(s.decisions, ev.decisionId, "decision");
      // A weight/assumption change is a new version; prior sign-off does not carry forward.
      return put(s, "decisions", d.id, { ...d, ...ev.changes, version: d.version + 1, signedBy: null, signedAt: null }, ev);
    }
    case "decision_signed": {
      const d = get(s.decisions, ev.decisionId, "decision");
      requireAuthority(s, ev.actor, cfg.decision, `sign decision ${d.id}`, d.id);
      if (ev.version !== d.version) throw new LifecycleError("STALE_VERSION", `decision ${d.id} is at v${d.version}; cannot sign v${ev.version}`, d.id);
      if (d.signedBy) throw new LifecycleError("ILLEGAL_TRANSITION", `decision ${d.id} v${d.version} already signed`, d.id);
      return put(s, "decisions", d.id, { ...d, signedBy: ev.actor, signedAt: ev.at }, ev);
    }
    case "land_record_added": {
      const r = ev.record;
      requireText(r.parcel, "parcel", r.id);
      return create(s, "land", r.id, { ...r, status: "draft", acceptedBy: null, waiver: null }, ev, "land record");
    }
    case "land_rights_accepted": {
      const r = get(s.land, ev.recordId, "land record");
      requireAuthority(s, ev.actor, cfg.landRights, `accept rights evidence for ${r.id}`, r.id);
      if (r.instrument !== "executed") throw new LifecycleError("RIGHTS_FROM_OUTREACH", `land record ${r.id} is "${r.instrument}"; only an executed instrument can evidence site control`, r.id);
      requireEvidence(ev.evidence, "rights acceptance", r.id);
      return put(s, "land", r.id, { ...r, status: "accepted", acceptedBy: ev.actor, evidence: [...new Set([...r.evidence, ...ev.evidence])] }, ev);
    }
    case "land_control_waived": {
      const r = get(s.land, ev.recordId, "land record");
      requireAuthority(s, ev.actor, cfg.waiver, `waive site control for ${r.id}`, r.id);
      if (!ev.reason || !ev.reason.trim()) throw new LifecycleError("WAIVER_REQUIRES_APPROVER", `waiver of ${r.id} requires a reason`, r.id);
      return put(s, "land", r.id, { ...r, status: "waived", waiver: { by: ev.actor, reason: ev.reason } }, ev);
    }
    case "budget_approved": {
      const b = ev.budget;
      requireAuthority(s, ev.actor, cfg.budget, "approve budget", b.id);
      if (!(b.amount > 0)) throw new LifecycleError("MISSING_FIELD", "budget amount must be positive", b.id);
      requireText(b.currency, "budget currency", b.id);
      const prev = current(s.budgets[b.id]);
      return put(s, "budgets", b.id, { ...b, version: (prev?.version ?? 0) + 1, approvedBy: ev.actor, approvedAt: ev.at }, ev);
    }
    case "funding_source_recorded": {
      const f = ev.source;
      if (EVIDENCED_FUNDING.includes(f.status)) requireEvidence(f.evidence, `funding status ${f.status}`, f.id);
      return create(s, "funding", f.id, { ...f, submissionId: null }, ev, "funding source");
    }
    case "funding_status_changed": {
      const f = get(s.funding, ev.fundingId, "funding source");
      transition(FUNDING_TRANSITIONS, f.status, ev.status, "funding", f.id);
      if (EVIDENCED_FUNDING.includes(ev.status)) requireEvidence(ev.evidence, `funding status ${ev.status}`, f.id);
      if (f.kind === "grant" && ev.status === "awarded") {
        throw new LifecycleError("AWARD_BEFORE_SUBMISSION", `grant award for ${f.id} must be recorded via grant_award_recorded against a submission`, f.id);
      }
      return put(s, "funding", f.id, { ...f, status: ev.status, evidence: [...new Set([...f.evidence, ...ev.evidence])] }, ev);
    }
    case "submission_drafted": {
      const d = ev.submission;
      requireText(d.authority, "submission authority", d.id);
      requireText(d.packageRevision, "packageRevision", d.id);
      if (!d.attachments.length) throw new LifecycleError("MISSING_FIELD", "submission package needs attachments", d.id);
      if (d.fundingId) get(s.funding, d.fundingId, "funding source");
      if (d.authorizationId) get(s.authorizations, d.authorizationId, "authorization");
      const attachments = [...d.attachments].map((a) => ({ ...a })).sort((a, b) => a.name.localeCompare(b.name));
      const packageHash = submissionPackageHash(d.packageRevision, attachments);
      return create(s, "submissions", d.id, {
        id: d.id, kind: d.kind, authority: d.authority, packageRevision: d.packageRevision, attachments, packageHash,
        fundingId: d.fundingId ?? null, authorizationId: d.authorizationId ?? null, state: "draft", submitter: null,
        sentAt: null, receipt: null, reason: null,
      }, ev, "submission");
    }
    case "submission_sent": {
      const sub = get(s.submissions, ev.submissionId, "submission");
      requireAuthority(s, ev.actor, cfg.submission, `submit ${sub.id}`, sub.id);
      transition(SUBMISSION_TRANSITIONS, sub.state, "submitted", "submission", sub.id);
      if (ev.packageHash !== sub.packageHash) throw new LifecycleError("PACKAGE_HASH_MISMATCH", `submitted package ${ev.packageHash} differs from frozen ${sub.packageHash}`, sub.id);
      let next = put(s, "submissions", sub.id, { ...sub, state: "submitted", submitter: ev.actor, sentAt: ev.at }, ev);
      if (sub.fundingId) {
        const f = get(next.funding, sub.fundingId, "funding source");
        if (f.status === "identified" || f.status === "inquiry") next = put(next, "funding", f.id, { ...f, status: "applied", submissionId: sub.id }, ev);
        else next = put(next, "funding", f.id, { ...f, submissionId: sub.id }, ev);
      }
      return next;
    }
    case "submission_receipt_recorded": {
      const sub = get(s.submissions, ev.submissionId, "submission");
      transition(SUBMISSION_TRANSITIONS, sub.state, "acknowledged", "submission", sub.id);
      requireText(ev.reference, "receipt reference", sub.id);
      get(s.evidence, ev.evidenceId, "evidence");
      parseTime(ev.receivedAt, "receipt.receivedAt");
      return put(s, "submissions", sub.id, { ...sub, state: "acknowledged", receipt: { reference: ev.reference, evidenceId: ev.evidenceId, receivedAt: ev.receivedAt } }, ev);
    }
    case "submission_status_changed": {
      const sub = get(s.submissions, ev.submissionId, "submission");
      transition(SUBMISSION_TRANSITIONS, sub.state, ev.state, "submission", sub.id);
      requireText(ev.reason, "reason", sub.id);
      return put(s, "submissions", sub.id, { ...sub, state: ev.state, reason: ev.reason }, ev);
    }
    case "grant_award_recorded": {
      const sub = get(s.submissions, ev.submissionId, "submission");
      const f = get(s.funding, ev.fundingId, "funding source");
      if (sub.state !== "submitted" && sub.state !== "acknowledged") {
        throw new LifecycleError("AWARD_BEFORE_SUBMISSION", `submission ${sub.id} is ${sub.state}; an award requires a sent application`, sub.id);
      }
      if (sub.fundingId !== f.id) throw new LifecycleError("ILLEGAL_TRANSITION", `submission ${sub.id} is not linked to funding ${f.id}`, f.id);
      requireEvidence(ev.evidence, "award notice", f.id);
      transition(FUNDING_TRANSITIONS, f.status, "awarded", "funding", f.id);
      // Award is a separate record from submission: submission state is untouched.
      return put(s, "funding", f.id, { ...f, status: "awarded", amount: ev.amount, evidence: [...new Set([...f.evidence, ...ev.evidence])] }, ev);
    }
    case "authorization_identified": {
      const a = ev.authorization;
      requireText(a.requirement, "requirement", a.id);
      requireText(a.activity, "activity", a.id);
      requireText(a.phase, "phase", a.id);
      if (a.supersedes) get(s.authorizations, a.supersedes, "authorization");
      if (a.renews) get(s.authorizations, a.renews, "authorization");
      return create(s, "authorizations", a.id, {
        id: a.id, requirement: a.requirement, authority: a.authority, activity: a.activity, phase: a.phase,
        jurisdictionId: a.jurisdictionId ?? null, segmentId: a.segmentId ?? null, ruleId: a.ruleId ?? null,
        requiredFor: a.requiredFor ?? ["M4", "M5", "M6"], applicability: "not assessed", applicabilityBasis: null,
        reviewer: null, external: "not ready", instrumentEvidence: [], issuedAt: null,
        expiresAt: { state: "unknown", reason: "no instrument recorded" }, renews: a.renews ?? null, supersedes: a.supersedes ?? null,
      }, ev, "authorization");
    }
    case "authorization_applicability_set": {
      const a = get(s.authorizations, ev.authorizationId, "authorization");
      if (!APPLICABILITY_STATES.includes(ev.applicability)) throw new LifecycleError("ILLEGAL_TRANSITION", `unknown applicability ${ev.applicability}`, a.id);
      if (ev.applicability === "not applicable with rationale") {
        if (!hasAuthority(s, ev.actor, cfg.applicabilityReviewer) || !ev.basis || !ev.basis.trim()) {
          throw new LifecycleError("NOT_APPLICABLE_REQUIRES_REVIEWER", `"not applicable" for ${a.id} requires a named authorized reviewer and a rationale`, a.id);
        }
      }
      if (ev.applicability === "confirmed applicable") requireAuthority(s, ev.actor, cfg.applicabilityReviewer, `confirm applicability of ${a.id}`, a.id);
      const reviewed = ev.applicability === "confirmed applicable" || ev.applicability === "not applicable with rationale";
      return put(s, "authorizations", a.id, { ...a, applicability: ev.applicability, applicabilityBasis: ev.basis, reviewer: reviewed ? ev.actor : a.reviewer }, ev);
    }
    case "authorization_external_changed": {
      const a = get(s.authorizations, ev.authorizationId, "authorization");
      transition(EXTERNAL_TRANSITIONS, a.external, ev.state, "authorization", a.id);
      if (a.applicability === "not applicable with rationale" || a.applicability === "superseded by change") {
        throw new LifecycleError("ILLEGAL_TRANSITION", `authorization ${a.id} is "${a.applicability}"; external lifecycle is closed`, a.id);
      }
      let next: Authorization = { ...a, external: ev.state, instrumentEvidence: [...new Set([...a.instrumentEvidence, ...ev.evidence])] };
      if (ev.state === "issued") {
        // Only an authorized verifier with instrument evidence marks external issuance.
        requireAuthority(s, ev.actor, cfg.instrumentVerifier, `record issuance of ${a.id}`, a.id);
        requireEvidence(ev.evidence, "issued instrument", a.id);
        if (!ev.issuedAt) throw new LifecycleError("MISSING_FIELD", "issuedAt is required for issuance", a.id);
        parseTime(ev.issuedAt, "issuedAt");
        if (ev.expiresAt === undefined) throw new LifecycleError("MISSING_FIELD", "expiresAt (date or explicit Unknown) is required for issuance", a.id);
        if (typeof ev.expiresAt === "string") parseTime(ev.expiresAt, "expiresAt");
        next = { ...next, issuedAt: ev.issuedAt, expiresAt: ev.expiresAt };
      } else if (ev.expiresAt !== undefined) {
        throw new LifecycleError("ILLEGAL_TRANSITION", `expiry can only be set on issuance; renewal is a new linked authorization`, a.id);
      }
      return put(s, "authorizations", a.id, next, ev);
    }
    case "condition_recorded": {
      const c = ev.condition;
      requireText(c.text, "condition text", c.id);
      requireText(c.responsibleParty, "responsibleParty", c.id);
      if (c.dueAt) parseTime(c.dueAt, "condition.dueAt");
      if (!c.dueAt && !c.trigger) throw new LifecycleError("MISSING_FIELD", "condition needs a due date or trigger", c.id);
      return create(s, "conditions", c.id, { ...c, status: "open", evidence: [], reviewer: null, waiver: null }, ev, "condition");
    }
    case "condition_status_changed": {
      const c = get(s.conditions, ev.conditionId, "condition");
      transition(CONDITION_TRANSITIONS, c.status, ev.status, "condition", c.id);
      if (ev.status === "evidence_submitted") requireEvidence(ev.evidence, "condition evidence submission", c.id);
      if (ev.status === "verified") requireAuthority(s, ev.actor, cfg.conditionReviewer, `verify condition ${c.id}`, c.id);
      return put(s, "conditions", c.id, { ...c, status: ev.status, evidence: [...new Set([...c.evidence, ...ev.evidence])], reviewer: ev.status === "verified" ? ev.actor : c.reviewer }, ev);
    }
    case "condition_waived": {
      const c = get(s.conditions, ev.conditionId, "condition");
      if (!hasAuthority(s, ev.actor, cfg.waiver) || !ev.reason || !ev.reason.trim()) {
        throw new LifecycleError("WAIVER_REQUIRES_APPROVER", `waiver of ${c.id} requires an authorized approver and a reason`, c.id);
      }
      requireEvidence(ev.evidence, "waiver", c.id);
      if (c.status === "closed" || c.status === "verified" || c.status === "waived_by_authority") {
        throw new LifecycleError("ILLEGAL_TRANSITION", `condition ${c.id} is ${c.status}; cannot waive`, c.id);
      }
      return put(s, "conditions", c.id, { ...c, status: "waived_by_authority", waiver: { approver: ev.actor, reason: ev.reason, evidence: [...ev.evidence], at: ev.at } }, ev);
    }
    case "condition_closed": {
      const c = get(s.conditions, ev.conditionId, "condition");
      transition(CONDITION_TRANSITIONS, c.status, "closed", "condition", c.id);
      return put(s, "conditions", c.id, { ...c, status: "closed" }, ev);
    }
    case "asset_registered": {
      const a = ev.asset;
      return create(s, "assets", a.id, { id: a.id, assetType: a.assetType, status: "candidate", custodian: null, baselineId: a.baselineId ?? null }, ev, "asset");
    }
    case "asset_custodian_assigned": {
      const a = get(s.assets, ev.assetId, "asset");
      requireText(ev.custodian, "custodian", a.id);
      return put(s, "assets", a.id, { ...a, custodian: ev.custodian }, ev);
    }
    case "asset_status_changed": {
      const a = get(s.assets, ev.assetId, "asset");
      transition(ASSET_TRANSITIONS, a.status, ev.status, "asset", a.id);
      return put(s, "assets", a.id, { ...a, status: ev.status }, ev);
    }
    case "ncr_raised": {
      const n = ev.ncr;
      requireText(n.description, "NCR description", n.id);
      return create(s, "ncrs", n.id, { id: n.id, severity: n.severity, description: n.description, owner: n.owner ?? null, status: "open", disposition: null, dispositionedBy: null, evidence: [...(n.evidence ?? [])] }, ev, "NCR");
    }
    case "ncr_status_changed": {
      const n = get(s.ncrs, ev.ncrId, "NCR");
      transition(NCR_TRANSITIONS, n.status, ev.status, "NCR", n.id);
      let next: Ncr = { ...n, status: ev.status, evidence: [...new Set([...n.evidence, ...(ev.evidence ?? [])])] };
      if (ev.status === "dispositioned") {
        requireAuthority(s, ev.actor, cfg.ncrDisposition, `disposition NCR ${n.id}`, n.id);
        requireText(ev.disposition, "disposition", n.id);
        next = { ...next, disposition: ev.disposition ?? null, dispositionedBy: ev.actor };
      }
      if (ev.status === "closed") {
        requireAuthority(s, ev.actor, cfg.ncrDisposition, `close NCR ${n.id}`, n.id);
        requireEvidence(ev.evidence, "NCR closure verification", n.id);
      }
      return put(s, "ncrs", n.id, next, ev);
    }
    case "test_result_recorded": {
      const r = ev.result;
      if (s.tests[r.id]) throw new LifecycleError("IMMUTABLE_RECORD", `test result ${r.id} already recorded; record a retest as a new result`, r.id);
      parseTime(r.executedAt, "test.executedAt");
      requireText(r.testId, "testId", r.id);
      if (r.outcome === "deferred" && (!r.deferral || !r.deferral.owner || !r.deferral.control)) {
        throw new LifecycleError("MISSING_FIELD", "deferred test requires risk owner, control, and review date", r.id);
      }
      if (r.deferral) parseTime(r.deferral.reviewAt, "deferral.reviewAt");
      if (r.reviewedBy !== null) requireAuthority(s, r.reviewedBy, cfg.testReviewer, `review test ${r.id}`, r.id);
      const chainHead = latestTestResults(s).get(r.testId);
      if (r.retestOf) {
        const prior = current(s.tests[r.retestOf]);
        if (!prior) throw new LifecycleError("RETEST_CHAIN", `retest ${r.id} references unknown result ${r.retestOf}`, r.id);
        if (prior.testId !== r.testId) throw new LifecycleError("RETEST_CHAIN", `retest ${r.id} is for ${r.testId}, prior is ${prior.testId}`, r.id);
        if (chainHead && chainHead.id !== prior.id) throw new LifecycleError("RETEST_CHAIN", `retest ${r.id} must reference latest result ${chainHead.id}`, r.id);
      } else if (chainHead) {
        throw new LifecycleError("RETEST_CHAIN", `test ${r.testId} already has result ${chainHead.id}; a new result must set retestOf`, r.id);
      }
      return create(s, "tests", r.id, { ...r, evidence: [...r.evidence] }, ev, "test result");
    }
    case "baseline_recorded": {
      const b = ev.baseline;
      if (s.baselines[b.id]) throw new LifecycleError("IMMUTABLE_BASELINE", `baseline ${b.id} is immutable; record a new baseline that supersedes it`, b.id);
      parseTime(b.createdAt, "baseline.createdAt");
      if (b.supersedes) get(s.baselines, b.supersedes, "baseline");
      return create(s, "baselines", b.id, { ...b, contentHash: stableHash(b.content) }, ev, "baseline");
    }
    case "linked_case_opened": {
      const l = ev.link;
      requireText(l.caseId, "linked caseId");
      requireText(l.reason, "linked case reason", l.caseId);
      if (l.fromBaselineId) get(s.baselines, l.fromBaselineId, "baseline");
      if (s.linkedCases.some((x) => x.record.caseId === l.caseId)) throw new LifecycleError("DUPLICATE_RECORD", `linked case ${l.caseId} already exists`, l.caseId);
      return { ...s, linkedCases: [...s.linkedCases, rev(s, ev, { ...l, at: ev.at })] };
    }
    case "supplier_registered": {
      const sp = ev.supplier;
      for (const l of sp.licenses) parseTime(l.expiresAt, "license.expiresAt");
      return put(s, "suppliers", sp.id, { ...sp, licenses: sp.licenses.map((l) => ({ ...l })) }, ev);
    }
    case "procurement_package_created": {
      const p = ev.package;
      return create(s, "packages", p.id, {
        id: p.id, scope: p.scope, requiredLicense: p.requiredLicense, approvals: [], award: null, executedEvidence: [],
        equipment: (p.equipment ?? []).map((e) => ({ ...e, substitutedBy: null })),
      }, ev, "procurement package");
    }
    case "procurement_approval_recorded": {
      const p = get(s.packages, ev.packageId, "procurement package");
      if (p.award) throw new LifecycleError("ILLEGAL_TRANSITION", `package ${p.id} already awarded`, p.id);
      requireText(ev.kind, "approval kind", p.id);
      return put(s, "packages", p.id, { ...p, approvals: [...p.approvals, { kind: ev.kind, by: ev.actor, at: ev.at }] }, ev);
    }
    case "procurement_awarded": {
      const p = get(s.packages, ev.packageId, "procurement package");
      requireAuthority(s, ev.actor, cfg.award, `award ${p.id}`, p.id);
      if (p.award) throw new LifecycleError("ILLEGAL_TRANSITION", `package ${p.id} already awarded`, p.id);
      const have = new Set(p.approvals.map((a) => a.kind));
      const missing = s.config.requiredAwardApprovals.filter((k) => !have.has(k));
      if (missing.length) throw new LifecycleError("AWARD_BEFORE_APPROVALS", `package ${p.id} missing approvals: ${missing.join(", ")}`, p.id);
      const sp = get(s.suppliers, ev.supplierId, "supplier");
      if (p.requiredLicense) {
        const req = p.requiredLicense;
        const match = sp.licenses.filter((l) => l.class === req.class && l.jurisdictionId === req.jurisdictionId);
        if (match.length === 0) throw new LifecycleError("LICENSE_MISMATCH", `supplier ${sp.id} holds no ${req.class} license in ${req.jurisdictionId}`, p.id);
        if (!match.some((l) => parseTime(l.expiresAt) > parseTime(ev.at))) throw new LifecycleError("LICENSE_EXPIRED", `supplier ${sp.id} ${req.class} license expired`, p.id);
      }
      return put(s, "packages", p.id, { ...p, award: { supplierId: sp.id, by: ev.actor, at: ev.at } }, ev);
    }
    case "contract_executed": {
      const p = get(s.packages, ev.packageId, "procurement package");
      if (!p.award) throw new LifecycleError("ILLEGAL_TRANSITION", `package ${p.id} has no award; award is not a signed contract and must precede execution`, p.id);
      requireEvidence(ev.evidence, "executed contract", p.id);
      return put(s, "packages", p.id, { ...p, executedEvidence: [...new Set([...p.executedEvidence, ...ev.evidence])] }, ev);
    }
    case "equipment_availability_changed": {
      const p = get(s.packages, ev.packageId, "procurement package");
      const idx = p.equipment.findIndex((e) => e.id === ev.equipmentId);
      if (idx < 0) throw new LifecycleError("UNKNOWN_RECORD", `equipment ${ev.equipmentId} not in package ${p.id}`, ev.equipmentId);
      const equipment = p.equipment.map((e, i) => (i === idx ? { ...e, availability: ev.availability, leadTimeDays: ev.leadTimeDays, evidence: [...new Set([...e.evidence, ...ev.evidence])] } : e));
      return put(s, "packages", p.id, { ...p, equipment }, ev);
    }
    case "equipment_substituted": {
      const p = get(s.packages, ev.packageId, "procurement package");
      requireAuthority(s, ev.actor, cfg.designAuthority, `approve substitution in ${p.id}`, p.id);
      get(s.suppliers, ev.supplierId, "supplier");
      const idx = p.equipment.findIndex((e) => e.id === ev.equipmentId);
      if (idx < 0) throw new LifecycleError("UNKNOWN_RECORD", `equipment ${ev.equipmentId} not in package ${p.id}`, ev.equipmentId);
      const equipment = p.equipment.map((e, i) => (i === idx ? { ...e, substitutedBy: { model: ev.model, supplierId: ev.supplierId, approvedBy: ev.actor } } : e));
      return put(s, "packages", p.id, { ...p, equipment }, ev);
    }
    case "gate_signoff": {
      requireAuthority(s, ev.actor, cfg.gateSignoff[ev.gate], `sign off ${ev.gate}`);
      requireEvidence(ev.evidence, `${ev.gate} sign-off`);
      return { ...s, signoffs: [...s.signoffs, rev(s, ev, { gate: ev.gate, by: ev.actor, at: ev.at, evidence: [...ev.evidence] })] };
    }
    case "procedure_step_completed": {
      requireText(ev.code, "procedure code");
      requireEvidence(ev.evidence, `procedure ${ev.code}`);
      return put(s, "procedures", ev.code, { code: ev.code, by: ev.actor, at: ev.at, evidence: [...ev.evidence] }, ev);
    }
    case "rule_evaluations_recorded": {
      let next = s;
      for (const e of ev.evaluations) next = put(next, "ruleEvaluations", evaluationKey(e), { ...e, missingInputs: [...e.missingInputs], evidence: [...e.evidence] }, ev);
      return next;
    }
  }
  // Exhaustiveness: unknown event types are rejected.
  const unknown = ev as { type?: string; id?: string };
  throw new LifecycleError("ILLEGAL_TRANSITION", `unknown event type ${String(unknown.type)}`, unknown.id);
}

export function submissionPackageHash(packageRevision: string, attachments: { name: string; sha256: string }[]): string {
  const sorted = [...attachments].map((a) => ({ name: a.name, sha256: a.sha256 })).sort((a, b) => a.name.localeCompare(b.name));
  return stableHash({ packageRevision, attachments: sorted });
}

/** Latest result per logical test id (follows the retest chain). */
export function latestTestResults(s: LifecycleState): Map<string, TestResult> {
  const out = new Map<string, TestResult>();
  const all = Object.values(s.tests).map((r) => r[0]).sort((a, b) => a.revision - b.revision);
  for (const r of all) out.set(r.record.testId, r.record);
  return out;
}

export function conditionEffectiveStatus(c: Condition, asOf: string): ConditionStatus {
  if ((c.status === "open" || c.status === "in_progress" || c.status === "disputed") && c.dueAt && parseTime(c.dueAt) < parseTime(asOf)) return "overdue";
  return c.status;
}

// ---------------------------------------------------------------------------
// Gate evaluation.

export interface GateBlocker { code: string; reason: string; recordId: string }
export interface GateEvaluation { gate: GateId; status: "pass" | "blocked" | "not_ready"; blockers: GateBlocker[]; missingInputs: string[]; asOf: string }
export interface EvaluateGateOptions {
  /** Procedure catalogue (from lib/owner/procedures.ts). Steps for this gate must be completed. */
  procedures?: ProcedureStep[];
}

export const GATE_STAGE: Record<GateId, StageId[]> = {
  M0: ["intake"], M1: ["feasibility"], M2: ["site_control"], M3: ["capital", "grants"], M4: ["permits", "engineering"],
  M5: ["procurement"], M6: ["construction"], M7: ["commissioning"], M8: ["operations"], M9: ["decommissioning"],
};

function latestDecision(s: LifecycleState, gate: GateId): DecisionRecord | undefined {
  const ds = currentAll(s.decisions).filter((d) => d.gate === gate);
  // Most recently revised decision for the gate wins (by revision of its latest entry).
  const withRev = ds.map((d) => ({ d, rev: s.decisions[d.id][s.decisions[d.id].length - 1].revision }));
  withRev.sort((a, b) => a.rev - b.rev);
  return withRev.length ? withRev[withRev.length - 1].d : undefined;
}

function authValid(a: Authorization, asOf: number): GateBlocker | null {
  if (a.external === "expired") return { code: "AUTHORIZATION_EXPIRED", reason: `${a.requirement} is expired; renewal is a new linked record`, recordId: a.id };
  if (a.external !== "issued") return { code: "AUTHORIZATION_NOT_ISSUED", reason: `${a.requirement} is "${a.external}"; issuance requires verified instrument evidence`, recordId: a.id };
  if (typeof a.expiresAt === "string") {
    if (parseTime(a.expiresAt) <= asOf) return { code: "AUTHORIZATION_EXPIRED", reason: `${a.requirement} expired at ${a.expiresAt}`, recordId: a.id };
    return null;
  }
  if (a.expiresAt.state === "not_applicable" && a.expiresAt.reason.trim()) return null;
  return { code: "EXPIRY_UNKNOWN", reason: `${a.requirement} expiry is unknown (${a.expiresAt.reason}); missing expiry is not perpetual`, recordId: a.id };
}

/** Authorizations that are the live record for their requirement (not superseded/renewed by a later record). */
function liveAuthorizations(s: LifecycleState): Authorization[] {
  const all = currentAll(s.authorizations);
  const replaced = new Set(all.flatMap((a) => [a.supersedes, a.renews]).filter((x): x is string => !!x));
  return all.filter((a) => !replaced.has(a.id));
}

function evidenceChecks(s: LifecycleState, ids: Iterable<string>, asOf: number, blockers: GateBlocker[], missing: string[]): void {
  const maxAge = s.config.evidenceMaxAgeDays;
  for (const id of [...new Set(ids)].sort()) {
    const e = current(s.evidence[id]);
    if (!e) { blockers.push({ code: "EVIDENCE_MISSING", reason: `referenced evidence ${id} is not recorded`, recordId: id }); continue; }
    if (e.freshness === "stale") { blockers.push({ code: "EVIDENCE_STALE", reason: `${e.title} is marked stale`, recordId: id }); continue; }
    if (maxAge !== undefined && parseTime(e.retrievedAt) + maxAge * DAY_MS < asOf) {
      blockers.push({ code: "EVIDENCE_STALE", reason: `${e.title} retrieved ${e.retrievedAt}, older than ${maxAge} days at evaluation`, recordId: id });
      continue;
    }
    if (e.freshness === "unknown") missing.push(`freshness of evidence ${id}`);
  }
}

/** activity × phase × jurisdiction, the combination PER-01 identifies instruments for. */
function comboKey(r: { activity: string; phase: string; jurisdictionId: string | null }): string {
  return `${r.activity} × ${r.phase} × ${r.jurisdictionId ?? "jurisdiction unknown"}`;
}

/**
 * M4 requirement-set completeness (PROCEDURES-AUTHORIZATIONS PER-01): the set is
 * only complete once PER-01 identification is recorded, and it must cover every
 * activity × phase × jurisdiction now in the set. A combination first recorded
 * after the latest PER-01 completion means scope changed and PER-01 must repeat.
 */
function per01Coverage(s: LifecycleState, auths: Authorization[], evals: RuleEvaluation[], ev: Set<string>, missing: string[]): void {
  const revs = s.procedures["PER-01"];
  const done = revs?.[revs.length - 1];
  if (!done) {
    missing.push("PER-01 authority and instrument identification (all instruments per activity × phase × jurisdiction)");
    return;
  }
  done.record.evidence.forEach((x) => ev.add(x));
  const firstSeen = new Map<string, number>();
  const see = (key: string, revision: number) => firstSeen.set(key, Math.min(firstSeen.get(key) ?? Infinity, revision));
  for (const revsOf of Object.values(s.authorizations)) see(comboKey(revsOf[revsOf.length - 1].record), revsOf[0].revision);
  for (const revsOf of Object.values(s.ruleEvaluations)) see(comboKey(revsOf[revsOf.length - 1].record), revsOf[0].revision);
  const present = [...new Set([...auths.map(comboKey), ...evals.map(comboKey)])].sort();
  for (const key of present) {
    if ((firstSeen.get(key) ?? 0) > done.revision) missing.push(`PER-01 re-identification for ${key} (first recorded after PER-01 completion at ${done.at})`);
  }
}

function signoff(s: LifecycleState, gate: GateId): GateSignoff | undefined {
  const xs = s.signoffs.filter((r) => r.record.gate === gate);
  return xs.length ? xs[xs.length - 1].record : undefined;
}

/**
 * Evaluate a gate's evidence readiness at `asOf`.
 * - blocked: at least one blocker (a recorded fact prevents the gate).
 * - not_ready: no blockers but required inputs are absent.
 * - pass: all configured conditions are evidenced. Not an external approval.
 */
export function evaluateGate(state: LifecycleState, gate: GateId, asOf: string, opts: EvaluateGateOptions = {}): GateEvaluation {
  const now = parseTime(asOf, "asOf");
  const blockers: GateBlocker[] = [];
  const missing: string[] = [];
  const ev = new Set<string>();
  const c = caseRecord(state);

  // Conditions that block this gate (any gate, not only M9).
  for (const cond of currentAll(state.conditions)) {
    if (!cond.blocksGates.includes(gate)) continue;
    const st = conditionEffectiveStatus(cond, asOf);
    if (st === "closed" || st === "verified" || st === "waived_by_authority") { cond.evidence.forEach((e) => ev.add(e)); continue; }
    blockers.push({ code: st === "overdue" ? "OBLIGATION_OVERDUE" : "OBLIGATION_OPEN", reason: `${cond.text} is ${st} (responsible: ${cond.responsibleParty})`, recordId: cond.id });
  }

  switch (gate) {
    case "M0": {
      if (!c.accepted) missing.push("intake acceptance by triage role");
      if (!c.owner) missing.push("accountable owner");
      if (!c.nextAction || !c.nextActionDate) missing.push("next action and date");
      if (c.sourceEvidence.length === 0) missing.push("source evidence");
      c.sourceEvidence.forEach((e) => ev.add(e));
      break;
    }
    case "M1": {
      const d = latestDecision(state, "M1");
      if (!d) { missing.push("M1 decision record"); break; }
      d.evidence.forEach((e) => ev.add(e));
      if (!d.signedBy) blockers.push({ code: "DECISION_UNSIGNED", reason: `decision ${d.id} v${d.version} has no authorized sign-off (a revision clears prior sign-off)`, recordId: d.id });
      if (d.outcome === "proceed") {
        if (!d.alternatives.some((a) => a.viable)) blockers.push({ code: "NO_VIABLE_ALTERNATIVE", reason: "proceed requires at least one viable alternative", recordId: d.id });
      } else if (d.outcome === "stop") {
        if (!d.rationale.trim()) blockers.push({ code: "NO_GO_UNDOCUMENTED", reason: "no-go requires rationale", recordId: d.id });
      } else {
        blockers.push({ code: "DECISION_NOT_FINAL", reason: `decision outcome is ${d.outcome}`, recordId: d.id });
      }
      break;
    }
    case "M2": {
      const recs = currentAll(state.land);
      if (recs.length === 0) { missing.push("parcel/route land records"); break; }
      const parcels = [...new Set(recs.map((r) => r.parcel))].sort();
      for (const parcel of parcels) {
        const forParcel = recs.filter((r) => r.parcel === parcel);
        const ok = forParcel.find((r) => (r.status === "accepted" && r.instrument === "executed") || r.status === "waived");
        if (ok) { ok.evidence.forEach((e) => ev.add(e)); continue; }
        const best = forParcel[forParcel.length - 1];
        blockers.push({ code: "RIGHTS_NOT_EVIDENCED", reason: `parcel ${parcel}: only ${forParcel.map((r) => `${r.instrument}/${r.status}`).join(", ")}; outreach or drafts never establish site control`, recordId: best.id });
      }
      break;
    }
    case "M3": {
      const budgets = currentAll(state.budgets);
      if (budgets.length === 0) { missing.push("approved budget"); break; }
      const budget = budgets[budgets.length - 1];
      const sources = currentAll(state.funding);
      if (sources.length === 0) missing.push("status-labeled funding sources");
      let committed = 0;
      for (const f of sources) {
        if (f.currency !== budget.currency) { blockers.push({ code: "INCOMPARABLE_CURRENCY", reason: `${f.id} in ${f.currency}, budget in ${budget.currency}`, recordId: f.id }); continue; }
        if (COMMITTED_FUNDING.includes(f.status)) { committed += f.amount; f.evidence.forEach((e) => ev.add(e)); }
      }
      const gap = budget.amount - committed;
      if (gap > 0 && !budget.residualGap) {
        const pending = sources.filter((f) => !COMMITTED_FUNDING.includes(f.status) && f.status !== "declined" && f.status !== "withdrawn").map((f) => `${f.id}:${f.status}`);
        blockers.push({ code: "FUNDING_GAP", reason: `committed ${committed} of ${budget.amount} ${budget.currency}; pending (not counted): ${pending.join(", ") || "none"}`, recordId: budget.id });
      }
      break;
    }
    case "M4": {
      // Every recorded rule evaluation must be resolved; indeterminate never defaults to not applicable.
      const evals = currentAll(state.ruleEvaluations);
      const auths = liveAuthorizations(state);
      const relevant = auths.filter((a) => a.requiredFor.includes("M4") || a.applicability !== "confirmed applicable");
      for (const e of evals) {
        const key = evaluationKey(e);
        if (e.result === "indeterminate") {
          const resolved = auths.find((a) => a.ruleId === e.ruleId && a.segmentId === e.segmentId && a.activity === e.activity && a.phase === e.phase && (a.applicability === "confirmed applicable" || a.applicability === "not applicable with rationale"));
          if (!resolved) blockers.push({ code: "APPLICABILITY_INDETERMINATE", reason: `${e.ruleId} on ${e.segmentId} (${e.jurisdictionId ?? "jurisdiction unknown"}) ${e.activity}/${e.phase}: missing ${e.missingInputs.join("; ")}`, recordId: key });
        } else if (e.result === "applies") {
          const tracked = auths.find((a) => a.ruleId === e.ruleId && a.segmentId === e.segmentId && a.activity === e.activity && a.phase === e.phase);
          if (!tracked) blockers.push({ code: "REQUIREMENT_UNTRACKED", reason: `${e.ruleId} screened as applicable on ${e.segmentId} ${e.activity}/${e.phase} but no authorization record`, recordId: key });
        }
        e.evidence.forEach((x) => ev.add(x));
      }
      if (evals.length === 0 && auths.length === 0) missing.push("permit/authorization requirement set");
      per01Coverage(state, auths, evals, ev, missing);
      for (const a of relevant) {
        switch (a.applicability) {
          case "not applicable with rationale":
            if (!a.reviewer || !a.applicabilityBasis) blockers.push({ code: "NOT_APPLICABLE_UNREVIEWED", reason: `${a.requirement} not applicable without reviewer/rationale`, recordId: a.id });
            break;
          case "confirmed applicable": {
            const b = authValid(a, now);
            if (b) blockers.push(b);
            a.instrumentEvidence.forEach((x) => ev.add(x));
            break;
          }
          case "superseded by change":
            blockers.push({ code: "APPLICABILITY_SUPERSEDED", reason: `${a.requirement} superseded by change and has no replacement record`, recordId: a.id });
            break;
          default:
            blockers.push({ code: "APPLICABILITY_UNRESOLVED", reason: `${a.requirement} (${a.activity}/${a.phase}/${a.jurisdictionId ?? "?"}) is "${a.applicability}"`, recordId: a.id });
        }
      }
      if (!currentAll(state.baselines).some((b) => b.kind === "design")) missing.push("approved design baseline");
      break;
    }
    case "M5": {
      const pkgs = currentAll(state.packages);
      if (pkgs.length === 0) missing.push("procurement packages");
      for (const p of pkgs) {
        if (!p.award) { blockers.push({ code: "NOT_AWARDED", reason: `package ${p.id} has no authorized award`, recordId: p.id }); continue; }
        if (p.executedEvidence.length === 0) blockers.push({ code: "CONTRACT_NOT_EXECUTED", reason: `package ${p.id} awarded but not executed; award is not a signed contract`, recordId: p.id });
        p.executedEvidence.forEach((x) => ev.add(x));
        const sp = current(state.suppliers[p.award.supplierId]);
        if (p.requiredLicense && sp) {
          const req = p.requiredLicense;
          const lic = sp.licenses.filter((l) => l.class === req.class && l.jurisdictionId === req.jurisdictionId);
          if (lic.length === 0) blockers.push({ code: "LICENSE_MISMATCH", reason: `${sp.name} lacks ${req.class} in ${req.jurisdictionId}`, recordId: p.id });
          else if (!lic.some((l) => parseTime(l.expiresAt) > now)) blockers.push({ code: "LICENSE_EXPIRED", reason: `${sp.name} ${req.class} license expired`, recordId: p.id });
          lic.forEach((l) => ev.add(l.evidenceId));
        }
        for (const e of p.equipment) {
          if (e.substitutedBy) continue;
          if (e.longLead && e.availability !== "available") blockers.push({ code: e.availability === "unavailable" ? "EQUIPMENT_UNAVAILABLE" : "EQUIPMENT_AVAILABILITY_UNKNOWN", reason: `${e.model} in ${p.id} is ${e.availability}; record an approved alternate or confirmed availability`, recordId: e.id });
          e.evidence.forEach((x) => ev.add(x));
        }
      }
      for (const a of liveAuthorizations(state)) {
        if (!a.requiredFor.includes("M5") || a.applicability !== "confirmed applicable") continue;
        const b = authValid(a, now);
        if (b) blockers.push(b);
      }
      break;
    }
    case "M6": {
      for (const n of currentAll(state.ncrs)) {
        if (n.status === "closed") { n.evidence.forEach((x) => ev.add(x)); continue; }
        if (n.severity === "critical") blockers.push({ code: "CRITICAL_NCR_OPEN", reason: `critical NCR ${n.id} is ${n.status}: ${n.description}`, recordId: n.id });
        else if (!n.owner) blockers.push({ code: "NCR_UNOWNED", reason: `NCR ${n.id} has no owner`, recordId: n.id });
      }
      for (const [testId, r] of latestTestResults(state)) {
        if (r.stage !== "construction" || !r.critical) continue;
        if (r.outcome !== "pass" || !r.reviewedBy) blockers.push({ code: "CRITICAL_TEST_NOT_PASSED", reason: `${testId} latest result ${r.id} is ${r.outcome}${r.reviewedBy ? "" : " (unreviewed)"}`, recordId: r.id });
        r.evidence.forEach((x) => ev.add(x));
      }
      for (const a of liveAuthorizations(state)) {
        if (!a.requiredFor.includes("M6") || a.applicability !== "confirmed applicable") continue;
        const b = authValid(a, now);
        if (b) blockers.push(b);
      }
      if (!signoff(state, "M6")) missing.push("M6 completion sign-off by authorized owner");
      break;
    }
    case "M7": {
      const latest = [...latestTestResults(state).values()].filter((r) => r.stage === "commissioning");
      if (latest.length === 0) missing.push("commissioning test results");
      for (const r of latest) {
        r.evidence.forEach((x) => ev.add(x));
        if (r.outcome === "deferred") blockers.push({ code: "TEST_DEFERRED", reason: `${r.testId} deferred (owner ${r.deferral?.owner ?? "?"}); deferred tests never count as passed`, recordId: r.id });
        else if (r.outcome === "fail") blockers.push({ code: "TEST_FAILED", reason: `${r.testId} failed (${r.id}); retest required as a new result`, recordId: r.id });
        else if (r.outcome !== "pass") blockers.push({ code: "TEST_NOT_PASSED", reason: `${r.testId} is ${r.outcome}`, recordId: r.id });
        else if (!r.reviewedBy) blockers.push({ code: "TEST_UNREVIEWED", reason: `${r.testId} pass is not reviewed by commissioning authority`, recordId: r.id });
      }
      const assets = currentAll(state.assets);
      if (assets.length === 0) missing.push("asset register");
      for (const a of assets) if (!a.custodian) blockers.push({ code: "NO_CUSTODIAN", reason: `asset ${a.id} has no named operational custodian`, recordId: a.id });
      if (!signoff(state, "M7")) missing.push("M7 commissioning acceptance sign-off");
      break;
    }
    case "M8": {
      const d = latestDecision(state, "M8");
      if (!d) { missing.push("M8 renewal/retirement decision"); break; }
      d.evidence.forEach((x) => ev.add(x));
      if (!d.signedBy) blockers.push({ code: "DECISION_UNSIGNED", reason: `decision ${d.id} v${d.version} unsigned`, recordId: d.id });
      if (d.outcome === "hold" || d.outcome === "unknown") blockers.push({ code: "DECISION_NOT_FINAL", reason: `decision outcome is ${d.outcome}`, recordId: d.id });
      if (d.kind === "renewal") {
        const link = state.linkedCases.map((r) => r.record).find((l) => l.relation === "renewal");
        if (!link) blockers.push({ code: "RENEWAL_CASE_MISSING", reason: "renewal decision requires a linked lifecycle case", recordId: d.id });
        else if (!link.fromBaselineId || !state.baselines[link.fromBaselineId]) blockers.push({ code: "RENEWAL_BASELINE_MISSING", reason: `renewal case ${link.caseId} must reference the prior baseline`, recordId: link.caseId });
      }
      // Stage 10/11: a retirement decision ends routine operations, but retirement is only
      // carried by a decommissioning case. Either a linked decommissioning case, or this case
      // documents its own closure path with a recorded RET-01 retirement assessment/approval.
      if (d.kind === "retirement" && d.outcome === "stop") {
        const link = state.linkedCases.map((r) => r.record).find((l) => l.relation === "decommissioning");
        const ret01 = current(state.procedures["RET-01"]);
        if (!link && ret01) ret01.evidence.forEach((x) => ev.add(x));
        else if (!link) blockers.push({ code: "DECOMMISSIONING_CASE_MISSING", reason: "retirement (stop) decision requires a linked decommissioning case or a recorded RET-01 retirement assessment documenting closure in this case", recordId: d.id });
      }
      break;
    }
    case "M9": {
      const assets = currentAll(state.assets);
      if (assets.length === 0) missing.push("asset register");
      for (const a of assets) if (a.status !== "retired" && a.status !== "transferred") blockers.push({ code: "ASSET_NOT_DISPOSITIONED", reason: `asset ${a.id} is ${a.status}; physical shutdown alone does not complete retirement`, recordId: a.id });
      for (const cond of currentAll(state.conditions)) {
        if (cond.blocksGates.includes("M9")) continue; // already evaluated above
        const st = conditionEffectiveStatus(cond, asOf);
        if (st === "closed" || st === "verified" || st === "waived_by_authority") { cond.evidence.forEach((e) => ev.add(e)); cond.waiver?.evidence.forEach((e) => ev.add(e)); continue; }
        blockers.push({ code: st === "overdue" ? "OBLIGATION_OVERDUE" : "OBLIGATION_OPEN", reason: `${cond.text} is ${st}; open obligation blocks closure unless waived by an authorized approver`, recordId: cond.id });
      }
      for (const a of liveAuthorizations(state)) {
        if (a.external === "issued" && a.applicability === "confirmed applicable") blockers.push({ code: "INSTRUMENT_NOT_CLOSED", reason: `${a.requirement} still issued; close, transfer, or surrender before archive`, recordId: a.id });
      }
      if (!signoff(state, "M9")) missing.push("M9 archive acceptance by records custodian");
      break;
    }
  }

  // Generic procedure-catalogue steps for this gate.
  for (const step of (opts.procedures ?? []).filter((p) => p.gate === gate).sort((a, b) => a.code.localeCompare(b.code))) {
    const done = current(state.procedures[step.code]);
    if (done) { done.evidence.forEach((x) => ev.add(x)); continue; }
    if (step.blocksGateOn && step.blocksGateOn.length) {
      blockers.push({ code: "PROCEDURE_INCOMPLETE", reason: `${step.code} ${step.title} not accepted (${step.blocksGateOn.join("; ")})`, recordId: step.code });
    } else {
      missing.push(`procedure ${step.code} ${step.title}`);
    }
  }

  const so = signoff(state, gate);
  so?.evidence.forEach((x) => ev.add(x));
  evidenceChecks(state, ev, now, blockers, missing);

  blockers.sort((a, b) => a.code.localeCompare(b.code) || a.recordId.localeCompare(b.recordId));
  const uniqMissing = [...new Set(missing)];
  return { gate, status: blockers.length ? "blocked" : uniqMissing.length ? "not_ready" : "pass", blockers, missingInputs: uniqMissing, asOf };
}

export const GATES: readonly GateId[] = ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9"];

export function evaluateAllGates(state: LifecycleState, asOf: string, opts: EvaluateGateOptions = {}): GateEvaluation[] {
  return GATES.map((g) => evaluateGate(state, g, asOf, opts));
}
