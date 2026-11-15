/**
 * Dependency-free streaming reader for the OpenStreetMap PBF format.
 *
 * The file is a sequence of [4-byte big-endian BlobHeader length][BlobHeader]
 * [Blob] frames. Frames are read one at a time from a file handle, so memory is
 * bounded by the largest blob (32 MiB uncompressed by spec), never by the file.
 *
 * Only node built-ins are used: node:zlib for zlib_data and node:fs/promises for
 * positioned reads. lzma/zstd/lz4 blobs are rejected with an explicit error
 * rather than silently skipped, because skipping would drop elements.
 *
 * Integer handling: OSM ids, coordinates in nanodegrees and timestamps all fit in
 * a double's 53-bit mantissa, so varints are decoded to numbers. Varints longer
 * than 7 bytes take a BigInt path and are read as signed 64-bit (int32/int64
 * negatives are always encoded as 10-byte two's complement).
 *
 * Reference: https://wiki.openstreetmap.org/wiki/PBF_Format (fileformat.proto,
 * osmformat.proto).
 */
import { open } from "node:fs/promises";
import { inflateSync } from "node:zlib";

export const SUPPORTED_REQUIRED_FEATURES = ["OsmSchema-V0.6", "DenseNodes", "HistoricalInformation"] as const;

const MAX_BLOB_HEADER_BYTES = 64 * 1024;
const MAX_BLOB_BYTES = 32 * 1024 * 1024;

export interface OsmInfo {
  version?: number;
  /** Seconds since the Unix epoch (date_granularity already applied). */
  timestamp?: number;
  changeset?: number;
  uid?: number;
  user?: string;
  visible?: boolean;
}

export type OsmTags = Record<string, string>;

export interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags: OsmTags;
  info?: OsmInfo;
}

export interface OsmWay {
  type: "way";
  id: number;
  refs: number[];
  tags: OsmTags;
  info?: OsmInfo;
}

export type OsmMemberType = "node" | "way" | "relation";

export interface OsmMember {
  type: OsmMemberType;
  ref: number;
  role: string;
}

export interface OsmRelation {
  type: "relation";
  id: number;
  members: OsmMember[];
  tags: OsmTags;
  info?: OsmInfo;
}

export interface OsmHeader {
  requiredFeatures: string[];
  optionalFeatures: string[];
  writingProgram?: string;
  source?: string;
  /** Degrees: [left, bottom, right, top]. */
  bbox?: [number, number, number, number];
  /** Seconds since epoch. */
  replicationTimestamp?: number;
  replicationSequence?: number;
  replicationBaseUrl?: string;
}

export interface RawBlob {
  /** "OSMHeader" or "OSMData" (unknown types are passed through for the caller to skip). */
  type: string;
  /** File offset of the frame's 4-byte length prefix. */
  offset: number;
  /** Total frame length in bytes (prefix + header + blob). */
  frameBytes: number;
  /** Decompressed blob payload. */
  data: Uint8Array;
}

/* ------------------------------------------------------------------------ */
/* Minimal protobuf decoding                                                 */
/* ------------------------------------------------------------------------ */

export class ProtoReader {
  pos: number;
  readonly end: number;
  constructor(readonly buf: Uint8Array, start = 0, end = buf.length) {
    this.pos = start;
    this.end = end;
  }

  eof(): boolean {
    return this.pos >= this.end;
  }

  /** Unsigned varint up to 2^53, or signed 64-bit for varints longer than 7 bytes. */
  varint(): number {
    const buf = this.buf;
    let pos = this.pos;
    let b = buf[pos++];
    if (b < 0x80) {
      this.pos = pos;
      return b;
    }
    let result = b & 0x7f;
    b = buf[pos++];
    result |= (b & 0x7f) << 7;
    if (b < 0x80) {
      this.pos = pos;
      return result;
    }
    b = buf[pos++];
    result |= (b & 0x7f) << 14;
    if (b < 0x80) {
      this.pos = pos;
      return result;
    }
    b = buf[pos++];
    result |= (b & 0x7f) << 21;
    if (b < 0x80) {
      this.pos = pos;
      return result;
    }
    let scale = 2 ** 28;
    for (let i = 4; i < 7; i += 1) {
      b = buf[pos++];
      result += (b & 0x7f) * scale;
      if (b < 0x80) {
        this.pos = pos;
        return result;
      }
      scale *= 128;
    }
    return this.longVarint();
  }

  private longVarint(): number {
    let pos = this.pos;
    let value = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i += 1) {
      if (pos >= this.end) throw new Error("Truncated varint");
      const b = this.buf[pos++];
      value |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) {
        this.pos = pos;
        return Number(BigInt.asIntN(64, value));
      }
      shift += 7n;
    }
    throw new Error("Malformed varint (more than 10 bytes)");
  }

  sint(): number {
    return zigzag(this.varint());
  }

  bytesRange(): [number, number] {
    const length = this.varint();
    const start = this.pos;
    const end = start + length;
    if (end > this.end) throw new Error(`Length-delimited field overruns buffer (${end} > ${this.end})`);
    this.pos = end;
    return [start, end];
  }

  bytes(): Uint8Array {
    const [start, end] = this.bytesRange();
    return this.buf.subarray(start, end);
  }

  string(): string {
    const [start, end] = this.bytesRange();
    return utf8.decode(this.buf.subarray(start, end));
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        return;
      case 1:
        this.pos += 8;
        return;
      case 2:
        this.bytesRange();
        return;
      case 5:
        this.pos += 4;
        return;
      default:
        throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
  }
}

const utf8 = new TextDecoder("utf-8");

export function zigzag(n: number): number {
  if (n <= 0x7fffffff) return (n >>> 1) ^ -(n & 1);
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

/** Read a repeated scalar field that may be packed (wire 2) or unpacked (wire 0). */
function readRepeated(r: ProtoReader, wireType: number, out: number[], signed: boolean): void {
  if (wireType === 2) {
    const [start, end] = r.bytesRange();
    const inner = new ProtoReader(r.buf, start, end);
    while (inner.pos < end) out.push(signed ? inner.sint() : inner.varint());
    return;
  }
  if (wireType === 0) {
    out.push(signed ? r.sint() : r.varint());
    return;
  }
  throw new Error(`Repeated scalar with wire type ${wireType}`);
}

/** Read packed zigzag deltas, returning running sums. */
function readDelta(r: ProtoReader, wireType: number, out: number[]): void {
  const raw: number[] = [];
  readRepeated(r, wireType, raw, true);
  let acc = out.length ? out[out.length - 1] : 0;
  for (const value of raw) {
    acc += value;
    out.push(acc);
  }
}

/* ------------------------------------------------------------------------ */
/* Frames                                                                    */
/* ------------------------------------------------------------------------ */

interface BlobHeaderFields {
  type: string;
  datasize: number;
}

function parseBlobHeader(buf: Uint8Array): BlobHeaderFields {
  const r = new ProtoReader(buf);
  let type = "";
  let datasize = -1;
  while (!r.eof()) {
    const key = r.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1 && wire === 2) type = r.string();
    else if (field === 3 && wire === 0) datasize = r.varint();
    else r.skip(wire);
  }
  if (!type) throw new Error("BlobHeader is missing its type");
  if (datasize < 0) throw new Error("BlobHeader is missing datasize");
  return { type, datasize };
}

const COMPRESSION_FIELDS: Record<number, string> = {
  4: "lzma_data",
  5: "OBSOLETE_bzip2_data",
  6: "lz4_data",
  7: "zstd_data",
};

/** Decode a Blob message into its uncompressed payload. */
export function decodeBlob(buf: Uint8Array): Uint8Array {
  const r = new ProtoReader(buf);
  let raw: Uint8Array | undefined;
  let zlib: Uint8Array | undefined;
  let rawSize = -1;
  while (!r.eof()) {
    const key = r.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1 && wire === 2) raw = r.bytes();
    else if (field === 2 && wire === 0) rawSize = r.varint();
    else if (field === 3 && wire === 2) zlib = r.bytes();
    else if (COMPRESSION_FIELDS[field]) {
      throw new Error(`Unsupported PBF blob compression: ${COMPRESSION_FIELDS[field]} (only raw and zlib_data are supported)`);
    } else r.skip(wire);
  }
  if (raw) return raw;
  if (zlib) {
    // Cap inflation itself: a small zlib bomb must not allocate past raw_size or the blob cap.
    if (rawSize > MAX_BLOB_BYTES) throw new Error(`zlib blob raw_size ${rawSize} exceeds the ${MAX_BLOB_BYTES}-byte blob cap`);
    const limit = rawSize >= 0 ? rawSize : MAX_BLOB_BYTES;
    let out: Buffer;
    try {
      out = inflateSync(zlib, { maxOutputLength: Math.max(1, limit) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw new Error(rawSize >= 0 ? `zlib blob inflates past raw_size ${rawSize}` : `zlib blob inflates past ${MAX_BLOB_BYTES} bytes`);
      }
      throw error;
    }
    if (rawSize >= 0 && out.length !== rawSize) {
      throw new Error(`zlib blob inflated to ${out.length} bytes, raw_size says ${rawSize}`);
    }
    return new Uint8Array(out.buffer, out.byteOffset, out.length);
  }
  throw new Error("Blob has no data field");
}

export interface ReadBlobsOptions {
  /** If given, only frames starting at these file offsets are read (in the given order). */
  offsets?: number[];
}

/**
 * Stream frames from a PBF file. Reads one frame at a time through a file
 * handle; memory never holds more than one compressed + one inflated blob.
 */
export async function* readBlobs(path: string, options: ReadBlobsOptions = {}): AsyncGenerator<RawBlob> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const readExact = async (length: number, position: number): Promise<Buffer> => {
      const target = Buffer.allocUnsafe(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(target, done, length - done, position + done);
        if (bytesRead === 0) throw new Error(`Unexpected end of file at byte ${position + done} (wanted ${length} bytes)`);
        done += bytesRead;
      }
      return target;
    };
    const readFrame = async (offset: number): Promise<RawBlob> => {
      const headerLength = (await readExact(4, offset)).readUInt32BE(0);
      if (headerLength > MAX_BLOB_HEADER_BYTES) throw new Error(`BlobHeader at ${offset} is ${headerLength} bytes (max ${MAX_BLOB_HEADER_BYTES})`);
      const header = parseBlobHeader(await readExact(headerLength, offset + 4));
      if (header.datasize > MAX_BLOB_BYTES) throw new Error(`Blob at ${offset} is ${header.datasize} bytes (max ${MAX_BLOB_BYTES})`);
      const blob = await readExact(header.datasize, offset + 4 + headerLength);
      const data = decodeBlob(blob);
      if (data.length > MAX_BLOB_BYTES) throw new Error(`Blob at ${offset} inflates to ${data.length} bytes (max ${MAX_BLOB_BYTES})`);
      return { type: header.type, offset, frameBytes: 4 + headerLength + header.datasize, data };
    };
    if (options.offsets) {
      for (const offset of options.offsets) yield await readFrame(offset);
      return;
    }
    let offset = 0;
    while (offset < size) {
      const frame = await readFrame(offset);
      offset += frame.frameBytes;
      yield frame;
    }
  } finally {
    await handle.close();
  }
}

/* ------------------------------------------------------------------------ */
/* HeaderBlock                                                               */
/* ------------------------------------------------------------------------ */

export function parseHeaderBlock(buf: Uint8Array): OsmHeader {
  const r = new ProtoReader(buf);
  const header: OsmHeader = { requiredFeatures: [], optionalFeatures: [] };
  while (!r.eof()) {
    const key = r.varint();
    const field = key >>> 3;
    const wire = key & 7;
    switch (field) {
      case 1: {
        const [start, end] = r.bytesRange();
        const b = new ProtoReader(buf, start, end);
        const box = [0, 0, 0, 0];
        while (!b.eof()) {
          const k = b.varint();
          const f = k >>> 3;
          if (f >= 1 && f <= 4 && (k & 7) === 0) box[f - 1] = b.sint() / 1e9;
          else b.skip(k & 7);
        }
        // HeaderBBox: left=1 right=2 top=3 bottom=4 -> [left, bottom, right, top]
        header.bbox = [box[0], box[3], box[1], box[2]];
        break;
      }
      case 4:
        header.requiredFeatures.push(r.string());
        break;
      case 5:
        header.optionalFeatures.push(r.string());
        break;
      case 16:
        header.writingProgram = r.string();
        break;
      case 17:
        header.source = r.string();
        break;
      case 32:
        header.replicationTimestamp = r.varint();
        break;
      case 33:
        header.replicationSequence = r.varint();
        break;
      case 34:
        header.replicationBaseUrl = r.string();
        break;
      default:
        r.skip(wire);
    }
  }
  const unsupported = header.requiredFeatures.filter(
    (feature) => !(SUPPORTED_REQUIRED_FEATURES as readonly string[]).includes(feature),
  );
  if (unsupported.length) {
    throw new Error(`PBF requires unsupported feature(s): ${unsupported.join(", ")}`);
  }
  return header;
}

/* ------------------------------------------------------------------------ */
/* PrimitiveBlock                                                            */
/* ------------------------------------------------------------------------ */

export interface PrimitiveVisitor {
  /** Full node with tags/info. When absent, node tags and info are not decoded. */
  node?(node: OsmNode): void;
  /** Lightweight coordinate callback (no allocation). timestamp/version only if `nodeInfo` is set. */
  nodeCoord?(id: number, lat: number, lon: number, timestamp: number | undefined, version: number | undefined): void;
  /** Decode DenseInfo/Info for nodeCoord as well. */
  nodeInfo?: boolean;
  /**
   * Pre-filter for `node`: only nodes for which this returns true are materialised.
   * `tag(key)` reads one raw tag value without building the tag object.
   */
  nodeFilter?(id: number, tag: (key: string) => string | undefined): boolean;
  way?(way: OsmWay): void;
  relation?(relation: OsmRelation): void;
}

export interface BlockSummary {
  nodes: number;
  ways: number;
  relations: number;
  changesets: number;
}

interface BlockContext {
  buf: Uint8Array;
  stringRanges: Array<[number, number]>;
  strings: Array<string | undefined>;
  granularity: number;
  latOffset: number;
  lonOffset: number;
  dateGranularity: number;
}

function str(ctx: BlockContext, index: number): string {
  let value = ctx.strings[index];
  if (value === undefined) {
    const range = ctx.stringRanges[index];
    if (!range) throw new Error(`String table index ${index} out of range (${ctx.stringRanges.length})`);
    value = utf8.decode(ctx.buf.subarray(range[0], range[1]));
    ctx.strings[index] = value;
  }
  return value;
}

/** Exposed for tests/diagnostics: the decoded string table of a block. */
export function blockStrings(buf: Uint8Array): string[] {
  const ctx = blockContext(buf).ctx;
  return ctx.stringRanges.map((_, index) => str(ctx, index));
}

function blockContext(buf: Uint8Array): { ctx: BlockContext; groups: Array<[number, number]> } {
  const r = new ProtoReader(buf);
  const groups: Array<[number, number]> = [];
  const ctx: BlockContext = {
    buf,
    stringRanges: [],
    strings: [],
    granularity: 100,
    latOffset: 0,
    lonOffset: 0,
    dateGranularity: 1000,
  };
  while (!r.eof()) {
    const key = r.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1 && wire === 2) {
      const [start, end] = r.bytesRange();
      const s = new ProtoReader(buf, start, end);
      while (!s.eof()) {
        const k = s.varint();
        if (k >>> 3 === 1 && (k & 7) === 2) ctx.stringRanges.push(s.bytesRange());
        else s.skip(k & 7);
      }
    } else if (field === 2 && wire === 2) groups.push(r.bytesRange());
    else if (field === 17 && wire === 0) ctx.granularity = r.varint();
    else if (field === 18 && wire === 0) ctx.dateGranularity = r.varint();
    else if (field === 19 && wire === 0) ctx.latOffset = r.varint();
    else if (field === 20 && wire === 0) ctx.lonOffset = r.varint();
    else r.skip(wire);
  }
  return { ctx, groups };
}

function coord(offset: number, granularity: number, value: number): number {
  return (offset + granularity * value) / 1e9;
}

function decodeInfo(ctx: BlockContext, r: ProtoReader): OsmInfo {
  const [start, end] = r.bytesRange();
  const i = new ProtoReader(ctx.buf, start, end);
  const info: OsmInfo = {};
  while (!i.eof()) {
    const k = i.varint();
    const f = k >>> 3;
    const w = k & 7;
    if (w !== 0) {
      i.skip(w);
      continue;
    }
    const v = i.varint();
    if (f === 1) info.version = v;
    else if (f === 2) info.timestamp = (v * ctx.dateGranularity) / 1000;
    else if (f === 3) info.changeset = v;
    else if (f === 4) info.uid = v;
    else if (f === 5) info.user = str(ctx, v);
    else if (f === 6) info.visible = v !== 0;
  }
  return info;
}

function tagsFrom(ctx: BlockContext, keys: number[], vals: number[]): OsmTags {
  if (keys.length !== vals.length) throw new Error(`Tag key/value count mismatch (${keys.length} vs ${vals.length})`);
  const tags: OsmTags = {};
  for (let index = 0; index < keys.length; index += 1) tags[str(ctx, keys[index])] = str(ctx, vals[index]);
  return tags;
}

function decodeDense(ctx: BlockContext, start: number, end: number, visitor: PrimitiveVisitor): number {
  const r = new ProtoReader(ctx.buf, start, end);
  const ids: number[] = [];
  const lats: number[] = [];
  const lons: number[] = [];
  const keysVals: number[] = [];
  let infoRange: [number, number] | undefined;
  const full = Boolean(visitor.node);
  const wantInfo = full || Boolean(visitor.nodeInfo);
  while (!r.eof()) {
    const key = r.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1) readDelta(r, wire, ids);
    else if (field === 8) readDelta(r, wire, lats);
    else if (field === 9) readDelta(r, wire, lons);
    else if (field === 5 && wire === 2 && wantInfo) infoRange = r.bytesRange();
    else if (field === 10 && full) readRepeated(r, wire, keysVals, false);
    else r.skip(wire);
  }
  if (lats.length !== ids.length || lons.length !== ids.length) {
    throw new Error(`DenseNodes id/lat/lon length mismatch (${ids.length}/${lats.length}/${lons.length})`);
  }
  // DenseInfo: version is NOT delta coded; timestamp, changeset, uid, user_sid ARE.
  const versions: number[] = [];
  const timestamps: number[] = [];
  const changesets: number[] = [];
  const uids: number[] = [];
  const userSids: number[] = [];
  const visibles: number[] = [];
  if (infoRange) {
    const i = new ProtoReader(ctx.buf, infoRange[0], infoRange[1]);
    while (!i.eof()) {
      const key = i.varint();
      const field = key >>> 3;
      const wire = key & 7;
      if (field === 1) readRepeated(i, wire, versions, false);
      else if (field === 2) readDelta(i, wire, timestamps);
      else if (field === 3) readDelta(i, wire, changesets);
      else if (field === 4) readDelta(i, wire, uids);
      else if (field === 5) readDelta(i, wire, userSids);
      else if (field === 6) readRepeated(i, wire, visibles, false);
      else i.skip(wire);
    }
  }
  const { granularity, latOffset, lonOffset, dateGranularity } = ctx;
  let kv = 0;
  for (let index = 0; index < ids.length; index += 1) {
    const lat = coord(latOffset, granularity, lats[index]);
    const lon = coord(lonOffset, granularity, lons[index]);
    const timestamp = timestamps.length ? (timestamps[index] * dateGranularity) / 1000 : undefined;
    const version = versions.length ? versions[index] : undefined;
    if (visitor.nodeCoord) visitor.nodeCoord(ids[index], lat, lon, timestamp, version);
    if (full) {
      const kvStart = kv;
      if (keysVals.length) {
        while (kv < keysVals.length && keysVals[kv] !== 0) kv += 2;
        kv += 1; // skip the 0 delimiter
      }
      const kvEnd = keysVals.length ? kv - 1 : kvStart;
      if (visitor.nodeFilter) {
        const tag = (wanted: string): string | undefined => {
          for (let k = kvStart; k < kvEnd; k += 2) if (str(ctx, keysVals[k]) === wanted) return str(ctx, keysVals[k + 1]);
          return undefined;
        };
        if (!visitor.nodeFilter(ids[index], tag)) continue;
      }
      const tags: OsmTags = {};
      for (let k = kvStart; k < kvEnd; k += 2) tags[str(ctx, keysVals[k])] = str(ctx, keysVals[k + 1]);
      const node: OsmNode = { type: "node", id: ids[index], lat, lon, tags };
      if (infoRange) {
        const info: OsmInfo = {};
        if (versions.length) info.version = versions[index];
        if (timestamp !== undefined) info.timestamp = timestamp;
        if (changesets.length) info.changeset = changesets[index];
        if (uids.length) info.uid = uids[index];
        if (userSids.length) info.user = str(ctx, userSids[index]);
        if (visibles.length) info.visible = visibles[index] !== 0;
        node.info = info;
      }
      visitor.node!(node);
    }
  }
  return ids.length;
}

function decodeNode(ctx: BlockContext, start: number, end: number, visitor: PrimitiveVisitor): void {
  const r = new ProtoReader(ctx.buf, start, end);
  let id = 0;
  let lat = 0;
  let lon = 0;
  const keys: number[] = [];
  const vals: number[] = [];
  let info: OsmInfo | undefined;
  while (!r.eof()) {
    const key = r.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1) id = r.sint();
    else if (field === 2) readRepeated(r, wire, keys, false);
    else if (field === 3) readRepeated(r, wire, vals, false);
    else if (field === 4 && wire === 2) info = decodeInfo(ctx, r);
    else if (field === 8) lat = r.sint();
    else if (field === 9) lon = r.sint();
    else r.skip(wire);
  }
  const latDeg = coord(ctx.latOffset, ctx.granularity, lat);
  const lonDeg = coord(ctx.lonOffset, ctx.granularity, lon);
  visitor.nodeCoord?.(id, latDeg, lonDeg, info?.timestamp, info?.version);
  if (visitor.node) {
    const tags = tagsFrom(ctx, keys, vals);
    if (visitor.nodeFilter && !visitor.nodeFilter(id, (wanted) => tags[wanted])) return;
    const node: OsmNode = { type: "node", id, lat: latDeg, lon: lonDeg, tags };
    if (info) node.info = info;
    visitor.node(node);
  }
}

function decodeWay(ctx: BlockContext, start: number, end: number): OsmWay {
  const r = new ProtoReader(ctx.buf, start, end);
  let id = 0;
  const keys: number[] = [];
  const vals: number[] = [];
  const refs: number[] = [];
  let info: OsmInfo | undefined;
  while (!r.eof()) {
    const key = r.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1) id = r.varint();
    else if (field === 2) readRepeated(r, wire, keys, false);
    else if (field === 3) readRepeated(r, wire, vals, false);
    else if (field === 4 && wire === 2) info = decodeInfo(ctx, r);
    else if (field === 8) readDelta(r, wire, refs);
    else r.skip(wire);
  }
  const way: OsmWay = { type: "way", id, refs, tags: tagsFrom(ctx, keys, vals) };
  if (info) way.info = info;
  return way;
}

const MEMBER_TYPES: OsmMemberType[] = ["node", "way", "relation"];

function decodeRelation(ctx: BlockContext, start: number, end: number): OsmRelation {
  const r = new ProtoReader(ctx.buf, start, end);
  let id = 0;
  const keys: number[] = [];
  const vals: number[] = [];
  const roles: number[] = [];
  const memids: number[] = [];
  const types: number[] = [];
  let info: OsmInfo | undefined;
  while (!r.eof()) {
    const key = r.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1) id = r.varint();
    else if (field === 2) readRepeated(r, wire, keys, false);
    else if (field === 3) readRepeated(r, wire, vals, false);
    else if (field === 4 && wire === 2) info = decodeInfo(ctx, r);
    else if (field === 8) readRepeated(r, wire, roles, false);
    else if (field === 9) readDelta(r, wire, memids);
    else if (field === 10) readRepeated(r, wire, types, false);
    else r.skip(wire);
  }
  if (roles.length !== memids.length || types.length !== memids.length) {
    throw new Error(`Relation ${id} member arrays disagree (${roles.length}/${memids.length}/${types.length})`);
  }
  const members = memids.map((ref, index) => {
    const type = MEMBER_TYPES[types[index]];
    if (!type) throw new Error(`Relation ${id} has unknown member type ${types[index]}`);
    return { type, ref, role: str(ctx, roles[index]) };
  });
  const relation: OsmRelation = { type: "relation", id, members, tags: tagsFrom(ctx, keys, vals) };
  if (info) relation.info = info;
  return relation;
}

/**
 * Decode one PrimitiveBlock and dispatch elements to the visitor. Kinds without
 * a visitor callback are counted but not decoded.
 */
export function decodePrimitiveBlock(buf: Uint8Array, visitor: PrimitiveVisitor): BlockSummary {
  const { ctx, groups } = blockContext(buf);
  const summary: BlockSummary = { nodes: 0, ways: 0, relations: 0, changesets: 0 };
  const wantNodes = Boolean(visitor.node || visitor.nodeCoord);
  for (const [gStart, gEnd] of groups) {
    const g = new ProtoReader(buf, gStart, gEnd);
    while (!g.eof()) {
      const key = g.varint();
      const field = key >>> 3;
      const wire = key & 7;
      if (wire !== 2) {
        g.skip(wire);
        continue;
      }
      const [start, end] = g.bytesRange();
      if (field === 1) {
        summary.nodes += 1;
        if (wantNodes) decodeNode(ctx, start, end, visitor);
      } else if (field === 2) {
        if (wantNodes) summary.nodes += decodeDense(ctx, start, end, visitor);
        else summary.nodes += countDense(buf, start, end);
      } else if (field === 3) {
        summary.ways += 1;
        if (visitor.way) visitor.way(decodeWay(ctx, start, end));
      } else if (field === 4) {
        summary.relations += 1;
        if (visitor.relation) visitor.relation(decodeRelation(ctx, start, end));
      } else if (field === 5) summary.changesets += 1;
    }
  }
  return summary;
}

/** Count dense nodes without decoding coordinates (counts varints in the id field). */
function countDense(buf: Uint8Array, start: number, end: number): number {
  const r = new ProtoReader(buf, start, end);
  while (!r.eof()) {
    const key = r.varint();
    if (key >>> 3 === 1 && (key & 7) === 2) {
      const [s, e] = r.bytesRange();
      let count = 0;
      for (let index = s; index < e; index += 1) if (buf[index] < 0x80) count += 1;
      return count;
    }
    r.skip(key & 7);
  }
  return 0;
}

export interface ReadOsmOptions extends ReadBlobsOptions {
  onHeader?(header: OsmHeader): void;
  /** Called after each data block with its frame offset and element counts. Return false to stop reading. */
  onBlock?(offset: number, summary: BlockSummary): boolean | void;
}

/** Stream a whole PBF file through a visitor. The first frame must be an OSMHeader. */
export async function readOsmPbf(path: string, visitor: PrimitiveVisitor, options: ReadOsmOptions = {}): Promise<{ header?: OsmHeader; blocks: number }> {
  let header: OsmHeader | undefined;
  let blocks = 0;
  for await (const frame of readBlobs(path, options)) {
    if (frame.type === "OSMHeader") {
      header = parseHeaderBlock(frame.data);
      options.onHeader?.(header);
      continue;
    }
    if (frame.type !== "OSMData") continue; // spec: unknown blob types are skipped
    if (!header && !options.offsets) throw new Error("OSMData blob before OSMHeader");
    blocks += 1;
    const summary = decodePrimitiveBlock(frame.data, visitor);
    if (options.onBlock?.(frame.offset, summary) === false) break;
  }
  return { header, blocks };
}
