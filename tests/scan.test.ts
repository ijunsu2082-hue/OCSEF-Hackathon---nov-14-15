import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGridData } from "../lib/scan/data";
import { scanArea } from "../lib/scan/scan";
import { CENTER, haversineMi } from "../lib/scan/geo";
import type { ScanResult } from "../lib/scan/types";
import { stubFetchFromPublic } from "./helpers";

stubFetchFromPublic();

/** Shortest distance (mi) from the center to segment a-b, in a local flat projection (fine at these scales). */
function segDistMi(lat: number, lon: number, a: [number, number], b: [number, number]): number {
  const kx = 69.172 * Math.cos((lat * Math.PI) / 180), ky = 69.0;
  const ax = (a[1] - lon) * kx, ay = (a[0] - lat) * ky, bx = (b[1] - lon) * kx, by = (b[0] - lat) * ky;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function checkScan(r: ScanResult, radius: number) {
  const { lat, lon } = r.area;
  const t = r.totals;
  const sumSrc = Object.values(t.mw_by_source).reduce((s, v) => s + v, 0);
  // mw_by_source entries are rounded to 0.1 MW each.
  const tol = 0.05 * Object.keys(t.mw_by_source).length + 0.1;
  assert.ok(Math.abs(sumSrc - t.nameplate_mw) <= tol, `sum by source ${sumSrc.toFixed(1)} vs nameplate ${t.nameplate_mw}`);
  assert.ok(t.renewable_mw + t.storage_mw + t.fossil_mw <= t.nameplate_mw + tol, "renewable + storage + fossil exceeds nameplate");
  if (t.nameplate_mw > 0) {
    const pct = ((t.renewable_mw + t.storage_mw + t.fossil_mw) / t.nameplate_mw) * 100;
    assert.ok(pct <= 100.1, `category share ${pct.toFixed(2)}%`);
  }
  assert.equal(t.plant_count, r.plants.length);
  assert.equal(t.substation_count, r.substations.length);
  for (let i = 1; i < r.plants.length; i++) {
    assert.ok(r.plants[i - 1].nameplate_mw >= r.plants[i].nameplate_mw, "plants not sorted by MW desc");
  }
  for (const p of r.plants) assert.ok(haversineMi(lat, lon, p.lat, p.lon) <= radius, `plant ${p.plant_name} outside`);
  for (const s of r.substations) assert.ok(haversineMi(lat, lon, s.lat, s.lon) <= radius, `substation ${s.osm_id} outside`);
  for (const e of r.events) assert.ok(haversineMi(lat, lon, e.lat, e.lon) <= radius, `event ${e.plant_name} outside`);
  for (const c of r.cases) assert.ok(haversineMi(lat, lon, c.location.lat, c.location.lon) <= radius, `case ${c.title} outside`);
  for (const l of r.lines) {
    let d = Infinity;
    for (let i = 1; i < l.coords.length; i++) d = Math.min(d, segDistMi(lat, lon, l.coords[i - 1], l.coords[i]));
    assert.ok(d <= radius * 1.01, `line ${l.osm_id} is ${d.toFixed(2)} mi away (radius ${radius})`);
  }
  const bandSum = Object.values(t.line_miles_by_kv).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(bandSum - t.line_miles) <= 0.05 * 5 + 0.1, "line miles by kV do not add up");
}

for (const radius of [5, 30]) {
  test(`scanArea Westminster HS ${radius} mi: totals add up and everything is inside the circle`, async () => {
    const data = await loadGridData();
    const r = scanArea(data, { lat: CENTER.lat, lon: CENTER.lon, radius_mi: radius });
    assert.ok(r.plants.length > 0, "expected plants near Westminster HS");
    assert.ok(r.lines.length > 0, "expected lines near Westminster HS");
    checkScan(r, radius);
    console.log(`scan ${radius} mi: ${r.plants.length} plants, ${r.totals.nameplate_mw} MW, ${r.lines.length} lines, ${r.substations.length} subs, risk ${r.risk.score}`);
  });
}

test("a bigger circle never has less than a smaller one", async () => {
  const data = await loadGridData();
  const a = scanArea(data, { lat: CENTER.lat, lon: CENTER.lon, radius_mi: 5 });
  const b = scanArea(data, { lat: CENTER.lat, lon: CENTER.lon, radius_mi: 30 });
  assert.ok(b.plants.length >= a.plants.length);
  assert.ok(b.totals.nameplate_mw >= a.totals.nameplate_mw);
  assert.ok(b.substations.length >= a.substations.length);
});
