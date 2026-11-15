/**
 * Proves the area scan never prints the rating-site placeholder figures that
 * loadGridData() fills in when `public/layers/line_ratings/summary.json` is
 * absent, and that the hourly rating CSV URL resolves to a shipped file.
 *
 * `fetch` is stubbed to serve `public/` from disk (404 for anything missing),
 * so loadGridData() runs its real path against the committed files. The
 * gitignored outputs of scripts/sync-layers.mjs (`layers/line_ratings/`,
 * `layers/gen_events.json`, written by predev/prebuild) are served as 404 so
 * the unavailable path is exercised whether or not sync-layers has run.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-scan-unavailable.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QUICK_SPOTS } from "../lib/scan";
import { loadGridData, loadRatingCsv, ratingCsvUrl } from "../lib/scan/data";
import { scanArea } from "../lib/scan/scan";
import { scanReportMarkdown } from "../lib/scan/report";
import { RATING_CSV_URL, RATING_FALLBACK_CSV_URL } from "../lib/scan/wire";
import type { GridData, RatingSiteSummary } from "../lib/scan/types";

const PUBLIC = resolve(process.cwd(), "public");
/** Generated, gitignored by scripts/sync-layers.mjs; never committed. */
const SYNCED = ["/layers/line_ratings/", "/layers/gen_events.json"];
const requested: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
  requested.push(url);
  const path = url.split("?")[0];
  if (SYNCED.some((prefix) => path.startsWith(prefix))) return new Response("not found", { status: 404 });
  const file = resolve(PUBLIC, `.${path}`);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) return new Response("not found", { status: 404 });
  return new Response(readFileSync(file));
}) as typeof fetch;

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`ok  ${name}`);
}

const SUMMARY = "/layers/line_ratings/summary.json";
// Every string the placeholder defaults (median 1, 0 %, hottest 0 °C / ratio 1,
// risk's 1.5 stand-in) would render as, in report.ts, scan.ts and risk.ts.
const PLACEHOLDER_SIGNATURES = [
  "beat static in 0% of hours",
  "median 1x",
  "(0 C)",
  "only 1x",
  "about 0% more capacity",
  "(0 °C)",
  "(NaN °C)",
  "1.00× the fixed rating",
  "1.50× the fixed rating",
  "the fixed rating in 0% of 2025 hours",
  "NaN",
];

async function main() {
  const data = await loadGridData();

  check("summary.json is reported unavailable", () => {
    assert.ok(data.unavailable.includes(SUMMARY), `unavailable = ${JSON.stringify(data.unavailable)}`);
  });

  let reports = 0;
  for (const spot of QUICK_SPOTS) {
    for (const radius_mi of [1, 5, 25, 100]) {
      for (const heatwave of [false, true]) {
        const result = scanArea(data, { lat: spot.lat, lon: spot.lon, radius_mi }, { heatwave });
        const md = scanReportMarkdown(result, null);
        const where = `${spot.name} r=${radius_mi} heatwave=${heatwave}`;
        assert.equal(result.rating_unavailable, `${SUMMARY} not found`, where);
        const s = result.rating_site;
        for (const key of [
          "median_conservative_dlr_vs_static", "pct_hours_conservative_dlr_above_static",
          "summer_4to8pm_median_wind_gain_over_aar", "hottest_temp_c", "hottest_hour_dlr_vs_static",
        ] as const) {
          assert.ok(Number.isNaN(s[key]), `${where}: rating_site.${key} = ${s[key]} (placeholder leaked)`);
        }
        assert.equal(s.hottest_hour, "", where);
        assert.ok(md.includes(`- 2025 rating summary: unavailable (${SUMMARY} not found)`), `${where}: no unavailable line`);
        for (const sig of PLACEHOLDER_SIGNATURES) {
          assert.ok(!md.includes(sig), `${where}: report contains placeholder text "${sig}"`);
          for (const idea of result.upgrade_ideas) assert.ok(!idea.includes(sig), `${where}: idea "${idea}"`);
        }
        const heat = result.risk.factors.find((f) => f.key === "heat");
        assert.ok(heat, where);
        if (!heatwave) {
          assert.deepEqual(result.unscored_factors, ["heat"], where);
          assert.equal(heat.score, 0, where);
          assert.ok(md.includes("- Heat stress on wires: not scored (weight 15%) — Unavailable ("), `${where}: heat line`);
        } else {
          // Heatwave ratio is modeled from the fixed 105 °F weather, not the summary.
          assert.deepEqual(result.unscored_factors, [], where);
          assert.ok(heat.detail.startsWith("In a 105 °F heatwave"), where);
        }
        reports += 1;
      }
    }
  }
  check(`${reports} scans/reports emit no placeholder rating value`, () => assert.ok(reports > 0));

  check("control: a real summary is printed, not marked unavailable", () => {
    const measured: RatingSiteSummary[] = data.ratingSites.map((site) => ({
      ...site,
      median_conservative_dlr_vs_static: 1.234,
      pct_hours_conservative_dlr_above_static: 56.7,
      summer_4to8pm_median_wind_gain_over_aar: 1.1,
      hottest_hour: "2025-09-06T15:00",
      hottest_temp_c: 41.2,
      hottest_hour_dlr_vs_static: 0.91,
    }));
    const complete: GridData & { unavailable: string[] } = { ...data, ratingSites: measured, unavailable: [] };
    const result = scanArea(complete, { lat: 33.7538, lon: -118.0111, radius_mi: 5 });
    const md = scanReportMarkdown(result, null);
    assert.equal(result.rating_unavailable, null);
    assert.deepEqual(result.unscored_factors, []);
    assert.ok(md.includes("typical hour 1.234x with wind halved"), md);
    assert.ok(md.includes("With wind halved the rating beat static in 56.7% of hours; hottest hour 2025-09-06T15:00 (41.2 C) only 0.91x"), md);
    assert.ok(!md.includes("unavailable ("), md);
    assert.ok(md.includes("the safe rating was 0.91× the fixed rating"), md);
  });

  check("rating CSV URL has one source of truth and points at shipped files", () => {
    assert.equal(RATING_CSV_URL, ratingCsvUrl("westminster_hs", 2025));
    assert.equal(RATING_FALLBACK_CSV_URL, ratingCsvUrl("westminster_hs", 2024));
    assert.equal(ratingCsvUrl("westminster_hs"), "/layers/line_rating_2025_westminster_hs.csv");
    for (const url of [RATING_CSV_URL, RATING_FALLBACK_CSV_URL]) {
      assert.ok(existsSync(resolve(PUBLIC, `.${url}`)), `${url} missing under public/`);
    }
  });

  const rows = await loadRatingCsv("westminster_hs");
  check(`loadRatingCsv("westminster_hs") parses ${rows.length} hourly rows`, () => {
    assert.ok(requested.includes("/layers/line_rating_2025_westminster_hs.csv"), JSON.stringify(requested));
    assert.ok(rows.length > 8000, `rows = ${rows.length}`);
    assert.ok(rows.every((r) => Number.isFinite(r.dlr_conservative_A)));
  });

  console.log(`\n${checks} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
