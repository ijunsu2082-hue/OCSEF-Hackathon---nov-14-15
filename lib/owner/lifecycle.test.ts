import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPLICABILITY_STATES, EVENT_TYPES, EXTERNAL_STATES, LifecycleError, applyEvent, caseRecord, createLifecycle,
  current, evaluateGate, replay, stateHash, submissionPackageHash, triggerStatus, GATE_STAGE, GATES,
  type GateEvaluation, type LifecycleConfig, type LifecycleEvent, type LifecycleState,
} from "./lifecycle";
import { evaluateRules, segmentRouteByJurisdiction, type JurisdictionArea, type RulePack } from "./rulePacks";
import { PROCEDURES, RULE_IDS, STAGE_GATE, TRIGGER_IDS, gatingOf, preconditionCodes, procedureByCode } from "./procedures";
import { LIVENESS_CASE_IDS, completedLifecycleCase, type LivenessCase } from "./fixtures";
import type { Evidence, Fact, GateId } from "./planTypes";

// ---------------------------------------------------------------------------
// Fixture harness.

type Payload = LifecycleEvent extends infer E ? (E extends LifecycleEvent ? Omit<E, "id" | "at" | "actor"> : never) : never;
const USED = new Set<string>();
const T = (day: string) => `${day}T12:00:00Z`;

export const CONFIG: LifecycleConfig = {
  roles: {
    triage: ["triage"], sponsor: ["investment"], compliance: ["compliance"], verifier: ["permit_verifier"],
    land: ["land_legal"], finance: ["finance"], signatory: ["signatory"], contracting: ["contracting"],
    waiverAuth: ["waiver"], design: ["design_authority"], quality: ["quality"], cx: ["cx_authority"],
    ownerRep: ["owner_rep"], custodian: ["records"], analyst: [],
  },
  authority: {
    triage: ["triage"], decision: ["investment"], applicabilityReviewer: ["compliance"], instrumentVerifier: ["permit_verifier"],
    landRights: ["land_legal"], budget: ["finance"], submission: ["signatory"], award: ["contracting"], waiver: ["waiver"],
    conditionReviewer: ["compliance"], designAuthority: ["design_authority"], ncrDisposition: ["quality"], testReviewer: ["cx_authority"],
    gateSignoff: { M6: ["owner_rep"], M7: ["cx_authority"], M9: ["records"] },
  },
  requiredAwardApprovals: ["technical", "finance", "legal"],
};

class W {
  s: LifecycleState;
  n = 0;
  constructor(cfg: LifecycleConfig = CONFIG) {
    this.s = createLifecycle({ caseId: "case-mg", title: "Westminster critical-facility microgrid (synthetic)", sector: "electric", config: cfg });
  }
  ev(actor: string, at: string, p: Payload): LifecycleEvent {
    return { ...(p as object), id: `e${++this.n}`, at, actor } as LifecycleEvent;
  }
  do(actor: string, at: string, p: Payload): this {
    const e = this.ev(actor, at, p);
    this.s = applyEvent(this.s, e);
    USED.add(e.type);
    return this;
  }
  err(actor: string, at: string, p: Payload): LifecycleError {
    const before = stateHash(this.s);
    try {
      applyEvent(this.s, this.ev(actor, at, p));
    } catch (e) {
      assert.ok(e instanceof LifecycleError, `expected LifecycleError, got ${String(e)}`);
      assert.equal(stateHash(this.s), before, "failed event must not change state");
      return e;
    }
    assert.fail(`expected ${p.type} to be rejected`);
  }
  evidence(id: string, at: string, freshness: Evidence["freshness"] = "fresh", kind: Evidence["kind"] = "document"): this {
    return this.do("analyst", at, { type: "evidence_recorded", evidence: { id, kind, title: id, source: { publisher: "synthetic" }, retrievedAt: at, freshness, provenance: "owner_verified" } });
  }
  gate(g: GateId, asOf: string, procedures = false): GateEvaluation {
    return evaluateGate(this.s, g, asOf, procedures ? { procedures: [...PROCEDURES] } : {});
  }
}
const codes = (g: GateEvaluation) => g.blockers.map((b) => b.code);

function m0(w: W): W {
  return w.evidence("ev-intake", T("2026-12-01")).do("triage", T("2026-12-02"), {
    type: "intake_accepted", owner: "City facilities manager", urgency: "routine",
    nextAction: "Interval-meter load logging and critical-load audit", nextActionDate: T("2027-01-15"), sourceEvidence: ["ev-intake"],
  });
}

// ---------------------------------------------------------------------------
// Vocabulary.

test("vocabulary: six applicability states and thirteen external states, exact doc names", () => {
  assert.deepEqual([...APPLICABILITY_STATES], ["not assessed", "potentially applicable", "confirmed applicable", "not applicable with rationale", "non-determination—authority/source unclear", "superseded by change"]);
  assert.equal(EXTERNAL_STATES.length, 13);
  assert.deepEqual([...EXTERNAL_STATES], ["not ready", "pre-application", "in preparation", "submitted", "receipt confirmed", "under review", "information requested", "issued", "denied", "withdrawn", "appeal/dispute", "expired", "closed"]);
});

// ---------------------------------------------------------------------------
// M0.

test("M0: not_ready before intake; unauthorized acceptance rejected; pass when accepted with owner, next action/date, source", () => {
  const w = new W();
  assert.equal(w.gate("M0", T("2026-12-03")).status, "not_ready");
  w.evidence("ev-intake", T("2026-12-01"));
  const e = w.err("analyst", T("2026-12-02"), { type: "intake_accepted", owner: "x", urgency: "routine", nextAction: "a", nextActionDate: T("2027-01-15"), sourceEvidence: ["ev-intake"] });
  assert.equal(e.code, "UNAUTHORIZED");
  const e2 = w.err("triage", T("2026-12-02"), { type: "intake_accepted", owner: "x", urgency: "routine", nextAction: "", nextActionDate: T("2027-01-15"), sourceEvidence: ["ev-intake"] });
  assert.equal(e2.code, "MISSING_FIELD");
  w.do("triage", T("2026-12-02"), { type: "intake_accepted", owner: "City facilities manager", urgency: "routine", nextAction: "load audit", nextActionDate: T("2027-01-15"), sourceEvidence: ["ev-intake"] });
  const g = w.gate("M0", T("2026-12-03"));
  assert.equal(g.status, "pass", JSON.stringify(g));
  w.do("triage", T("2026-12-04"), { type: "next_action_set", nextAction: "geotech", nextActionDate: T("2027-03-01") });
  assert.equal(caseRecord(w.s).nextAction, "geotech");
  assert.equal(w.s.case.length, 3, "case revisions are appended, not overwritten");
});

test("stale evidence: freshness 'stale' or age beyond evidenceMaxAgeDays blocks the gate; re-retrieval appends a fresh revision", () => {
  const w = m0(new W({ ...CONFIG, evidenceMaxAgeDays: 90 }));
  assert.equal(w.gate("M0", T("2027-01-01")).status, "pass");
  const aged = w.gate("M0", T("2027-06-01"));
  assert.equal(aged.status, "blocked");
  assert.deepEqual(codes(aged), ["EVIDENCE_STALE"]);
  w.evidence("ev-intake", T("2027-05-30"), "stale");
  assert.deepEqual(codes(w.gate("M0", T("2027-05-31"))), ["EVIDENCE_STALE"]);
  w.evidence("ev-intake", T("2027-05-31"), "fresh");
  assert.equal(w.gate("M0", T("2027-06-01")).status, "pass");
  assert.equal(w.s.evidence["ev-intake"].length, 3, "all evidence revisions retained");
  w.evidence("ev-intake", T("2027-06-02"), "unknown");
  const unk = w.gate("M0", T("2027-06-03"));
  assert.equal(unk.status, "not_ready");
  assert.ok(unk.missingInputs.some((m) => m.includes("freshness")));
});

// ---------------------------------------------------------------------------
// M1.

function decision(w: W, at: string, outcome: "proceed" | "stop" = "proceed", rationale = "B balances resilience and cost") {
  return w.evidence("ev-alts", at).do("sponsor", at, {
    type: "decision_recorded",
    decision: {
      id: "dec-m1", gate: "M1", kind: outcome === "stop" ? "no_go" : "alternative", question: "Preferred microgrid option",
      owner: "sponsor", alternatives: [{ id: "A", label: "Battery only", viable: true }, { id: "B", label: "PV + 4 MWh", viable: true }, { id: "C", label: "PV + 8 MWh", viable: true }],
      outcome, rationale, weights: { resilience: 0.5, cost: 0.3, emissions: 0.2 }, assumptions: ["0.375 kg/kWh emissions proxy"],
      evidence: ["ev-alts"], decidedAt: at, revisitAt: null,
    },
  });
}

test("M1: unsigned decision blocks; weight change creates new version, clears sign-off, old version cannot be signed", () => {
  const w = decision(m0(new W()), T("2027-02-01"));
  assert.deepEqual(codes(w.gate("M1", T("2027-02-02"))), ["DECISION_UNSIGNED"]);
  assert.equal(w.err("analyst", T("2027-02-02"), { type: "decision_signed", decisionId: "dec-m1", version: 1 }).code, "UNAUTHORIZED");
  w.do("sponsor", T("2027-02-02"), { type: "decision_signed", decisionId: "dec-m1", version: 1 });
  assert.equal(w.gate("M1", T("2027-02-03")).status, "pass");
  w.do("analyst", T("2027-02-10"), { type: "decision_revised", decisionId: "dec-m1", changes: { weights: { resilience: 0.6, cost: 0.2, emissions: 0.2 } } });
  const d = current(w.s.decisions["dec-m1"]);
  assert.equal(d?.version, 2);
  assert.equal(d?.signedBy, null);
  assert.equal(w.s.decisions["dec-m1"].length, 3, "v1, v1-signed, v2 all retained");
  assert.deepEqual(codes(w.gate("M1", T("2027-02-11"))), ["DECISION_UNSIGNED"]);
  assert.equal(w.err("sponsor", T("2027-02-11"), { type: "decision_signed", decisionId: "dec-m1", version: 1 }).code, "STALE_VERSION");
  w.do("sponsor", T("2027-02-11"), { type: "decision_signed", decisionId: "dec-m1", version: 2 });
  assert.equal(w.gate("M1", T("2027-02-12")).status, "pass");
});

test("M1: documented no-go passes; no-go without rationale rejected; proceed with no viable alternative blocked", () => {
  const w = decision(m0(new W()), T("2027-02-01"), "stop", "No site can host battery under fire access constraints");
  w.do("sponsor", T("2027-02-02"), { type: "decision_signed", decisionId: "dec-m1", version: 1 });
  assert.equal(w.gate("M1", T("2027-02-03")).status, "pass");
  const w2 = m0(new W()).evidence("ev-alts", T("2027-02-01"));
  assert.equal(w2.err("sponsor", T("2027-02-01"), { type: "decision_recorded", decision: { id: "d", gate: "M1", kind: "no_go", question: "q", owner: "o", alternatives: [], outcome: "stop", rationale: "", weights: {}, assumptions: [], evidence: [], decidedAt: T("2027-02-01"), revisitAt: null } }).code, "MISSING_FIELD");
  w2.do("sponsor", T("2027-02-01"), { type: "decision_recorded", decision: { id: "d", gate: "M1", kind: "alternative", question: "q", owner: "o", alternatives: [{ id: "A", label: "a", viable: false }], outcome: "proceed", rationale: "r", weights: {}, assumptions: [], evidence: [], decidedAt: T("2027-02-01"), revisitAt: null } });
  w2.do("sponsor", T("2027-02-02"), { type: "decision_signed", decisionId: "d", version: 1 });
  assert.deepEqual(codes(w2.gate("M1", T("2027-02-03"))), ["NO_VIABLE_ALTERNATIVE"]);
});

// ---------------------------------------------------------------------------
// M2.

test("M2: outreach never establishes site control; only accepted executed instrument or authorized waiver passes", () => {
  const w = m0(new W()).evidence("ev-meeting", T("2027-02-01"));
  w.do("land", T("2027-02-01"), { type: "land_record_added", record: { id: "lr-1", parcel: "APN-195-01", instrument: "outreach", evidence: ["ev-meeting"] } });
  assert.deepEqual(codes(w.gate("M2", T("2027-02-02"))), ["RIGHTS_NOT_EVIDENCED"]);
  assert.equal(w.err("land", T("2027-02-02"), { type: "land_rights_accepted", recordId: "lr-1", evidence: ["ev-meeting"] }).code, "RIGHTS_FROM_OUTREACH");
  w.evidence("ev-lease", T("2027-03-01"));
  w.do("land", T("2027-03-01"), { type: "land_record_added", record: { id: "lr-2", parcel: "APN-195-01", instrument: "executed", evidence: [] } });
  assert.deepEqual(codes(w.gate("M2", T("2027-03-02"))), ["RIGHTS_NOT_EVIDENCED"], "executed but unaccepted still blocked");
  assert.equal(w.err("analyst", T("2027-03-02"), { type: "land_rights_accepted", recordId: "lr-2", evidence: ["ev-lease"] }).code, "UNAUTHORIZED");
  w.do("land", T("2027-03-02"), { type: "land_rights_accepted", recordId: "lr-2", evidence: ["ev-lease"] });
  assert.equal(w.gate("M2", T("2027-03-03")).status, "pass");
  w.do("land", T("2027-03-03"), { type: "land_record_added", record: { id: "lr-3", parcel: "APN-195-02", instrument: "loi_draft", evidence: [] } });
  assert.equal(w.gate("M2", T("2027-03-04")).status, "blocked");
  w.do("waiverAuth", T("2027-03-04"), { type: "land_control_waived", recordId: "lr-3", reason: "Access only; at-risk accepted by sponsor until Jun 1" });
  assert.equal(w.gate("M2", T("2027-03-05")).status, "pass");
});

// ---------------------------------------------------------------------------
// M3 / grants.

function grantSetup(w: W): W {
  return w.evidence("ev-capital", T("2027-03-01"))
    .do("finance", T("2027-03-01"), { type: "budget_approved", budget: { id: "bud-1", amount: 6_800_000, currency: "USD", residualGap: null } })
    .do("finance", T("2027-03-01"), { type: "funding_source_recorded", source: { id: "fs-capital", provider: "City capital plan", kind: "capital", amount: 3_000_000, currency: "USD", status: "committed", evidence: ["ev-capital"] } })
    .do("finance", T("2027-03-02"), { type: "funding_source_recorded", source: { id: "fs-grant", provider: "Resilience grant (synthetic)", kind: "grant", amount: 3_800_000, currency: "USD", status: "identified", evidence: [] } })
    .do("finance", T("2027-03-03"), { type: "submission_drafted", submission: { id: "sub-grant", kind: "grant_application", authority: "Grant administrator", packageRevision: "pkg-r3", attachments: [{ name: "narrative.pdf", sha256: "aa11" }, { name: "budget.xlsx", sha256: "bb22" }], fundingId: "fs-grant" } });
}

test("M3: pending funds never counted as committed; grant award is separate from submission; frozen package hash enforced", () => {
  const w = grantSetup(m0(new W()));
  const g1 = w.gate("M3", T("2027-03-04"));
  assert.deepEqual(codes(g1), ["FUNDING_GAP"]);
  assert.match(g1.blockers[0].reason, /committed 3000000 of 6800000/);
  // Award cannot be recorded against a draft, nor by bypassing the submission.
  assert.equal(w.err("finance", T("2027-03-04"), { type: "grant_award_recorded", submissionId: "sub-grant", fundingId: "fs-grant", amount: 3_800_000, evidence: ["x"] }).code, "AWARD_BEFORE_SUBMISSION");
  w.do("finance", T("2027-03-04"), { type: "funding_status_changed", fundingId: "fs-grant", status: "applied", evidence: [] });
  assert.equal(w.err("finance", T("2027-03-04"), { type: "funding_status_changed", fundingId: "fs-grant", status: "awarded", evidence: ["x"] }).code, "AWARD_BEFORE_SUBMISSION");
  // Submission: only signatory; hash must match frozen package.
  const frozen = current(w.s.submissions["sub-grant"])!.packageHash;
  assert.equal(frozen, submissionPackageHash("pkg-r3", [{ name: "budget.xlsx", sha256: "bb22" }, { name: "narrative.pdf", sha256: "aa11" }]));
  assert.equal(w.err("finance", T("2027-03-05"), { type: "submission_sent", submissionId: "sub-grant", packageHash: frozen }).code, "UNAUTHORIZED");
  assert.equal(w.err("signatory", T("2027-03-05"), { type: "submission_sent", submissionId: "sub-grant", packageHash: "edited-after-freeze" }).code, "PACKAGE_HASH_MISMATCH");
  w.do("signatory", T("2027-03-05"), { type: "submission_sent", submissionId: "sub-grant", packageHash: frozen });
  assert.equal(current(w.s.submissions["sub-grant"])!.state, "submitted");
  assert.deepEqual(codes(w.gate("M3", T("2027-03-06"))), ["FUNDING_GAP"], "submitted application is not committed funding");
  w.evidence("ev-receipt", T("2027-03-06"));
  w.do("signatory", T("2027-03-06"), { type: "submission_receipt_recorded", submissionId: "sub-grant", reference: "GRANT-2027-0042", evidenceId: "ev-receipt", receivedAt: T("2027-03-06") });
  w.evidence("ev-award", T("2027-06-01"));
  w.do("finance", T("2027-06-01"), { type: "grant_award_recorded", submissionId: "sub-grant", fundingId: "fs-grant", amount: 3_800_000, evidence: ["ev-award"] });
  assert.equal(current(w.s.submissions["sub-grant"])!.state, "acknowledged", "award does not change submission state");
  assert.equal(current(w.s.funding["fs-grant"])!.status, "awarded");
  assert.deepEqual(codes(w.gate("M3", T("2027-06-02"))), ["FUNDING_GAP"], "awarded is not yet committed");
  assert.equal(w.err("finance", T("2027-06-02"), { type: "funding_status_changed", fundingId: "fs-grant", status: "committed", evidence: [] }).code, "EVIDENCE_REQUIRED");
  w.evidence("ev-acceptance", T("2027-06-10"));
  w.do("finance", T("2027-06-10"), { type: "funding_status_changed", fundingId: "fs-grant", status: "committed", evidence: ["ev-acceptance"] });
  assert.equal(w.gate("M3", T("2027-06-11")).status, "pass");
  assert.equal(w.err("signatory", T("2027-06-11"), { type: "submission_status_changed", submissionId: "sub-grant", state: "returned", reason: "" }).code, "MISSING_FIELD");
  w.do("signatory", T("2027-06-11"), { type: "submission_status_changed", submissionId: "sub-grant", state: "closed", reason: "award executed" });
  assert.equal(w.err("signatory", T("2027-06-12"), { type: "submission_status_changed", submissionId: "sub-grant", state: "withdrawn", reason: "x" }).code, "ILLEGAL_TRANSITION");
});

test("M3: explicit residual gap acknowledged on the approved budget passes; currency mismatch blocks", () => {
  const w = m0(new W()).evidence("ev-capital", T("2027-03-01"))
    .do("finance", T("2027-03-01"), { type: "budget_approved", budget: { id: "bud-1", amount: 6_800_000, currency: "USD", residualGap: { acknowledgedBy: "finance", reason: "Grant pending; council to revisit Jun 1" } } })
    .do("finance", T("2027-03-01"), { type: "funding_source_recorded", source: { id: "fs-capital", provider: "City", kind: "capital", amount: 3_000_000, currency: "USD", status: "committed", evidence: ["ev-capital"] } });
  assert.equal(w.gate("M3", T("2027-03-02")).status, "pass");
  w.do("finance", T("2027-03-02"), { type: "funding_source_recorded", source: { id: "fs-eur", provider: "Partner", kind: "other", amount: 1, currency: "EUR", status: "identified", evidence: [] } });
  assert.deepEqual(codes(w.gate("M3", T("2027-03-03"))), ["INCOMPARABLE_CURRENCY"]);
});

// ---------------------------------------------------------------------------
// M4 and rules.

const COUNTY_A: JurisdictionArea = { id: "county-a", ring: [[-118.1, 33.7], [-118.0, 33.7], [-118.0, 33.8], [-118.1, 33.8]] };
const COUNTY_B: JurisdictionArea = { id: "county-b", ring: [[-118.0, 33.7], [-117.9, 33.7], [-117.9, 33.8], [-118.0, 33.8]] };
const ROUTE = { id: "feeder", vertices: [[-118.08, 33.75], [-118.04, 33.75], [-117.96, 33.75], [-117.92, 33.75]] as [number, number][] };
const PACK_A: RulePack = {
  id: "pack-a-row", jurisdictionId: "county-a", domain: "right_of_way", version: "2026.1", effectiveFrom: T("2026-01-01"), effectiveTo: null,
  status: "active", reviewedBy: "compliance",
  rules: [{ id: "row-encroachment", requirement: "Encroachment permit for trenching in public right-of-way", when: [{ input: "trench_in_public_row", op: "eq", value: true }], sourceIds: ["src-a-code"], effectiveFrom: T("2026-01-01"), effectiveTo: null, activities: ["trenching"], phases: ["construction"] }],
};
const PACK_B: RulePack = {
  ...PACK_A, id: "pack-b-row", jurisdictionId: "county-b",
  rules: [{ ...PACK_A.rules[0], id: "row-b-encroachment", when: [{ input: "trench_in_public_row", op: "eq", value: true }, { input: "depth_m", op: "gt", value: 1.2 }], sourceIds: ["src-b-code"] }],
};
const FACTS: Fact[] = [{ id: "f-row", subject: "case-mg", predicate: "trench_in_public_row", value: true, provenance: "owner_verified", evidence: ["ev-route"], asOf: T("2027-07-01") }];

test("rules: a route crossing two jurisdictions is evaluated per segment (two evaluations), never by centroid", () => {
  const segs = segmentRouteByJurisdiction(ROUTE, [COUNTY_A, COUNTY_B], ["trenching"], "construction");
  assert.deepEqual(segs.map((s) => s.jurisdictionIds), [["county-a"], ["county-b"]]);
  const out = evaluateRules({ projectId: "case-mg", segments: segs, packs: [PACK_A, PACK_B], facts: FACTS, domains: ["right_of_way"], effectiveDate: T("2027-07-01") });
  assert.equal(out.evaluations.length, 2);
  assert.deepEqual(out.evaluations.map((e) => [e.jurisdictionId, e.result]), [["county-a", "applies"], ["county-b", "indeterminate"]]);
  assert.deepEqual(out.evaluations[1].missingInputs, ["depth_m"]);
  const outside = segmentRouteByJurisdiction({ id: "r2", vertices: [[-118.08, 33.75], [-118.08, 33.95]] }, [COUNTY_A], ["trenching"], "construction");
  const o2 = evaluateRules({ projectId: "case-mg", segments: outside, packs: [PACK_A], facts: FACTS, domains: ["right_of_way"], effectiveDate: T("2027-07-01") });
  assert.ok(o2.evaluations.some((e) => e.jurisdictionId === null && e.result === "indeterminate"), "unresolved boundary is indeterminate, not does_not_apply");
  assert.ok(o2.coverage.some((c) => c.reason === "unresolved_boundary"));
});

test("rules: unknown or conflicting inputs are indeterminate; does_not_apply only with all inputs known; draft pack gives no coverage", () => {
  const segs = segmentRouteByJurisdiction(ROUTE, [COUNTY_A], ["trenching"], "construction").filter((s) => Array.isArray(s.jurisdictionIds));
  const run = (facts: Fact[], packs = [PACK_A]) => evaluateRules({ projectId: "p", segments: segs, packs, facts, domains: ["right_of_way"], effectiveDate: T("2027-07-01") }).evaluations[0];
  assert.equal(run([{ ...FACTS[0], subject: "p", value: { state: "unknown", reason: "survey pending" } }]).result, "indeterminate");
  assert.equal(run([{ ...FACTS[0], subject: "p" }, { ...FACTS[0], id: "f2", subject: "p", value: false }]).result, "indeterminate", "conflict");
  assert.equal(run([{ ...FACTS[0], subject: "p", value: false }]).result, "does_not_apply");
  assert.equal(run([{ ...FACTS[0], subject: "p", value: false }, { ...FACTS[0], id: "f3", subject: "p", value: true, supersedes: "f-row" }]).result, "applies", "supersession respected");
  const draft = run([{ ...FACTS[0], subject: "p" }], [{ ...PACK_A, status: "draft", reviewedBy: null }]);
  assert.equal(draft.result, "indeterminate");
  assert.equal(draft.ruleId, "coverage:right_of_way");
});

function m4Setup(w: W) {
  const segs = segmentRouteByJurisdiction(ROUTE, [COUNTY_A, COUNTY_B], ["trenching"], "construction");
  const { evaluations } = evaluateRules({ projectId: "case-mg", segments: segs, packs: [PACK_A, PACK_B], facts: FACTS, domains: ["right_of_way"], effectiveDate: T("2027-07-01") });
  w.evidence("ev-route", T("2027-07-01")).evidence("src-a-code", T("2027-07-01")).evidence("src-b-code", T("2027-07-01"));
  w.do("compliance", T("2027-07-01"), { type: "rule_evaluations_recorded", evaluations });
  w.do("design", T("2027-07-01"), { type: "baseline_recorded", baseline: { id: "bl-design-1", kind: "design", version: 1, content: { oneLine: "rev C" }, createdAt: T("2027-07-01"), supersedes: null } });
  return { evaluations, segA: evaluations[0], segB: evaluations[1] };
}

test("M4: permit unknown (indeterminate) blocks; not-applicable needs named reviewer; issued instrument passes until expiry", () => {
  const w = m0(new W());
  const { segA, segB } = m4Setup(w);
  const g = w.gate("M4", T("2027-07-02"));
  assert.equal(g.status, "blocked");
  assert.deepEqual(codes(g), ["APPLICABILITY_INDETERMINATE", "REQUIREMENT_UNTRACKED"]);
  const ident = (id: string, e: typeof segA) => ({ type: "authorization_identified" as const, authorization: { id, requirement: e.ruleId, authority: `${e.jurisdictionId} public works`, activity: e.activity, phase: e.phase, jurisdictionId: e.jurisdictionId, segmentId: e.segmentId, ruleId: e.ruleId } });
  w.do("compliance", T("2027-07-02"), ident("auth-a", segA)).do("compliance", T("2027-07-02"), ident("auth-b", segB));
  assert.deepEqual(codes(w.gate("M4", T("2027-07-03"))), ["APPLICABILITY_INDETERMINATE", "APPLICABILITY_UNRESOLVED", "APPLICABILITY_UNRESOLVED"]);
  // Not applicable requires reviewer + rationale.
  assert.equal(w.err("analyst", T("2027-07-03"), { type: "authorization_applicability_set", authorizationId: "auth-b", applicability: "not applicable with rationale", basis: "bored at 0.9 m" }).code, "NOT_APPLICABLE_REQUIRES_REVIEWER");
  assert.equal(w.err("compliance", T("2027-07-03"), { type: "authorization_applicability_set", authorizationId: "auth-b", applicability: "not applicable with rationale", basis: "" }).code, "NOT_APPLICABLE_REQUIRES_REVIEWER");
  w.do("compliance", T("2027-07-03"), { type: "authorization_applicability_set", authorizationId: "auth-b", applicability: "not applicable with rationale", basis: "County B code §12 threshold 1.2 m; design depth 0.9 m (ev-route)" });
  w.do("compliance", T("2027-07-03"), { type: "authorization_applicability_set", authorizationId: "auth-a", applicability: "confirmed applicable", basis: "County A code" });
  w.evidence("ev-per01", T("2027-07-03")).do("compliance", T("2027-07-03"), { type: "procedure_step_completed", code: "PER-01", evidence: ["ev-per01"] });
  assert.deepEqual(codes(w.gate("M4", T("2027-07-04"))), ["AUTHORIZATION_NOT_ISSUED"]);
  for (const st of ["in preparation", "submitted", "under review"] as const) w.do("compliance", T("2027-08-01"), { type: "authorization_external_changed", authorizationId: "auth-a", state: st, evidence: [] });
  w.evidence("ev-permit-a", T("2027-10-01"));
  assert.equal(w.err("compliance", T("2027-10-01"), { type: "authorization_external_changed", authorizationId: "auth-a", state: "issued", evidence: ["ev-permit-a"], issuedAt: T("2027-10-01"), expiresAt: T("2028-07-01") }).code, "UNAUTHORIZED");
  assert.equal(w.err("verifier", T("2027-10-01"), { type: "authorization_external_changed", authorizationId: "auth-a", state: "issued", evidence: ["ev-permit-a"], issuedAt: T("2027-10-01") }).code, "MISSING_FIELD", "expiry must be explicit");
  w.do("verifier", T("2027-10-01"), { type: "authorization_external_changed", authorizationId: "auth-a", state: "issued", evidence: ["ev-permit-a"], issuedAt: T("2027-10-01"), expiresAt: T("2028-07-01") });
  assert.equal(w.gate("M4", T("2027-10-02")).status, "pass");
  // Permit expiry blocks.
  const exp = w.gate("M4", T("2028-07-02"));
  assert.deepEqual(codes(exp), ["AUTHORIZATION_EXPIRED"]);
  // Expired instruments are never extended in place.
  w.do("verifier", T("2028-07-02"), { type: "authorization_external_changed", authorizationId: "auth-a", state: "expired", evidence: [] });
  assert.equal(w.err("verifier", T("2028-07-03"), { type: "authorization_external_changed", authorizationId: "auth-a", state: "issued", evidence: ["ev-permit-a"], issuedAt: T("2028-07-03"), expiresAt: T("2029-07-01") }).code, "ILLEGAL_TRANSITION");
});

test("M4: unknown expiry is not perpetual; explicit non-expiring instrument with reason passes", () => {
  const w = m0(new W());
  w.do("design", T("2027-07-01"), { type: "baseline_recorded", baseline: { id: "bl-d", kind: "design", version: 1, content: {}, createdAt: T("2027-07-01"), supersedes: null } });
  w.do("compliance", T("2027-07-01"), { type: "authorization_identified", authorization: { id: "auth-bld", requirement: "Building permit", authority: "City", activity: "install", phase: "construction", jurisdictionId: "westminster" } });
  w.do("compliance", T("2027-07-01"), { type: "authorization_applicability_set", authorizationId: "auth-bld", applicability: "confirmed applicable", basis: "City code" });
  w.evidence("ev-per01", T("2027-07-01")).do("compliance", T("2027-07-01"), { type: "procedure_step_completed", code: "PER-01", evidence: ["ev-per01"] });
  for (const st of ["in preparation", "submitted", "under review"] as const) w.do("compliance", T("2027-07-02"), { type: "authorization_external_changed", authorizationId: "auth-bld", state: st, evidence: [] });
  w.evidence("ev-bld", T("2027-07-03"));
  w.do("verifier", T("2027-07-03"), { type: "authorization_external_changed", authorizationId: "auth-bld", state: "issued", evidence: ["ev-bld"], issuedAt: T("2027-07-03"), expiresAt: { state: "unknown", reason: "instrument silent on term" } });
  assert.deepEqual(codes(w.gate("M4", T("2027-07-04"))), ["EXPIRY_UNKNOWN"]);
  w.do("analyst", T("2027-07-05"), { type: "authorization_identified", authorization: { id: "auth-bld-2", requirement: "Building permit", authority: "City", activity: "install", phase: "construction", jurisdictionId: "westminster", supersedes: "auth-bld" } });
  w.do("compliance", T("2027-07-05"), { type: "authorization_applicability_set", authorizationId: "auth-bld-2", applicability: "confirmed applicable", basis: "City code" });
  for (const st of ["in preparation", "submitted", "under review"] as const) w.do("compliance", T("2027-07-05"), { type: "authorization_external_changed", authorizationId: "auth-bld-2", state: st, evidence: [] });
  w.do("verifier", T("2027-07-06"), { type: "authorization_external_changed", authorizationId: "auth-bld-2", state: "issued", evidence: ["ev-bld"], issuedAt: T("2027-07-06"), expiresAt: { state: "not_applicable", reason: "Instrument states no expiry; verified with City clerk" } });
  assert.equal(w.gate("M4", T("2027-07-07")).status, "pass", "superseded record drops out; explicit non-expiring passes");
  const w2 = m0(new W());
  w2.do("compliance", T("2027-07-01"), { type: "authorization_identified", authorization: { id: "x", requirement: "Utility agreement", authority: "SCE", activity: "interconnect", phase: "operations" } });
  w2.do("compliance", T("2027-07-01"), { type: "authorization_applicability_set", authorizationId: "x", applicability: "non-determination—authority/source unclear", basis: null });
  assert.deepEqual(codes(w2.gate("M4", T("2027-07-02"))), ["APPLICABILITY_UNRESOLVED"]);
});

test("M4: requirement set is not complete until PER-01 identifies every activity × phase × jurisdiction", () => {
  const w = m0(new W());
  w.do("design", T("2027-07-01"), { type: "baseline_recorded", baseline: { id: "bl-d", kind: "design", version: 1, content: {}, createdAt: T("2027-07-01"), supersedes: null } });
  const issue = (id: string, activity: string, phase: string, jurisdictionId: string, at: string) => {
    w.do("compliance", at, { type: "authorization_identified", authorization: { id, requirement: `${activity} instrument`, authority: jurisdictionId, activity, phase, jurisdictionId } });
    w.do("compliance", at, { type: "authorization_applicability_set", authorizationId: id, applicability: "confirmed applicable", basis: "code" });
    for (const st of ["in preparation", "submitted", "under review"] as const) w.do("compliance", at, { type: "authorization_external_changed", authorizationId: id, state: st, evidence: [] });
    w.evidence(`ev-${id}`, at).do("verifier", at, { type: "authorization_external_changed", authorizationId: id, state: "issued", evidence: [`ev-${id}`], issuedAt: at, expiresAt: T("2030-01-01") });
  };
  issue("auth-bld", "install", "construction", "westminster", T("2027-07-02"));
  // Every identified instrument issued, but no PER-01 completion: not ready, not pass.
  const before = w.gate("M4", T("2027-07-03"));
  assert.equal(before.status, "not_ready");
  assert.deepEqual(codes(before), []);
  assert.deepEqual(before.missingInputs, ["PER-01 authority and instrument identification (all instruments per activity × phase × jurisdiction)"]);
  w.evidence("ev-per01", T("2027-07-03")).do("compliance", T("2027-07-03"), { type: "procedure_step_completed", code: "PER-01", evidence: ["ev-per01"] });
  assert.equal(w.gate("M4", T("2027-07-04")).status, "pass");
  // A combination PER-01 did not cover (new activity/phase/jurisdiction) reopens completeness.
  issue("auth-ic", "interconnect", "operations", "sce-territory", T("2027-07-05"));
  const reopened = w.gate("M4", T("2027-07-06"));
  assert.equal(reopened.status, "not_ready");
  assert.deepEqual(reopened.missingInputs, [`PER-01 re-identification for interconnect × operations × sce-territory (first recorded after PER-01 completion at ${T("2027-07-03")})`]);
  w.do("compliance", T("2027-07-06"), { type: "procedure_step_completed", code: "PER-01", evidence: ["ev-per01"] });
  assert.equal(w.gate("M4", T("2027-07-07")).status, "pass", "repeated PER-01 covers the new combination");
  // With the procedure catalogue the missing PER-01 is a blocker as before (stricter, never pass).
  const w2 = m0(new W());
  w2.do("design", T("2027-07-01"), { type: "baseline_recorded", baseline: { id: "bl-d", kind: "design", version: 1, content: {}, createdAt: T("2027-07-01"), supersedes: null } });
  assert.ok(codes(w2.gate("M4", T("2027-07-02"), true)).includes("PROCEDURE_INCOMPLETE"));
});

// ---------------------------------------------------------------------------
// M5.

function m5Setup(w: W): W {
  return w.evidence("ev-lic-a", T("2027-11-01")).evidence("ev-lic-b", T("2027-11-01"))
    .do("contracting", T("2027-11-01"), { type: "supplier_registered", supplier: { id: "sup-a", name: "Supplier A", licenses: [{ class: "C-46 solar", jurisdictionId: "CA", expiresAt: T("2029-01-01"), evidenceId: "ev-lic-a" }] } })
    .do("contracting", T("2027-11-01"), { type: "supplier_registered", supplier: { id: "sup-b", name: "Supplier B", licenses: [{ class: "C-10 electrical", jurisdictionId: "CA", expiresAt: T("2029-01-01"), evidenceId: "ev-lic-b" }] } })
    .do("contracting", T("2027-11-02"), { type: "procurement_package_created", package: { id: "pkg-epc", scope: "Microgrid EPC incl. switchgear", requiredLicense: { class: "C-10 electrical", jurisdictionId: "CA" }, equipment: [{ id: "eq-swgr", model: "SWGR-1200A", supplierId: "sup-b", longLead: true, availability: "available", leadTimeDays: 120, evidence: [] }] } });
}

test("M5: award only after configured approvals; license mismatch rejected, alternate supplier awarded; execution required", () => {
  const w = m5Setup(m0(new W()));
  assert.deepEqual(codes(w.gate("M5", T("2027-11-03"))), ["NOT_AWARDED"]);
  w.do("design", T("2027-11-03"), { type: "procurement_approval_recorded", packageId: "pkg-epc", kind: "technical" });
  assert.equal(w.err("contracting", T("2027-11-04"), { type: "procurement_awarded", packageId: "pkg-epc", supplierId: "sup-b" }).code, "AWARD_BEFORE_APPROVALS");
  w.do("finance", T("2027-11-04"), { type: "procurement_approval_recorded", packageId: "pkg-epc", kind: "finance" });
  w.do("signatory", T("2027-11-04"), { type: "procurement_approval_recorded", packageId: "pkg-epc", kind: "legal" });
  assert.equal(w.err("analyst", T("2027-11-05"), { type: "procurement_awarded", packageId: "pkg-epc", supplierId: "sup-b" }).code, "UNAUTHORIZED");
  const mismatch = w.err("contracting", T("2027-11-05"), { type: "procurement_awarded", packageId: "pkg-epc", supplierId: "sup-a" });
  assert.equal(mismatch.code, "LICENSE_MISMATCH");
  w.do("contracting", T("2027-11-05"), { type: "procurement_awarded", packageId: "pkg-epc", supplierId: "sup-b" });
  assert.deepEqual(codes(w.gate("M5", T("2027-11-06"))), ["CONTRACT_NOT_EXECUTED"]);
  w.evidence("ev-contract", T("2027-11-20"));
  w.do("signatory", T("2027-11-20"), { type: "contract_executed", packageId: "pkg-epc", evidence: ["ev-contract"] });
  assert.equal(w.gate("M5", T("2027-11-21")).status, "pass");
  assert.deepEqual(codes(w.gate("M5", T("2029-01-02"))), ["LICENSE_EXPIRED"]);
});

test("M5: unavailable long-lead equipment blocks until an approved alternate is recorded by design authority", () => {
  const w = m5Setup(m0(new W()));
  for (const k of ["technical", "finance", "legal"]) w.do("contracting", T("2027-11-03"), { type: "procurement_approval_recorded", packageId: "pkg-epc", kind: k });
  w.do("contracting", T("2027-11-05"), { type: "procurement_awarded", packageId: "pkg-epc", supplierId: "sup-b" });
  w.evidence("ev-contract", T("2027-11-20")).do("signatory", T("2027-11-20"), { type: "contract_executed", packageId: "pkg-epc", evidence: ["ev-contract"] });
  w.evidence("ev-vendor-notice", T("2028-05-01"));
  w.do("contracting", T("2028-05-01"), { type: "equipment_availability_changed", packageId: "pkg-epc", equipmentId: "eq-swgr", availability: "unavailable", leadTimeDays: 232, evidence: ["ev-vendor-notice"] });
  assert.deepEqual(codes(w.gate("M5", T("2028-05-02"))), ["EQUIPMENT_UNAVAILABLE"]);
  assert.equal(w.err("contracting", T("2028-05-02"), { type: "equipment_substituted", packageId: "pkg-epc", equipmentId: "eq-swgr", model: "SWGR-ALT", supplierId: "sup-a" }).code, "UNAUTHORIZED");
  w.do("design", T("2028-05-03"), { type: "equipment_substituted", packageId: "pkg-epc", equipmentId: "eq-swgr", model: "SWGR-ALT", supplierId: "sup-a" });
  assert.equal(w.gate("M5", T("2028-05-04")).status, "pass");
});

// ---------------------------------------------------------------------------
// M6 / M7.

test("M6: critical NCR blocks until dispositioned and closed with evidence; unowned minor NCR blocks; sign-off required", () => {
  const w = m0(new W());
  w.do("quality", T("2028-04-01"), { type: "ncr_raised", ncr: { id: "ncr-5", severity: "critical", description: "Gasket mismatch on battery enclosure", owner: "EPC QA" } });
  w.evidence("ev-m6", T("2028-04-02")).do("ownerRep", T("2028-04-02"), { type: "gate_signoff", gate: "M6", evidence: ["ev-m6"] });
  assert.deepEqual(codes(w.gate("M6", T("2028-04-03"))), ["CRITICAL_NCR_OPEN"]);
  w.do("quality", T("2028-04-03"), { type: "ncr_status_changed", ncrId: "ncr-5", status: "contained" });
  assert.equal(w.err("analyst", T("2028-04-04"), { type: "ncr_status_changed", ncrId: "ncr-5", status: "dispositioned", disposition: "repair" }).code, "UNAUTHORIZED");
  assert.equal(w.err("quality", T("2028-04-04"), { type: "ncr_status_changed", ncrId: "ncr-5", status: "closed" }).code, "ILLEGAL_TRANSITION");
  w.do("quality", T("2028-04-04"), { type: "ncr_status_changed", ncrId: "ncr-5", status: "dispositioned", disposition: "Replace gasket per vendor spec" });
  assert.deepEqual(codes(w.gate("M6", T("2028-04-05"))), ["CRITICAL_NCR_OPEN"]);
  w.evidence("ev-ncr-close", T("2028-04-06"));
  assert.equal(w.err("quality", T("2028-04-06"), { type: "ncr_status_changed", ncrId: "ncr-5", status: "closed", evidence: [] }).code, "EVIDENCE_REQUIRED");
  w.do("quality", T("2028-04-06"), { type: "ncr_status_changed", ncrId: "ncr-5", status: "closed", evidence: ["ev-ncr-close"] });
  assert.equal(w.gate("M6", T("2028-04-07")).status, "pass");
  w.do("quality", T("2028-04-07"), { type: "ncr_raised", ncr: { id: "ncr-6", severity: "minor", description: "Label missing" } });
  assert.deepEqual(codes(w.gate("M6", T("2028-04-08"))), ["NCR_UNOWNED"]);
  const w2 = m0(new W());
  assert.equal(w2.gate("M6", T("2028-04-08")).status, "not_ready", "no sign-off");
});

function m7Base(w: W): W {
  w.do("ownerRep", T("2028-05-01"), { type: "asset_registered", asset: { id: "asset-bess", assetType: "BESS 1 MW / 4 MWh" } });
  w.evidence("ev-test-8", T("2028-06-01")).evidence("ev-m7", T("2028-06-01"));
  w.do("cx", T("2028-06-01"), { type: "test_result_recorded", result: { id: "TEST-8", testId: "islanding", stage: "commissioning", critical: true, outcome: "fail", executedAt: T("2028-06-01"), executor: "Cx agent", witness: "SCE", reviewedBy: "cx", retestOf: null, observed: "transfer exceeded 200 ms", evidence: ["ev-test-8"], deferral: null } });
  return w;
}

test("M7: failed test blocks; results are immutable; retest is a new linked result; deferred never passes; custodian required", () => {
  const w = m7Base(m0(new W()));
  w.do("cx", T("2028-06-02"), { type: "gate_signoff", gate: "M7", evidence: ["ev-m7"] });
  assert.deepEqual(codes(w.gate("M7", T("2028-06-02"))), ["NO_CUSTODIAN", "TEST_FAILED"]);
  const base = { testId: "islanding", stage: "commissioning" as const, critical: true, executor: "Cx agent", witness: "SCE", observed: null, evidence: ["ev-test-8"], deferral: null };
  assert.equal(w.err("cx", T("2028-06-03"), { type: "test_result_recorded", result: { ...base, id: "TEST-8", outcome: "pass", executedAt: T("2028-06-03"), reviewedBy: "cx", retestOf: null } }).code, "IMMUTABLE_RECORD");
  assert.equal(w.err("cx", T("2028-06-03"), { type: "test_result_recorded", result: { ...base, id: "TEST-9", outcome: "pass", executedAt: T("2028-06-03"), reviewedBy: "cx", retestOf: null } }).code, "RETEST_CHAIN");
  assert.equal(w.err("cx", T("2028-06-03"), { type: "test_result_recorded", result: { ...base, id: "TEST-9", outcome: "pass", executedAt: T("2028-06-03"), reviewedBy: "analyst", retestOf: "TEST-8" } }).code, "UNAUTHORIZED");
  w.do("cx", T("2028-06-03"), { type: "test_result_recorded", result: { ...base, id: "TEST-9", outcome: "pass", executedAt: T("2028-06-03"), reviewedBy: "cx", retestOf: "TEST-8" } });
  assert.equal(current(w.s.tests["TEST-8"])!.outcome, "fail", "failed result retained unchanged");
  w.do("ownerRep", T("2028-06-04"), { type: "asset_custodian_assigned", assetId: "asset-bess", custodian: "City facilities operations" });
  assert.equal(w.gate("M7", T("2028-06-05")).status, "pass");
  assert.equal(w.err("cx", T("2028-06-05"), { type: "test_result_recorded", result: { ...base, id: "TEST-10", testId: "48h-exercise", outcome: "deferred", executedAt: T("2028-06-05"), reviewedBy: null, retestOf: null } }).code, "MISSING_FIELD");
  w.do("cx", T("2028-06-05"), { type: "test_result_recorded", result: { ...base, id: "TEST-10", testId: "48h-exercise", outcome: "deferred", executedAt: T("2028-06-05"), reviewedBy: "cx", retestOf: null, deferral: { owner: "Emergency management", reviewAt: T("2028-09-01"), control: "Diesel rental on standby" } } });
  assert.deepEqual(codes(w.gate("M7", T("2028-06-06"))), ["TEST_DEFERRED"]);
});

// ---------------------------------------------------------------------------
// M8 / renewal.

test("M8: post-handover renewal opens a linked case referencing the immutable prior baseline", () => {
  const w = m0(new W());
  w.do("design", T("2028-06-10"), { type: "baseline_recorded", baseline: { id: "bl-ops-1", kind: "design", version: 1, content: { bess: "4 MWh", inverter: "INV-500" }, createdAt: T("2028-06-10"), supersedes: null } });
  const h0 = current(w.s.baselines["bl-ops-1"])!.contentHash;
  assert.equal(w.err("design", T("2028-06-11"), { type: "baseline_recorded", baseline: { id: "bl-ops-1", kind: "design", version: 2, content: { bess: "6 MWh" }, createdAt: T("2028-06-11"), supersedes: null } }).code, "IMMUTABLE_BASELINE");
  w.evidence("ev-condition", T("2040-01-10"));
  w.do("sponsor", T("2040-01-10"), { type: "decision_recorded", decision: { id: "dec-m8", gate: "M8", kind: "renewal", question: "Inverter/control renewal at year 12", owner: "asset manager", alternatives: [{ id: "renew", label: "Renew inverters", viable: true }], outcome: "proceed", rationale: "Warranted capacity below threshold", weights: {}, assumptions: [], evidence: ["ev-condition"], decidedAt: T("2040-01-10"), revisitAt: null } });
  w.do("sponsor", T("2040-01-11"), { type: "decision_signed", decisionId: "dec-m8", version: 1 });
  assert.deepEqual(codes(w.gate("M8", T("2040-01-12"))), ["RENEWAL_CASE_MISSING"]);
  assert.equal(w.err("sponsor", T("2040-01-12"), { type: "linked_case_opened", link: { caseId: "case-mg-renewal", relation: "renewal", fromBaselineId: "nope", trigger: "dec-m8", reason: "renewal" } }).code, "UNKNOWN_RECORD");
  w.do("sponsor", T("2040-01-12"), { type: "linked_case_opened", link: { caseId: "case-mg-renewal", relation: "renewal", fromBaselineId: "bl-ops-1", trigger: "dec-m8", reason: "Inverter renewal" } });
  assert.equal(w.gate("M8", T("2040-01-13")).status, "pass");
  assert.equal(current(w.s.baselines["bl-ops-1"])!.contentHash, h0, "old baseline unchanged");
  w.do("design", T("2040-01-14"), { type: "baseline_recorded", baseline: { id: "bl-ops-2", kind: "design", version: 2, content: { bess: "4 MWh", inverter: "INV-600" }, createdAt: T("2040-01-14"), supersedes: "bl-ops-1" } });
  assert.equal(w.s.baselines["bl-ops-1"].length, 1);
});

test("M8: retirement stop needs a linked decommissioning case or a recorded RET-01 closure path", () => {
  const retire = () => {
    const w = m0(new W());
    w.evidence("ev-eol", T("2050-01-10"));
    w.do("sponsor", T("2050-01-10"), { type: "decision_recorded", decision: { id: "dec-ret", gate: "M8", kind: "retirement", question: "Retire the BESS at end of life", owner: "asset manager", alternatives: [{ id: "retire", label: "Retire and restore site", viable: true }], outcome: "stop", rationale: "Capacity fade below service threshold; no economic renewal", weights: {}, assumptions: [], evidence: ["ev-eol"], decidedAt: T("2050-01-10"), revisitAt: null } });
    w.do("sponsor", T("2050-01-11"), { type: "decision_signed", decisionId: "dec-ret", version: 1 });
    return w;
  };
  const w = retire();
  const g = w.gate("M8", T("2050-01-12"));
  assert.equal(g.status, "blocked", "a signed stop alone does not pass M8");
  assert.deepEqual(codes(g), ["DECOMMISSIONING_CASE_MISSING"]);
  assert.equal(g.blockers[0].recordId, "dec-ret");
  // A renewal/replacement link is not a decommissioning case.
  w.do("sponsor", T("2050-01-12"), { type: "linked_case_opened", link: { caseId: "case-mg-replacement", relation: "replacement", fromBaselineId: null, trigger: "dec-ret", reason: "Replacement microgrid" } });
  assert.deepEqual(codes(w.gate("M8", T("2050-01-13"))), ["DECOMMISSIONING_CASE_MISSING"]);
  w.do("sponsor", T("2050-01-13"), { type: "linked_case_opened", link: { caseId: "case-mg-decom", relation: "decommissioning", fromBaselineId: null, trigger: "dec-ret", reason: "Stage 11 decommissioning and closure" } });
  assert.equal(w.gate("M8", T("2050-01-14")).status, "pass");

  // Alternative: this case documents its own closure path via RET-01.
  const w2 = retire();
  w2.evidence("ev-ret-case", T("2050-01-12")).do("sponsor", T("2050-01-12"), { type: "procedure_step_completed", code: "RET-01", evidence: ["ev-ret-case"] });
  assert.equal(w2.gate("M8", T("2050-01-13")).status, "pass");
  w2.do("analyst", T("2050-01-14"), { type: "evidence_recorded", evidence: { id: "ev-ret-case", kind: "document", title: "ev-ret-case", source: { publisher: "synthetic" }, retrievedAt: T("2050-01-12"), freshness: "stale", provenance: "owner_verified" } });
  assert.deepEqual(codes(w2.gate("M8", T("2050-01-15"))), ["EVIDENCE_STALE"], "RET-01 closure evidence is freshness-checked");

  // Retirement that is not a stop (hold) stays not final, unchanged.
  const w3 = m0(new W());
  w3.evidence("ev-eol", T("2050-01-10")).do("sponsor", T("2050-01-10"), { type: "decision_recorded", decision: { id: "dec-hold", gate: "M8", kind: "retirement", question: "Retire?", owner: "asset manager", alternatives: [], outcome: "hold", rationale: "await study", weights: {}, assumptions: [], evidence: ["ev-eol"], decidedAt: T("2050-01-10"), revisitAt: T("2050-06-01") } });
  w3.do("sponsor", T("2050-01-11"), { type: "decision_signed", decisionId: "dec-hold", version: 1 });
  assert.deepEqual(codes(w3.gate("M8", T("2050-01-12"))), ["DECISION_NOT_FINAL"]);
});

// ---------------------------------------------------------------------------
// M9.

test("M9: open obligation blocks closure; waiver needs authorized approver + reason; waived → pass", () => {
  const w = m0(new W());
  w.do("ownerRep", T("2041-01-01"), { type: "asset_registered", asset: { id: "asset-bess", assetType: "BESS" } });
  for (const st of ["validated", "in_service", "retired"] as const) w.do("ownerRep", T("2041-01-02"), { type: "asset_status_changed", assetId: "asset-bess", status: st });
  assert.equal(w.err("ownerRep", T("2041-01-02"), { type: "asset_status_changed", assetId: "asset-bess", status: "in_service" }).code, "ILLEGAL_TRANSITION");
  w.do("compliance", T("2041-01-03"), { type: "condition_recorded", condition: { id: "cond-recycle", sourceRecordId: "auth-fire", text: "Battery recycling receipt to fire authority", authority: "Fire authority", responsibleParty: "Facilities", dueAt: T("2041-03-01"), trigger: null, blocksGates: [] } });
  w.do("compliance", T("2041-01-03"), { type: "condition_recorded", condition: { id: "cond-site", sourceRecordId: "auth-city", text: "Site restoration inspection", authority: "City", responsibleParty: "Facilities", dueAt: T("2041-02-01"), trigger: null, blocksGates: ["M9"] } });
  w.evidence("ev-archive", T("2041-01-04")).do("custodian", T("2041-01-04"), { type: "gate_signoff", gate: "M9", evidence: ["ev-archive"] });
  assert.deepEqual(codes(w.gate("M9", T("2041-01-05"))), ["OBLIGATION_OPEN", "OBLIGATION_OPEN"]);
  assert.deepEqual(codes(w.gate("M9", T("2041-02-15"))), ["OBLIGATION_OPEN", "OBLIGATION_OVERDUE"]);
  w.evidence("ev-restoration", T("2041-01-20"));
  w.do("compliance", T("2041-01-20"), { type: "condition_status_changed", conditionId: "cond-site", status: "evidence_submitted", evidence: ["ev-restoration"] });
  assert.equal(w.err("analyst", T("2041-01-21"), { type: "condition_status_changed", conditionId: "cond-site", status: "verified", evidence: [] }).code, "UNAUTHORIZED");
  w.do("compliance", T("2041-01-21"), { type: "condition_status_changed", conditionId: "cond-site", status: "verified", evidence: [] });
  w.do("compliance", T("2041-01-22"), { type: "condition_closed", conditionId: "cond-site" });
  assert.deepEqual(codes(w.gate("M9", T("2041-01-23"))), ["OBLIGATION_OPEN"]);
  w.evidence("ev-waiver", T("2041-01-24"));
  assert.equal(w.err("analyst", T("2041-01-24"), { type: "condition_waived", conditionId: "cond-recycle", reason: "transferred", evidence: ["ev-waiver"] }).code, "WAIVER_REQUIRES_APPROVER");
  assert.equal(w.err("waiverAuth", T("2041-01-24"), { type: "condition_waived", conditionId: "cond-recycle", reason: " ", evidence: ["ev-waiver"] }).code, "WAIVER_REQUIRES_APPROVER");
  assert.equal(w.err("compliance", T("2041-01-24"), { type: "condition_closed", conditionId: "cond-recycle" }).code, "ILLEGAL_TRANSITION", "open obligation cannot be closed directly");
  w.do("waiverAuth", T("2041-01-24"), { type: "condition_waived", conditionId: "cond-recycle", reason: "Fire authority letter waives receipt: batteries transferred to vendor take-back", evidence: ["ev-waiver"] });
  assert.equal(w.gate("M9", T("2041-01-25")).status, "pass");
});

// ---------------------------------------------------------------------------
// Reducer integrity.

test("reducer: replaying the same event log yields an identical state hash; input state is never mutated", () => {
  const w = grantSetup(m0(new W()));
  const initial = createLifecycle({ caseId: "case-mg", title: "Westminster critical-facility microgrid (synthetic)", sector: "electric", config: CONFIG });
  const h0 = stateHash(initial);
  const a = replay(initial, w.s.log);
  const b = replay(initial, [...w.s.log]);
  assert.equal(stateHash(initial), h0, "initial untouched");
  assert.equal(stateHash(a), stateHash(b));
  assert.equal(stateHash(a), stateHash(w.s));
  const before = stateHash(w.s);
  w.do("finance", T("2027-03-10"), { type: "funding_status_changed", fundingId: "fs-grant", status: "inquiry", evidence: [] });
  assert.notEqual(stateHash(w.s), before);
  assert.equal(stateHash(replay(initial, w.s.log.slice(0, -1))), before);
});

test("reducer: duplicate event id, out-of-order time, and offset-less timestamps are rejected", () => {
  const w = m0(new W());
  const last = w.s.log[w.s.log.length - 1];
  assert.throws(() => applyEvent(w.s, last), (e: unknown) => e instanceof LifecycleError && e.code === "DUPLICATE_EVENT");
  assert.throws(() => applyEvent(w.s, { id: "late", at: T("2020-01-01"), actor: "triage", type: "next_action_set", nextAction: "x", nextActionDate: T("2027-01-01") }), (e: unknown) => e instanceof LifecycleError && e.code === "OUT_OF_ORDER");
  assert.throws(() => applyEvent(w.s, { id: "noz", at: "2027-01-01T00:00:00", actor: "triage", type: "next_action_set", nextAction: "x", nextActionDate: T("2027-01-01") }), (e: unknown) => e instanceof LifecycleError && e.code === "INVALID_TIME");
  assert.throws(() => applyEvent(w.s, { id: "bad", at: T("2027-01-01"), actor: "triage", type: "nope" } as unknown as LifecycleEvent), (e: unknown) => e instanceof LifecycleError && e.code === "ILLEGAL_TRANSITION");
  w.do("analyst", T("2027-01-02"), { type: "fact_recorded", fact: { id: "f1", subject: "case-mg", predicate: "peak_kw", value: 500, unit: "kW", provenance: "user_assertion", evidence: [], asOf: T("2027-01-02") } });
  w.do("analyst", T("2027-01-03"), { type: "fact_recorded", fact: { id: "f2", subject: "case-mg", predicate: "peak_kw", value: 520, unit: "kW", provenance: "owner_verified", evidence: [], asOf: T("2027-01-03"), supersedes: "f1" } });
  assert.equal(w.err("analyst", T("2027-01-04"), { type: "fact_recorded", fact: { id: "f3", subject: "case-mg", predicate: "peak_kw", value: 1, provenance: "model", evidence: [], asOf: T("2027-01-04"), supersedes: "f1" } }).code, "SUPERSEDES_INVALID");
  assert.equal(w.err("analyst", T("2027-01-04"), { type: "fact_recorded", fact: { id: "f2", subject: "case-mg", predicate: "peak_kw", value: 1, provenance: "model", evidence: [], asOf: T("2027-01-04") } }).code, "DUPLICATE_RECORD");
});

test("procedures: required steps at a gate are consumed generically; non-required steps never count; completion clears them", () => {
  const w = m0(new W());
  const steps = PROCEDURES.filter((p) => p.gate === "M0");
  const required = steps.filter((st) => gatingOf(st) === "required");
  assert.ok(required.length > 0);
  const g = w.gate("M0", T("2026-12-03"), true);
  assert.notEqual(g.status, "pass");
  assert.deepEqual(g.blockers.filter((b) => b.code === "PROCEDURE_INCOMPLETE").map((b) => b.recordId), required.filter((st) => st.blocksGateOn?.length).map((st) => st.code).sort());
  assert.deepEqual(g.missingInputs.filter((m) => m.startsWith("procedure ")).map((m) => m.split(" ")[1]).sort(), required.filter((st) => !st.blocksGateOn?.length).map((st) => st.code).sort());
  for (const st of steps.filter((x) => gatingOf(x) !== "required")) assert.ok(!JSON.stringify(g).includes(st.code), `${st.code} (${gatingOf(st)}) must not affect M0`);
  w.evidence("ev-proc", T("2026-12-03"));
  for (const st of required) w.do("triage", T("2026-12-03"), { type: "procedure_step_completed", code: st.code, evidence: ["ev-proc"] });
  assert.equal(w.gate("M0", T("2026-12-04"), true).status, "pass");
});

// ---------------------------------------------------------------------------
// Gating modes, triggers, liveness.

test("stage<->gate mapping has one source: GATE_STAGE derives from STAGE_GATE; grants reach no gate", () => {
  for (const g of GATES) assert.deepEqual(GATE_STAGE[g], Object.keys(STAGE_GATE).filter((st) => STAGE_GATE[st as keyof typeof STAGE_GATE] === g));
  assert.deepEqual(GATE_STAGE.M3, ["capital"]);
  assert.ok(!Object.values(GATE_STAGE).flat().includes("grants"));
  for (const st of PROCEDURES.filter((p) => p.stage === "grants")) assert.ok(st.gate === undefined || st.gateOverride, `${st.code} grants step reaches a gate only by doc override`);
});

test("trigger_evaluated: only allowlisted triggers, basis required; revisions append; status reflects the latest", () => {
  const w = m0(new W());
  assert.equal(w.err("triage", T("2026-12-03"), { type: "trigger_evaluated", trigger: "trigger.nope", active: true, basis: "x", evidence: [] }).code, "UNKNOWN_TRIGGER");
  assert.equal(w.err("triage", T("2026-12-03"), { type: "trigger_evaluated", trigger: "gate.M5", active: true, basis: "x", evidence: [] }).code, "UNKNOWN_TRIGGER", "gate rules are not triggers");
  assert.equal(w.err("triage", T("2026-12-03"), { type: "trigger_evaluated", trigger: "trigger.emergency", active: false, basis: " ", evidence: [] }).code, "MISSING_FIELD");
  assert.equal(triggerStatus(w.s, "trigger.emergency"), "not_evaluated");
  w.do("triage", T("2026-12-03"), { type: "trigger_evaluated", trigger: "trigger.emergency", active: false, basis: "routine urgency", evidence: ["ev-intake"] });
  assert.equal(triggerStatus(w.s, "trigger.emergency"), "not_active");
  w.do("triage", T("2026-12-04"), { type: "trigger_evaluated", trigger: "trigger.emergency", active: true, basis: "re-triaged: hazard", evidence: ["ev-intake"] });
  assert.equal(triggerStatus(w.s, "trigger.emergency"), "active");
  assert.equal(w.s.triggers["trigger.emergency"].length, 2, "evaluations are appended, not overwritten");
});

test("evaluation-required trigger: an unevaluated emergency trigger is a missing M1 input; other unevaluated triggers are not", () => {
  const c = completedLifecycleCase("microgrid");
  const strip = (b: LivenessCase["batches"][number]) => b.events.filter((e) => e.type !== "trigger_evaluated");
  let s = c.initial;
  for (const b of c.batches.slice(0, 2)) s = replay(s, strip(b));
  const g = evaluateGate(s, "M1", c.batches[1].asOf, { procedures: [...PROCEDURES] });
  assert.equal(g.status, "not_ready");
  assert.deepEqual(g.missingInputs, ["trigger trigger.emergency not evaluated (decides whether DEV-02 Emergency coordination and stabilization record applies)"]);
  assert.equal(RULE_IDS["trigger.assurance_configured"].evaluationRequired, undefined);
  assert.ok(!g.missingInputs.some((m) => m.includes("DEV-16")), "assurance trigger is owner-configured; unevaluated means not active");
});

function replayTo(c: LivenessCase, gate: GateId): { s: LifecycleState; asOf: string } {
  let s = c.initial;
  for (const b of c.batches) {
    s = replay(s, b.events);
    if (b.gate === gate) return { s, asOf: b.asOf };
  }
  throw new Error(gate);
}

for (const id of LIVENESS_CASE_IDS) {
  test(`liveness (${id}): a fully completed log passes M0..M9 in order; completions follow catalog preconditions and gate rules`, () => {
    const c = completedLifecycleCase(id);
    assert.deepEqual(c.batches.map((b) => b.gate), [...GATES]);
    let s = c.initial;
    const procs = [...PROCEDURES];
    for (const b of c.batches) {
      for (const ev of b.events) {
        if (ev.type === "procedure_step_completed") {
          const step = procedureByCode(ev.code)!;
          assert.equal(gatingOf(step) === "non_gating", false, `${ev.code} is non-gating and must not be needed`);
          for (const pre of preconditionCodes(step, false)) assert.ok(current(s.procedures[pre]), `${ev.code} completed before its precondition ${pre}`);
          for (const rule of step.preconditions.filter((x) => x.startsWith("gate."))) {
            assert.equal(evaluateGate(s, rule.slice(5) as GateId, ev.at, { procedures: procs }).status, "pass", `${ev.code} needs ${rule} passed first`);
          }
        }
        s = applyEvent(s, ev);
      }
      const g = evaluateGate(s, b.gate, b.asOf, { procedures: procs });
      assert.equal(g.status, "pass", `${id} ${b.gate}: ${JSON.stringify({ blockers: g.blockers, missing: g.missingInputs })}`);
    }
    // No trigger was active and no non-gating step was completed.
    for (const t of TRIGGER_IDS) assert.notEqual(triggerStatus(s, t), "active", t);
    for (const st of PROCEDURES.filter((p) => gatingOf(p) === "non_gating")) assert.equal(current(s.procedures[st.code]), undefined, st.code);
    // Deterministic: replaying the whole log twice gives the same state.
    const all = c.batches.flatMap((b) => b.events);
    assert.equal(stateHash(replay(c.initial, all)), stateHash(replay(c.initial, JSON.parse(JSON.stringify(all)) as LifecycleEvent[])));
    assert.equal(stateHash(replay(c.initial, all)), stateHash(s));
  });

  test(`liveness (${id}): partial cases stay blocked/not ready with their missing inputs listed`, () => {
    const c = completedLifecycleCase(id);
    const procs = [...PROCEDURES];
    let before = c.initial;
    for (const b of c.batches) {
      // (a) nothing recorded for this gate yet
      const g0 = evaluateGate(before, b.gate, b.asOf, { procedures: procs });
      assert.notEqual(g0.status, "pass", `${b.gate} passed with none of its records`);
      assert.ok(g0.blockers.length + g0.missingInputs.length > 0, `${b.gate} gave no reason`);
      // (b) domain records present, catalog completions withheld: every required step is named
      const partial = replay(before, b.events.filter((e) => e.type !== "procedure_step_completed"));
      const g1 = evaluateGate(partial, b.gate, b.asOf, { procedures: procs });
      const required = PROCEDURES.filter((p) => p.gate === b.gate && gatingOf(p) === "required" && !current(before.procedures[p.code]));
      assert.ok(required.length > 0, b.gate);
      assert.notEqual(g1.status, "pass", `${b.gate} passed without its required procedures`);
      for (const st of required) {
        const named = g1.blockers.some((x) => x.recordId === st.code) || g1.missingInputs.some((m) => m.startsWith(`procedure ${st.code} `));
        assert.ok(named, `${b.gate}: ${st.code} not listed as blocker or missing input`);
      }
      before = replay(before, b.events);
    }
  });
}

test("conditional steps: activating each trigger holds its gate until that procedure completes (after the activation)", () => {
  const c = completedLifecycleCase("microgrid");
  const procs = [...PROCEDURES];
  const conditional = PROCEDURES.filter((p) => gatingOf(p) === "conditional");
  assert.equal(conditional.length, 12);
  for (const st of conditional) {
    const { s, asOf } = replayTo(c, st.gate!);
    let n = 0;
    const ev = (body: Payload): LifecycleEvent => ({ ...(body as object), id: `cond.${st.code}.${++n}`, at: asOf, actor: "ownerRep" } as LifecycleEvent);
    assert.equal(evaluateGate(s, st.gate!, asOf, { procedures: procs }).status, "pass", `${st.code}: baseline ${st.gate}`);
    let t = applyEvent(s, ev({ type: "trigger_evaluated", trigger: st.trigger!, active: true, basis: `${st.trigger} recorded`, evidence: [] }));
    const held = evaluateGate(t, st.gate!, asOf, { procedures: procs });
    assert.equal(held.status, st.blocksGateOn?.length ? "blocked" : "not_ready", `${st.code} active trigger must hold ${st.gate}`);
    assert.ok(held.blockers.some((b) => b.recordId === st.code) || held.missingInputs.some((m) => m.startsWith(`procedure ${st.code} `)), `${st.code} not named`);
    t = applyEvent(t, ev({ type: "evidence_recorded", evidence: { id: `ev.cond.${st.code}`, kind: "document", title: st.code, source: { publisher: "synthetic" }, retrievedAt: asOf, freshness: "fresh", provenance: "owner_verified" } }));
    t = applyEvent(t, ev({ type: "procedure_step_completed", code: st.code, evidence: [`ev.cond.${st.code}`] }));
    assert.equal(evaluateGate(t, st.gate!, asOf, { procedures: procs }).status, "pass", `${st.code} completion must clear ${st.gate}`);
    // A later re-activation (new trigger event) requires a new completion.
    t = applyEvent(t, ev({ type: "trigger_evaluated", trigger: st.trigger!, active: true, basis: "second occurrence", evidence: [] }));
    const again = evaluateGate(t, st.gate!, asOf, { procedures: procs });
    assert.notEqual(again.status, "pass", `${st.code}: completion before re-activation must not count`);
    assert.ok(JSON.stringify(again).includes("predates it"));
    // Evaluated not active -> ignored again.
    t = applyEvent(t, ev({ type: "trigger_evaluated", trigger: st.trigger!, active: false, basis: "closed", evidence: [] }));
    assert.equal(evaluateGate(t, st.gate!, asOf, { procedures: procs }).status, "pass");
  }
});

test("DEV-17 utility conflicts: with the trigger active M2 passes without DEV-17; M4 is held until DEV-17 completes", () => {
  const c = completedLifecycleCase("microgrid");
  const procs = [...PROCEDURES];
  assert.equal(procedureByCode("DEV-17")!.gate, "M4");
  let s = c.initial;
  for (const b of c.batches.slice(0, 3)) s = replay(s, b.events); // M0..M2
  const m2At = c.batches[2].asOf;
  s = applyEvent(s, { id: "uc.1", at: m2At, actor: "ownerRep", type: "trigger_evaluated", trigger: "trigger.utility_conflict", active: true, basis: "Feeder trench crosses a gas main (synthetic)", evidence: [] });
  const m2 = evaluateGate(s, "M2", m2At, { procedures: procs });
  assert.equal(m2.status, "pass", JSON.stringify(m2));
  assert.ok(!JSON.stringify(m2).includes("DEV-17"));
  for (const b of c.batches.slice(3, 5)) s = replay(s, b.events); // M3, M4 (DEV-17 not completed)
  const m4At = c.batches[4].asOf;
  const held = evaluateGate(s, "M4", m4At, { procedures: procs });
  assert.equal(held.status, "not_ready");
  assert.deepEqual(held.blockers, []);
  assert.ok(held.missingInputs.some((m) => m.startsWith("procedure DEV-17 ") && m.includes("trigger.utility_conflict is active")), JSON.stringify(held.missingInputs));
  s = applyEvent(s, { id: "uc.2", at: m4At, actor: "analyst", type: "evidence_recorded", evidence: { id: "ev.uc", kind: "document", title: "Conflict register with dispositions", source: { publisher: "synthetic" }, retrievedAt: m4At, freshness: "fresh", provenance: "owner_verified" } });
  s = applyEvent(s, { id: "uc.3", at: m4At, actor: "ownerRep", type: "procedure_step_completed", code: "DEV-17", evidence: ["ev.uc"] });
  assert.equal(evaluateGate(s, "M4", m4At, { procedures: procs }).status, "pass");
  assert.equal(evaluateGate(s, "M2", m4At, { procedures: procs }).status, "pass");
});

test("non-gating steps never block: the completed log leaves them undone; explicit not-active triggers change nothing; DEV-18 is a warning only", () => {
  const c = completedLifecycleCase("substation");
  const procs = [...PROCEDURES];
  const nonGating = PROCEDURES.filter((p) => gatingOf(p) === "non_gating").map((p) => p.code);
  assert.deepEqual([...nonGating].sort(), ["CAP-04", "DEV-15", "DEV-18", "GR-01", "GR-02", "GR-03", "GR-04", "PROC-05", "PROC-06", "PROC-07", "RET-05"]);
  let s = c.initial;
  for (const b of c.batches) {
    s = replay(s, b.events);
    let k = 0;
    const off = TRIGGER_IDS.map((t): LifecycleEvent => ({ id: `off.${b.gate}.${++k}`, at: b.asOf, actor: "ownerRep", type: "trigger_evaluated", trigger: t, active: false, basis: "evaluated, not present", evidence: [] }));
    const g = evaluateGate(replay(s, off), b.gate, b.asOf, { procedures: procs });
    assert.equal(g.status, "pass", b.gate);
    for (const code of nonGating) assert.ok(!g.blockers.some((x) => x.recordId === code) && !g.missingInputs.some((m) => m.includes(code)), `${code} affected ${b.gate}`);
    if (b.gate === "M4") assert.deepEqual(g.warnings, ["DEV-18 Seasonal, staged, and fallback delivery planning not accepted; gate at risk (Unverified fallback (gate kept at risk))"]);
    else assert.deepEqual(g.warnings, []);
  }
});

test("coverage: every reducer event type is exercised by this suite", () => {
  const missing = EVENT_TYPES.filter((t) => !USED.has(t));
  assert.deepEqual(missing, []);
});
