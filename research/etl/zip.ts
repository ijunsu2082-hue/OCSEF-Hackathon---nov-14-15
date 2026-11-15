/**
 * Minimal, dependency-free ZIP reader for captured provider archives.
 *
 * CAISO OASIS answers every query with a small ZIP. The archive is stored as the
 * snapshot's exact bytes and re-read on every replay, so this reader has to be
 * deterministic and strict rather than forgiving:
 *
 *   - Entries come from the central directory. OASIS sets general-purpose bit 3
 *     (data descriptor), so the local header's CRC and sizes are zero and only
 *     the central directory carries them.
 *   - Only methods 0 (stored) and 8 (deflate) are read. ZIP64, encryption,
 *     multi-disk archives, unsafe names (`..`, absolute or drive paths),
 *     duplicate names and overlapping entries are rejected.
 *   - Declared uncompressed sizes are summed and capped before anything is
 *     inflated, inflation is bounded by the declared size, and every entry's
 *     CRC-32 and length are verified (zip-bomb and corruption guard).
 */

import { inflateRawSync } from "node:zlib";

export const ZIP_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 1024;

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export interface ZipOptions {
  /** Cap on the summed declared uncompressed size. Defaults to ZIP_MAX_TOTAL_BYTES. */
  maxTotalBytes?: number;
}

let crcTable: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320), as ZIP records it. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeName(raw: Uint8Array, utf8: boolean): string {
  if (!utf8 && raw.some((byte) => byte > 0x7f)) throw new Error("ZIP entry name is not ASCII and not flagged UTF-8");
  const name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  if (!name || name.includes("\u0000")) throw new Error("ZIP entry has an empty or NUL name");
  if (/^[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) throw new Error(`ZIP entry has an absolute path: ${name}`);
  if (name.split(/[\\/]/).some((segment) => segment === "..")) throw new Error(`ZIP entry escapes its root: ${name}`);
  return name;
}

function findEndOfCentralDirectory(view: DataView): number {
  const last = view.byteLength - EOCD_SIZE;
  if (last < 0) throw new Error("Not a ZIP archive: too short");
  const first = Math.max(0, last - MAX_COMMENT);
  for (let offset = last; offset >= first; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    // A signature inside the comment is not the record: the comment length must
    // account for exactly the remaining bytes.
    if (offset + EOCD_SIZE + view.getUint16(offset + 20, true) === view.byteLength) return offset;
  }
  throw new Error("Not a ZIP archive: no end of central directory record");
}

/** Read every file entry of an archive held fully in memory. Directory entries are skipped. */
export function readZip(bytes: Uint8Array, options: ZipOptions = {}): ZipEntry[] {
  const cap = options.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE) throw new Error("ZIP64 archives are not supported");
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported");
  }
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw new Error("Multi-disk ZIP archives are not supported");
  if (totalEntries > MAX_ENTRIES) throw new Error(`ZIP has ${totalEntries} entries; at most ${MAX_ENTRIES} are read`);
  if (centralOffset + centralSize > eocd) throw new Error("ZIP central directory overlaps its end record");

  interface Pending { name: string; directory: boolean; method: number; crc: number; compressed: number; size: number; start: number; end: number; local: number }
  const pending: Pending[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + CENTRAL_SIZE > centralOffset + centralSize || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error("ZIP central directory is truncated or corrupt");
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const startDisk = view.getUint16(cursor + 34, true);
    const local = view.getUint32(cursor + 42, true);
    const next = cursor + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize) throw new Error("ZIP central directory entry overruns the directory");
    if (flags & 0x0001 || flags & 0x0040) throw new Error("Encrypted ZIP entries are not supported");
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new Error("ZIP64 entries are not supported");
    if (startDisk !== 0) throw new Error("Multi-disk ZIP archives are not supported");
    if (method !== 0 && method !== 8) throw new Error(`ZIP compression method ${method} is not supported`);
    const rawName = bytes.subarray(cursor + CENTRAL_SIZE, cursor + CENTRAL_SIZE + nameLength);
    const name = safeName(rawName, (flags & 0x0800) !== 0);
    if (names.has(name)) throw new Error(`ZIP has duplicate entry ${name}`);
    names.add(name);
    const directory = name.endsWith("/");
    if (directory && (size !== 0 || compressed !== 0)) throw new Error(`ZIP directory entry ${name} carries data`);
    if (method === 0 && compressed !== size) throw new Error(`Stored ZIP entry ${name} has mismatched sizes`);
    total += size;
    if (total > cap) throw new Error(`ZIP declares more than ${cap} uncompressed bytes`);

    if (local + LOCAL_SIZE > centralOffset || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
      throw new Error(`ZIP local header for ${name} is missing`);
    }
    const localFlags = view.getUint16(local + 6, true);
    if (localFlags & 0x0001 || localFlags & 0x0040) throw new Error("Encrypted ZIP entries are not supported");
    if (view.getUint16(local + 8, true) !== method) throw new Error(`ZIP local header for ${name} disagrees on method`);
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const localName = bytes.subarray(local + LOCAL_SIZE, local + LOCAL_SIZE + localNameLength);
    if (localName.length !== rawName.length || localName.some((byte, at) => byte !== rawName[at])) {
      throw new Error(`ZIP local header name disagrees with the central directory for ${name}`);
    }
    const start = local + LOCAL_SIZE + localNameLength + localExtraLength;
    const end = start + compressed;
    if (end > centralOffset) throw new Error(`ZIP entry ${name} overruns the central directory`);
    pending.push({ name, directory, method, crc, compressed, size, start, end, local });
    cursor = next;
  }

  // Overlapping entries let a small archive expand into many copies of one stream.
  const ordered = [...pending].sort((a, b) => a.local - b.local);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].local < ordered[index - 1].end) throw new Error("ZIP entries overlap");
  }

  const entries: ZipEntry[] = [];
  for (const entry of pending) {
    if (entry.directory) continue;
    const raw = bytes.subarray(entry.start, entry.end);
    let data: Uint8Array;
    if (entry.method === 0) {
      data = raw;
    } else {
      try {
        data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }));
      } catch (error) {
        throw new Error(`ZIP entry ${entry.name} failed to inflate within its declared size: ${(error as Error).message}`);
      }
    }
    if (data.length !== entry.size) throw new Error(`ZIP entry ${entry.name} is ${data.length} bytes, directory declares ${entry.size}`);
    if (crc32(data) !== entry.crc) throw new Error(`ZIP entry ${entry.name} fails its CRC-32 check`);
    entries.push({ name: entry.name, data });
  }
  return entries;
}
