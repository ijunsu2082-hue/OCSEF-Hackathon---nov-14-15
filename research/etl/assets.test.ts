import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { collectAssets, replayAssets } from "./assets";
import { atomicJson, locationQuery, stateRoot } from "./pipeline";
import { auditSubstations } from "./substation-audit";
import { loadLocationAssets, readLocationAssets } from "./load-assets";
import { backupAssets, restoreAssets } from "./backup";

test("ArcGIS collection pins all feature pages and rejects an incomplete inventory", async (t) => {
  const prior = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  t.after(() => {
    if (prior === undefined) delete process.env.ETL_STATE_NAMESPACE;
    else process.env.ETL_STATE_NAMESPACE = prior;
  });
  const ids = Array.from({ length: 101 }, (_, i) => 101 - i);
  let truncate = false;
  let pageCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.searchParams.get("returnIdsOnly") === "true") {
      assert.equal(url.searchParams.get("where"), "VOLTAGE >= 69");
      assert.equal(url.searchParams.get("distance"), "100");
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
  t.after(() => {
    if (prior === undefined) delete process.env.ETL_STATE_NAMESPACE;
    else process.env.ETL_STATE_NAMESPACE = prior;
  });
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.searchParams.get("returnIdsOnly") === "true") {
      return Response.json({ objectIdFieldName: "OBJECTID", objectIds: [7] });
    }
    return Response.json({ type: "FeatureCollection", features: [{
      type: "Feature", properties: { OBJECTID: 7, NAME: "Example Station", OPERATOR: "Utility B", OWNER: "Utility C", MAX_VOLT: 230 },
      geometry: { type: "Point", coordinates: [-118, 34] },
    }] });
  });
  const manifest = await collectAssets(locationQuery(34, -118, 5), "hifld-substations");
  const loaded = await loadLocationAssets([manifest.path]);
  const revision = await readLocationAssets(loaded.location, loaded.revision);
  assert.ok(revision);
  const { datasets } = revision.data as {
    datasets: { features: { features: { properties: Record<string, unknown>; citations: Record<string, { locator: string }> }[] } }[];
  };
  const normalized = datasets[0].features.features[0];
  assert.equal(normalized.properties.owner, "Utility C");
  assert.equal(normalized.properties.maximum_voltage_kv, 230);
  assert.equal(normalized.citations.name.locator, "/features/0/properties/NAME");
  assert.equal((await loadLocationAssets([manifest.path])).revision, loaded.revision);
  const oldKey = process.env.ETL_BACKUP_KEY;
  const originalNamespace = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_BACKUP_KEY = "cd".repeat(32);
  const backup = `${stateRoot()}/assets.backup.json`;
  await backupAssets(loaded.location, loaded.revision, backup);
  process.env.ETL_STATE_NAMESPACE = `restore-${randomUUID()}`;
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
