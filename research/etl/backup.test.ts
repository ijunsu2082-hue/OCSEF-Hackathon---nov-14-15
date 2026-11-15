import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { digest } from "../../lib/evidence/canonical";
import { buildSnapshot } from "../snapshot";
import { restoreAssets, restoreReport, restoreWeather } from "./backup";
import { stateRoot } from "./pipeline";

const KEY = Buffer.alloc(32, 0xcd);

/** Isolated state namespace and backup key for one test. */
function scratch(t: TestContext): string {
  const priorNamespace = process.env.ETL_STATE_NAMESPACE;
  const priorKey = process.env.ETL_BACKUP_KEY;
  process.env.ETL_STATE_NAMESPACE = `backup-test-${randomUUID()}`;
  process.env.ETL_BACKUP_KEY = KEY.toString("hex");
  const root = stateRoot();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (priorNamespace === undefined) delete process.env.ETL_STATE_NAMESPACE;
    else process.env.ETL_STATE_NAMESPACE = priorNamespace;
    if (priorKey === undefined) delete process.env.ETL_BACKUP_KEY;
    else process.env.ETL_BACKUP_KEY = priorKey;
  });
  return root;
}

/** Seal `payload` exactly as backup.ts does, then let the caller mangle the envelope. */
async function envelope(path: string, format: string, payload: unknown, mangle: (fields: { nonce: Buffer; tag: Buffer }) => { nonce: Buffer; tag: Buffer } = (f) => f) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, nonce);
  cipher.setAAD(Buffer.from(format));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const fields = mangle({ nonce, tag: cipher.getAuthTag() });
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ format, nonce: fields.nonce.toString("hex"), tag: fields.tag.toString("hex"), ciphertext: ciphertext.toString("base64") }));
}

const truncated = ({ nonce, tag }: { nonce: Buffer; tag: Buffer }) => ({ nonce, tag: tag.subarray(0, 4) });

test("a GCM tag truncated to 4 bytes is rejected before decryption", async (t) => {
  const root = scratch(t);
  const report = resolve(root, "report.backup.json");
  await envelope(report, "mapergy.backup/1", { report: {}, blobs: {} }, truncated);
  await assert.rejects(restoreReport(report), /Invalid backup authentication tag/);
  const weather = resolve(root, "weather.backup.json");
  await envelope(weather, "mapergy.data-backup/1", { kind: "nope" }, truncated);
  await assert.rejects(restoreWeather(weather), /Invalid backup authentication tag/);
  await assert.rejects(restoreAssets(weather), /Invalid backup authentication tag/);
});

test("a nonce that is not 12 bytes is rejected before decryption", async (t) => {
  const root = scratch(t);
  const path = resolve(root, "nonce.backup.json");
  await envelope(path, "mapergy.data-backup/1", { kind: "nope" }, ({ tag }) => ({ nonce: Buffer.alloc(16), tag }));
  await assert.rejects(restoreWeather(path), /Invalid backup nonce/);
  const report = resolve(root, "report-nonce.backup.json");
  await envelope(report, "mapergy.backup/1", { report: {}, blobs: {} }, ({ tag }) => ({ nonce: Buffer.alloc(8), tag }));
  await assert.rejects(restoreReport(report), /Invalid backup nonce/);
});

test("an untruncated tag still restores (the data path is unchanged)", async (t) => {
  const root = scratch(t);
  const path = resolve(root, "weather.backup.json");
  await envelope(path, "mapergy.data-backup/1", { kind: "nope" });
  // Decryption succeeds; the payload check is what rejects it.
  await assert.rejects(restoreWeather(path), /Invalid weather backup/);
});

test("asset restore rejects a manifest source that would escape the location directory", async (t) => {
  const root = scratch(t);
  const location = `location-${"a".repeat(24)}`;
  const bytes = new Uint8Array(Buffer.from(JSON.stringify({ objectIdFieldName: "OBJECTID", objectIds: [] })));
  const { snapshot } = buildSnapshot({
    sourceId: "hifld-substations", url: "https://example.invalid/query?returnIdsOnly=true", bytes,
    cachePath: "unused", retrievedAt: "2026-11-14T00:00:00.000Z", parser: "json.object",
  });
  const data = { datasets: [] };
  const path = resolve(root, "assets.backup.json");
  for (const source of ["../../x", "..", "a/b", "A", "x".repeat(65), ""]) {
    const manifest = { schema: "mapergy.asset-manifest/1", query: {}, source, index: snapshot, pages: [] };
    await envelope(path, "mapergy.data-backup/1", {
      kind: "assets", location, revision: digest(data), data, manifests: [manifest],
      blobs: { [snapshot.sha256]: Buffer.from(bytes).toString("base64") },
    });
    await assert.rejects(restoreAssets(path), /Invalid asset backup source/, JSON.stringify(source));
  }
  // Nothing was written outside assets/<location>/, and the rejection came before any write.
  await assert.rejects(access(resolve(root, "x")), { code: "ENOENT" });
  await assert.rejects(access(resolve(root, "assets")), { code: "ENOENT" });
  await assert.rejects(access(resolve(root, "blobs")), { code: "ENOENT" });
});
