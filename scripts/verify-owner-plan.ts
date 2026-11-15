/**
 * Owner-plan verifier: prints a PASS/FAIL row per case and acceptance criterion
 * (doc expectations in lib/owner/fixtures.ts) plus cross-case checks. Exit 1 on any FAIL.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-owner-plan.ts
 */
import { buildOwnerPlan, planKey, reforecastMilestones } from "../lib/owner/ownerPlan";
import { evaluateCase, FIXTURE_AS_OF, ownerCases, type CheckRow } from "../lib/owner/fixtures";
import type { DraftEdits } from "../lib/owner/types";

function reverseKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(reverseKeys) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).reverse()) out[k] = reverseKeys((v as Record<string, unknown>)[k]);
    return out as T;
  }
  return v;
}

const rows: CheckRow[] = [];
const cases = ownerCases();
for (const c of cases) rows.push(...evaluateCase(c, buildOwnerPlan, reforecastMilestones));

// Cross-case checks.
const allKeyShuffle = cases.every((c) => {
  const a = buildOwnerPlan(c.input, { scenario: "heatwave", asOf: FIXTURE_AS_OF });
  const b = buildOwnerPlan(reverseKeys(c.input), { scenario: "heatwave", asOf: FIXTURE_AS_OF });
  return a.inputsHash === b.inputsHash && a.outputHash === b.outputHash;
});
rows.push({ caseId: "all", criterion: "key-order shuffle → same inputsHash/outputHash", pass: allKeyShuffle, detail: `${cases.length} cases` });

const keys = new Set(cases.map((c) => planKey(c.input.target)));
const [mg, , water] = cases;
const editsA: DraftEdits = { planKey: planKey(mg.input.target), tasks: { "t.dev.need": { owner: "Westminster PM" } } };
const pA = buildOwnerPlan(mg.input, { scenario: "baseline", asOf: FIXTURE_AS_OF, edits: editsA });
const pB = buildOwnerPlan(water.input, { scenario: "baseline", asOf: FIXTURE_AS_OF, edits: editsA });
const isolated = keys.size === cases.length && pA.draft.applied.includes("t.dev.need") && pB.draft.applied.length === 0 && pB.draft.rejected !== null
  && pB.tasks.find((t) => t.id === "t.dev.need")?.owner === undefined;
rows.push({ caseId: "all", criterion: "reload isolation: drafts scoped per target", pass: isolated, detail: `${keys.size} distinct plan keys; foreign draft rejected=${pB.draft.rejected !== null}` });

const lateGrant = buildOwnerPlan(mg.input, { scenario: "baseline", asOf: "2027-05-20T00:00:00.000Z" });
rows.push({ caseId: "microgrid", criterion: "missed grant window flagged (late_start)", pass: lateGrant.deadlines.some((d) => d.taskId === "t.grants.application" && d.kind === "late_start"), detail: "asOf 2027-05-20" });
rows.push({ caseId: "microgrid", criterion: "stale evidence → gap + refresh task", pass: lateGrant.tasks.some((t) => t.id.startsWith("t.refresh.")), detail: lateGrant.findings.filter((f) => f.id.startsWith("g.stale.")).map((f) => f.id).join(", ") });

// Table.
const w1 = Math.max(...rows.map((r) => r.caseId.length), 4);
const w2 = Math.max(...rows.map((r) => r.criterion.length), 9);
console.log(`${"CASE".padEnd(w1)}  ${"CRITERION".padEnd(w2)}  RESULT  DETAIL`);
for (const r of rows) console.log(`${r.caseId.padEnd(w1)}  ${r.criterion.padEnd(w2)}  ${r.pass ? "PASS  " : "FAIL  "}  ${r.detail}`);
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} PASS${failed ? `, ${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);
