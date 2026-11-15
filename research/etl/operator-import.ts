/**
 * Operator imports: topology, equipment ratings and condition, meter series and
 * quotes supplied by a utility or site operator.
 *
 * An operator input is neither public data nor a model output. Every stored
 * record carries `method: "operator"` and is kept beside public-source records,
 * never merged into them: `readOperatorSideBySide` returns the loaded public
 * asset inventory and the operator inputs under separate keys.
 *
 * Input is one JSON envelope (plus, for `meter_series`, an optional CSV of
 * readings). The envelope must record who issued it, when (ISO 8601 with an
 * explicit offset), for which location and assets, for whom it is visible, and
 * the period it is effective for. Every physical or monetary quantity is a
 * `{ value, unit }` pair with a fixed unit per field; a bare number is rejected.
 *
 * Storage, under `stateRoot()/operator/<location>/`:
 *
 *   raw/<sha256>.json|.csv     exact bytes as received, content-addressed
 *   inputs/<revision>.json     normalized record; revision = digest(record)
 *   manifests/<digest>.json    sorted set of input revisions for the location
 *   latest.json                { revision } of the current manifest
 *
 * The normalized record is a pure function of the raw bytes, so the same bytes
 * always yield the same revision and `replayOperatorInput` can re-derive it.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digest } from "../../lib/evidence/canonical";
import { readLocationAssets } from "./load-assets";
import { atomicJson, locationId, locationQuery, stateRoot } from "./pipeline";

export const OPERATOR_INPUT_SCHEMA = "gridsentinel.operator-input/1" as const;
export const OPERATOR_MANIFEST_SCHEMA = "gridsentinel.operator-manifest/1" as const;

export type OperatorKind = "topology" | "equipment_rating" | "equipment_condition" | "meter_series" | "quote";
export type Visibility = "private" | "shared" | "public";

const KINDS: readonly OperatorKind[] = ["topology", "equipment_rating", "equipment_condition", "meter_series", "quote"];
const VISIBILITIES: readonly Visibility[] = ["private", "shared", "public"];
/** A caller cleared for a level sees that level and everything less restricted. */
const RANK: Record<Visibility, number> = { public: 0, shared: 1, private: 2 };
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_READINGS = 200_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 60_000;

export class OperatorImportError extends Error {}

export interface Quantity {
  value: number;
  unit: string;
}

export interface OperatorSource {
  role: "envelope" | "readings_csv";
  sha256: string;
  bytes: number;
  media_type: "application/json" | "text/csv";
  /** Relative to the location's operator directory. */
  path: string;
}

export interface OperatorRecord {
  schema: typeof OPERATOR_INPUT_SCHEMA;
  method: "operator";
  label: string;
  location: string;
  kind: OperatorKind;
  issuer: { name: string; organization: string; contact?: string };
  issued_at: string;
  issued_at_utc: string;
  scope: { location: string; center?: [number, number]; radius_miles?: number; assets: string[] };
  visibility: Visibility;
  effective: { start: string; start_utc: string; end?: string; end_utc?: string };
  sources: OperatorSource[];
  payload: Record<string, unknown>;
}

export interface OperatorManifest {
  schema: typeof OPERATOR_MANIFEST_SCHEMA;
  location: string;
  inputs: { revision: string; kind: OperatorKind; visibility: Visibility }[];
}

const LABEL = "Operator-supplied input. Not public-source data and not a model output; not independently verified.";

// ---------------------------------------------------------------------------
// Validation primitives. Each throws with the JSON path of the offending field.

function fail(path: string, message: string): never {
  throw new OperatorImportError(`${path}: ${message}`);
}

type Plain = Record<string, unknown>;

function object(value: unknown, path: string, required: string[], optional: string[] = []): Plain {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  const record = value as Plain;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
  for (const key of required) if (record[key] === undefined || record[key] === null) fail(`${path}.${key}`, "is required");
  return record;
}

function list(value: unknown, path: string, max = 10_000): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  if (value.length === 0) fail(path, "must not be empty");
  if (value.length > max) fail(path, `at most ${max} entries`);
  return value;
}

function text(value: unknown, path: string, max = 200): string {
  if (typeof value !== "string" || !value.trim()) fail(path, "expected a non-empty string");
  if (value.length > max) fail(path, `at most ${max} characters`);
  return value.trim();
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    fail(path, "expected an id of letters, digits, '.', '_', ':' or '-' (max 128)");
  }
  return value;
}

function choice<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) fail(path, `expected one of ${options.join(", ")}`);
  return value as T;
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** ISO 8601 with an explicit offset; returns epoch milliseconds. */
function timestamp(value: unknown, path: string): { original: string; ms: number; utc: string; offset: string } {
  if (typeof value !== "string") fail(path, "expected an ISO 8601 timestamp with offset");
  const match = TIMESTAMP.exec(value);
  if (!match) fail(path, "timestamp must be ISO 8601 with an explicit offset (Z or ±HH:MM)");
  const [, year, month, day, hour, minute, second = "00", offset] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    fail(path, "timestamp is not a valid calendar time");
  }
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59)) fail(path, "offset out of range");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail(path, "timestamp is not parseable");
  return { original: value, ms, utc: new Date(ms).toISOString(), offset: offset === "Z" ? "+00:00" : offset };
}

function quantity(value: unknown, path: string, unit: string, sign: "positive" | "nonnegative" | "any" = "positive"): Quantity {
  if (typeof value === "number" || typeof value === "string") {
    fail(path, `unit-less value; expected { "value": <number>, "unit": "${unit}" }`);
  }
  const record = object(value, path, ["value", "unit"]);
  if (record.unit !== unit) fail(`${path}.unit`, `expected unit "${unit}"`);
  const number = record.value;
  if (typeof number !== "number" || !Number.isFinite(number)) fail(`${path}.value`, "expected a finite number");
  if (sign === "positive" && !(number > 0)) fail(`${path}.value`, "must be greater than zero");
  if (sign === "nonnegative" && number < 0) fail(`${path}.value`, "must not be negative");
  return { value: Object.is(number, -0) ? 0 : number, unit };
}

function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

function unique(ids: string[], path: string, what = "asset id"): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) fail(path, `duplicate ${what} ${JSON.stringify(id)}`);
    seen.add(id);
  }
}

function inScope(ids: string[], scope: Set<string>, path: string): void {
  for (const id of ids) if (!scope.has(id)) fail(path, `asset ${JSON.stringify(id)} is not listed in scope.assets`);
}

/** Drop undefined so canonical JSON and on-disk JSON agree. */
function compact<T extends Plain>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// Per-kind payload schemas.

interface Context {
  scope: Set<string>;
  issuedMs: number;
  csv: Uint8Array | null;
}

function topology(raw: unknown, context: Context): Plain {
  const payload = object(raw, "payload", ["buses", "branches"], ["feeder_id"]);
  const buses = list(payload.buses, "payload.buses").map((entry, index) => {
    const path = `payload.buses[${index}]`;
    const bus = object(entry, path, ["id", "base_voltage"], ["name"]);
    return compact({
      id: identifier(bus.id, `${path}.id`),
      name: optional(bus.name, (value) => text(value, `${path}.name`)),
      base_voltage: quantity(bus.base_voltage, `${path}.base_voltage`, "kV"),
    });
  });
  const busIds = new Set(buses.map(({ id }) => id));
  const branches = list(payload.branches, "payload.branches").map((entry, index) => {
    const path = `payload.branches[${index}]`;
    const branch = object(entry, path, ["id", "from_bus", "to_bus", "voltage", "length"], ["rating"]);
    const from = identifier(branch.from_bus, `${path}.from_bus`);
    const to = identifier(branch.to_bus, `${path}.to_bus`);
    if (!busIds.has(from)) fail(`${path}.from_bus`, `unknown bus ${JSON.stringify(from)}`);
    if (!busIds.has(to)) fail(`${path}.to_bus`, `unknown bus ${JSON.stringify(to)}`);
    if (from === to) fail(path, "a branch must connect two different buses");
    return compact({
      id: identifier(branch.id, `${path}.id`),
      from_bus: from,
      to_bus: to,
      voltage: quantity(branch.voltage, `${path}.voltage`, "kV"),
      length: quantity(branch.length, `${path}.length`, "mi"),
      rating: optional(branch.rating, (value) => quantity(value, `${path}.rating`, "MVA")),
    });
  });
  const ids = [...buses.map(({ id }) => id), ...branches.map(({ id }) => id)];
  unique(ids, "payload");
  inScope(ids, context.scope, "payload");
  return compact({
    feeder_id: optional(payload.feeder_id, (value) => identifier(value, "payload.feeder_id")),
    buses: [...buses].sort((a, b) => a.id.localeCompare(b.id)),
    branches: [...branches].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

const RATING_FIELDS = {
  voltage: "kV",
  current: "A",
  apparent_power: "MVA",
  real_power: "MW",
  energy: "MWh",
} as const;

function equipmentRating(raw: unknown, context: Context): Plain {
  const payload = object(raw, "payload", ["ratings"]);
  const fields = Object.keys(RATING_FIELDS) as (keyof typeof RATING_FIELDS)[];
  const ratings = list(payload.ratings, "payload.ratings").map((entry, index) => {
    const path = `payload.ratings[${index}]`;
    const rating = object(entry, path, ["asset_id", "basis"], fields);
    const values = Object.fromEntries(fields
      .filter((field) => rating[field] !== undefined)
      .map((field) => [field, quantity(rating[field], `${path}.${field}`, RATING_FIELDS[field])]));
    if (!Object.keys(values).length) fail(path, `at least one of ${fields.join(", ")} is required`);
    return {
      asset_id: identifier(rating.asset_id, `${path}.asset_id`),
      basis: choice(rating.basis, `${path}.basis`, ["nameplate", "normal", "emergency"] as const),
      ...values,
    };
  });
  unique(ratings.map(({ asset_id, basis }) => `${asset_id}/${basis}`), "payload.ratings", "asset id/basis pair");
  inScope(ratings.map(({ asset_id }) => asset_id), context.scope, "payload.ratings");
  return { ratings: ratings.sort((a, b) => `${a.asset_id}/${a.basis}`.localeCompare(`${b.asset_id}/${b.basis}`)) };
}

function equipmentCondition(raw: unknown, context: Context): Plain {
  const payload = object(raw, "payload", ["assessments"]);
  const assessments = list(payload.assessments, "payload.assessments").map((entry, index) => {
    const path = `payload.assessments[${index}]`;
    const assessment = object(entry, path, ["asset_id", "assessed_at", "condition"], ["inspection", "derated_capacity", "notes"]);
    const at = timestamp(assessment.assessed_at, `${path}.assessed_at`);
    if (at.ms > context.issuedMs) fail(`${path}.assessed_at`, "is after issued_at");
    return compact({
      asset_id: identifier(assessment.asset_id, `${path}.asset_id`),
      assessed_at: at.original,
      assessed_at_utc: at.utc,
      condition: choice(assessment.condition, `${path}.condition`, ["good", "fair", "poor", "critical"] as const),
      inspection: optional(assessment.inspection, (value) => text(value, `${path}.inspection`)),
      derated_capacity: optional(assessment.derated_capacity, (value) => quantity(value, `${path}.derated_capacity`, "MVA")),
      notes: optional(assessment.notes, (value) => text(value, `${path}.notes`, 2000)),
    });
  });
  const ids = assessments.map(({ asset_id }) => asset_id);
  unique(ids, "payload.assessments");
  inScope(ids, context.scope, "payload.assessments");
  return { assessments: assessments.sort((a, b) => a.asset_id.localeCompare(b.asset_id)) };
}

const METER_UNITS = { energy: "MWh", demand: "MW" } as const;

function zoneOffset(timeZone: string, ms: number): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms)).find((part) => part.type === "timeZoneName")?.value ?? "";
  if (name === "GMT") return "+00:00";
  const match = /^GMT([+-]\d{2}):(\d{2})$/.exec(name);
  if (!match) throw new OperatorImportError(`timezone ${timeZone} offset could not be resolved`);
  return `${match[1]}:${match[2]}`;
}

function csvReadings(bytes: Uint8Array, unit: string): { interval_start: unknown; value: unknown; path: string }[] {
  const body = Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
  const lines = body.split("\n");
  if (lines[0] !== `interval_start,${unit}`) {
    fail("readings_csv:1", `header must be exactly "interval_start,${unit}" so the unit is explicit`);
  }
  if (lines.length < 2) fail("readings_csv", "has no readings");
  return lines.slice(1).map((line, index) => {
    const path = `readings_csv:${index + 2}`;
    if (/["\r]/.test(line)) fail(path, "quoted fields and stray carriage returns are not allowed");
    const fields = line.split(",");
    if (fields.length !== 2) fail(path, "expected exactly interval_start and value");
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(fields[1])) fail(path, "value is not a number");
    return { interval_start: fields[0], value: Number(fields[1]), path };
  });
}

function meterSeries(raw: unknown, context: Context): Plain {
  const payload = object(raw, "payload",
    ["meter_id", "asset_id", "quantity", "unit", "interval_minutes", "timezone"], ["readings"]);
  const kind = choice(payload.quantity, "payload.quantity", ["energy", "demand"] as const);
  const unit = METER_UNITS[kind];
  if (payload.unit !== unit) fail("payload.unit", `quantity "${kind}" requires unit "${unit}"`);
  const interval = payload.interval_minutes;
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > 1440 || 1440 % interval !== 0) {
    fail("payload.interval_minutes", "expected an integer number of minutes that divides a day (1..1440)");
  }
  const timeZone = text(payload.timezone, "payload.timezone", 64);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    fail("payload.timezone", "expected an IANA time zone such as America/Los_Angeles");
  }
  const assetId = identifier(payload.asset_id, "payload.asset_id");
  inScope([assetId], context.scope, "payload.asset_id");
  if (payload.readings !== undefined && context.csv) fail("payload.readings", "give readings inline or as CSV, not both");
  if (payload.readings === undefined && !context.csv) fail("payload.readings", "is required (inline or as a CSV file)");
  const source = context.csv
    ? csvReadings(context.csv, unit)
    : list(payload.readings, "payload.readings", MAX_READINGS).map((entry, index) => {
      const path = `payload.readings[${index}]`;
      const reading = object(entry, path, ["interval_start", "value"]);
      if (typeof reading.value !== "number") fail(`${path}.value`, `expected a number in ${unit} (series unit)`);
      return { interval_start: reading.interval_start, value: reading.value, path };
    });
  if (source.length > MAX_READINGS) fail("payload.readings", `at most ${MAX_READINGS} readings`);
  const stepMs = interval * 60_000;
  const readings = source.map(({ interval_start, value, path }) => {
    const at = timestamp(interval_start, `${path}.interval_start`);
    if (at.offset !== "+00:00" && at.offset !== zoneOffset(timeZone, at.ms)) {
      fail(`${path}.interval_start`, `offset ${at.offset} does not match ${timeZone} at that instant`);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path}.value`, "expected a finite number");
    return { interval_start: at.original, interval_start_utc: at.utc, ms: at.ms, value: Object.is(value, -0) ? 0 : value, path };
  }).sort((a, b) => a.ms - b.ms);
  let gaps = 0;
  for (let index = 1; index < readings.length; index += 1) {
    const previous = readings[index - 1];
    const current = readings[index];
    if (current.ms < previous.ms + stepMs) {
      fail(current.path, `interval overlaps the interval starting ${previous.interval_start}`);
    }
    gaps += Math.floor((current.ms - previous.ms) / stepMs) - 1;
  }
  return {
    meter_id: identifier(payload.meter_id, "payload.meter_id"),
    asset_id: assetId,
    quantity: kind,
    unit,
    interval_minutes: interval,
    timezone: timeZone,
    timestamp_basis: "interval_start",
    summary: {
      readings: readings.length,
      first_interval_start_utc: readings[0].interval_start_utc,
      last_interval_end_utc: new Date(readings[readings.length - 1].ms + stepMs).toISOString(),
      missing_intervals: gaps,
    },
    readings: readings.map(({ interval_start, interval_start_utc, value }) => ({ interval_start, interval_start_utc, value })),
  };
}

function quote(raw: unknown, context: Context): Plain {
  const payload = object(raw, "payload", ["vendor", "currency", "valid_until", "lines"], ["reference"]);
  // Money is expressed with the "$" unit; only USD is accepted so "$" is unambiguous.
  if (payload.currency !== "USD") fail("payload.currency", 'only "USD" is supported (unit "$")');
  const validUntil = timestamp(payload.valid_until, "payload.valid_until");
  if (validUntil.ms <= context.issuedMs) fail("payload.valid_until", "must be after issued_at");
  const lines = list(payload.lines, "payload.lines").map((entry, index) => {
    const path = `payload.lines[${index}]`;
    const line = object(entry, path, ["line_id", "item", "quantity", "unit_price"], ["asset_id"]);
    const count = line.quantity;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) fail(`${path}.quantity`, "expected a positive integer count");
    return compact({
      line_id: identifier(line.line_id, `${path}.line_id`),
      item: text(line.item, `${path}.item`),
      asset_id: optional(line.asset_id, (value) => identifier(value, `${path}.asset_id`)),
      quantity: count,
      unit_price: quantity(line.unit_price, `${path}.unit_price`, "$", "nonnegative"),
    });
  });
  unique(lines.map(({ line_id }) => line_id), "payload.lines", "line id");
  inScope(lines.flatMap(({ asset_id }) => (asset_id ? [asset_id] : [])), context.scope, "payload.lines");
  return compact({
    vendor: text(payload.vendor, "payload.vendor"),
    reference: optional(payload.reference, (value) => text(value, "payload.reference")),
    currency: "USD",
    valid_until: validUntil.original,
    valid_until_utc: validUntil.utc,
    lines: lines.sort((a, b) => a.line_id.localeCompare(b.line_id)),
  });
}

const PAYLOADS: Record<OperatorKind, (raw: unknown, context: Context) => Plain> = {
  topology,
  equipment_rating: equipmentRating,
  equipment_condition: equipmentCondition,
  meter_series: meterSeries,
  quote,
};

// ---------------------------------------------------------------------------
// Envelope.

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function scopeOf(raw: unknown): OperatorRecord["scope"] {
  const scope = object(raw, "scope", ["assets"], ["location_id", "center", "radius_miles"]);
  const assets = list(scope.assets, "scope.assets").map((id, index) => identifier(id, `scope.assets[${index}]`));
  unique(assets, "scope.assets");
  const sorted = [...assets].sort();
  if (scope.location_id !== undefined) {
    if (scope.center !== undefined || scope.radius_miles !== undefined) {
      fail("scope", "give either location_id or center + radius_miles, not both");
    }
    if (typeof scope.location_id !== "string" || !/^location-[a-f0-9]{24}$/.test(scope.location_id)) {
      fail("scope.location_id", "expected location-<24 hex>");
    }
    return { location: scope.location_id, assets: sorted };
  }
  if (scope.center === undefined || scope.radius_miles === undefined) {
    fail("scope", "location_id or center + radius_miles is required");
  }
  const center = scope.center;
  if (!Array.isArray(center) || center.length !== 2 || !center.every((value) => typeof value === "number")) {
    fail("scope.center", "expected [latitude, longitude]");
  }
  if (typeof scope.radius_miles !== "number") fail("scope.radius_miles", "expected a number of miles");
  let query;
  try {
    query = locationQuery(center[0], center[1], scope.radius_miles);
  } catch (error) {
    fail("scope", error instanceof Error ? error.message : "invalid location");
  }
  // Same id the loaded public asset inventory uses for this center + radius.
  return { location: locationId(query), center: query.center, radius_miles: query.radius_miles, assets: sorted };
}

/**
 * Validate and normalize an operator input from its raw bytes. Pure: no I/O,
 * no clock. Throws `OperatorImportError` naming the first offending field.
 */
export function normalizeOperatorInput(envelopeBytes: Uint8Array, csvBytes: Uint8Array | null = null): OperatorRecord {
  if (envelopeBytes.length > MAX_INPUT_BYTES) fail("envelope", "exceeds the 16 MiB limit");
  if (csvBytes && csvBytes.length > MAX_INPUT_BYTES) fail("readings_csv", "exceeds the 16 MiB limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(envelopeBytes).toString("utf8"));
  } catch {
    fail("envelope", "is not valid JSON");
  }
  const envelope = object(parsed, "envelope",
    ["kind", "issuer", "issued_at", "scope", "visibility", "effective", "payload"]);
  const kind = choice(envelope.kind, "kind", KINDS);
  if (csvBytes && kind !== "meter_series") fail("readings_csv", "a CSV file is only accepted for meter_series");
  const issuerRaw = object(envelope.issuer, "issuer", ["name", "organization"], ["contact"]);
  const issuer = compact({
    name: text(issuerRaw.name, "issuer.name"),
    organization: text(issuerRaw.organization, "issuer.organization"),
    contact: optional(issuerRaw.contact, (value) => text(value, "issuer.contact")),
  });
  const issued = timestamp(envelope.issued_at, "issued_at");
  const scope = scopeOf(envelope.scope);
  const visibility = choice(envelope.visibility, "visibility", VISIBILITIES);
  const effectiveRaw = object(envelope.effective, "effective", ["start"], ["end"]);
  const start = timestamp(effectiveRaw.start, "effective.start");
  const end = optional(effectiveRaw.end, (value) => timestamp(value, "effective.end"));
  if (end && end.ms <= start.ms) fail("effective.end", "must be after effective.start");
  const payload = PAYLOADS[kind](envelope.payload, { scope: new Set(scope.assets), issuedMs: issued.ms, csv: csvBytes });
  const envelopeSha = sha256(envelopeBytes);
  const sources: OperatorSource[] = [{
    role: "envelope", sha256: envelopeSha, bytes: envelopeBytes.length,
    media_type: "application/json", path: `raw/${envelopeSha}.json`,
  }];
  if (csvBytes) {
    const csvSha = sha256(csvBytes);
    sources.push({ role: "readings_csv", sha256: csvSha, bytes: csvBytes.length, media_type: "text/csv", path: `raw/${csvSha}.csv` });
  }
  return {
    schema: OPERATOR_INPUT_SCHEMA,
    method: "operator",
    label: LABEL,
    location: scope.location,
    kind,
    issuer,
    issued_at: issued.original,
    issued_at_utc: issued.utc,
    scope,
    visibility,
    effective: compact({ start: start.original, start_utc: start.utc, end: end?.original, end_utc: end?.utc }),
    sources,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Storage.

function directoryFor(location: string): string {
  if (!/^location-[a-f0-9]{24}$/.test(location)) throw new OperatorImportError("Invalid location id");
  return resolve(stateRoot(), "operator", location);
}

/** Content-addressed write; an existing file must already hold the same bytes. */
async function storeRaw(path: string, bytes: Uint8Array, hash: string): Promise<void> {
  const existing = await readFile(path).catch(() => null);
  if (existing) {
    if (sha256(existing) !== hash) throw new Error(`Stored operator bytes at ${path} fail their checksum`);
    return;
  }
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Serialize manifest updates for one location across processes with a lock directory. */
async function withLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const lock = resolve(directory, ".lock");
  await mkdir(directory, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for operator import lock on ${directory}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function currentManifest(directory: string, location: string): Promise<{ revision: string | null; manifest: OperatorManifest }> {
  const latest = await readJson(resolve(directory, "latest.json")) as { revision?: unknown } | null;
  if (!latest) return { revision: null, manifest: { schema: OPERATOR_MANIFEST_SCHEMA, location, inputs: [] } };
  const revision = latest.revision;
  if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) throw new Error("Invalid operator manifest pointer");
  const manifest = await readJson(resolve(directory, "manifests", `${revision}.json`)) as OperatorManifest | null;
  if (!manifest) throw new Error("Operator manifest pointed to by latest.json is missing");
  if (digest(manifest) !== revision) throw new Error("Operator manifest checksum mismatch");
  if (manifest.location !== location) throw new Error("Operator manifest belongs to another location");
  return { revision, manifest };
}

export interface OperatorImportResult {
  location: string;
  kind: OperatorKind;
  visibility: Visibility;
  revision: string;
  manifest: string;
  /** False when these exact bytes were already imported. */
  created: boolean;
  sources: { role: OperatorSource["role"]; sha256: string }[];
}

/** Validate, store raw bytes + normalized revision, and add it to the location manifest. */
export async function importOperatorInput(envelopeBytes: Uint8Array, csvBytes: Uint8Array | null = null): Promise<OperatorImportResult> {
  const record = normalizeOperatorInput(envelopeBytes, csvBytes);
  const revision = digest(record);
  const directory = directoryFor(record.location);
  for (const source of record.sources) {
    await storeRaw(resolve(directory, source.path), source.role === "envelope" ? envelopeBytes : csvBytes!, source.sha256);
  }
  const inputPath = resolve(directory, "inputs", `${revision}.json`);
  const existing = await readJson(inputPath);
  if (existing === null) await atomicJson(inputPath, record);
  else if (digest(existing) !== revision) throw new Error(`Stored operator revision ${revision} fails its checksum`);
  return withLock(directory, async () => {
    const { revision: previous, manifest } = await currentManifest(directory, record.location);
    const created = !manifest.inputs.some((entry) => entry.revision === revision);
    const next: OperatorManifest = created
      ? {
        schema: OPERATOR_MANIFEST_SCHEMA,
        location: record.location,
        inputs: [...manifest.inputs, { revision, kind: record.kind, visibility: record.visibility }]
          .sort((a, b) => a.revision.localeCompare(b.revision)),
      }
      : manifest;
    const manifestRevision = digest(next);
    if (manifestRevision !== previous) {
      await atomicJson(resolve(directory, "manifests", `${manifestRevision}.json`), next);
      await atomicJson(resolve(directory, "latest.json"), { revision: manifestRevision });
    }
    return {
      location: record.location, kind: record.kind, visibility: record.visibility,
      revision, manifest: manifestRevision, created,
      sources: record.sources.map(({ role, sha256: hash }) => ({ role, sha256: hash })),
    };
  });
}

export async function importOperatorFiles(envelopePath: string, csvPath?: string): Promise<OperatorImportResult> {
  const envelope = await readFile(resolve(envelopePath));
  const csv = csvPath ? await readFile(resolve(csvPath)) : null;
  return importOperatorInput(envelope, csv);
}

async function loadRecord(directory: string, revision: string): Promise<OperatorRecord> {
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("Invalid operator revision");
  const record = await readJson(resolve(directory, "inputs", `${revision}.json`)) as OperatorRecord | null;
  if (!record) throw new Error(`Operator revision ${revision} is missing`);
  if (digest(record) !== revision) throw new Error(`Operator revision ${revision} checksum mismatch`);
  for (const source of record.sources) {
    if (!/^raw\/[a-f0-9]{64}\.(json|csv)$/.test(source.path)) throw new Error("Invalid operator source path");
    const bytes = await readFile(resolve(directory, source.path));
    if (sha256(bytes) !== source.sha256) throw new Error(`Operator raw bytes ${source.sha256} fail their checksum`);
  }
  return record;
}

export interface OperatorInputs {
  location: string;
  manifest: string;
  /** The clearance the caller asked with; nothing more restricted is included. */
  visibility: Visibility;
  inputs: (OperatorRecord & { revision: string })[];
}

/**
 * Operator inputs for a location that a caller with clearance `visibility` may
 * see: `public` sees public only, `shared` sees public + shared, `private` sees
 * all. Every record and its raw bytes are checksum-verified before return.
 */
export async function readOperatorInputs(
  location: string, options: { visibility: Visibility; manifest?: string },
): Promise<OperatorInputs | null> {
  const clearance = choice(options?.visibility, "visibility", VISIBILITIES);
  if (!/^location-[a-f0-9]{24}$/.test(location)) return null;
  const directory = directoryFor(location);
  let revision: string | null;
  let manifest: OperatorManifest;
  if (options.manifest !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(options.manifest)) return null;
    const pinned = await readJson(resolve(directory, "manifests", `${options.manifest}.json`)) as OperatorManifest | null;
    if (!pinned) return null;
    if (digest(pinned) !== options.manifest) throw new Error("Operator manifest checksum mismatch");
    revision = options.manifest;
    manifest = pinned;
  } else {
    ({ revision, manifest } = await currentManifest(directory, location));
    if (!revision) return null;
  }
  const visible = (level: Visibility) => RANK[level] <= RANK[clearance];
  const inputs = [];
  for (const entry of manifest.inputs) {
    if (!visible(entry.visibility)) continue;
    const record = await loadRecord(directory, entry.revision);
    // The record itself is authoritative; never trust the manifest alone for access.
    if (!visible(record.visibility) || record.visibility !== entry.visibility) continue;
    inputs.push({ revision: entry.revision, ...record });
  }
  return { location, manifest: revision, visibility: clearance, inputs };
}

/** Re-derive a stored revision from its raw bytes; throws unless it reproduces exactly. */
export async function replayOperatorInput(location: string, revision: string): Promise<{ revision: string; replayed: true }> {
  const directory = directoryFor(location);
  const record = await loadRecord(directory, revision);
  const bytesFor = (role: OperatorSource["role"]) => {
    const source = record.sources.find((entry) => entry.role === role);
    return source ? readFile(resolve(directory, source.path)) : Promise.resolve(null);
  };
  const envelope = await bytesFor("envelope");
  if (!envelope) throw new Error("Operator revision has no envelope source");
  const rebuilt = normalizeOperatorInput(envelope, await bytesFor("readings_csv"));
  if (digest(rebuilt) !== revision) throw new Error(`Operator revision ${revision} does not replay from its raw bytes`);
  return { revision, replayed: true };
}

/**
 * Public asset inventory and operator inputs for one location, side by side.
 * The two are never merged: a consumer that wants to compare an operator
 * rating against a public one must do so explicitly and cite both.
 */
export async function readOperatorSideBySide(location: string, options: { visibility: Visibility }) {
  const [publicAssets, operator] = await Promise.all([
    readLocationAssets(location),
    readOperatorInputs(location, options),
  ]);
  return {
    location,
    public: publicAssets ? { method: "public" as const, ...publicAssets } : null,
    operator: operator ? { method: "operator" as const, ...operator } : null,
  };
}

/**
 * CLI entry: `operator-import <envelope.json> [readings.csv]`. Returns the
 * import result; the caller prints it.
 */
export async function runOperatorImportCommand(args: string[]): Promise<OperatorImportResult> {
  if (args.length < 1 || args.length > 2 || args.some((arg) => !arg.trim() || arg.startsWith("--"))) {
    throw new Error("Expected operator-import <envelope.json> [readings.csv]");
  }
  return importOperatorFiles(args[0], args[1]);
}
