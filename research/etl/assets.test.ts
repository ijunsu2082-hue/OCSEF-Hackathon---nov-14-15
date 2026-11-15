import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { collectAssets, replayAssets } from "./assets";
import { atomicJson, locationQuery, stateRoot } from "./pipeline";
import { auditSubstations, substationNameKey } from "./substation-audit";
import { loadLocationAssets, readLocationAssets } from "./load-assets";
import { backupAssets, restoreAssets } from "./backup";
import { greatCircleMiles, STUDY_RING_VERTICES, type Position } from "./geometry";
import { feedsFor } from "./sources";

/**
 * HIFLD Transmission_Lines misapplies `distance` (US-feet state plane), so its
 * spatial filter must be the study polygon with no linear unit, and the query
 * string must stay under the 2,048-character GET limit of ArcGIS Online's front end.
 */
function assertStudyPolygonQuery(url: URL, center: Position, radiusMiles: number) {
  assert.equal(url.searchParams.get("geometryType"), "esriGeometryPolygon");
  assert.equal(url.searchParams.get("inSR"), "4326");
  assert.equal(url.searchParams.get("spatialRel"), "esriSpatialRelIntersects");
  assert.equal(url.searchParams.has("distance"), false);
  assert.equal(url.searchParams.has("units"), false);
  assert.ok(url.search.length < 2048, `query string ${url.search.length} chars`);
  assert.match(url.search, /&geometry=\{%22rings%22:\[\[\[-?\d/);
  const { rings } = JSON.parse(url.searchParams.get("geometry")!) as { rings: Position[][] };
  assert.equal(rings.length, 1);
  const [ring] = rings;
  assert.equal(ring.length, STUDY_RING_VERTICES + 1);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  // Every straight lon/lat edge stays at or beyond the great-circle radius, so nothing within it is excluded.
  for (let i = 1; i < ring.length; i += 1) {
    for (let step = 0; step <= 100; step += 1) {
      const t = step / 100;
      const point: Position = [ring[i - 1][0] + t * (ring[i][0] - ring[i - 1][0]), ring[i - 1][1] + t * (ring[i][1] - ring[i - 1][1])];
      assert.ok(greatCircleMiles(center, point) >= radiusMiles, `edge ${i} comes within ${greatCircleMiles(center, point)} mi`);
    }
  }
}

test("ArcGIS collection pins all feature pages and rejects an incomplete inventory", async (t) => {
  const prior = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const scratch = stateRoot();
  t.after(async () => {
    if (prior === undefined) delete process.env.ETL_STATE_NAMESPACE;
    else process.env.ETL_STATE_NAMESPACE = prior;
    await rm(scratch, { recursive: true, force: true });
  });
  const ids = Array.from({ length: 101 }, (_, i) => 101 - i);
  let truncate = false;
  let pageCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.searchParams.get("returnIdsOnly") === "true") {
      assert.equal(url.searchParams.get("where"), "VOLTAGE >= 69");
      assert.equal(url.searchParams.has("returnCountOnly"), false);
      assertStudyPolygonQuery(url, [-118.0111, 33.7538], 100);
      return Response.json({ objectIdFieldName: "OBJECTID", objectIds: ids });
    }
    pageCalls += 1;
    const requested = url.searchParams.get("objectIds")!.split(",").map(Number);
    return Response.json({
      type: "FeatureCollection",
      features: requested.filter((id) => !truncate || id !== 101).reverse().map((id) => ({
        type: "Feature", properties: { OBJECTID: id },
        geometry: { type: "LineString", coordinates: [[-118, 34], [-117, 34]] },
      })),
    });
  });
  const query = locationQuery(33.7538, -118.0111, 100);
  const capture = await collectAssets(query, "hifld-transmission");
  assert.equal(capture.features, 101);
  const fromDisk = await replayAssets(JSON.parse(await readFile(capture.path, "utf8")));
  assert.equal(fromDisk.features[0].id, "hifld-transmission:1");
  assert.equal(fromDisk.features[0].citation.locator, "/features/99");
  assert.equal(pageCalls, 2);
  truncate = true;
  await assert.rejects(collectAssets(query, "hifld-transmission"), /Incomplete ArcGIS inventory/);
});

test("substation audit requires reviewed identity and preserves source conflicts", async (t) => {
  const prior = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const scratch = stateRoot();
  t.after(async () => {
    if (prior === undefined) delete process.env.ETL_STATE_NAMESPACE;
    else process.env.ETL_STATE_NAMESPACE = prior;
    await rm(scratch, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.searchParams.get("returnIdsOnly") === "true") {
      // Point layers keep the server-side statute-mile distance, which they honour.
      assert.equal(url.searchParams.get("geometryType"), "esriGeometryPoint");
      assert.equal(url.searchParams.get("geometry"), "-118,34");
      assert.equal(url.searchParams.get("distance"), "5");
      assert.equal(url.searchParams.get("units"), "esriSRUnit_StatuteMile");
      return Response.json({ objectIdFieldName: "OBJECTID", objectIds: [7, 8] });
    }
    return Response.json({ type: "FeatureCollection", features: [{
      // The live layer has no OWNER or OPERATOR; they are present here to prove neither is mapped.
      type: "Feature", properties: { OBJECTID: 7, NAME: "Example Station", OPERATOR: "Utility B", OWNER: "Utility C", MAX_VOLT: 230 },
      geometry: { type: "Point", coordinates: [-118, 34] },
    }, {
      type: "Feature",
      properties: { OBJECTID: 8, ID: "300101", NAME: "TAP300101", TYPE: "TAP", MAX_VOLT: -999999, MIN_VOLT: -999999 },
      geometry: { type: "Point", coordinates: [-118.01, 34] },
    }] });
  });
  const manifest = await collectAssets(locationQuery(34, -118, 5), "hifld-substations");
  const loaded = await loadLocationAssets([manifest.path]);
  const revision = await readLocationAssets(loaded.location, loaded.revision);
  assert.ok(revision);
  const { datasets } = revision.data as {
    datasets: {
      field_notes: Record<string, string>;
      counts: { features: number; missing: Record<string, number> };
      features: { features: { properties: Record<string, unknown>; citations: Record<string, { locator: string }> }[] };
    }[];
  };
  const normalized = datasets[0].features.features[0];
  assert.equal(normalized.properties.owner, null);
  assert.equal(Object.hasOwn(normalized.citations, "owner"), false);
  assert.match(datasets[0].field_notes.owner, /no OWNER or OPERATOR field/);
  assert.equal(normalized.properties.maximum_voltage_kv, 230);
  // TAP placeholder: kept as a record, name and -999999 voltages unavailable, TYPE exposed.
  const tap = datasets[0].features.features[1];
  assert.deepEqual(tap.properties,
    { name: null, maximum_voltage_kv: null, minimum_voltage_kv: null, type: "TAP", owner: null });
  assert.equal(tap.citations.name.locator, "/features/1/properties/NAME");
  assert.equal(datasets[0].counts.features, 2);
  assert.deepEqual(datasets[0].counts.missing,
    { name: 1, maximum_voltage_kv: 1, minimum_voltage_kv: 2, type: 1, owner: 2 });
  assert.equal(normalized.citations.name.locator, "/features/0/properties/NAME");
  assert.equal(Object.hasOwn(normalized, "study_clip"), false);
  assert.equal(Object.hasOwn(datasets[0], "mileage"), false);
  assert.equal((await loadLocationAssets([manifest.path])).revision, loaded.revision);
  const oldKey = process.env.ETL_BACKUP_KEY;
  const originalNamespace = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_BACKUP_KEY = "cd".repeat(32);
  const backup = `${stateRoot()}/assets.backup.json`;
  await backupAssets(loaded.location, loaded.revision, backup);
  process.env.ETL_STATE_NAMESPACE = `restore-${randomUUID()}`;
  const restoreScratch = stateRoot();
  t.after(() => rm(restoreScratch, { recursive: true, force: true }));
  const restored = await restoreAssets(backup);
  assert.notEqual(restored.revision, loaded.revision);
  assert.ok(await readLocationAssets(loaded.location, restored.revision));
  if (originalNamespace === undefined) delete process.env.ETL_STATE_NAMESPACE;
  else process.env.ETL_STATE_NAMESPACE = originalNamespace;
  if (oldKey === undefined) delete process.env.ETL_BACKUP_KEY;
  else process.env.ETL_BACKUP_KEY = oldKey;
  await assert.rejects(loadLocationAssets([manifest.path, manifest.path]), /Only one manifest/);
  const osm = `${stateRoot()}/osm.geojson`;
  const crosswalk = `${stateRoot()}/crosswalk.json`;
  await atomicJson(osm, { features: [
    { properties: { osm_id: "node/17", operator: "Utility A", voltage_kv: 115 } },
    { properties: { osm_id: "way/18", name: "Other Station" } },
  ] });
  const { pages } = JSON.parse(await readFile(manifest.path, "utf8"));
  const row = { osm: "node/17", hifld: "hifld-substations:7", snapshot: pages[0].id, evidence: "Reviewed fixture" };
  await atomicJson(crosswalk, [row]);
  const result = await auditSubstations(osm, manifest.path, crosswalk);
  assert.deepEqual(result.unmatchedOsm, ["way/18"]);
  assert.equal(result.comparisons[0].name.status, "missing");
  assert.equal(result.comparisons[0].operator.status, "conflict");
  assert.equal(result.comparisons[0].hifldOwner, "Utility C");
  assert.equal(result.comparisons[0].voltage.status, "incomparable");
  assert.equal(result.comparisons[0].citation.locator, "/features/0");
  await atomicJson(crosswalk, [row, { ...row, osm: "way/18" }]);
  await assert.rejects(auditSubstations(osm, manifest.path, crosswalk), /ambiguous crosswalk/);
});

test("loaded transmission lines carry inside-radius mileage and keep provider geometry", async (t) => {
  const prior = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const scratch = stateRoot();
  t.after(async () => {
    if (prior === undefined) delete process.env.ETL_STATE_NAMESPACE;
    else process.env.ETL_STATE_NAMESPACE = prior;
    await rm(scratch, { recursive: true, force: true });
  });
  const crossing = { type: "LineString", coordinates: [[-118.5, 34], [-117.5, 34]] };
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.searchParams.get("returnIdsOnly") === "true") {
      return Response.json({ objectIdFieldName: "OBJECTID", objectIds: [1, 2, 3] });
    }
    return Response.json({ type: "FeatureCollection", features: [
      { type: "Feature", properties: { OBJECTID: 1, VOLTAGE: 230, OWNER: "Utility A" }, geometry: crossing },
      { type: "Feature", properties: { OBJECTID: 2, VOLTAGE: -999999 },
        geometry: { type: "MultiLineString", coordinates: [[[-118, 34], [-118.05, 34.02]]] } },
      { type: "Feature", properties: { OBJECTID: 3, VOLTAGE: 500 },
        geometry: { type: "LineString", coordinates: [[-118.2, 35], [-117.8, 35]] } },
    ] });
  });
  const manifest = await collectAssets(locationQuery(34, -118, 10), "hifld-transmission");
  const loaded = await loadLocationAssets([manifest.path]);
  assert.equal((await loadLocationAssets([manifest.path])).revision, loaded.revision);
  const stored = await readLocationAssets(loaded.location, loaded.revision);
  assert.ok(stored);
  type Clip = { inside_miles: number; total_miles: number; segments: number; status: string; voltage_band: string };
  const [dataset] = (stored.data as { datasets: {
    mileage: { radius_miles: number; center: number[]; inside_miles_total: number; provider_miles_total: number;
      by_voltage_band: Record<string, number>; counts: Record<string, number> };
    features: { features: { id: string; geometry: unknown; study_clip: Clip }[] };
  }[] }).datasets;
  const byId = new Map(dataset.features.features.map((record) => [record.id, record]));
  const line = byId.get("hifld-transmission:1")!;
  assert.deepEqual(line.geometry, crossing);
  assert.equal(line.study_clip.status, "crossing");
  assert.equal(line.study_clip.segments, 1);
  assert.equal(line.study_clip.voltage_band, "230-345");
  assert.ok(Math.abs(line.study_clip.inside_miles - 20) <= 0.02, `inside ${line.study_clip.inside_miles}`);
  assert.ok(line.study_clip.total_miles > 50);
  const sentinel = byId.get("hifld-transmission:2")!.study_clip;
  assert.equal(sentinel.status, "inside");
  assert.equal(sentinel.inside_miles, sentinel.total_miles);
  assert.equal(sentinel.voltage_band, "unknown");
  assert.deepEqual(byId.get("hifld-transmission:3")!.study_clip,
    { ...byId.get("hifld-transmission:3")!.study_clip, inside_miles: 0, segments: 0, status: "outside", voltage_band: "500-765" });
  assert.deepEqual(dataset.mileage.counts, { inside: 1, crossing: 1, outside: 1 });
  assert.equal(dataset.mileage.radius_miles, 10);
  assert.deepEqual(dataset.mileage.center, [34, -118]);
  assert.deepEqual(Object.keys(dataset.mileage.by_voltage_band), ["230-345", "500-765", "unknown"]);
  assert.equal(dataset.mileage.by_voltage_band["500-765"], 0);
  assert.equal(dataset.mileage.inside_miles_total,
    Math.round((line.study_clip.inside_miles + sentinel.inside_miles) * 100) / 100);
  assert.ok(dataset.mileage.provider_miles_total > dataset.mileage.inside_miles_total);
});

test("the transmission count feed sends the study polygon and point feeds keep their distance query", () => {
  const feeds = new Map(feedsFor(locationQuery(33.7538, -118.0111, 100)).map((feed) => [feed.source.id, feed]));
  const transmission = feeds.get("hifld-transmission")!;
  assert.equal(transmission.url.searchParams.get("returnCountOnly"), "true");
  assert.equal(transmission.url.searchParams.get("where"), "VOLTAGE >= 69");
  assertStudyPolygonQuery(transmission.url, [-118.0111, 33.7538], 100);
  assert.match(transmission.source.access.notes ?? "", /polygon/);
  for (const id of ["hifld-substations", "eia-atlas-plants"]) {
    const { searchParams } = feeds.get(id)!.url;
    assert.equal(searchParams.get("geometryType"), "esriGeometryPoint", id);
    assert.equal(searchParams.get("distance"), "100", id);
    assert.equal(searchParams.get("units"), "esriSRUnit_StatuteMile", id);
  }
});

test("direct-current lines are banded dc from VOLT_CLASS or TYPE, never as AC voltage", async (t) => {
  const prior = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const scratch = stateRoot();
  t.after(async () => {
    if (prior === undefined) delete process.env.ETL_STATE_NAMESPACE;
    else process.env.ETL_STATE_NAMESPACE = prior;
    await rm(scratch, { recursive: true, force: true });
  });
  const inside = { type: "LineString", coordinates: [[-118, 34], [-118, 34.05]] };
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.searchParams.get("returnIdsOnly") === "true") {
      return Response.json({ objectIdFieldName: "OBJECTID", objectIds: [1, 2, 3] });
    }
    // Shapes of the two live DC records: Pacific DC Intertie (VOLT_CLASS DC, TYPE AC, VOLTAGE 1000)
    // and Intermountain-Adelanto (TYPE "DC, OVERHEAD", VOLT_CLASS 500).
    return Response.json({ type: "FeatureCollection", features: [
      { type: "Feature", properties: { OBJECTID: 1, VOLTAGE: 1000, VOLT_CLASS: "DC", TYPE: "AC" }, geometry: inside },
      { type: "Feature", properties: { OBJECTID: 2, VOLTAGE: 500, VOLT_CLASS: "500", TYPE: "DC, OVERHEAD" }, geometry: inside },
      { type: "Feature", properties: { OBJECTID: 3, VOLTAGE: 500, VOLT_CLASS: "500", TYPE: "AC, OVERHEAD" }, geometry: inside },
    ] });
  });
  const manifest = await collectAssets(locationQuery(34, -118, 10), "hifld-transmission");
  const loaded = await loadLocationAssets([manifest.path]);
  const stored = await readLocationAssets(loaded.location, loaded.revision);
  assert.ok(stored);
  const [dataset] = (stored.data as { datasets: {
    field_notes: Record<string, string>;
    mileage: { by_voltage_band: Record<string, number> };
    features: { features: { id: string; properties: Record<string, unknown>; study_clip: { voltage_band: string; inside_miles: number } }[] };
  }[] }).datasets;
  const band = (id: number) => dataset.features.features.find((record) => record.id === `hifld-transmission:${id}`)!;
  assert.equal(band(1).study_clip.voltage_band, "dc");
  assert.equal(band(1).properties.voltage_kv, 1000);
  assert.equal(band(1).properties.voltage_class, "DC");
  assert.equal(band(2).study_clip.voltage_band, "dc");
  assert.equal(band(2).properties.type, "DC, OVERHEAD");
  assert.equal(band(3).study_clip.voltage_band, "500-765");
  assert.deepEqual(Object.keys(dataset.mileage.by_voltage_band), ["500-765", "dc"]);
  assert.equal(dataset.mileage.by_voltage_band.dc,
    Math.round((band(1).study_clip.inside_miles + band(2).study_clip.inside_miles) * 100) / 100);
  assert.match(dataset.field_notes.voltage_band, /VOLT_CLASS is DC or TYPE begins with DC/);
});

test("audit name comparison ignores case, punctuation and generic words but keeps raw values", async (t) => {
  assert.equal(substationNameKey("Lucas Substation (electricity)"), "lucas");
  assert.equal(substationNameKey("LUCAS"), "lucas");
  assert.equal(substationNameKey("Mira Loma Sub"), substationNameKey("MIRALOMA"));
  assert.equal(substationNameKey("Barre 230kV Substation"), "barre");
  assert.equal(substationNameKey("Substation"), null);
  assert.equal(substationNameKey("Bahía"), "bahia");
  assert.notEqual(substationNameKey("Santiago Substation"), substationNameKey("VIEJO"));
  const prior = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const scratch = stateRoot();
  t.after(async () => {
    if (prior === undefined) delete process.env.ETL_STATE_NAMESPACE;
    else process.env.ETL_STATE_NAMESPACE = prior;
    await rm(scratch, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.searchParams.get("returnIdsOnly") === "true") {
      return Response.json({ objectIdFieldName: "FID", objectIds: [1, 2, 3] });
    }
    return Response.json({ type: "FeatureCollection", features: [
      { type: "Feature", properties: { FID: 1, ID: "300001", NAME: "LUCAS" }, geometry: { type: "Point", coordinates: [-118, 34] } },
      { type: "Feature", properties: { FID: 2, ID: "300002", NAME: "VIEJO" }, geometry: { type: "Point", coordinates: [-118.1, 34] } },
      { type: "Feature", properties: { FID: 3, ID: "300003", NAME: "FAIRMONT" }, geometry: { type: "Point", coordinates: [-118.2, 34] } },
    ] });
  });
  const manifest = await collectAssets(locationQuery(34, -118, 20), "hifld-substations");
  const osm = `${stateRoot()}/osm.geojson`;
  const crosswalk = `${stateRoot()}/crosswalk.json`;
  await atomicJson(osm, { features: [
    { properties: { osm_id: "way/1", name: "Lucas Substation (electricity)" } },
    { properties: { osm_id: "way/2", name: "Santiago Substation" } },
    { properties: { osm_id: "way/3", name: "Substation" } },
  ] });
  const { pages } = JSON.parse(await readFile(manifest.path, "utf8"));
  await atomicJson(crosswalk, [1, 2, 3].map((n) => ({
    osm: `way/${n}`, hifld: `hifld-substations:${n}`, snapshot: pages[0].id, evidence: "Reviewed fixture",
  })));
  const { comparisons } = await auditSubstations(osm, manifest.path, crosswalk);
  assert.deepEqual(comparisons.map(({ name }) => name), [
    { osm: "Lucas Substation (electricity)", hifld: "LUCAS", status: "agreement" },
    { osm: "Santiago Substation", hifld: "VIEJO", status: "conflict" },
    { osm: "Substation", hifld: "FAIRMONT", status: "missing" },
  ]);
});
