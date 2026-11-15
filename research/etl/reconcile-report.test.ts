import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { canonicalJson, digest } from "../../lib/evidence/canonical";
import { CAISO_DEMAND_URL, CAISO_SUPPLY_URL, parseCsv } from "./caiso";
import { resetHttpState } from "./http";
import { locationId, locationQuery, reportRevision, runLocation, stateRoot, type LocationReport } from "./pipeline";
import { getPolicy, POLICIES_VERSION, RECONCILE_POLICIES } from "./reconcile-policies";
import { evaluatePolicy, readReconciliation, reconcileReport, RECONCILIATION_SCHEMA } from "./reconcile-report";

const FIXTURES = "research/etl/fixtures/caiso";
const capturedAt = new Date("2026-11-15T01:03:29Z");
/** Center and radius of the shipped westminster-100mi bundle, so bundled OSM and EIA-860 counts apply. */
const WESTMINSTER: [number, number, number] = [33.7538, -118.0111, 100];

function isolateState(t: TestContext): string {
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const root = stateRoot();
  resetHttpState();
  const originalKey = process.env.EIA_API_KEY;
  process.env.EIA_API_KEY = "fixture-secret";
  t.after(async () => {
    delete process.env.ETL_STATE_NAMESPACE;
    if (originalKey === undefined) delete process.env.EIA_API_KEY;
    else process.env.EIA_API_KEY = originalKey;
    resetHttpState();
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

/**
 * EIA periods are UTC hour-ending (sources.ts), so the default period 2026-11-15T00 covers
 * 23:00-24:00Z on 2026-11-14, i.e. the fixture's 15:00-15:55 PST rows.
 */
async function mockUpstreams(t: TestContext, eiaDemand = "20900", period = "2026-11-15T00") {
  const demand = await readFile(`${FIXTURES}/demand.csv`, "utf8");
  const supply = await readFile(`${FIXTURES}/fuelsource.csv`, "utf8");
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    switch (url.hostname) {
      case "www.caiso.com":
        if (url.href === CAISO_DEMAND_URL) return new Response(demand, { headers: { "content-type": "text/csv" } });
        if (url.href === CAISO_SUPPLY_URL) return new Response(supply, { headers: { "content-type": "text/csv" } });
        throw new Error(`Unexpected CAISO URL ${url}`);
      case "geocoding.geo.census.gov":
        return Response.json({ result: { geographies: {
          States: [{ GEOID: "06" }], Counties: [{ GEOID: "06059", NAME: "Orange County" }],
        } } });
      case "services.arcgis.com":
      case "services1.arcgis.com":
        if (url.pathname.includes("/Substations/")) return Response.json({ count: 42 });
        if (url.pathname.includes("/Power_Plants/")) return Response.json({ count: 7 });
        return Response.json({ count: 3 });
      case "api.eia.gov": {
        const fuel = url.pathname.includes("fuel-type");
        return Response.json({ response: { data: [{
          period, respondent: "CISO", value: fuel ? "900" : eiaDemand,
          "value-units": "megawatthours", ...(fuel ? { fueltype: "SUN" } : { type: "D" }),
        }] } });
      }
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

async function westminsterReport(t: TestContext, eiaDemand?: string, period?: string): Promise<LocationReport> {
  await mockUpstreams(t, eiaDemand, period);
  const [lat, lon, radius] = WESTMINSTER;
  return runLocation(locationQuery(lat, lon, radius, "CISO", true), true, capturedAt);
}

test("reconcileReport persists every policy's outcome, idempotently, and rejects tampering", async (t) => {
  const root = isolateState(t);
  const report = await westminsterReport(t);
  const id = report.evidence.region.id;
  const revision = reportRevision(report);
  const record = await reconcileReport(id, revision);
  assert.ok(record);
  assert.equal(record.schema, RECONCILIATION_SCHEMA);
  assert.equal(record.report_revision, revision);
  assert.equal(record.policies_version, POLICIES_VERSION);
  assert.deepEqual(record.comparisons.map(({ policy }) => policy), RECONCILE_POLICIES.map(({ id: policy }) => policy));

  // The saved key binds the policy registry version, so a policy change yields a new record.
  const path = resolve(root, "reconciliations", id, `${revision}.${POLICIES_VERSION.slice(0, 12)}.json`);
  const bytes = await readFile(path, "utf8");
  assert.equal(bytes, canonicalJson(record) + "\n");
  assert.deepEqual(await readReconciliation(id, revision), record);

  const byPolicy = Object.fromEntries(record.comparisons.map((comparison) => [comparison.policy, comparison]));
  assert.deepEqual(record.comparisons.map(({ status }) => status),
    ["incomparable", "incomparable", "agreement", "incomparable"]);
  for (const comparison of record.comparisons.filter(({ status }) => status === "incomparable")) {
    assert.equal(comparison.selected, null);
    assert.equal(comparison.independent, false);
    assert.ok(comparison.reason && comparison.reason.length > 0, comparison.policy);
  }
  // (a) Point-layer HIFLD counts carry no known defect (the radius-unit defect was transmission-only);
  // the pair is incomparable on definitions (basis), and both counts are kept.
  const substations = byPolicy["substation-count.hifld-vs-osm-bundle"];
  assert.match(substations.reason!, /^scope differs in basis \(/);
  assert.doesNotMatch(substations.reason!, /known defect/);
  assert.equal(substations.right.issue, null);
  assert.equal(substations.left.observation?.value, 42, "incomparable values are still shown");
  assert.equal(substations.right.observation?.value, 1271);
  assert.equal(substations.selected, null);
  const hifldClaim = report.evidence.claims.find((claim) => claim.source_id === "hifld-substations")!;
  assert.deepEqual(substations.left.claim_ids, [hifldClaim.id]);
  // (b) Both counts exist; definitions differ, so the scope reason names the basis and both values are kept.
  const plants = byPolicy["plant-count.eia-atlas-vs-eia860-bundle"];
  assert.match(plants.reason!, /^scope differs in basis \(/);
  assert.equal(plants.left.observation?.value, 7);
  assert.equal(plants.right.observation?.value, 697);
  assert.equal(plants.right.observation?.source, "gs-layer-plants");
  assert.equal(plants.left.observation?.scope.start, plants.right.observation?.scope.start, "as-of window is shared");
  // (c) EIA hour ending 00:00Z vs the mean of CAISO's twelve 15:00-15:55 PST values: exact agreement.
  const demand = byPolicy["ba-demand.eia930-ciso-vs-caiso-5min"];
  assert.equal(demand.left.observation?.value, 20900);
  assert.equal(demand.right.observation?.value, await fixtureHourMean("15"));
  assert.equal(demand.left.observation?.scope.start, "2026-11-14T23:00:00.000Z");
  assert.equal(demand.right.observation?.scope.end, "2026-11-15T00:00:00.000Z");
  assert.equal(demand.selected, "left");
  assert.equal(demand.independent, true);
  assert.equal(demand.reason, null);
  const eiaClaim = report.evidence.claims.find((claim) =>
    claim.source_id === "eia-hourly-demand" && claim.predicate === "telemetry.demand")!;
  assert.deepEqual(demand.left.claim_ids, [eiaClaim.id]);
  // (d) No bulk feed is ingested.
  assert.match(byPolicy["ba-demand.eia930-api-vs-bulk"].right.issue!, /^input not captured: EIA-930 bulk BALANCE rows are an opt-in backfill/);
  const bulk = byPolicy["ba-demand.eia930-api-vs-bulk"];
  assert.equal(bulk.left.observation?.value, 20900, "a side that was read keeps its value");
  assert.equal(bulk.left.observation?.scope.start, "2026-11-14T23:00:00.000Z");
  assert.equal(bulk.right.observation, null);
  assert.equal(bulk.difference, null);

  // Idempotent: a rerun returns the stored record, and recomputing from scratch yields identical bytes.
  assert.deepEqual(await reconcileReport(id, revision), record);
  assert.deepEqual(await reconcileReport(id), record, "latest resolves to the same revision");
  await rm(path);
  await reconcileReport(id, revision);
  assert.equal(await readFile(path, "utf8"), bytes);

  // Tampering with a value or with the bound revision is detected on read.
  await writeFile(path, bytes.replace('"value":697', '"value":698'));
  await assert.rejects(readReconciliation(id, revision), /checksum mismatch/);
  await assert.rejects(reconcileReport(id, revision), /checksum mismatch/);
  const rebound = JSON.parse(bytes);
  rebound.report_revision = "0".repeat(64);
  await writeFile(path, JSON.stringify(rebound));
  await assert.rejects(readReconciliation(id, revision), /does not match its report revision/);

  // A record saved under another policies_version is never served: not at the legacy
  // unversioned key, not at another version's key, and not when relabelled in place.
  await rm(path);
  const stale = { ...JSON.parse(bytes), policies_version: "0".repeat(64) };
  const { digest: _drop, ...staleBody } = stale;
  const staleRecord = canonicalJson({ ...staleBody, digest: digest(staleBody) }) + "\n";
  await writeFile(resolve(root, "reconciliations", id, `${revision}.json`), staleRecord);
  await writeFile(resolve(root, "reconciliations", id, `${revision}.000000000000.json`), staleRecord);
  assert.equal(await readReconciliation(id, revision), null, "no record for the current policies version");
  const fresh = await reconcileReport(id, revision);
  assert.equal(fresh?.policies_version, POLICIES_VERSION);
  assert.equal(await readFile(path, "utf8"), bytes);
  await writeFile(path, staleRecord);
  await assert.rejects(readReconciliation(id, revision), /does not match its report revision/);

  assert.equal(await reconcileReport(id, "f".repeat(64)), null);
  assert.equal(await reconcileReport("location-nope", revision), null);
});

test("missing inputs are incomparable with input-not-captured reasons", async (t) => {
  isolateState(t);
  await mockUpstreams(t);
  const report = await runLocation(locationQuery(34.0522, -118.2437, 100), true, capturedAt);
  const id = locationId(report.query);
  const record = await reconcileReport(id, reportRevision(report));
  assert.ok(record);
  const byPolicy = Object.fromEntries(record.comparisons.map((comparison) => [comparison.policy, comparison]));
  assert.match(byPolicy["substation-count.hifld-vs-osm-bundle"].right.issue!,
    /^input not captured: no shipped evidence bundle covers center 34.0522,-118.2437 radius 100 mi exactly/);
  assert.doesNotMatch(byPolicy["substation-count.hifld-vs-osm-bundle"].reason!, /known defect/);
  assert.match(byPolicy["plant-count.eia-atlas-vs-eia860-bundle"].right.issue!, /^input not captured: no shipped evidence bundle/);
  const demand = byPolicy["ba-demand.eia930-ciso-vs-caiso-5min"];
  assert.match(demand.left.issue!, /^input not captured: source eia-hourly-demand is not part of this report/);
  assert.match(demand.right.issue!, /^input not captured: source caiso-demand-5min is not part of this report/);
  for (const comparison of record.comparisons) {
    assert.equal(comparison.status, "incomparable");
    assert.equal(comparison.selected, null);
  }
});

/** Independent expectation: mean of the fixture's `Current demand` for one Pacific hour (all 12 rows). */
async function fixtureHourMean(pacificHour: string): Promise<number> {
  const { header, rows } = parseCsv(await readFile(`${FIXTURES}/demand.csv`, "utf8"));
  const time = header.indexOf("Time");
  const demand = header.indexOf("Current demand");
  const values = rows.filter((row) => row[time].startsWith(`${pacificHour}:`)).map((row) => Number(row[demand]));
  assert.equal(values.length, 12);
  assert.ok(values.every(Number.isFinite));
  return values.reduce((sum, value) => sum + value, 0) / 12;
}
const demandPolicy = () => structuredClone(getPolicy("ba-demand.eia930-ciso-vs-caiso-5min")!);

test("EIA vs CAISO inside the documented tolerance is within_tolerance and selects nothing", async (t) => {
  isolateState(t);
  // Hour ending 01:00Z covers 00:00-01:00Z = 16:00-16:55 PST.
  const expected = await fixtureHourMean("16");
  const eia = Math.round(expected) + 100;
  const within = await evaluatePolicy(demandPolicy(), await westminsterReport(t, String(eia), "2026-11-15T01"));
  assert.equal(within.status, "within_tolerance");
  assert.equal(within.left.observation?.value, eia);
  assert.equal(within.right.observation?.value, expected);
  assert.equal(within.right.observation?.locator.match(/\/rows\/\d+\/3/g)?.length, 12);
  assert.equal(within.left.observation?.scope.start, "2026-11-15T00:00:00.000Z");
  assert.equal(within.independent, true);
  assert.equal(within.selected, null, "no authority: within tolerance selects nothing");
  assert.match(within.reason!, /within the 300 MW tolerance; no authority, both values retained/);
});

test("a CAISO-vs-EIA conflict selects nothing and stores no blended value", async (t) => {
  isolateState(t);
  const expected = await fixtureHourMean("15");
  const eia = expected + 2000;
  const report = await westminsterReport(t, String(eia));
  const id = report.evidence.region.id;
  const record = (await reconcileReport(id, reportRevision(report)))!;
  const conflict = record.comparisons.find(({ policy }) => policy === "ba-demand.eia930-ciso-vs-caiso-5min")!;
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.selected, null);
  assert.equal(conflict.left.observation?.value, eia);
  assert.equal(conflict.right.observation?.value, expected);
  assert.equal(conflict.difference, 2000);
  const blended = (eia + expected) / 2;
  assert.equal(JSON.stringify(record).includes(String(blended)), false, "no averaged value in the persisted record");
  assert.match(conflict.reason!, /beyond the 300 MW tolerance; no authority, both values retained and none selected/);
});

test("the CAISO side needs all 12 intervals; the EIA side needs a UTC basis and a reviewed convention", async (t) => {
  isolateState(t);
  // Hour ending 02:00Z covers 01:00-02:00Z = 17:00-17:55 PST, which the fixture has not published.
  const missing = await evaluatePolicy(demandPolicy(), await westminsterReport(t, "20900", "2026-11-15T02"));
  assert.equal(missing.status, "incomparable");
  assert.match(missing.right.issue!, /CAISO file has 0 of 12 five-minute demand values for 2026-11-15T01:00:00.000Z/);
  assert.equal(missing.independent, false);
  t.mock.restoreAll();
  isolateState(t);
  const report = await westminsterReport(t);
  const legacy = structuredClone(report);
  legacy.feeds["eia-hourly-demand"] = {
    ...legacy.feeds["eia-hourly-demand"], observation_at: "2026-11-15T00", observation_time_basis: "local-unknown",
  };
  const local = await evaluatePolicy(demandPolicy(), legacy);
  assert.match(local.left.issue!, /no verified UTC basis \(observation_time_basis local-unknown\)/);
  assert.match(local.right.issue!, /not evaluated: no comparison hour/);
  const unreviewed = demandPolicy();
  unreviewed.interval = { kind: "utc-hour", eia_period_convention: null };
  assert.match((await evaluatePolicy(unreviewed, report)).left.issue!, /EIA period convention .* is not reviewed/);
  const otherRespondent = structuredClone(report);
  otherRespondent.query = { ...otherRespondent.query, respondent: "BPAT" };
  assert.match((await evaluatePolicy(demandPolicy(), otherRespondent)).reason!, /respondent BPAT is not CISO/);
});

test("a side with a known_defect is incomparable with that reason and keeps both values", async (t) => {
  isolateState(t);
  const policy = structuredClone(getPolicy("substation-count.hifld-vs-osm-bundle")!);
  assert.equal(policy.left.known_defect, undefined, "no shipped point-layer policy carries a known defect");
  policy.left.known_defect = "synthetic defect for this test";
  const result = await evaluatePolicy(policy, await westminsterReport(t));
  assert.equal(result.status, "incomparable");
  assert.equal(result.reason, "left (hifld-substations): known defect: synthetic defect for this test");
  assert.equal(result.left.observation?.value, 42);
  assert.equal(result.right.observation?.value, 1271);
  assert.equal(result.difference, null);
  assert.equal(result.selected, null);
});
