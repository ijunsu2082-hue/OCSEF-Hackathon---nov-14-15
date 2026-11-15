/**
 * CAISO OASIS nodal locational marginal prices for one explicit pricing node.
 *
 * Two anonymous OASIS SingleZip queries are ingested:
 *
 *   - `PRC_INTVL_LMP` (v3, market RTM)  five-minute real-time interval prices
 *   - `PRC_LMP`       (v12, market DAM) hourly day-ahead prices
 *
 * Each answers with a ZIP holding one CSV (snapshot parser `zip.csv`, which
 * also turns an OASIS XML error report into a rejected capture). Three
 * properties are handled explicitly:
 *
 *   1. The query window depends on the capture instant, so `urlAt(now)` builds
 *      it at capture time. The exact URL is stored on the snapshot and replay
 *      never re-derives it from the clock; `feed.url` is a window-less template.
 *   2. Columns are matched by published header name. The price column is
 *      `VALUE` in PRC_INTVL_LMP but `MW` in PRC_LMP (a CAISO naming quirk: it
 *      holds $/MWh, not megawatts); the other name must be absent.
 *   3. Rows for another node or another market fail the capture closed rather
 *      than being filtered, because they mean the query was not what was asked.
 *   4. RTM reports the newest interval with a numeric LMP. DAM reports the
 *      hour containing the snapshot's capture instant (start <= capture < end),
 *      because the operating day's later hours are in the future at capture.
 *
 * A nodal LMP is a wholesale market price at one pricing node. It is not system
 * demand, not a retail tariff, and not the price at the analysis location.
 */

import type { Feed, Metric } from "./sources";
import type { SourceDefinition } from "../../lib/evidence/schema";
import { pacificInstant, typedTable, type TypedCsvTable } from "./caiso";

export const OASIS_ENDPOINT = "https://oasis.caiso.com/oasisapi/SingleZip";
export const OASIS_NODE = /^[A-Z0-9_\-.]{3,64}$/;
const PACIFIC = "America/Los_Angeles";

export type OasisMarket = "RTM" | "DAM";

interface MarketSpec {
  queryname: string;
  version: string;
  priceColumn: string;
  otherPriceColumn: string;
  label: string;
}

const MARKETS: Record<OasisMarket, MarketSpec> = {
  RTM: { queryname: "PRC_INTVL_LMP", version: "3", priceColumn: "VALUE", otherPriceColumn: "MW", label: "real-time (five-minute interval)" },
  DAM: { queryname: "PRC_LMP", version: "12", priceColumn: "MW", otherPriceColumn: "VALUE", label: "day-ahead (hourly)" },
};

/** Published LMP_TYPE codes mapped to predicate suffixes. Other codes (e.g. MGHG) stay unreported. */
const COMPONENTS: Record<string, string> = {
  LMP: "lmp_usd_mwh",
  MCE: "energy_usd_mwh",
  MCC: "congestion_usd_mwh",
  MCL: "loss_usd_mwh",
};

const REQUIRED = ["INTERVALSTARTTIME_GMT", "NODE", "MARKET_RUN_ID", "LMP_TYPE"];
const GMT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})-00:00$/;

export function validOasisNode(node: unknown): node is string {
  return typeof node === "string" && OASIS_NODE.test(node);
}

/** OASIS `startdatetime` / `enddatetime` form: `YYYYMMDDTHH:mm-0000`, always GMT. */
function oasisTime(instant: number): string {
  const iso = new Date(instant).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 16)}-0000`;
}

function pacificDate(instant: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * The query window for a capture at `now`:
 *   - RTM: the last full UTC hour before `now` (now 08:37Z -> 07:00Z..08:00Z);
 *   - DAM: the Pacific operating day containing `now`, midnight to midnight
 *     (23 or 25 hours on daylight-saving transition days).
 */
export function oasisWindow(market: OasisMarket, now: Date): { start: number; end: number } {
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new Error("Invalid capture time");
  if (market === "RTM") {
    const end = Math.floor(time / 3_600_000) * 3_600_000;
    return { start: end - 3_600_000, end };
  }
  const date = pacificDate(now);
  const next = new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { start: Date.parse(pacificInstant(date, "00:00")), end: Date.parse(pacificInstant(next, "00:00")) };
}

function queryUrl(market: OasisMarket, node: string, window?: { start: number; end: number }): URL {
  if (!validOasisNode(node)) throw new Error("Invalid OASIS node id");
  const spec = MARKETS[market];
  const url = new URL(OASIS_ENDPOINT);
  // OASIS reads the literal `:` in its time parameters; URLSearchParams would
  // percent-encode it, so the query is written by hand from validated parts.
  url.search = [
    `queryname=${spec.queryname}`,
    ...(window ? [`startdatetime=${oasisTime(window.start)}`, `enddatetime=${oasisTime(window.end)}`] : []),
    `version=${spec.version}`,
    `market_run_id=${market}`,
    `node=${node}`,
    "resultformat=6",
  ].join("&");
  return url;
}

export function oasisUrl(market: OasisMarket, node: string, now: Date): URL {
  return queryUrl(market, node, oasisWindow(market, now));
}

/**
 * The `[start, end)` window a stored request URL asked for, from its
 * `startdatetime` / `enddatetime` (`YYYYMMDDTHH:mm-0000`, GMT).
 */
function requestedWindow(url: string | undefined): { start: number; end: number } {
  let search: URLSearchParams | null = null;
  try {
    search = url === undefined ? null : new URL(url).searchParams;
  } catch {
    search = null;
  }
  const instant = (value: string | null | undefined) => {
    const match = value ? /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2})-0000$/.exec(value) : null;
    return match ? Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00Z`) : Number.NaN;
  };
  const start = instant(search?.get("startdatetime"));
  const end = instant(search?.get("enddatetime"));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("OASIS RTM interval selection requires the stored request URL with its query window");
  }
  return { start, end };
}

function column(table: TypedCsvTable, name: string): number {
  return table.header.indexOf(name);
}

interface Latest {
  start: string;
  timeColumn: number;
  priceColumn: number;
  /** Row index per LMP_TYPE for the selected interval. */
  rows: Record<string, number>;
}

const END = "INTERVALENDTIME_GMT";

function gmtInstant(value: unknown): number {
  const match = typeof value === "string" ? GMT.exec(value) : null;
  return match ? Date.parse(`${match[1]}Z`) : Number.NaN;
}

/**
 * Validate the whole file, then select the reported interval. Rows are not
 * time-ordered in OASIS output, so the interval is chosen by value, not by
 * position:
 *   - RTM: the newest interval that has a numeric LMP, after every row's
 *     interval start is checked against the window of the stored request URL
 *     (`url`); an out-of-window row, or no usable URL, fails closed;
 *   - DAM: the interval containing `retrievedAt` (start <= capture < end). A
 *     capture outside every returned interval, or without a capture instant,
 *     fails closed instead of reporting an hour that was in the future.
 */
function latest(data: unknown, node: string, market: OasisMarket, retrievedAt?: string, url?: string): Latest | null {
  const table = typedTable(data);
  if (!table) throw new Error("OASIS snapshot is not a parsed CSV table");
  const spec = MARKETS[market];
  const unknown = table.header.filter((name) => !REQUIRED.includes(name) && name !== END && name !== spec.priceColumn);
  const required = market === "DAM" ? [...REQUIRED, END] : REQUIRED;
  const missing = [...required, spec.priceColumn].filter((name) => !table.header.includes(name));
  if (missing.length) {
    throw new Error(`OASIS ${spec.queryname} CSV is missing ${missing.join(", ")}. Other headers: ${unknown.join(", ") || "none"}.`);
  }
  if (table.header.includes(spec.otherPriceColumn)) {
    throw new Error(`OASIS ${spec.queryname} CSV carries both ${spec.priceColumn} and ${spec.otherPriceColumn}; the price column is ambiguous.`);
  }
  const [timeColumn, nodeColumn, marketColumn, typeColumn] = REQUIRED.map((name) => column(table, name));
  const priceColumn = column(table, spec.priceColumn);
  const markets = new Set(table.rows.map((row) => row[marketColumn]));
  if (markets.size > 1) throw new Error(`OASIS CSV mixes markets: ${[...markets].join(", ")}`);
  const intervals = new Map<string, Record<string, number>>();
  table.rows.forEach((row, index) => {
    if (row[nodeColumn] !== node) throw new Error(`OASIS CSV row ${index} is for node ${String(row[nodeColumn])}, not ${node}`);
    if (row[marketColumn] !== market) throw new Error(`OASIS CSV row ${index} is market ${String(row[marketColumn])}, not ${market}`);
    const start = row[timeColumn];
    if (typeof start !== "string" || !GMT.test(start) || !Number.isFinite(Date.parse(`${GMT.exec(start)![1]}Z`))) {
      throw new Error(`OASIS CSV row ${index} has an invalid INTERVALSTARTTIME_GMT`);
    }
    const type = row[typeColumn];
    if (typeof type !== "string" || !Object.hasOwn(COMPONENTS, type)) return;
    const slot = intervals.get(start) ?? {};
    if (Object.hasOwn(slot, type)) throw new Error(`OASIS CSV repeats ${type} for ${start}`);
    slot[type] = index;
    intervals.set(start, slot);
  });
  const candidates = [...intervals.entries()]
    .filter(([, rows]) => rows.LMP !== undefined && typeof table.rows[rows.LMP][priceColumn] === "number")
    .sort(([a], [b]) => gmtInstant(b) - gmtInstant(a));
  if (market === "RTM") {
    if (!table.rows.length) return null;
    // Every returned interval must fall in the window the stored URL asked for;
    // anything else means the answer is not for the query that was sent.
    const window = requestedWindow(url);
    table.rows.forEach((row, index) => {
      const start = gmtInstant(row[timeColumn]);
      if (start < window.start || start >= window.end) {
        throw new Error(`OASIS RTM CSV row ${index} interval ${String(row[timeColumn])} is outside the requested window ` +
          `${new Date(window.start).toISOString()} to ${new Date(window.end).toISOString()}`);
      }
    });
    if (!candidates.length) return null;
    const [start, rows] = candidates[0];
    return { start, timeColumn, priceColumn, rows };
  }
  if (!table.rows.length) return null;
  const capture = retrievedAt === undefined ? Number.NaN : Date.parse(retrievedAt);
  if (!Number.isFinite(capture)) {
    throw new Error("OASIS DAM interval selection requires the snapshot capture instant");
  }
  const endColumn = column(table, END);
  const containing = candidates.filter(([, rows]) => {
    const row = table.rows[rows.LMP];
    const start = gmtInstant(row[timeColumn]);
    const end = gmtInstant(row[endColumn]);
    if (!Number.isFinite(end) || end <= start) {
      throw new Error(`OASIS CSV row ${rows.LMP} has an invalid ${END}`);
    }
    return start <= capture && capture < end;
  });
  if (containing.length !== 1) {
    throw new Error(containing.length
      ? `OASIS DAM CSV has overlapping intervals containing capture ${new Date(capture).toISOString()}`
      : `OASIS DAM CSV has no interval with a numeric LMP containing capture ${new Date(capture).toISOString()}`);
  }
  const [start, rows] = containing[0];
  return { start, timeColumn, priceColumn, rows };
}

function metricsFor(data: unknown, node: string, market: OasisMarket, retrievedAt?: string, url?: string): Metric[] {
  const found = latest(data, node, market, retrievedAt, url);
  if (!found) return [];
  const table = typedTable(data)!;
  const prefix = `caiso.oasis.${market.toLowerCase()}`;
  const result: Metric[] = [{
    predicate: "telemetry.period",
    locator: `/rows/${found.rows.LMP}/${found.timeColumn}`,
    value: found.start,
  }];
  for (const [type, suffix] of Object.entries(COMPONENTS)) {
    const index = found.rows[type];
    if (index === undefined) continue;
    const value = table.rows[index][found.priceColumn];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    result.push({ predicate: `${prefix}.${suffix}`, locator: `/rows/${index}/${found.priceColumn}`, value });
  }
  return result;
}

function source(node: string, market: OasisMarket): SourceDefinition {
  const spec = MARKETS[market];
  return {
    id: `caiso-oasis-${market.toLowerCase()}-lmp`,
    title: `CAISO OASIS ${market} locational marginal price at ${node}`,
    publisher: "California ISO",
    homepage: "https://oasis.caiso.com/",
    license: "CAISO OASIS public market data; see caiso.com terms of use",
    authority: "primary",
    access: {
      kind: "rest",
      endpoint: OASIS_ENDPOINT,
      docs: "https://www.caiso.com/market-operations/oasis",
      deterministic: false,
      notes: `Anonymous ${spec.queryname} v${spec.version} SingleZip query, market_run_id=${market}, node=${node}. ` +
        "The query window is computed from the capture instant and recorded in the snapshot URL.",
    },
    freshness: market === "RTM"
      ? { cadence: "hourly window of 5-minute intervals", max_age_days: 3 / 24 }
      : { cadence: "daily (published day-ahead)", max_age_days: 2 },
    caveats: [
      `Nodal price at CAISO pricing node ${node}, market ${market} (${spec.label}), for the cited INTERVALSTARTTIME_GMT interval.`,
      "Units are $/MWh. LMP = energy (MCE) + congestion (MCC) + loss (MCL) + greenhouse-gas (MGHG, not reported) components.",
      "A wholesale market price at one node: it is not system demand, not a local retail price, and not the price at the analysis location.",
      ...(market === "RTM"
        ? ["The window is the last full UTC hour before capture; the newest interval with a published LMP is reported."]
        : ["The window is the Pacific operating day containing the capture; the hour containing the capture instant is reported.",
          "PRC_LMP names its price column MW; the values are $/MWh."]),
    ],
  };
}

function feed(node: string, market: OasisMarket): Feed {
  return {
    source: source(node, market),
    interval: market === "RTM" ? 900 : 3600,
    // Clock-independent template without the time window; capture requests
    // `urlAt(now)` and stores that exact URL on the snapshot.
    url: queryUrl(market, node),
    urlAt: (at) => oasisUrl(market, node, at),
    accept: "application/x-zip-compressed, application/zip",
    parser: "zip.csv",
    extract: (data, retrievedAt, url) => metricsFor(data, node, market, retrievedAt, url),
    observationTime(data, retrievedAt, url) {
      const found = latest(data, node, market, retrievedAt, url);
      return found ? { timestamp: new Date(`${GMT.exec(found.start)![1]}Z`).toISOString(), basis: "utc" } : null;
    },
  };
}

/** Opt-in OASIS LMP feeds for one explicit pricing node. Included only when a query names a node. */
export function oasisFeeds(node: string): Feed[] {
  if (!validOasisNode(node)) throw new Error("Invalid OASIS node id");
  return [feed(node, "RTM"), feed(node, "DAM")];
}
