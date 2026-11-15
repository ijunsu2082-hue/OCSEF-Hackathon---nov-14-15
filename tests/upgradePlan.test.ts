import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpgradePlan, upgradePlanMarkdown } from "../lib/scan/upgradePlan";
import type { DailyRating, ScanResult } from "../lib/scan/types";

const MW = {
  solar: 400,
  battery: 80,
  natural_gas: 900,
  wind: 0,
  hydro: 0,
  biogas: 0,
  oil: 0,
  other_gas: 0,
  waste_heat: 0,
  other: 0,
};

function fixture(): ScanResult {
  return {
    area: { lat: 33.98, lon: -117.42, radius_mi: 5 },
    area_label: "Riverside area · near Desert Sun",
    inside_coverage: true,
    plants: [
      {
        plant_code: 1, plant_name: "Desert Sun Solar", utility_name: "Southern California Edison", city: "Riverside", county: "Riverside",
        nameplate_mw: 400, mw_by_source: { solar: 400 }, primary_source: "solar", technologies: ["Solar PV"],
        oldest_year: 2019, newest_year: 2023, capacity_weighted_year: 2021, capacity_weighted_age_years: 5,
        planned_retirement_mw: 0, generator_count: 4, grid_voltage_kv: 230, lat: 33.98, lon: -117.42,
      },
      {
        plant_code: 2, plant_name: "Riverside Gas Unit", utility_name: "Southern California Edison", city: "Riverside", county: "Riverside",
        nameplate_mw: 900, mw_by_source: { natural_gas: 900 }, primary_source: "natural_gas", technologies: ["Gas Turbine"],
        oldest_year: 1974, newest_year: 2005, capacity_weighted_year: 1990, capacity_weighted_age_years: 34,
        planned_retirement_mw: 250, generator_count: 6, grid_voltage_kv: 230, lat: 33.97, lon: -117.41,
      },
    ],
    lines: [
      { osm_id: 11, voltage_kv: 500, operator: "Southern California Edison", name: "Devers-Palo Verde 1", circuits: "2", coords: [[33.98, -117.42], [34.0, -117.4]] },
      { osm_id: 12, voltage_kv: 230, operator: "Southern California Edison", name: "Riverside-Mira Loma", circuits: null, coords: [[33.97, -117.43], [33.99, -117.39]] },
      { osm_id: 13, voltage_kv: 115, operator: null, name: null, circuits: null, coords: [[33.96, -117.44], [33.98, -117.38]] },
    ],
    substations: [
      { osm_id: "node/1", name: "Riverside Switching", operator: "Southern California Edison", voltage_kv: 500, substation: "transmission", lat: 33.981, lon: -117.421 },
      { osm_id: "node/2", name: "Mira Loma", operator: "Southern California Edison", voltage_kv: 230, substation: "transmission", lat: 33.982, lon: -117.423 },
    ],
    cases: [
      {
        id: "case-fire", title: "Canyon fire near line corridor", category: "Wildfire",
        location: { name: "Riverside Canyon", lat: 33.99, lon: -117.41, distance_mi: 2 },
        one_liner: "Wind-driven fire crossed an overhead corridor.",
        problem: "Overhead line in a high fire-threat area.", fix: "Covered conductor on exposed spans.",
        shock_line: "A wind-driven fire crossed the corridor and closed a transmission line for 14 hours.",
        stats: [], team_bullets: [],
      },
    ],
    events: [],
    totals: {
      plant_count: 2, nameplate_mw: 1480, mw_by_source: MW, renewable_mw: 400, storage_mw: 80, fossil_mw: 900,
      renewable_pct: 27, cap_weighted_age: 34, oldest: { name: "Riverside Gas Unit", year: 1974 },
      planned_retirement_mw: 250, retired_mw: 0, proposed_mw: 120, proposed_storage_mw: 60,
      line_miles: 150, line_miles_by_kv: { "500+": 60, "200-499": 90, "100-199": 0, "<100": 0, unknown: 0 },
      substation_count: 2, hv_substation_count: 2,
      evening_cover_pct: 20,
    },
    risk: {
      score: 64, level: "WATCH",
      factors: [
        { key: "age", label: "Plant age", score: 72, weight: 0.25, detail: "Capacity-weighted 34 years." },
        { key: "fossil", label: "Fossil share", score: 61, weight: 0.2, detail: "900 MW of 1,480 MW is gas." },
      ],
    },
    rating_site: {
      key: "riverside", name: "Riverside", lat: 33.95, lon: -117.4,
      median_conservative_dlr_vs_static: 1.18, pct_hours_conservative_dlr_above_static: 62,
      summer_4to8pm_median_wind_gain_over_aar: 1.04, median_aar_vs_static: 1.18,
      hottest_hour: "2025-09-06T15:00", hottest_temp_c: 44, hottest_hour_dlr_vs_static: 0.92, distance_mi: 6,
    },
    upgrade_ideas: [],
    elapsed_ms: 12,
  };
}

function daily(): DailyRating[] {
  return Array.from({ length: 10 }, (_, index) => ({
    date: `2025-08-${String(index + 1).padStart(2, "0")}`,
    static_A: 723,
    worst_A: index < 4 ? 680 : 760,
    median_A: 800,
    max_temp_c: index < 4 ? 45 : 31,
  }));
}

test("plan is deterministic, ranked, and the storage lever is sized from the scan", () => {
  const plan = buildUpgradePlan(fixture(), null, daily());
  assert.deepEqual(plan, buildUpgradePlan(fixture(), null, daily()));
  assert.equal(plan.improvements[0].id, "sunset-storage");
  assert.equal(plan.improvements[0].label, "Evening storage");
  assert.match(plan.improvements[0].headline, /120 MW/);
  assert.match(plan.improvements[0].finding, /400 MW/);
  assert.equal(plan.improvements[0].metrics.length, 3);
  assert.equal(plan.state, "CA");
  assert.ok(!("headline" in plan) && !("funding" in plan));
  assert.ok(plan.improvements.every((item) => !("rank" in item) && !("fundingIds" in item)));
  for (let i = 1; i < plan.improvements.length; i++) {
    assert.ok(plan.improvements[i - 1].score >= plan.improvements[i].score);
  }
  assert.ok(plan.improvements.every((item) => item.steps.length >= 1 && item.steps.length <= 5));
});

test("steps vary by lever: kinds, count, and named counterparties", () => {
  const plan = buildUpgradePlan(fixture(), null, daily());
  const storage = plan.improvements.find((item) => item.id === "sunset-storage")!;
  assert.deepEqual(storage.steps.map((step) => step.kind), ["request", "model", "meet", "fund"]);
  assert.ok(storage.steps.some((step) => step.who === "Southern California Edison"));
  assert.ok(storage.steps.some((step) => step.detail.includes("Riverside")));
  assert.ok(storage.steps.some((step) => step.detail.includes("Riverside Switching")));

  const weather = plan.improvements.find((item) => item.id === "weather-rating")!;
  assert.deepEqual(weather.steps.map((step) => step.kind), ["ask", "request", "test", "file"]);
  assert.ok(weather.steps[0].detail.includes("Devers-Palo Verde 1"));
  assert.ok(weather.metrics.some((metric) => metric.value === "+18%"));

  const retirement = plan.improvements.find((item) => item.id === "retirement-gap")!;
  assert.equal(retirement.steps.length, 3);
  assert.match(retirement.finding, /Riverside Gas Unit/);
});

test("each lever's funding is matched from watched sources, not a shared list", () => {
  const plan = buildUpgradePlan(fixture(), null, daily());
  const storage = plan.improvements.find((item) => item.id === "sunset-storage")!;
  const weather = plan.improvements.find((item) => item.id === "weather-rating")!;
  const retirement = plan.improvements.find((item) => item.id === "retirement-gap")!;
  const wildfire = plan.improvements.find((item) => item.id === "wildfire-hardening")!;

  assert.ok(storage.funding.some((match) => match.id === "cec-deba"));
  assert.ok(weather.funding.some((match) => match.id === "cec-cerri"));
  assert.ok(!storage.funding.some((match) => match.id === "cec-cerri"));
  assert.ok(retirement.funding.some((match) => match.id === "doe-formula"));
  assert.ok(wildfire.funding.some((match) => match.id === "fema-bric"));
  for (const item of plan.improvements) {
    for (const match of item.funding) {
      assert.match(match.url, /^https:\/\//);
      assert.ok(match.checkedAt);
      assert.match(match.next, /\S/);
    }
  }
  assert.ok(plan.grants.watched <= plan.grants.total);
  assert.ok(plan.grants.watched >= 4, "the watched artifact should carry its programme checks");
});

test("markdown exports the chosen lever with its own steps and funding only", () => {
  const plan = buildUpgradePlan(fixture(), null, daily());
  const storage = plan.improvements.find((item) => item.id === "sunset-storage")!;
  const text = upgradePlanMarkdown(plan, "Riverside area", 5, storage.id);
  assert.match(text, /# Evening storage — Riverside area/);
  assert.match(text, /\(request\) Measure the sunset ramp/);
  assert.doesNotMatch(text, /Wildfire hardening/);
  assert.match(text, /CEC Distributed Electricity Backup Assets/);
  assert.match(text, /Checked against \d+\/\d+ watched programmes/);
  assert.doesNotMatch(text, /Community Energy Reliability/);
  assert.match(text, /Before you rely on it/);
  assert.doesNotMatch(text, /NaN|undefined/);
  assert.doesNotMatch(JSON.stringify(plan), /NaN|undefined/);
});

test("a circle with no mapped assets offers only the re-scan lever", () => {
  const empty = fixture();
  empty.lines = [];
  empty.plants = [];
  empty.substations = [];
  empty.cases = [];
  empty.totals = {
    ...empty.totals,
    plant_count: 0, nameplate_mw: 0, mw_by_source: { ...MW, solar: 0, natural_gas: 0 }, renewable_mw: 0,
    storage_mw: 0, fossil_mw: 0, renewable_pct: 0, cap_weighted_age: null, oldest: null,
    planned_retirement_mw: 0, proposed_mw: 0, proposed_storage_mw: 0, line_miles: 0,
    line_miles_by_kv: { "500+": 0, "200-499": 0, "100-199": 0, "<100": 0, unknown: 0 },
    substation_count: 0, hv_substation_count: 0, evening_cover_pct: null,
  };
  const plan = buildUpgradePlan(empty, null, null);
  assert.equal(plan.improvements.length, 1);
  assert.equal(plan.improvements[0].id, "no-assets");
  assert.equal(plan.improvements[0].steps.length, 1);
  assert.deepEqual(plan.improvements[0].funding, []);
  assert.ok(plan.improvements[0].evidence.length >= 2);
});

test("wind and queue levers appear only when their own measurement does", () => {
  const windy = fixture();
  windy.rating_site = { ...windy.rating_site, summer_4to8pm_median_wind_gain_over_aar: 1.19 };
  const plan = buildUpgradePlan(windy, null, daily());

  const wind = plan.improvements.find((item) => item.id === "wind-rating");
  assert.ok(wind, "wind lever missing on a site with a 19% evening gain");
  assert.deepEqual(wind.steps.map((step) => step.kind), ["ask", "model", "test", "file"]);
  assert.match(wind.finding, /\+?19%/);
  assert.ok(wind.evidence.some((line) => line.includes("Riverside")));

  const calm = buildUpgradePlan(fixture(), null, daily());
  assert.ok(!calm.improvements.some((item) => item.id === "wind-rating"));

  const queue = plan.improvements.find((item) => item.id === "queue-conversion");
  assert.ok(queue, "queue lever missing with 120 MW proposed");
  assert.match(queue.headline, /120 MW/);
  assert.equal(queue.metrics.length, 3);
  assert.ok(queue.evidence.length >= 2);

  const noQueue = fixture();
  noQueue.totals = { ...noQueue.totals, proposed_mw: 0, proposed_storage_mw: 0 };
  assert.ok(!buildUpgradePlan(noQueue, null, daily()).improvements.some((item) => item.id === "queue-conversion"));
});

test("aging gas fires on a smaller, older fleet and every lever has named evidence", () => {
  const la = fixture();
  la.totals = { ...la.totals, fossil_mw: 176, cap_weighted_age: 31.6, nameplate_mw: 187 };
  la.rating_site = { ...la.rating_site, summer_4to8pm_median_wind_gain_over_aar: 1.2 };
  const plan = buildUpgradePlan(la, null, daily());

  const aging = plan.improvements.find((item) => item.id === "aging-fossil");
  assert.ok(aging, "aging lever missing for 176 MW at 31.6 years");
  assert.ok(aging.evidence.length >= 2);

  const ids = plan.improvements.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate lever ids");
  for (const item of plan.improvements) {
    assert.ok(item.evidence.length >= 2, `${item.id} has no evidence`);
    assert.ok(item.evidence.every((line) => line.length > 0 && !line.includes("undefined")), `${item.id} evidence is malformed`);
  }
});
