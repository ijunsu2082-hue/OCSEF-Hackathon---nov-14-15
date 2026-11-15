import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import {
  CAISO_DEMAND_URL, CAISO_SUPPLY_URL, MIN_SUPPLY_COLUMNS, caisoFeeds, caisoHeaderAudit, pacificInstant, parseCsv,
} from "./caiso";
import { locationQuery, runLocation, stateRoot, verifyLocation } from "./pipeline";
import { verifyEvidenceFiles } from "../verify-files";
import { parseSnapshot } from "../parsers";
import { resetHttpState } from "./http";
import { PREDICATES } from "../../lib/evidence/predicates";
import type { Metric } from "./sources";

const FIXTURES = "research/etl/fixtures/caiso";
const SUPPLY_HEADER = "Time,Solar,Wind,Geothermal,Biomass,Biogas,Small hydro,Coal,Nuclear,Natural Gas,Large Hydro,Batteries,Imports,Other";
const [demandFeed, supplyFeed] = caisoFeeds();

function values(metrics: Metric[]): Record<string, string | number> {
  return Object.fromEntries(metrics.map(({ predicate, value }) => [predicate, value]));
}

test("real CAISO fixtures map every published value column to a registered predicate", async () => {
  const demand = await readFile(`${FIXTURES}/demand.csv`, "utf8");
  const supply = await readFile(`${FIXTURES}/fuelsource.csv`, "utf8");

  // demand.csv runs to the next midnight with forecast-only rows; the newest
  // published telemetry is 16:55, not the trailing 00:00 row.
  const demandMetrics = demandFeed.extract(demand);
  assert.deepEqual(values(demandMetrics), { "telemetry.period": "16:55", "caiso.system_demand_mw": 24031 });
  assert.deepEqual(demandMetrics.map(({ locator }) => locator), ["/rows/203/0", "/rows/203/3"]);
  assert.deepEqual(caisoHeaderAudit(demand, "demand"), {
    recognized: ["Day ahead forecast", "Hour ahead forecast", "Current demand", "Demand response"],
    unknown: [],
    // Net demand is not published in demand.csv, is not mapped, and is never fabricated.
    missing: [],
  });
  assert.equal(values(demandMetrics)["caiso.system_net_demand_mw"], undefined);

  const supplyMetrics = supplyFeed.extract(supply);
  assert.deepEqual(values(supplyMetrics), {
    "telemetry.period": "16:55",
    "caiso.supply_solar_mw": 61,
    "caiso.supply_wind_mw": 4103,
    "caiso.supply_geothermal_mw": 735,
    "caiso.supply_biomass_mw": 171,
    "caiso.supply_biogas_mw": 144,
    "caiso.supply_small_hydro_mw": 102,
    "caiso.supply_coal_mw": 0,
    "caiso.supply_nuclear_mw": 2199,
    "caiso.supply_natural_gas_mw": 6227,
    "caiso.supply_large_hydro_mw": 1605,
    "caiso.supply_batteries_mw": 6746,
    "caiso.supply_imports_mw": 1723,
    "caiso.supply_other_mw": 0,
  });
  const supplyAudit = caisoHeaderAudit(supply, "supply");
  assert.deepEqual(supplyAudit.unknown, []);
  assert.deepEqual(supplyAudit.missing, ["Renewables"]);
  assert.equal(supplyAudit.recognized.length, 13);

  for (const { predicate } of [...demandMetrics, ...supplyMetrics]) {
    assert.ok(PREDICATES[predicate], `${predicate} is registered`);
  }
  // Each header column in the live files is either Time or accounted for.
  for (const [text, kind] of [[demand, "demand"], [supply, "supply"]] as const) {
    const { header } = parseCsv(text);
    const audit = caisoHeaderAudit(text, kind);
    assert.deepEqual(header.filter((name) => name !== "Time"), audit.recognized);
  }

  const retrievedAt = "2026-11-15T01:03:29Z";
  for (const [feed, text] of [[demandFeed, demand], [supplyFeed, supply]] as const) {
    assert.deepEqual(feed.observationTime!(text, retrievedAt), { timestamp: "2026-11-15T00:55:00.000Z", basis: "utc" });
  }
});

test("negative published values survive extraction", async () => {
  const supply = await readFile(`${FIXTURES}/fuelsource.csv`, "utf8");
  // The live file's first interval has negative solar.
  const firstRowOnly = supply.split("\n").slice(0, 2).join("\n");
  assert.equal(values(supplyFeed.extract(firstRowOnly))["caiso.supply_solar_mw"], -58);
  const charging = `${SUPPLY_HEADER}\n19:00,-12,4000,735,170,140,100,0,2199,9000,1600,-1250,-340,0\n`;
  const result = values(supplyFeed.extract(charging));
  assert.equal(result["caiso.supply_solar_mw"], -12);
  assert.equal(result["caiso.supply_batteries_mw"], -1250);
  assert.equal(result["caiso.supply_imports_mw"], -340);
});

test("parseCsv accepts the RFC 4180 subset and rejects malformed quoting", () => {
  const table = parseCsv('Time,"Current demand","Note"\r\n"16:55","24,031","said ""hi"", twice"\r\n\r\n17:00,,""');
  assert.deepEqual(table.header, ["Time", "Current demand", "Note"]);
  assert.deepEqual(table.rows, [["16:55", "24,031", 'said "hi", twice'], ["17:00", "", ""]]);
  // A thousands separator is not a number under the snapshot parser's strict cell
  // rule, so no claim could cite it; the capture is rejected rather than skipped.
  assert.throws(() => demandFeed.extract('Time,"Current demand"\n"16:55","24,031"\n'), /non-numeric Current demand "24,031"/);
  assert.deepEqual(values(demandFeed.extract('Time,"Current demand"\n"16:55","24031"\n')),
    { "telemetry.period": "16:55", "caiso.system_demand_mw": 24031 });

  assert.throws(() => parseCsv('Time,Value\n00:00,"open\n'), /Unterminated CSV field/);
  assert.throws(() => parseCsv('Time,Value\n00:00,ab"c\n'), /bare quote/);
  assert.throws(() => parseCsv('Time,Value\n00:00,"ab"c\n'), /after a closing quote/);
  assert.throws(() => parseCsv("Time,Time\n00:00,1\n"), /duplicate column names/);
  assert.throws(() => parseCsv("Time,\n00:00,1\n"), /empty column name/);
});

test("csv.table types cells by a strict rule so locators resolve to claimed values", () => {
  const { data, recordCount } = parseSnapshot(new TextEncoder().encode(
    'Time,A,B,C,D,E,F,G\n16:55,24031,-58,0.5,"24,031",+5,1e3,\n 07 , ,abc,-0,12.,007,1234567890123456,x\n'), "csv.table");
  assert.equal(recordCount, 2);
  assert.deepEqual(data, {
    header: ["Time", "A", "B", "C", "D", "E", "F", "G"],
    rows: [["16:55", 24031, -58, 0.5, "24,031", "+5", "1e3", null], [7, null, "abc", -0, "12.", 7, "1234567890123456", "x"]],
  });
  assert.throws(() => parseSnapshot(new Uint8Array([0xff, 0xfe]), "csv.table"));
});

test("ragged rows and missing required columns fail closed", () => {
  assert.throws(() => demandFeed.extract("Time,Current demand\n00:00,21000\n00:05\n"), /wrong number of columns/);
  assert.throws(() => supplyFeed.extract(`${SUPPLY_HEADER}\n00:00,1,2,3\n`), /wrong number of columns/);

  assert.throws(() => demandFeed.extract("Interval,Current demand\n00:00,21000\n"), /no Time column.*Unrecognized headers: Interval/);
  assert.throws(() => supplyFeed.extract(`${SUPPLY_HEADER.replace("Time", "Hour")}\n${"00:00,1,1,1,1,1,1,1,1,1,1,1,1,1"}\n`),
    /supply CSV has no Time column/);
  assert.throws(() => demandFeed.extract("Time,Demand\n00:00,21000\n"), /no "Current demand" column.*Unrecognized headers: Demand/);
  assert.throws(() => demandFeed.observationTime!("Time,Demand\n00:00,21000\n", "2026-11-15T01:00:00Z"), /Current demand/);
});

test("supply header drift fails below the threshold and is reported above it", () => {
  const row = "16:55,61,4103,735,171,144,102,0,2199,6227,1605,6746,1723,0";
  assert.equal(MIN_SUPPLY_COLUMNS, 10);

  const drifted = SUPPLY_HEADER.replace("Natural Gas", "Gas").replace("Large Hydro", "Hydro")
    .replace("Small hydro", "Small Hydro").replace("Batteries", "Storage");
  assert.throws(() => supplyFeed.extract(`${drifted}\n${row}\n`), (error: Error) => {
    assert.match(error.message, /recognizes 9 resource columns; at least 10 are required/);
    assert.match(error.message, /Missing: Renewables, Small hydro, Natural Gas, Large Hydro, Batteries/);
    assert.match(error.message, /Unrecognized headers: Small Hydro, Gas, Hydro, Storage/);
    return true;
  });

  // One rename stays above the threshold but is a rename signature (a published
  // column missing next to an unknown one), so it fails closed naming both.
  const renamed = `${SUPPLY_HEADER.replace("Natural Gas", "Gas")}\n${row}\n`;
  assert.throws(() => supplyFeed.extract(renamed),
    /looks renamed: published column\(s\) Natural Gas missing while unrecognized header\(s\) Gas are present/);
  assert.throws(() => supplyFeed.observationTime!(renamed, "2026-11-15T01:03:00Z"), /looks renamed/);
  assert.deepEqual(caisoHeaderAudit(renamed, "supply").unknown, ["Gas"]);
  assert.ok(caisoHeaderAudit(renamed, "supply").missing.includes("Natural Gas"));

  // A dropped column with no unknown header (CAISO stopped publishing it) is
  // tolerated above the threshold and simply stays unreported.
  const columns = SUPPLY_HEADER.split(",");
  const coal = columns.indexOf("Coal");
  const dropped = [columns, row.split(",")].map((cells) => cells.filter((_, index) => index !== coal).join(",")).join("\n");
  const kept = values(supplyFeed.extract(`${dropped}\n`));
  assert.equal(kept["caiso.supply_coal_mw"], undefined);
  assert.equal(kept["caiso.supply_natural_gas_mw"], 6227);
  assert.equal(Object.keys(kept).length, 13);

  // A single added column is reported and does not disturb the known series.
  const extra = `${SUPPLY_HEADER},Hydrogen\n${row},12\n`;
  assert.equal(Object.keys(values(supplyFeed.extract(extra))).length, 14);
  assert.deepEqual(caisoHeaderAudit(extra, "supply").unknown, ["Hydrogen"]);
});

test("partially empty trailing rows resolve to the last published interval", () => {
  const supply = [
    SUPPLY_HEADER,
    "16:50,136,4036,735,171,143,102,0,2199,6160,1609,6791,1643,0",
    "16:55,61,4103,735,171,144,102,0,2199,6227,1605,6746,1723,0",
    "17:00,40,4100,,,,,,,,,,,",
    "17:05,,,,,,,,,,,,,",
  ].join("\n");
  const metrics = supplyFeed.extract(supply);
  assert.equal(values(metrics)["telemetry.period"], "16:55");
  assert.equal(values(metrics)["caiso.supply_natural_gas_mw"], 6227);
  assert.ok(metrics.every(({ locator }) => locator.startsWith("/rows/1/")));
  assert.equal(supplyFeed.observationTime!(supply, "2026-11-15T01:03:00Z")!.timestamp, "2026-11-15T00:55:00.000Z");

  const demand = "Time,Day ahead forecast,Hour ahead forecast,Current demand,Demand response\n" +
    "16:55,22686,23925,24031,\n17:00,22686,23925,,\n00:00,20851,20614,,\n";
  assert.deepEqual(values(demandFeed.extract(demand)), { "telemetry.period": "16:55", "caiso.system_demand_mw": 24031 });

  // No published interval at all yields no observations, which capture quarantines.
  assert.deepEqual(demandFeed.extract("Time,Current demand\n00:00,\n"), []);
  assert.equal(demandFeed.observationTime!("Time,Current demand\n00:00,\n", "2026-11-15T01:00:00Z"), null);
});

test("pacificInstant resolves offsets from zone data across DST transitions", () => {
  assert.equal(pacificInstant("2026-11-14", "16:55"), "2026-11-15T00:55:00.000Z");
  assert.equal(pacificInstant("2026-07-01", "12:00"), "2026-07-01T19:00:00.000Z");
  // Spring forward 2026-03-08: 02:00-02:59 does not exist in Pacific time.
  assert.throws(() => pacificInstant("2026-03-08", "02:30"), /Unresolvable Pacific wall time/);
  // Valid times after the transition resolve with the new offset (these threw before the candidate search).
  assert.equal(pacificInstant("2026-03-08", "03:00"), "2026-03-08T10:00:00.000Z");
  assert.equal(pacificInstant("2026-03-08", "08:30"), "2026-03-08T15:30:00.000Z");
  assert.equal(pacificInstant("2026-03-08", "01:55"), "2026-03-08T09:55:00.000Z");
  // Fall back 2026-11-01: 01:30 occurs twice; it resolves to the first (PDT) occurrence, every time.
  assert.equal(pacificInstant("2026-11-01", "01:30"), "2026-11-01T08:30:00.000Z");
  assert.equal(pacificInstant("2026-11-01", "01:30"), pacificInstant("2026-11-01", "01:30"));
  assert.equal(pacificInstant("2026-11-01", "00:55"), "2026-11-01T07:55:00.000Z");
  assert.equal(pacificInstant("2026-11-01", "02:00"), "2026-11-01T10:00:00.000Z");
  assert.equal(pacificInstant("2026-11-01", "08:00"), "2026-11-01T16:00:00.000Z");
  assert.throws(() => pacificInstant("2026-11-01", "1:30"), /Expected YYYY-MM-DD and HH:MM/);
  assert.throws(() => pacificInstant("2026-11-01", "25:00"), /Invalid operating interval/);
});

test("observationTime keeps the previous operating date across Pacific midnight", () => {
  const text = "Time,Current demand\n23:50,21000\n23:55,20900\n";
  // 2026-11-15T08:02Z is 00:02 PST on 2026-11-15; the 23:55 row belongs to 2026-11-14.
  assert.deepEqual(demandFeed.observationTime!(text, "2026-11-15T08:02:00Z"),
    { timestamp: "2026-11-15T07:55:00.000Z", basis: "utc" });
  // Later the same evening the row belongs to the retrieval date.
  assert.equal(demandFeed.observationTime!(text, "2026-11-15T07:58:00Z")!.timestamp, "2026-11-15T07:55:00.000Z");
  // A new-day file whose newest row is 00:00 keeps the retrieval date.
  assert.equal(demandFeed.observationTime!("Time,Current demand\n00:00,20000\n", "2026-11-15T08:02:00Z")!.timestamp,
    "2026-11-15T08:00:00.000Z");
  assert.equal(demandFeed.observationTime!(text), null);
  assert.equal(demandFeed.observationTime!(text, "not a date"), null);
});

/** Mocks every upstream the location pipeline calls; CAISO bodies come from `caiso`. */
function mockUpstreams(t: TestContext, caiso: { demand: string; supply: string }) {
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    switch (url.hostname) {
      case "www.caiso.com":
        if (url.href === CAISO_DEMAND_URL) return new Response(caiso.demand, { headers: { "content-type": "text/csv" } });
        if (url.href === CAISO_SUPPLY_URL) return new Response(caiso.supply, { headers: { "content-type": "text/csv" } });
        throw new Error(`Unexpected CAISO URL ${url}`);
      case "geocoding.geo.census.gov":
        return Response.json({ result: { geographies: {
          States: [{ GEOID: "06" }], Counties: [{ GEOID: "06037", NAME: "Los Angeles County" }],
        } } });
      case "services.arcgis.com":
      case "services1.arcgis.com":
        return Response.json({ count: 42 });
      case "api.weather.gov":
        if (url.pathname === "/alerts/active") return Response.json({ features: [] });
        if (url.pathname.startsWith("/points/")) return Response.json({
          properties: { observationStations: "https://api.weather.gov/gridpoints/LOX/1,2/stations" },
        });
        if (url.pathname.endsWith("/stations")) return Response.json({
          features: [{ id: "https://api.weather.gov/stations/KLAX" }],
        });
        return Response.json({ properties: {
          timestamp: "2026-11-15T00:53:00Z", temperature: { unitCode: "wmoUnit:degC", value: 20 },
        } });
      default:
        throw new Error(`Unexpected source ${url}`);
    }
  });
}

function isolateState(t: TestContext): string {
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const root = stateRoot();
  resetHttpState();
  t.after(async () => {
    delete process.env.ETL_STATE_NAMESPACE;
    resetHttpState();
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

const DRIFTED_SUPPLY_HEADER = SUPPLY_HEADER.replace("Natural Gas", "Gas").replace("Large Hydro", "Hydro")
  .replace("Small hydro", "Small Hydro").replace("Batteries", "Storage");
const query = locationQuery(34.0522, -118.2437, 100, undefined, true);
const capturedAt = new Date("2026-11-15T01:03:29Z");

test("pipeline capture quarantines CAISO files whose headers fail closed", async (t) => {
  const root = isolateState(t);
  const supply = (await readFile(`${FIXTURES}/fuelsource.csv`, "utf8")).replace(SUPPLY_HEADER, DRIFTED_SUPPLY_HEADER);
  const demand = (await readFile(`${FIXTURES}/demand.csv`, "utf8")).replace("Current demand", "Actual demand");
  mockUpstreams(t, { demand, supply });

  const report = await runLocation(query, true, capturedAt);
  assert.equal(report.evidence.verification.ok, true);
  assert.equal(report.feeds["caiso-supply-5min"].status, "unavailable");
  assert.match(report.feeds["caiso-supply-5min"].issue ?? "", /recognizes 9 resource columns; at least 10 are required/);
  assert.equal(report.feeds["caiso-demand-5min"].status, "unavailable");
  assert.match(report.feeds["caiso-demand-5min"].issue ?? "", /no "Current demand" column.*Unrecognized headers: Actual demand/);
  assert.equal(report.evidence.claims.filter((claim) => claim.predicate.startsWith("caiso.")).length, 0);

  const quarantined = await Promise.all((await readdir(`${root}/quarantine`))
    .map(async (name) => JSON.parse(await readFile(`${root}/quarantine/${name}`, "utf8"))));
  assert.deepEqual(quarantined.map(({ source }) => source).sort(), ["caiso-demand-5min", "caiso-supply-5min"]);
  assert.ok(quarantined.some(({ source, issue }) =>
    source === "caiso-supply-5min" && /Unrecognized headers: Small Hydro, Gas, Hydro, Storage/.test(issue)));
});

// The `csv.table` parser types cells, so `/rows/<i>/<j>` locators resolve to the
// cited numbers during evidence-file verification and replay.
test("pipeline capture cites CAISO fixture values", async (t) => {
  isolateState(t);
  mockUpstreams(t, {
    demand: await readFile(`${FIXTURES}/demand.csv`, "utf8"),
    supply: await readFile(`${FIXTURES}/fuelsource.csv`, "utf8"),
  });
  const captured = await runLocation(query, true, capturedAt);
  assert.equal(captured.evidence.verification.ok, true);
  for (const source of ["caiso-demand-5min", "caiso-supply-5min"]) {
    assert.equal(captured.feeds[source].status, "fresh");
    assert.equal(captured.feeds[source].observation_at, "2026-11-15T00:55:00.000Z");
  }
  const cited = (predicate: string) => captured.evidence.claims.find((claim) => claim.predicate === predicate);
  assert.equal(cited("caiso.system_demand_mw")?.value, 24031);
  assert.equal(cited("caiso.supply_large_hydro_mw")?.value, 1605);
  assert.equal(cited("caiso.system_net_demand_mw"), undefined);
  assert.equal(cited("caiso.system_demand_mw")?.locator, "/rows/203/3");
  assert.deepEqual(captured.evidence.snapshots.filter(({ source_id }) => source_id.startsWith("caiso-"))
    .map(({ parser }) => parser), ["csv.table", "csv.table"]);
  const files = await verifyEvidenceFiles(captured.evidence);
  assert.deepEqual(files.issues, []);
  assert.ok(files.checkedLocators >= 16);
  // Offline replay from the stored blob bytes rebuilds the identical bundle.
  await verifyLocation(captured);
});

test("the supply row reported is the newest with every present resource column numeric", async () => {
  const supply = await readFile(`${FIXTURES}/fuelsource.csv`, "utf8");
  // Three blank resource cells in the newest row (about 8.5 GW) must not publish a partial mix.
  const partial = supply.replace("16:55,61,4103,735,171,144,102,0,2199,6227,1605,6746,1723,0",
    "16:55,61,4103,735,171,144,102,0,2199,6227,1605,,,");
  const metrics = values(supplyFeed.extract(partial));
  assert.equal(metrics["telemetry.period"], "16:50");
  assert.equal(Object.keys(metrics).length, 14);
  assert.equal(metrics["caiso.supply_batteries_mw"], 6791);
  assert.equal(supplyFeed.observationTime!(partial, "2026-11-15T01:03:29Z")!.timestamp, "2026-11-15T00:50:00.000Z");
  // No row with the full mix: fail closed (capture quarantines an empty extraction).
  const none = `${SUPPLY_HEADER}\n16:50,136,4036,735,171,143,102,0,2199,6160,1609,6791,1643,\n16:55,61,4103,735,171,144,102,0,2199,6227,1605,,,\n`;
  assert.deepEqual(supplyFeed.extract(none), []);
  assert.equal(supplyFeed.observationTime!(none, "2026-11-15T01:03:29Z"), null);
});

test("a non-numeric newest value cell is quarantined, not skipped for an older row", async () => {
  const demand = await readFile(`${FIXTURES}/demand.csv`, "utf8");
  const separated = demand.replace("16:55,22686,23925,24031,", '16:55,22686,23925,"24,031",');
  assert.throws(() => demandFeed.extract(separated), /non-numeric Current demand "24,031" at 16:55/);
  assert.throws(() => demandFeed.observationTime!(separated, "2026-11-15T01:03:29Z"), /non-numeric/);
  const supply = await readFile(`${FIXTURES}/fuelsource.csv`, "utf8");
  const unit = supply.replace("16:55,61,4103,", "16:55,61,4103 MW,");
  assert.throws(() => supplyFeed.extract(unit), /non-numeric Wind "4103 MW" at 16:55/);
  // A non-numeric cell in an older row than the one reported is not examined.
  const older = demand.replace("16:50,22686,23925,23887,", '16:50,22686,23925,"23,887",');
  assert.equal(values(demandFeed.extract(older))["caiso.system_demand_mw"], 24031);
});

test("Net demand is never mapped from demand.csv", () => {
  const text = "Time,Current demand,Net demand\n16:55,24031,18000\n";
  assert.deepEqual(values(demandFeed.extract(text)), { "telemetry.period": "16:55", "caiso.system_demand_mw": 24031 });
  assert.deepEqual(caisoHeaderAudit(text, "demand"), { recognized: ["Current demand"], unknown: ["Net demand"], missing: [] });
});

test("a label up to 10 minutes after the capture instant stays on the capture's Pacific day", () => {
  const text = "Time,Current demand\n16:50,23887\n16:55,24031\n";
  // 2026-11-15T00:45:00Z is 16:45:00 PST on 2026-11-14: the 16:55 label is exactly 10 minutes ahead.
  assert.equal(demandFeed.observationTime!(text, "2026-11-15T00:45:00Z")!.timestamp, "2026-11-15T00:55:00.000Z");
  assert.equal(demandFeed.observationTime!(text, "2026-11-15T00:54:59Z")!.timestamp, "2026-11-15T00:55:00.000Z");
  // One second beyond the tolerance it is read as the previous operating day.
  assert.equal(demandFeed.observationTime!(text, "2026-11-15T00:44:59Z")!.timestamp, "2026-11-14T00:55:00.000Z");
  // Midnight rollover is unchanged: shortly after Pacific midnight the 23:55 row is yesterday's.
  const late = "Time,Current demand\n23:55,20900\n";
  assert.equal(demandFeed.observationTime!(late, "2026-11-15T08:02:00Z")!.timestamp, "2026-11-15T07:55:00.000Z");
});
