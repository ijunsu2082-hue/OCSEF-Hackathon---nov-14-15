import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";
import { digest } from "./evidence/canonical";
import { assetsForSiteFromSource } from "./gridAssets.server";
import { stateRoot } from "../research/etl/pipeline";
import {
  adaptLocationAssets, clearEtlAssetCache, etlAssetsUrl, etlCacheKey, LOCATION_ASSETS_SCHEMA,
  type EtlDataset, type LoadedAssetsBody,
} from "./etlAssets";
import { loadPlants, loadSubstations, loadTransmission, type SubstationFeature } from "./gridLayers";
import { gridChain } from "./grid";
import { buildAssetIndex, summarizeAssets } from "./gridAssets";
import { listFacilities } from "./region";
import { simulate } from "./simulation";
import { loadGridData } from "./scan/data";
import { scanReportMarkdown } from "./scan/report";
import { scanArea } from "./scan/scan";

const LOCATION = "location-0123456789abcdef01234567";
const OTHER = "location-fedcba9876543210fedcba98";
const REVISION = "a".repeat(64);
const REPORT_A = "b".repeat(64);
const REPORT_B = "c".repeat(64);

const cite = (snapshot: string, locator: string) => ({ snapshot, locator });

function dataset(source: string, features: EtlDataset["features"]["features"]): EtlDataset {
  return {
    source, scope: { center: [33.78, -117.98], radius_miles: 10 }, snapshots: [{ id: `snp_${source.length}idx` }],
    counts: { features: features.length, missing: {} }, features: { type: "FeatureCollection", features },
  };
}

function loaded(datasets: EtlDataset[], location = LOCATION): LoadedAssetsBody {
  return { revision: REVISION, data: { schema: LOCATION_ASSETS_SCHEMA, location, datasets } };
}

const SYNTHETIC = loaded([
  dataset("eia-atlas-plants", [
    {
      id: "eia-atlas-plants:1", geometry: { type: "Point", coordinates: [-117.9, 33.7] },
      geometryCitation: cite("snp_plants", "/features/0/geometry"),
      properties: { name: "Alpha Peaker", plant_code: 101, utility_name: null },
      citations: { name: cite("snp_plants", "/features/0/properties/Plant_Name") },
    },
    {
      id: "eia-atlas-plants:2", geometry: { type: "Polygon", coordinates: [] },
      geometryCitation: cite("snp_plants", "/features/1/geometry"), properties: {}, citations: {},
    },
  ]),
  dataset("hifld-substations", [{
    id: "hifld-substations:7", geometry: { type: "Point", coordinates: [-118.0, 33.8] },
    geometryCitation: cite("snp_subs", "/features/0/geometry"),
    properties: { name: "Example Station", owner: null, maximum_voltage_kv: null },
    citations: { name: cite("snp_subs", "/features/0/properties/NAME") },
  }]),
  dataset("hifld-transmission", [
    {
      id: "hifld-transmission:1", geometry: { type: "LineString", coordinates: [[-118, 33.8], [-117.9, 33.7]] },
      geometryCitation: cite("snp_tx", "/features/0/geometry"),
      properties: { owner: "Utility C", voltage_kv: 230, status: "IN SERVICE" },
      citations: { voltage_kv: cite("snp_tx", "/features/0/properties/VOLTAGE") },
      study_clip: { inside_miles: 1 },
    },
    {
      id: "hifld-transmission:2",
      geometry: { type: "MultiLineString", coordinates: [[[-118, 33.9], [-117.8, 33.9]], [[-117.7, 33.9]], [[-117.6, 33.9], [-117.5, 33.8]]] },
      geometryCitation: cite("snp_tx", "/features/1/geometry"),
      properties: { owner: null, voltage_kv: null, status: null }, citations: {},
    },
    {
      id: "hifld-transmission:3", geometry: { type: "LineString", coordinates: [[-120, 36], [-120.1, 36.1]] },
      geometryCitation: cite("snp_tx", "/features/2/geometry"),
      properties: { owner: "Far Utility", voltage_kv: 500, status: "IN SERVICE" }, citations: {},
      study_clip: { inside_miles: 0, total_miles: 8.9, segments: 0, status: "outside", voltage_band: "345-499" },
    },
  ]),
]);

const BUNDLED = {
  plants: { type: "FeatureCollection", features: [{
    geometry: { type: "Point", coordinates: [-117.99, 33.77] },
    properties: {
      plant_code: 9, plant_name: "Bundled Plant", utility_name: "U", nameplate_mw: 50, mw_by_source: { solar: 50 },
      oldest_year: 2010, newest_year: 2010, planned_retirement_mw: 0, primary_source: "solar", technologies: ["pv"],
      capacity_weighted_age_years: 15,
    },
  }] },
  transmission: { type: "FeatureCollection", features: [{
    geometry: { type: "LineString", coordinates: [[-118.1, 33.7], [-118.0, 33.7]] },
    properties: { osm_id: 5, voltage_kv: 66, operator: "SCE", name: "Bundled Line" },
  }] },
  substations: { type: "FeatureCollection", features: [{
    geometry: { type: "Point", coordinates: [-118.05, 33.75] },
    properties: { osm_id: "way/1", name: "Bundled Sub", operator: "SCE", voltage_kv: 66, substation: "distribution" },
  }] },
  niche: [],
};

let calls: string[] = [];
let assetsResponse: (url: string) => Response = () => new Response(JSON.stringify({ error: "Location report unavailable" }), { status: 404 });

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  calls.push(url);
  if (url.startsWith("/api/location-report/")) return assetsResponse(url);
  const routes: Record<string, unknown> = {
    "/layers/plants.geojson": BUNDLED.plants,
    "/layers/transmission.geojson": BUNDLED.transmission,
    "/layers/substations.geojson": BUNDLED.substations,
    "/layers/niche_cases.json": BUNDLED.niche,
  };
  return url in routes ? json(routes[url]) : json({ error: "not found" }, 404);
}) as typeof fetch;

beforeEach(() => {
  calls = [];
  clearEtlAssetCache();
  assetsResponse = () => json({ error: "Location report unavailable" }, 404);
});

test("adapter maps a synthetic loaded inventory to the app layer shapes", () => {
  const adapted = adaptLocationAssets(SYNTHETIC);
  assert.equal(adapted.location, LOCATION);
  assert.equal(adapted.revision, REVISION);

  const plants = adapted.plants!;
  assert.equal(plants.features.length, 1);
  assert.equal(plants.meta.skipped, 1, "polygon plant is skipped, not coerced");
  const plant = plants.features[0];
  assert.deepEqual(plant.geometry, { type: "Point", coordinates: [-117.9, 33.7] });
  assert.equal(plant.properties.plant_name, "Alpha Peaker");
  assert.equal(plant.properties.plant_code, 101);

  const subs = adapted.substations!.features;
  assert.equal(subs.length, 1);
  assert.deepEqual(subs[0].properties, { name: "Example Station", operator: null, owner: null, voltage_kv: null, substation: null });

  const lines = adapted.transmission!.features;
  assert.equal(lines.length, 3, "LineString + two usable MultiLineString parts; the 1-point part is dropped");
  // HIFLD OWNER is the owner, never the operator: HIFLD publishes no operator field.
  assert.deepEqual(lines[0].properties, { voltage_kv: 230, operator: null, owner: "Utility C", name: null, status: "IN SERVICE" });
  assert.deepEqual(lines.slice(1).map((l) => l.etl.part), [0, 2]);
  assert.equal(adapted.transmission!.meta.outside_radius, 1, "study_clip status outside is excluded and counted");
  assert.equal(lines.some((l) => l.etl.id === "hifld-transmission:3"), false);
  assert.deepEqual(lines[1].geometry.coordinates, [[-118, 33.9], [-117.8, 33.9]]);
});

test("adapter keeps provider-absent fields null and never fills them", () => {
  const plant = adaptLocationAssets(SYNTHETIC).plants!.features[0];
  assert.equal(plant.properties.nameplate_mw, null);
  assert.equal(plant.properties.utility_name, null);
  for (const key of ["mw_by_source", "primary_source", "technologies", "planned_retirement_mw",
    "oldest_year", "newest_year", "capacity_weighted_age_years", "city", "county", "generator_count"] as const) {
    assert.equal(plant.properties[key], null, key);
  }
  const line = adaptLocationAssets(SYNTHETIC).transmission!.features[1];
  assert.deepEqual(line.properties, { voltage_kv: null, operator: null, owner: null, name: null, status: null });
});

test("adapter attaches per-feature provenance beside geometry/properties", () => {
  const adapted = adaptLocationAssets(SYNTHETIC);
  const sub = adapted.substations!.features[0];
  assert.deepEqual(sub.etl, {
    source: "hifld-substations", snapshot: "snp_subs", revision: REVISION, location: LOCATION,
    id: "hifld-substations:7", geometry_locator: "/features/0/geometry",
    citations: { name: cite("snp_subs", "/features/0/properties/NAME") },
  });
  assert.equal(adapted.transmission!.features[0].etl.snapshot, "snp_tx");
  assert.deepEqual(Object.keys(sub).sort(), ["etl", "geometry", "properties"]);
  assert.deepEqual(adapted.transmission!.meta.snapshots, ["snp_18idx"]);
});

test("adapter rejects a document that is not a loaded inventory", () => {
  assert.throws(() => adaptLocationAssets({ revision: REVISION, data: { schema: "other/1", location: LOCATION, datasets: [] } }));
});

test("no selector: loaders return the bundled collection untouched", async () => {
  const plain = await loadSubstations();
  assert.deepEqual(plain, BUNDLED.substations);
  assert.equal("source" in plain, false);
  assert.equal(calls.some((u) => u.startsWith("/api/")), false);
});

test("selector falls back to bundled layers on 404 and says why", async () => {
  const result = await loadSubstations({ locationId: LOCATION });
  assert.equal(result.source, "bundled");
  assert.match(result.fallback_reason ?? "", /404.*Location report unavailable/);
  assert.deepEqual(result.features, BUNDLED.substations.features);
  assert.equal(result.etl, null);
  assert.ok(calls.includes(`/api/location-report/${LOCATION}/assets`));
});

test("selector falls back on network failure and on an invalid location id without fetching", async () => {
  assetsResponse = () => { throw new TypeError("fetch failed"); };
  const failed = await loadTransmission({ locationId: LOCATION });
  assert.equal(failed.source, "bundled");
  assert.match(failed.fallback_reason ?? "", /fetch failed/);
  calls = [];
  const invalid = await loadTransmission({ locationId: "../../etc" });
  assert.equal(invalid.source, "bundled");
  assert.equal(calls.some((u) => u.startsWith("/api/")), false);
});

test("selector uses loaded assets and labels them etl, binding by ?report=", async () => {
  assetsResponse = () => json(SYNTHETIC, 200, { "X-Report-Revision": REPORT_A, "X-Asset-Revision": REVISION });
  const tx = await loadTransmission({ locationId: LOCATION, reportRevision: REPORT_A });
  assert.equal(tx.source, "etl");
  if (tx.source !== "etl") return;
  assert.equal(tx.features.length, 3);
  assert.equal(tx.etl.revision, REVISION);
  assert.equal(tx.etl.report_revision, REPORT_A);
  assert.ok(calls.includes(`/api/location-report/${LOCATION}/assets?report=${REPORT_A}`));
  const plants = await loadPlants({ locationId: LOCATION, reportRevision: REPORT_A });
  assert.equal(plants.source, "etl");
  assert.equal(plants.features[0].properties.nameplate_mw, null);
  assert.equal(calls.filter((u) => u.startsWith("/api/")).length, 1, "one inventory fetch shared by both layers");
});

test("a dataset missing from the inventory falls back for that layer only", async () => {
  assetsResponse = () => json(loaded([SYNTHETIC.data.datasets[1]]));
  const subs = await loadSubstations({ locationId: LOCATION });
  const tx = await loadTransmission({ locationId: LOCATION });
  assert.equal(subs.source, "etl");
  assert.equal(tx.source, "bundled");
  assert.match(tx.fallback_reason ?? "", /no transmission dataset/);
});

test("cache keys separate location and report revision; failures are not cached", async () => {
  assert.notEqual(etlCacheKey({ locationId: LOCATION, reportRevision: REPORT_A }), etlCacheKey({ locationId: LOCATION, reportRevision: REPORT_B }));
  assert.notEqual(etlCacheKey({ locationId: LOCATION }), etlCacheKey({ locationId: OTHER }));
  assert.equal(etlAssetsUrl({ locationId: LOCATION }), `/api/location-report/${LOCATION}/assets`);

  assetsResponse = (url) => json(url.includes(REPORT_B) ? loaded([SYNTHETIC.data.datasets[1]], OTHER) : SYNTHETIC);
  const a = await loadSubstations({ locationId: LOCATION, reportRevision: REPORT_A });
  const b = await loadSubstations({ locationId: LOCATION, reportRevision: REPORT_B });
  await loadSubstations({ locationId: LOCATION, reportRevision: REPORT_A });
  assert.equal(a.source === "etl" && a.etl.location, LOCATION);
  assert.equal(b.source === "etl" && b.etl.location, OTHER);
  assert.equal(calls.filter((u) => u.startsWith("/api/")).length, 2, "same key is served from cache");

  calls = [];
  assetsResponse = () => json({ error: "report has no bound asset inventory" }, 404);
  await loadSubstations({ locationId: OTHER });
  await loadSubstations({ locationId: OTHER });
  assert.equal(calls.filter((u) => u.startsWith("/api/")).length, 2, "a 404 is retried, not pinned");
});

test("loadGridData: absent gen_events/summary are reported unavailable instead of throwing", async () => {
  const grid = await loadGridData();
  assert.equal(grid.source, "bundled");
  assert.deepEqual(grid.events, []);
  assert.deepEqual(grid.unavailable, ["/layers/gen_events.json", "/layers/line_ratings/summary.json"]);
  assert.equal(grid.lines[0].name, "Bundled Line");
  assert.equal(grid.etl, null);
});

test("loadGridData with a selector takes lines and substations from ETL, keeps bundled plants", async () => {
  assetsResponse = () => json(SYNTHETIC, 200, { "X-Report-Revision": REPORT_A });
  const grid = await loadGridData({ locationId: LOCATION, reportRevision: REPORT_A });
  assert.equal(grid.source, "etl");
  assert.deepEqual(grid.layers, { plants: "bundled", lines: "etl", substations: "etl" });
  assert.equal(grid.lines.length, 3);
  assert.deepEqual(grid.lines[0].coords, [[33.8, -118], [33.7, -117.9]]);
  assert.equal(grid.substations[0].voltage_kv, null);
  assert.equal(grid.plants[0].plant_name, "Bundled Plant");
  assert.match(grid.fallback_reasons.join(";"), /no nameplate MW/);
  assert.deepEqual(grid.etl, { location: LOCATION, revision: REVISION, report_revision: REPORT_A });

  assetsResponse = () => json({ error: "Location report unavailable" }, 404);
  const bundled = await loadGridData({ locationId: OTHER });
  assert.equal(bundled.source, "bundled");
  assert.notEqual(bundled, grid, "different location → different cache entry");
});

test("scan report labels lines and substations with the layer's real provider", async () => {
  const area = { lat: 33.78, lon: -117.98, radius_mi: 10 };
  const rows = (md: string) => md.split("\n").filter((l) => l.startsWith("- Lines:") || l.startsWith("- Substations:"));

  assetsResponse = () => json(SYNTHETIC, 200, { "X-Report-Revision": REPORT_A });
  const etl = await loadGridData({ locationId: LOCATION, reportRevision: REPORT_A });
  assert.deepEqual(etl.layers, { plants: "bundled", lines: "etl", substations: "etl" });
  const etlMd = scanReportMarkdown(scanArea(etl, area), null, etl.layers);
  const etlRows = rows(etlMd);
  assert.equal(etlRows.length, 2);
  for (const row of etlRows) assert.ok(row.endsWith("(HIFLD)") && !row.includes("OSM"), row);
  assert.match(etlMd, /; HIFLD \(lines, substations\);/);
  assert.doesNotMatch(etlMd, /OpenStreetMap/);

  assetsResponse = () => json({ error: "Location report unavailable" }, 404);
  const bundled = await loadGridData();
  assert.deepEqual(bundled.layers, { plants: "bundled", lines: "bundled", substations: "bundled" });
  const bundledMd = scanReportMarkdown(scanArea(bundled, area), null, bundled.layers);
  // area-scan's enrichGrid may fill bundled OSM voltages, which the Lines row notes after the provider.
  for (const row of rows(bundledMd)) assert.match(row, /\(OSM(; some voltages filled in from connected lines)?\)$/, row);
  assert.match(bundledMd, /OpenStreetMap contributors, ODbL \(lines, substations\)/);
  assert.doesNotMatch(bundledMd, /HIFLD/);
  assert.equal(scanReportMarkdown(scanArea(bundled, area), null), bundledMd, "no layers argument reads as bundled OSM");

  const mixed = scanReportMarkdown(scanArea(bundled, area), null, { lines: "etl", substations: "bundled" });
  assert.ok(/\(HIFLD(; some voltages filled in from connected lines)?\)$/.test(rows(mixed)[0]) && rows(mixed)[1].endsWith("(OSM)"), rows(mixed).join(" | "));
  assert.match(mixed, /HIFLD \(lines\); OpenStreetMap contributors, ODbL \(substations\)/);
});

test("HIFLD owner is carried as owner and rendered 'owned by', never as the operator", async () => {
  const adapted = adaptLocationAssets(SYNTHETIC);
  // A substation source that does publish an owner (HIFLD Substations itself has no OWNER field).
  const ownedSub: SubstationFeature & { properties: { owner: string | null } } = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-117.95, 33.75] },
    properties: { osm_id: "node/1", name: "Owned Station", operator: null, owner: "Utility S", voltage_kv: 230, substation: null },
  };
  const index = buildAssetIndex([], adapted.transmission!.features, [...adapted.substations!.features, ownedSub]);
  const assets = summarizeAssets(index, [-117.95, 33.75]);
  assert.equal(assets.transmission!.nearest[0].operator, null);
  assert.equal(assets.transmission!.nearest[0].owner, "Utility C");
  assert.deepEqual(assets.transmission!.operators, [], "owners are not counted as operators");
  assert.equal(assets.substations!.nearest_named[0].owner, "Utility S");

  const facility = listFacilities()[0].properties;
  const chain = gridChain(facility, simulate(facility), { assets });
  const detail = (phase: string, id: string) =>
    chain.find((s) => s.id === phase)!.diagnostics.find((d) => d.id === id)!.detail;
  assert.match(detail("transmission", "coverage"), /owned by Utility C/);
  assert.doesNotMatch(detail("transmission", "coverage"), /\(Utility C\)|operated by/);
  assert.match(detail("substation", "nearest-transmission"), /owned by Utility S/);
  assert.doesNotMatch(detail("substation", "nearest-transmission"), /operated by/);

  assetsResponse = () => json(SYNTHETIC, 200, { "X-Report-Revision": REPORT_A });
  const grid = await loadGridData({ locationId: LOCATION, reportRevision: REPORT_A });
  const owner = (x: object) => (x as { owner?: unknown }).owner;
  assert.equal(grid.lines[0].operator, null);
  assert.equal(owner(grid.lines[0]), "Utility C");
  assert.equal(grid.substations[0].operator, null);
  assert.equal(owner(grid.substations[0]), null);
});

test("summarizeAssets: a confirmed-empty layer is an empty summary, an unconfirmed empty layer is unavailable", () => {
  const confirmed = summarizeAssets(buildAssetIndex([], [], [], { lines: true, substations: true }), [-117.95, 33.75]);
  assert.equal(confirmed.generation, null, "plants not confirmed: unavailable");
  assert.equal(confirmed.transmission?.line_count, 0);
  assert.equal(confirmed.transmission?.max_kv, null);
  assert.equal(confirmed.substations?.count, 0);
  const unconfirmed = summarizeAssets(buildAssetIndex([], [], []), [-117.95, 33.75]);
  assert.deepEqual(unconfirmed, { generation: null, transmission: null, substations: null });
});

test("assetsForSiteFromSource: loaded ETL layers with 0 features are confirmed-empty, not unavailable", async (t) => {
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const root = stateRoot();
  t.after(async () => {
    delete process.env.ETL_STATE_NAMESPACE;
    await rm(root, { recursive: true, force: true });
  });
  const data = { schema: LOCATION_ASSETS_SCHEMA, location: LOCATION, datasets: [
    dataset("hifld-transmission", []), dataset("hifld-substations", []),
  ] };
  const revision = digest(data);
  const directory = resolve(root, "loaded-assets", LOCATION);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${revision}.json`), JSON.stringify(data));
  const sourced = await assetsForSiteFromSource([-117.95, 33.75], { locationId: LOCATION, revision });
  assert.equal(sourced.source, "etl");
  assert.deepEqual(sourced.layers, { plants: "bundled", transmission: "etl", substations: "etl" });
  assert.ok(sourced.assets, "a loaded inventory is not unavailable");
  assert.equal(sourced.assets.transmission?.line_count, 0);
  assert.equal(sourced.assets.substations?.count, 0);
});
