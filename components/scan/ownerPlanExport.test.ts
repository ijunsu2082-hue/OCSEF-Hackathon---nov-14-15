// Run: node node_modules/tsx/dist/cli.mjs --test components/scan/ownerPlanExport.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import type { ScanResult as HeadScanResult } from "../../lib/scan/areaScan";
import { buildOwnerPlan, draftStorageKey, planKey } from "../../lib/owner/ownerPlan";
import { planInputFromHeadScan } from "../../lib/owner/planInput";
import { FIXTURE_AS_OF, ownerCases } from "../../lib/owner/fixtures";
import { emptyDraft, memoryStorage, setTaskEdit, draftKey } from "../../lib/owner/draftStore";
import { evaluateAllGates } from "../../lib/owner/lifecycle";
import { PROCEDURES, TRIGGER_IDS } from "../../lib/owner/procedures";
import type { DraftEdits } from "../../lib/owner/types";
import {
  deadlinesIcs,
  draftLocation,
  draftStoreFor,
  draftToEdits,
  evidenceJson,
  factValueText,
  icsEscape,
  icsFold,
  lifecycleFromPlan,
  planJson,
  stagePackets,
} from "./ownerPlanExport";

const octets = (s: string) => Buffer.byteLength(s, "utf8");
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, "");

function headScan(): HeadScanResult {
  return {
    point: { lat: 33.75, lon: -118.0, radius_mi: 3 }, label: "Synthetic HEAD scan", inside_coverage: true, max_voltage_kv: 230, wire: null,
    plant_count: 2, nameplate_mw: 500, renewable_mw: 50, storage_mw: 20, fossil_mw: 430, renewable_pct: 10,
    mw_by_source: { natural_gas: 430, solar: 50, battery: 20 }, line_miles: 40, hv_line_miles: 20,
    line_miles_by_kv: { "500+": 0, "200-499": 20, "100-199": 10, "<100": 10, unknown: 0 },
    substation_count: 4, hv_substation_count: 1, cap_weighted_age: 35, oldest_plant: { name: "Old", year: 1975, distance_mi: 1 },
    planned_retirement_mw: 100, planned_retirement_plants: 1, evening_cover_pct: 40, nearest_load_center: null, plants: [],
    risk: { score: 55, level: "HIGH", factors: [] }, ideas: [], report: "",
  };
}

const headInput = () => planInputFromHeadScan(headScan(), { sector: "electric", scannedAt: FIXTURE_AS_OF });

test("icsEscape escapes backslash, semicolon, comma and newlines (RFC 5545 3.3.11)", () => {
  assert.equal(icsEscape("a,b;c\\d\ne\r\nf"), "a\\,b\\;c\\\\d\\ne\\nf");
});

test("icsFold keeps every physical line within 75 octets and unfolds losslessly, never splitting UTF-8", () => {
  const long = `SUMMARY:${"Wärmepumpe ☀ ".repeat(30)}`;
  const folded = icsFold(long);
  for (const line of folded.split("\r\n")) assert.ok(octets(line) <= 75, `line is ${octets(line)} octets`);
  assert.ok(folded.split("\r\n").slice(1).every((l) => l.startsWith(" ")));
  assert.equal(unfold(folded), long);
  assert.equal(icsFold("SHORT:x"), "SHORT:x");
  // Exactly 75 octets stays on one line; 76 folds.
  assert.equal(icsFold("X".repeat(75)).includes("\r\n"), false);
  assert.equal(icsFold("X".repeat(76)), `${"X".repeat(75)}\r\n X`);
});

test("deadlinesIcs: CRLF only, folded, escaped, all-day VALUE=DATE, DTSTAMP from asOf, one VEVENT per deadline", () => {
  const c = ownerCases()[0];
  const plan = buildOwnerPlan(c.input, { scenario: "baseline", asOf: FIXTURE_AS_OF });
  assert.ok(plan.deadlines.length > 0, "fixture has deadlines");
  const ics = deadlinesIcs(plan, FIXTURE_AS_OF);
  assert.ok(ics.endsWith("\r\n"));
  assert.equal(/[^\r]\n/.test(ics), false, "no bare LF");
  assert.equal(/\r(?!\n)/.test(ics), false, "no bare CR");
  for (const line of ics.split("\r\n")) assert.ok(octets(line) <= 75, `line too long: ${line}`);
  const lines = unfold(ics).split("\r\n").filter(Boolean);
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.equal(lines[lines.length - 1], "END:VCALENDAR");
  assert.ok(lines.includes("VERSION:2.0"));
  assert.ok(lines.some((l) => l.startsWith("PRODID:")));
  assert.equal(lines.filter((l) => l === "BEGIN:VEVENT").length, plan.deadlines.length);
  assert.equal(lines.filter((l) => l === "END:VEVENT").length, plan.deadlines.length);
  assert.ok(lines.filter((l) => l.startsWith("DTSTAMP:")).every((l) => l === "DTSTAMP:20261101T000000Z"));
  const starts = lines.filter((l) => l.startsWith("DTSTART"));
  assert.ok(starts.every((l) => /^DTSTART;VALUE=DATE:\d{8}$/.test(l)));
  assert.ok(lines.filter((l) => l.startsWith("DTEND")).every((l) => /^DTEND;VALUE=DATE:\d{8}$/.test(l)));
  const uids = lines.filter((l) => l.startsWith("UID:"));
  assert.equal(new Set(uids).size, uids.length, "UIDs unique");
  // TEXT values never carry an unescaped comma, semicolon or raw newline.
  for (const l of lines.filter((x) => /^(SUMMARY|DESCRIPTION|X-WR-CALNAME):/.test(x))) {
    const value = l.slice(l.indexOf(":") + 1);
    assert.equal(/(^|[^\\])(\\\\)*[,;]/.test(value), false, `unescaped separator in ${l}`);
  }
});

test("deadlinesIcs escapes owner text with commas, semicolons and newlines; UID stable when the owner edits the task", () => {
  const input = headInput();
  const base = buildOwnerPlan(input, { scenario: "baseline", asOf: FIXTURE_AS_OF });
  const task = base.tasks[0];
  const edits = (owner: string): DraftEdits => ({ planKey: planKey(input.target), tasks: { [task.id]: { owner, due: "2026-12-01" } } });
  const a = buildOwnerPlan(input, { scenario: "baseline", asOf: FIXTURE_AS_OF, edits: edits("Smith, J.; Facilities\nLead") });
  const b = buildOwnerPlan(input, { scenario: "baseline", asOf: FIXTURE_AS_OF, edits: edits("Lee") });
  const ia = unfold(deadlinesIcs(a, FIXTURE_AS_OF));
  const ib = unfold(deadlinesIcs(b, FIXTURE_AS_OF));
  assert.ok(ia.includes("Owner: Smith\\, J.\\; Facilities\\nLead"), "owner text escaped");
  const uid = (s: string) => s.split("\r\n").filter((l) => l.startsWith("UID:")).sort();
  assert.deepEqual(uid(ia), uid(ib));
  assert.ok(uid(ia).some((u) => u.includes(task.id.replace(/[^A-Za-z0-9._-]+/g, "_"))));
});

test("exports are deterministic: same plan, same bytes; rebuilt plan, same bytes", () => {
  for (const c of ownerCases()) {
    const p1 = buildOwnerPlan(c.input, { scenario: "heatwave", asOf: FIXTURE_AS_OF });
    const p2 = buildOwnerPlan(structuredClone(c.input), { scenario: "heatwave", asOf: FIXTURE_AS_OF });
    assert.equal(deadlinesIcs(p1, FIXTURE_AS_OF), deadlinesIcs(p2, FIXTURE_AS_OF));
    assert.equal(planJson(p1), planJson(p2));
    assert.equal(evidenceJson(p1, FIXTURE_AS_OF), evidenceJson(p2, FIXTURE_AS_OF));
    assert.deepEqual(stagePackets(p1, FIXTURE_AS_OF), stagePackets(p2, FIXTURE_AS_OF));
  }
});

test("stagePackets: one Markdown packet per stage with tasks; facts linked with Unknown reasons", () => {
  const plan = buildOwnerPlan(headInput(), { scenario: "baseline", asOf: FIXTURE_AS_OF });
  const packets = stagePackets(plan, FIXTURE_AS_OF);
  const stages = new Set(plan.tasks.map((t) => t.stage));
  assert.equal(packets.length, stages.size);
  for (const p of packets) {
    assert.ok(p.filename.endsWith(`-${p.stage}.md`));
    for (const t of plan.tasks.filter((x) => x.stage === p.stage)) assert.ok(p.markdown.includes(`### ${t.title}`));
    assert.ok(p.markdown.includes("does not record any approval"));
  }
  const unknownFact = plan.facts.find((f) => typeof f.value === "object");
  assert.ok(unknownFact, "head scan input carries at least one Unknown fact");
  assert.ok(packets[0].markdown.includes(factValueText(unknownFact.value, unknownFact.unit)));
  assert.equal(/: (unknown|not assessed|not applicable): \s*\(/.test(packets[0].markdown), false, "no blank Unknown reasons");
});

test("draftStoreFor persists under draftStorageKey; edits survive a heatwave rebuild; heat-only edits orphan, not drop", () => {
  const input = headInput();
  const target = input.target;
  const storage = memoryStorage();
  const { store, storageKey } = draftStoreFor(storage, target);
  assert.equal(storageKey, draftStorageKey(target));
  const loc = draftLocation(target);
  const hot = buildOwnerPlan(input, { scenario: "heatwave", asOf: FIXTURE_AS_OF });
  const heatTask = hot.tasks.find((t) => t.id === "t.heat.interim");
  assert.ok(heatTask, "heatwave adds the interim heat task");
  const shared = hot.tasks.find((t) => t.id === "t.dev.need")!;
  let draft = emptyDraft(draftKey(loc));
  draft = setTaskEdit(draft, shared, { owner: "Westminster PM" }, FIXTURE_AS_OF);
  draft = setTaskEdit(draft, heatTask, { notes: "pre-stage crews" }, FIXTURE_AS_OF);
  assert.equal(store.save(loc, draft), true);
  assert.deepEqual(Object.keys(storage.dump()), [draftStorageKey(target)]);
  const loaded = store.load(loc);
  assert.equal(loaded.status, "loaded");
  const edits = draftToEdits(loaded.draft, target);
  const pHot = buildOwnerPlan(input, { scenario: "heatwave", asOf: FIXTURE_AS_OF, edits });
  const pBase = buildOwnerPlan(input, { scenario: "baseline", asOf: FIXTURE_AS_OF, edits });
  assert.equal(pHot.tasks.find((t) => t.id === "t.dev.need")!.owner, "Westminster PM");
  assert.equal(pBase.tasks.find((t) => t.id === "t.dev.need")!.owner, "Westminster PM");
  assert.equal(pHot.tasks[0].id, "t.heat.interim", "heatwave puts heat work first");
  assert.notEqual(pBase.tasks[0].id, "t.heat.interim");
  assert.deepEqual(pBase.draft.orphaned.map((o) => o.taskId), ["t.heat.interim"]);
  assert.equal(pBase.draft.orphaned[0].edit.notes, "pre-stage crews");
  assert.equal(pHot.draft.orphaned.length, 0);
});

test("lifecycleFromPlan never fakes a pass; credits a procedure only when all its tasks are done", () => {
  const input = headInput();
  const asOf = FIXTURE_AS_OF;
  const fresh = buildOwnerPlan(input, { scenario: "baseline", asOf });
  const m0 = lifecycleFromPlan(fresh, asOf);
  assert.equal(m0.error, null);
  const gates0 = evaluateAllGates(m0.state!, asOf, { procedures: [...PROCEDURES] });
  assert.equal(gates0.some((g) => g.status === "pass"), false);
  for (const g of gates0) if (g.status === "not_ready") assert.ok(g.missingInputs.length > 0, `${g.gate} not_ready has missing inputs`);
  assert.ok(gates0[0].missingInputs.includes("intake acceptance by triage role"));
  const devTasks = fresh.tasks.filter((t) => t.code === "DEV-03");
  assert.ok(devTasks.length >= 2);
  const partialEdits: DraftEdits = { planKey: planKey(input.target), tasks: { [devTasks[0].id]: { status: "done" } } };
  const partial = lifecycleFromPlan(buildOwnerPlan(input, { scenario: "baseline", asOf, edits: partialEdits }), asOf);
  assert.deepEqual(partial.credited, []);
  assert.deepEqual(partial.partial, ["DEV-03"]);
  const allEdits: DraftEdits = { planKey: planKey(input.target), tasks: Object.fromEntries(devTasks.map((t) => [t.id, { status: "done" as const }])) };
  const all = lifecycleFromPlan(buildOwnerPlan(input, { scenario: "baseline", asOf, edits: allEdits }), asOf);
  assert.deepEqual(all.credited, ["DEV-03"]);
  const m0b = evaluateAllGates(all.state!, asOf, { procedures: [...PROCEDURES] })[0];
  assert.equal(m0b.missingInputs.some((x) => x.startsWith("procedure DEV-03")), false);
  assert.notEqual(m0b.status, "pass");
});

test("lifecycleFromPlan: triggers stay not evaluated by default; only a yes/no plan fact named by trigger id records an evaluation", () => {
  const input = headInput();
  const asOf = FIXTURE_AS_OF;
  const base = lifecycleFromPlan(buildOwnerPlan(input, { scenario: "baseline", asOf }), asOf);
  assert.equal(base.events.some((e) => e.type === "trigger_evaluated"), false, "no trigger evaluation is inferred");
  assert.deepEqual([...new Set(base.triggers.map((t) => t.state))], ["not_evaluated"]);
  assert.deepEqual(base.triggers.map((t) => t.trigger), [...TRIGGER_IDS]);
  // M1 names the doc-required emergency evaluation as missing; owner-configured triggers are not listed.
  const m1 = evaluateAllGates(base.state!, asOf, { procedures: [...PROCEDURES] })[1];
  assert.ok(m1.missingInputs.some((m) => m.startsWith("trigger trigger.emergency not evaluated")));
  assert.equal(m1.missingInputs.some((m) => m.includes("trigger.assurance_configured")), false);
  const fact = (id: string, value: boolean | { state: "unknown"; reason: string }) => ({ id, subject: "case", predicate: "trigger.emergency", value, provenance: "user_assertion" as const, evidence: [], asOf });
  const withFact = (facts: ReturnType<typeof fact>[]) => lifecycleFromPlan(buildOwnerPlan(input, { scenario: "baseline", asOf, edits: { planKey: planKey(input.target), facts } }), asOf);
  const no = withFact([fact("f.trigger.emergency", false)]);
  assert.equal(no.error, null);
  assert.equal(no.triggers.find((t) => t.trigger === "trigger.emergency")!.state, "not_active");
  assert.equal(no.events.filter((e) => e.type === "trigger_evaluated").length, 1);
  const m1b = evaluateAllGates(no.state!, asOf, { procedures: [...PROCEDURES] })[1];
  assert.equal(m1b.missingInputs.some((m) => m.includes("trigger.emergency")), false);
  const yes = withFact([fact("f.trigger.emergency", true)]);
  assert.equal(yes.triggers.find((t) => t.trigger === "trigger.emergency")!.state, "active");
  assert.ok(evaluateAllGates(yes.state!, asOf, { procedures: [...PROCEDURES] })[1].missingInputs.some((m) => m.startsWith("procedure DEV-02 ")));
  const unknown = withFact([fact("f.trigger.emergency", { state: "unknown", reason: "not yet triaged" })]);
  assert.equal(unknown.triggers.find((t) => t.trigger === "trigger.emergency")!.state, "not_evaluated");
  assert.equal(unknown.events.some((e) => e.type === "trigger_evaluated"), false);
});
