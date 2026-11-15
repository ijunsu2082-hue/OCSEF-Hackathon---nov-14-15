import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOwnerPlan, candidateId, evaluateRules, getOwnerPlanFixture, OWNER_PLAN_FIXTURES, validateOwnerPlan } from "../lib/ownerPlan";
import type { DailyRating, LineRatingNow, ScanResult } from "../lib/scan/types";

const scan: ScanResult = {
  area: { lat: 33.78, lon: -117.98, radius_mi: 12 }, area_label: "Westminster test area", inside_coverage: true,
  plants: [], lines: [], substations: [], cases: [], events: [],
  totals: {
    plant_count: 0, nameplate_mw: 0, mw_by_source: { solar: 0, battery: 0, natural_gas: 0, wind: 0, hydro: 0, biogas: 0, oil: 0, other_gas: 0, waste_heat: 0, other: 0 },
    renewable_mw: 0, storage_mw: 0, fossil_mw: 0, renewable_pct: 0, cap_weighted_age: null, oldest: null,
    planned_retirement_mw: 0, retired_mw: 0, proposed_mw: 0, proposed_storage_mw: 0, line_miles: 22.4,
    line_miles_by_kv: { "500+": 0, "200-499": 4, "100-199": 8, "<100": 10.4, unknown: 0 },
    substation_count: 2, hv_substation_count: 1, evening_cover_pct: null,
  },
  risk: { score: 20, level: "WATCH", factors: [
    { key: "heat", label: "Heat exposure", score: 30, weight: 0.6, detail: "Synthetic heat risk for test." },
    { key: "aging", label: "Asset age", score: 10, weight: 0.4, detail: "Synthetic age risk for test." },
  ] },
  rating_site: { key: "westminster_hs", name: "Westminster HS", lat: 33.78, lon: -117.98, distance_mi: 0, median_conservative_dlr_vs_static: 1.1, pct_hours_conservative_dlr_above_static: 40, summer_4to8pm_median_wind_gain_over_aar: 1, hottest_hour: "2025-08-01T17:00:00", hottest_temp_c: 40, hottest_hour_dlr_vs_static: 1.05 },
  upgrade_ideas: [], elapsed_ms: 1,
};
const live: LineRatingNow = { static_A: 100, aar_A: 110, dlr_A: 120, dlr_conservative_A: 115, ratio: 1.15, extra_pct: 15, weather: { temp_c: 28, wind_ms: 3, sun_wm2: 300, time: "2026-11-15T12:00:00Z", source: "open-meteo-live" } };
const daily: DailyRating[] = [{ date: "2025-08-01", static_A: 100, worst_A: 80, median_A: 110, max_temp_c: 41 }];

test("builds deterministic plan inventory and keeps owner facts unknown", () => {
  const a = buildOwnerPlan(scan, live, daily);
  const b = buildOwnerPlan(scan, null, null);
  assert.equal(a.interventions.length, 5);
  assert.equal(a.funding.length, 5);
  assert.equal(a.authorizations.length, 3);
  assert.equal(a.topRisks.length, 2);
  assert.ok(a.topRisks[0].weightedScore >= a.topRisks[1].weightedScore);
  assert.match(a.sustainability.caveat, /does not establish/);
  assert.equal(a.decisionComparison.map((x) => x.option).join(","), "defer,operate");
  assert.equal(a.confidenceGap.score + a.confidenceGap.gap, 100);
  assert.equal(a.confidenceGap.meaning.includes("not a probability"), true);
  assert.ok(a.nextStep.title.length > 20);
  assert.deepEqual(a.interventions.map((x) => x.id), b.interventions.map((x) => x.id));
  assert.equal(a.interventions[1].evidence.some((e) => e.includes("weather-specific screening")), true);
  assert.equal(b.interventions[1].confidence, "low");
  assert.equal(b.interventions[1].evidence.some((e) => e.includes("safe operating limit")), false);
  assert.deepEqual(validateOwnerPlan(a), []);
  assert.ok(a.funding.every((x) => x.url.startsWith("https://") && x.applicability.length > 20));
  assert.ok(a.funding.every((x) => x.deadline === null || /^20\d\d-\d\d-\d\d$/.test(x.deadline)));
});

test("uses canonical stable IDs and evaluates readiness from server-side tri-state answers", () => {
  const plan = buildOwnerPlan(scan, null, null);
  assert.equal(candidateId("intervention", "Dynamic Line Rating"), "intervention:dynamic-line-rating");
  assert.equal(evaluateRules(plan, {}).ready, null);
  const allYes = Object.fromEntries(plan.rules.map((r) => [r.id, "yes" as const]));
  assert.equal(evaluateRules(plan, allYes).ready, true);
  const blocked = { ...allYes, [plan.rules[0].id]: "no" as const };
  assert.equal(evaluateRules(plan, blocked).ready, false);
  assert.equal(evaluateRules(plan, {}).evaluations[0].status, "unknown");
});

test("validates malformed dependency DAG and rule IDs", () => {
  const plan = buildOwnerPlan(scan, null, null);
  const candidate = plan.interventions[0];
  candidate.tasks[0].dependsOn = [candidate.tasks[1].id];
  candidate.tasks[1].dependsOn = [candidate.tasks[0].id];
  assert.ok(validateOwnerPlan(plan).some((message) => message.includes("cycle")));
  candidate.tasks[0].dependsOn = [];
  candidate.tasks[1].dependsOn = ["task:missing"];
  assert.ok(validateOwnerPlan(plan).some((message) => message.includes("unknown task dependency")));
});

test("exposes six explicit sector fixtures and never infers non-grid facts", () => {
  assert.equal(OWNER_PLAN_FIXTURES.length, 6);
  assert.deepEqual(getOwnerPlanFixture("water-main-renewal").sector, "water");
  assert.equal(getOwnerPlanFixture("water-main-renewal").synthetic, true);
  assert.throws(() => getOwnerPlanFixture("not-a-fixture" as never), /Unknown owner plan fixture/);
  assert.ok(OWNER_PLAN_FIXTURES.every((x) => x.objective && x.topRisks.length === 2 && x.sustainabilityEvidence.length > 0 && x.nextStep && x.defer && x.operate));
  assert.ok(OWNER_PLAN_FIXTURES.every((x) => x.confidenceScore + x.confidenceGap === 100 && x.missingEvidence.length > 0));
  assert.ok(OWNER_PLAN_FIXTURES.filter((x) => x.sector !== "electric").every((x) => x.notes.some((n) => n.includes("not inferred") || n.includes("not inferred"))));
});

const FIXTURE_PHASES = ["screen", "fund-permit", "procure", "deliver-commission", "operate-renew", "retire"];
for (const fixture of OWNER_PLAN_FIXTURES) {
  test(`fixture DAG ${fixture.id} has a complete ordered path through retirement`, () => {
    assert.deepEqual(fixture.lifecycle.map((task) => task.phase), FIXTURE_PHASES);
    assert.equal(new Set(fixture.lifecycle.map((task) => task.id)).size, 6);
    fixture.lifecycle.forEach((task, index) => {
      assert.ok(task.owner.length > 0, `${task.phase} owner`);
      assert.ok(task.prerequisites.length > 0, `${task.phase} prerequisite`);
      assert.ok(task.deliverable.length > 0, `${task.phase} deliverable`);
      assert.ok(task.evidence.length > 0, `${task.phase} evidence`);
      assert.ok(task.recovery.length > 20, `${task.phase} recovery`);
      assert.deepEqual(task.dependsOn, index === 0 ? [] : [fixture.lifecycle[index - 1].id]);
      assert.ok(task.dependsOn.every((dep) => fixture.lifecycle.some((candidate) => candidate.id === dep)));
    });
  });
}

test("fixture recovery plans handle missed funding, credentials, equipment, commissioning, and renewals", () => {
  const recoveries = OWNER_PLAN_FIXTURES.flatMap((fixture) => fixture.lifecycle.map((task) => task.recovery)).join(" ");
  assert.match(recoveries, /funding window is missed|application window or street permit is missed|funding approval or a required permit is missed|award or permit is delayed|grant deadline or route permission is missed/i);
  assert.match(recoveries, /unlicensed bids|unqualified contractor|credentials|lapsed credentials/i);
  assert.match(recoveries, /nonconforming pipe|equipment|materials|specs/i);
  assert.match(recoveries, /failed commissioning|failed performance|failed pressure|failed protection|failed optical|failed inspection/i);
  assert.match(recoveries, /renewal|maintenance|permit renewal/i);
});
