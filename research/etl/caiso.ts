/**
 * CAISO five-minute system telemetry.
 *
 * CAISO publishes the operating day as anonymous CSV behind the Today's Outlook
 * dashboard. Two documented feeds are ingested here:
 *
 *   - `demand.csv`     system demand, five-minute average
 *   - `fuelsource.csv` system supply by resource type, five-minute average
 *
 * Both are *system-wide*. They say nothing about the analysis radius, a
 * distribution feeder, or a facility, and CAISO states these telemetry
 * summaries will not tie out to OASIS market results. Every claim built from
 * this module therefore carries that scope in its caveats.
 *
 * Two properties are handled explicitly because they are where a scraper
 * quietly goes wrong:
 *
 *   1. The current-day file has no date column. The operating date is derived
 *      from the capture's retrieval instant in America/Los_Angeles, which is
 *      stored on the snapshot and therefore replayable.
 *   2. Columns are matched by published header name, never by position. An
 *      unrecognized header is left unreported rather than mapped to a guess.
 */

import type { Feed, Metric } from "./sources";
import type { SourceDefinition } from "../../lib/evidence/schema";
import { CAISO_SUPPLY_KEYS } from "../../lib/evidence/predicates";

export const CAISO_DEMAND_URL = "https://www.caiso.com/outlook/current/demand.csv";
export const CAISO_SUPPLY_URL = "https://www.caiso.com/outlook/current/fuelsource.csv";
const PACIFIC = "America/Los_Angeles";
const TIME_COLUMN = "Time";

/** Published supply columns, in the order CAISO writes them. */
const SUPPLY_COLUMNS: Record<string, (typeof CAISO_SUPPLY_KEYS)[number]> = {
  Renewables: "renewables",
  Solar: "solar",
  Wind: "wind",
  Geothermal: "geothermal",
  Biomass: "biomass",
  Biogas: "biogas",
  "Small hydro": "small_hydro",
  Coal: "coal",
  Nuclear: "nuclear",
  "Natural Gas": "natural_gas",
  "Large hydro": "large_hydro",
  Batteries: "batteries",
  Imports: "imports",
  Other: "other",
};

/** Published demand columns mapped to predicates. Missing columns stay unreported. */
const DEMAND_COLUMNS: Record<string, string> = {
  "Current demand": "caiso.system_demand_mw",
  "Net demand": "caiso.system_net_demand_mw",
};

export interface CsvTable {
  header: string[];
  rows: string[][];
}

/** RFC 4180 subset: quoted fields, doubled quotes, CRLF or LF, no bare quotes. */
export function parseCsv(text: string): CsvTable {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === ",") {
      record.push(field);
      field = "";
      continue;
    }
    if (character === "\r") continue;
    if (character === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      continue;
    }
    field += character;
  }
  if (quoted) throw new Error("Unterminated CSV field");
  if (field.length || record.length) {
    record.push(field);
    records.push(record);
  }
  const kept = records.filter((entry, index) => index === 0 || entry.some((value) => value.trim()));
  if (!kept.length) throw new Error("Empty CSV document");
  const header = kept[0].map((name) => name.trim());
  if (header.some((name) => !name)) throw new Error("CSV has an empty column name");
  if (new Set(header).size !== header.length) throw new Error("CSV has duplicate column names");
  const rows = kept.slice(1);
  for (const row of rows) {
    if (row.length !== header.length) throw new Error("CSV row has the wrong number of columns");
  }
  return { header, rows };
}

function pacificParts(instant: Date): { date: string; hour: number; minute: number; second: number } {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const values: Record<string, string> = {};
  for (const part of format.formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  const hour = values.hour === "24" ? "00" : values.hour;
  if (!values.year || !values.month || !values.day || hour === undefined || !values.minute || !values.second) {
    throw new Error("Cannot resolve Pacific wall time");
  }
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

/**
 * Convert a Pacific wall time to an exact UTC instant, resolving the daylight
 * offset from the zone data and rejecting times the zone cannot represent.
 */
export function pacificInstant(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("Expected YYYY-MM-DD and HH:MM");
  }
  const guess = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(guess)) throw new Error("Invalid operating interval");
  const local = pacificParts(new Date(guess));
  const observed = Date.parse(
    `${local.date}T${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}:${String(local.second).padStart(2, "0")}Z`,
  );
  const offset = observed - guess;
  const corrected = new Date(guess - offset);
  const check = pacificParts(corrected);
  if (check.date !== date || `${String(check.hour).padStart(2, "0")}:${String(check.minute).padStart(2, "0")}` !== time) {
    throw new Error("Unresolvable Pacific wall time");
  }
  return corrected.toISOString();
}

function lastIntervalRow(table: CsvTable) {
  const timeIndex = table.header.indexOf(TIME_COLUMN);
  if (timeIndex < 0) throw new Error("CAISO CSV has no Time column");
  for (let index = table.rows.length - 1; index >= 0; index -= 1) {
    const value = table.rows[index][timeIndex].trim();
    if (/^\d{2}:\d{2}$/.test(value)) return { time: value, index, timeIndex };
  }
  return null;
}

function numeric(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function metricsFor(text: string, columns: Record<string, string>): Metric[] {
  const table = parseCsv(text);
  const row = lastIntervalRow(table);
  if (!row) return [];
  const result: Metric[] = [{
    predicate: "telemetry.period",
    locator: `/rows/${row.index}/${row.timeIndex}`,
    value: row.time,
  }];
  const seen = new Set<string>();
  for (const [name, predicate] of Object.entries(columns)) {
    const column = table.header.indexOf(name);
    if (column < 0) continue;
    const value = numeric(table.rows[row.index][column]);
    if (value === null) continue;
    if (seen.has(predicate)) throw new Error(`Duplicate CAISO series for ${name}`);
    seen.add(predicate);
    result.push({ predicate, locator: `/rows/${row.index}/${column}`, value });
  }
  return result.length > 1 ? result : [];
}

function observationTime(text: string, retrievedAt?: string) {
  if (!retrievedAt || !Number.isFinite(Date.parse(retrievedAt))) return null;
  const row = lastIntervalRow(parseCsv(text));
  if (!row) return null;
  const retrieved = pacificParts(new Date(retrievedAt));
  const [hour, minute] = row.time.split(":").map(Number);
  // The current-day file ends at the newest published interval. After Pacific
  // midnight that interval still belongs to the previous operating day.
  const date = hour * 60 + minute > retrieved.hour * 60 + retrieved.minute
    ? new Date(Date.parse(`${retrieved.date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    : retrieved.date;
  return { timestamp: pacificInstant(date, row.time), basis: "utc" as const };
}

const demandSource: SourceDefinition = {
  id: "caiso-demand-5min",
  title: "CAISO system demand, five-minute average",
  publisher: "California ISO",
  homepage: "https://www.caiso.com/todays-outlook/demand",
  license: "CAISO public dashboard feed; see caiso.com terms of use",
  authority: "primary",
  access: {
    kind: "rest",
    endpoint: CAISO_DEMAND_URL,
    docs: "https://www.caiso.com/todays-outlook/demand",
    deterministic: false,
    notes: "Anonymous current-operating-day CSV. CAISO states these values are telemetry-based summaries, not OASIS market results.",
  },
  freshness: { cadence: "5 minutes", max_age_days: 1 / 24 },
  caveats: [
    "System-wide CAISO demand. It does not describe the analysis radius, a feeder, or any facility.",
    "The current-day CSV has no date column; the operating date is derived from the capture timestamp in America/Los_Angeles.",
    "Telemetry summaries do not reconcile to OASIS market dispatch.",
  ],
};

const supplySource: SourceDefinition = {
  id: "caiso-supply-5min",
  title: "CAISO system supply by resource type, five-minute average",
  publisher: "California ISO",
  homepage: "https://www.caiso.com/todays-outlook/supply",
  license: "CAISO public dashboard feed; see caiso.com terms of use",
  authority: "primary",
  access: {
    kind: "rest",
    endpoint: CAISO_SUPPLY_URL,
    docs: "https://www.caiso.com/todays-outlook/supply",
    deterministic: false,
    notes: "Anonymous current-operating-day CSV. Columns are matched by published header name, never by position.",
  },
  freshness: { cadence: "5 minutes", max_age_days: 1 / 24 },
  caveats: [
    "System-wide CAISO supply mix. It is not the resource mix of the analysis radius or of a serving utility.",
    "Battery and import columns can be negative; a negative value is published data, not a parsing error.",
    "Unrecognized columns stay unreported instead of being mapped to a guessed resource type.",
  ],
};

function textOf(data: unknown): string | null {
  return typeof data === "string" ? data : null;
}

/** Opt-in CAISO system feeds. Only included in queries that ask for them. */
export function caisoFeeds(): Feed[] {
  return [
    {
      source: demandSource,
      interval: 300,
      url: new URL(CAISO_DEMAND_URL),
      accept: "text/csv",
      parser: "text.lines",
      extract(data) {
        const text = textOf(data);
        return text === null ? [] : metricsFor(text, DEMAND_COLUMNS);
      },
      observationTime(data, retrievedAt) {
        const text = textOf(data);
        return text === null ? null : observationTime(text, retrievedAt);
      },
    },
    {
      source: supplySource,
      interval: 300,
      url: new URL(CAISO_SUPPLY_URL),
      accept: "text/csv",
      parser: "text.lines",
      extract(data) {
        const text = textOf(data);
        if (text === null) return [];
        const columns = Object.fromEntries(Object.entries(SUPPLY_COLUMNS)
          .map(([name, key]) => [name, `caiso.supply_${key}_mw`]));
        return metricsFor(text, columns);
      },
      observationTime(data, retrievedAt) {
        const text = textOf(data);
        return text === null ? null : observationTime(text, retrievedAt);
      },
    },
  ];
}
