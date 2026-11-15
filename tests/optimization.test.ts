import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGridData } from "../lib/scan/data";
import { scanArea } from "../lib/scan/scan";
import { CENTER } from "../lib/scan/geo";
import type { DailyRating, ScanResult } from "../lib/scan/types";
import { buildWorkflow, OPTION_ORDER, RULES, shortDayPct } from "../lib/scan/optimization";
import { stubFetchFromPublic } from "./helpers";

stubFetchFromPublic();

async function westminster(radius = 5): Promise<ScanResult> {
  const data = await loadGridData();
  return scanArea(data, { lat: CENTER.lat, lon: CENTER.lon, radius_mi: radius });
}

const day = (worst: number, stat = 100): DailyRating => ({ date: "2025-01-01", static_A: stat, worst_A: worst, median_A: worst, max_temp_c: 20 });

test("same scan always produces the same workflow", async () => {
  const r = await westminster();
  const daily = [day(120), day(130), day(95)];
  const a = buildWorkflow(r, { daily });
  const b = buildWorkflow(structuredClone(r), { daily: structuredClone(daily) });
  assert.deepEqual(a, b);
});

test("Westminster: six steps, weather rating screens in, shortlist follows the objective order", async () => {
  const r = await westminster();
  const w = buildWorkflow(r, { daily: Array.from({ length: 30 }, () => day(140)) });
  assert.equal(w.stopped, false);
  assert.deepEqual(w.steps.map((s) => s.id), ["scope", "voltage", "weather_rating", "reconductor", "storage", "new_line"]);
  const s3 = w.steps.find((s) => s.id === "weather_rating")!;
  // Westminster HS site: 99.7% of hours above static, median 1.45×, and the scan center is the site.
  assert.equal(s3.verdict, "candidate");
  for (const objective of ["transfer", "cost", "resilience", "emissions"] as const) {
    const ww = buildWorkflow(r, { daily: Array.from({ length: 30 }, () => day(140)), objective });
    const order = OPTION_ORDER[objective];
    const idx = ww.shortlist.map((i) => order.indexOf(i.option));
    assert.deepEqual(idx, [...idx].sort((x, y) => x - y), `${objective} shortlist out of order`);
    for (const item of ww.shortlist) assert.ok(item.verdict === "candidate" || item.verdict === "weak");
  }
});

test("objective changes order only, never verdicts", async () => {
  const r = await westminster(10);
  const daily = [day(90), day(95), day(130)];
  const verdicts = (o: "transfer" | "cost" | "resilience" | "emissions") =>
    buildWorkflow(r, { daily, objective: o }).steps.map((s) => s.verdict);
  const base = verdicts("transfer");
  for (const o of ["cost", "resilience", "emissions"] as const) assert.deepEqual(verdicts(o), base);
});

test("outside coverage stops at step 1", async () => {
  const data = await loadGridData();
  const r = scanArea(data, { lat: 40.7, lon: -74.0, radius_mi: 5 });
  const w = buildWorkflow(r);
  assert.equal(w.stopped, true);
  assert.equal(w.steps.length, 1);
  assert.equal(w.steps[0].verdict, "stop");
  assert.deepEqual(w.shortlist, []);
});

test("short-day rule: reconductoring screens in at the threshold, not below", async () => {
  const r = await westminster();
  // 1 of 10 days below 1.0× = 10% → candidate (threshold is inclusive).
  const at = [day(90), ...Array.from({ length: 9 }, () => day(130))];
  assert.equal(shortDayPct(at)!.pct, RULES.reconductorShortDayPct);
  assert.equal(buildWorkflow(r, { daily: at }).steps.find((s) => s.id === "reconductor")!.verdict, "candidate");
  // 1 of 11 days ≈ 9.1% → not supported (hottest hour at this site is above 1.0×).
  const below = [day(90), ...Array.from({ length: 10 }, () => day(130))];
  assert.equal(buildWorkflow(r, { daily: below }).steps.find((s) => s.id === "reconductor")!.verdict, "not_supported");
  // No daily data → needs data.
  assert.equal(buildWorkflow(r, { daily: null }).steps.find((s) => s.id === "reconductor")!.verdict, "needs_data");
});

test("weather site too far → weather rating needs data", async () => {
  const r = await westminster();
  const far = { ...r, rating_site: { ...r.rating_site, distance_mi: RULES.maxWeatherSiteMi + 1 } };
  assert.equal(buildWorkflow(far).steps.find((s) => s.id === "weather_rating")!.verdict, "needs_data");
});

test("storage rule sizes the gap to the cover target", async () => {
  const r = await westminster(20);
  const solar = 200, storage = 40;
  const fake: ScanResult = {
    ...r,
    totals: { ...r.totals, mw_by_source: { ...r.totals.mw_by_source, solar }, storage_mw: storage, evening_cover_pct: (storage / solar) * 100 },
  };
  const s5 = buildWorkflow(fake).steps.find((s) => s.id === "storage")!;
  assert.equal(s5.verdict, "candidate");
  assert.match(s5.finding, /about 60 MW more/); // 50% of 200 − 40
  const small: ScanResult = { ...fake, totals: { ...fake.totals, mw_by_source: { ...fake.totals.mw_by_source, solar: RULES.minSolarMw - 1 } } };
  assert.equal(buildWorkflow(small).steps.find((s) => s.id === "storage")!.verdict, "not_applicable");
});

test("new line only when weather rating fails and reconductoring is needed", async () => {
  const r = await westminster();
  const weak = { ...r, rating_site: { ...r.rating_site, pct_hours_conservative_dlr_above_static: 5 } };
  const shortDays = Array.from({ length: 10 }, () => day(80));
  assert.equal(buildWorkflow(weak, { daily: shortDays }).steps.find((s) => s.id === "new_line")!.verdict, "candidate");
  assert.equal(buildWorkflow(r, { daily: shortDays }).steps.find((s) => s.id === "new_line")!.verdict, "not_supported");
});
