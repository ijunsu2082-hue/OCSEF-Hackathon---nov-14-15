/**
 * Owner procedure catalog verification. Reads the procedure manuals from disk
 * and checks lib/owner/procedures.ts against them. Prints a PASS/FAIL table;
 * exits 1 on any failure. Run with:
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-owner-procedures.ts
 */

import { readFileSync } from "node:fs";
import {
  GATE_OVERRIDES,
  PROCEDURES,
  PROCEDURE_DOCS,
  RULE_IDS,
  STAGE_GATE,
  STAGE_ORDER,
  gatingOf,
  headingAnchor,
  instantiateTasks,
  preconditionCodes,
  procedureGraph,
  topologicalOrder,
} from "../lib/owner/procedures";
import type { GateId } from "../lib/owner/planTypes";

const CODE_RE = /\b[A-Z]{2,5}-\d{2}/g;

/**
 * Tokens that match the code pattern but are fictional example-record ids in
 * docs/INFRASTRUCTURE-PROCEDURES-DELIVERY.md "## 8. Example linked records"
 * (e.g. CASE-204, ASSET-PUMP-17, PKG-MECH-03, CON-88, DEC-11, INV-17, DWG-31,
 * TEST-10). Each is checked to occur only inside that section.
 */
const EXAMPLE_TOKENS = ["CASE-20", "PUMP-17", "MECH-03", "CON-88", "DEC-11", "DEC-14", "INV-17", "DWG-31", "TEST-10"];
const EXAMPLE_SECTION = "## 8. Example linked records";

/** Docs that reference (but do not define) procedure codes. */
const REFERENCING_DOCS = ["docs/INFRASTRUCTURE-WORKFLOWS.md", "docs/INFRASTRUCTURE-LIFECYCLE.md", "docs/INFRASTRUCTURE-FRICTION.md"];

type Row = { check: string; pass: boolean; detail: string; info?: boolean };
const rows: Row[] = [];
const record = (check: string, pass: boolean, detail: string) => rows.push({ check, pass, detail });
const GATE_LIST: GateId[] = ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9"];

const read = (p: string) => readFileSync(p, "utf8");
const docText = Object.fromEntries(PROCEDURE_DOCS.map((d) => [d, read(d)]));

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

// (a) doc coverage --------------------------------------------------------
{
  const found = new Map<string, Set<string>>();
  for (const [doc, text] of Object.entries(docText)) {
    for (const m of text.match(CODE_RE) ?? []) {
      if (!found.has(m)) found.set(m, new Set());
      found.get(m)!.add(doc);
    }
  }
  const delivery = docText["docs/INFRASTRUCTURE-PROCEDURES-DELIVERY.md"];
  const exampleText = section(delivery, EXAMPLE_SECTION);
  const outsideExample = delivery.replace(exampleText, "");
  const leakedExamples = EXAMPLE_TOKENS.filter((t) => outsideExample.includes(t) || !exampleText.includes(t));
  record(
    "a0 example-token allowlist confined to delivery s8",
    leakedExamples.length === 0,
    leakedExamples.length ? `outside s8 or absent: ${leakedExamples.join(", ")}` : `${EXAMPLE_TOKENS.length} tokens only in "${EXAMPLE_SECTION}"`,
  );
  const docCodes = [...found.keys()].filter((c) => !EXAMPLE_TOKENS.includes(c)).sort();
  const counts = new Map<string, number>();
  for (const s of PROCEDURES) counts.set(s.code, (counts.get(s.code) ?? 0) + 1);
  const missing = docCodes.filter((c) => !counts.has(c));
  const dupes = [...counts].filter(([, n]) => n !== 1).map(([c]) => c);
  const invented = [...counts.keys()].filter((c) => !docCodes.includes(c));
  record("a1 every doc code in PROCEDURES", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${docCodes.length} doc codes found`);
  record("a2 each code exactly once", dupes.length === 0, dupes.length ? `duplicates: ${dupes.join(", ")}` : `${PROCEDURES.length} unique codes`);
  record("a3 no invented codes", invented.length === 0, invented.length ? `not in docs: ${invented.join(", ")}` : "all codes occur in a procedure doc");

  // every code has its own heading in the doc it cites
  const headingMiss: string[] = [];
  for (const s of PROCEDURES) {
    const [doc, anchor] = s.sourceDoc.split("#");
    const text = docText[doc];
    const anchors = (text ?? "").split("\n").filter((l) => /^#{2,3} /.test(l)).map((l) => headingAnchor(l.replace(/^#+ /, "")));
    if (!text || !anchors.includes(anchor) || !anchor.startsWith(s.code.toLowerCase())) headingMiss.push(s.code);
  }
  record("a4 sourceDoc anchors resolve to own heading", headingMiss.length === 0, headingMiss.length ? `bad: ${headingMiss.join(", ")}` : "all anchors match a doc heading");

  const refMiss: string[] = [];
  for (const d of REFERENCING_DOCS) for (const m of read(d).match(CODE_RE) ?? []) if (!counts.has(m)) refMiss.push(`${d}:${m}`);
  record("a5 codes referenced in WORKFLOWS/LIFECYCLE/FRICTION resolve", refMiss.length === 0, refMiss.length ? refMiss.join(", ") : "all referenced codes resolve");
}

// (b) preconditions resolve -------------------------------------------------
{
  const codes = new Set(PROCEDURES.map((s) => s.code));
  const bad: string[] = [];
  for (const s of PROCEDURES) for (const p of s.preconditions) if (!codes.has(p) && !["gate", "rule"].includes(RULE_IDS[p]?.kind)) bad.push(`${s.code}->${p}`);
  for (const s of PROCEDURES) for (const c of s.conditionalPreconditions ?? []) {
    if (!["trigger", "branch"].includes(RULE_IDS[c.when]?.kind)) bad.push(`${s.code} when ${c.when}`);
    for (const p of c.preconditions) if (!codes.has(p) || p === s.code) bad.push(`${s.code}-(${c.when})->${p}`);
  }
  const self = PROCEDURES.filter((s) => s.preconditions.includes(s.code)).map((s) => s.code);
  record("b preconditions resolve (code or RULE_IDS)", bad.length === 0 && self.length === 0, bad.length || self.length ? `unresolved: ${bad.join(", ")} self: ${self.join(", ")}` : `${procedureGraph().edges.length} code edges, ${procedureGraph().ruleEdges.length} rule edges`);
}

// (c) acyclic --------------------------------------------------------------
{
  // independent DFS (does not reuse topologicalOrder)
  // includes conditional preconditions: the graph must stay acyclic whichever triggers hold
  const pre = new Map(PROCEDURES.map((s) => [s.code, preconditionCodes(s, true)]));
  const state = new Map<string, 0 | 1 | 2>();
  let cycle: string[] | null = null;
  const visit = (c: string, path: string[]) => {
    if (cycle) return;
    if (state.get(c) === 2) return;
    if (state.get(c) === 1) {
      cycle = [...path.slice(path.indexOf(c)), c];
      return;
    }
    state.set(c, 1);
    for (const p of pre.get(c) ?? []) visit(p, [...path, c]);
    state.set(c, 2);
  };
  for (const c of pre.keys()) visit(c, []);
  let topoOk = true;
  try {
    topologicalOrder();
  } catch {
    topoOk = false;
  }
  record("c precondition graph acyclic", cycle === null && topoOk, cycle ? `cycle: ${(cycle as string[]).join(" -> ")}` : "DFS + topologicalOrder agree: no cycle");
}

// (d) stage coverage and stage->gate ---------------------------------------
{
  const empty = STAGE_ORDER.filter((st) => !PROCEDURES.some((s) => s.stage === st));
  record("d1 every stage has >=1 step", empty.length === 0, empty.length ? `empty: ${empty.join(", ")}` : `${STAGE_ORDER.length} stages covered`);

  // Re-derive the gate table from WORKFLOWS text, independent of STAGE_GATE.
  const wf = read("docs/INFRASTRUCTURE-WORKFLOWS.md");
  const completionGate = (sectionHeading: string): string | null => {
    const sec = section(wf, sectionHeading);
    const para = sec.split("\n").find((l) => l.startsWith("**Completion / acceptance.**")) ?? "";
    return para.match(/\bM\d\b/)?.[0] ?? null;
  };
  const milestones = wf.match(/Default milestones: ([^.]*(?:\.[^ ][^.]*)*)\./)?.[1] ?? "";
  const milestone = (label: string): string | null => {
    const m = milestones.match(new RegExp(`(M\\d) ${label.replace(/[/]/g, "\\/")}`));
    return m ? m[1] : null;
  };
  const expected: Record<string, string | null> = {
    intake: completionGate("## 1. Intake and emergency intake"),
    feasibility: completionGate("## 2. Feasibility and alternatives"),
    site_control: milestone("site/control path"),
    capital: completionGate("## 4. Capital and financing"),
    grants: null, // 5A names no milestone
    permits: (() => {
      const sec = section(wf, "## 5. Grants, incentives, permits, licenses, agreements");
      const b = sec.slice(sec.indexOf("### 5B."));
      return b.split("\n").find((l) => l.startsWith("**Completion / acceptance.**"))?.match(/\bM\d\b/)?.[0] ?? null;
    })(),
    engineering: milestone("design and external approvals ready"),
    procurement: milestone("notice-to-proceed readiness"),
    construction: completionGate("## 8. Construction"),
    commissioning: completionGate("## 9. Commissioning and handover"),
    operations: milestone("renewal/retirement decision"),
    decommissioning: completionGate("## 11. Decommissioning and closure"),
  };
  // grants: confirm 5A completion paragraph really names no milestone
  const sec5 = section(wf, "## 5. Grants, incentives, permits, licenses, agreements");
  const a5 = sec5.slice(0, sec5.indexOf("### 5B."));
  const grantsHasGate = /\bM\d\b/.test(a5);
  const tableBad = STAGE_ORDER.filter((st) => expected[st] !== STAGE_GATE[st]).map((st) => `${st}: doc=${expected[st]} table=${STAGE_GATE[st]}`);
  if (grantsHasGate) tableBad.push("grants: 5A text names a milestone");
  record("d2 STAGE_GATE matches WORKFLOWS text", tableBad.length === 0, tableBad.length ? tableBad.join("; ") : Object.entries(expected).map(([k, v]) => `${k}=${v ?? "none"}`).join(" "));
  const stepBad = PROCEDURES.filter((s) => (s.gate ?? null) !== (GATE_OVERRIDES[s.code]?.gate ?? expected[s.stage] ?? null) || s.gateOverride !== GATE_OVERRIDES[s.code]?.gate).map((s) => s.code);
  record("d3 every step gate = stage default or a doc override", stepBad.length === 0, stepBad.length ? stepBad.join(", ") : `${PROCEDURES.length} steps; overrides ${Object.entries(GATE_OVERRIDES).map(([c, o]) => `${c}->${o.gate}`).join(" ")}`);
  const quoteBad = Object.entries(GATE_OVERRIDES).filter(([, o]) => !read(o.sourceDoc.split("#")[0]).includes(o.quote)).map(([c]) => c);
  record("d4 every gate override quotes its doc verbatim", quoteBad.length === 0, quoteBad.length ? quoteBad.join(", ") : Object.entries(GATE_OVERRIDES).map(([c, o]) => `${c}: "${o.quote}"`).join("; "));
}

// (e) no empty required strings -------------------------------------------
{
  const bad: string[] = [];
  for (const s of PROCEDURES) {
    for (const k of ["code", "stage", "title", "role", "recovery", "sourceDoc"] as const) if (typeof s[k] !== "string" || !s[k].trim()) bad.push(`${s.code}.${k}`);
    for (const k of ["inputs", "outputs", "acceptance"] as const) {
      if (!Array.isArray(s[k]) || s[k].length === 0) bad.push(`${s.code}.${k}[]`);
      s[k].forEach((v, i) => (typeof v !== "string" || !v.trim()) && bad.push(`${s.code}.${k}[${i}]`));
    }
    s.preconditions.forEach((v, i) => !v.trim() && bad.push(`${s.code}.preconditions[${i}]`));
    (s.blocksGateOn ?? []).forEach((v, i) => !v.trim() && bad.push(`${s.code}.blocksGateOn[${i}]`));
  }
  record("e no empty required strings/lists", bad.length === 0, bad.length ? bad.join(", ") : "all required fields non-empty");
}

// (g) gating classification and trigger allowlist ----------------------------
{
  const bad: string[] = [];
  const counts: Record<string, number> = { required: 0, conditional: 0, non_gating: 0 };
  for (const s of PROCEDURES) {
    const m = gatingOf(s);
    counts[m]++;
    if (m === "conditional" && !(s.trigger && RULE_IDS[s.trigger]?.kind === "trigger")) bad.push(`${s.code}: conditional without allowlisted trigger`);
    if (m !== "conditional" && s.trigger) bad.push(`${s.code}: trigger on a ${m} step`);
    if (!s.gate && s.gating !== "non_gating") bad.push(`${s.code}: no gate but not explicitly non_gating`);
  }
  record("g1 every conditional step has an allowlisted trigger; gate-less steps are non_gating", bad.length === 0, bad.length ? bad.join("; ") : `required=${counts.required} conditional=${counts.conditional} non_gating=${counts.non_gating}`);
  const ruleBad: string[] = [];
  for (const [id, r] of Object.entries(RULE_IDS)) {
    const [file, anchor] = r.sourceDoc.split("#");
    const text = read(file);
    if (!text.includes(r.quote)) ruleBad.push(`${id}: quote`);
    if (!text.split("\n").filter((l) => /^#{2,4} /.test(l)).map((l) => headingAnchor(l.replace(/^#+ /, ""))).includes(anchor)) ruleBad.push(`${id}: anchor ${anchor}`);
    if (r.evaluationRequired && !read(r.evaluationRequired.sourceDoc.split("#")[0]).includes(r.evaluationRequired.basis)) ruleBad.push(`${id}: evaluation basis`);
  }
  const used = new Set(PROCEDURES.flatMap((s) => [...s.preconditions, ...(s.trigger ? [s.trigger] : []), ...(s.conditionalPreconditions ?? []).map((c) => c.when)]));
  for (const id of Object.keys(RULE_IDS)) if (!used.has(id)) ruleBad.push(`${id}: unused`);
  const kinds = Object.values(RULE_IDS).reduce<Record<string, number>>((m, r) => ({ ...m, [r.kind]: (m[r.kind] ?? 0) + 1 }), {});
  record("g2 RULE_IDS: verbatim doc quote, resolvable anchor, used", ruleBad.length === 0, ruleBad.length ? ruleBad.join("; ") : `${Object.keys(RULE_IDS).length} ids (${Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join(" ")}); evaluation required: ${Object.keys(RULE_IDS).filter((k) => RULE_IDS[k].evaluationRequired).join(", ") || "none"}`);
}

// (u) structural gate reachability -------------------------------------------
{
  // Graph: gate -> each step that can gate it (required, or conditional with its trigger active: worst case);
  // step -> each catalog precondition (incl. conditional); step -> gate X for a "gate.X" rule precondition.
  // A gate is structurally unreachable if its dependency closure contains a cycle (it would wait on itself).
  const byCode = new Map(PROCEDURES.map((s) => [s.code, s]));
  const succ = (node: string): string[] => {
    if (/^M\d$/.test(node)) return PROCEDURES.filter((s) => s.gate === node && gatingOf(s) !== "non_gating").map((s) => s.code);
    const s = byCode.get(node)!;
    return [...preconditionCodes(s, true), ...s.preconditions.filter((p) => p.startsWith("gate.")).map((p) => p.slice(5))];
  };
  const unreachable: string[] = [];
  const closureSize: string[] = [];
  for (const gate of GATE_LIST) {
    const state = new Map<string, 1 | 2>();
    let cycle: string[] | null = null;
    const seen = new Set<string>();
    const visit = (n: string, path: string[]) => {
      if (cycle) return;
      if (state.get(n) === 2) return;
      if (state.get(n) === 1) { cycle = [...path.slice(path.indexOf(n)), n]; return; }
      state.set(n, 1);
      seen.add(n);
      for (const m of succ(n)) visit(m, [...path, n]);
      state.set(n, 2);
    };
    visit(gate, []);
    if (cycle) unreachable.push(`${gate}: ${(cycle as string[]).join(" -> ")}`);
    closureSize.push(`${gate}:${seen.size - 1}`);
  }
  record("u1 no gate is structurally unreachable (no cycle through steps, preconditions, gate rules)", unreachable.length === 0, unreachable.length ? unreachable.join("; ") : `dependency closure sizes ${closureSize.join(" ")}`);

  // Order inversions: a gating step at gate G whose catalog preconditions (transitively) include a gating
  // step assigned to a later gate. Not a deadlock (gates do not consult preconditions), but G then waits
  // on later-stage work in practice, so the earlier gate cannot pass in lifecycle order. Hard failure.
  const gi = (g: GateId | undefined) => (g ? GATE_LIST.indexOf(g) : -1);
  const inversions: string[] = [];
  for (const s of PROCEDURES) {
    if (gatingOf(s) === "non_gating") continue;
    const seen = new Set<string>();
    const stack = [...preconditionCodes(s, true)];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      const p = byCode.get(c)!;
      if (gatingOf(p) !== "non_gating" && gi(p.gate) > gi(s.gate)) inversions.push(`${s.code}@${s.gate} <- ${c}@${p.gate}`);
      stack.push(...preconditionCodes(p, true));
    }
  }
  record("u2 no gate-order inversion (no gating step waits on a later gate's step)", inversions.length === 0, inversions.length ? inversions.join("; ") : `${PROCEDURES.filter((s) => gatingOf(s) !== "non_gating").length} gating steps checked`);
}

// (f) instantiateTasks deterministic ---------------------------------------
try {
  const sel: (string | readonly string[])[] = [...STAGE_ORDER, PROCEDURES.map((s) => s.code)];
  const problems: string[] = [];
  for (const s of sel) {
    const a = JSON.stringify(instantiateTasks(s as never, { key: "204" }));
    const b = JSON.stringify(instantiateTasks(s as never, { key: "204" }));
    if (a !== b) problems.push(`nondeterministic: ${typeof s === "string" ? s : "all"}`);
  }
  const all = instantiateTasks(PROCEDURES.map((s) => s.code).reverse(), { key: "204" });
  const fwd = instantiateTasks(PROCEDURES.map((s) => s.code), { key: "204" });
  if (JSON.stringify(all) !== JSON.stringify(fwd)) problems.push("output depends on input code order");
  const ids = new Set(all.map((t) => t.id));
  const pos = new Map(all.map((t, i) => [t.id, i]));
  for (const t of all) for (const d of t.dependsOn) if (!ids.has(d) || pos.get(d)! >= pos.get(t.id)!) problems.push(`${t.id} dep ${d} missing or not earlier`);
  record("f instantiateTasks deterministic + ordered", problems.length === 0, problems.length ? problems.slice(0, 5).join("; ") : `${all.length} tasks, ids like ${all[0]?.id}`);
} catch (err) {
  record("f instantiateTasks deterministic + ordered", false, `threw: ${(err as Error).message}`);
}

// report ---------------------------------------------------------------------
const families = new Map<string, number>();
for (const s of PROCEDURES) families.set(s.code.split("-")[0], (families.get(s.code.split("-")[0]) ?? 0) + 1);
console.log(`Procedures: ${PROCEDURES.length}  (${[...families].map(([f, n]) => `${f}=${n}`).join(" ")})`);
const width = Math.max(...rows.map((r) => r.check.length));
for (const r of rows) console.log(`${r.info ? "INFO" : r.pass ? "PASS" : "FAIL"}  ${r.check.padEnd(width)}  ${r.detail}`);
const failed = rows.filter((r) => !r.pass).length;
const checks = rows.filter((r) => !r.info).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nAll ${checks} checks passed (${rows.length - checks} informational)`);
process.exit(failed ? 1 : 0);
