import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { crc32, readZip } from "./zip";

const FIXTURES = "research/etl/fixtures/oasis";

interface Spec {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  flags?: number;
  /** Override the CRC written to the central directory. */
  crc?: number;
  /** Override the uncompressed size written to the central directory. */
  size?: number;
}

/** Hand-assembled archive: local headers with a data descriptor flag, central directory, end record. */
function buildZip(specs: Spec[], comment = ""): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const spec of specs) {
    const method = spec.method ?? 8;
    const payload = method === 8 ? deflateRawSync(spec.data) : Buffer.from(spec.data);
    const name = Buffer.from(spec.name, "utf8");
    const flags = spec.flags ?? 0x0808;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    // CRC and sizes stay zero in the local header, as OASIS writes them.
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(spec.crc ?? crc32(spec.data), 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(spec.size ?? spec.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(specs.length, 8);
  end.writeUInt16LE(specs.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(Buffer.byteLength(comment), 20);
  return new Uint8Array(Buffer.concat([...locals, directory, end, Buffer.from(comment)]));
}

const text = (value: string) => new Uint8Array(Buffer.from(value));

test("crc32 matches the published check value", () => {
  assert.equal(crc32(text("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test("reads the real OASIS archive through its central directory", async () => {
  const bytes = new Uint8Array(await readFile(`${FIXTURES}/rtm-prc-intvl-lmp-TH_SP15_GEN-APND.zip`));
  // OASIS writes general-purpose flags 0x0808: data descriptor + UTF-8 names.
  assert.equal(Buffer.from(bytes).readUInt16LE(6), 0x0808);
  const entries = readZip(bytes);
  assert.equal(entries.length, 1);
  assert.match(entries[0].name, /^20261114_20261114_PRC_INTVL_LMP_RTM_.*_v3\.csv$/);
  assert.equal(entries[0].data.length, 10955);
  assert.ok(Buffer.from(entries[0].data).toString("utf8").startsWith("INTERVALSTARTTIME_GMT,INTERVALENDTIME_GMT,"));
});

test("reads stored and deflated entries and tolerates an archive comment", () => {
  const archive = buildZip([
    { name: "a.csv", data: text("x,y\n1,2\n"), method: 0 },
    { name: "dir/b.txt", data: text("hello ".repeat(100)), method: 8 },
    { name: "empty.txt", data: new Uint8Array(), method: 8 },
  ], "PK\u0005\u0006 comment with a fake signature");
  const entries = readZip(archive);
  assert.deepEqual(entries.map(({ name }) => name), ["a.csv", "dir/b.txt", "empty.txt"]);
  assert.equal(Buffer.from(entries[0].data).toString(), "x,y\n1,2\n");
  assert.equal(Buffer.from(entries[1].data).toString(), "hello ".repeat(100));
  assert.equal(entries[2].data.length, 0);
});

test("corruption and declared-size mismatches fail closed", () => {
  const data = text("INTERVALSTARTTIME_GMT,VALUE\n");
  assert.throws(() => readZip(buildZip([{ name: "a.csv", data, crc: crc32(data) ^ 1 }])), /fails its CRC-32 check/);
  assert.throws(() => readZip(buildZip([{ name: "a.csv", data, method: 0, crc: 0 }])), /CRC-32/);
  assert.throws(() => readZip(buildZip([{ name: "a.csv", data, size: data.length - 1 }])), /failed to inflate within its declared size/);
  assert.throws(() => readZip(buildZip([{ name: "a.csv", data, size: data.length + 1 }])), /directory declares/);
  // Flip one byte inside the deflate stream of a real fixture-shaped archive.
  const archive = buildZip([{ name: "a.csv", data: text("1234567890".repeat(50)) }]);
  archive[40] ^= 0xff;
  assert.throws(() => readZip(archive), /inflate|CRC-32|declares/);
  assert.throws(() => readZip(text("not a zip at all, definitely")), /no end of central directory/);
  assert.throws(() => readZip(new Uint8Array(4)), /too short/);
});

test("unsafe names, encryption, ZIP64, multi-disk and zip bombs are rejected", () => {
  const data = text("a");
  for (const name of ["../evil.csv", "dir/../../evil", "/etc/passwd", "\\windows", "C:/x.csv"]) {
    assert.throws(() => readZip(buildZip([{ name, data }])), /absolute path|escapes its root/, name);
  }
  assert.throws(() => readZip(buildZip([{ name: "a", data }, { name: "a", data }])), /duplicate entry/);
  assert.throws(() => readZip(buildZip([{ name: "a.csv", data, flags: 0x0809 }])), /Encrypted/);

  const zip64 = buildZip([{ name: "a.csv", data }]);
  Buffer.from(zip64.buffer).writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
  assert.throws(() => readZip(zip64), /ZIP64/);
  const multiDisk = buildZip([{ name: "a.csv", data }]);
  Buffer.from(multiDisk.buffer).writeUInt16LE(1, multiDisk.length - 22 + 4);
  assert.throws(() => readZip(multiDisk), /Multi-disk/);
  // 1 MiB of zeros deflates to about 1 KB; a 64 KiB cap must refuse it before inflating.
  const bomb = buildZip([{ name: "zeros.csv", data: new Uint8Array(1024 * 1024) }]);
  assert.ok(bomb.length < 4096);
  assert.throws(() => readZip(bomb, { maxTotalBytes: 64 * 1024 }), /declares more than 65536 uncompressed bytes/);
  assert.equal(readZip(bomb)[0].data.length, 1024 * 1024);
});

test("unsupported methods and overlapping entries are rejected", () => {
  const data = text("abc");
  const bzip = buildZip([{ name: "a.csv", data, method: 0 }]);
  // Method field in both the local header (offset 8) and the central entry.
  const view = Buffer.from(bzip.buffer);
  const central = bzip.length - 22 - 46 - 5;
  view.writeUInt16LE(12, 8);
  view.writeUInt16LE(12, central + 10);
  assert.throws(() => readZip(bzip), /compression method 12/);

  // Two central entries pointing at the same local record.
  const one = buildZip([{ name: "a.csv", data, method: 0 }, { name: "b.csv", data, method: 0 }]);
  const second = one.length - 22 - 46 - 5;
  Buffer.from(one.buffer).writeUInt32LE(0, second + 42);
  assert.throws(() => readZip(one), /name disagrees/);

  // A valid local record for b.csv nested inside a.csv's stored data.
  const nested = Buffer.alloc(30);
  nested.writeUInt32LE(0x04034b50, 0);
  nested.writeUInt16LE(0x0808, 6);
  nested.writeUInt16LE(5, 26);
  const inner = new Uint8Array(Buffer.concat([nested, Buffer.from("b.csv"), Buffer.from(data)]));
  const overlapping = buildZip([{ name: "a.csv", data: inner, method: 0 }, { name: "b.csv", data, method: 0 }]);
  Buffer.from(overlapping.buffer).writeUInt32LE(30 + 5, overlapping.length - 22 - 46 - 5 + 42);
  assert.throws(() => readZip(overlapping), /ZIP entries overlap/);
});
