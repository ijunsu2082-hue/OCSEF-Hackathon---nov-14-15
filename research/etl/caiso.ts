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
 *      unrecognized header is left unreported rather than mapped to a guess,
 *      and a header missing `Time`, `Current demand`, or most supply columns
 *      fails closed (see MIN_SUPPLY_COLUMNS).
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
  "Large Hydro": "large_hydro",
  Batteries: "batteries",
  Imports: "imports",
  Other: "other",
};

/**
 * A supply file must carry `Time` and at least this many recognized resource
 * columns. The live file publishes 13 of the 14 known names (no `Renewables`),
 * so the threshold tolerates a few renamed or dropped columns but fails closed
 * when the header has drifted far enough that most of the mix would vanish.
 */
export const MIN_SUPPLY_COLUMNS = 10;

/**
 * Known supply columns the live file does not publish today. Every other known
 * column is currently published, so its absence next to an unrecognized header
 * is a rename signature and fails closed even above MIN_SUPPLY_COLUMNS.
 */
const SUPPLY_NOT_PUBLISHED = new Set(["Renewables"]);

/**
 * Published demand columns mapped to predicates. Net demand is not a column of
 * demand.csv (CAISO publishes it separately), so it is not mapped: a `Net
 * demand` header would be reported as unknown, never as a value.
 */
const DEMAND_COLUMNS: Record<string, string> = {
  "Current demand": "caiso.system_demand_mw",
};
/** The demand file is unusable without this column. */
const DEMAND_REQUIRED = "Current demand";
/** Published demand headers that are known but deliberately not mapped to a predicate. */
const DEMAND_UNMAPPED = ["Day ahead forecast", "Hour ahead forecast", "Demand response"];

export type CaisoFile = "demand" | "supply";

export interface HeaderAudit {
  /** Known headers present in the file, excluding `Time`. */
  recognized: string[];
  /** Headers this module does not know. A renamed column shows up here. */
  unknown: string[];
  /** Known value headers absent from the file. */
  missing: string[];
}

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
  // True between a closing quote and the next delimiter; only `,` or a line end may follow.
  let closed = false;
  // True once the current field has any content, so a later quote is a bare quote.
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === ",") {
      record.push(field);
      field = "";
      closed = false;
      started = false;
      continue;
    }
    if (character === "\r") continue;
    if (character === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      closed = false;
      started = false;
      continue;
    }
    if (closed) throw new Error("CSV has data after a closing quote");
    if (character === '"') {
      if (started) throw new Error("CSV has a bare quote inside an unquoted field");
      quoted = true;
      started = true;
      continue;
    }
    started = true;
    field += character;
  }
  if (quoted) throw new Error("Unterminated CSV field");
  if (field.length || record.length || closed) {
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

export type CsvCell = string | number | null;

/** A CSV document with typed cells, as the `csv.table` snapshot parser yields it. */
export interface TypedCsvTable {
  header: string[];
  rows: CsvCell[][];
}

/**
 * Strict cell typing used by the `csv.table` and `zip.csv` snapshot parsers, so
 * `/rows/<i>/<j>` locators resolve to the value a claim stores:
 *   - a cell that is empty after trimming becomes `null`;
 *   - a trimmed cell matching `-?\d{1,15}(\.\d{1,15})?` becomes a number
 *     (no `+`, exponent, thousands separator or unit text);
 *   - every other cell keeps its exact text.
 */
export function csvCell(raw: string): CsvCell {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return /^-?\d{1,15}(?:\.\d{1,15})?$/.test(trimmed) ? Number(trimmed) : raw;
}

export function csvTable(text: string): TypedCsvTable {
  const { header, rows } = parseCsv(text);
  return { header, rows: rows.map((row) => row.map(csvCell)) };
}

/** A parsed `csv.table` snapshot, or null when the data is not one. */
export function typedTable(data: unknown): TypedCsvTable | null {
  if (!data || typeof data !== "object") return null;
  const { header, rows } = data as Partial<TypedCsvTable>;
  if (!Array.isArray(header) || !header.every((name) => typeof name === "string") || !Array.isArray(rows)) return null;
  return rows.every((row) => Array.isArray(row) && row.length === header.length) ? { header, rows } : null;
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
  const offsetAt = (instant: number) => {
    const local = pacificParts(new Date(instant));
    const observed = Date.parse(
      `${local.date}T${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}:${String(local.second).padStart(2, "0")}Z`,
    );
    return observed - instant;
  };
  // Zone transitions are months apart, so the offsets a day either side are the
  // only candidates. A nonexistent spring-forward time matches neither; an
  // ambiguous fall-back time matches both and resolves to the earlier instant.
  const candidates = [...new Set([offsetAt(guess - 86_400_000), offsetAt(guess + 86_400_000)])]
    .map((offset) => guess - offset)
    .filter((instant) => {
      const check = pacificParts(new Date(instant));
      return check.date === date && `${String(check.hour).padStart(2, "0")}:${String(check.minute).padStart(2, "0")}` === time;
    })
    .sort((a, b) => a - b);
  if (!candidates.length) throw new Error("Unresolvable Pacific wall time");
  return new Date(candidates[0]).toISOString();
}

function columnsFor(kind: CaisoFile): Record<string, string> {
  return kind === "demand"
    ? DEMAND_COLUMNS
    : Object.fromEntries(Object.entries(SUPPLY_COLUMNS).map(([name, key]) => [name, `caiso.supply_${key}_mw`]));
}

function auditHeader(header: string[], kind: CaisoFile): HeaderAudit {
  const mapped = Object.keys(columnsFor(kind));
  const known = new Set([TIME_COLUMN, ...mapped, ...(kind === "demand" ? DEMAND_UNMAPPED : [])]);
  return {
    recognized: header.filter((name) => name !== TIME_COLUMN && known.has(name)),
    unknown: header.filter((name) => !known.has(name)),
    missing: mapped.filter((name) => !header.includes(name)),
  };
}

/** Header audit for a CAISO file, so a renamed or added column is visible to callers. */
export function caisoHeaderAudit(text: string, kind: CaisoFile): HeaderAudit {
  return auditHeader(parseCsv(text).header, kind);
}

/**
 * Fail closed when the header cannot support the feed. A missing `Time` or
 * `Current demand`, or a supply header with fewer than MIN_SUPPLY_COLUMNS
 * recognized resource columns, throws so capture quarantines the bytes instead
 * of publishing a silently thinner mix.
 */
function requireHeader(table: { header: string[] }, kind: CaisoFile): HeaderAudit {
  const audit = auditHeader(table.header, kind);
  const unknown = audit.unknown.length ? ` Unrecognized headers: ${audit.unknown.join(", ")}.` : "";
  if (!table.header.includes(TIME_COLUMN)) throw new Error(`CAISO ${kind} CSV has no Time column.${unknown}`);
  if (kind === "demand" && !table.header.includes(DEMAND_REQUIRED)) {
    throw new Error(`CAISO demand CSV has no "${DEMAND_REQUIRED}" column.${unknown}`);
  }
  if (kind === "supply") {
    const supply = audit.recognized.filter((name) => Object.hasOwn(SUPPLY_COLUMNS, name));
    if (supply.length < MIN_SUPPLY_COLUMNS) {
      throw new Error(`CAISO supply CSV recognizes ${supply.length} resource columns; at least ${MIN_SUPPLY_COLUMNS} are required. ` +
        `Missing: ${audit.missing.join(", ") || "none"}.${unknown}`);
    }
    // A dropped column alone is tolerated above the threshold; a dropped column
    // alongside an unknown one is most likely a rename and is never guessed.
    const dropped = audit.missing.filter((name) => !SUPPLY_NOT_PUBLISHED.has(name));
    if (dropped.length && audit.unknown.length) {
      throw new Error(`CAISO supply CSV looks renamed: published column(s) ${dropped.join(", ")} missing while ` +
        `unrecognized header(s) ${audit.unknown.join(", ")} are present.`);
    }
  }
  return audit;
}

/** Only cells the snapshot parser typed as numbers are reported, so the locator resolves to the claimed value. */
function numeric(cell: CsvCell): number | null {
  return typeof cell === "number" && Number.isFinite(cell) ? cell : null;
}

/**
 * The newest interval CAISO has actually published. Trailing rows can carry a
 * time and forecasts but no telemetry yet (the demand file runs to the next
 * midnight), so a row only counts once every value column the feed reports is
 * numeric: `Current demand` for demand, and every recognized resource column
 * present in the header for supply, so a partly published row never stands in
 * for the full mix. Blank cells mark a row not yet published; a non-empty cell
 * that is not a number (such as `24,031`) in a row newer than the one reported
 * throws, so capture quarantines it instead of reporting an older row as fresh.
 */
function latestInterval(table: TypedCsvTable, kind: CaisoFile) {
  requireHeader(table, kind);
  const timeIndex = table.header.indexOf(TIME_COLUMN);
  const valueColumns = kind === "demand"
    ? [table.header.indexOf(DEMAND_REQUIRED)]
    : Object.keys(SUPPLY_COLUMNS).map((name) => table.header.indexOf(name)).filter((column) => column >= 0);
  for (let index = table.rows.length - 1; index >= 0; index -= 1) {
    const row = table.rows[index];
    const value = row[timeIndex];
    if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) continue;
    const malformed = valueColumns.find((column) => row[column] !== null && numeric(row[column]) === null);
    if (malformed !== undefined) {
      throw new Error(`CAISO ${kind} CSV has a non-numeric ${table.header[malformed]} "${String(row[malformed])}" at ${value}`);
    }
    if (valueColumns.every((column) => numeric(row[column]) !== null)) return { time: value, index, timeIndex };
  }
  return null;
}

function metricsFor(table: TypedCsvTable, kind: CaisoFile): Metric[] {
  const row = latestInterval(table, kind);
  if (!row) return [];
  const result: Metric[] = [{
    predicate: "telemetry.period",
    locator: `/rows/${row.index}/${row.timeIndex}`,
    value: row.time,
  }];
  const seen = new Set<string>();
  for (const [name, predicate] of Object.entries(columnsFor(kind))) {
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

/**
 * How far a row label may sit after the snapshot's `retrieved_at` and still be
 * read as the same Pacific day. `retrieved_at` is stamped when the run starts,
 * before the request is sent (and possibly queued, spaced or retried), so the
 * file can already hold an interval labelled after that instant.
 */
export const LABEL_AHEAD_TOLERANCE_SECONDS = 600;

function observationTime(table: TypedCsvTable, kind: CaisoFile, retrievedAt?: string) {
  if (!retrievedAt || !Number.isFinite(Date.parse(retrievedAt))) return null;
  const row = latestInterval(table, kind);
  if (!row) return null;
  const retrieved = pacificParts(new Date(retrievedAt));
  const [hour, minute] = row.time.split(":").map(Number);
  // The current-day file ends at the newest published interval. After Pacific
  // midnight that interval still belongs to the previous operating day; a
  // label up to LABEL_AHEAD_TOLERANCE_SECONDS after the capture is the same day.
  const date = hour * 3600 + minute * 60 >
      retrieved.hour * 3600 + retrieved.minute * 60 + retrieved.second + LABEL_AHEAD_TOLERANCE_SECONDS
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
    "Net demand is not a column of demand.csv; CAISO publishes it separately and it is not captured by this feed, so no net demand value is reported.",
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
    "Capture is rejected when fewer than 10 known resource columns are present, so a heavily renamed header cannot publish a partial mix.",
  ],
};

/**
 * Feeds read the `csv.table` parser's output. Raw text (tests, ad-hoc callers)
 * is typed with the same rule; a legacy `text.lines` snapshot therefore still
 * extracts, but its `/rows` locators only resolve under `csv.table`.
 */
function tableOf(data: unknown): TypedCsvTable | null {
  return typeof data === "string" ? csvTable(data) : typedTable(data);
}

/** Opt-in CAISO system feeds. Only included in queries that ask for them. */
export function caisoFeeds(): Feed[] {
  return [
    {
      source: demandSource,
      interval: 300,
      url: new URL(CAISO_DEMAND_URL),
      accept: "text/csv",
      parser: "csv.table",
      extract(data) {
        const table = tableOf(data);
        return table === null ? [] : metricsFor(table, "demand");
      },
      observationTime(data, retrievedAt) {
        const table = tableOf(data);
        return table === null ? null : observationTime(table, "demand", retrievedAt);
      },
    },
    {
      source: supplySource,
      interval: 300,
      url: new URL(CAISO_SUPPLY_URL),
      accept: "text/csv",
      parser: "csv.table",
      extract(data) {
        const table = tableOf(data);
        return table === null ? [] : metricsFor(table, "supply");
      },
      observationTime(data, retrievedAt) {
        const table = tableOf(data);
        return table === null ? null : observationTime(table, "supply", retrievedAt);
      },
    },
  ];
}
