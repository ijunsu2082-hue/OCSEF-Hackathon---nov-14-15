/**
 * EIA-930 six-month BALANCE files: same-publisher backfill for EIA hourly demand.
 *
 * This is an explicit opt-in backfill over a locally provided file, not a feed
 * in the telemetry loop. Probed 2026-11-14: the current file
 * (EIA930_BALANCE_2026_Jul_Dec.csv, ~36 MB) answered a `Range: bytes=0-3000`
 * request with `200` and the whole body (no `206`, no `Accept-Ranges`), and its
 * rows are sorted by balancing authority, then time. The newest hours of one
 * authority sit mid-file, so no bounded byte range can address "the latest
 * hour", and downloading the file every five minutes is not acceptable.
 *
 * Clock basis: "UTC Time at End of Hour" is used, never the local columns. EIA
 * API `frequency=hourly` labels the same hour by its UTC end: CISO demand for
 * API period 2026-11-14T08 equals the bulk row with UTC end 11/14/2026 8:00 AM
 * (both 22227 MW). Each row carries that API-compatible `period` label and the
 * explicit interval bounds, so the two sources join without an off-by-one.
 *
 * The newest hours of each authority are published with blank `Demand (MW)`;
 * those rows are skipped and counted, never zero-filled.
 */

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { digest } from "../../lib/evidence/canonical";
import { buildSnapshot } from "../snapshot";
import { csvCell, parseCsv } from "./caiso";
import { atomicJson, stateRoot, storeCapture } from "./pipeline";

const HOUR = 3_600_000;
const BA = "Balancing Authority";
const UTC_END = "UTC Time at End of Hour";
const DEMAND = "Demand (MW)";
/** Optional series reported when present, by published header name. */
const OPTIONAL: Record<string, string> = {
  "Demand Forecast (MW)": "demand_forecast_mw",
  "Net Generation (MW)": "net_generation_mw",
  "Total Interchange (MW)": "total_interchange_mw",
};

export interface Eia930Row {
  /** EIA API `frequency=hourly` period label: the UTC hour-ending hour, `YYYY-MM-DDTHH`. */
  period: string;
  interval_start: string;
  interval_end: string;
  demand_mw: number;
  demand_forecast_mw?: number;
  net_generation_mw?: number;
  total_interchange_mw?: number;
  /** 1-based line in the source file. */
  line: number;
}

export interface Eia930Parse {
  respondent: string;
  rows: Eia930Row[];
  /** Respondent rows skipped because Demand (MW) is blank (not yet published). */
  skipped_blank_demand: number;
}

/** Six-month file covering `now` (UTC calendar halves). */
export function eia930BulkUrl(now = new Date()): URL {
  const year = now.getUTCFullYear();
  if (!Number.isFinite(year)) throw new Error("Invalid date");
  const half = now.getUTCMonth() < 6 ? "Jan_Jun" : "Jul_Dec";
  return new URL(`https://www.eia.gov/electricity/gridmonitor/sixMonthFiles/EIA930_BALANCE_${year}_${half}.csv`);
}

/** `MM/DD/YYYY h:mm:ss AM|PM` on the hour, read as UTC. */
export function eia930UtcInstant(value: string): number {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):00:00 (AM|PM)$/.exec(value);
  if (!match) throw new Error(`Unexpected EIA-930 UTC time: ${value}`);
  const [, month, day, year, rawHour, meridiem] = match;
  const hour12 = Number(rawHour);
  if (hour12 < 1 || hour12 > 12) throw new Error(`Unexpected EIA-930 UTC time: ${value}`);
  const hour = (hour12 % 12) + (meridiem === "PM" ? 12 : 0);
  const date = `${year}-${month}-${day}`;
  const instant = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== date) {
    throw new Error(`Unexpected EIA-930 UTC time: ${value}`);
  }
  return instant;
}

function number(raw: string, column: string, line: number): number | null {
  const cell = csvCell(raw);
  if (cell === null) return null;
  if (typeof cell !== "number") throw new Error(`EIA-930 line ${line}: ${column} is not a number`);
  return cell;
}

/**
 * Parse one respondent's hours from a BALANCE file. Columns are matched by
 * header name; the respondent is matched exactly; a duplicate hour, an
 * unparseable time or a non-numeric value fails the whole file.
 */
export function parseEia930Balance(text: string, respondent: string): Eia930Parse {
  if (!/^[A-Z0-9]{2,8}$/.test(respondent)) throw new Error("Expected an EIA balancing-authority respondent code");
  const lines = text.split(/\r?\n/);
  const header = parseCsv(lines[0] ?? "").header;
  const missing = [BA, UTC_END, DEMAND].filter((name) => !header.includes(name));
  if (missing.length) throw new Error(`EIA-930 BALANCE file is missing ${missing.join(", ")}`);
  const baColumn = header.indexOf(BA);
  const timeColumn = header.indexOf(UTC_END);
  const demandColumn = header.indexOf(DEMAND);
  const optional = Object.entries(OPTIONAL).map(([name, key]) => [header.indexOf(name), name, key] as const)
    .filter(([column]) => column >= 0);
  const rows: Eia930Row[] = [];
  const seen = new Set<number>();
  let skipped = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    // Cheap prefilter when the authority is the first column (the published layout).
    if (baColumn === 0 && !raw.startsWith(`${respondent},`) && !raw.startsWith(`"${respondent}",`)) continue;
    const [cells] = parseCsv(`${lines[0]}\n${raw}`).rows;
    if (cells[baColumn] !== respondent) continue;
    const line = index + 1;
    const end = eia930UtcInstant(cells[timeColumn]);
    if (seen.has(end)) throw new Error(`EIA-930 line ${line}: duplicate hour for ${respondent}`);
    seen.add(end);
    const demand = number(cells[demandColumn], DEMAND, line);
    if (demand === null) {
      skipped += 1;
      continue;
    }
    const row: Eia930Row = {
      period: new Date(end).toISOString().slice(0, 13),
      interval_start: new Date(end - HOUR).toISOString(),
      interval_end: new Date(end).toISOString(),
      demand_mw: demand,
      line,
    };
    for (const [column, name, key] of optional) {
      const value = number(cells[column], name, line);
      if (value !== null) (row as unknown as Record<string, number>)[key] = value;
    }
    rows.push(row);
  }
  rows.sort((a, b) => a.interval_end.localeCompare(b.interval_end));
  return { respondent, rows, skipped_blank_demand: skipped };
}

/**
 * Opt-in backfill from a locally downloaded BALANCE file. The bytes are stored
 * content-addressed with a snapshot record; the parsed hours are written as an
 * archive under the ETL state root, like the weather backfill.
 */
export async function backfillEia930(
  file: string, respondent: string, options: { url?: string; retrievedAt?: string } = {},
) {
  const bytes = new Uint8Array(await readFile(file));
  const { cachePath, hash } = await storeCapture(bytes);
  const retrievedAt = options.retrievedAt ?? new Date().toISOString();
  const url = options.url ?? `local-file:${basename(file)}`;
  try {
    const { snapshot, data } = buildSnapshot({
      sourceId: "eia930-balance-bulk", url, retrievedAt, bytes, cachePath, parser: "text.lines",
      contentType: "text/csv", notes: ["EIA-930 six-month BALANCE file provided locally for an opt-in backfill."],
    });
    const parsed = parseEia930Balance(data as string, respondent);
    if (!parsed.rows.length) throw new Error(`EIA-930 file has no published demand for ${respondent}`);
    const archive = {
      schema: "gridsentinel.eia930-bulk/1", basis: "utc_hour_ending",
      units: "MW as published in Demand (MW); the EIA API reports the same hourly values as megawatthours", snapshot, ...parsed,
    };
    const path = resolve(stateRoot(), "eia930", `${snapshot.id}-${respondent}.json`);
    await atomicJson(path, archive);
    return {
      path, snapshot: snapshot.id, rows: parsed.rows.length, skipped_blank_demand: parsed.skipped_blank_demand,
      first: parsed.rows[0].period, last: parsed.rows.at(-1)!.period,
    };
  } catch (error) {
    await atomicJson(resolve(stateRoot(), "quarantine", `${digest([url, hash, respondent])}.json`), {
      url, cachePath, sha256: hash, retrievedAt,
      issue: error instanceof Error ? error.message : "EIA-930 file rejected",
    });
    throw error;
  }
}
