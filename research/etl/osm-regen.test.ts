import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Position } from "./geometry";
import { buildPbf, type FixtureNode, type FixtureWay } from "./fixtures/osm/pbf-encoder";
import {
  buildLayers,
  CENTER,
  centroid,
  collectOsm,
  diffLayers,
  displacement,
  INFERRED_RULES,
  lineVoltageSelected,
  maxVoltageKv,
  NodeCoordIndex,
  parseCurlHeaders,
  parseVoltageKv,
  round5,
  runOsmRegenCommand,
  withinRadius,
  type Collection,
} from "./osm-regen";

const [LON0, LAT0] = CENTER;

test("voltage parsing matches the committed normalisation", () => {
  assert.deepEqual(parseVoltageKv("230000;66000"), [230, 66]);
  assert.equal(maxVoltageKv("230000;66000"), 230);
  assert.equal(maxVoltageKv("34500;4800"), 34.5);
  assert.equal(maxVoltageKv("138000;"), 138);
  assert.equal(maxVoltageKv("66000/12000"), null); // committed: null, line kept as "untagged"
  assert.equal(maxVoltageKv(undefined), null);
  assert.equal(maxVoltageKv("0"), 0);
  assert.equal(lineVoltageSelected("69000"), true);
  assert.equal(lineVoltageSelected("66000"), false);
  assert.equal(lineVoltageSelected("69000;66000"), true);
  assert.equal(lineVoltageSelected("0"), false); // HVDC electrode lines are excluded
  assert.equal(lineVoltageSelected(undefined), true);
  assert.equal(lineVoltageSelected("66000/12000"), true);
});

test("coordinate rounding is toFixed(5), not Math.round", () => {
  assert.equal(round5(-117.183835), -117.18384);
  assert.equal(Math.round(-117.183835 * 1e5) / 1e5, -117.18383);
  assert.equal(round5(32.903985), 32.90398);
});

test("ref_mean centroid counts the repeated closing node of a closed way", () => {
  const ring: Position[] = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];
  assert.deepEqual(centroid(ring, "ref_mean"), [0.8, 0.8]);
  assert.deepEqual(centroid(ring, "vertex_mean"), [1, 1]);
  assert.deepEqual(centroid(ring, "bbox"), [1, 1]);
  assert.deepEqual(centroid(ring, "area"), [1, 1]);
});

test("segment radius semantics keep a way whose interior, not its vertices, enters the circle", () => {
  const chord: Position[] = [[LON0 - 2.2, LAT0 + 1], [LON0 + 2.2, LAT0 + 1]];
  assert.equal(withinRadius(chord, chord[0], "vertex"), false);
  assert.equal(withinRadius(chord, chord[0], "segment"), true);
});

test("node coordinate index is sorted, deduplicated and typed-array backed", () => {
  const index = new NodeCoordIndex([30, 10, 20, 10, 12_000_000_000]);
  assert.deepEqual([...index.ids], [10, 20, 30, 12_000_000_000]);
  index.set(20, 1.5, 2.5, 99);
  index.set(999, 0, 0, 0); // not wanted: ignored
  assert.deepEqual(index.get(20), { lon: 2.5, lat: 1.5, ts: 99 });
  assert.equal(index.get(10), null);
  assert.equal(index.found, 1);
});

test("displacement: pairwise when counts match, Hausdorff otherwise", () => {
  const a: Position[] = [[0, 0], [0, 0.001]];
  assert.equal(displacement(a, a).max, 0);
  const moved: Position[] = [[0, 0], [0, 0.002]];
  assert.ok(Math.abs(displacement(a, moved).max - 111.2) < 0.5);
  assert.equal(displacement(a, [[0, 0], [0, 0.0005], [0, 0.001]]).method, "hausdorff_vertices");
});

test("curl header dump parsing takes the final response", () => {
  const dump = "HTTP/1.1 307 Temporary Redirect\r\nLocation: x\r\n\r\nHTTP/1.1 200 OK\r\nETag: \"abc\"\r\nContent-Length: 10\r\n\r\n";
  assert.deepEqual(parseCurlHeaders(dump), { statuses: [307, 200], final: { etag: '"abc"', "content-length": "10" } });
});

/* ------------------------------ end to end ------------------------------- */

const T_OLD = 1_600_000_000; // 2020
const T_NEW = 1_790_000_000; // 2026-09
const n = (id: number, dLon: number, dLat: number, timestamp = T_OLD, tags?: Record<string, string>): FixtureNode => ({
  id,
  lon: Math.round((LON0 + dLon) * 1e7) / 1e7,
  lat: Math.round((LAT0 + dLat) * 1e7) / 1e7,
  timestamp,
  tags,
});

const NODES: FixtureNode[] = [
  n(1, 0.01, 0.01),
  n(2, 0.02, 0.01),
  n(3, 0.02, 0.02),
  n(4, 0.03, 0.03, T_NEW), // moved after the "snapshot"
  n(5, -2.2, 1),
  n(6, 2.2, 1),
  n(7, 0.1, 0.1),
  n(8, 0.1, 0.11),
  n(50, 0.0123456, 0.0234567, T_OLD, { power: "substation", name: "Node Sub" }),
  n(51, 0, 1.47, T_OLD, { power: "substation" }), // ~101.6 mi north: outside
];

const WAYS: FixtureWay[] = [
  { id: 100, refs: [1, 2], tags: { power: "line", voltage: "230000;66000", name: "Keep" }, timestamp: T_OLD },
  { id: 101, refs: [2, 3], tags: { power: "line", voltage: "66000" }, timestamp: T_OLD }, // below 69 kV
  { id: 102, refs: [3, 4], tags: { power: "line" }, timestamp: T_OLD }, // untagged: kept; node 4 moved
  { id: 103, refs: [5, 6], tags: { power: "line", voltage: "500000" }, timestamp: T_OLD }, // chord crossing
  { id: 104, refs: [7, 8], tags: { power: "line", voltage: "0" }, timestamp: T_OLD }, // electrode: excluded
  { id: 105, refs: [1, 3], tags: { power: "line", voltage: "115000", name: "Renamed" }, version: 3, timestamp: T_NEW },
  { id: 106, refs: [7, 8], tags: { power: "line", voltage: "138000" }, version: 1, timestamp: T_NEW + 100 }, // created after snapshot
  { id: 200, refs: [1, 2, 3, 1], tags: { power: "substation", substation: "distribution", voltage: "66000;12000" }, timestamp: T_OLD },
  { id: 201, refs: [7, 8, 1, 7], tags: { building: "yes" }, timestamp: T_OLD },
];

function committedFrom(features: Array<{ id: number | string; coords: Position | Position[]; props: Record<string, unknown> }>, point: boolean) {
  return {
    type: "FeatureCollection" as const,
    features: features.map((f) => ({
      type: "Feature",
      geometry: point ? { type: "Point", coordinates: f.coords } : { type: "LineString", coordinates: f.coords },
      properties: { osm_id: f.id, ...f.props },
    })),
  };
}

const at = (id: number): Position => {
  const node = NODES.find((x) => x.id === id)!;
  return [round5(node.lon), round5(node.lat)];
};

const lineProps = (voltage_kv: number | null, name: string | null = null) => ({ voltage_kv, operator: null, name, cables: null, circuits: null, line: null });

function committedLayers() {
  const ring = [1, 2, 3, 1].map((id) => NODES.find((x) => x.id === id)!);
  const mean: Position = [round5(ring.reduce((s, x) => s + x.lon, 0) / 4), round5(ring.reduce((s, x) => s + x.lat, 0) / 4)];
  const substations = committedFrom(
    [
      { id: "node/50", coords: at(50), props: { name: "Node Sub", operator: null, voltage_kv: null, substation: null } },
      { id: "way/200", coords: mean, props: { name: null, operator: null, voltage_kv: 66, substation: "distribution" } },
    ],
    true,
  );
  const transmission = committedFrom(
    [
      { id: 100, coords: [at(1), at(2)], props: lineProps(230, "Keep") },
      { id: 102, coords: [at(3), [round5(LON0 + 0.031), round5(LAT0 + 0.03)]], props: lineProps(null) },
      { id: 103, coords: [at(5), at(6)], props: lineProps(500) },
      { id: 105, coords: [at(1), at(3)], props: lineProps(115, "Old name") },
      { id: 999, coords: [at(1), at(2)], props: lineProps(69) }, // deleted from OSM
    ],
    false,
  );
  return { substations, transmission };
}

async function withFixture(fn: (dir: string, pbf: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "osm-regen-test-"));
  try {
    const pbf = join(dir, "fixture.osm.pbf");
    await writeFile(pbf, buildPbf({ nodes: NODES, ways: WAYS, relations: [{ id: 300, members: [{ type: "way", ref: 201, role: "outer" }], tags: { power: "substation" } }] }));
    await fn(dir, pbf);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("collect + build + diff over a hand-built PBF classifies every difference", async () => {
  await withFixture(async (_dir, pbf) => {
    const committed = committedLayers();
    const osm = await collectOsm(pbf, { nodes: new Set([50]), ways: new Set([200, 100, 102, 103, 105, 999]), relations: new Set() });
    assert.equal(osm.relations.size, 1);
    assert.ok(osm.ways.has(201), "pass 1b fetched the relation's member way");
    assert.equal(osm.stats.resolvedNodes, osm.stats.neededNodes);

    const built = buildLayers(osm, INFERRED_RULES);
    assert.deepEqual(built.substations.features.map((f) => f.properties.osm_id), ["node/50", "way/200"]);
    assert.ok(built.substationEvals.get("node/51")!.reasons.includes("outside_radius"));
    assert.ok(built.substationEvals.get("relation/300")!.reasons.includes("relations_excluded"));
    assert.deepEqual(built.transmission.features.map((f) => f.properties.osm_id), [100, 102, 103, 105, 106]);
    assert.deepEqual(built.lineEvals.get("101")!.reasons, ["below_69kv"]);
    assert.deepEqual(built.lineEvals.get("104")!.reasons, ["below_69kv"]);
    const keep = built.transmission.features[0];
    assert.equal(keep.properties.voltage_kv, 230);
    assert.deepEqual(keep.osm?.tags, { power: "line", voltage: "230000;66000", name: "Keep" });
    assert.deepEqual(keep.osm?.nodes, [1, 2]);
    assert.equal(keep.osm?.version, 1);

    const diff = diffLayers({ committedSubstations: committed.substations, committedTransmission: committed.transmission, built });
    const byId = new Map(diff.entries.map((e) => [`${e.layer}:${e.id}`, e]));
    assert.deepEqual(byId.get("substations:node/50")!.classes, ["unchanged"]);
    assert.deepEqual(byId.get("substations:way/200")!.classes, ["unchanged"]);
    assert.deepEqual(byId.get("transmission:100")!.classes, ["unchanged"]);
    assert.deepEqual(byId.get("transmission:103")!.classes, ["unchanged"]);
    const moved = byId.get("transmission:102")!;
    assert.deepEqual(moved.classes, ["geometry_changed"]);
    assert.ok(moved.geometry!.max_displacement_m > 80 && moved.geometry!.max_displacement_m < 100);
    assert.equal(moved.cause, "osm_edit_after_snapshot");
    const renamed = byId.get("transmission:105")!;
    assert.deepEqual(renamed.fields, [{ field: "name", committed: "Old name", regen: "Renamed" }]);
    assert.equal(renamed.baseline_version, "unknown");
    const removed = byId.get("transmission:999")!;
    assert.deepEqual(removed.classes, ["removed"]);
    assert.equal(removed.cause, "element_absent_from_extract");
    const added = byId.get("transmission:106")!;
    assert.deepEqual(added.classes, ["added"]);
    assert.equal(added.cause, "osm_edit_after_snapshot");
    assert.deepEqual(diff.counts.transmission, { unchanged: 2, geometry_changed: 1, property_changed: 1, removed: 1, added: 1 });
    assert.equal(diff.snapshot.transmission.lower_bound, new Date(T_OLD * 1000).toISOString());
    assert.ok(diff.boundary.some((b) => b.kind === "voltage_parse" && b.id === "100"));
  });
});

test("runOsmRegenCommand pin + regen writes outputs outside public/ and refuses public/", async () => {
  await withFixture(async (dir, pbf) => {
    const committed = committedLayers();
    const layers = join(dir, "layers");
    await mkdir(layers);
    await writeFile(join(layers, "substations.geojson"), JSON.stringify(committed.substations));
    await writeFile(join(layers, "transmission.geojson"), JSON.stringify(committed.transmission));
    const headers = join(dir, "headers.txt");
    const size = (await readFile(pbf)).length;
    await writeFile(headers, `HTTP/1.1 200 OK\r\nContent-Length: ${size}\r\nETag: "e"\r\nLast-Modified: Sat, 14 Nov 2026 02:10:51 GMT\r\n\r\n`);
    const manifest = join(dir, "manifest.json");
    const log = console.log;
    console.log = () => {};
    try {
      await runOsmRegenCommand(["pin", "--pbf", pbf, "--url", "https://example.invalid/x.osm.pbf", "--headers", headers, "--out", manifest]);
      const out = join(dir, "regen");
      await runOsmRegenCommand(["regen", "--pbf", pbf, "--manifest", manifest, "--committed", layers, "--out", out]);
      const pinned = JSON.parse(await readFile(manifest, "utf8"));
      assert.equal(pinned.size_bytes, size);
      assert.match(pinned.sha256, /^[0-9a-f]{64}$/);
      assert.equal(pinned.header.osmosis_replication_sequence_number, 2911);
      const regen = JSON.parse(await readFile(join(out, "transmission.geojson"), "utf8")) as Collection<{ properties: { osm_id: number } }>;
      assert.deepEqual(regen.features.map((f) => f.properties.osm_id), [100, 102, 103, 105, 106]);
      const diff = JSON.parse(await readFile(join(out, "diff.json"), "utf8"));
      assert.equal(diff.counts.transmission.removed, 1);
      await assert.rejects(
        runOsmRegenCommand(["regen", "--pbf", pbf, "--manifest", manifest, "--committed", layers, "--out", "public/layers"]),
        /Refusing to write/,
      );
    } finally {
      console.log = log;
    }
  });
});

test("regen hashes the PBF and refuses a manifest whose sha256 does not match", async () => {
  await withFixture(async (dir, pbf) => {
    const committed = committedLayers();
    const layers = join(dir, "layers");
    await mkdir(layers);
    await writeFile(join(layers, "substations.geojson"), JSON.stringify(committed.substations));
    await writeFile(join(layers, "transmission.geojson"), JSON.stringify(committed.transmission));
    const manifest = join(dir, "manifest.json");
    await writeFile(manifest, JSON.stringify({ url: "https://example.invalid/x.osm.pbf", sha256: "0".repeat(64) }));
    const out = join(dir, "regen");
    const log = console.log;
    console.log = () => {};
    try {
      await assert.rejects(
        runOsmRegenCommand(["regen", "--pbf", pbf, "--manifest", manifest, "--committed", layers, "--out", out]),
        /PBF sha256 [0-9a-f]{64} does not match manifest sha256 0{64}/,
      );
      await assert.rejects(readFile(join(out, "substations.geojson")), { code: "ENOENT" });
    } finally {
      console.log = log;
    }
  });
});
