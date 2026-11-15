// Shared owner-plan contract. Other modules depend on these names; add fields
// or types freely, but do not rename or remove any.

export type Sector = "electric" | "water" | "wastewater" | "transport" | "telecom";
export type Provenance = "model" | "public_source" | "user_assertion" | "owner_verified" | "operator";
export interface Unknown { state: "unknown" | "not_assessed" | "not_applicable"; reason: string }
export type FactValue = number | string | boolean | Unknown;
export interface Fact { id: string; subject: string; predicate: string; value: FactValue; unit?: string; provenance: Provenance; evidence: string[]; asOf: string; supersedes?: string }
export interface EvidenceRef { publisher: string; url?: string; snapshot?: string; locator?: string; sha256?: string }
export interface Evidence { id: string; kind: "snapshot" | "document" | "observation" | "model_run" | "attestation"; title: string; source: EvidenceRef; retrievedAt: string; observedAt?: string; freshness: "fresh" | "stale" | "unknown"; provenance: Provenance }
export type StageId = "intake" | "feasibility" | "site_control" | "capital" | "grants" | "permits" | "engineering" | "procurement" | "construction" | "commissioning" | "operations" | "decommissioning";
export type GateId = "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8" | "M9";
export interface Finding { id: string; kind: "risk" | "sustainability" | "gap"; title: string; score?: number; factors?: Record<string, number>; evidence: string[]; detail: string }
export type OptionKind = "repair" | "operating_change" | "replacement" | "defer" | "do_nothing";
export interface PlanOption { id: string; kind: OptionKind; title: string; assumptions: Fact[]; addresses: string[]; tradeoffs: string }
export type TaskStatus = "not_started" | "in_progress" | "waiting" | "done" | "blocked";
export interface OwnerTask { id: string; code?: string; title: string; role: string; stage: StageId; gate?: GateId; dependsOn: string[]; offsetDays: number; durationDays: number; inputs: string[]; output: string; evidence: string[]; recovery: string; owner?: string; due?: string; status: TaskStatus }
export interface ProcedureStep {
  code: string; stage: StageId; gate?: GateId; title: string; role: string; inputs: string[]; preconditions: string[]; outputs: string[]; acceptance: string[]; recovery: string; blocksGateOn?: string[]; sourceDoc: string;
  /**
   * How the step affects its gate (absent = "required").
   * required: incomplete -> blocker (blocksGateOn) or missing input.
   * conditional: counts only while `trigger` is recorded active, then behaves as required.
   * non_gating: never affects a gate (lifelong/portfolio/post-gate work); listed separately.
   */
  gating?: "required" | "conditional" | "non_gating";
  /** Trigger rule id (lib/owner/procedures.ts RULE_IDS, kind "trigger"). Present iff gating is "conditional". */
  trigger?: string;
  /** Gate assigned by doc text instead of the stage default; `gate` equals this when set. */
  gateOverride?: GateId;
  /** Preconditions that apply only when `when` (a RULE_IDS trigger/branch id) holds. Not part of `preconditions`. */
  conditionalPreconditions?: { when: string; preconditions: string[] }[];
  /** Acceptance for later execution of the same procedure; recorded for traceability, never consulted by gates. */
  followUpAcceptance?: string[];
}
export interface PlanTarget { lat: number; lon: number; radius_miles: number; sector: Sector; label?: string }
export interface OwnerPlan { schema: "gridsentinel.owner-plan/1"; target: PlanTarget; scenario: "baseline" | "heatwave"; findings: Finding[]; options: PlanOption[]; selectedOption: string | null; tasks: OwnerTask[]; nextAction: string | null; waitingOn: string[]; deadlines: { taskId: string; due: string; kind: string }[]; facts: Fact[]; evidence: Evidence[]; inputsHash: string; outputHash: string }

// ---- Additive types (not part of the frozen names above) ----

/** Owner edits to one generated task, keyed by task id. Present fields override the generated value. */
export interface TaskEdit { title?: string; owner?: string; due?: string; status?: TaskStatus; evidence?: string[]; notes?: string }

/** A local draft for one plan. `planKey` scopes it to one target (see planKey() in ownerPlan.ts). */
export interface DraftEdits { planKey: string; tasks?: Record<string, TaskEdit>; selectedOption?: string | null; facts?: Fact[] }

/** How the draft was merged. Orphaned edits target tasks the current scenario/option did not generate; they are kept, not dropped. */
export interface DraftReport { planKey: string; applied: string[]; orphaned: { taskId: string; edit: TaskEdit }[]; rejected: string | null }

/** OwnerTask plus optional owner notes carried from a TaskEdit. */
export type OwnerTaskWithNotes = OwnerTask & { notes?: string };

/** OwnerPlan plus additive planner metadata. */
export interface OwnerPlanExtras { draft: DraftReport; nextTaskId: string | null; scheduleAnchor: string | null; scheduleMode: "back" | "forward" }

/** Helper: is a FactValue an explicit Unknown marker? */
export function isUnknown(v: FactValue | undefined | null): v is Unknown {
  return typeof v === "object" && v !== null && "state" in v && "reason" in v;
}
