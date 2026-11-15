import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SourceSnapshot } from "../../lib/evidence/schema";
import { RATING_SITES } from "../../lib/scan/data";
import { ampacity, rateLine } from "../../lib/scan/rating";
import { replaySnapshot } from "../snapshot";
import { csvCell } from "./caiso";
import { atomicJson, stateRoot } from "./pipeline";

/**
 * Hourly line-rating CSVs regenerated from an archived, hash-verified weather
 * history (weather-history.ts) through the in-repo thermal engine
 * (lib/scan/rating.ts `rateLine`). Output columns match the committed
 * public/layers/line_rating_<year>_<site>.csv files. Weather is ERA5 modeled
 * reanalysis, not station measurement; ratings are a screening model, not an
 * operating rating.
 */

const HOUR = 3600000;
const ENGINE_MODULE = "lib/scan/rating.ts";
export const RATING_COLUMNS = [
  "time", "temp_c", "wind_ms", "sun_wm2", "static_A", "aar_A", "dlr_A", "dlr_conservative_A",
  "dlr_vs_static", "dlr_conservative_vs_static",
] as const;
const NUMERIC = RATING_COLUMNS.slice(1);

/** Documents what rateLine assumes; the engine source hash in the manifest pins it. */
export const CONDUCTOR_ASSUMPTIONS = {
  conductor: "ACSR 795 kcmil Drake",
  diameter_m: 0.02814,
  r_ac_ohm_per_m: { "25C": 7.283e-5, "75C": 8.688e-5 },
  max_conductor_temp_c: 75,
  emissivity: 0.8,
  absorptivity: 0.8,
  elevation_m: 100,
  static: { ambient_c: 40, wind_ms: 0.61, sun_wm2: 1000, wind_angle_deg: 90 },
  aar: { wind_ms: 0.61, wind_angle_deg: 90, ambient: "hourly", sun: "hourly" },
  dlr: { wind: "hourly", wind_angle_deg: 45 },
  dlr_conservative: { wind: "0.5 x hourly", wind_angle_deg: 45 },
  method: "simplified IEEE Std 738 steady-state heat balance",
} as const;

interface ArchiveRow {
  timestamp: string;
  metrics: { field: string; value: number | null; locator: string }[];
}

export interface WeatherArchive {
  schema: "gridsentinel.weather-history/1";
  center: [number, number];
  start: string;
  end: string;
  model: string;
  basis: string;
  gridCell: [number, number];
  units: Record<string, string>;
  snapshot: SourceSnapshot;
  rows: ArchiveRow[];
}

export interface RatingRow {
  time: string;
  temp_c: number | null;
  wind_ms: number | null;
  sun_wm2: number | null;
  static_A: number | null;
  aar_A: number | null;
  dlr_A: number | null;
  dlr_conservative_A: number | null;
  dlr_vs_static: number | null;
  dlr_conservative_vs_static: number | null;
}

const WEATHER_FIELDS = { temp_c: "temperature_2m", wind_ms: "wind_speed_10m", sun_wm2: "shortwave_radiation" } as const;
const STATIC_EXACT = ampacity(40, 0.61, 1000, 90);

/**
 * Re-read an archive's raw capture, prove it still hashes to the snapshot, and
 * prove every archived row equals the capture's own hourly arrays.
 */
export async function verifyWeatherArchive(archive: WeatherArchive): Promise<WeatherArchive> {
  if (archive?.schema !== "gridsentinel.weather-history/1" || !Array.isArray(archive.rows)) {
    throw new Error("Not a gridsentinel.weather-history/1 archive");
  }
  const { data } = await replaySnapshot(archive.snapshot);
  const hourly = (data as { hourly?: Record<string, unknown[]> }).hourly;
  const time = hourly?.time;
  if (!Array.isArray(time) || time.length !== archive.rows.length) throw new Error("Archive rows do not match capture time axis");
  archive.rows.forEach((row, index) => {
    if (row.timestamp !== `${time[index]}:00Z`) throw new Error(`Archive timestamp mismatch at row ${index}`);
    for (const metric of row.metrics) {
      const raw = hourly?.[metric.field];
      if (!Array.isArray(raw) || raw[index] !== metric.value || metric.locator !== `/hourly/${metric.field}/${index}`) {
        throw new Error(`Archive value mismatch ${metric.field} at row ${index}`);
      }
    }
  });
  return archive;
}

export async function readWeatherArchive(snapshotId: string): Promise<WeatherArchive> {
  if (!/^[a-z]+_[a-f0-9]{16}$/.test(snapshotId)) throw new Error("Expected weather snapshot ID");
  const archive = JSON.parse(await readFile(resolve(stateRoot(), "weather", `${snapshotId}.json`), "utf8"));
  if (archive?.snapshot?.id !== snapshotId) throw new Error("Weather archive snapshot ID mismatch");
  return verifyWeatherArchive(archive);
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Engine outputs for one hour of weather, in CSV column order. */
export function rateHour(temp_c: number, wind_ms: number, sun_wm2: number) {
  // rateLine only echoes `source` back; "fallback-2025" is the app's label for archived hourly weather.
  const rated = rateLine({ temp_c, wind_ms, sun_wm2, time: "", source: "fallback-2025" });
  // rateLine rounds dlr_A; the committed CSVs carry the unrounded ratio, so
  // recompute it with the same call rateLine makes and prove they agree.
  const dlrExact = ampacity(temp_c, wind_ms, sun_wm2, 45);
  if (Math.round(dlrExact) !== rated.dlr_A || Math.round(STATIC_EXACT) !== rated.static_A) {
    throw new Error("rateLine no longer matches ampacity(ta, wind, sun, 45); update ratings.ts");
  }
  return {
    static_A: rated.static_A, aar_A: rated.aar_A, dlr_A: rated.dlr_A,
    dlr_conservative_A: rated.dlr_conservative_A,
    dlr_vs_static: STATIC_EXACT > 0 ? round3(dlrExact / STATIC_EXACT) : 0,
    dlr_conservative_vs_static: rated.ratio,
  };
}

function localTime(utcMs: number, offsetHours: number): string {
  return new Date(utcMs + offsetHours * HOUR).toISOString().slice(0, 16);
}

function rateArchiveRow(source: ArchiveRow, utcMs: number, utcOffsetHours: number): RatingRow {
  const value = (field: string) => {
    const metric = source.metrics.find((m) => m.field === field);
    return metric && typeof metric.value === "number" && Number.isFinite(metric.value) ? metric.value : null;
  };
  const temp_c = value(WEATHER_FIELDS.temp_c);
  const wind_ms = value(WEATHER_FIELDS.wind_ms);
  const sun_wm2 = value(WEATHER_FIELDS.sun_wm2);
  const time = localTime(utcMs, utcOffsetHours);
  if (temp_c === null || wind_ms === null || sun_wm2 === null) {
    return {
      time, temp_c, wind_ms, sun_wm2, static_A: null, aar_A: null, dlr_A: null,
      dlr_conservative_A: null, dlr_vs_static: null, dlr_conservative_vs_static: null,
    };
  }
  return { time, temp_c, wind_ms, sun_wm2, ...rateHour(temp_c, wind_ms, sun_wm2) };
}

function checkOffset(utcOffsetHours: number) {
  if (!Number.isInteger(utcOffsetHours) || Math.abs(utcOffsetHours) > 14) throw new Error("Expected integer UTC offset");
}

/** Every archive hour, relabelled to a fixed UTC offset (no DST). */
export function rateArchive(archive: WeatherArchive, utcOffsetHours: number): RatingRow[] {
  checkOffset(utcOffsetHours);
  return archive.rows.map((row) => rateArchiveRow(row, Date.parse(row.timestamp), utcOffsetHours));
}

/**
 * Hourly rows for one local calendar year at a fixed UTC offset (no DST), the
 * basis of the committed CSVs (lib/scan/rating.ts csvKeyFor). Every hour of the
 * year must be in the archive; hours whose weather is null keep their
 * timestamp and get empty rating cells.
 */
export function ratingRows(archive: WeatherArchive, year: number, utcOffsetHours: number) {
  if (!Number.isInteger(year)) throw new Error("Expected integer year");
  checkOffset(utcOffsetHours);
  const first = Date.UTC(year, 0, 1) - utcOffsetHours * HOUR;
  const expected = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / HOUR;
  const byTime = new Map(archive.rows.map((row) => [Date.parse(row.timestamp), row]));
  const rows: RatingRow[] = [];
  for (let i = 0; i < expected; i++) {
    const utc = first + i * HOUR;
    const source = byTime.get(utc);
    if (!source) throw new Error(`Weather archive does not cover ${new Date(utc).toISOString()}`);
    rows.push(rateArchiveRow(source, utc, utcOffsetHours));
  }
  const nullHours = rows.filter((row) => row.static_A === null).map((row) => row.time);
  return { rows, nullHours };
}

/** Python float repr for the values these columns hold (10 → "10.0", 0.88 → "0.88"). */
function pyNumber(x: number | null, integer: boolean): string {
  if (x === null) return "";
  if (integer) return String(x);
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

export function ratingCsv(rows: RatingRow[]): string {
  const ints = new Set(["static_A", "aar_A", "dlr_A", "dlr_conservative_A"]);
  const lines = rows.map((row) => [row.time, ...NUMERIC.map((key) =>
    pyNumber(row[key as keyof RatingRow] as number | null, ints.has(key)))].join(","));
  return [RATING_COLUMNS.join(","), ...lines].join("\n") + "\n";
}

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function atomicText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function generateRatings(snapshotId: string, siteKey: string, year: number, utcOffsetHours = -8) {
  const site = RATING_SITES.find((s) => s.key === siteKey);
  if (!site) throw new Error(`Unknown rating site ${siteKey}`);
  const archive = await readWeatherArchive(snapshotId);
  const [lat, lon] = archive.center;
  if (Math.abs(lat - site.lat) > 0.01 || Math.abs(lon - site.lon) > 0.01) {
    throw new Error(`Weather archive center ${lat},${lon} is not site ${siteKey}`);
  }
  const { rows, nullHours } = ratingRows(archive, year, utcOffsetHours);
  const csv = ratingCsv(rows);
  const name = `line_rating_${year}_${siteKey}`;
  const directory = resolve(stateRoot(), "ratings");
  const csvPath = resolve(directory, `${name}.csv`);
  const engineSource = await readFile(resolve(process.cwd(), ENGINE_MODULE));
  const manifest = {
    schema: "gridsentinel.line-rating-csv/1",
    site, year,
    time_basis: { utc_offset_hours: utcOffsetHours, dst: false, column: "time is local standard time, no zone suffix" },
    csv: { file: `${name}.csv`, sha256: sha256(csv), rows: rows.length, columns: RATING_COLUMNS },
    null_input_hours: nullHours,
    weather: {
      snapshot: archive.snapshot.id, sha256: archive.snapshot.sha256, source_id: archive.snapshot.source_id,
      url: archive.snapshot.url, retrieved_at: archive.snapshot.retrieved_at, model: archive.model,
      basis: archive.basis, grid_cell: archive.gridCell, center: archive.center, units: archive.units,
      start: archive.start, end: archive.end, verified: "capture sha256 replayed; every row matched the capture",
    },
    engine: { module: ENGINE_MODULE, function: "rateLine", source_sha256: sha256(engineSource) },
    conductor: CONDUCTOR_ASSUMPTIONS,
    generator: "research/etl/ratings.ts",
  };
  await atomicText(csvPath, csv);
  await atomicJson(resolve(directory, `${name}.manifest.json`), manifest);
  return { path: csvPath, rows: rows.length, null_input_hours: nullHours.length, manifest };
}

// ---- comparison against a committed CSV -------------------------------------

/**
 * Strict: every row has exactly one cell per column; numeric cells follow the
 * `csv.table` rule (caiso.ts `csvCell`): blank or whitespace-only is null
 * (missing), a plain decimal is a number, anything else (e.g. "nan") throws.
 */
export function parseRatingCsv(text: string): RatingRow[] {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  if (header !== RATING_COLUMNS.join(",")) throw new Error("Unexpected line-rating CSV header");
  return lines.map((line, index) => {
    const cells = line.split(",");
    const at = `line-rating CSV row ${index + 2}`;
    if (cells.length !== RATING_COLUMNS.length) {
      throw new Error(`${at} has ${cells.length} cells, expected ${RATING_COLUMNS.length}`);
    }
    if (!cells[0].trim()) throw new Error(`${at} has an empty time`);
    const row: Record<string, string | number | null> = { time: cells[0] };
    NUMERIC.forEach((key, i) => {
      const cell = csvCell(cells[i + 1]);
      if (typeof cell === "string") throw new Error(`${at} has non-numeric cell ${JSON.stringify(cell)} in ${key}`);
      row[key] = cell;
    });
    return row as unknown as RatingRow;
  });
}

/**
 * Per-column differences. A pair with a missing (null) or non-finite value on
 * either side is a failure, not a skip: `failed` counts them and, when any
 * failed, the difference statistics are null (no parity is claimed).
 */
type ColumnStats = {
  max_abs: number | null; mean_abs: number | null; mean_signed: number | null; max_at: string | null;
  compared: number; failed: number; first_failed_at: string | null;
};

function columnStats(pairs: [RatingRow, RatingRow][]): Record<string, ColumnStats> {
  return Object.fromEntries(NUMERIC.map((key) => {
    let max = 0, sumAbs = 0, sum = 0, n = 0, failed = 0, at: string | null = null, firstFailed: string | null = null;
    for (const [a, b] of pairs) {
      const x = a[key as keyof RatingRow] as number | null, y = b[key as keyof RatingRow] as number | null;
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
        failed++;
        firstFailed ??= a.time;
        continue;
      }
      const d = x - y;
      n++; sum += d; sumAbs += Math.abs(d);
      if (Math.abs(d) > max) { max = Math.abs(d); at = a.time; }
    }
    const r = (v: number) => Math.round(v * 10000) / 10000;
    const clean = failed === 0 && n > 0;
    return [key, {
      max_abs: clean ? r(max) : null, mean_abs: clean ? r(sumAbs / n) : null, mean_signed: clean ? r(sum / n) : null,
      max_at: clean ? at : null, compared: n, failed, first_failed_at: firstFailed,
    }];
  }));
}

/** Row count, timestamp alignment and per-column differences, generated minus reference. */
export function compareRatings(generated: RatingRow[], reference: RatingRow[]) {
  const ref = new Map(reference.map((row) => [row.time, row]));
  const gen = new Set(generated.map((row) => row.time));
  const pairs = generated.filter((row) => ref.has(row.time)).map((row) => [row, ref.get(row.time)!] as [RatingRow, RatingRow]);
  // Shift probe: which hour lag best aligns the diurnal sun and temperature curves.
  const lag = [];
  const refTimes = reference.map((row) => row.time);
  for (let k = -9; k <= 9; k++) {
    let sun = 0, temp = 0, n = 0;
    for (let i = 0; i < generated.length; i++) {
      const j = i + k;
      if (j < 0 || j >= reference.length) continue;
      const a = generated[i], b = reference[j];
      if (a.sun_wm2 === null || b.sun_wm2 === null || a.temp_c === null || b.temp_c === null) continue;
      sun += Math.abs(a.sun_wm2 - b.sun_wm2); temp += Math.abs(a.temp_c - b.temp_c); n++;
    }
    lag.push({ reference_lag_hours: k, sun_mean_abs: Math.round((sun / n) * 100) / 100, temp_mean_abs: Math.round((temp / n) * 1000) / 1000 });
  }
  return {
    rows: { generated: generated.length, reference: reference.length, matched_timestamps: pairs.length },
    timestamps: {
      identical_sequence: generated.length === reference.length && generated.every((row, i) => row.time === refTimes[i]),
      generated_first: generated[0]?.time ?? null, generated_last: generated.at(-1)?.time ?? null,
      reference_first: reference[0]?.time ?? null, reference_last: reference.at(-1)?.time ?? null,
      only_generated: generated.filter((row) => !ref.has(row.time)).length,
      only_reference: reference.filter((row) => !gen.has(row.time)).length,
    },
    columns: columnStats(pairs),
    lag_probe: lag,
  };
}

/**
 * Feed the reference CSV's own temp/wind/sun through the engine and diff the
 * derived columns: isolates engine parity from weather-source differences.
 */
export function engineParity(reference: RatingRow[]) {
  const recomputed = reference.map((row): RatingRow => row.temp_c === null || row.wind_ms === null || row.sun_wm2 === null
    ? { ...row }
    : { ...row, ...rateHour(row.temp_c, row.wind_ms, row.sun_wm2) });
  const stats = columnStats(recomputed.map((row, i) => [row, reference[i]]));
  const derived = NUMERIC.slice(3);
  const mismatched = Object.fromEntries(derived.map((key) => [key, recomputed.filter((row, i) =>
    row[key as keyof RatingRow] !== reference[i][key as keyof RatingRow]).length]));
  return {
    rows: reference.length,
    columns: Object.fromEntries(derived.map((key) => [key, stats[key]])),
    mismatched_rows: mismatched,
  };
}

/**
 * CLI entry for later wiring into cli.ts:
 *   ratings generate <weather-snapshot-id> <site-key> <year> [--utc-offset -8]
 *   ratings compare <generated.csv> <reference.csv>
 *   ratings parity <reference.csv>
 */
export async function runRatingsCommand(args: string[]) {
  const [command, ...rest] = args;
  if (command === "generate") {
    const offsetAt = rest.indexOf("--utc-offset");
    const offset = offsetAt === -1 ? -8 : Number(rest[offsetAt + 1]);
    const positional = offsetAt === -1 ? rest : rest.filter((_, i) => i !== offsetAt && i !== offsetAt + 1);
    if (positional.length !== 3 || !/^\d{4}$/.test(positional[2]) || !Number.isInteger(offset)) {
      throw new Error("Expected ratings generate <weather-snapshot-id> <site-key> <year> [--utc-offset <hours>]");
    }
    return generateRatings(positional[0], positional[1], Number(positional[2]), offset);
  }
  if (command === "compare") {
    if (rest.length !== 2) throw new Error("Expected ratings compare <generated.csv> <reference.csv>");
    const [generated, reference] = await Promise.all(rest.map(async (path) => parseRatingCsv(await readFile(path, "utf8"))));
    return { comparison: compareRatings(generated, reference), engine_parity: engineParity(reference) };
  }
  if (command === "parity") {
    if (rest.length !== 1) throw new Error("Expected ratings parity <reference.csv>");
    return engineParity(parseRatingCsv(await readFile(rest[0], "utf8")));
  }
  throw new Error("Expected ratings generate|compare|parity");
}
