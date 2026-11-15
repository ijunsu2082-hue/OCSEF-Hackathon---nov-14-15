import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSnapshot } from "../snapshot";
import {
  compareRatings, engineParity, parseRatingCsv, rateArchive, rateHour, ratingCsv, ratingRows, verifyWeatherArchive, type WeatherArchive,
} from "./ratings";

const COMMITTED = "public/layers/line_rating_2025_westminster_hs.csv";
const FIELDS = { temperature_2m: "°C", wind_speed_10m: "m/s", shortwave_radiation: "W/m²" } as const;

/** A 6-hour Open-Meteo-shaped capture plus the archive weather-history.ts would write for it. */
async function syntheticArchive(directory: string, mutate?: (archive: WeatherArchive) => void): Promise<WeatherArchive> {
  const time = ["2025-07-01T18:00", "2025-07-01T19:00", "2025-07-01T20:00", "2025-07-01T21:00", "2025-07-01T22:00", "2025-07-01T23:00"];
  const hourly = {
    time,
    temperature_2m: [24.1, 25.9, 30.5, 10, 18.2, 40.6],
    wind_speed_10m: [3.37, 1.05, 0.3, 0, 2.5, 0.3],
    shortwave_radiation: [630, 983, 1000, 0, 48, null],
  };
  const capture = { latitude: 33.75, longitude: -118, hourly_units: FIELDS, hourly };
  const bytes = new TextEncoder().encode(JSON.stringify(capture));
  const cachePath = join(directory, "capture.json");
  await writeFile(cachePath, bytes);
  const { snapshot } = buildSnapshot({
    sourceId: "open-meteo-era5", url: "https://archive-api.open-meteo.com/v1/archive?synthetic=1",
    retrievedAt: "2026-01-01T00:00:00.000Z", bytes, cachePath, parser: "json.object", contentType: "application/json",
  });
  const archive: WeatherArchive = {
    schema: "mapergy.weather-history/1", center: [33.778557, -117.98506], start: "2025-07-01", end: "2025-07-01",
    model: "era5", basis: "modeled_reanalysis", gridCell: [33.75, -118], units: FIELDS, snapshot,
    rows: time.map((t, index) => ({
      timestamp: `${t}:00Z`,
      metrics: (Object.keys(FIELDS) as (keyof typeof FIELDS)[]).map((field) => ({
        field, value: hourly[field][index], locator: `/hourly/${field}/${index}`,
      })),
    })),
  };
  mutate?.(archive);
  return archive;
}

test("small synthetic archive: verified, deterministic, UTC relabelled to fixed UTC-8", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ratings-test-"));
  try {
    const archive = await verifyWeatherArchive(await syntheticArchive(directory));
    const first = ratingCsv(rateArchive(archive, -8));
    const second = ratingCsv(rateArchive(await verifyWeatherArchive(await syntheticArchive(directory)), -8));
    assert.equal(first, second, "byte-identical output for identical input");
    const lines = first.trimEnd().split("\n");
    assert.equal(lines[0], "time,temp_c,wind_ms,sun_wm2,static_A,aar_A,dlr_A,dlr_conservative_A,dlr_vs_static,dlr_conservative_vs_static");
    assert.deepEqual(lines.slice(1).map((l) => l.split(",")[0]),
      ["2025-07-01T10:00", "2025-07-01T11:00", "2025-07-01T12:00", "2025-07-01T13:00", "2025-07-01T14:00", "2025-07-01T15:00"]);
    // Row 1 inputs are the committed CSV's 2025-07-01T16:00 hour, so the rated columns must match it exactly
    // (aar_A 925: FERC 881 AAR takes worst-case sun by day, as regenerated in area-scan 5b1489f).
    assert.equal(lines[1], "2025-07-01T10:00,24.1,3.37,630.0,723,925,1398,1159,1.933,1.602");
    // Integer-valued inputs are written the way the committed (Python) CSVs write them.
    assert.equal(lines[4].split(",").slice(1, 4).join(","), "10.0,0.0,0.0");
    // Null weather keeps its hour but no rating is invented.
    assert.equal(lines[6], "2025-07-01T15:00,40.6,0.3,,,,,,,");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive verification rejects rows that disagree with the hashed capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ratings-test-"));
  try {
    const tampered = await syntheticArchive(directory, (a) => { a.rows[2].metrics[0].value = 20.5; });
    await assert.rejects(verifyWeatherArchive(tampered), /value mismatch temperature_2m at row 2/);
    const shifted = await syntheticArchive(directory, (a) => { a.rows[0].timestamp = "2025-07-01T17:00:00Z"; });
    await assert.rejects(verifyWeatherArchive(shifted), /timestamp mismatch/);
    const archive = await syntheticArchive(directory);
    await writeFile(archive.snapshot.cache_path, "{}");
    await assert.rejects(verifyWeatherArchive(archive), /hashes to/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a year window refuses an archive that does not cover every local hour", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ratings-test-"));
  try {
    const archive = await syntheticArchive(directory);
    assert.throws(() => ratingRows(archive, 2025, -8), /does not cover 2025-01-01T08:00:00.000Z/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Engine parity: the committed CSV's own temp/wind/sun through rateLine must
 * reproduce its derived columns. Tolerance: 1 A on ampacities and 0.001 on
 * ratios (one unit of the CSV's rounding); observed difference is 0.
 */
test("engine parity on 24 committed rows (hottest July day + a winter night)", async () => {
  const all = parseRatingCsv(await readFile(COMMITTED, "utf8"));
  const sample = [
    ...all.filter((row) => row.time.startsWith("2025-07-15")).slice(0, 18),
    ...all.filter((row) => row.time.startsWith("2025-01-23")).slice(0, 6),
  ];
  assert.equal(sample.length, 24);
  const parity = engineParity(sample);
  for (const key of ["static_A", "aar_A", "dlr_A", "dlr_conservative_A"]) {
    assert.equal(parity.columns[key].failed, 0, key);
    assert.ok(parity.columns[key].max_abs !== null && parity.columns[key].max_abs <= 1, `${key} max ${parity.columns[key].max_abs} A`);
  }
  for (const key of ["dlr_vs_static", "dlr_conservative_vs_static"]) {
    assert.equal(parity.columns[key].failed, 0, key);
    assert.ok(parity.columns[key].max_abs !== null && parity.columns[key].max_abs <= 0.001, `${key} max ${parity.columns[key].max_abs}`);
  }
  assert.deepEqual(Object.values(parity.mismatched_rows), [0, 0, 0, 0, 0, 0], "observed: exact on all 24 rows");
  // Engine output for those inputs, serialised by ratingCsv, is identical to the committed lines
  // (the committed file is CRLF, so lines are compared without their terminators).
  const text = (await readFile(COMMITTED, "utf8")).split(/\r?\n/);
  const expected = [...text.filter((l) => l.startsWith("2025-07-15")).slice(0, 18),
    ...text.filter((l) => l.startsWith("2025-01-23")).slice(0, 6)];
  const recomputed = sample.map((row) => ({ ...row, ...rateHour(row.temp_c!, row.wind_ms!, row.sun_wm2!) }));
  assert.deepEqual(ratingCsv(recomputed).trimEnd().split("\n").slice(1), expected);
});

const HEADER = "time,temp_c,wind_ms,sun_wm2,static_A,aar_A,dlr_A,dlr_conservative_A,dlr_vs_static,dlr_conservative_vs_static";

test("parseRatingCsv: blank cells are null, text cells and short/long rows throw", () => {
  const rows = parseRatingCsv(`${HEADER}\n2025-01-01T00:00,10.5, ,0.0,800,810,900,850,1.125,1.0625\n`);
  assert.equal(rows[0].wind_ms, null, "whitespace-only cell is missing, not 0");
  assert.equal(rows[0].temp_c, 10.5);
  assert.equal(rows[0].sun_wm2, 0);
  assert.throws(() => parseRatingCsv(`${HEADER}\n2025-01-01T00:00,nan,1,0,800,810,900,850,1.1,1.0\n`), /non-numeric cell "nan".*temp_c/);
  assert.throws(() => parseRatingCsv(`${HEADER}\n2025-01-01T00:00,10,1,0,800,810,900,850,1.1\n`), /9 cells, expected 10/);
  assert.throws(() => parseRatingCsv(`${HEADER}\n2025-01-01T00:00,10,1,0,800,810,900,850,1.1,1.0,7\n`), /11 cells, expected 10/);
  assert.throws(() => parseRatingCsv(`${HEADER}\n,10,1,0,800,810,900,850,1.1,1.0\n`), /time/);
});

test("compareRatings: a missing or non-finite cell is a counted failure, never a perfect match", () => {
  const row = (time: string, temp: number | null) => ({
    time, temp_c: temp, wind_ms: 1, sun_wm2: 0, static_A: 800, aar_A: 810, dlr_A: 900, dlr_conservative_A: 850,
    dlr_vs_static: 1.125, dlr_conservative_vs_static: 1.0625,
  });
  const generated = [row("t0", Number.NaN), row("t1", null), row("t2", 10)];
  const reference = [row("t0", 10), row("t1", 10), row("t2", 10)];
  const temp = compareRatings(generated, reference).columns.temp_c;
  assert.equal(temp.compared, 1);
  assert.equal(temp.failed, 2, "NaN and null pairs are failures");
  assert.equal(temp.max_abs, null, "max_abs is not reported as 0 when values could not be compared");
  assert.equal(temp.mean_abs, null);
  assert.equal(temp.max_at, null);
  assert.equal(temp.first_failed_at, "t0");
  // An empty comparison claims nothing either.
  assert.equal(compareRatings([], reference).columns.temp_c.max_abs, null);
  const wind = compareRatings(generated, reference).columns.wind_ms;
  assert.equal(wind.failed, 0);
  assert.equal(wind.max_abs, 0);
});
