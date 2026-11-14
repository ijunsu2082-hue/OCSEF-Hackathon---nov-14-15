/**
 * Snapshot parsers.
 *
 * Every snapshot declares a parser id. The verifier re-runs that parser over the
 * exact bytes and checks `record_count`. This makes `record_count` — and every
 * `artifact.count` claim built from it — reproducible without re-fetching.
 */

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

export const PARSERS: Record<string, ParserDefinition> = {
  "geojson.features": {
    id: "geojson.features",
    version: "1",
    parse: (bytes) => {
      const data = JSON.parse(decode(bytes)) as { features?: unknown[] };
      const features = asArray(data.features) ?? [];
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
