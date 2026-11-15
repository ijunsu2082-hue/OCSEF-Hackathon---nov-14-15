// Run: node node_modules/tsx/dist/cli.mjs --test lib/owner/ownerPlan.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import type { ScanResult as HeadScanResult } from "../scan/areaScan";
import type { ScanResult as Pr2ScanResult } from "../scan/types";
import { computeRisk } from "../scan/risk";
import { buildOwnerPlan, planKey, reforecastMilestones } from "./ownerPlan";
import { planInputFromHeadScan, planInputFromPr2Scan, type Pr2ScanResultLike } from "./planInput";
import { evaluateCase, FIXTURE_AS_OF, heatFindingsCheck, ownerCases } from "./fixtures";
import type { DraftEdits, Sector } from "./types";

// Compile-time: PR #2's ScanResult (identical file on HEAD) satisfies the local structural type.
const _pr2Compat: (r: Pr2ScanResult) => Pr2ScanResultLike = (r) => r;
void _pr2Compat;

function headScan(over: Partial<HeadScanResult> = {}): HeadScanResult {
  return {
    point: { lat: 33.75, lon: -118.0, radius_mi: 3 }, label: "Synthetic HEAD scan", inside_coverage: true, max_voltage_kv: 230, wire: null,
    plant_count: 2, nameplate_mw: 500, renewable_mw: 50, storage_mw: 20, fossil_mw: 430, renewable_pct: 10,
    mw_by_source: { natural_gas: 430, solar: 50, battery: 20 }, line_miles: 40, hv_line_miles: 20,
    line_miles_by_kv: { "500+": 0, "200-499": 20, "100-199": 10, "<100": 10, unknown: 0 },
    substation_count: 4, hv_substation_count: 1, cap_weighted_age: 35, oldest_plant: { name: "Old", year: 1975, distance_mi: 1 },
    planned_retirement_mw: 100, planned_retirement_plants: 1, evening_cover_pct: 40, nearest_load_center: null, plants: [],
    risk: { score: 55, level: "HIGH", factors: [] }, ideas: [], report: "",
    ...over,
  };
}

function shuffleKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(shuffleKeys) as T;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object).reverse();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = shuffleKeys((v as Record<string, unknown>)[k]);
    return out as T;
  }
  return v;
}

for (const c of ownerCases()) {
  test(`case ${c.id}: doc expected outcomes`, () => {
    const rows = evaluateCase(c, buildOwnerPlan, reforecastMilestones);
    const failed = rows.filter((r) => !r.pass);
    assert.deepEqual(failed, [], failed.map((r) => `${r.criterion}: ${r.detail}`).join("\n"));
    assert.ok(rows.length >= 13);
  });
}

test("determinism: same input twice gives identical outputHash; key shuffle gives same inputsHash", () => {
  for (const c of ownerCases()) {
    const a = buildOwnerPlan(c.input, { scenario: "heatwave", asOf: FIXTURE_AS_OF });
    const b = buildOwnerPlan(c.input, { scenario: "heatwave", asOf: FIXTURE_AS_OF });
    assert.equal(a.outputHash, b.outputHash);
    assert.deepEqual(a, b);
    const s = buildOwnerPlan(shuffleKeys(c.input), { scenario: "heatwave", asOf: FIXTURE_AS_OF });
    assert.equal(s.inputsHash, a.inputsHash);
    assert.equal(s.outputHash, a.outputHash);
    assert.notEqual(buildOwnerPlan(c.input, { scenario: "baseline", asOf: FIXTURE_AS_OF }).inputsHash, a.inputsHash);
  }
});

test("purity: buildOwnerPlan never reads the clock or randomness and does not mutate input", () => {
  const c = ownerCases()[0];
  const before = JSON.stringify(c.input);
  const RealDate = Date;
  const realNow = Date.now;
  const realRandom = Math.random;
  class NoClockDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length === 0) throw new Error("clock read");
      super(...(args as ConstructorParameters<typeof Date>));
    }
    static now(): number { throw new Error("clock read"); }
  }
  try {
    globalThis.Date = NoClockDate as DateConstructor;
    Math.random = () => { throw new Error("random read"); };
    const p = buildOwnerPlan(c.input, { scenario: "heatwave", asOf: FIXTURE_AS_OF });
    assert.ok(p.outputHash.length === 64);
  } finally {
    globalThis.Date = RealDate;
    Date.now = realNow;
    Math.random = realRandom;
  }
  assert.equal(JSON.stringify(c.input), before);
});

test("heatwave changes priorities without erasing edits; scenario-removed task edit is orphaned, not dropped", () => {
  const c = ownerCases()[2]; // water
  const key = planKey(c.input.target);
  const edits: DraftEdits = {
    planKey: key,
    tasks: {
      "t.heat.interim": { owner: "J. Ops", status: "in_progress", notes: "set during heatwave" },
      "t.evidence.break_records": { owner: "K. Asset", due: "2026-12-01" },
    },
  };
  const heat = buildOwnerPlan(c.input, { scenario: "heatwave", asOf: FIXTURE_AS_OF, edits });
  const base = buildOwnerPlan(c.input, { scenario: "baseline", asOf: FIXTURE_AS_OF, edits });
  assert.equal(heat.findings[0].id, "r.case.hospital");
  assert.equal(base.findings[0].id, "r.case.breaks");
  assert.equal(heat.tasks[0].id, "t.heat.interim");
  assert.notEqual(base.nextTaskId, heat.nextTaskId);
  assert.equal(heat.tasks.find((t) => t.id === "t.heat.interim")?.owner, "J. Ops");
  assert.equal(heat.tasks.find((t) => t.id === "t.heat.interim")?.notes, "set during heatwave");
  assert.equal(base.tasks.find((t) => t.id === "t.heat.interim"), undefined);
  assert.deepEqual(base.draft.orphaned, [{ taskId: "t.heat.interim", edit: edits.tasks!["t.heat.interim"] }]);
  for (const p of [heat, base]) {
    const t = p.tasks.find((x) => x.id === "t.evidence.break_records")!;
    assert.equal(t.owner, "K. Asset");
    assert.equal(t.due, "2026-12-01");
    assert.ok(p.deadlines.some((d) => d.taskId === t.id && d.kind === "owner_due"));
  }
  // Back to heatwave after baseline: the orphaned edit re-applies.
  const heat2 = buildOwnerPlan(c.input, { scenario: "heatwave", asOf: FIXTURE_AS_OF, edits });
  assert.equal(heat2.outputHash, heat.outputHash);
});

test("heatwave check needs heat-sensitive findings to re-score, not just t.heat.interim first", () => {
  // An engine that still puts t.heat.interim first but ignores heatwave scoring.
  const flat: typeof buildOwnerPlan = (input, opts) => {
    const p = buildOwnerPlan(input, opts);
    return opts.scenario === "heatwave" ? { ...p, findings: buildOwnerPlan(input, { ...opts, scenario: "baseline" }).findings } : p;
  };
  for (const c of ownerCases()) {
    const rows = evaluateCase(c, flat, reforecastMilestones);
    const heat = rows.find((r) => r.criterion === "heatwave re-scores/re-orders heat-sensitive findings")!;
    const prio = rows.find((r) => r.criterion === "heatwave re-prioritizes without erasing edits")!;
    assert.equal(heat.pass, false, `${c.id}: ${heat.detail}`);
    assert.equal(prio.pass, false, `${c.id}: task order alone must not pass`);
    assert.match(prio.detail, /→ t\.heat\.interim$/, "the flat engine still re-orders tasks");
  }
});

test("a case without any heat factor reports the findings check as explicitly not applicable", () => {
  const c = ownerCases()[2]; // water: heat enters only through sector heatwaveScore
  const input = { ...c.input, gridRisk: null, sectorRisks: c.input.sectorRisks.map(({ heatwaveScore: _h, ...r }) => r) };
  const hb = buildOwnerPlan(input, { scenario: "baseline", asOf: FIXTURE_AS_OF });
  const hh = buildOwnerPlan(input, { scenario: "heatwave", asOf: FIXTURE_AS_OF });
  const check = heatFindingsCheck(input, hb, hh);
  assert.equal(check.applies, false);
  assert.equal(check.pass, true);
  assert.match(check.detail, /^not applicable: /);
  const row = evaluateCase({ ...c, input }, buildOwnerPlan, reforecastMilestones)
    .find((r) => r.criterion === "heatwave re-scores/re-orders heat-sensitive findings")!;
  assert.equal(row.pass, true);
  assert.match(row.detail, /^not applicable: /);
  for (const real of ownerCases()) {
    const applies = heatFindingsCheck(real.input,
      buildOwnerPlan(real.input, { scenario: "baseline", asOf: FIXTURE_AS_OF }),
      buildOwnerPlan(real.input, { scenario: "heatwave", asOf: FIXTURE_AS_OF })).applies;
    assert.equal(applies, true, `${real.id}: every fixture carries a heat factor`);
  }
});

test("option switch orphans edits for tasks the new option does not generate", () => {
  const c = ownerCases()[2];
  const key = planKey(c.input.target);
  const edits: DraftEdits = { planKey: key, selectedOption: "o.generic.defer", tasks: { "t.const.complete": { owner: "CM" }, "t.dev.alternatives": { status: "done" } } };
  const p = buildOwnerPlan(c.input, { scenario: "baseline", asOf: FIXTURE_AS_OF, edits });
  assert.equal(p.selectedOption, "o.generic.defer");
  assert.ok(p.tasks.some((t) => t.id === "t.ops.monitor"));
  assert.deepEqual(p.draft.orphaned.map((o) => o.taskId), ["t.const.complete"]);
  assert.deepEqual(p.draft.applied, ["t.dev.alternatives"]);
});

test("sparse HEAD scan → named evidence tasks and not-assessed factors (all six from risk.ts)", () => {
  const input = planInputFromHeadScan(headScan(), { sector: "electric", scannedAt: FIXTURE_AS_OF });
  const p = buildOwnerPlan(input, { scenario: "baseline", asOf: FIXTURE_AS_OF });
  const titles = p.tasks.map((t) => t.title);
  assert.ok(titles.includes("Obtain interval meter data"));
  assert.ok(titles.includes("Connect live weather for line rating"));
  assert.ok(titles.includes("Compile hazard history for the area"));
  assert.ok(p.findings.some((f) => f.id === "g.factor.hazard"));
  assert.ok(p.findings.some((f) => f.id === "g.factor.heat"));
  // Factor keys and weights are risk.ts's own.
  const ref = computeRisk(
    { plant_count: 0, nameplate_mw: 0, mw_by_source: {} as never, renewable_mw: 0, storage_mw: 0, fossil_mw: 0, renewable_pct: 0, cap_weighted_age: null, oldest: null, planned_retirement_mw: 0, retired_mw: 0, proposed_mw: 0, proposed_storage_mw: 0, line_miles: 0, line_miles_by_kv: {} as never, substation_count: 0, hv_substation_count: 0, evening_cover_pct: null },
    { key: "x", name: "x", lat: 0, lon: 0, median_conservative_dlr_vs_static: 1, pct_hours_conservative_dlr_above_static: 0, summer_4to8pm_median_wind_gain_over_aar: 1, hottest_hour: "", hottest_temp_c: 30, hottest_hour_dlr_vs_static: 1.2 },
    [], [], 0,
  );
  assert.deepEqual(input.gridRisk!.baseline.factors.map((f) => [f.key, f.weight]), ref.factors.map((f) => [f.key, f.weight]));
  const top = p.findings.filter((f) => f.kind === "risk").slice(0, 2);
  for (const f of top) assert.deepEqual(Object.keys(f.factors!).sort(), ref.factors.map((x) => x.key).sort());
  // Nameplate never becomes load or emissions.
  assert.equal(typeof p.facts.find((f) => f.id === "f.scan.actual_load")!.value, "object");
  assert.equal(typeof p.facts.find((f) => f.id === "f.scan.emissions")!.value, "object");
  assert.equal(p.scheduleMode, "forward");
});

test("live and daily ratings become model facts; missing live rating becomes Unknown", () => {
  const live = { static_A: 1000, aar_A: 1100, dlr_A: 1300, dlr_conservative_A: 1150, ratio: 1.15, extra_pct: 15, weather: { temp_c: 30, wind_ms: 2, sun_wm2: 800, time: "2026-10-31T20:00", source: "open-meteo-live" as const } };
  const daily = [{ date: "2025-09-06", static_A: 1000, worst_A: 900, median_A: 1100, max_temp_c: 41 }, { date: "2025-09-05", static_A: 1000, worst_A: 1050, median_A: 1150, max_temp_c: 35 }];
  const withLive = planInputFromHeadScan(headScan(), { sector: "electric", scannedAt: FIXTURE_AS_OF, live, daily });
  assert.equal(withLive.facts.find((f) => f.id === "f.rating.live_ratio")?.value, 1.15);
  assert.equal(withLive.facts.find((f) => f.id === "f.rating.live_ratio")?.provenance, "model");
  assert.equal(withLive.facts.find((f) => f.id === "f.rating.daily_days_below_static")?.value, 1);
  assert.equal(withLive.facts.find((f) => f.id === "f.rating.daily_worst_ratio")?.value, 0.9);
  const p = buildOwnerPlan(withLive, { scenario: "baseline", asOf: FIXTURE_AS_OF });
  assert.ok(!p.tasks.some((t) => t.title === "Connect live weather for line rating"));
  const none = planInputFromHeadScan(headScan(), { sector: "electric", scannedAt: FIXTURE_AS_OF });
  assert.equal(typeof none.facts.find((f) => f.id === "f.rating.live_ratio")?.value, "object");
});

test("sector is explicit: electrical scan is never used as non-grid risk; missing sector throws", () => {
  const pr2 = ownerCases()[0];
  void pr2;
  const scan = headScan();
  const water = planInputFromHeadScan(scan, { sector: "water", scannedAt: FIXTURE_AS_OF });
  assert.equal(water.gridRisk, null);
  assert.equal(water.target.sector, "water");
  const p = buildOwnerPlan(water, { scenario: "baseline", asOf: FIXTURE_AS_OF });
  assert.ok(!p.findings.some((f) => f.id.startsWith("r.grid.")));
  assert.ok(p.tasks.some((t) => t.title === "Obtain geocoded break records"));
  assert.throws(() => planInputFromHeadScan(scan, { sector: undefined as unknown as Sector, scannedAt: FIXTURE_AS_OF }), /sector must be stated/);
  assert.throws(() => planInputFromPr2Scan({} as Pr2ScanResultLike, { sector: "gas" as Sector, scannedAt: FIXTURE_AS_OF }), /sector must be stated/);
});

test("options coverage: do-nothing only at intake/feasibility", () => {
  for (const c of ownerCases()) {
    const p = buildOwnerPlan(c.input, { scenario: "baseline", asOf: FIXTURE_AS_OF });
    for (const k of ["repair", "operating_change", "replacement", "defer", "do_nothing"]) assert.ok(p.options.some((o) => o.kind === k), `${c.id} ${k}`);
    const ops = buildOwnerPlan({ ...c.input, stage: "operations" }, { scenario: "baseline", asOf: FIXTURE_AS_OF });
    assert.ok(!ops.options.some((o) => o.kind === "do_nothing"));
    for (const k of ["repair", "operating_change", "replacement", "defer"]) assert.ok(ops.options.some((o) => o.kind === k));
  }
});

test("task field completeness and lifecycle coverage through retirement", () => {
  for (const c of ownerCases()) {
    const p = buildOwnerPlan(c.input, { scenario: "heatwave", asOf: FIXTURE_AS_OF });
    for (const t of p.tasks) {
      assert.ok(t.role && t.output && t.recovery && t.evidence.length > 0 && t.due && Array.isArray(t.dependsOn), `${c.id} ${t.id}`);
      assert.ok(Number.isInteger(t.offsetDays) && t.durationDays > 0);
    }
    const stages = new Set(p.tasks.map((t) => t.stage));
    for (const s of ["feasibility", "site_control", "capital", "grants", "permits", "engineering", "procurement", "construction", "commissioning", "operations", "decommissioning"]) {
      assert.ok(stages.has(s as never), `${c.id} missing stage ${s}`);
    }
  }
});

test("reload isolation: drafts for one target are not applied to another", () => {
  const [mg, , water] = ownerCases();
  const editsA: DraftEdits = { planKey: planKey(mg.input.target), tasks: { "t.dev.need": { owner: "Westminster PM" } } };
  const snapshot = JSON.stringify(editsA);
  const a = buildOwnerPlan(mg.input, { scenario: "baseline", asOf: FIXTURE_AS_OF, edits: editsA });
  const b = buildOwnerPlan(water.input, { scenario: "baseline", asOf: FIXTURE_AS_OF, edits: editsA });
  assert.notEqual(planKey(mg.input.target), planKey(water.input.target));
  assert.equal(a.tasks.find((t) => t.id === "t.dev.need")?.owner, "Westminster PM");
  assert.equal(b.tasks.find((t) => t.id === "t.dev.need")?.owner, undefined);
  assert.match(b.draft.rejected ?? "", /not applied/);
  assert.deepEqual(b.draft.applied, []);
  assert.equal(JSON.stringify(editsA), snapshot);
  const clean = buildOwnerPlan(water.input, { scenario: "baseline", asOf: FIXTURE_AS_OF });
  assert.deepEqual(b.tasks, clean.tasks);
});

test("missed grant window and stale evidence are flagged", () => {
  const mg = ownerCases()[0];
  const late = buildOwnerPlan(mg.input, { scenario: "baseline", asOf: "2027-05-20T00:00:00.000Z" });
  assert.ok(late.deadlines.some((d) => d.taskId === "t.grants.application" && d.kind === "late_start"));
  assert.ok(late.findings.some((f) => f.id === "g.stale.e.scan.pr2"));
  assert.ok(late.tasks.some((t) => t.id === "t.refresh.e.scan.pr2"));
});

test("provenance stays distinct: owner-verified fact supersedes but does not replace the model fact", () => {
  const mg = ownerCases()[0];
  const subject = mg.input.facts.find((f) => f.id === "f.scan.actual_load")!.subject;
  const edits: DraftEdits = { planKey: planKey(mg.input.target), facts: [{ id: "f.owner.peak", subject, predicate: "actual_load", value: 0.5, unit: "MW", provenance: "owner_verified", evidence: ["e.owner.meter"], asOf: FIXTURE_AS_OF }] };
  const p = buildOwnerPlan(mg.input, { scenario: "baseline", asOf: FIXTURE_AS_OF, edits });
  const model = p.facts.find((f) => f.id === "f.scan.actual_load")!;
  const owner = p.facts.find((f) => f.id === "f.owner.peak")!;
  assert.equal(model.provenance, "public_source");
  assert.equal(typeof model.value, "object");
  assert.equal(owner.provenance, "owner_verified");
  assert.equal(owner.supersedes, "f.scan.actual_load");
});
