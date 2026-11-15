/**
 * Owner lifecycle verification harness.
 *
 * Runs the acceptance scenarios from docs/INFRASTRUCTURE-IMPLEMENTATION-HANDOFF.md
 * against lib/owner/{lifecycle,rules,schedule,draftStore}.ts and prints PASS/FAIL
 * per scenario. Exits 1 on any failure. Run with:
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-owner-lifecycle.ts
 */

import assert from "node:assert/strict";
import {
  GATES, LifecycleError, applyEvent, createLifecycle, current, evaluateGate, replay, stateHash, triggerStatus,
  type GateEvaluation, type LifecycleConfig, type LifecycleEvent, type LifecycleState,
} from "../lib/owner/lifecycle";
import { PROCEDURES, TRIGGER_IDS, gatingOf } from "../lib/owner/procedures";
import { LIVENESS_CASE_IDS, completedLifecycleCase } from "../lib/owner/fixtures";
import { evaluateRules, segmentRouteByJurisdiction, type RulePack } from "../lib/owner/rulePacks";
import { applyDisruption, backSchedule, createScheduleBaseline, isoDay, reforecast, schedule, type SchedTask } from "../lib/owner/schedule";
import { createDraftStore, draftKey, emptyDraft, memoryStorage, mergeDraft, setTaskEdit } from "../lib/owner/draftStore";
import type { GateId, OwnerTask } from "../lib/owner/planTypes";

type Payload = LifecycleEvent extends infer E ? (E extends LifecycleEvent ? Omit<E, "id" | "at" | "actor"> : never) : never;
const T = (d: string) => `${d}T12:00:00Z`;

const CONFIG: LifecycleConfig = {
  roles: { triage: ["triage"], sponsor: ["investment"], compliance: ["compliance"], verifier: ["permit_verifier"], contracting: ["contracting"], design: ["design_authority"], cx: ["cx_authority"], waiverAuth: ["waiver"], custodian: ["records"], ownerRep: ["owner_rep"], analyst: [] },
  authority: {
    triage: ["triage"], decision: ["investment"], applicabilityReviewer: ["compliance"], instrumentVerifier: ["permit_verifier"], landRights: ["compliance"],
    budget: ["investment"], submission: ["investment"], award: ["contracting"], waiver: ["waiver"], conditionReviewer: ["compliance"],
    designAuthority: ["design_authority"], ncrDisposition: ["compliance"], testReviewer: ["cx_authority"], gateSignoff: { M6: ["owner_rep"], M7: ["cx_authority"], M9: ["records"] },
  },
  requiredAwardApprovals: ["technical", "finance", "legal"],
  evidenceMaxAgeDays: 180,
};

class Case {
  s: LifecycleState;
  n = 0;
  constructor(id: string) { this.s = createLifecycle({ caseId: id, title: id, sector: "electric", config: CONFIG }); }
  do(actor: string, at: string, p: Payload): this { this.s = applyEvent(this.s, { ...(p as object), id: `e${++this.n}`, at, actor } as LifecycleEvent); return this; }
  reject(actor: string, at: string, p: Payload): string {
    try { applyEvent(this.s, { ...(p as object), id: `x${this.n + 1}`, at, actor } as LifecycleEvent); } catch (e) { if (e instanceof LifecycleError) return e.code; throw e; }
    return "ACCEPTED";
  }
  ev(id: string, at: string, freshness: "fresh" | "stale" = "fresh"): this {
    return this.do("analyst", at, { type: "evidence_recorded", evidence: { id, kind: "document", title: id, source: { publisher: "synthetic" }, retrievedAt: at, freshness, provenance: "owner_verified" } });
  }
  gate(g: GateId, asOf: string): GateEvaluation { return evaluateGate(this.s, g, asOf); }
}
const codes = (g: GateEvaluation) => g.blockers.map((b) => b.code).join(",");
const day = (iso: string) => isoDay(iso);

const MICROGRID: SchedTask[] = [
  ["load_audit", 30, []], ["geotech_fire", 45, ["load_audit"]], ["utility_preapp", 45, ["geotech_fire"]], ["funding_award", 47, ["utility_preapp"]],
  ["design_package", 61, ["funding_award"]], ["permits_utility_agreement", 61, ["design_package"]], ["equipment_delivery", 152, ["permits_utility_agreement"]],
  ["energization", 92, ["equipment_delivery"]], ["acceptance_exercise", 14, ["energization"]], ["grant_application", 20, ["utility_preapp"]], ["om_plan", 60, ["design_package"]],
].map(([id, durationDays, dependsOn]) => ({ id: id as string, durationDays: durationDays as number, dependsOn: dependsOn as string[], offsetDays: 0 }));
const SLIP = { id: "swgr", taskId: "equipment_delivery", delayDays: 112, reason: "switchgear +16 weeks", at: T("2028-05-01") };

const PROCS = [...PROCEDURES];
const gateOf = (s: LifecycleState, g: GateId, asOf: string) => evaluateGate(s, g, asOf, { procedures: PROCS });

/** Per-gate "can pass": replay the completed log batch by batch and evaluate each gate when its batch lands. */
function livenessScenario(id: (typeof LIVENESS_CASE_IDS)[number]) {
  return {
    name: `liveness ${id}: fully completed log (required steps only, no trigger active) passes M0..M9 in order`,
    run: () => {
      const c = completedLifecycleCase(id);
      let s = c.initial;
      const out: string[] = [];
      for (const b of c.batches) {
        s = replay(s, b.events);
        const g = gateOf(s, b.gate, b.asOf);
        assert.equal(g.status, "pass", `${b.gate} ${g.status}: ${[...g.blockers.map((x) => `${x.code}:${x.recordId}`), ...g.missingInputs].join("; ")}`);
        out.push(`${b.gate} ${b.asOf.slice(0, 10)} pass (${b.completedCodes.length} steps${g.warnings.length ? `, ${g.warnings.length} warning` : ""})`);
      }
      assert.ok(TRIGGER_IDS.every((t) => triggerStatus(s, t) !== "active"));
      return out.join("; ");
    },
  };
}

function partialScenario(id: (typeof LIVENESS_CASE_IDS)[number]) {
  return {
    name: `partial ${id}: each gate stays blocked/not ready, naming every withheld required step`,
    run: () => {
      const c = completedLifecycleCase(id);
      let before = c.initial;
      const out: string[] = [];
      for (const b of c.batches) {
        const none = gateOf(before, b.gate, b.asOf);
        assert.notEqual(none.status, "pass");
        const withheld = replay(before, b.events.filter((e) => e.type !== "procedure_step_completed"));
        const g = gateOf(withheld, b.gate, b.asOf);
        const required = PROCEDURES.filter((p) => p.gate === b.gate && gatingOf(p) === "required" && !current(before.procedures[p.code]));
        assert.notEqual(g.status, "pass");
        const unnamed = required.filter((p) => !g.blockers.some((x) => x.recordId === p.code) && !g.missingInputs.some((m) => m.startsWith(`procedure ${p.code} `)));
        assert.deepEqual(unnamed.map((p) => p.code), []);
        out.push(`${b.gate} ${none.status}->${g.status} (${g.blockers.length}b/${g.missingInputs.length}m)`);
        before = replay(before, b.events);
      }
      return `[no records -> domain records without procedures] ${out.join(" ")}`;
    },
  };
}

const scenarios: { name: string; run: () => string }[] = [
  ...LIVENESS_CASE_IDS.flatMap((id) => [livenessScenario(id), partialScenario(id)]),
  {
    name: "conditional steps: each trigger, once active, holds its gate until that procedure completes after the activation",
    run: () => {
      const c = completedLifecycleCase("microgrid");
      const out: string[] = [];
      for (const st of PROCEDURES.filter((p) => gatingOf(p) === "conditional")) {
        let s = c.initial;
        let asOf = "";
        for (const b of c.batches) { s = replay(s, b.events); asOf = b.asOf; if (b.gate === st.gate) break; }
        let k = 0;
        const ev = (body: Payload): LifecycleEvent => ({ ...(body as object), id: `v.${st.code}.${++k}`, at: asOf, actor: "ownerRep" } as LifecycleEvent);
        s = applyEvent(s, ev({ type: "trigger_evaluated", trigger: st.trigger!, active: true, basis: "verification", evidence: [] }));
        const held = gateOf(s, st.gate!, asOf);
        assert.notEqual(held.status, "pass");
        s = applyEvent(s, ev({ type: "evidence_recorded", evidence: { id: `ev.v.${st.code}`, kind: "document", title: st.code, source: { publisher: "synthetic" }, retrievedAt: asOf, freshness: "fresh", provenance: "owner_verified" } }));
        s = applyEvent(s, ev({ type: "procedure_step_completed", code: st.code, evidence: [`ev.v.${st.code}`] }));
        const after = gateOf(s, st.gate!, asOf);
        assert.equal(after.status, "pass");
        out.push(`${st.code}@${st.gate} ${held.status}->pass`);
      }
      return out.join("; ");
    },
  },
  {
    name: "non-gating steps never affect a gate; DEV-18 unverified fallback is an at-risk warning only",
    run: () => {
      const c = completedLifecycleCase("substation");
      const nonGating = PROCEDURES.filter((p) => gatingOf(p) === "non_gating").map((p) => p.code);
      let s = c.initial;
      let warned = "";
      for (const b of c.batches) {
        s = replay(s, b.events);
        const g = gateOf(s, b.gate, b.asOf);
        for (const code of nonGating) assert.ok(!g.blockers.some((x) => x.recordId === code) && !g.missingInputs.some((m) => m.includes(code)), `${code} at ${b.gate}`);
        if (g.warnings.length) warned = `${b.gate}: ${g.warnings.join("; ")}`;
      }
      assert.ok(nonGating.every((code) => !current(s.procedures[code])), "non-gating steps were never completed");
      assert.match(warned, /^M4: DEV-18 /);
      return `${nonGating.length} non-gating steps (${nonGating.join(", ")}) never completed, never listed; ${warned}`;
    },
  },
  {
    name: "period shift (microgrid switchgear +16 wk: energization Jun 1 → Sep 21, acceptance Jun 15 → Oct 5, dependents only)",
    run: () => {
      const i = applyDisruption(MICROGRID, { targetFinish: T("2028-06-15") }, SLIP);
      const ef = Object.fromEntries(i.after.tasks.map((t) => [t.id, day(t.earlyFinish)]));
      assert.equal(ef.energization, "2028-09-21");
      assert.equal(ef.acceptance_exercise, "2028-10-05");
      assert.ok(i.dependentsOnly);
      return `energization ${ef.energization}, acceptance ${ef.acceptance_exercise}, moved=[${i.moved.map((m) => `${m.taskId}+${m.finishShiftDays}d`).join(" ")}]`;
    },
  },
  {
    name: "grant miss (deadline before application can finish)",
    run: () => {
      const r = backSchedule(MICROGRID, T("2028-06-15"), { windows: [{ id: "grant", kind: "grant_deadline", taskId: "grant_application", deadline: T("2027-04-30") }] });
      assert.equal(r.flags[0]?.code, "MISSED_WINDOW");
      return r.flags[0].reason;
    },
  },
  {
    name: "permit unknown (indeterminate applicability blocks M4)",
    run: () => {
      const route = { id: "feeder", vertices: [[-118.08, 33.75], [-117.92, 33.75]] as [number, number][] };
      const areas = [{ id: "county-a", ring: [[-118.1, 33.7], [-118.0, 33.7], [-118.0, 33.8], [-118.1, 33.8]] as [number, number][] }, { id: "county-b", ring: [[-118.0, 33.7], [-117.9, 33.7], [-117.9, 33.8], [-118.0, 33.8]] as [number, number][] }];
      const pack: RulePack = { id: "pk-a", jurisdictionId: "county-a", domain: "row", version: "1", effectiveFrom: T("2026-01-01"), effectiveTo: null, status: "active", reviewedBy: "compliance", rules: [{ id: "row", requirement: "ROW encroachment", when: [{ input: "trench_in_public_row", op: "eq", value: true }], sourceIds: [], effectiveFrom: T("2026-01-01"), effectiveTo: null }] };
      const segs = segmentRouteByJurisdiction(route, areas, ["trenching"], "construction");
      const out = evaluateRules({ projectId: "p", segments: segs, packs: [pack], facts: [], domains: ["row"], effectiveDate: T("2027-07-01") });
      assert.equal(out.evaluations.length, 2);
      assert.ok(out.evaluations.every((e) => e.result === "indeterminate"));
      const c = new Case("p").do("compliance", T("2027-07-01"), { type: "rule_evaluations_recorded", evaluations: out.evaluations });
      const g = c.gate("M4", T("2027-07-02"));
      assert.equal(g.status, "blocked");
      assert.ok(g.blockers.every((b) => b.code === "APPLICABILITY_INDETERMINATE"));
      return `${out.evaluations.length} segment evaluations (${out.evaluations.map((e) => `${e.jurisdictionId ?? "?"}:${e.result}`).join(", ")}); M4 ${g.status} [${codes(g)}]`;
    },
  },
  {
    name: "permit expiry (gate blocked after expiry; schedule flags expiry before construction end; no in-place extension)",
    run: () => {
      const c = new Case("p").ev("ev-permit", T("2027-10-01"))
        .do("design", T("2027-10-01"), { type: "baseline_recorded", baseline: { id: "bl", kind: "design", version: 1, content: {}, createdAt: T("2027-10-01"), supersedes: null } })
        .do("compliance", T("2027-10-01"), { type: "authorization_identified", authorization: { id: "auth", requirement: "Building permit", authority: "City", activity: "install", phase: "construction" } })
        .do("compliance", T("2027-10-01"), { type: "authorization_applicability_set", authorizationId: "auth", applicability: "confirmed applicable", basis: "City code" })
        // M4 requirement set is only complete once PER-01 identification is recorded.
        .do("compliance", T("2027-10-01"), { type: "procedure_step_completed", code: "PER-01", evidence: ["ev-permit"] });
      for (const st of ["in preparation", "submitted", "under review"] as const) c.do("compliance", T("2027-10-01"), { type: "authorization_external_changed", authorizationId: "auth", state: st, evidence: [] });
      c.do("verifier", T("2027-10-01"), { type: "authorization_external_changed", authorizationId: "auth", state: "issued", evidence: ["ev-permit"], issuedAt: T("2027-10-01"), expiresAt: T("2028-07-01") });
      const pre = c.gate("M4", T("2028-01-01"));
      const post = c.gate("M4", T("2028-07-02"));
      assert.equal(pre.status, "pass");
      // Evidence is also >180 d old by then, so EVIDENCE_STALE co-occurs (correct under evidenceMaxAgeDays).
      assert.ok(post.blockers.some((b) => b.code === "AUTHORIZATION_EXPIRED"));
      c.do("verifier", T("2028-07-02"), { type: "authorization_external_changed", authorizationId: "auth", state: "expired", evidence: [] });
      assert.equal(c.reject("verifier", T("2028-07-03"), { type: "authorization_external_changed", authorizationId: "auth", state: "issued", evidence: ["ev-permit"], issuedAt: T("2028-07-03"), expiresAt: T("2029-07-01") }), "ILLEGAL_TRANSITION");
      const plan = backSchedule(MICROGRID, T("2028-06-15"));
      const s = schedule(MICROGRID, { anchor: plan.anchor, targetFinish: T("2028-06-15"), disruptions: [SLIP], expiries: [{ id: "auth", expiresAt: T("2028-07-01"), coversTaskIds: ["equipment_delivery", "energization"] }] });
      const f = s.flags.find((x) => x.code === "EXPIRES_BEFORE_COMPLETION");
      assert.ok(f);
      return `M4 pre-expiry ${pre.status}, post-expiry ${post.status} [${codes(post)}]; re-issue expired → ILLEGAL_TRANSITION; schedule: ${f!.reason}`;
    },
  },
  {
    name: "license mismatch in procurement, alternate supplier awarded",
    run: () => {
      const c = new Case("p").ev("lic-a", T("2027-11-01")).ev("lic-b", T("2027-11-01"))
        .do("contracting", T("2027-11-01"), { type: "supplier_registered", supplier: { id: "A", name: "Supplier A", licenses: [{ class: "C-46", jurisdictionId: "CA", expiresAt: T("2029-01-01"), evidenceId: "lic-a" }] } })
        .do("contracting", T("2027-11-01"), { type: "supplier_registered", supplier: { id: "B", name: "Supplier B", licenses: [{ class: "C-10", jurisdictionId: "CA", expiresAt: T("2029-01-01"), evidenceId: "lic-b" }] } })
        .do("contracting", T("2027-11-02"), { type: "procurement_package_created", package: { id: "epc", scope: "EPC", requiredLicense: { class: "C-10", jurisdictionId: "CA" } } });
      const early = c.reject("contracting", T("2027-11-03"), { type: "procurement_awarded", packageId: "epc", supplierId: "B" });
      for (const k of ["technical", "finance", "legal"]) c.do("contracting", T("2027-11-03"), { type: "procurement_approval_recorded", packageId: "epc", kind: k });
      const mismatch = c.reject("contracting", T("2027-11-04"), { type: "procurement_awarded", packageId: "epc", supplierId: "A" });
      c.do("contracting", T("2027-11-04"), { type: "procurement_awarded", packageId: "epc", supplierId: "B" }).ev("contract", T("2027-11-10")).do("contracting", T("2027-11-10"), { type: "contract_executed", packageId: "epc", evidence: ["contract"] });
      assert.equal(early, "AWARD_BEFORE_APPROVALS");
      assert.equal(mismatch, "LICENSE_MISMATCH");
      const g = c.gate("M5", T("2027-11-11"));
      assert.equal(g.status, "pass");
      return `award before approvals → ${early}; supplier A → ${mismatch}; alternate B awarded, M5 ${g.status}`;
    },
  },
  {
    name: "unavailable equipment (M5 blocked until approved alternate; schedule propagates lead time)",
    run: () => {
      const c = new Case("p").ev("lic", T("2027-11-01"))
        .do("contracting", T("2027-11-01"), { type: "supplier_registered", supplier: { id: "B", name: "B", licenses: [] } })
        .do("contracting", T("2027-11-02"), { type: "procurement_package_created", package: { id: "epc", scope: "EPC", requiredLicense: null, equipment: [{ id: "inv", model: "INV-500", supplierId: "B", longLead: true, availability: "available", leadTimeDays: 120, evidence: [] }] } });
      for (const k of ["technical", "finance", "legal"]) c.do("contracting", T("2027-11-03"), { type: "procurement_approval_recorded", packageId: "epc", kind: k });
      c.do("contracting", T("2027-11-04"), { type: "procurement_awarded", packageId: "epc", supplierId: "B" }).ev("contract", T("2027-11-10")).do("contracting", T("2027-11-10"), { type: "contract_executed", packageId: "epc", evidence: ["contract"] })
        .ev("notice", T("2028-01-05")).do("contracting", T("2028-01-05"), { type: "equipment_availability_changed", packageId: "epc", equipmentId: "inv", availability: "unavailable", leadTimeDays: null, evidence: ["notice"] });
      const blocked = c.gate("M5", T("2028-01-06"));
      c.do("design", T("2028-01-07"), { type: "equipment_substituted", packageId: "epc", equipmentId: "inv", model: "INV-520", supplierId: "B" });
      const after = c.gate("M5", T("2028-01-08"));
      assert.equal(codes(blocked), "EQUIPMENT_UNAVAILABLE");
      assert.equal(after.status, "pass");
      const i = applyDisruption(MICROGRID, { targetFinish: T("2028-06-15") }, { id: "alt", taskId: "equipment_delivery", delayDays: 80, reason: "alternate lead time", at: T("2028-01-07") });
      assert.ok(i.dependentsOnly);
      return `M5 ${blocked.status} [${codes(blocked)}] → after substitution ${after.status}; acceptance moves to ${day(i.after.tasks.find((t) => t.id === "acceptance_exercise")!.earlyFinish)}`;
    },
  },
  {
    name: "failed commissioning + retest (fail retained, retest new result, deferred never passes)",
    run: () => {
      const c = new Case("p").ev("t", T("2028-06-01")).ev("m7", T("2028-06-01"))
        .do("ownerRep", T("2028-06-01"), { type: "asset_registered", asset: { id: "bess", assetType: "BESS" } })
        .do("ownerRep", T("2028-06-01"), { type: "asset_custodian_assigned", assetId: "bess", custodian: "Facilities ops" })
        .do("cx", T("2028-06-01"), { type: "gate_signoff", gate: "M7", evidence: ["m7"] });
      const base = { testId: "islanding", stage: "commissioning" as const, critical: true, executor: "Cx", witness: "SCE", observed: null, evidence: ["t"], deferral: null, reviewedBy: "cx" };
      c.do("cx", T("2028-06-01"), { type: "test_result_recorded", result: { ...base, id: "TEST-8", outcome: "fail", executedAt: T("2028-06-01"), retestOf: null } });
      const failed = c.gate("M7", T("2028-06-02"));
      const mutate = c.reject("cx", T("2028-06-02"), { type: "test_result_recorded", result: { ...base, id: "TEST-8", outcome: "pass", executedAt: T("2028-06-02"), retestOf: null } });
      c.do("cx", T("2028-06-03"), { type: "test_result_recorded", result: { ...base, id: "TEST-9", outcome: "pass", executedAt: T("2028-06-03"), retestOf: "TEST-8" } });
      const passed = c.gate("M7", T("2028-06-04"));
      c.do("cx", T("2028-06-04"), { type: "test_result_recorded", result: { ...base, id: "TEST-10", testId: "48h", outcome: "deferred", executedAt: T("2028-06-04"), retestOf: null, deferral: { owner: "EM", reviewAt: T("2028-09-01"), control: "standby" } } });
      const deferred = c.gate("M7", T("2028-06-05"));
      assert.equal(codes(failed), "TEST_FAILED");
      assert.equal(mutate, "IMMUTABLE_RECORD");
      assert.equal(passed.status, "pass");
      assert.equal(current(c.s.tests["TEST-8"])!.outcome, "fail");
      assert.equal(codes(deferred), "TEST_DEFERRED");
      return `fail → ${failed.status}; overwrite → ${mutate}; retest → ${passed.status}; deferred → ${deferred.status}`;
    },
  },
  {
    name: "post-handover renewal opens linked case keeping old baseline",
    run: () => {
      const c = new Case("p")
        .do("design", T("2028-06-10"), { type: "baseline_recorded", baseline: { id: "bl-1", kind: "design", version: 1, content: { inverter: "INV-500" }, createdAt: T("2028-06-10"), supersedes: null } });
      const h = current(c.s.baselines["bl-1"])!.contentHash;
      c.ev("cond", T("2040-01-01")).do("sponsor", T("2040-01-10"), { type: "decision_recorded", decision: { id: "m8", gate: "M8", kind: "renewal", question: "Year-12 inverter renewal", owner: "asset mgr", alternatives: [{ id: "r", label: "renew", viable: true }], outcome: "proceed", rationale: "condition", weights: {}, assumptions: [], evidence: ["cond"], decidedAt: T("2040-01-10"), revisitAt: null } })
        .do("sponsor", T("2040-01-10"), { type: "decision_signed", decisionId: "m8", version: 1 });
      const before = c.gate("M8", T("2040-01-11"));
      c.do("sponsor", T("2040-01-11"), { type: "linked_case_opened", link: { caseId: "p-renewal", relation: "renewal", fromBaselineId: "bl-1", trigger: "m8", reason: "inverter renewal" } });
      const after = c.gate("M8", T("2040-01-12"));
      const overwrite = c.reject("design", T("2040-01-12"), { type: "baseline_recorded", baseline: { id: "bl-1", kind: "design", version: 2, content: {}, createdAt: T("2040-01-12"), supersedes: null } });
      assert.equal(codes(before), "RENEWAL_CASE_MISSING");
      assert.equal(after.status, "pass");
      assert.equal(overwrite, "IMMUTABLE_BASELINE");
      assert.equal(current(c.s.baselines["bl-1"])!.contentHash, h);
      const plan = backSchedule(MICROGRID, T("2028-06-15"));
      const bl = createScheduleBaseline("sched-1", plan, T("2027-01-01"));
      const rf = reforecast(bl, MICROGRID, { disruptions: [SLIP] }, T("2028-05-01"), 2);
      assert.equal(rf.baselineHash, bl.contentHash);
      return `M8 ${before.status} → ${after.status}; baseline overwrite → ${overwrite}; schedule variance energization +${rf.variance.find((v) => v.taskId === "energization")!.varianceDays}d vs frozen baseline`;
    },
  },
  {
    name: "stale evidence (freshness and age affect gate)",
    run: () => {
      const c = new Case("p").ev("src", T("2026-12-01")).do("triage", T("2026-12-02"), { type: "intake_accepted", owner: "o", urgency: "routine", nextAction: "audit", nextActionDate: T("2027-01-15"), sourceEvidence: ["src"] });
      const fresh = c.gate("M0", T("2027-01-01"));
      const aged = c.gate("M0", T("2027-07-01"));
      c.ev("src", T("2027-01-02"), "stale");
      const marked = c.gate("M0", T("2027-01-03"));
      c.ev("src", T("2027-01-04"));
      const renewed = c.gate("M0", T("2027-01-05"));
      assert.equal(fresh.status, "pass");
      assert.equal(codes(aged), "EVIDENCE_STALE");
      assert.equal(codes(marked), "EVIDENCE_STALE");
      assert.equal(renewed.status, "pass");
      return `fresh ${fresh.status}; >180 d ${aged.status}; marked stale ${marked.status}; re-retrieved ${renewed.status}`;
    },
  },
  {
    name: "open obligation at M9 (blocked; waived by authorized approver → pass)",
    run: () => {
      const c = new Case("p").ev("archive", T("2041-01-01"))
        .do("ownerRep", T("2041-01-01"), { type: "asset_registered", asset: { id: "bess", assetType: "BESS" } });
      for (const st of ["validated", "in_service", "retired"] as const) c.do("ownerRep", T("2041-01-01"), { type: "asset_status_changed", assetId: "bess", status: st });
      c.do("compliance", T("2041-01-01"), { type: "condition_recorded", condition: { id: "recycle", sourceRecordId: "fire", text: "Battery recycling receipt", authority: "Fire", responsibleParty: "Facilities", dueAt: T("2041-03-01"), trigger: null, blocksGates: ["M9"] } })
        .do("custodian", T("2041-01-02"), { type: "gate_signoff", gate: "M9", evidence: ["archive"] });
      const blocked = c.gate("M9", T("2041-01-03"));
      c.ev("waiver", T("2041-01-03"));
      const noAuth = c.reject("analyst", T("2041-01-03"), { type: "condition_waived", conditionId: "recycle", reason: "x", evidence: ["waiver"] });
      c.do("waiverAuth", T("2041-01-03"), { type: "condition_waived", conditionId: "recycle", reason: "Vendor take-back accepted by fire authority", evidence: ["waiver"] });
      const after = c.gate("M9", T("2041-01-04"));
      assert.equal(codes(blocked), "OBLIGATION_OPEN");
      assert.equal(noAuth, "WAIVER_REQUIRES_APPROVER");
      assert.equal(after.status, "pass");
      return `M9 ${blocked.status} [${codes(blocked)}]; unauthorized waiver → ${noAuth}; authorized waiver → ${after.status}`;
    },
  },
  {
    name: "not-applicable without reviewer rejected",
    run: () => {
      const c = new Case("p").do("compliance", T("2027-07-01"), { type: "authorization_identified", authorization: { id: "a", requirement: "Air permit", authority: "AQMD", activity: "standby diesel", phase: "construction" } });
      const noReviewer = c.reject("analyst", T("2027-07-02"), { type: "authorization_applicability_set", authorizationId: "a", applicability: "not applicable with rationale", basis: "below threshold" });
      const noReason = c.reject("compliance", T("2027-07-02"), { type: "authorization_applicability_set", authorizationId: "a", applicability: "not applicable with rationale", basis: null });
      assert.equal(noReviewer, "NOT_APPLICABLE_REQUIRES_REVIEWER");
      assert.equal(noReason, "NOT_APPLICABLE_REQUIRES_REVIEWER");
      return `unauthorized actor → ${noReviewer}; reviewer without rationale → ${noReason}`;
    },
  },
  {
    name: "determinism of the reducer (replay same log → identical state hash)",
    run: () => {
      const c = new Case("p").ev("src", T("2026-12-01")).do("triage", T("2026-12-02"), { type: "intake_accepted", owner: "o", urgency: "routine", nextAction: "a", nextActionDate: T("2027-01-15"), sourceEvidence: ["src"] })
        .do("sponsor", T("2027-01-02"), { type: "decision_recorded", decision: { id: "d", gate: "M1", kind: "alternative", question: "q", owner: "o", alternatives: [{ id: "B", label: "B", viable: true }], outcome: "proceed", rationale: "r", weights: { cost: 0.5 }, assumptions: [], evidence: ["src"], decidedAt: T("2027-01-02"), revisitAt: null } })
        .do("analyst", T("2027-01-03"), { type: "decision_revised", decisionId: "d", changes: { weights: { cost: 0.6 } } });
      const init = createLifecycle({ caseId: "p", title: "p", sector: "electric", config: CONFIG });
      const h1 = stateHash(replay(init, c.s.log));
      const h2 = stateHash(replay(init, JSON.parse(JSON.stringify(c.s.log)) as LifecycleEvent[]));
      assert.equal(h1, h2);
      assert.equal(h1, stateHash(c.s));
      return `${c.s.log.length} events, hash ${h1} (x2 replays + live state)`;
    },
  },
  {
    name: "reload isolation in draftStore",
    run: () => {
      const mem = memoryStorage();
      const loc = { lat: 33.759123, lon: -117.99, radius: 5, sector: "electric" as const };
      const t: OwnerTask = { id: "t1", title: "Confirm ROW permit", role: "permits", stage: "permits", dependsOn: [], offsetDays: 0, durationDays: 5, inputs: [], output: "memo", evidence: ["e1"], recovery: "escalate", status: "not_started" };
      createDraftStore(mem).save(loc, setTaskEdit(emptyDraft(draftKey(loc)), t, { owner: "Ana" }, T("2027-01-01")));
      const reloaded = createDraftStore(mem);
      const same = reloaded.load(loc);
      const other = reloaded.load({ ...loc, radius: 10 });
      const otherSector = reloaded.load({ ...loc, sector: "water" });
      const merged = mergeDraft([{ ...t, evidence: ["e1", "e2"] }], same.draft);
      assert.equal(same.status, "loaded");
      assert.equal(other.status, "empty");
      assert.equal(otherSector.status, "empty");
      assert.equal(merged.tasks[0].owner, "Ana");
      assert.deepEqual(merged.changedUnderEdit, ["t1"]);
      return `key ${draftKey(loc)} → ${same.status}; radius 10 → ${other.status}; water → ${otherSector.status}; edit survives evidence change (flagged changedUnderEdit)`;
    },
  },
  {
    name: "case gate dates (water +10 wk, bridge +8 wk, wastewater startup +5 wk, fiber build/launch)",
    run: () => {
      const shift = (work: number, gate: string, delay: number) => {
        const anchor = new Date(Date.parse(T(gate)) - work * 86_400_000).toISOString();
        const i = applyDisruption([{ id: "w", durationDays: work, dependsOn: [], offsetDays: 0 }, { id: "g", durationDays: 0, dependsOn: ["w"], offsetDays: 0 }], { anchor }, { id: "d", taskId: "w", delayDays: delay, reason: "r", at: anchor });
        return day(i.after.tasks.find((x) => x.id === "g")!.earlyFinish);
      };
      const got = [shift(60, "2028-08-01", 70), shift(90, "2028-11-01", 56), shift(14, "2029-06-01", 35)];
      assert.deepEqual(got, ["2028-10-10", "2028-12-27", "2029-07-06"]);
      const fiber = applyDisruption([{ id: "west", durationDays: 61, dependsOn: [], offsetDays: 0 }, { id: "wacc", durationDays: 190, dependsOn: ["west"], offsetDays: 0 }, { id: "east", durationDays: 259, dependsOn: [], offsetDays: 0 }, { id: "launch", durationDays: 0, dependsOn: ["wacc", "east"], offsetDays: 0 }], { anchor: T("2028-05-01") }, { id: "d", taskId: "west", delayDays: 98, reason: "make-ready", at: T("2028-06-01") });
      const f = Object.fromEntries(fiber.after.tasks.map((x) => [x.id, day(x.earlyFinish)]));
      assert.deepEqual([f.west, f.launch], ["2028-10-07", "2029-04-15"]);
      return `water ${got[0]}, bridge ${got[1]}, wastewater startup ${got[2]}, fiber west ${f.west} / launch ${f.launch}`;
    },
  },
];

let failed = 0;
for (const s of scenarios) {
  try {
    const detail = s.run();
    console.log(`PASS  ${s.name}\n      ${detail}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${s.name}\n      ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}
console.log("\nNOTE  doc arithmetic not reproducible by a pure period shift (engine values reported, not asserted against doc):");
console.log("      substation: 20 wk from Oct 1, 2029 = 2030-02-18 (doc states Feb 20, 2030)");
console.log("      wastewater performance sampling: 5 wk from Sep 1, 2029 = 2029-10-06 (doc states Oct 15)");
console.log(`\n${scenarios.length - failed} scenarios passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
