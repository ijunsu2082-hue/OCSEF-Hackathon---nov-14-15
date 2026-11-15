/**
 * Snapshot parsers.
 *
 * Every snapshot declares a parser id. The verifier re-runs that parser over the
 * exact bytes and checks `record_count`. This makes `record_count` — and every
 * `artifact.count` claim built from it — reproducible without re-fetching.
 */

import { csvTable } from "./etl/caiso";
import { readZip } from "./etl/zip";

export interface ParsedSnapshot {
  data: unknown;
  recordCount: number | null;
}

export interface ParserDefinition {
  id: string;
  version: string;
  parse: (bytes: Uint8Array) => ParsedSnapshot;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** Text of the first `<tag>` element, ignoring any namespace prefix. */
function xmlText(xml: string, tag: string): string | null {
  const match = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tag}>([^<]*)</`).exec(xml);
  return match ? match[1].trim() : null;
}

export const PARSERS: Record<string, ParserDefinition> = {
  "json.eia-hourly": {
    id: "json.eia-hourly",
    version: "1",
    parse: (bytes) => {
      const data = JSON.parse(decode(bytes));
      const rows: unknown[] | null = asArray(data?.response?.data);
      if (!rows) throw new Error("EIA response has no data array");
      for (const entry of rows) {
        if (!entry || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        if (typeof row.value === "string" && /^-?\d+(\.\d+)?$/.test(row.value)) {
          row.value = Number(row.value);
        }
      }
      return { data, recordCount: rows.length };
    },
  },
  "geojson.features": {
    id: "geojson.features",
    version: "1",
    parse: (bytes) => {
      const data = JSON.parse(decode(bytes)) as { features?: unknown[] };
      const features = asArray(data.features) ?? [];
      return { data, recordCount: features.length };
    },
  },
  "json.nws-alerts": {
    id: "json.nws-alerts",
    version: "1",
    parse: (bytes) => {
      const data = JSON.parse(decode(bytes)) as Record<string, unknown>;
      const features = asArray(data.features);
      if (!features) throw new Error("NWS alerts response has no features array");
      const pagination = data.pagination;
      if (pagination !== undefined && (!pagination || typeof pagination !== "object" ||
          ("next" in pagination && pagination.next !== null && pagination.next !== ""))) {
        throw new Error("NWS alerts response is paginated or has invalid pagination metadata");
      }
      for (const feature of features) {
        const properties = feature && typeof feature === "object"
          ? (feature as { properties?: unknown }).properties : null;
        const event = properties && typeof properties === "object"
          ? (properties as { event?: unknown }).event : null;
        if (typeof event !== "string" || !event.trim()) {
          throw new Error("NWS alert feature has no event name");
        }
      }
      data.etl = { active_alert_count: features.length };
      return { data, recordCount: features.length };
    },
  },
  "json.array": {
    id: "json.array",
    version: "1",
    parse: (bytes) => {
      const data = JSON.parse(decode(bytes));
      const array = asArray(data);
      if (!array) throw new Error("json.array: root is not an array");
      return { data, recordCount: array.length };
    },
  },
  "json.overpass.elements": {
    id: "json.overpass.elements",
    version: "1",
    parse: (bytes) => {
      const data = JSON.parse(decode(bytes)) as { elements?: unknown[] };
      const elements = asArray(data.elements) ?? [];
      return { data, recordCount: elements.length };
    },
  },
  "json.census.geographies": {
    id: "json.census.geographies",
    version: "1",
    parse: (bytes) => {
      const data = JSON.parse(decode(bytes)) as {
        result?: { geographies?: Record<string, unknown[]> };
      };
      const geographies = data.result?.geographies ?? {};
      const recordCount = Object.values(geographies).reduce(
        (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
        0,
      );
      return { data, recordCount };
    },
  },
  "json.object": {
    id: "json.object",
    version: "1",
    parse: (bytes) => {
      const data = JSON.parse(decode(bytes));
      const recordCount =
        data && typeof data === "object" && !Array.isArray(data)
          ? Object.keys(data as Record<string, unknown>).length
          : null;
      return { data, recordCount };
    },
  },
  "text.lines": {
    id: "text.lines",
    version: "1",
    parse: (bytes) => {
      const text = decode(bytes);
      const lines = text.length === 0 ? [] : text.split(/\r?\n/);
      return { data: text, recordCount: lines.length };
    },
  },
  "csv.table": {
    id: "csv.table",
    version: "1",
    // RFC 4180 subset, header matched by name downstream; cells typed by caiso.csvCell.
    parse: (bytes) => {
      const data = csvTable(decode(bytes));
      return { data, recordCount: data.rows.length };
    },
  },
  "zip.csv": {
    id: "zip.csv",
    version: "1",
    /**
     * A ZIP holding exactly one `.csv` entry (CAISO OASIS SingleZip). The entry is
     * typed like `csv.table` and exposed as `{ entry, header, rows }`. OASIS answers
     * a failed query with a ZIP holding one `.xml` report instead; that fails here
     * with the report's ERR_CODE / ERR_DESC rather than parsing as data.
     */
    parse: (bytes) => {
      const entries = readZip(bytes);
      if (entries.length !== 1) throw new Error(`zip.csv: expected exactly one entry, found ${entries.length}`);
      const [{ name, data: inner }] = entries;
      if (/\.xml$/i.test(name)) {
        const xml = decode(inner);
        const code = xmlText(xml, "ERR_CODE");
        const description = xmlText(xml, "ERR_DESC");
        throw new Error(description || code
          ? `zip.csv: provider returned an error report (ERR_CODE ${code ?? "?"}): ${description ?? "no description"}`
          : `zip.csv: archive holds XML (${name}), not CSV`);
      }
      if (!/\.csv$/i.test(name)) throw new Error(`zip.csv: entry ${name} is not a .csv file`);
      const table = csvTable(decode(inner));
      return { data: { entry: name, ...table }, recordCount: table.rows.length };
    },
  },
};

export function getParser(id: string): ParserDefinition {
  const parser = PARSERS[id];
  if (!parser) throw new Error(`unknown parser: ${id}`);
  return parser;
}

export function parseSnapshot(bytes: Uint8Array, parserId: string): ParsedSnapshot {
  return getParser(parserId).parse(bytes);
}

/** Resolve an RFC 6901 JSON Pointer against parsed data. */
export function resolvePointer(data: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return data;
  if (!pointer.startsWith("/")) {
    throw new Error(`invalid JSON Pointer "${pointer}"`);
  }
  const segments = pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = data;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`pointer ${pointer}: index ${segment} out of range`);
      }
      current = current[index];
    } else if (current && typeof current === "object") {
      if (!(segment in (current as Record<string, unknown>))) {
        throw new Error(`pointer ${pointer}: missing key ${segment}`);
      }
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new Error(`pointer ${pointer}: cannot descend into ${typeof current}`);
    }
  }
  return current;
}
