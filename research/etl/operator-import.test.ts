import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { digest } from "../../lib/evidence/canonical";
import {
  importOperatorFiles, importOperatorInput, normalizeOperatorInput, OperatorImportError, readOperatorInputs,
  readOperatorSideBySide, replayOperatorInput, runOperatorImportCommand,
} from "./operator-import";
import { atomicJson, stateRoot } from "./pipeline";

const FIXTURES = resolve("research/etl/fixtures/operator");
const LOCATION = "location-29a410dca3e4c0191458bdbc";
const fixture = (name: string) => readFile(resolve(FIXTURES, name));
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

function namespace(t: TestContext): void {
  const prior = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const root = resolve(stateRoot());
  t.after(async () => {
    if (prior === undefined) delete process.env.ETL_STATE_NAMESPACE;
    else process.env.ETL_STATE_NAMESPACE = prior;
    await rm(root, { recursive: true, force: true });
  });
}

async function json(name: string): Promise<Record<string, any>> {
  return JSON.parse((await fixture(name)).toString("utf8"));
}

function rejects(envelope: unknown, pattern: RegExp, csv: Uint8Array | null = null): void {
  assert.throws(() => normalizeOperatorInput(bytes(envelope), csv), (error: unknown) => {
    assert.ok(error instanceof OperatorImportError, `expected OperatorImportError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });
}

test("each kind imports from its valid fixture with method: operator and full provenance", async (t) => {
  namespace(t);
  const cases: [string, string | undefined, string][] = [
    ["topology.json", undefined, "topology"],
    ["equipment-rating.json", undefined, "equipment_rating"],
    ["equipment-condition.json", undefined, "equipment_condition"],
    ["meter-series.json", undefined, "meter_series"],
    ["meter-series-csv.json", "meter-readings.csv", "meter_series"],
    ["quote.json", undefined, "quote"],
  ];
  for (const [envelope, csv, kind] of cases) {
    const result = await importOperatorFiles(resolve(FIXTURES, envelope), csv && resolve(FIXTURES, csv));
    assert.equal(result.kind, kind, envelope);
    // center + radius and the equivalent location_id land in the same location.
    assert.equal(result.location, LOCATION, envelope);
    assert.equal(result.created, true);
    assert.match(result.revision, /^[a-f0-9]{64}$/);
    assert.equal(result.sources.length, csv ? 2 : 1);
  }
  const all = await readOperatorInputs(LOCATION, { visibility: "private" });
  assert.ok(all);
  assert.equal(all.inputs.length, 6);
  for (const input of all.inputs) {
    assert.equal(input.method, "operator");
    assert.match(input.label, /Operator-supplied/);
    assert.ok(input.issuer.name && input.issuer.organization);
    assert.match(input.issued_at, /(Z|[+-]\d{2}:\d{2})$/);
    assert.ok(input.scope.assets.length > 0);
    assert.ok(input.effective.start_utc);
    assert.equal(digest(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "revision"))), input.revision);
  }

  const topology = all.inputs.find((input) => input.kind === "topology")!;
  assert.deepEqual(topology.scope.center, [33.75, -117.99]);
  assert.deepEqual((topology.payload.branches as any[]).map((branch) => branch.rating?.unit ?? null), ["MVA", null]);

  const meter = all.inputs.find((input) => input.kind === "meter_series" && input.payload.meter_id === "mtr-4471")!;
  assert.deepEqual(meter.payload.summary, {
    readings: 4,
    first_interval_start_utc: "2026-07-01T07:00:00.000Z",
    last_interval_end_utc: "2026-07-01T08:15:00.000Z",
    missing_intervals: 1,
  });
  assert.equal(meter.payload.timestamp_basis, "interval_start");
  assert.equal(meter.payload.timezone, "America/Los_Angeles");

  // CSV readings across the 2026-11-01 DST fall-back: offsets match the zone, no overlap.
  const csvMeter = all.inputs.find((input) => input.payload.meter_id === "mtr-4470")!;
  assert.deepEqual((csvMeter.payload.readings as any[]).map((reading) => reading.interval_start_utc), [
    "2026-11-01T07:00:00.000Z", "2026-11-01T08:00:00.000Z", "2026-11-01T09:00:00.000Z", "2026-11-01T10:00:00.000Z",
  ]);
  assert.equal(csvMeter.sources[1].role, "readings_csv");

  const quote = all.inputs.find((input) => input.kind === "quote")!;
  assert.equal(quote.payload.vendor, "Example Transformer Co.");
  assert.equal(quote.payload.currency, "USD");
  assert.deepEqual((quote.payload.lines as any[])[0].unit_price, { value: 2450000, unit: "$" });

  // Raw bytes are stored verbatim and content-addressed.
  const directory = resolve(stateRoot(), "operator", LOCATION);
  const raw = await readFile(resolve(directory, topology.sources[0].path));
  assert.deepEqual(raw, await fixture("topology.json"));
});

test("same bytes produce the same revision and do not rewrite the manifest", async (t) => {
  namespace(t);
  const envelope = await fixture("equipment-rating.json");
  const first = await importOperatorInput(envelope);
  const second = await importOperatorInput(envelope);
  assert.equal(second.revision, first.revision);
  assert.equal(second.manifest, first.manifest);
  assert.equal(second.created, false);
  const directory = resolve(stateRoot(), "operator", LOCATION);
  assert.equal((await readdir(resolve(directory, "inputs"))).length, 1);
  assert.equal((await readdir(resolve(directory, "manifests"))).length, 1);

  // A stored revision that was edited after the fact is refused on read.
  const path = resolve(directory, "inputs", `${first.revision}.json`);
  const record = JSON.parse(await readFile(path, "utf8"));
  record.payload.ratings.find((rating: any) => rating.apparent_power).apparent_power.value = 99;
  await writeFile(path, JSON.stringify(record));
  await assert.rejects(readOperatorInputs(LOCATION, { visibility: "private" }), /checksum mismatch/);
  await assert.rejects(importOperatorInput(envelope), /fails its checksum/);
});

test("tampered raw bytes are refused on read", async (t) => {
  namespace(t);
  const result = await importOperatorInput(await fixture("quote.json"));
  const directory = resolve(stateRoot(), "operator", LOCATION);
  await writeFile(resolve(directory, "raw", `${result.sources[0].sha256}.json`), "{}");
  await assert.rejects(readOperatorInputs(LOCATION, { visibility: "public" }), /fail their checksum/);
});

test("visibility filtering: private is never returned to a public or shared caller", async (t) => {
  namespace(t);
  for (const name of ["topology.json", "equipment-rating.json", "equipment-condition.json", "meter-series.json", "quote.json"]) {
    await importOperatorInput(await fixture(name));
  }
  const kinds = async (visibility: "public" | "shared" | "private") =>
    (await readOperatorInputs(LOCATION, { visibility }))!.inputs.map((input) => `${input.kind}:${input.visibility}`).sort();
  assert.deepEqual(await kinds("public"), ["equipment_condition:public", "quote:public"]);
  assert.deepEqual(await kinds("shared"), ["equipment_condition:public", "equipment_rating:shared", "quote:public"]);
  assert.deepEqual(await kinds("private"), [
    "equipment_condition:public", "equipment_rating:shared", "meter_series:private", "quote:public", "topology:private",
  ]);
  // Clearance is mandatory: no implicit default.
  await assert.rejects(readOperatorInputs(LOCATION, {} as never), /visibility/);
  await assert.rejects(readOperatorInputs(LOCATION, { visibility: "admin" as never }), /visibility/);

  // A manifest entry relabelled "public" cannot leak a private record: the record itself decides.
  const directory = resolve(stateRoot(), "operator", LOCATION);
  const pointer = JSON.parse(await readFile(resolve(directory, "latest.json"), "utf8"));
  const manifest = JSON.parse(await readFile(resolve(directory, "manifests", `${pointer.revision}.json`), "utf8"));
  for (const entry of manifest.inputs) entry.visibility = "public";
  const forged = digest(manifest);
  await writeFile(resolve(directory, "manifests", `${forged}.json`), JSON.stringify(manifest));
  const pinned = await readOperatorInputs(LOCATION, { visibility: "public", manifest: forged });
  assert.deepEqual(pinned!.inputs.map((input) => input.kind).sort(), ["equipment_condition", "quote"]);
});

test("operator inputs sit beside public assets and are never merged into them", async (t) => {
  namespace(t);
  await importOperatorInput(await fixture("equipment-condition.json"));
  const empty = await readOperatorSideBySide(LOCATION, { visibility: "public" });
  assert.equal(empty.public, null);
  assert.equal(empty.operator?.inputs.length, 1);

  // A loaded public inventory for the same location, written the way load-assets.ts writes it.
  const publicData = { schema: "mapergy.location-assets/1", location: LOCATION, datasets: [{ source: "hifld-substations", features: { type: "FeatureCollection", features: [] } }] };
  const publicRevision = digest(publicData);
  const assetsDirectory = resolve(stateRoot(), "loaded-assets", LOCATION);
  await atomicJson(resolve(assetsDirectory, `${publicRevision}.json`), publicData);
  await atomicJson(resolve(assetsDirectory, "latest.json"), { revision: publicRevision });
  const before = await readFile(resolve(assetsDirectory, `${publicRevision}.json`));

  const view = await readOperatorSideBySide(LOCATION, { visibility: "public" });
  assert.equal(view.public?.method, "public");
  assert.equal(view.public?.revision, publicRevision);
  assert.deepEqual(view.public?.data, publicData);
  assert.equal(view.operator?.method, "operator");
  assert.equal(view.operator?.inputs.length, 1);
  assert.equal(view.operator?.inputs[0].method, "operator");
  // The public revision on disk is byte-identical after the operator import and read.
  assert.deepEqual(await readFile(resolve(assetsDirectory, `${publicRevision}.json`)), before);
  assert.equal(JSON.stringify(view.public).includes("operator"), false);
  assert.equal(await readOperatorInputs("location-000000000000000000000000", { visibility: "private" }), null);
});

test("deterministic replay: raw bytes re-derive every revision; manifest is order-independent", async (t) => {
  namespace(t);
  const names = ["quote.json", "topology.json", "meter-series.json"];
  const forward = [];
  for (const name of names) forward.push(await importOperatorInput(await fixture(name)));
  const csv = await importOperatorInput(await fixture("meter-series-csv.json"), await fixture("meter-readings.csv"));
  for (const result of [...forward, csv]) {
    assert.deepEqual(await replayOperatorInput(LOCATION, result.revision), { revision: result.revision, replayed: true });
  }
  const manifestForward = (await readOperatorInputs(LOCATION, { visibility: "private" }))!.manifest;

  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const second = resolve(stateRoot());
  t.after(() => rm(second, { recursive: true, force: true }));
  await importOperatorInput(await fixture("meter-series-csv.json"), await fixture("meter-readings.csv"));
  const backward = [];
  for (const name of [...names].reverse()) backward.push(await importOperatorInput(await fixture(name)));
  assert.deepEqual(backward.map(({ revision }) => revision).reverse(), forward.map(({ revision }) => revision));
  assert.equal((await readOperatorInputs(LOCATION, { visibility: "private" }))!.manifest, manifestForward);
});

test("runOperatorImportCommand validates arguments and imports a file", async (t) => {
  namespace(t);
  await assert.rejects(runOperatorImportCommand([]), /Expected operator-import/);
  await assert.rejects(runOperatorImportCommand(["a", "b", "c"]), /Expected operator-import/);
  const result = await runOperatorImportCommand([resolve(FIXTURES, "quote.json")]);
  assert.equal(result.kind, "quote");
  assert.equal(result.visibility, "public");
});

test("rejects missing issuer, date, scope or visibility", async () => {
  const base = await json("equipment-rating.json");
  for (const field of ["issuer", "issued_at", "scope", "visibility", "effective"]) {
    const { [field]: _omitted, ...rest } = base;
    rejects(rest, new RegExp(`${field}: is required`));
  }
  rejects({ ...base, issuer: { name: "Dana" } }, /issuer\.organization: is required/);
  rejects({ ...base, issuer: { name: " ", organization: "X" } }, /issuer\.name: expected a non-empty string/);
  rejects({ ...base, scope: { assets: ["xfmr-sub-12-t1"] } }, /location_id or center \+ radius_miles is required/);
  rejects({ ...base, scope: { location_id: LOCATION, assets: [] } }, /scope\.assets: must not be empty/);
  rejects({ ...base, scope: { ...base.scope, center: [33.75, -117.99], radius_miles: 25 } }, /not both/);
  rejects({ ...base, visibility: "internal" }, /visibility: expected one of private, shared, public/);
  rejects({ ...base, kind: "tariff" }, /kind: expected one of/);
  rejects({ ...base, extra: true }, /envelope\.extra: unknown field/);
});

test("rejects unit-less and wrong-unit values", async () => {
  const rating = await json("equipment-rating.json");
  const bare = structuredClone(rating);
  bare.payload.ratings[0].apparent_power = 28;
  rejects(bare, /payload\.ratings\[0\]\.apparent_power: unit-less value/);
  const wrong = structuredClone(rating);
  wrong.payload.ratings[0].apparent_power = { value: 28, unit: "MW" };
  rejects(wrong, /apparent_power\.unit: expected unit "MVA"/);
  const none = structuredClone(rating);
  none.payload.ratings[2] = { asset_id: "br-f1-01", basis: "emergency" };
  rejects(none, /at least one of voltage, current, apparent_power, real_power, energy/);

  const topology = await json("topology.json");
  topology.payload.branches[0].length = "1.8 mi";
  rejects(topology, /branches\[0\]\.length: unit-less value/);

  const meter = await json("meter-series.json");
  meter.payload.unit = "kWh";
  rejects(meter, /quantity "energy" requires unit "MWh"/);
  const noUnit = await json("meter-series.json");
  delete noUnit.payload.unit;
  rejects(noUnit, /payload\.unit: is required/);
  const noInterval = await json("meter-series.json");
  delete noInterval.payload.interval_minutes;
  rejects(noInterval, /payload\.interval_minutes: is required/);
  const noZone = await json("meter-series.json");
  delete noZone.payload.timezone;
  rejects(noZone, /payload\.timezone: is required/);

  const csvEnvelope = await json("meter-series-csv.json");
  rejects(csvEnvelope, /header must be exactly "interval_start,MW"/, Buffer.from("interval_start,value\n2026-11-01T00:00:00-07:00,3.1\n"));

  const quote = await json("quote.json");
  quote.payload.lines[0].unit_price = 2450000;
  rejects(quote, /unit_price: unit-less value/);
  const euro = await json("quote.json");
  euro.payload.currency = "EUR";
  rejects(euro, /only "USD" is supported/);
  const noVendor = await json("quote.json");
  delete noVendor.payload.vendor;
  rejects(noVendor, /payload\.vendor: is required/);
  const expired = await json("quote.json");
  expired.payload.valid_until = "2026-10-01T00:00:00-07:00";
  rejects(expired, /valid_until: must be after issued_at/);
});

test("rejects overlapping meter intervals", async () => {
  const duplicate = await json("meter-series.json");
  duplicate.payload.readings.push({ interval_start: "2026-07-01T07:15:00Z", value: 0.1 });
  rejects(duplicate, /interval overlaps the interval starting 2026-07-01T00:15:00-07:00/);
  const partial = await json("meter-series.json");
  partial.payload.readings.push({ interval_start: "2026-07-01T00:20:00-07:00", value: 0.1 });
  rejects(partial, /interval overlaps/);
  const csvEnvelope = await json("meter-series-csv.json");
  rejects(csvEnvelope, /readings_csv:3: interval overlaps/,
    Buffer.from("interval_start,MW\n2026-11-01T00:00:00-07:00,3.1\n2026-11-01T00:30:00-07:00,3.0\n"));
});

test("rejects timestamps without an offset, impossible dates and offsets that contradict the zone", async () => {
  const base = await json("equipment-condition.json");
  rejects({ ...base, issued_at: "2026-10-03T08:00:00" }, /issued_at: timestamp must be ISO 8601 with an explicit offset/);
  rejects({ ...base, issued_at: "2026-10-03" }, /issued_at: timestamp must be ISO 8601/);
  rejects({ ...base, issued_at: "2026-02-30T08:00:00Z" }, /not a valid calendar time/);
  rejects({ ...base, effective: { start: "2026-10-03T00:00:00" } }, /effective\.start: timestamp must be ISO 8601/);
  rejects({ ...base, effective: { start: "2026-10-03T00:00:00Z", end: "2026-10-02T00:00:00Z" } }, /effective\.end: must be after/);
  const assessed = structuredClone(base);
  assessed.payload.assessments[0].assessed_at = "2026-09-20 14:00";
  rejects(assessed, /assessments\[0\]\.assessed_at: timestamp must be ISO 8601/);
  const future = structuredClone(base);
  future.payload.assessments[0].assessed_at = "2026-10-04T00:00:00Z";
  rejects(future, /assessed_at: is after issued_at/);

  const meter = await json("meter-series.json");
  meter.payload.readings[0].interval_start = "2026-07-01T00:00:00";
  rejects(meter, /readings\[0\]\.interval_start: timestamp must be ISO 8601/);
  const wrongOffset = await json("meter-series.json");
  wrongOffset.payload.readings[0].interval_start = "2026-07-01T00:00:00-08:00";
  rejects(wrongOffset, /offset -08:00 does not match America\/Los_Angeles/);
  const badZone = await json("meter-series.json");
  badZone.payload.timezone = "Pacific Time";
  rejects(badZone, /expected an IANA time zone/);
  const csvEnvelope = await json("meter-series-csv.json");
  rejects(csvEnvelope, /readings_csv:2\.interval_start: timestamp must be ISO 8601/,
    Buffer.from("interval_start,MW\n2026-11-01 00:00,3.1\n"));
});

test("rejects duplicate asset ids", async () => {
  const scope = await json("equipment-condition.json");
  scope.scope.assets.push("bess-yard-1");
  rejects(scope, /scope\.assets: duplicate asset id "bess-yard-1"/);
  const assessments = await json("equipment-condition.json");
  assessments.payload.assessments[1].asset_id = "xfmr-sub-12-t1";
  rejects(assessments, /payload\.assessments: duplicate asset id "xfmr-sub-12-t1"/);
  const topology = await json("topology.json");
  topology.payload.branches[1].id = "bus-f1-a";
  rejects(topology, /payload: duplicate asset id "bus-f1-a"/);
  const ratings = await json("equipment-rating.json");
  ratings.payload.ratings[1].basis = "nameplate";
  rejects(ratings, /duplicate asset id\/basis pair "xfmr-sub-12-t1\/nameplate"/);
  const unscoped = await json("equipment-rating.json");
  unscoped.payload.ratings[0].asset_id = "xfmr-elsewhere";
  rejects(unscoped, /asset "xfmr-elsewhere" is not listed in scope\.assets/);
  const lines = await json("quote.json");
  lines.payload.lines[1].line_id = "1";
  rejects(lines, /duplicate line id "1"/);
});

test("CSV is accepted only for meter_series and never alongside inline readings", async () => {
  const csv = await fixture("meter-readings.csv");
  rejects(await json("quote.json"), /CSV file is only accepted for meter_series/, csv);
  rejects(await json("meter-series.json"), /inline or as CSV, not both/, Buffer.from("interval_start,MWh\n2026-07-01T00:00:00-07:00,1\n"));
  rejects(await json("meter-series-csv.json"), /payload\.readings: is required/);
  rejects(await json("meter-series-csv.json"), /value is not a number/, Buffer.from("interval_start,MW\n2026-11-01T00:00:00-07:00,abc\n"));
});
