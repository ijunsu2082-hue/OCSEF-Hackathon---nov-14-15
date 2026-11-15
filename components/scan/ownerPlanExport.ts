/**
 * Owner-plan exports and the pure glue the owner UI needs.
 *
 * PURE: no clock, no randomness, no DOM. Every timestamp comes from the plan's
 * `asOf` argument, so the same plan exports byte-identical files.
 *
 * - planJson / evidenceJson: the built plan and its evidence register.
 * - deadlinesIcs: RFC 5545 calendar (CRLF, 75-octet folding, TEXT escaping,
 *   all-day VALUE=DATE events, UID stable per planKey + task id + deadline kind).
 * - stagePackets: one prepared Markdown packet per lifecycle stage.
 * - draftToEdits / draftStoreFor: bridge lib/owner/draftStore drafts into
 *   buildOwnerPlan edits, stored under ownerPlan.draftStorageKey(target).
 * - lifecycleFromPlan: the event log the plan's task statuses can honestly
 *   support, replayed into a LifecycleState for evaluateGate.
 */

import { createDraftStore, type Draft, type DraftStore, type StorageAdapter } from "../../lib/owner/draftStore";
import { createLifecycle, replay, type LifecycleEvent, type LifecycleState, type TriggerState } from "../../lib/owner/lifecycle";
import { draftStorageKey, planKey, type BuiltOwnerPlan } from "../../lib/owner/ownerPlan";
import { STAGE_ORDER, TRIGGER_IDS } from "../../lib/owner/procedures";
import type { DraftEdits, Evidence, Fact, FactValue, PlanTarget, Provenance, StageId, TaskEdit } from "../../lib/owner/types";
import { isUnknown } from "../../lib/owner/types";

// ---------------------------------------------------------------- labels

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  model: "model",
  public_source: "public source",
  user_assertion: "user assertion",
  owner_verified: "owner verified",
  operator: "operator",
};

export const STAGE_LABEL: Record<StageId, string> = {
  intake: "Intake",
  feasibility: "Feasibility",
  site_control: "Site control",
  capital: "Capital",
  grants: "Grants",
  permits: "Permits",
  engineering: "Engineering",
  procurement: "Procurement",
  construction: "Construction",
  commissioning: "Commissioning",
  operations: "Operations",
  decommissioning: "Decommissioning",
};

/** Human text for a fact value. Unknowns always carry their reason; never blank. */
export function factValueText(v: FactValue, unit?: string): string {
  if (isUnknown(v)) return `${v.state.replace(/_/g, " ")}: ${v.reason.trim() || "no reason recorded"}`;
  if (typeof v === "boolean") return v ? "yes" : "no";
  const s = String(v);
  if (s.trim() === "") return "unknown: empty value recorded";
  return unit ? `${s} ${unit}` : s;
}

/** "milestone:M1" -> "Milestone M1"; "late_start" -> "Late start"; "owner_due" -> "Owner due date". */
export function deadlineKindLabel(kind: string): string {
  if (kind === "late_start") return "Late start";
  if (kind === "owner_due") return "Owner due date";
  const m = /^milestone:([^:]+)(?::(info|unmapped))?$/.exec(kind);
  if (m) return `Milestone ${m[1]}${m[2] === "info" ? " (informational)" : m[2] === "unmapped" ? " (no task mapped)" : ""}`;
  return kind;
}

// ---------------------------------------------------------------- JSON exports

export function planJson(plan: BuiltOwnerPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function evidenceJson(plan: BuiltOwnerPlan, asOf: string): string {
  const usedBy: Record<string, string[]> = {};
  const note = (id: string, by: string) => { (usedBy[id] ??= []).push(by); };
  for (const f of plan.findings) for (const e of f.evidence) note(e, f.id);
  for (const f of plan.facts) for (const e of f.evidence) note(e, f.id);
  for (const id of Object.keys(usedBy)) usedBy[id] = [...new Set(usedBy[id])].sort();
  const body = {
    schema: "gridsentinel.owner-evidence/1",
    planKey: planKey(plan.target),
    asOf,
    outputHash: plan.outputHash,
    evidence: plan.evidence,
    facts: plan.facts,
    referencedBy: Object.fromEntries(Object.keys(usedBy).sort().map((k) => [k, usedBy[k]])),
    unregistered: Object.keys(usedBy).filter((id) => !plan.evidence.some((e) => e.id === id)).sort(),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

// ---------------------------------------------------------------- ICS (RFC 5545)

/** RFC 5545 3.3.11 TEXT escaping: backslash, semicolon, comma, newline. */
export function icsEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function utf8Len(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * RFC 5545 3.1 folding: no line longer than 75 octets (excluding CRLF);
 * continuation lines start with one space. Never splits a UTF-8 sequence.
 */
export function icsFold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const ch of line) {
    const len = utf8Len(ch);
    // The continuation line's leading space counts toward its 75 octets.
    if (curLen + len > 75) {
      out.push(cur);
      cur = " ";
      curLen = 1;
    }
    cur += ch;
    curLen += len;
  }
  out.push(cur);
  return out.join("\r\n");
}

function icsDate(isoDay: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDay);
  if (!m) throw new Error(`ownerPlanExport: not an ISO date: ${isoDay}`);
  return `${m[1]}${m[2]}${m[3]}`;
}

function icsNextDate(isoDay: string): string {
  const d = new Date(`${isoDay.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return icsDate(d.toISOString());
}

/** asOf ISO timestamp -> UTC DATE-TIME form (YYYYMMDDTHHMMSSZ). */
export function icsStamp(asOf: string): string {
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) throw new Error(`ownerPlanExport: asOf is not an ISO time: ${asOf}`);
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/** Stable UID. Readable, restricted to [A-Za-z0-9._-], unique per planKey + task + deadline kind. */
export function icsUid(key: string, taskId: string, kind: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${clean(taskId)}.${clean(kind)}.${clean(key)}@gridsentinel`;
}

export function deadlinesIcs(plan: BuiltOwnerPlan, asOf: string): string {
  const key = planKey(plan.target);
  const stamp = icsStamp(asOf);
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const label = plan.target.label ?? key;
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GridSentinel//Owner Plan//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(`Owner plan deadlines, ${label}`)}`,
  ];
  for (const d of plan.deadlines) {
    const t = byId.get(d.taskId);
    const kind = deadlineKindLabel(d.kind);
    const summary = t ? `${kind}: ${t.title}` : `${kind}: ${d.taskId}`;
    const who = t ? (t.owner ? `Owner: ${t.owner}` : `Role: ${t.role} (owner not assigned)`) : "No task mapped";
    const desc = [
      who,
      t ? `Stage: ${STAGE_LABEL[t.stage]}${t.code ? `, procedure ${t.code}` : ""}` : null,
      t ? `Status: ${t.status.replace(/_/g, " ")}` : null,
      t ? `Deliverable: ${t.output}` : null,
      `Scenario: ${plan.scenario}; plan ${key}; as of ${asOf}`,
    ].filter((x): x is string => x !== null).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsUid(key, d.taskId, d.kind)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(d.due)}`,
      `DTEND;VALUE=DATE:${icsNextDate(d.due)}`,
      `SUMMARY:${icsEscape(summary)}`,
      `DESCRIPTION:${icsEscape(desc)}`,
      `CATEGORIES:${icsEscape(d.kind.split(":")[0])}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(icsFold).join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------- Markdown packets

const mdCell = (s: string) => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim() || "-";

function evidenceLine(e: Evidence): string {
  return `- \`${e.id}\` ${e.title} (${PROVENANCE_LABEL[e.provenance]}, ${e.kind}, ${e.freshness}; ${e.source.publisher}${e.source.url ? `, ${e.source.url}` : ""}; retrieved ${e.retrievedAt})`;
}

function factLine(f: Fact): string {
  return `- \`${f.id}\` ${f.predicate.replace(/_/g, " ")} = ${factValueText(f.value, f.unit)} (${PROVENANCE_LABEL[f.provenance]}${f.supersedes ? `; supersedes \`${f.supersedes}\`` : ""})`;
}

export interface StagePacket { stage: StageId; filename: string; markdown: string }

/** One prepared packet per stage with tasks, in lifecycle order. Facts and evidence are linked by id, not retyped. */
export function stagePackets(plan: BuiltOwnerPlan, asOf: string): StagePacket[] {
  const key = planKey(plan.target);
  const label = plan.target.label ?? key;
  const evById = new Map(plan.evidence.map((e) => [e.id, e]));
  const titleOf = new Map(plan.tasks.map((t) => [t.id, t.title]));
  const option = plan.options.find((o) => o.id === plan.selectedOption) ?? null;
  const safeKey = key.replace(/[^A-Za-z0-9._-]+/g, "_");
  const out: StagePacket[] = [];
  for (const stage of STAGE_ORDER) {
    const tasks = plan.tasks.filter((t) => t.stage === stage);
    if (!tasks.length) continue;
    const evIds = [...new Set(tasks.flatMap((t) => t.evidence.filter((x) => evById.has(x))))].sort();
    const md: string[] = [
      `# ${STAGE_LABEL[stage]} packet: ${label}`,
      "",
      `- Plan: \`${key}\` (scenario ${plan.scenario}, as of ${asOf})`,
      `- Selected option: ${option ? `${option.title} (\`${option.id}\`)` : "none selected"}`,
      `- Next action: ${plan.nextAction ?? "none (no ready task)"}`,
      `- Plan output hash: \`${plan.outputHash}\``,
      "",
      "This packet organizes work. It does not record any approval, award, permit issuance, or eligibility decision.",
      "",
      "## Tasks",
      "",
      "| Task | Procedure | Owner | Due | Status | Depends on |",
      "| --- | --- | --- | --- | --- | --- |",
      ...tasks.map((t) => `| ${mdCell(t.title)} | ${mdCell(t.code ?? "")} | ${mdCell(t.owner ?? `${t.role} (unassigned)`)} | ${mdCell(t.due ?? "")} | ${mdCell(t.status.replace(/_/g, " "))} | ${mdCell(t.dependsOn.map((d) => titleOf.get(d) ?? d).join("; "))} |`),
      "",
    ];
    for (const t of tasks) {
      md.push(`### ${t.title}`, "", `- Deliverable: ${t.output}`, `- Inputs: ${t.inputs.join("; ") || "none listed"}`);
      md.push(`- Acceptance evidence: ${t.evidence.join("; ") || "none listed"}`, `- Recovery: ${t.recovery}`);
      if (t.notes) md.push(`- Owner notes: ${t.notes.replace(/\r?\n/g, " ")}`);
      md.push("");
    }
    md.push("## Linked facts", "", ...(plan.facts.length ? plan.facts.map(factLine) : ["- none recorded"]), "");
    md.push("## Linked evidence", "", ...(evIds.length ? evIds.map((id) => evidenceLine(evById.get(id)!)) : plan.evidence.length ? plan.evidence.map(evidenceLine) : ["- none recorded"]), "");
    out.push({ stage, filename: `owner-packet-${safeKey}-${stage}.md`, markdown: `${md.join("\n")}\n` });
  }
  return out;
}

// ---------------------------------------------------------------- drafts

/** Draft (lib/owner/draftStore) -> buildOwnerPlan edits. selectedOption is only sent once the owner picked one. */
export function draftToEdits(draft: Draft, target: PlanTarget): DraftEdits {
  const tasks: Record<string, TaskEdit> = {};
  for (const id of Object.keys(draft.edits).sort()) {
    const e = draft.edits[id];
    const t: TaskEdit = {};
    if (e.owner !== undefined) t.owner = e.owner;
    if (e.due !== undefined) t.due = e.due;
    if (e.status !== undefined) t.status = e.status;
    if (e.notes !== undefined) t.notes = e.notes;
    tasks[id] = t;
  }
  return { planKey: planKey(target), tasks, ...(draft.selectedOption !== null ? { selectedOption: draft.selectedOption } : {}) };
}

/** A draftStore whose single slot is ownerPlan.draftStorageKey(target). load/save keep draftStore's schema and key checks. */
export function draftStoreFor(adapter: StorageAdapter, target: PlanTarget): { store: DraftStore; storageKey: string } {
  const storageKey = draftStorageKey(target);
  const slot: StorageAdapter = {
    getItem: () => adapter.getItem(storageKey),
    setItem: (_k, v) => adapter.setItem(storageKey, v),
    removeItem: () => adapter.removeItem(storageKey),
  };
  return { store: createDraftStore(slot), storageKey };
}

export const draftLocation = (target: PlanTarget) => ({ lat: target.lat, lon: target.lon, radius: target.radius_miles, sector: target.sector });

// ---------------------------------------------------------------- lifecycle

export interface LifecycleMapping {
  state: LifecycleState | null;
  events: LifecycleEvent[];
  /** Procedure codes credited complete (every plan task with the code marked done). */
  credited: string[];
  /** Codes with some but not all plan tasks done; not credited. */
  partial: string[];
  /** What the plan cannot supply; those gate inputs stay missing. */
  notMapped: string[];
  /** Every trigger rule id with the state the plan supports. "not_evaluated" unless a plan fact says so. */
  triggers: { trigger: string; state: TriggerState; basis: string }[];
  error: string | null;
}

const NOT_MAPPED = [
  "intake acceptance (needs a configured triage role)",
  "gate decisions and signoffs (need configured decision authority)",
  "authorizations, submissions, conditions, funding, budgets, land, procurement, tests, assets (no plan record)",
  "trigger evaluations, except plan facts whose predicate is a trigger id with a yes/no value (unevaluated triggers are treated as not active)",
];

/**
 * Trigger state the plan supports: a non-superseded plan fact whose predicate is the trigger id and whose
 * value is boolean. Conflicting or Unknown values, or no fact, leave the trigger not evaluated.
 */
function planTriggers(plan: BuiltOwnerPlan): { trigger: string; state: TriggerState; basis: string; fact: Fact | null }[] {
  const superseded = new Set(plan.facts.map((f) => f.supersedes).filter((x): x is string => !!x));
  return TRIGGER_IDS.map((trigger) => {
    const fs = plan.facts.filter((f) => f.predicate === trigger && !superseded.has(f.id));
    if (fs.length === 0) return { trigger, state: "not_evaluated" as const, basis: "no plan fact", fact: null };
    const values = [...new Set(fs.map((f) => f.value))];
    if (values.length !== 1 || typeof values[0] !== "boolean") {
      return { trigger, state: "not_evaluated" as const, basis: `plan facts ${fs.map((f) => f.id).join(", ")} are ${values.length > 1 ? "conflicting" : factValueText(values[0])}`, fact: null };
    }
    const f = fs[0];
    return { trigger, state: values[0] ? ("active" as const) : ("not_active" as const), basis: `plan fact ${f.id} (${PROVENANCE_LABEL[f.provenance]}): ${factValueText(f.value)}`, fact: f };
  });
}

/**
 * Event log the plan supports, in order, all at `asOf`:
 * 1. evidence_recorded for each plan evidence item;
 * 2. next_action_set from the plan's next action (no authority needed);
 * 3. trigger_evaluated only for triggers a plan fact decides (planTriggers); all
 *    other triggers stay not evaluated, which the gates treat as not active;
 * 4. per procedure code whose plan tasks are all "done": an attestation evidence
 *    (provenance user_assertion) then procedure_step_completed citing it.
 * Nothing else is inferred, so gates needing decisions, signoffs or external
 * records stay not_ready with their missing inputs.
 */
export function lifecycleFromPlan(plan: BuiltOwnerPlan, asOf: string): LifecycleMapping {
  const key = planKey(plan.target);
  const events: LifecycleEvent[] = [];
  let n = 0;
  const id = (what: string) => `ev.${String(++n).padStart(3, "0")}.${what}`;
  const actor = "owner-plan";
  for (const e of plan.evidence) events.push({ id: id(`evidence.${e.id}`), at: asOf, actor, type: "evidence_recorded", evidence: e });
  const next = plan.tasks.find((t) => t.id === plan.nextTaskId);
  if (plan.nextAction && next?.due) {
    events.push({ id: id("next_action"), at: asOf, actor, type: "next_action_set", nextAction: plan.nextAction, nextActionDate: `${next.due.slice(0, 10)}T00:00:00Z` });
  }
  const triggers = planTriggers(plan);
  for (const t of triggers) {
    if (!t.fact) continue;
    events.push({ id: id(`trigger.${t.trigger}`), at: asOf, actor, type: "trigger_evaluated", trigger: t.trigger, active: t.state === "active", basis: t.basis, evidence: [...t.fact.evidence] });
  }
  const triggerSummary = triggers.map(({ trigger, state, basis }) => ({ trigger, state, basis }));
  const byCode = new Map<string, typeof plan.tasks>();
  for (const t of plan.tasks) if (t.code) byCode.set(t.code, [...(byCode.get(t.code) ?? []), t]);
  const credited: string[] = [];
  const partial: string[] = [];
  for (const code of [...byCode.keys()].sort()) {
    const ts = byCode.get(code)!;
    const done = ts.filter((t) => t.status === "done");
    if (done.length === 0) continue;
    if (done.length < ts.length) { partial.push(code); continue; }
    const evId = `e.attest.${code}`;
    const owners = [...new Set(ts.map((t) => t.owner ?? t.role))].join(", ");
    events.push({
      id: id(`attest.${code}`), at: asOf, actor, type: "evidence_recorded",
      evidence: { id: evId, kind: "attestation", title: `Owner marked ${code} done in plan ${key} (${owners})`, source: { publisher: "Owner plan draft (user assertion)" }, retrievedAt: asOf, freshness: "fresh", provenance: "user_assertion" },
    });
    events.push({ id: id(`procedure.${code}`), at: asOf, actor: ts[0].owner ?? actor, type: "procedure_step_completed", code, evidence: [evId] });
    credited.push(code);
  }
  const initial = createLifecycle({
    caseId: key, title: plan.target.label ?? key, sector: plan.target.sector,
    config: { roles: {}, authority: { triage: [], decision: [], applicabilityReviewer: [], instrumentVerifier: [], landRights: [], budget: [], submission: [], award: [], waiver: [], conditionReviewer: [], designAuthority: [], ncrDisposition: [], testReviewer: [], gateSignoff: {} }, requiredAwardApprovals: [] },
  });
  try {
    return { state: replay(initial, events), events, credited, partial, notMapped: NOT_MAPPED, triggers: triggerSummary, error: null };
  } catch (err) {
    return { state: null, events, credited, partial, notMapped: NOT_MAPPED, triggers: triggerSummary, error: err instanceof Error ? err.message : String(err) };
  }
}
