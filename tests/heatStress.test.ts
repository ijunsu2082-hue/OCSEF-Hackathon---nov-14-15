import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGridData } from "../lib/scan/data";
import { scanArea } from "../lib/scan/scan";
import { CENTER } from "../lib/scan/geo";
import { heatStress, type HeatStressResult } from "../lib/scan/heatStress";
import { stubFetchFromPublic } from "./helpers";

stubFetchFromPublic();

/** Every number anywhere in the result must be finite. */
function assertNoNaN(v: unknown, path = "result"): void {
  if (typeof v === "number") assert.ok(Number.isFinite(v), `${path} is ${v}`);
  else if (Array.isArray(v)) v.forEach((x, i) => assertNoNaN(x, `${path}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) assertNoNaN(x, `${path}.${k}`);
}

function check(h: HeatStressResult) {
  const { loads, transformer } = h;
  assert.ok(loads.nodes.length >= 1, "at least one load center (nearest fallback)");
  assert.ok(loads.heatwave_mw > loads.baseline_mw, `heatwave ${loads.heatwave_mw} MW <= baseline ${loads.baseline_mw} MW`);
  assert.ok(loads.heatwave_co2_t_yr > loads.baseline_co2_t_yr, "heatwave CO2 not above baseline");
  assert.ok(Number.isInteger(loads.overloads) && loads.overloads >= 0, `overloads ${loads.overloads}`);
  assert.ok(loads.overloads <= loads.nodes.length, "more overloads than load centers");
  assert.ok(transformer.heatwave.peak_hotspot_c > transformer.normal.peak_hotspot_c, "hot-spot not higher at 105 °F");
  assert.ok(transformer.heatwave.aging_hours > transformer.normal.aging_hours, "aging not higher at 105 °F");
  assert.ok(transformer.heatwave.life_used_pct > transformer.normal.life_used_pct, "life used not higher at 105 °F");
  assert.ok(transformer.normal.aging_hours > 0, "normal-day aging is zero");
  for (const day of [transformer.normal, transformer.heatwave]) {
    // Physical sanity: hot-spot above the peak air temperature, below runaway; under a day of aging per day.
    assert.ok(day.peak_hotspot_c > day.peak_ambient_c && day.peak_hotspot_c < 200, `hot-spot ${day.peak_hotspot_c} °C`);
    assert.ok(day.aging_hours < 24, `aging ${day.aging_hours} h in one day at ${day.peak_loading_pct}% load`);
    assert.ok(day.life_used_pct >= 0 && day.life_used_pct < 1, `life used ${day.life_used_pct}%`);
  }
  assert.ok(Number.isInteger(transformer.substations) && transformer.substations >= 0);
  assertNoNaN(h);
}

test("heatStress: Westminster HS 5 / 15 / 30 mi", async () => {
  const data = await loadGridData();
  for (const radius of [5, 15, 30]) {
    const r = scanArea(data, { lat: CENTER.lat, lon: CENTER.lon, radius_mi: radius });
    for (const hw of [true, false]) {
      const h = heatStress(r, hw);
      assert.equal(h.heatwave, hw);
      assert.equal(h.transformer.substations, r.totals.substation_count);
      check(h);
    }
  }
});

test("heatStress: circle with no load center falls back to the nearest one", async () => {
  const data = await loadGridData();
  // Westminster HS 5 mi: the nearest seeded load center (node-oc-01) is ~5.7 mi away.
  const r = scanArea(data, { lat: CENTER.lat, lon: CENTER.lon, radius_mi: 5 });
  const h = heatStress(r, true);
  assert.equal(h.loads.inside_circle, false);
  assert.equal(h.loads.nodes.length, 1);
  assert.ok(h.loads.nodes[0].distance_mi > 5);
});

test("heatStress: same numbers either way of the toggle", async () => {
  const data = await loadGridData();
  const r = scanArea(data, { lat: CENTER.lat, lon: CENTER.lon, radius_mi: 15 });
  const on = heatStress(r, true), off = heatStress(r, false);
  assert.deepEqual({ ...on, heatwave: false }, off);
});
