import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import {
  decodeBlob,
  decodePrimitiveBlock,
  parseHeaderBlock,
  ProtoReader,
  readBlobs,
  readOsmPbf,
  zigzag,
  type OsmNode,
  type OsmRelation,
  type OsmWay,
} from "./osm-pbf";

import {
  deltas,
  fBytes,
  frame,
  fSint,
  fString,
  fVarint,
  headerBlock,
  packed,
  packedSint,
  varint,
  zz,
  type Bytes,
} from "./fixtures/osm/pbf-encoder";

// String table: index 0 must be "" (dense keys_vals delimiter).
const STRINGS = ["", "power", "substation", "name", "Ünïcode Sub", "line", "voltage", "230000;66000", "alice", "outer", "type"];
const S = (s: string) => {
  const index = STRINGS.indexOf(s);
  if (index < 0) throw new Error(`missing string ${s}`);
  return index;
};

/**
 * Block with granularity 1000 (1e-6 deg units), lat/lon offsets, date_granularity 1000 (ms).
 * lat = 1e-9 * (lat_offset + granularity * raw).
 */
const GRAN = 1000;
const LAT_OFF = 500; // nanodegrees
const LON_OFF = -250;
const DENSE = [
  { id: 1001, lat: 33_753_800, lon: -118_011_100, v: 3, ts: 1_600_000_000, cs: 900, uid: 7, user: "alice", tags: [["power", "substation"], ["name", "Ünïcode Sub"]] },
  { id: 1002, lat: 33_753_900, lon: -118_011_000, v: 1, ts: 1_600_000_100, cs: 905, uid: 7, user: "alice", tags: [] },
  { id: 1010, lat: 33_700_000, lon: -118_100_000, v: 12, ts: 1_599_999_000, cs: 880, uid: 9, user: "", tags: [["voltage", "230000;66000"]] },
] as const;

function primitiveBlock(dateGranularity = 1000): Bytes {
  const stringtable = fBytes(1, STRINGS.flatMap((s) => fString(1, s)));
  const dense = [
    ...packedSint(1, deltas(DENSE.map((n) => n.id))),
    ...fBytes(5, [
      ...packed(1, DENSE.map((n) => n.v)), // version: NOT delta coded
      ...packedSint(2, deltas(DENSE.map((n) => n.ts))),
      ...packedSint(3, deltas(DENSE.map((n) => n.cs))),
      ...packedSint(4, deltas(DENSE.map((n) => n.uid))),
      ...packedSint(5, deltas(DENSE.map((n) => S(n.user)))),
    ]),
    ...packedSint(8, deltas(DENSE.map((n) => n.lat))),
    ...packedSint(9, deltas(DENSE.map((n) => n.lon))),
    ...packed(10, DENSE.flatMap((n) => [...n.tags.flatMap(([k, v]) => [S(k), S(v)]), 0])),
  ];
  const plainNode = [
    ...fSint(1, 2002),
    ...packed(2, [S("power")]),
    ...packed(3, [S("substation")]),
    ...fBytes(4, [...fVarint(1, 4), ...fVarint(2, 1_700_000), ...fVarint(3, 77)]),
    ...fSint(8, -1_000), // southern / western hemisphere sign handling
    ...fSint(9, 2_000),
  ];
  const refs = [1001, 1002, 1010, 1001];
  const way = [
    ...fVarint(1, 5555),
    ...packed(2, [S("power"), S("voltage")]),
    ...packed(3, [S("line"), S("230000;66000")]),
    ...fBytes(4, [...fVarint(1, 7), ...fVarint(2, 1_650_000_000)]),
    ...packedSint(8, deltas(refs)),
  ];
  const relation = [
    ...fVarint(1, 77),
    ...packed(2, [S("type"), S("power")]),
    ...packed(3, [S("substation"), S("substation")]),
    ...fBytes(4, [...fVarint(1, 2)]),
    ...packed(8, [S("outer"), S(""), S("")]),
    ...packedSint(9, deltas([5555, 1001, 77])),
    ...packed(10, [1, 0, 2]),
  ];
  const groupDense = fBytes(2, fBytes(2, dense));
  const groupNode = fBytes(2, fBytes(1, plainNode));
  const groupWay = fBytes(2, fBytes(3, way));
  const groupRel = fBytes(2, fBytes(4, relation));
  // Offsets/granularity deliberately encoded AFTER the groups, as osmium does.
  return [
    ...stringtable,
    ...groupDense,
    ...groupNode,
    ...groupWay,
    ...groupRel,
    ...fVarint(17, GRAN),
    ...fVarint(18, dateGranularity),
    ...fVarint(19, LAT_OFF),
    ...fVarint(20, BigInt(LON_OFF)), // negative int64 -> 10-byte varint
  ];
}

async function withFile(bytes: Buffer, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "osm-pbf-test-"));
  try {
    const path = join(dir, "fixture.osm.pbf");
    await writeFile(path, bytes);
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* --------------------------------- tests --------------------------------- */

test("varint and zigzag decoding, including 10-byte negative int64", () => {
  for (const value of [0, 1, 127, 128, 300, 2 ** 31, 2 ** 35 + 5, 2 ** 52 + 1]) {
    assert.equal(new ProtoReader(Uint8Array.from(varint(value))).varint(), value, `varint ${value}`);
  }
  assert.equal(new ProtoReader(Uint8Array.from(varint(-1))).varint(), -1);
  assert.equal(new ProtoReader(Uint8Array.from(varint(-250))).varint(), -250);
  for (const value of [0, -1, 1, -2, 2 ** 40, -(2 ** 40) - 3, 12_345_678_901]) {
    assert.equal(zigzag(Number(zz(value))), value, `zigzag ${value}`);
  }
});

test("header block: features, bbox, replication timestamp and sequence", () => {
  const header = parseHeaderBlock(Uint8Array.from(headerBlock()));
  assert.deepEqual(header.requiredFeatures, ["OsmSchema-V0.6", "DenseNodes"]);
  assert.deepEqual(header.optionalFeatures, ["Sort.Type_then_ID"]);
  assert.deepEqual(header.bbox, [-118.5, 33.25, -117.5, 34.25]);
  assert.equal(header.replicationTimestamp, 1_794_604_940);
  assert.equal(header.replicationSequence, 2911);
  assert.equal(header.writingProgram, "test-encoder");
  assert.doesNotThrow(() => parseHeaderBlock(Uint8Array.from(headerBlock(["OsmSchema-V0.6", "DenseNodes", "HistoricalInformation"]))));
  assert.throws(() => parseHeaderBlock(Uint8Array.from(headerBlock(["OsmSchema-V0.6", "LocationsOnWays"]))), /unsupported feature\(s\): LocationsOnWays/);
});

test("dense nodes: delta ids/coords, granularity+offset math, DenseInfo (version not delta), tags", () => {
  const nodes: OsmNode[] = [];
  const coords: Array<[number, number, number, number | undefined, number | undefined]> = [];
  const summary = decodePrimitiveBlock(Uint8Array.from(primitiveBlock()), {
    node: (n) => nodes.push(n),
    nodeCoord: (...args) => coords.push(args),
  });
  assert.deepEqual(summary, { nodes: 4, ways: 1, relations: 1, changesets: 0 });
  assert.deepEqual(nodes.map((n) => n.id), [1001, 1002, 1010, 2002]);
  DENSE.forEach((expected, index) => {
    const node = nodes[index];
    assert.equal(node.lat, (LAT_OFF + GRAN * expected.lat) / 1e9);
    assert.equal(node.lon, (LON_OFF + GRAN * expected.lon) / 1e9);
    assert.deepEqual(node.info, {
      version: expected.v,
      timestamp: expected.ts,
      changeset: expected.cs,
      uid: expected.uid,
      user: expected.user,
    });
    assert.deepEqual(node.tags, Object.fromEntries(expected.tags));
  });
  // Concrete values: 33.7538 deg + 500 nanodeg offset.
  assert.equal(nodes[0].lat, 33.7538005);
  assert.equal(nodes[0].lon, -118.01110025);
  assert.equal(nodes[0].tags.name, "Ünïcode Sub");
  // Plain (non-dense) node with Info, date_granularity applied (ms -> s).
  assert.equal(nodes[3].lat, (LAT_OFF + GRAN * -1000) / 1e9);
  assert.equal(nodes[3].lon, (LON_OFF + GRAN * 2000) / 1e9);
  // Raw Info.timestamp 1_700_000 in date_granularity (1000 ms) units = 1_700_000 s.
  assert.deepEqual(nodes[3].info, { version: 4, timestamp: 1_700_000, changeset: 77 });
  assert.deepEqual(nodes[3].tags, { power: "substation" });
  assert.deepEqual(coords[2], [1010, nodes[2].lat, nodes[2].lon, 1_599_999_000, 12]);
});

test("date_granularity scales Info and DenseInfo timestamps", () => {
  const nodes: OsmNode[] = [];
  const ways: OsmWay[] = [];
  decodePrimitiveBlock(Uint8Array.from(primitiveBlock(500)), { node: (n) => nodes.push(n), way: (w) => ways.push(w) });
  assert.equal(nodes[0].info?.timestamp, 1_600_000_000 / 2);
  assert.equal(nodes[3].info?.timestamp, 850_000);
  assert.equal(ways[0].info?.timestamp, 825_000_000);
});

test("ways: delta-coded refs, tags via stringtable, info.version; relations: members, roles, types", () => {
  const ways: OsmWay[] = [];
  const relations: OsmRelation[] = [];
  decodePrimitiveBlock(Uint8Array.from(primitiveBlock()), { way: (w) => ways.push(w), relation: (r) => relations.push(r) });
  assert.equal(ways.length, 1);
  assert.deepEqual(ways[0], {
    type: "way",
    id: 5555,
    refs: [1001, 1002, 1010, 1001],
    tags: { power: "line", voltage: "230000;66000" },
    info: { version: 7, timestamp: 1_650_000_000 },
  });
  assert.deepEqual(relations[0], {
    type: "relation",
    id: 77,
    members: [
      { type: "way", ref: 5555, role: "outer" },
      { type: "node", ref: 1001, role: "" },
      { type: "relation", ref: 77, role: "" },
    ],
    tags: { type: "substation", power: "substation" },
    info: { version: 2 },
  });
});

test("nodeFilter materialises only matching nodes (dense and plain)", () => {
  const ids: number[] = [];
  decodePrimitiveBlock(Uint8Array.from(primitiveBlock()), {
    node: (n) => ids.push(n.id),
    nodeFilter: (id, tag) => tag("power") === "substation" || id === 1010,
  });
  assert.deepEqual(ids, [1001, 1010, 2002]);
});

test("visitor without node callbacks skips node decoding but still counts dense nodes", () => {
  const summary = decodePrimitiveBlock(Uint8Array.from(primitiveBlock()), { way: () => {} });
  assert.deepEqual(summary, { nodes: 4, ways: 1, relations: 1, changesets: 0 });
});

test("file streaming: zlib and raw blobs, frame offsets, header-first, offset replay", async () => {
  const file = Buffer.concat([frame("OSMHeader", headerBlock()), frame("OSMData", primitiveBlock(), "zlib"), frame("OSMData", primitiveBlock(), "raw")]);
  await withFile(file, async (path) => {
    const frames = [];
    for await (const f of readBlobs(path)) frames.push({ type: f.type, offset: f.offset, frameBytes: f.frameBytes });
    assert.deepEqual(frames.map((f) => f.type), ["OSMHeader", "OSMData", "OSMData"]);
    assert.equal(frames.reduce((sum, f) => sum + f.frameBytes, 0), file.length);
    const ids: number[] = [];
    const offsets: number[] = [];
    const { header, blocks } = await readOsmPbf(path, { nodeCoord: (id) => ids.push(id) }, { onBlock: (offset) => void offsets.push(offset) });
    assert.equal(header?.replicationSequence, 2911);
    assert.equal(blocks, 2);
    assert.deepEqual(ids, [1001, 1002, 1010, 2002, 1001, 1002, 1010, 2002]);
    assert.deepEqual(offsets, [frames[1].offset, frames[2].offset]);
    // Replay only the second data frame by offset.
    const replay: number[] = [];
    await readOsmPbf(path, { way: (w) => replay.push(w.id) }, { offsets: [frames[2].offset] });
    assert.deepEqual(replay, [5555]);
    // onBlock returning false stops the stream.
    let seen = 0;
    await readOsmPbf(path, { way: () => void seen++ }, { onBlock: () => false });
    assert.equal(seen, 1);
  });
});

test("rejects lzma/zstd blobs and truncated files with clear errors", async () => {
  const lzma = frame("OSMData", primitiveBlock(), "lzma");
  const blobStart = 4 + lzma.readUInt32BE(0);
  assert.throws(() => decodeBlob(lzma.subarray(blobStart)), /Unsupported PBF blob compression: lzma_data/);
  const zstdBlob = Uint8Array.from([...fVarint(2, 3), ...fBytes(7, [1, 2, 3])]);
  assert.throws(() => decodeBlob(zstdBlob), /zstd_data/);
  const good = frame("OSMHeader", headerBlock());
  await withFile(good.subarray(0, good.length - 3), async (path) => {
    await assert.rejects(readOsmPbf(path, {}), /Unexpected end of file/);
  });
  await withFile(frame("OSMData", primitiveBlock()), async (path) => {
    await assert.rejects(readOsmPbf(path, {}), /OSMData blob before OSMHeader/);
  });
});

test("zlib bombs are capped during inflation, not after", () => {
  const MAX = 32 * 1024 * 1024;
  // 33 MiB of zeros deflates to ~33 KiB: a >1000:1 bomb built in-test.
  const bomb = deflateSync(Buffer.alloc(MAX + 1024 * 1024), { level: 9 });
  assert.ok(bomb.length < 64 * 1024, `bomb is ${bomb.length} bytes compressed`);
  const blob = (rawSize?: number) => Uint8Array.from([...(rawSize === undefined ? [] : fVarint(2, rawSize)), ...fBytes(3, bomb)]);
  // raw_size claims 1 KiB: inflation stops at 1 KiB instead of producing 33 MiB.
  assert.throws(() => decodeBlob(blob(1024)), /zlib blob inflates past raw_size 1024/);
  // raw_size omitted: capped at 32 MiB.
  assert.throws(() => decodeBlob(blob()), /zlib blob inflates past 33554432 bytes/);
  // raw_size over the cap is rejected before inflating, even when it is truthful.
  assert.throws(() => decodeBlob(blob(MAX + 1024 * 1024)), /raw_size 34603008 exceeds the 33554432-byte blob cap/);
  // A truthful raw_size within the cap still decodes.
  const small = Buffer.from("x".repeat(5000));
  const ok = decodeBlob(Uint8Array.from([...fVarint(2, small.length), ...fBytes(3, deflateSync(small))]));
  assert.equal(Buffer.from(ok).toString(), small.toString());
});
