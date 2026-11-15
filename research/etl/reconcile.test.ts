import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcile, scopeDifferences, type ComparisonScope, type Observation } from "./reconcile";

const scope: ComparisonScope = {
  metric: "balancing-authority demand", entity: "balancing-authority:CISO", unit: "MW",
  start: "2026-11-15T00:00:00Z", end: "2026-11-15T01:00:00Z",
  statistic: "hourly mean MW", basis: "Balancing-authority demand averaged over one UTC clock hour",
};

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    scope, source: "eia-hourly-demand", publisher: "U.S. Energy Information Administration",
    release: "retrieved 2026-11-15T01:03:29.000Z", snapshot: "snp_left", locator: "/response/data/0/value",
    value: 24000, ...overrides,
  };
}
const caiso = (value: number, overrides: Partial<Observation> = {}) => observation({
  source: "caiso-demand-5min", publisher: "California ISO", snapshot: "snp_right", locator: "mean(/rows/192/3)",
  value, ...overrides,
});
const tolerance = { absolute: 300, basis: "Reviewer-chosen band for telemetry vs EIA-930" };

test("exact agreement selects the left candidate without blending", () => {
  const result = reconcile(observation(), caiso(24000), { scope });
  assert.equal(result.status, "agreement");
  assert.equal(result.selected?.value, 24000);
  assert.equal(result.independent, true);
});

test("a difference inside the documented tolerance is within_tolerance and selects nothing without authority", () => {
  const result = reconcile(observation(), caiso(24250), { scope, tolerance });
  assert.equal(result.status, "within_tolerance");
  assert.equal(result.selected, null);
  assert.equal("difference" in result && result.difference, 250);
});

test("a conflict keeps both values and never produces a mean", () => {
  const result = reconcile(observation(), caiso(25000), { scope, tolerance });
  assert.equal(result.status, "conflict");
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates.map(({ value }) => value), [24000, 25000]);
  const mean = (24000 + 25000) / 2;
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(String(mean)), false, "no averaged value anywhere in the result");
  assert.equal(Object.values(result).includes(mean), false);
});

test("a conflict with no tolerance is a conflict even for a 1-unit difference", () => {
  assert.equal(reconcile(observation(), caiso(24001), { scope }).status, "conflict");
});

test("different scopes are incomparable and never independent", () => {
  const other = caiso(24000, { scope: { ...scope, basis: "Some other definition" } });
  const result = reconcile(observation(), other);
  assert.equal(result.status, "incomparable");
  assert.equal(result.independent, false);
  assert.equal(result.selected, null);
  assert.deepEqual(scopeDifferences(scope, other.scope), ["basis"]);
});

test("equivalent offsets normalise to the same scope; offset-less timestamps are rejected", () => {
  const shifted = caiso(24000, { scope: { ...scope, start: "2026-11-14T16:00:00-08:00", end: "2026-11-14T17:00:00-08:00" } });
  assert.equal(reconcile(observation(), shifted, { scope }).status, "agreement");
  assert.deepEqual(scopeDifferences(scope, shifted.scope), []);
  const naive = caiso(24000, { scope: { ...scope, start: "2026-11-15T00:00:00" } });
  assert.throws(() => reconcile(observation(), naive), /explicit offsets/);
  assert.throws(() => reconcile(naive, observation()), /explicit offsets/);
  assert.throws(() => scopeDifferences(scope, naive.scope), /explicit offsets/);
});

test("authority selects exactly one candidate in a conflict; the other value stays a candidate", () => {
  const result = reconcile(observation(), caiso(25000), { scope, tolerance, authority: "caiso-demand-5min" });
  assert.equal(result.status, "conflict");
  assert.equal(result.selected?.source, "caiso-demand-5min");
  assert.equal(result.selected?.value, 25000);
  assert.deepEqual(result.candidates.map(({ value }) => value), [24000, 25000]);
});

test("an authority matching both candidates selects neither", () => {
  const sameSource = observation({ value: 25000, snapshot: "snp_later", release: "retrieved later" });
  const result = reconcile(observation(), sameSource, { scope, authority: "eia-hourly-demand" });
  assert.equal(result.status, "conflict");
  assert.equal(result.selected, null);
});

test("same-publisher releases are flagged as not independent", () => {
  const bulk = observation({ source: "eia-930-bulk", release: "bulk 2026-11-15", snapshot: "snp_bulk" });
  const result = reconcile(observation(), bulk, { scope });
  assert.equal(result.status, "agreement");
  assert.equal(result.independent, false);
  assert.equal(reconcile(observation(), caiso(24000), { scope }).independent, true);
});

test("a policy scope that differs from the observations is rejected", () => {
  assert.throws(() => reconcile(observation(), caiso(24000), { scope: { ...scope, unit: "MWh" } }), /Policy scope mismatch/);
});

test("a tolerance without a documented basis or with a negative bound is rejected", () => {
  assert.throws(() => reconcile(observation(), caiso(24100), { scope, tolerance: { absolute: 300, basis: " " } }), /documented basis/);
  assert.throws(() => reconcile(observation(), caiso(24100), { scope, tolerance: { absolute: -1, basis: "x" } }), /finite absolute/);
});
