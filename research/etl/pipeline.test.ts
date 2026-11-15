import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { verifyEvidenceFiles } from "../verify-files";
import { locationQuery, runLocation, stateRoot, verifyLocation } from "./pipeline";
import { backupReport, backupWeather, restoreReport, restoreWeather } from "./backup";
import { reconcile, type Observation } from "./reconcile";
import { backfillWeather } from "./weather-history";
import { feedsFor } from "./sources";
import { computeBundleId, computeRegistryDigest, digest } from "../../lib/evidence/canonical";
import { verifyBundle } from "../../lib/evidence/verify";
import { replaySnapshot } from "../snapshot";
import { parseSnapshot } from "../parsers";

test("location ETL captures, throttles, replays and falls back with cited values", async (t) => {
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  t.after(() => { delete process.env.ETL_STATE_NAMESPACE; });
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
  assert.equal(captured.evidence.unresolved.length, 2);
  assert.equal(captured.feeds["eia-hourly-demand"].status, "unknown");
  assert.equal(captured.feeds["eia-hourly-demand"].observation_at, "2026-11-14T18");
  assert.equal(captured.feeds["eia-hourly-demand"].source_age_seconds, null);
  const legacy = {
    ...captured,
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

test("EIA invalid periods and local reporting times cannot qualify as fresh UTC data", () => {
  const feed = feedsFor(locationQuery(34, -118, 100, "CISO")).find((item) => item.source.id === "eia-hourly-demand")!;
  const bad = { response: { data: [{ period: "2026-11-14T99", respondent: "CISO", value: 2,
    "value-units": "megawatthours", type: "D" }] } };
  assert.deepEqual(feed.extract(bad), []);
  const futureLocal = { response: { data: [{ period: "2099-11-14T18", respondent: "CISO", value: 2,
    "value-units": "megawatthours", type: "D" }] } };
  assert.equal(feed.observationTime?.(futureLocal)?.basis, "local-unknown");
});
test("weather backfill rejects gaps and preserves modeled data and locators", async (t) => {
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  t.after(() => { delete process.env.ETL_STATE_NAMESPACE; });
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
