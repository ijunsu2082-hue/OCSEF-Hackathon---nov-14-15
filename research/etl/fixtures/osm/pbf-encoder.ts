/**
 * Test-only OSM PBF encoder (protobuf varints, zigzag, length-delimited fields,
 * BlobHeader/Blob frames). Used by osm-pbf.test.ts and osm-regen.test.ts to build
 * hand-made fixtures; never used by production code.
 */
import { deflateSync } from "node:zlib";


export function varint(value: number | bigint): number[] {
  let v = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

export const zz = (n: number): bigint => {
  const b = BigInt(n);
  return b >= 0n ? b * 2n : -b * 2n - 1n;
};

export type Bytes = number[];
export const key = (field: number, wire: number): Bytes => varint((field << 3) | wire);
export const fVarint = (field: number, value: number | bigint): Bytes => [...key(field, 0), ...varint(value)];
export const fSint = (field: number, value: number): Bytes => fVarint(field, zz(value));
export const fBytes = (field: number, payload: Bytes | Uint8Array): Bytes => [...key(field, 2), ...varint(payload.length), ...payload];
export const fString = (field: number, value: string): Bytes => fBytes(field, [...Buffer.from(value, "utf8")]);
export const packed = (field: number, values: Array<number | bigint>): Bytes => fBytes(field, values.flatMap((v) => varint(v)));
export const packedSint = (field: number, values: number[]): Bytes => packed(field, values.map(zz));
export const deltas = (values: number[]): number[] => values.map((v, i) => (i === 0 ? v : v - values[i - 1]));

export function frame(type: string, payload: Bytes, compression: "zlib" | "raw" | "lzma" = "zlib"): Buffer {
  const data = Buffer.from(payload);
  const blob =
    compression === "zlib"
      ? [...fVarint(2, data.length), ...fBytes(3, deflateSync(data))]
      : compression === "raw"
        ? fBytes(1, data)
        : [...fVarint(2, data.length), ...fBytes(4, [1, 2, 3])];
  const header = [...fString(1, type), ...fVarint(3, blob.length)];
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, Buffer.from(header), Buffer.from(blob)]);
}

export function headerBlock(required = ["OsmSchema-V0.6", "DenseNodes"]): Bytes {
  return [
    ...fBytes(1, [...fSint(1, -118_500_000_000), ...fSint(2, -117_500_000_000), ...fSint(3, 34_250_000_000), ...fSint(4, 33_250_000_000)]),
    ...required.flatMap((f) => fString(4, f)),
    ...fString(5, "Sort.Type_then_ID"),
    ...fString(16, "test-encoder"),
    ...fVarint(32, 1_794_604_940),
    ...fVarint(33, 2911),
    ...fString(34, "https://example.invalid/updates"),
  ];
}

export interface FixtureNode {
  id: number;
  lat: number;
  lon: number;
  version?: number;
  timestamp?: number;
  tags?: Record<string, string>;
}

export interface FixtureWay {
  id: number;
  refs: number[];
  version?: number;
  timestamp?: number;
  tags?: Record<string, string>;
}

export interface FixtureRelation {
  id: number;
  members: Array<{ type: "node" | "way" | "relation"; ref: number; role?: string }>;
  version?: number;
  tags?: Record<string, string>;
}

/**
 * Encode a small sorted PBF: header, then one block of dense nodes, one of ways,
 * one of relations (granularity 100, no offsets, date_granularity 1000).
 */
export function buildPbf(input: { nodes: FixtureNode[]; ways: FixtureWay[]; relations?: FixtureRelation[] }): Buffer {
  const strings: string[] = [""];
  const sid = (value: string) => {
    let index = strings.indexOf(value);
    if (index < 0) index = strings.push(value) - 1;
    return index;
  };
  const tagIds = (tags: Record<string, string> = {}) => Object.entries(tags).map(([k, v]) => [sid(k), sid(v)] as const);
  const nano = (deg: number) => Math.round(deg * 1e7); // 100-nanodegree units
  const nodes = [...input.nodes].sort((a, b) => a.id - b.id);
  const dense = [
    ...packedSint(1, deltas(nodes.map((n) => n.id))),
    ...fBytes(5, [
      ...packed(1, nodes.map((n) => n.version ?? 1)),
      ...packedSint(2, deltas(nodes.map((n) => n.timestamp ?? 0))),
    ]),
    ...packedSint(8, deltas(nodes.map((n) => nano(n.lat)))),
    ...packedSint(9, deltas(nodes.map((n) => nano(n.lon)))),
    ...packed(10, nodes.flatMap((n) => [...tagIds(n.tags).flatMap(([k, v]) => [k, v]), 0])),
  ];
  const ways = [...input.ways].sort((a, b) => a.id - b.id).map((w) => {
    const tags = tagIds(w.tags);
    return fBytes(3, [
      ...fVarint(1, w.id),
      ...packed(2, tags.map(([k]) => k)),
      ...packed(3, tags.map(([, v]) => v)),
      ...fBytes(4, [...fVarint(1, w.version ?? 1), ...fVarint(2, w.timestamp ?? 0)]),
      ...packedSint(8, deltas(w.refs)),
    ]);
  });
  const typeCode = { node: 0, way: 1, relation: 2 } as const;
  const relations = [...(input.relations ?? [])].sort((a, b) => a.id - b.id).map((r) => {
    const tags = tagIds(r.tags);
    return fBytes(4, [
      ...fVarint(1, r.id),
      ...packed(2, tags.map(([k]) => k)),
      ...packed(3, tags.map(([, v]) => v)),
      ...fBytes(4, [...fVarint(1, r.version ?? 1)]),
      ...packed(8, r.members.map((m) => sid(m.role ?? ""))),
      ...packedSint(9, deltas(r.members.map((m) => m.ref))),
      ...packed(10, r.members.map((m) => typeCode[m.type])),
    ]);
  });
  const block = (groups: Bytes[]) => [...fBytes(1, strings.flatMap((s) => fString(1, s))), ...groups.map((g) => fBytes(2, g)).flat()];
  // String ids are assigned while encoding the groups above, so build the string table last.
  const frames = [frame("OSMHeader", headerBlock()), frame("OSMData", block([fBytes(2, dense)]))];
  if (ways.length) frames.push(frame("OSMData", block([ways.flat()])));
  if (relations.length) frames.push(frame("OSMData", block([relations.flat()])));
  return Buffer.concat(frames);
}
