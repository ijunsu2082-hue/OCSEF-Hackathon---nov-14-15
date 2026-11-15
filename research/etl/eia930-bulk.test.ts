import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { backfillEia930, eia930BulkUrl, eia930UtcInstant, parseEia930Balance } from "./eia930-bulk";
import { locationQuery, stateRoot } from "./pipeline";
import { feedsFor } from "./sources";
import { parseSnapshot } from "../parsers";

const FIXTURES = "research/etl/fixtures/eia930";
const EXCERPT = `${FIXTURES}/EIA930_BALANCE_2026_Jul_Dec.excerpt.csv`;
// Recorded EIA API v2 response (DEMO_KEY, 2026-11-15T01:10Z) for CISO demand, frequency=hourly.
const API = `${FIXTURES}/api-region-data-CISO-D-2026-11-14T05-T09.json`;

function isolateState(t: TestContext): string {
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const root = stateRoot();
  t.after(async () => {
    delete process.env.ETL_STATE_NAMESPACE;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("bulk rows use UTC hour-ending time, match the respondent exactly and skip blank demand", async () => {
  const text = await readFile(EXCERPT, "utf8");
  const ciso = parseEia930Balance(text, "CISO");
  assert.equal(ciso.rows.length, 11);
  // The 12 newest CISO hours carry a forecast but no demand yet; they are skipped, not zero-filled.
  assert.equal(ciso.skipped_blank_demand, 12);
  assert.ok(ciso.rows.every(({ demand_mw }) => demand_mw > 0));
  assert.deepEqual(ciso.rows.at(-1), {
    period: "2026-11-14T08", interval_start: "2026-11-14T07:00:00.000Z", interval_end: "2026-11-14T08:00:00.000Z",
    demand_mw: 22227, demand_forecast_mw: 22233, net_generation_mw: 17457, total_interchange_mw: -5460, line: 12,
  });
  // 11/13/2026 4:00 PM Pacific ends at 11/14/2026 12:00 AM UTC: the local column is never used.
  assert.equal(ciso.rows[2].interval_end, "2026-11-14T00:00:00.000Z");
  assert.equal(ciso.rows[2].period, "2026-11-14T00");

  assert.deepEqual(parseEia930Balance(text, "CPLE").rows.map(({ period, demand_mw }) => [period, demand_mw]),
    [["2026-11-14T04", 6130], ["2026-11-14T05", 5848]]);
  assert.deepEqual(parseEia930Balance(text, "CPLW").rows.map(({ demand_mw }) => demand_mw), [644, 621]);
  // Exact match only: a prefix of a real code matches nothing.
  assert.equal(parseEia930Balance(text, "CPL").rows.length, 0);
  assert.throws(() => parseEia930Balance(text, "ciso"), /respondent code/);
});

test("bulk and API agree for the overlapping UTC hours (recorded comparison)", async () => {
  const bulk = parseEia930Balance(await readFile(EXCERPT, "utf8"), "CISO");
  const api = parseSnapshot(new Uint8Array(await readFile(API)), "json.eia-hourly").data as {
    response: { data: { period: string; value: number; respondent: string; type: string }[] };
  };
  const byPeriod = new Map(bulk.rows.map((row) => [row.period, row.demand_mw]));
  const overlap = api.response.data.filter(({ period }) => byPeriod.has(period));
  assert.deepEqual(overlap.map(({ period }) => period), ["2026-11-14T05", "2026-11-14T06", "2026-11-14T07", "2026-11-14T08"]);
  for (const { period, value, respondent, type } of overlap) {
    assert.equal(respondent, "CISO");
    assert.equal(type, "D");
    assert.equal(byPeriod.get(period), value, period);
  }
  // API period T09 is newer than the bulk file's last published demand hour.
  assert.ok(api.response.data.some(({ period }) => period === "2026-11-14T09"));
  assert.equal(byPeriod.has("2026-11-14T09"), false);

  // The API feed's observation time equals the bulk row's UTC end of hour.
  const feed = feedsFor(locationQuery(34, -118, 100, "CISO")).find(({ source }) => source.id === "eia-hourly-demand")!;
  const latest = { response: { data: [api.response.data.find(({ period }) => period === "2026-11-14T08")!] } };
  assert.deepEqual(feed.observationTime!(latest), { timestamp: bulk.rows.at(-1)!.interval_end, basis: "utc" });
});

test("times, headers, values and duplicates fail closed", async () => {
  assert.equal(new Date(eia930UtcInstant("11/14/2026 12:00:00 AM")).toISOString(), "2026-11-14T00:00:00.000Z");
  assert.equal(new Date(eia930UtcInstant("11/14/2026 12:00:00 PM")).toISOString(), "2026-11-14T12:00:00.000Z");
  assert.equal(new Date(eia930UtcInstant("11/14/2026 1:00:00 PM")).toISOString(), "2026-11-14T13:00:00.000Z");
  for (const bad of ["11/14/2026 13:00:00 PM", "11/14/2026 0:00:00 AM", "02/30/2026 1:00:00 AM", "11/14/2026 1:30:00 AM", "2026-11-14T01:00Z"]) {
    assert.throws(() => eia930UtcInstant(bad), /Unexpected EIA-930 UTC time/, bad);
  }
  const header = '"Balancing Authority","UTC Time at End of Hour","Demand (MW)"';
  assert.throws(() => parseEia930Balance('"Balancing Authority","Local Time at End of Hour","Demand (MW)"\n', "CISO"),
    /missing UTC Time at End of Hour/);
  assert.throws(() => parseEia930Balance(`${header}\nCISO,11/14/2026 1:00:00 AM,1,234\n`, "CISO"), /wrong number of columns/);
  assert.throws(() => parseEia930Balance(`${header}\nCISO,11/14/2026 1:00:00 AM,"1,234"\n`, "CISO"), /Demand \(MW\) is not a number/);
  assert.throws(() => parseEia930Balance(`${header}\nCISO,11/14/2026 1:00:00 AM,5\nCISO,11/14/2026 1:00:00 AM,6\n`, "CISO"),
    /duplicate hour/);
  assert.deepEqual(parseEia930Balance(`${header}\r\n"CISO","11/14/2026 1:00:00 AM","5"\r\n`, "CISO").rows.map(({ demand_mw }) => demand_mw), [5]);
});

test("six-month file URL follows the UTC half-year", () => {
  assert.equal(eia930BulkUrl(new Date("2026-11-14T00:00:00Z")).href,
    "https://www.eia.gov/electricity/gridmonitor/sixMonthFiles/EIA930_BALANCE_2026_Jul_Dec.csv");
  assert.equal(eia930BulkUrl(new Date("2026-06-30T23:59:59Z")).href,
    "https://www.eia.gov/electricity/gridmonitor/sixMonthFiles/EIA930_BALANCE_2026_Jan_Jun.csv");
});

test("backfill stores the file, writes an archive and quarantines a file without the respondent", async (t) => {
  const root = isolateState(t);
  const result = await backfillEia930(EXCERPT, "CISO", { retrievedAt: "2026-11-15T01:09:51Z" });
  assert.equal(result.rows, 11);
  assert.equal(result.skipped_blank_demand, 12);
  assert.deepEqual([result.first, result.last], ["2026-11-13T22", "2026-11-14T08"]);
  const archive = JSON.parse(await readFile(result.path, "utf8"));
  assert.equal(archive.schema, "mapergy.eia930-bulk/1");
  assert.equal(archive.basis, "utc_hour_ending");
  assert.equal(archive.snapshot.parser, "text.lines");
  assert.equal(archive.snapshot.record_count, 29);

  await assert.rejects(backfillEia930(EXCERPT, "ERCO"), /no published demand for ERCO/);
  assert.equal((await readdir(`${root}/quarantine`)).length, 1);
});
