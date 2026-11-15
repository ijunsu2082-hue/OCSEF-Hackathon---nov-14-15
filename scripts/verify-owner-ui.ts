/**
 * Owner-plan UI verifier: drives the same pure path components/scan/OwnerPlanView.tsx
 * and LifecycleGatesView.tsx use (draft store slot, edit -> rebuild, heatwave
 * toggle, exports, gate mapping) and prints a PASS/FAIL row per check. Exit 1 on any FAIL.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-owner-ui.ts
 *
 * The scan is a SYNTHETIC HEAD ScanResult placed at Westminster HS
 * (data/regions.json center); real grid layers load only in the browser.
 * The rendered UI is verified separately in a browser.
 */
import type { ScanResult } from "../lib/scan/areaScan";
import { buildOwnerPlan, draftStorageKey, type Scenario } from "../lib/owner/ownerPlan";
import { planInputFromHeadScan } from "../lib/owner/planInput";
import { emptyDraft, draftKey, memoryStorage, setTaskEdit, setSelectedOption, type Draft } from "../lib/owner/draftStore";
import { evaluateAllGates } from "../lib/owner/lifecycle";
import { PROCEDURES } from "../lib/owner/procedures";
import {
  deadlinesIcs,
  draftLocation,
  draftStoreFor,
  draftToEdits,
  evidenceJson,
  lifecycleFromPlan,
  planJson,
  stagePackets,
} from "../components/scan/ownerPlanExport";

interface Row { check: string; pass: boolean; detail: string }
const rows: Row[] = [];
const row = (check: string, pass: boolean, detail: string) => rows.push({ check, pass, detail });

const AS_OF = "2026-11-14T18:00:00.000Z";
const scan: ScanResult = {
  point: { lat: 33.7538, lon: -118.0111, radius_mi: 5 }, label: "Westminster HS (synthetic scan)", inside_coverage: true, max_voltage_kv: 230, wire: null,
  plant_count: 3, nameplate_mw: 820, renewable_mw: 60, storage_mw: 40, fossil_mw: 720, renewable_pct: 7,
  mw_by_source: { natural_gas: 720, solar: 60, battery: 40 }, line_miles: 55, hv_line_miles: 25,
  line_miles_by_kv: { "500+": 0, "200-499": 25, "100-199": 18, "<100": 12, unknown: 0 },
  substation_count: 6, hv_substation_count: 2, cap_weighted_age: 31, oldest_plant: { name: "Synthetic", year: 1971, distance_mi: 3 },
  planned_retirement_mw: 200, planned_retirement_plants: 1, evening_cover_pct: 67, nearest_load_center: null, plants: [],
  risk: { score: 58, level: "HIGH", factors: [] }, ideas: [], report: "",
};

const input = planInputFromHeadScan(scan, { sector: "electric", scannedAt: AS_OF, label: scan.label });
const target = input.target;
const storage = memoryStorage();
const { store, storageKey } = draftStoreFor(storage, target);
const loc = draftLocation(target);

/** What useOwnerPlan does on every render: load the draft, build base + edited plans. */
function render(scenario: Scenario) {
  const loaded = store.load(loc);
  const edits = draftToEdits(loaded.draft, target);
  const base = buildOwnerPlan(input, { scenario, asOf: AS_OF, edits: { planKey: edits.planKey, ...(edits.selectedOption !== undefined ? { selectedOption: edits.selectedOption } : {}) } });
  const plan = buildOwnerPlan(input, { scenario, asOf: AS_OF, edits });
  return { loaded, base, plan };
}
function edit(scenario: Scenario, taskId: string, patch: Parameters<typeof setTaskEdit>[2]) {
  const { loaded, base } = render(scenario);
  const task = base.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`no task ${taskId}`);
  return store.save(loc, setTaskEdit(loaded.draft, task, patch, AS_OF));
}

// 1. First open: empty draft, next action present.
const r0 = render("baseline");
row("first open: draft empty, no notices", r0.loaded.status === "empty" && r0.plan.draft.orphaned.length === 0 && r0.plan.draft.rejected === null, `status=${r0.loaded.status}`);
row("My work: next action names owner/role and due", !!r0.plan.nextAction && /due \d{4}-\d{2}-\d{2}/.test(r0.plan.nextAction), r0.plan.nextAction ?? "null");
row("top two risks + sustainability + gaps present", r0.plan.findings.filter((f) => f.kind === "risk").length >= 2 && r0.plan.findings.some((f) => f.kind === "sustainability") && r0.plan.findings.some((f) => f.kind === "gap"),
  r0.plan.findings.map((f) => f.kind[0]).join(""));
row("option picker covers repair/operating/replacement/defer/do nothing", ["repair", "operating_change", "replacement", "defer", "do_nothing"].every((k) => r0.plan.options.some((o) => o.kind === k)), r0.plan.options.map((o) => o.kind).join(","));

// 2. Edit owner of the next task; saved under draftStorageKey.
const nextId = r0.plan.nextTaskId!;
const saved = edit("baseline", nextId, { owner: "Westminster facilities PM" });
row("edit saved under ownerPlan.draftStorageKey(target)", saved && storageKey === draftStorageKey(target) && Object.keys(storage.dump()).join() === storageKey, storageKey);
const r1 = render("baseline");
row("owner edit applied after reload", r1.plan.tasks.find((t) => t.id === nextId)?.owner === "Westminster facilities PM", `applied=${r1.plan.draft.applied.join(",")}`);

// 3. Heatwave toggle: edit persists, priorities change.
const r2 = render("heatwave");
const orderBase = r1.plan.tasks.map((t) => t.id);
const orderHot = r2.plan.tasks.map((t) => t.id);
row("heatwave keeps the owner edit", r2.plan.tasks.find((t) => t.id === nextId)?.owner === "Westminster facilities PM", "");
row("heatwave re-prioritizes (order differs, heat task first)", orderBase.join() !== orderHot.join() && orderHot[0] === "t.heat.interim", `baseline #1=${orderBase[0]}, heatwave #1=${orderHot[0]}`);
row("heatwave changes next action", r1.plan.nextTaskId !== r2.plan.nextTaskId, `${r1.plan.nextTaskId} -> ${r2.plan.nextTaskId}`);

// 4. Heat-only edit is orphaned (kept) when back to baseline.
edit("heatwave", "t.heat.interim", { notes: "Stage mobile generation" });
const r3 = render("baseline");
row("heat-only edit surfaced as orphan under baseline, not dropped", r3.plan.draft.orphaned.some((o) => o.taskId === "t.heat.interim" && o.edit.notes === "Stage mobile generation"), JSON.stringify(r3.plan.draft.orphaned));
const r4 = render("heatwave");
row("orphan re-applies when heatwave returns", r4.plan.tasks.find((t) => t.id === "t.heat.interim")?.notes === "Stage mobile generation", "");

// 5. Option choice expands tasks and persists.
const repair = r4.plan.options.find((o) => o.kind === "replacement")!;
const d5: Draft = setSelectedOption(store.load(loc).draft, repair.id, AS_OF);
store.save(loc, d5);
const r5 = render("heatwave");
row("selected option persists and expands delivery tasks", r5.plan.selectedOption === repair.id && r5.plan.tasks.length > r4.plan.tasks.length, `${r4.plan.tasks.length} -> ${r5.plan.tasks.length} tasks`);
row("owner edit still applied after option change", r5.plan.tasks.find((t) => t.id === nextId)?.owner === "Westminster facilities PM", "");

// 6. Foreign / corrupt drafts.
const other = draftStoreFor(storage, { ...target, lat: target.lat + 0.5 });
row("other location starts empty (scan isolation)", other.store.load({ ...loc, lat: loc.lat + 0.5 }).status === "empty", other.storageKey);
storage.setItem(storageKey, "{not json");
row("corrupt draft reported, not thrown", store.load(loc).status === "corrupt", "");
storage.setItem(storageKey, JSON.stringify({ ...emptyDraft(draftKey({ ...loc, lat: 1 })) }));
row("draft keyed to another location reported as key_mismatch", store.load(loc).status === "key_mismatch", "");
store.save(loc, d5);

// 7. Exports.
edit("heatwave", nextId, { due: "2026-12-15" });
const r7 = render("heatwave");
const ics = deadlinesIcs(r7.plan, AS_OF);
const lines = ics.split("\r\n");
row("ICS has owner-due deadline, CRLF, lines <= 75 octets", r7.plan.deadlines.some((d) => d.kind === "owner_due") && !/[^\r]\n/.test(ics) && lines.every((l) => Buffer.byteLength(l) <= 75) && ics.includes("DTSTART;VALUE=DATE:20261215"),
  `${r7.plan.deadlines.length} deadlines, ${lines.length} lines`);
row("exports deterministic across rebuilds", deadlinesIcs(render("heatwave").plan, AS_OF) === ics && planJson(render("heatwave").plan) === planJson(r7.plan) && evidenceJson(r7.plan, AS_OF) === evidenceJson(render("heatwave").plan, AS_OF), "");
const packets = stagePackets(r7.plan, AS_OF);
row("one packet per stage with tasks", packets.length === new Set(r7.plan.tasks.map((t) => t.stage)).size, packets.map((p) => p.stage).join(","));

// 8. Gates.
const m = lifecycleFromPlan(r7.plan, AS_OF);
const gates = m.state ? evaluateAllGates(m.state, AS_OF, { procedures: [...PROCEDURES] }) : [];
row("gate replay succeeds", m.error === null && gates.length === 10, m.error ?? `${m.events.length} events`);
row("no gate passes from plan statuses alone", gates.every((g) => g.status !== "pass"), gates.map((g) => `${g.gate}:${g.status}`).join(" "));
row("every not_ready gate lists missing inputs", gates.filter((g) => g.status === "not_ready").every((g) => g.missingInputs.length > 0), "");

let fail = 0;
for (const r of rows) {
  if (!r.pass) fail++;
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.detail ? `  [${r.detail}]` : ""}`);
}
console.log(`\n${rows.length - fail}/${rows.length} passed`);
process.exit(fail ? 1 : 0);
