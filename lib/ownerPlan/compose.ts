import {
  evaluateRules,
  type AuthorizationTrack,
  type FundingCandidate,
  type OwnerCandidate,
  type OwnerPlan,
  type OwnerTask,
  type RuleStatus,
  type TriState,
} from "./index";

export const COMPOSED_STAGE_ORDER = ["screen", "develop", "procure", "commission", "operate", "retire"] as const;
export type ComposedStageId = (typeof COMPOSED_STAGE_ORDER)[number];
export type ComposedBranchKind = "lifecycle" | "intervention" | "funding" | "authorization" | "verification";

export interface ComposedWorkflowTask extends OwnerTask {
  stageId: ComposedStageId;
  sourceId: string;
  branchKind: ComposedBranchKind;
  verification?: { candidateId: string; ruleId: string; status: Exclude<RuleStatus, "pass">; missing: string[] };
}

export interface ComposedWorkflowStage {
  id: ComposedStageId;
  title: string;
  description: string;
  gate: string;
  evidence: string[];
  owner: string;
  taskIds: string[];
}

export interface ComposedWorkflowModule {
  id: string;
  kind: "intervention" | "funding" | "authorization";
  title: string;
  gate: string;
  status?: FundingCandidate["status"];
}

export interface ComposedWorkflow {
  id: string;
  modules: ComposedWorkflowModule[];
  stages: ComposedWorkflowStage[];
  tasks: ComposedWorkflowTask[];
  orderedTaskIds: string[];
  errors: string[];
  isValid: boolean;
}

export interface WorkflowSelection {
  interventionId: string;
  fundingId?: string | null;
  authorizationIds?: string[];
  /** User-recorded answers affect verification tasks only; they do not represent agency or funding approval. */
  answers?: Record<string, TriState>;
}

const VERIFY_ROLE = "Responsible owner";
const fundingGate = "Verify the current notice, applicant fit, deadline, and terms; selection does not establish eligibility or an award.";
const authorizationGate = "Track the responsible authority and required approvals; selection does not assert approval.";

function emptyResult(errors: string[]): ComposedWorkflow {
  return { id: "workflow:invalid", modules: [], stages: [], tasks: [], orderedTaskIds: [], errors, isValid: false };
}

function verificationTask(candidate: OwnerCandidate, ruleId: string, label: string, status: Exclude<RuleStatus, "pass">, missing: string[]): ComposedWorkflowTask {
  const lower = status === "fail" ? "Resolve failed check" : "Verify";
  return {
    id: `verify:${candidate.id}:${ruleId}`,
    title: `${lower}: ${label}`,
    role: VERIFY_ROLE,
    dependsOn: [],
    offsetDays: 0,
    inputs: missing.length ? [...missing] : [label],
    output: "Dated evidence or an explicit unresolved status; do not infer a pass.",
    evidence: [],
    recovery: "Keep the gate open until the responsible owner records supporting evidence and reviewer disposition.",
    stageId: "develop",
    sourceId: candidate.id,
    branchKind: "verification",
    verification: { candidateId: candidate.id, ruleId, status, missing: [...missing] },
  };
}

function ruleVerifications(plan: OwnerPlan, candidate: OwnerCandidate, answers: Record<string, TriState>): ComposedWorkflowTask[] {
  const result = evaluateRules(plan, answers, candidate.id);
  const labels = new Map(candidate.rules.map((item) => [item.id, item.label]));
  return result.evaluations.flatMap((item) => item.status === "pass" ? [] : [
    verificationTask(candidate, item.ruleId, labels.get(item.ruleId) ?? item.ruleId, item.status, item.missing),
  ]);
}

function candidateTasks(candidate: OwnerCandidate, kind: Exclude<ComposedBranchKind, "lifecycle" | "verification">): ComposedWorkflowTask[] {
  return candidate.tasks.map((item) => ({
    ...item,
    dependsOn: [...item.dependsOn],
    inputs: [...item.inputs],
    evidence: [...item.evidence],
    stageId: "develop",
    sourceId: candidate.id,
    branchKind: kind,
  }));
}

/** Find a stable join set: module tasks with no downstream task in that branch. */
function branchLeaves(tasks: ComposedWorkflowTask[]): string[] {
  const used = new Set(tasks.flatMap((item) => item.dependsOn));
  return tasks.filter((item) => !used.has(item.id)).map((item) => item.id).sort();
}

function graphOrder(tasks: ComposedWorkflowTask[]): { order: string[]; errors: string[] } {
  const errors: string[] = [];
  const byId = new Map<string, ComposedWorkflowTask>();
  tasks.forEach((item) => {
    if (byId.has(item.id)) errors.push(`duplicate task id ${item.id}`);
    else byId.set(item.id, item);
  });
  for (const item of tasks) for (const dependency of item.dependsOn) {
    if (!byId.has(dependency)) errors.push(`${item.id} depends on missing task ${dependency}`);
    if (item.id === dependency) errors.push(`${item.id} depends on itself`);
  }
  if (errors.length) return { order: [], errors };

  const indegree = new Map(tasks.map((item) => [item.id, item.dependsOn.length]));
  const next = new Map<string, string[]>();
  for (const item of tasks) for (const dependency of item.dependsOn) {
    const successors = next.get(dependency) ?? [];
    successors.push(item.id);
    next.set(dependency, successors);
  }
  const orderIndex = new Map(tasks.map((item, index) => [item.id, index]));
  const ready = tasks.filter((item) => indegree.get(item.id) === 0).map((item) => item.id);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => orderIndex.get(a)! - orderIndex.get(b)! || a.localeCompare(b));
    const id = ready.shift()!;
    order.push(id);
    for (const successor of next.get(id) ?? []) {
      const count = indegree.get(successor)! - 1;
      indegree.set(successor, count);
      if (count === 0) ready.push(successor);
    }
  }
  return order.length === tasks.length
    ? { order, errors }
    : { order: [], errors: ["composed workflow contains a dependency cycle"] };
}

/** Compose one intervention, optional funding, and selected approval tracks into one auditable lifecycle DAG. */
export function composeWorkflow(plan: OwnerPlan, selection: WorkflowSelection): ComposedWorkflow {
  const errors: string[] = [];
  const intervention = plan.interventions.find((item) => item.id === selection.interventionId);
  if (!intervention) return emptyResult(["Select one known intervention to compose a workflow."]);

  const funding: FundingCandidate | null = selection.fundingId
    ? plan.funding.find((item) => item.id === selection.fundingId) ?? null
    : null;
  if (selection.fundingId && !funding) errors.push(`unknown funding candidate ${selection.fundingId}`);

  const authorizationIds = selection.authorizationIds ?? [];
  if (new Set(authorizationIds).size !== authorizationIds.length) errors.push("duplicate authorization track selection");
  const authorizations: AuthorizationTrack[] = [...authorizationIds].sort().flatMap((id) => {
    const candidate = plan.authorizations.find((item) => item.id === id);
    if (!candidate) errors.push(`unknown authorization track ${id}`);
    return candidate ? [candidate] : [];
  });

  const stagesById = new Map(plan.lifecycle.map((stage) => [stage.id, stage]));
  for (const id of COMPOSED_STAGE_ORDER) if (!stagesById.has(id)) errors.push(`missing lifecycle stage ${id}`);
  if (errors.length) return emptyResult(errors);

  const screenTaskId = stagesById.get("screen")!.tasks[0]?.id;
  const stageOrder: ComposedStageId[] = [...COMPOSED_STAGE_ORDER];
  const stageTasks = new Map<ComposedStageId, ComposedWorkflowTask[]>();
  for (const id of stageOrder) stageTasks.set(id, []);

  for (const id of stageOrder) {
    for (const item of stagesById.get(id)!.tasks) {
      const dependsOn = id === "develop" ? [] : [...item.dependsOn];
      stageTasks.get(id)!.push({
        ...item,
        dependsOn,
        inputs: [...item.inputs],
        evidence: [...item.evidence],
        stageId: id,
        sourceId: `lifecycle:${id}`,
        branchKind: "lifecycle",
      });
    }
  }

  const modules: ComposedWorkflowModule[] = [{
    id: intervention.id, kind: "intervention", title: intervention.title,
    gate: "Complete owner verification before the lifecycle development gate; no feasibility or approval is implied.",
  }];
  const branches: ComposedWorkflowTask[][] = [];

  const interventionTasks = candidateTasks(intervention, "intervention");
  const interventionChecks = ruleVerifications(plan, intervention, selection.answers ?? {});
  for (const check of interventionChecks) check.dependsOn = branchLeaves(interventionTasks);
  branches.push([...interventionTasks, ...interventionChecks]);

  if (funding) {
    modules.push({ id: funding.id, kind: "funding", title: funding.title, gate: fundingGate, status: funding.status });
    if (funding.status === "closed") {
      const statusCheck = verificationTask(funding, "funding-status", "Check closed notice and identify a current replacement", "unknown", ["current funding notice", "replacement program"]);
      const checks = ruleVerifications(plan, funding, selection.answers ?? {});
      checks.forEach((check) => { check.dependsOn = [statusCheck.id]; });
      branches.push([statusCheck, ...checks]);
    } else {
      const tasks = candidateTasks(funding, "funding");
      const checks = ruleVerifications(plan, funding, selection.answers ?? {});
      checks.forEach((check) => { check.dependsOn = branchLeaves(tasks); });
      branches.push([...tasks, ...checks]);
    }
  }

  for (const authorization of authorizations) {
    modules.push({ id: authorization.id, kind: "authorization", title: authorization.title, gate: authorizationGate });
    const tasks = candidateTasks(authorization, "authorization");
    const checks = ruleVerifications(plan, authorization, selection.answers ?? {});
    checks.forEach((check) => { check.dependsOn = branchLeaves(tasks); });
    branches.push([...tasks, ...checks]);
  }

  const allBranchTasks = branches.flat();
  for (const task of allBranchTasks) {
    if (task.dependsOn.length === 0 && screenTaskId) task.dependsOn = [screenTaskId];
  }

  const join = [...new Set(branches.flatMap(branchLeaves))].sort();
  const developTask = stageTasks.get("develop")![0];
  if (!screenTaskId) errors.push("screen lifecycle stage must have a task");
  else developTask.dependsOn = [...new Set([screenTaskId, ...join])];

  for (const id of stageOrder) if (id !== "develop") stageTasks.get(id)!.forEach((item) => {
    if (id === "screen") return;
    const expectedPrevious = COMPOSED_STAGE_ORDER[COMPOSED_STAGE_ORDER.indexOf(id) - 1];
    const source = stagesById.get(id)!.tasks.find((task) => task.id === item.id);
    if (expectedPrevious && source && source.dependsOn.length === 0) {
      const previousTaskId = stagesById.get(expectedPrevious)!.tasks.at(-1)?.id;
      if (previousTaskId) item.dependsOn = [previousTaskId];
    }
  });

  for (const [id, tasks] of stageTasks) {
    if (id === "develop") tasks.push(...allBranchTasks);
  }
  const tasks = stageOrder.flatMap((id) => stageTasks.get(id)!);
  const graph = graphOrder(tasks);
  errors.push(...graph.errors);
  const stages: ComposedWorkflowStage[] = stageOrder.map((id) => {
    const stage = stagesById.get(id)!;
    return {
      id,
      title: stage.title,
      description: stage.description,
      gate: stage.gate,
      evidence: [...stage.evidence],
      owner: stage.owner,
      taskIds: stageTasks.get(id)!.map((item) => item.id),
    };
  });
  const authorizationPart = authorizations.map((item) => item.id).sort().join(",") || "none";
  const id = `workflow:${intervention.id}:${funding?.id ?? "no-funding"}:${authorizationPart}`;
  return {
    id, modules, stages, tasks, orderedTaskIds: graph.order, errors, isValid: errors.length === 0,
  };
}
