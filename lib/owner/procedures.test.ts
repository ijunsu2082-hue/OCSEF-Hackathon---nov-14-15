import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { OwnerTask, StageId } from "./types";
import {
  DEFAULT_DURATION_DAYS,
  PROCEDURES,
  PROCEDURE_DOCS,
  RULE_IDS,
  STAGE_GATE,
  STAGE_ORDER,
  headingAnchor,
  instantiateTasks,
  procedureByCode,
  procedureGraph,
  proceduresForStage,
  topologicalOrder,
} from "./procedures";

const CODE_RE = /\b[A-Z]{2,5}-\d{2}/g;
// Fictional example-record ids in DELIVERY "## 8. Example linked records" (CASE-204, ASSET-PUMP-17, ...).
const EXAMPLE_TOKENS = new Set(["CASE-20", "PUMP-17", "MECH-03", "CON-88", "DEC-11", "DEC-14", "INV-17", "DWG-31", "TEST-10"]);
const docs = Object.fromEntries(PROCEDURE_DOCS.map((d) => [d, readFileSync(d, "utf8")]));

test("(a) every code in the procedure docs appears exactly once in PROCEDURES, and vice versa", () => {
  const docCodes = new Set<string>();
  for (const text of Object.values(docs)) for (const m of text.match(CODE_RE) ?? []) if (!EXAMPLE_TOKENS.has(m)) docCodes.add(m);
  const catalog = PROCEDURES.map((s) => s.code);
  assert.equal(new Set(catalog).size, catalog.length, "duplicate code in PROCEDURES");
  assert.deepEqual([...catalog].sort(), [...docCodes].sort());
  // Each code is defined by a heading in exactly one doc, and sourceDoc points at that heading.
  for (const s of PROCEDURES) {
    const defining = PROCEDURE_DOCS.filter((d) => new RegExp(`^#{2,3} ${s.code} — `, "m").test(docs[d]));
    assert.equal(defining.length, 1, `${s.code} heading count`);
    const heading = docs[defining[0]].split("\n").find((l) => new RegExp(`^#{2,3} ${s.code} — `).test(l))!.replace(/^#+ /, "");
    assert.equal(s.sourceDoc, `${defining[0]}#${headingAnchor(heading)}`);
  }
});

test("(a) example tokens excluded from coverage occur only in the delivery example section", () => {
  const d = docs["docs/INFRASTRUCTURE-PROCEDURES-DELIVERY.md"];
  const start = d.indexOf("## 8. Example linked records");
  const end = d.indexOf("\n## 9.", start);
  assert.ok(start > 0 && end > start);
  const outside = d.slice(0, start) + d.slice(end);
  for (const t of EXAMPLE_TOKENS) {
    assert.ok(d.slice(start, end).includes(t), `${t} not in example section`);
    assert.ok(!outside.includes(t), `${t} occurs outside example section`);
    for (const [name, text] of Object.entries(docs)) if (!name.endsWith("DELIVERY.md")) assert.ok(!text.includes(t), `${t} in ${name}`);
  }
});

test("expected family counts", () => {
  const fam: Record<string, number> = {};
  for (const s of PROCEDURES) fam[s.code.split("-")[0]] = (fam[s.code.split("-")[0]] ?? 0) + 1;
  assert.deepEqual(fam, { DEV: 19, CAP: 4, CHG: 2, GR: 4, PER: 4, AGR: 1, PROC: 7, CONST: 7, TURN: 6, OPS: 9, RET: 5 });
});

test("(b) every precondition resolves to a code or an allowlisted rule id", () => {
  for (const s of PROCEDURES) {
    for (const p of s.preconditions) {
      assert.ok(procedureByCode(p) || p in RULE_IDS, `${s.code} precondition ${p} unresolved`);
      assert.notEqual(p, s.code);
    }
  }
  // every allowlisted rule is actually used (no dead allowlist entries)
  const used = new Set(PROCEDURES.flatMap((s) => s.preconditions));
  for (const r of Object.keys(RULE_IDS)) assert.ok(used.has(r), `unused rule id ${r}`);
});

test("(c) precondition graph is acyclic", () => {
  const order = topologicalOrder();
  assert.equal(order.length, PROCEDURES.length);
  const pos = new Map(order.map((c, i) => [c, i]));
  const g = procedureGraph();
  assert.equal(g.nodes.length, PROCEDURES.length);
  for (const e of g.edges) assert.ok(pos.get(e.from)! < pos.get(e.to)!, `${e.from} -> ${e.to} out of order`);
  for (const e of g.ruleEdges) assert.ok(e.rule in RULE_IDS);
  assert.equal(g.edges.length + g.ruleEdges.length, PROCEDURES.reduce((n, s) => n + s.preconditions.length, 0));
});

test("(d) every stage has >=1 step and each step's gate matches the WORKFLOWS stage->gate mapping", () => {
  const wf = readFileSync("docs/INFRASTRUCTURE-WORKFLOWS.md", "utf8");
  // Independent literal transcription of WORKFLOWS milestone statements.
  const expected: Record<StageId, string | undefined> = {
    intake: "M0", feasibility: "M1", site_control: "M2", capital: "M3", grants: undefined, permits: "M4",
    engineering: "M4", procurement: "M5", construction: "M6", commissioning: "M7", operations: "M8", decommissioning: "M9",
  };
  for (const phrase of ["M0 when accepted", "M1 when objective", "M2 site/control path", "M3 requires approved budget", "M4 requirement set", "M4 design and external approvals ready", "M5 notice-to-proceed readiness", "M5 authorization/readiness and contracted package", "M6 when configured scope", "M7 requires owner-defined commissioning", "M8 renewal/retirement decision", "M9 when asset status"]) {
    assert.ok(wf.includes(phrase), `WORKFLOWS no longer says "${phrase}"`);
  }
  assert.equal(STAGE_ORDER.length, 12);
  for (const st of STAGE_ORDER) {
    assert.ok(proceduresForStage(st).length >= 1, `${st} has no procedures`);
    assert.equal(STAGE_GATE[st] ?? undefined, expected[st], `STAGE_GATE.${st}`);
  }
  for (const s of PROCEDURES) assert.equal(s.gate, expected[s.stage], `${s.code} gate`);
  // DEV traceability table: catalog rows -> stage
  const devRows: Record<string, StageId> = {
    "DEV-01": "intake", "DEV-02": "intake", "DEV-03": "intake", "DEV-14": "intake", "DEV-15": "intake",
    "DEV-04": "feasibility", "DEV-05": "feasibility", "DEV-06": "feasibility", "DEV-16": "feasibility",
    "DEV-07": "site_control", "DEV-08": "site_control", "DEV-09": "site_control", "DEV-17": "site_control",
    "DEV-10": "engineering", "DEV-11": "engineering", "DEV-12": "engineering", "DEV-13": "engineering", "DEV-18": "engineering", "DEV-19": "engineering",
  };
  for (const [c, st] of Object.entries(devRows)) assert.equal(procedureByCode(c)?.stage, st, c);
  const famStage: Record<string, StageId> = { CAP: "capital", GR: "grants", PER: "permits", AGR: "permits", PROC: "procurement", CONST: "construction", TURN: "commissioning", OPS: "operations", RET: "decommissioning" };
  for (const s of PROCEDURES) {
    const f = s.code.split("-")[0];
    if (f in famStage) assert.equal(s.stage, famStage[f], s.code);
  }
});

test("(e) no empty required strings", () => {
  for (const s of PROCEDURES) {
    for (const v of [s.code, s.stage, s.title, s.role, s.recovery, s.sourceDoc]) assert.ok(typeof v === "string" && v.trim().length > 0, `${s.code} empty field`);
    for (const list of [s.inputs, s.outputs, s.acceptance]) {
      assert.ok(list.length > 0, `${s.code} empty list`);
      for (const v of list) assert.ok(v.trim().length > 0, `${s.code} empty entry`);
    }
    for (const v of [...s.preconditions, ...(s.blocksGateOn ?? [])]) assert.ok(v.trim().length > 0);
    assert.ok(!JSON.stringify(s).includes("\\u0000"), `${s.code} leaked internal marker`);
    // "not specified" strings must cite this step's own section
    for (const v of [s.recovery, ...s.acceptance]) if (v.startsWith("not specified in ")) assert.ok(v.startsWith(`not specified in ${s.sourceDoc}`), `${s.code}: ${v}`);
  }
});

test("(f) instantiateTasks is deterministic, ordered, and OwnerTask-compatible", () => {
  for (const st of STAGE_ORDER) assert.deepEqual(instantiateTasks(st, { key: "204" }), instantiateTasks(st, { key: "204" }));
  const codes = PROCEDURES.map((s) => s.code);
  const fwd = instantiateTasks(codes, { key: "204" });
  assert.deepEqual(instantiateTasks([...codes].reverse(), { key: "204" }), fwd, "input order must not matter");
  assert.deepEqual(instantiateTasks([...codes, ...codes], { key: "204" }), fwd, "duplicates deduped");
  const asOwner: OwnerTask[] = fwd; // compile-time compatibility
  assert.equal(asOwner.length, PROCEDURES.length);
  const pos = new Map(fwd.map((t, i) => [t.id, i]));
  for (const t of fwd) {
    assert.equal(t.id, `${t.code}-204`);
    assert.equal(t.durationDays, DEFAULT_DURATION_DAYS);
    assert.equal(t.status, "not_started");
    assert.deepEqual(t.evidence, []);
    for (const d of t.dependsOn) assert.ok(pos.get(d)! < pos.get(t.id)!, `${t.id} before ${d}`);
    const depMax = Math.max(0, ...t.dependsOn.map((d) => fwd[pos.get(d)!].offsetDays + DEFAULT_DURATION_DAYS));
    assert.equal(t.offsetDays, depMax);
  }
  // full catalog: only rule ids remain external
  for (const t of fwd) for (const p of t.externalPreconditions) assert.ok(p in RULE_IDS, `${t.id} external ${p}`);
});

test("instantiateTasks: stage subset keeps cross-stage preconditions external, not dangling", () => {
  const tasks = instantiateTasks("construction", { key: "X" });
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) for (const d of t.dependsOn) assert.ok(ids.has(d));
  const mob = tasks.find((t) => t.code === "CONST-01")!;
  assert.deepEqual(mob.dependsOn, []);
  assert.deepEqual(mob.externalPreconditions, ["PROC-04", "DEV-19", "gate.M5"]);
  assert.equal(mob.gate, "M6");
  assert.deepEqual(tasks.find((t) => t.code === "CONST-06")!.dependsOn, ["CONST-02-X", "CONST-03-X"]);
});

test("instantiateTasks rejects bad input", () => {
  assert.throws(() => instantiateTasks(["NOPE-01"], { key: "1" }), /Unknown procedure code/);
  assert.throws(() => instantiateTasks("intake", { key: " " }), /ctx.key/);
  assert.throws(() => topologicalOrder(["ZZ-99"]), /Unknown procedure code/);
});

test("lookups", () => {
  assert.equal(procedureByCode("PER-03")?.title, "Dossier preparation, submission, review, issuance");
  assert.equal(procedureByCode("OPS-05")?.title, "Multi-year stewardship review");
  assert.equal(procedureByCode("XX-01"), undefined);
  assert.deepEqual(proceduresForStage("grants").map((s) => s.code), ["GR-01", "GR-02", "GR-03", "GR-04", "CHG-02"]);
  assert.ok(Object.isFrozen(PROCEDURES));
});
