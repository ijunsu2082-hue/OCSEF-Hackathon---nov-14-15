import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { verifyEvidenceFiles } from "../verify-files";
import {
  LOCATION_REPORT_SCHEMA, locationId, locationQuery, readReport, reportRevision, runLocation, stateRoot, verifyLocation,
  type LocationReport,
} from "./pipeline";
import { resetHttpState } from "./http";
import { collectAssets } from "./assets";
import { loadLocationAssets, readLocationAssets } from "./load-assets";
import { resolveBoundAssets } from "./bound-assets";
import { backupReport, backupWeather, restoreReport, restoreWeather } from "./backup";
import { reconcile, type Observation } from "./reconcile";
import { backfillWeather } from "./weather-history";
import { feedsFor } from "./sources";
import { computeBundleId, computeRegistryDigest, digest } from "../../lib/evidence/canonical";
import { verifyBundle } from "../../lib/evidence/verify";
import { replaySnapshot } from "../snapshot";
import { parseSnapshot } from "../parsers";
import { GET as getInventory } from "../../app/api/location-assets/[inventory]/route";
import { GET as getReportAssets } from "../../app/api/location-report/[id]/assets/route";

test("location ETL captures, throttles, replays and falls back with cited values", async (t) => {
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const scratch = stateRoot();
  t.after(async () => {
    delete process.env.ETL_STATE_NAMESPACE;
    for (const path of [scratch, `${scratch}-restored`]) await rm(path, { recursive: true, force: true });
  });
  const query = locationQuery(34.0522, -118.2437, 100, "CISO");
  const start = new Date("2026-11-14T19:00:00Z");
  let calls = 0;
  let fail = false;
  let observationTimestamp = start.toISOString();
  const originalKey = process.env.EIA_API_KEY;
  process.env.EIA_API_KEY = "fixture-secret";
  t.after(() => {
    if (originalKey === undefined) delete process.env.EIA_API_KEY;
    else process.env.EIA_API_KEY = originalKey;
  });
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    calls += 1;
    if (fail) return new Response(null, { status: 503 });
    switch (url.hostname) {
      case "geocoding.geo.census.gov":
        return Response.json({ result: { geographies: {
          States: [{ GEOID: "06" }], Counties: [{ GEOID: "06037", NAME: "Los Angeles County" }],
        } } });
      case "services.arcgis.com":
      case "services1.arcgis.com":
        return Response.json({ count: 42 });
      case "api.eia.gov": {
        assert.equal(url.searchParams.get("api_key"), "fixture-secret");
        const fuel = url.pathname.includes("fuel-type");
        return Response.json({ response: { data: [{
          period: "2026-11-14T18", respondent: "CISO", value: "502",
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
          timestamp: observationTimestamp, temperature: { unitCode: "wmoUnit:degC", value: 20 },
          windGust: { unitCode: "wmoUnit:km_h-1", value: null },
        } });
      default:
        throw new Error(`Unexpected source ${url}`);
    }
  });
  const captured = await runLocation(query, true, start);
  await verifyLocation(captured);
  assert.equal(captured.evidence.verification.ok, true);
  assert.equal(captured.evidence.stats.observed, 13);
  // frequency=hourly periods are UTC hour-ending labels (EIA route metadata:
  // "hourly (UTC)"), so the 18:00Z hour observed at 19:00Z is one hour old.
  assert.equal(captured.evidence.unresolved.length, 0);
  assert.equal(captured.feeds["eia-hourly-demand"].status, "fresh");
  assert.equal(captured.feeds["eia-hourly-demand"].observation_at, "2026-11-14T18:00:00.000Z");
  assert.equal(captured.feeds["eia-hourly-demand"].observation_time_basis, "utc");
  assert.equal(captured.feeds["eia-hourly-demand"].source_age_seconds, 3600);
  // Legacy reports predate the schema marker as well as the observation-time fields.
  const { schema: _schema, ...unmarked } = captured;
  const legacy = {
    ...unmarked,
    feeds: Object.fromEntries(Object.entries(captured.feeds).map(([source, state]) => {
      const { observation_at: _at, observation_time_basis: _basis, source_age_seconds: _age, ...oldState } = state;
      return [source, oldState];
    })),
  };
  const feedById = new Map(feedsFor(query).map((feed) => [feed.source.id, feed]));
  const measurements = [];
  for (const snapshot of legacy.evidence.snapshots) {
    const loaded = await replaySnapshot(snapshot);
    const metrics = feedById.get(snapshot.source_id)!.extract(loaded.data);
    measurements.push([snapshot.source_id, metrics.map(({ predicate, value }) => [predicate, value]).sort()]);
  }
  legacy.state_hash = digest({
    measurements,
    coverage: Object.entries(legacy.feeds).map(([source, state]) => [source, state.status, state.issue ?? null]),
    gaps: legacy.evidence.unresolved.map(({ predicate, reason }) => [predicate, reason]),
  });
  await verifyLocation(legacy);
  const preAlerts = structuredClone(legacy);
  delete preAlerts.feeds["nws-active-alerts"];
  preAlerts.evidence.sources = preAlerts.evidence.sources.filter((source) => source.id !== "nws-active-alerts");
  preAlerts.evidence.snapshots = preAlerts.evidence.snapshots.filter((snapshot) => snapshot.source_id !== "nws-active-alerts");
  preAlerts.evidence.claims = preAlerts.evidence.claims.filter((claim) => claim.source_id !== "nws-active-alerts");
  preAlerts.evidence.registry_digest = computeRegistryDigest(preAlerts.evidence.sources);
  preAlerts.evidence.stats.claims = preAlerts.evidence.claims.length;
  preAlerts.evidence.stats.observed = preAlerts.evidence.claims.length - 3;
  preAlerts.evidence.stats.sources = preAlerts.evidence.sources.length;
  preAlerts.evidence.stats.snapshots = preAlerts.evidence.snapshots.length;
  preAlerts.evidence.bundle_id = computeBundleId(preAlerts.evidence);
  preAlerts.evidence.verification = verifyBundle(preAlerts.evidence).report;
  preAlerts.state_hash = digest({
    measurements: measurements.filter(([source]) => source !== "nws-active-alerts"),
    coverage: Object.entries(preAlerts.feeds).map(([source, state]) => [source, state.status, state.issue ?? null]),
    gaps: preAlerts.evidence.unresolved.map(({ predicate, reason }) => [predicate, reason]),
  });
  await verifyLocation(preAlerts);
  assert.equal(Object.hasOwn(preAlerts.feeds, "nws-active-alerts"), false);
  assert.equal(JSON.stringify(captured).includes("fixture-secret"), false);
  assert.equal(calls, 10);
  const replay = await runLocation(query, false, start);
  assert.deepEqual(replay, captured);
  await runLocation(query, true, new Date(start.getTime() + 60000));
  assert.equal(calls, 10);
  fail = true;
  const fallback = await runLocation(query, true, new Date(start.getTime() + 600000));
  assert.equal(fallback.feeds["nws-observation"].status, "fallback");
  assert.equal(fallback.evidence.claims.find((claim) => claim.predicate === "weather.temperature_c")?.value, 20);
  assert.notEqual(fallback.state_hash, captured.state_hash);
  const snapshot = captured.evidence.snapshots[0];
  const original = await readFile(snapshot.cache_path);
  try {
    await writeFile(snapshot.cache_path, "{}");
    assert.equal((await verifyEvidenceFiles(captured.evidence)).issues[0]?.code, "SNAPSHOT_REPLAY");
  } finally {
    await writeFile(snapshot.cache_path, original);
  }
  const namespace = process.env.ETL_STATE_NAMESPACE!;
  const backup = `research/etl-state/${namespace}/backup.json`;
  const originalBackupKey = process.env.ETL_BACKUP_KEY;
  process.env.ETL_BACKUP_KEY = "ab".repeat(32);
  t.after(() => {
    if (originalBackupKey === undefined) delete process.env.ETL_BACKUP_KEY;
    else process.env.ETL_BACKUP_KEY = originalBackupKey;
  });
  await backupReport(captured, backup);
  process.env.ETL_STATE_NAMESPACE = `${namespace}-restored`;
  const restored = await restoreReport(backup);
  assert.equal(restored.evidence.bundle_id, captured.evidence.bundle_id);
  assert.deepEqual(restored.evidence.claims.map(({ id }) => id), captured.evidence.claims.map(({ id }) => id));
  fail = false;
  observationTimestamp = "2026-11-13T18:00:00Z";
  const stale = await runLocation(query, true, new Date(start.getTime() + 20 * 60000));
  assert.equal(stale.feeds["nws-observation"].status, "stale");
  assert.equal(stale.feeds["nws-observation"].observation_at, new Date(observationTimestamp).toISOString());
  assert.ok((stale.feeds["nws-observation"].source_age_seconds ?? 0) > 86400);
  assert.ok(stale.evidence.unresolved.some((item) => item.predicate === "nws-observation"));
  observationTimestamp = "2026-11-15T19:00:00Z";
  const future = await runLocation(query, true, new Date(start.getTime() + 31 * 60000));
  assert.equal(future.feeds["nws-observation"].status, "unknown");
  assert.equal(future.feeds["nws-observation"].source_age_seconds, null);
});

test("NWS active alerts feed records zero counts and extracts returned events", () => {
  const feed = feedsFor(locationQuery(34.0522, -118.2437, 100)).find((item) => item.source.id === "nws-active-alerts")!;
  assert.equal(feed.url.href, "https://api.weather.gov/alerts/active?point=34.0522,-118.2437");
  const zero = parseSnapshot(Buffer.from(JSON.stringify({ features: [] })), "json.nws-alerts");
  assert.deepEqual(feed.extract(zero.data), [
    { predicate: "weather.active_alert_count", locator: "/etl/active_alert_count", value: 0 },
  ]);
  const populated = parseSnapshot(Buffer.from(JSON.stringify({ features: [
    { properties: { event: "Flood Warning" } }, { properties: { event: "High Wind Warning" } },
  ] })), "json.nws-alerts");
  assert.deepEqual(feed.extract(populated.data), [
    { predicate: "weather.active_alert_count", locator: "/etl/active_alert_count", value: 2 },
    { predicate: "weather.active_alert_event", locator: "/features/0/properties/event", value: "Flood Warning" },
    { predicate: "weather.active_alert_event", locator: "/features/1/properties/event", value: "High Wind Warning" },
  ]);
  assert.throws(() => parseSnapshot(Buffer.from(JSON.stringify({ features: [], pagination: { next: "https://api.weather.gov/alerts/active?page=2" } })), "json.nws-alerts"), /paginated/);
  assert.throws(() => parseSnapshot(Buffer.from(JSON.stringify({ features: null })), "json.nws-alerts"), /features array/);
});

test("provider disagreement requires compatible scope and explicit authority", () => {
  const left: Observation = {
    scope: { metric: "demand", entity: "CISO", unit: "MWh", start: "2026-11-14T18:00:00Z",
      end: "2026-11-14T19:00:00Z", statistic: "hourly_energy", basis: "actual" },
    source: "a", publisher: "A", release: "1", snapshot: "one", locator: "/value", value: 200,
  };
  const right = { ...left, source: "b", publisher: "B", value: 300 };
  assert.equal(reconcile(left, right).selected, null);
  assert.equal(reconcile(left, right, { scope: left.scope, authority: "a" }).selected, left);
  assert.equal(reconcile(left, { ...right, scope: { ...right.scope, entity: "LDWP" } }).status, "incomparable");
  assert.equal(reconcile(left, { ...right, publisher: "A" }).independent, false);
});

test("EIA hourly periods are UTC; invalid and local-time periods are rejected", () => {
  const feed = feedsFor(locationQuery(34, -118, 100, "CISO")).find((item) => item.source.id === "eia-hourly-demand")!;
  const bad = { response: { data: [{ period: "2026-11-14T99", respondent: "CISO", value: 2,
    "value-units": "megawatthours", type: "D" }] } };
  assert.deepEqual(feed.extract(bad), []);
  // `local-hourly` periods carry an offset suffix; this feed only reads UTC `hourly`.
  const local = { response: { data: [{ period: "2026-11-14T18-08", respondent: "CISO", value: 2,
    "value-units": "megawatthours", type: "D" }] } };
  assert.deepEqual(feed.extract(local), []);
  assert.equal(feed.observationTime?.(local), null);
  // A future UTC period is reported as such; observedState refuses a negative age as fresh.
  const future = { response: { data: [{ period: "2099-11-14T18", respondent: "CISO", value: 2,
    "value-units": "megawatthours", type: "D" }] } };
  assert.deepEqual(feed.observationTime?.(future), { timestamp: "2099-11-14T18:00:00.000Z", basis: "utc" });
});
test("weather backfill rejects gaps and preserves modeled data and locators", async (t) => {
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const scratch = stateRoot();
  t.after(async () => {
    delete process.env.ETL_STATE_NAMESPACE;
    await rm(scratch, { recursive: true, force: true });
  });
  let complete = true;
  t.mock.method(globalThis, "fetch", async () => Response.json({
    latitude: 34, longitude: -118,
    hourly_units: { temperature_2m: "°C", wind_speed_10m: "m/s", shortwave_radiation: "W/m²" },
    hourly: {
      time: Array.from({ length: complete ? 24 : 23 }, (_, i) => `2024-01-01T${String(i).padStart(2, "0")}:00`),
      temperature_2m: Array(24).fill(20), wind_speed_10m: Array(24).fill(2),
      shortwave_radiation: Array(24).fill(0),
    },
  }));
  const result = await backfillWeather(34, -118, "2024-01-01", "2024-01-01");
  assert.equal(result.rows, 24);
  const saved = JSON.parse(await readFile(result.path, "utf8"));
  assert.equal(saved.basis, "modeled_reanalysis");
  assert.equal(saved.rows[0].metrics[0].locator, "/hourly/temperature_2m/0");
  const priorKey = process.env.ETL_BACKUP_KEY;
  const originalNamespace = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_BACKUP_KEY = "ef".repeat(32);
  const backup = `${stateRoot()}/weather.backup.json`;
  await backupWeather(result.snapshot, backup);
  process.env.ETL_STATE_NAMESPACE = `restore-${randomUUID()}`;
  const restoreScratch = stateRoot();
  t.after(() => rm(restoreScratch, { recursive: true, force: true }));
  const restored = await restoreWeather(backup);
  assert.equal(restored.snapshot, result.snapshot);
  assert.equal(restored.rows, 24);
  if (originalNamespace === undefined) delete process.env.ETL_STATE_NAMESPACE;
  else process.env.ETL_STATE_NAMESPACE = originalNamespace;
  if (priorKey === undefined) delete process.env.ETL_BACKUP_KEY;
  else process.env.ETL_BACKUP_KEY = priorKey;
  complete = false;
  await assert.rejects(backfillWeather(34, -118, "2024-01-01", "2024-01-01"), /Incomplete hourly weather time axis/);
});

test("location reports bind the loaded asset inventory revision they were built against", async (t) => {
  const prior = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const scratch = stateRoot();
  const originalKey = process.env.EIA_API_KEY;
  process.env.EIA_API_KEY = "fixture-secret";
  t.after(async () => {
    if (prior === undefined) delete process.env.ETL_STATE_NAMESPACE;
    else process.env.ETL_STATE_NAMESPACE = prior;
    if (originalKey === undefined) delete process.env.EIA_API_KEY;
    else process.env.EIA_API_KEY = originalKey;
    for (const path of [scratch, `${scratch}-backup`]) await rm(path, { recursive: true, force: true });
  });
  const start = new Date("2026-11-14T19:00:00Z");
  let stationName = "Example Station";
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    switch (url.hostname) {
      case "geocoding.geo.census.gov":
        return Response.json({ result: { geographies: {
          States: [{ GEOID: "06" }], Counties: [{ GEOID: "06037", NAME: "Los Angeles County" }],
        } } });
      case "services.arcgis.com":
      case "services1.arcgis.com":
        if (url.searchParams.get("returnIdsOnly") === "true") {
          return Response.json({ objectIdFieldName: "OBJECTID", objectIds: [7] });
        }
        if (url.searchParams.has("objectIds")) return Response.json({ type: "FeatureCollection", features: [{
          type: "Feature", properties: { OBJECTID: 7, NAME: stationName, OWNER: "Utility C", MAX_VOLT: 230 },
          geometry: { type: "Point", coordinates: [-118, 34] },
        }] });
        return Response.json({ count: 42 });
      case "api.eia.gov": {
        const fuel = url.pathname.includes("fuel-type");
        return Response.json({ response: { data: [{
          period: "2026-11-14T18", respondent: "CISO", value: "502",
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
          timestamp: start.toISOString(), temperature: { unitCode: "wmoUnit:degC", value: 20 },
          windGust: { unitCode: "wmoUnit:km_h-1", value: null },
        } });
      default:
        throw new Error(`Unexpected source ${url}`);
    }
  });
  const query = locationQuery(34, -118, 5, "CISO");
  const id = locationId(query);
  const inventoryQuery = locationQuery(34, -118, 5);

  const unbound = await runLocation(query, true, start);
  assert.equal(unbound.assets, null);
  const unboundRevision = reportRevision(unbound);
  assert.deepEqual(await resolveBoundAssets(id), {
    status: 404, body: { error: "report has no bound asset inventory", report_revision: unboundRevision },
  });

  const first = await loadLocationAssets([(await collectAssets(inventoryQuery, "hifld-substations")).path]);
  assert.notEqual(first.location, id);
  assert.equal(first.location, locationId({ center: query.center, radius_miles: query.radius_miles }));
  const bound = await runLocation(query, true, new Date(start.getTime() + 60000));
  assert.deepEqual(bound.assets, { location: first.location, revision: first.revision });
  const boundRevision = reportRevision(bound);
  assert.notEqual(boundRevision, unboundRevision);
  assert.equal((await readReport(id, unboundRevision))?.assets, null);

  stationName = "Renamed Station";
  const second = await loadLocationAssets([(await collectAssets(inventoryQuery, "hifld-substations")).path]);
  assert.notEqual(second.revision, first.revision);
  assert.equal((await readLocationAssets(first.location))?.revision, second.revision);

  assert.deepEqual((await readReport(id, boundRevision))?.assets, { location: first.location, revision: first.revision });
  const pinned = await resolveBoundAssets(id, boundRevision);
  assert.equal(pinned.status, 200);
  if (pinned.status !== 200) throw new Error("unreachable");
  assert.equal(pinned.report_revision, boundRevision);
  assert.equal(pinned.asset_revision, first.revision);
  assert.equal(pinned.immutable, true);
  assert.deepEqual(pinned.body, await readLocationAssets(first.location, first.revision));
  assert.equal((await resolveBoundAssets(id, boundRevision, first.revision)).status, 200);
  assert.deepEqual(await resolveBoundAssets(id, boundRevision, second.revision), {
    status: 409, body: {
      error: `report is bound to asset revision ${first.revision}`,
      report_revision: boundRevision, asset_revision: first.revision,
    },
  });
  assert.equal((await resolveBoundAssets(id, "f".repeat(64))).status, 404);
  assert.equal((await resolveBoundAssets(id, "not-a-revision")).status, 404);
  assert.equal((await resolveBoundAssets(`location-${"0".repeat(24)}`)).status, 404);

  // Offline replay reuses the recorded binding even though latest now points at `second`.
  await verifyLocation(bound);
  const replayed = await runLocation(query, false, new Date(bound.evidence.generated_at), bound);
  assert.deepEqual(replayed.assets, bound.assets);
  assert.equal(reportRevision(replayed), boundRevision);
  assert.equal(reportRevision(await runLocation(query, false, new Date(bound.evidence.generated_at))), boundRevision);
  const legacy = structuredClone(unbound);
  delete legacy.assets;
  assert.equal(reportRevision(await runLocation(query, false, start, legacy)), reportRevision(legacy));

  const rebound = await runLocation(query, true, new Date(start.getTime() + 120000));
  assert.deepEqual(rebound.assets, { location: second.location, revision: second.revision });
  const latest = await resolveBoundAssets(id);
  assert.equal(latest.status, 200);
  if (latest.status !== 200) throw new Error("unreachable");
  assert.equal(latest.report_revision, reportRevision(rebound));
  assert.equal(latest.asset_revision, second.revision);
  assert.equal(latest.immutable, false);
  const old = await resolveBoundAssets(id, boundRevision);
  assert.equal(old.status === 200 && old.asset_revision, first.revision);

  // Scan-page link target: inventory-only route keyed by inventory id, not report id.
  const inventoryUrl = (inventory: string, revision?: string) => getInventory(
    new Request(`http://localhost/api/location-assets/${inventory}${revision ? `?revision=${revision}` : ""}`),
    { params: Promise.resolve({ inventory }) });
  const pinnedInventory = await inventoryUrl(first.location, first.revision);
  assert.equal(pinnedInventory.status, 200);
  assert.equal(pinnedInventory.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(pinnedInventory.headers.get("x-asset-revision"), first.revision);
  assert.deepEqual(await pinnedInventory.json(), await readLocationAssets(first.location, first.revision));
  const latestInventory = await inventoryUrl(first.location);
  assert.equal(latestInventory.status, 200);
  assert.equal(latestInventory.headers.get("cache-control"), "no-store");
  assert.equal(latestInventory.headers.get("x-asset-revision"), second.revision);
  assert.equal((await inventoryUrl(first.location, "f".repeat(64))).status, 404);
  assert.equal((await inventoryUrl(`location-${"0".repeat(24)}`)).status, 404);
  assert.equal((await inventoryUrl(first.location, "not-a-revision")).status, 400);
  assert.equal((await inventoryUrl("../reports")).status, 400);
  // The report-bound route rejects the same pairing the old link produced.
  assert.equal((await resolveBoundAssets(first.location, undefined, first.revision)).status, 404);

  // A corrupt latest inventory quarantines and binds nothing instead of failing the live build.
  const secondPath = `${stateRoot()}/loaded-assets/${second.location}/${second.revision}.json`;
  const secondBytes = await readFile(secondPath);
  await writeFile(secondPath, JSON.stringify({ ...JSON.parse(secondBytes.toString("utf8")), location: "tampered" }));
  const warn = t.mock.method(console, "warn", () => {});
  const corrupt = await runLocation(query, true, new Date(start.getTime() + 180000));
  warn.mock.restore();
  assert.equal(corrupt.assets, null);
  assert.equal((await readReport(id))?.assets, null);
  assert.equal(warn.mock.callCount(), 1);
  const warning = String(warn.mock.calls[0].arguments[0]);
  assert.match(warning, /asset inventory .* rejected \(Asset revision checksum mismatch\)/);
  assert.doesNotMatch(warning, /@@MAPERGY_RESULT@@|\n/);
  const quarantineDir = `${stateRoot()}/quarantine/assets/${second.location}`;
  const quarantined = await readdir(quarantineDir);
  assert.equal(quarantined.length, 1);
  const record = JSON.parse(await readFile(`${quarantineDir}/${quarantined[0]}`, "utf8"));
  assert.equal(record.inventory, second.location);
  assert.equal(record.issue, "Asset revision checksum mismatch");
  await writeFile(`${stateRoot()}/loaded-assets/${second.location}/latest.json`, "{not json");
  const malformed = await runLocation(query, true, new Date(start.getTime() + 210000));
  assert.equal(malformed.assets, null);
  assert.equal((await readdir(quarantineDir)).length, 2);
  await writeFile(`${stateRoot()}/loaded-assets/${second.location}/latest.json`, JSON.stringify({ revision: second.revision }));
  await writeFile(secondPath, secondBytes);
  const repaired = await runLocation(query, true, new Date(start.getTime() + 240000));
  assert.deepEqual(repaired.assets, { location: second.location, revision: second.revision });
  assert.deepEqual((await readReport(id))?.assets, repaired.assets);

  // Report backups embed the bound inventory and republish it before the report.
  const namespace = process.env.ETL_STATE_NAMESPACE!;
  const originalBackupKey = process.env.ETL_BACKUP_KEY;
  process.env.ETL_BACKUP_KEY = "ef".repeat(32);
  t.after(() => {
    if (originalBackupKey === undefined) delete process.env.ETL_BACKUP_KEY;
    else process.env.ETL_BACKUP_KEY = originalBackupKey;
  });
  const backup = `research/etl-state/${namespace}-backup/report.backup.json`;
  await backupReport(repaired, backup);
  await rm(`research/etl-state/${namespace}`, { recursive: true, force: true });
  assert.equal(await readLocationAssets(second.location, second.revision), null);
  const restored = await restoreReport(backup);
  assert.equal(reportRevision(restored), reportRevision(repaired));
  const resolved = await resolveBoundAssets(id, reportRevision(restored));
  assert.equal(resolved.status, 200);
  assert.equal(resolved.status === 200 && resolved.asset_revision, second.revision);
  assert.equal((await readLocationAssets(second.location))?.revision, second.revision);

  // Re-seal the payload to model an old backup (no inventory) and a tampered one.
  const unsealed = async () => {
    const envelope = JSON.parse(await readFile(backup, "utf8"));
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from("ef".repeat(32), "hex"), Buffer.from(envelope.nonce, "hex"));
    decipher.setAAD(Buffer.from("mapergy.backup/1"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  };
  // Re-sealed under the pre-rename format, as a real old backup would be.
  const reseal = async (payload: unknown, destination: string) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from("ef".repeat(32), "hex"), nonce);
    cipher.setAAD(Buffer.from("gridsentinel.backup/1"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    await writeFile(destination, JSON.stringify({ format: "gridsentinel.backup/1", nonce: nonce.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("base64") }));
  };
  const payload = await unsealed();
  assert.equal(payload.inventory.revision, second.revision);
  const { inventory, ...legacyPayload } = payload;
  const legacyBackup = `research/etl-state/${namespace}-backup/legacy.backup.json`;
  await reseal(legacyPayload, legacyBackup);
  await rm(`research/etl-state/${namespace}`, { recursive: true, force: true });
  const legacyRestored = await restoreReport(legacyBackup);
  assert.equal(reportRevision(legacyRestored), reportRevision(repaired));
  assert.equal((await resolveBoundAssets(id, reportRevision(legacyRestored))).status, 404);
  const tamperedBackup = `research/etl-state/${namespace}-backup/tampered.backup.json`;
  const tamperedBytes = Buffer.from(inventory.bytes, "base64").toString("utf8").replace(second.location, "location-tampered");
  await reseal({ ...payload, inventory: { ...inventory, bytes: Buffer.from(tamperedBytes).toString("base64") } }, tamperedBackup);
  await assert.rejects(restoreReport(tamperedBackup), /Backup inventory checksum mismatch/);
});

test("a corrupt bound inventory returns a JSON integrity error and quarantines once per issue", async (t) => {
  const prior = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const root = stateRoot();
  t.after(async () => {
    if (prior === undefined) delete process.env.ETL_STATE_NAMESPACE;
    else process.env.ETL_STATE_NAMESPACE = prior;
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    switch (url.hostname) {
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
          timestamp: "2026-11-14T19:00:00Z", temperature: { unitCode: "wmoUnit:degC", value: 20 },
        } });
      default:
        throw new Error(`Unexpected source ${url}`);
    }
  });
  const query = locationQuery(34, -118, 5);
  const id = locationId(query);
  const start = new Date("2026-11-14T19:00:00Z");
  // A minimal stored inventory: readLocationAssets binds any JSON whose digest is its revision.
  const inventory = { schema: "mapergy.location-assets/1", location: id, datasets: [] };
  const revision = digest(inventory);
  const directory = `${root}/loaded-assets/${id}`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/${revision}.json`, JSON.stringify(inventory));
  await writeFile(`${directory}/latest.json`, JSON.stringify({ revision }));
  const bound = await runLocation(query, true, start);
  assert.deepEqual(bound.assets, { location: id, revision });
  const reportRev = reportRevision(bound);

  const tampered = JSON.stringify({ ...inventory, datasets: [{ source: "tampered" }] });
  await writeFile(`${directory}/${revision}.json`, tampered);
  const reportAssets = (search = "") => getReportAssets(
    new Request(`http://localhost/api/location-report/${id}/assets${search}`), { params: Promise.resolve({ id }) });
  const inventoryAssets = (search = "") => getInventory(
    new Request(`http://localhost/api/location-assets/${id}${search}`), { params: Promise.resolve({ inventory: id }) });
  for (const response of [await reportAssets(), await reportAssets(`?report=${reportRev}`)]) {
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-asset-revision"), null);
    const text = await response.text();
    assert.doesNotMatch(text, /tampered/);
    assert.deepEqual(JSON.parse(text), {
      error: "Asset inventory failed integrity check", report_revision: reportRev, asset_revision: revision,
    });
  }
  for (const [search, expected] of [[`?revision=${revision}`, revision], ["", null]] as const) {
    const response = await inventoryAssets(search);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.doesNotMatch(text, /tampered/);
    assert.deepEqual(JSON.parse(text), { error: "Asset inventory failed integrity check", asset_revision: expected });
  }
  // Unparseable stored bytes are an integrity failure too, not a framework 500.
  await writeFile(`${directory}/${revision}.json`, "{tampered");
  assert.equal((await reportAssets(`?report=${reportRev}`)).status, 502);
  assert.equal((await inventoryAssets(`?revision=${revision}`)).status, 502);
  await writeFile(`${directory}/${revision}.json`, tampered);

  // Three live runs against the same corrupt revision: one record, counted, one warning per run.
  const quarantine = `${root}/quarantine/assets/${id}`;
  const warn = t.mock.method(console, "warn", () => {});
  for (let run = 1; run <= 3; run += 1) {
    const report = await runLocation(query, true, new Date(start.getTime() + run * 60000));
    assert.equal(report.assets, null);
    assert.equal(warn.mock.callCount(), run);
    const files = await readdir(quarantine);
    assert.equal(files.length, 1, `run ${run} wrote ${files.length} quarantine files`);
    const record = JSON.parse(await readFile(`${quarantine}/${files[0]}`, "utf8"));
    assert.deepEqual(record, {
      inventory: id, revision, path: directory, issue: "Asset revision checksum mismatch",
      detectedAt: new Date(start.getTime() + 60000).toISOString(),
      lastSeen: new Date(start.getTime() + run * 60000).toISOString(), count: run,
    });
    assert.deepEqual((await readdir(quarantine)).filter((name) => name.endsWith(".tmp")), []);
  }
  assert.match(String(warn.mock.calls[2].arguments[0]), /asset inventory .* rejected \(Asset revision checksum mismatch\)/);
  // A different issue for the same inventory is a separate record.
  await writeFile(`${directory}/latest.json`, "{not json");
  await runLocation(query, true, new Date(start.getTime() + 5 * 60000));
  warn.mock.restore();
  const records = await Promise.all((await readdir(quarantine)).map(async (name) =>
    JSON.parse(await readFile(`${quarantine}/${name}`, "utf8"))));
  assert.equal(records.length, 2);
  const malformed = records.find((record) => record.issue !== "Asset revision checksum mismatch");
  assert.equal(malformed.revision, null);
  assert.equal(malformed.count, 1);
});

/** Isolated state namespace with retries off; restores env afterwards. */
function isolatedRun(t: TestContext, env: Record<string, string> = {}): string {
  const values = { ETL_STATE_NAMESPACE: `test-${randomUUID()}`, ETL_HTTP_RETRY_ATTEMPTS: "0", ...env };
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  resetHttpState();
  const root = stateRoot();
  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetHttpState();
    for (const path of [root, `${root}-restored`]) await rm(path, { recursive: true, force: true });
  });
  return root;
}

/** NWS + ArcGIS + Census upstreams for a query without respondent or CAISO. */
function nwsUpstreams(observedAt: string) {
  return async (url: URL) => {
    switch (url.hostname) {
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
          timestamp: observedAt, temperature: { unitCode: "wmoUnit:degC", value: 20 },
        } });
      default:
        throw new Error(`Unexpected source ${url}`);
    }
  };
}

test("an all-unavailable report verifies, replays, backs up and restores", async (t) => {
  const root = isolatedRun(t, { ETL_BACKUP_KEY: "cd".repeat(32) });
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const query = locationQuery(39.8, -105.0, 50);
  const report = await runLocation(query, true, new Date("2026-11-15T01:05:00Z"));
  assert.ok(Object.values(report.feeds).every(({ status }) => status === "unavailable"));
  const stored = await readReport(report.evidence.region.id, reportRevision(report));
  assert.ok(stored);
  await verifyLocation(stored);
  assert.ok(Object.values(report.feeds).every(({ issue_code }) => issue_code === "fetch_failed"));
  assert.equal(report.schema, LOCATION_REPORT_SCHEMA);
  // With nothing to fall back on, a failed fetch is a no_source gap, not a fallback.
  assert.ok(report.evidence.unresolved.filter(({ predicate }) => Object.hasOwn(report.feeds, predicate))
    .every(({ reason }) => reason === "no_source"));
  await backupReport(stored, `${root}/backup.json`);
  process.env.ETL_STATE_NAMESPACE = `${process.env.ETL_STATE_NAMESPACE}-restored`;
  const restored = await restoreReport(`${root}/backup.json`);
  assert.equal(restored.state_hash, report.state_hash);

  // Unversioned all-unavailable revisions written before the schema marker
  // hashed the current coverage tuple; they still replay.
  const { schema: _schema, ...unversioned } = structuredClone(report);
  unversioned.state_hash = digest({
    measurements: [],
    coverage: Object.entries(unversioned.feeds).map(([source, state]) =>
      [source, state.status, state.observation_at ?? null, state.issue ?? null]),
    gaps: unversioned.evidence.unresolved.map(({ predicate, reason }) => [predicate, reason]),
  });
  await verifyLocation(unversioned as LocationReport);
  // A schema this code does not know is refused rather than guessed.
  await assert.rejects(verifyLocation({ ...report, schema: "mapergy.location-report/99" } as unknown as LocationReport),
    /Unsupported location report schema/);
});

test("a fallback keeps the replayed capture's measured freshness and flags the failed fetch", async (t) => {
  isolatedRun(t);
  const query = locationQuery(34.0522, -118.2437, 100);
  const captureAt = new Date("2026-11-15T01:05:00Z");
  const upstream = nwsUpstreams("2026-11-15T00:53:00+00:00");
  let fail = false;
  t.mock.method(globalThis, "fetch", async (url: URL) => fail ? new Response(null, { status: 503 }) : upstream(url));
  const captured = await runLocation(query, true, captureAt);
  assert.equal(captured.feeds["nws-observation"].status, "fresh");
  assert.equal(captured.feeds["nws-observation"].freshness, undefined);
  assert.equal(captured.feeds["nws-observation"].issue_code, undefined);
  fail = true;

  resetHttpState();
  const soon = await runLocation(query, true, new Date("2026-11-15T01:20:00Z"));
  const fresh = soon.feeds["nws-observation"];
  assert.equal(fresh.status, "fallback");
  assert.equal(fresh.freshness, "fresh");
  assert.equal(fresh.issue_code, "fetch_failed");
  assert.equal(fresh.source_age_seconds, 27 * 60);
  assert.match(fresh.issue ?? "", /503/);
  const freshGap = soon.evidence.unresolved.find(({ predicate }) => predicate === "nws-observation")!;
  assert.equal(freshGap.reason, "requires_review");
  assert.match(freshGap.detail, /^fetch_failed: .*503.*still within the source freshness window/);
  await verifyLocation(soon);

  resetHttpState();
  const later = await runLocation(query, true, new Date("2026-11-15T06:00:00Z"));
  const stale = later.feeds["nws-observation"];
  assert.equal(stale.status, "fallback");
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.issue_code, "fetch_failed");
  const staleGap = later.evidence.unresolved.find(({ predicate }) => predicate === "nws-observation")!;
  assert.equal(staleGap.reason, "stale");
  assert.match(staleGap.detail, /^fetch_failed: .*503.*exceeds source freshness window/);
  await verifyLocation(later);
});

test("EIA fuel reports the newest period in which every reported fuel is numeric", () => {
  const feed = feedsFor(locationQuery(34, -118, 100, "CISO")).find((item) => item.source.id === "eia-hourly-fuel")!;
  const row = (period: string, fueltype: string, value: unknown) =>
    ({ period, respondent: "CISO", value, "value-units": "megawatthours", fueltype });
  const partial = { response: { data: [
    row("2026-11-15T00", "NG", 1200), row("2026-11-15T00", "SUN", null),
    row("2026-11-14T23", "NG", 1100), row("2026-11-14T23", "SUN", 900),
  ] } };
  assert.deepEqual(feed.extract(partial), [
    { predicate: "telemetry.period", locator: "/response/data/2/period", value: "2026-11-14T23" },
    { predicate: "telemetry.fuel_NG", locator: "/response/data/2/value", value: 1100 },
    { predicate: "telemetry.fuel_SUN", locator: "/response/data/3/value", value: 900 },
  ]);
  assert.deepEqual(feed.observationTime?.(partial), { timestamp: "2026-11-14T23:00:00.000Z", basis: "utc" });
  // A complete newest period is still the one reported.
  const complete = { response: { data: [row("2026-11-15T00", "NG", 1200), row("2026-11-15T00", "SUN", 40)] } };
  assert.equal(feed.extract(complete)[0].value, "2026-11-15T00");
  assert.deepEqual(feed.observationTime?.(complete), { timestamp: "2026-11-15T00:00:00.000Z", basis: "utc" });
  // A fuel with no row yet in the newest period also makes that period incomplete.
  const absent = { response: { data: [
    row("2026-11-15T00", "NG", 1200),
    row("2026-11-14T23", "NG", 1100), row("2026-11-14T23", "SUN", 900),
  ] } };
  assert.equal(feed.extract(absent)[0].value, "2026-11-14T23");
  assert.equal(feed.extract(absent).length, 3);
  // No complete period (blank SUN newest, no NG row older): nothing is reported, so capture quarantines it.
  const split = { response: { data: [
    row("2026-11-15T00", "SUN", null), row("2026-11-15T00", "NG", 1200), row("2026-11-14T23", "SUN", 900),
  ] } };
  assert.deepEqual(feed.extract(split), []);
  assert.equal(feed.observationTime?.(split), null);
  const none = { response: { data: [row("2026-11-15T00", "NG", 1200), row("2026-11-15T00", "SUN", "N/A")] } };
  assert.deepEqual(feed.extract(none), []);
  assert.equal(feed.observationTime?.(none), null);
});

test("an ArcGIS count that arrives beside an error is rejected", () => {
  const feeds = feedsFor(locationQuery(34, -118, 100));
  for (const id of ["hifld-substations", "hifld-transmission", "eia-atlas-plants"]) {
    const feed = feeds.find((item) => item.source.id === id)!;
    assert.deepEqual(feed.extract({ count: 0, error: { code: 499, message: "Token required" } }), [], id);
    assert.deepEqual(feed.extract({ count: 3, error: null }), [], id);
    assert.equal(feed.extract({ count: 3 }).length, 1, id);
  }
});
