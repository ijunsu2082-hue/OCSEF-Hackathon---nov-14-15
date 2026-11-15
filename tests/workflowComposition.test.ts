import test from "node:test";
import assert from "node:assert/strict";
import { composeWorkflow, COMPOSED_STAGE_ORDER } from "../lib/ownerPlan/compose";
import type { AuthorizationTrack, FundingCandidate, OwnerCandidate, OwnerPlan, OwnerRule, OwnerTask } from "../lib/ownerPlan";

const rule: OwnerRule = { id: "rule:owner-check", label: "Confirm responsible owner", description: "Owner confirmation required.", required: ["owner record"], evidence: [] };
function task(id: string, dependsOn: string[] = []): OwnerTask {
  return { id, title: id, role: "Owner", dependsOn, offsetDays: 0, inputs: [], output: `${id} record`, evidence: [], recovery: "Keep unresolved until reviewed." };
}
function candidate(id: string, kind: OwnerCandidate["kind"], tasks: OwnerTask[], rules: OwnerRule[] = [rule]): OwnerCandidate {
  return { id, kind, title: id, summary: "Screening summary.", tradeoff: "Unknowns remain.", evidence: [], provenance: [], confidence: "low", confidenceScore: 0.2, usefulness: 1, rules, dependencies: [], tasks };
}
function plan(): OwnerPlan {
  const intervention = candidate("intervention:microgrid-storage", "intervention", [task("task:intervention:one"), task("task:intervention:two", ["task:intervention:one"]) ]);
  const openFunding = { ...candidate("funding:open", "funding", [task("task:funding:check" )]), url: "https://example.test/open", status: "open", deadline: null, applicability: "Verify fit." } as FundingCandidate;
  const closedFunding = { ...candidate("funding:closed", "funding", [task("task:funding:closed:prepare")]), url: "https://example.test/closed", status: "closed", deadline: null, applicability: "Closed notice." } as FundingCandidate;
  const authorization = { ...candidate("authorization:permit", "authorization", [task("task:authorization:check")]), authority: "Responsible authority" } as AuthorizationTrack;
  const lifecycle = COMPOSED_STAGE_ORDER.map((id, index) => ({
    id,
    title: id,
    description: `${id} description`,
    gate: `${id} gate`,
    evidence: [],
    owner: "Asset owner",
    tasks: [task(`lifecycle:${id}`, index ? [`lifecycle:${COMPOSED_STAGE_ORDER[index - 1]}`] : [])],
  }));
  return { interventions: [intervention], funding: [openFunding, closedFunding], authorizations: [authorization], lifecycle, rules: [rule] } as unknown as OwnerPlan;
}

test("composes stable screen-to-retire DAG with unresolved checks and no optional branches", () => {
  const source = plan();
  const composed = composeWorkflow(source, { interventionId: "intervention:microgrid-storage" });
  const repeated = composeWorkflow(source, { interventionId: "intervention:microgrid-storage" });
  assert.equal(composed.isValid, true, composed.errors.join("; "));
  assert.equal(composed.id, repeated.id);
  assert.deepEqual(composed.orderedTaskIds, repeated.orderedTaskIds);
  assert.deepEqual(composed.stages.map((stage) => stage.id), [...COMPOSED_STAGE_ORDER]);
  assert.ok(composed.tasks.some((item) => item.id === "task:intervention:one"));
  assert.ok(composed.tasks.some((item) => item.id === "verify:intervention:microgrid-storage:rule:owner-check"));
  const develop = composed.tasks.find((item) => item.id === "lifecycle:develop")!;
  assert.ok(develop.dependsOn.includes("verify:intervention:microgrid-storage:rule:owner-check"));
  assert.ok(composed.tasks.find((item) => item.id === "verify:intervention:microgrid-storage:rule:owner-check")?.dependsOn.includes("task:intervention:two"));
  assert.ok(composed.orderedTaskIds.indexOf("lifecycle:screen") < composed.orderedTaskIds.indexOf("lifecycle:develop"));
  assert.ok(composed.orderedTaskIds.indexOf("lifecycle:develop") < composed.orderedTaskIds.indexOf("lifecycle:retire"));
  assert.equal(composed.modules.some((item) => item.kind === "funding" || item.kind === "authorization"), false);
});

test("optional open funding and explicit authorization branches join before development", () => {
  const composed = composeWorkflow(plan(), {
    interventionId: "intervention:microgrid-storage",
    fundingId: "funding:open",
    authorizationIds: ["authorization:permit"],
  });
  assert.equal(composed.isValid, true, composed.errors.join("; "));
  assert.ok(composed.modules.find((item) => item.id === "funding:open")?.gate.includes("does not establish eligibility or an award"));
  assert.ok(composed.modules.find((item) => item.id === "authorization:permit")?.gate.includes("does not assert approval"));
  const develop = composed.tasks.find((item) => item.id === "lifecycle:develop")!;
  const fundingVerify = composed.tasks.find((item) => item.branchKind === "verification" && item.sourceId === "funding:open")!;
  const authorizationVerify = composed.tasks.find((item) => item.branchKind === "verification" && item.sourceId === "authorization:permit")!;
  assert.ok(develop.dependsOn.includes(fundingVerify.id));
  assert.ok(develop.dependsOn.includes(authorizationVerify.id));
  assert.ok(fundingVerify.dependsOn.includes("task:funding:check"));
  assert.ok(authorizationVerify.dependsOn.includes("task:authorization:check"));
});

test("closed funding stays a verification branch and does not include preparation tasks", () => {
  const composed = composeWorkflow(plan(), { interventionId: "intervention:microgrid-storage", fundingId: "funding:closed" });
  assert.equal(composed.isValid, true, composed.errors.join("; "));
  assert.equal(composed.modules.find((item) => item.id === "funding:closed")?.status, "closed");
  assert.ok(composed.tasks.some((item) => item.id === "verify:funding:closed:funding-status"));
  assert.equal(composed.tasks.some((item) => item.id === "task:funding:closed:prepare"), false);
});

test("empty selection and cyclic module paths fail validation", () => {
  assert.equal(composeWorkflow(plan(), { interventionId: "" }).isValid, false);
  const missing = plan();
  missing.interventions[0].tasks = [task("broken", ["not-present"])];
  const missingResult = composeWorkflow(missing, { interventionId: "intervention:microgrid-storage" });
  assert.equal(missingResult.isValid, false);
  assert.ok(missingResult.errors.some((error) => error.includes("missing task")));
  const cyclic = plan();
  cyclic.interventions[0].tasks = [task("cycle:a", ["cycle:b"]), task("cycle:b", ["cycle:a"])] as OwnerTask[];
  const result = composeWorkflow(cyclic, { interventionId: "intervention:microgrid-storage" });
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((error) => error.includes("cycle")));
});
