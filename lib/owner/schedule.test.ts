import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ScheduleError, applyDisruption, backSchedule, baselineIntact, createScheduleBaseline, isoDay, reforecast, schedule, topoOrder,
  type Disruption, type SchedTask,
} from "./schedule";
import {
  createDraftStore, draftKey, emptyDraft, localStorageAdapter, memoryStorage, mergeDraft, setSelectedOption, setTaskEdit,
} from "./draftStore";
import { stableHash } from "./lifecycle";
import type { OwnerTask } from "./types";

const T = (day: string) => `${day}T12:00:00Z`;
const day = (iso: string) => isoDay(iso);
const task = (id: string, durationDays: number, dependsOn: string[] = [], offsetDays = 0): SchedTask => ({ id, durationDays, dependsOn, offsetDays });

// Westminster critical-facility microgrid scenario sequence (INFRASTRUCTURE-CASES.md).
// Durations are the intervals between the doc's stated scenario dates.
const MICROGRID: SchedTask[] = [
  task("load_audit", 30),
  task("geotech_fire", 45, ["load_audit"]),
  task("utility_preapp", 45, ["geotech_fire"]),
  task("funding_award", 47, ["utility_preapp"]),
  task("design_package", 61, ["funding_award"]),
  task("permits_utility_agreement", 61, ["design_package"]),
  task("equipment_delivery", 152, ["permits_utility_agreement"]),
  task("energization", 92, ["equipment_delivery"]),
  task("acceptance_exercise", 14, ["energization"]),
  task("grant_application", 20, ["utility_preapp"]),
  task("om_plan", 60, ["design_package"]),
];
const SWITCHGEAR_SLIP: Disruption = { id: "d-swgr", taskId: "equipment_delivery", delayDays: 16 * 7, reason: "Switchgear lead time slips 16 weeks", at: T("2028-05-01") };

test("back-schedule from target reproduces the microgrid case gate dates and critical path", () => {
  const r = backSchedule(MICROGRID, T("2028-06-15"));
  const lf = Object.fromEntries(r.tasks.map((t) => [t.id, day(t.lateFinish)]));
  assert.deepEqual(
    ["load_audit", "geotech_fire", "utility_preapp", "funding_award", "design_package", "permits_utility_agreement", "equipment_delivery", "energization", "acceptance_exercise"].map((id) => lf[id]),
    ["2027-01-15", "2027-03-01", "2027-04-15", "2027-06-01", "2027-08-01", "2027-10-01", "2028-03-01", "2028-06-01", "2028-06-15"],
  );
  assert.equal(day(r.requiredStart!), "2026-12-16");
  assert.deepEqual(r.criticalPath, ["load_audit", "geotech_fire", "utility_preapp", "funding_award", "design_package", "permits_utility_agreement", "equipment_delivery", "energization", "acceptance_exercise"]);
  assert.equal(r.flags.length, 0);
  assert.ok(r.tasks.find((t) => t.id === "om_plan")!.floatDays > 0);
});

test("period shift: switchgear +16 weeks moves energization Jun 1 → Sep 21 and acceptance Jun 15 → Oct 5; dependents only", () => {
  const impact = applyDisruption(MICROGRID, { targetFinish: T("2028-06-15") }, SWITCHGEAR_SLIP);
  const ef = Object.fromEntries(impact.after.tasks.map((t) => [t.id, day(t.earlyFinish)]));
  assert.equal(ef.energization, "2028-09-21");
  assert.equal(ef.acceptance_exercise, "2028-10-05");
  assert.equal(impact.dependentsOnly, true);
  assert.deepEqual(impact.moved.map((m) => m.taskId).sort(), ["acceptance_exercise", "energization", "equipment_delivery"]);
  assert.ok(impact.unchanged.includes("om_plan") && impact.unchanged.includes("grant_application") && impact.unchanged.includes("load_audit"));
  assert.deepEqual(impact.after.flags.map((f) => [f.code, f.days]), [["TARGET_MISSED", 112]]);
});

test("period shift with float: slack absorbs part of the shift; non-dependents never move", () => {
  const tasks = [task("a", 10), task("b", 5), task("c", 3, ["a", "b"]), task("x", 4)];
  const impact = applyDisruption(tasks, { anchor: T("2027-01-01") }, { id: "d", taskId: "b", delayDays: 8, reason: "r", at: T("2027-01-02") });
  assert.deepEqual(impact.moved, [{ taskId: "b", finishShiftDays: 8 }, { taskId: "c", finishShiftDays: 3 }]);
  assert.deepEqual(impact.unchanged.sort(), ["a", "x"]);
});

test("grant miss: deadline before the application can finish is flagged; feasible deadline is not", () => {
  const miss = backSchedule(MICROGRID, T("2028-06-15"), { windows: [{ id: "w-grant", kind: "grant_deadline", taskId: "grant_application", deadline: T("2027-04-30") }] });
  assert.deepEqual(miss.flags.map((f) => [f.code, f.taskId, f.days]), [["MISSED_WINDOW", "grant_application", 5]]);
  const ok = backSchedule(MICROGRID, T("2028-06-15"), { windows: [{ id: "w-grant", kind: "grant_deadline", taskId: "grant_application", deadline: T("2027-05-10") }] });
  assert.equal(ok.flags.length, 0);
});

test("permit expiry: instrument expiring before construction end is flagged only after the slip", () => {
  const expiries = [{ id: "auth-a", expiresAt: T("2028-07-01"), coversTaskIds: ["equipment_delivery", "energization"] }];
  const before = backSchedule(MICROGRID, T("2028-06-15"), { expiries });
  assert.equal(before.flags.length, 0);
  const after = schedule(MICROGRID, { anchor: before.anchor, targetFinish: T("2028-06-15"), expiries, disruptions: [SWITCHGEAR_SLIP] });
  const f = after.flags.find((x) => x.code === "EXPIRES_BEFORE_COMPLETION");
  assert.ok(f);
  assert.equal(f!.taskId, "energization");
  assert.equal(f!.days, 82);
});

test("unavailable equipment: longer lead time propagates through delivery to dependents and flags target miss", () => {
  const impact = applyDisruption(MICROGRID, { targetFinish: T("2028-06-15") }, { id: "d-unavail", taskId: "equipment_delivery", delayDays: 80, reason: "Specified inverter unavailable; alternate lead time +80 d", at: T("2027-11-01") });
  assert.equal(day(impact.after.tasks.find((t) => t.id === "acceptance_exercise")!.earlyFinish), "2028-09-03");
  assert.equal(impact.dependentsOnly, true);
});

test("baselines are immutable; reforecast reports variance against the named baseline", () => {
  const plan = backSchedule(MICROGRID, T("2028-06-15"));
  const bl = createScheduleBaseline("bl-sched-1", plan, T("2027-01-01"));
  const h = bl.contentHash;
  assert.throws(() => { (bl.tasks[0] as { earlyFinish: string }).earlyFinish = "x"; }, TypeError);
  assert.throws(() => { (bl as { id: string }).id = "x"; }, TypeError);
  const rf = reforecast(bl, MICROGRID, { disruptions: [SWITCHGEAR_SLIP], targetFinish: T("2028-06-15") }, T("2028-05-01"), 2);
  const v = Object.fromEntries(rf.variance.map((x) => [x.taskId, x.varianceDays]));
  assert.equal(v.energization, 112);
  assert.equal(v.om_plan, 0);
  assert.equal(rf.baselineHash, h);
  assert.equal(bl.contentHash, h);
  assert.ok(baselineIntact(bl));
  const extra = reforecast(bl, [...MICROGRID, task("new_scope", 5, ["om_plan"])], {}, T("2028-05-01"), 3);
  assert.equal(extra.variance.find((x) => x.taskId === "new_scope")!.varianceDays, null);
});

test("topological order is deterministic; cycles and unknown dependencies are typed errors", () => {
  assert.deepEqual(topoOrder([task("c", 1, ["a", "b"]), task("b", 1), task("a", 1)]), ["a", "b", "c"]);
  assert.throws(() => topoOrder([task("a", 1, ["c"]), task("b", 1, ["a"]), task("c", 1, ["b"]), task("d", 1)]), (e: unknown) => e instanceof ScheduleError && e.code === "CYCLE" && e.taskIds.join() === "a,b,c" && /a → c → b → a/.test(e.message));
  assert.throws(() => topoOrder([task("a", 1, ["zz"])]), (e: unknown) => e instanceof ScheduleError && e.code === "UNKNOWN_DEPENDENCY");
  assert.throws(() => topoOrder([task("a", 1), task("a", 2)]), (e: unknown) => e instanceof ScheduleError && e.code === "DUPLICATE_TASK");
  const r1 = backSchedule(MICROGRID, T("2028-06-15"));
  const r2 = backSchedule([...MICROGRID].reverse(), T("2028-06-15"));
  assert.equal(r1.hash, r2.hash, "input order does not change output");
});

// Remaining five cases: disruption → gate-date movement as stated in INFRASTRUCTURE-CASES.md.
function shiftCase(workDays: number, gateDate: string, delayDays: number) {
  const anchor = new Date(Date.parse(T(gateDate)) - workDays * 86_400_000).toISOString();
  const tasks = [task("work", workDays), task("gate", 0, ["work"]), task("independent", 10)];
  const impact = applyDisruption(tasks, { anchor }, { id: "d", taskId: "work", delayDays, reason: "case disruption", at: anchor });
  return { gate: day(impact.after.tasks.find((t) => t.id === "gate")!.earlyFinish), impact };
}

test("case dates: water main (+10 wk) Aug 1 → Oct 10, 2028; bridge (+8 wk) Nov 1 → Dec 27, 2028; wastewater startup (+5 wk) Jun 1 → Jul 6, 2029", () => {
  const water = shiftCase(60, "2028-08-01", 70);
  assert.equal(water.gate, "2028-10-10");
  assert.deepEqual(water.impact.unchanged.includes("independent"), true);
  assert.equal(shiftCase(90, "2028-11-01", 56).gate, "2028-12-27");
  assert.equal(shiftCase(14, "2029-06-01", 35).gate, "2029-07-06");
});

test("case dates: rural fiber (+14 wk) west build Jul 1 → Oct 7, 2028; launch Jan 15 → Apr 15, 2029 (8 days float on west path)", () => {
  const anchor = T("2028-05-01");
  const tasks = [task("west_build", 61), task("west_acceptance", 190, ["west_build"]), task("east_path", 259), task("service_launch", 0, ["west_acceptance", "east_path"])];
  const impact = applyDisruption(tasks, { anchor }, { id: "d", taskId: "west_build", delayDays: 98, reason: "Make-ready delayed 14 weeks", at: T("2028-06-01") });
  const b = Object.fromEntries(impact.before.tasks.map((t) => [t.id, day(t.earlyFinish)]));
  const a = Object.fromEntries(impact.after.tasks.map((t) => [t.id, day(t.earlyFinish)]));
  assert.deepEqual([b.west_build, b.service_launch], ["2028-07-01", "2029-01-15"]);
  assert.deepEqual([a.west_build, a.service_launch], ["2028-10-07", "2029-04-15"]);
});

test("case dates (doc discrepancies, engine arithmetic reported): substation +20 wk; wastewater sampling", () => {
  // Doc: in-service Oct 1, 2029 → Feb 20, 2030 for a 20-week delay. 140 days from Oct 1 is Feb 18.
  assert.equal(shiftCase(30, "2029-10-01", 140).gate, "2030-02-18");
  // Doc: sampling Sep 1 → Oct 15 for a 5-week outage. A pure 35-day shift gives Oct 6.
  assert.equal(shiftCase(30, "2029-09-01", 35).gate, "2029-10-06");
});

// ---------------------------------------------------------------------------
// Draft store.

const ot = (id: string, evidence: string[] = ["ev-1"]): OwnerTask => ({
  id, title: `Task ${id}`, role: "owner", stage: "permits", dependsOn: [], offsetDays: 0, durationDays: 5,
  inputs: [], output: "memo", evidence, recovery: "escalate", status: "not_started",
});
const LOC = { lat: 33.759123456, lon: -117.99, radius: 5, sector: "electric" as const };

test("draft key: lat/lon toFixed(5), radius, sector", () => {
  assert.equal(draftKey({ lat: 33.759123456, lon: -117.99, radius: 5 }), "33.75912:-117.99000:5");
  assert.equal(draftKey(LOC), "33.75912:-117.99000:5:electric");
});

test("draft reload isolation: same key reloads edits; other location/radius/sector/namespace see nothing", () => {
  const mem = memoryStorage();
  const s1 = createDraftStore(mem);
  const d = setTaskEdit(emptyDraft(draftKey(LOC)), ot("t1"), { owner: "Ana", status: "in_progress" }, T("2027-01-01"));
  assert.equal(s1.save(LOC, d), true);
  const s2 = createDraftStore(mem);
  const back = s2.load(LOC);
  assert.equal(back.status, "loaded");
  assert.equal(stableHash(back.draft), stableHash(d));
  assert.equal(s2.load({ ...LOC, radius: 10 }).status, "empty");
  assert.equal(s2.load({ ...LOC, sector: "water" }).status, "empty");
  assert.equal(s2.load({ ...LOC, lat: 33.76 }).status, "empty");
  assert.equal(s2.load({ ...LOC, lat: 33.7591234 }).status, "loaded", "sub-5-decimal jitter maps to same key");
  assert.equal(createDraftStore(mem, "other-ns").load(LOC).status, "empty");
  assert.equal(s2.save({ ...LOC, radius: 10 }, d), false, "draft cannot be saved under another key");
  mem.setItem(s2.storageKey({ ...LOC, radius: 10 }), JSON.stringify(d));
  assert.equal(s2.load({ ...LOC, radius: 10 }).status, "key_mismatch");
  mem.setItem(s2.storageKey(LOC), "{not json");
  assert.equal(s2.load(LOC).status, "corrupt");
  assert.equal(s2.clear(LOC), true);
  assert.equal(s2.load(LOC).status, "empty");
});

test("localStorage adapter: throwing or missing storage never throws", () => {
  const boom = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); }, removeItem: () => { throw new Error("x"); } };
  const a = localStorageAdapter(boom);
  assert.equal(a.getItem("k"), null);
  assert.equal(a.setItem("k", "v"), false);
  assert.equal(a.removeItem("k"), false);
  const none = localStorageAdapter(null);
  assert.equal(none.setItem("k", "v"), false);
  const g = localStorageAdapter();
  assert.equal(g.setItem("k", "v"), typeof (globalThis as { localStorage?: unknown }).localStorage !== "undefined");
  const map = new Map<string, string>();
  const fake = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
  const store = createDraftStore(localStorageAdapter(fake));
  assert.equal(store.save(LOC, emptyDraft(draftKey(LOC))), true);
  assert.equal(store.load(LOC).status, "loaded");
});

test("draft merge preserves user edits when evidence/generated tasks change and surfaces orphans", () => {
  let d = emptyDraft(draftKey(LOC));
  const d0 = d;
  d = setTaskEdit(d, ot("t1"), { owner: "Ana", due: T("2027-03-01"), status: "in_progress", notes: "called county" }, T("2027-01-01"));
  d = setTaskEdit(d, ot("t2"), { owner: "Ben" }, T("2027-01-02"));
  d = setSelectedOption(d, "opt-B", T("2027-01-03"));
  assert.deepEqual(d0.edits, {}, "input draft not mutated");
  // Regenerated plan: t1 evidence changed, t2 gone, t3 new.
  const regenerated = [ot("t1", ["ev-1", "ev-2-heatwave"]), ot("t3")];
  const m = mergeDraft(regenerated, d, ["opt-A", "opt-C"]);
  const t1 = m.tasks.find((t) => t.id === "t1")!;
  assert.deepEqual([t1.owner, t1.due, t1.status], ["Ana", T("2027-03-01"), "in_progress"]);
  assert.deepEqual(t1.evidence, ["ev-1", "ev-2-heatwave"], "generated fields come from planner");
  assert.deepEqual(m.changedUnderEdit, ["t1"]);
  assert.deepEqual(m.orphaned.map((o) => o.taskId), ["t2"]);
  assert.equal(m.orphanedOption, "opt-B");
  assert.ok(d.edits.t2, "orphaned edit kept in draft until resolved");
  assert.equal(m.tasks.find((t) => t.id === "t3")!.owner, undefined);
  const same = mergeDraft([ot("t1"), ot("t2")], d, ["opt-B"]);
  assert.deepEqual([same.changedUnderEdit, same.orphaned, same.orphanedOption], [[], [], null]);
});
