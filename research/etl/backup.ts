import { createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digest } from "../../lib/evidence/canonical";
import { atomicJson, reportRevision, stateRoot, verifyLocation, type LocationReport } from "./pipeline";
import { replayAssets, type AssetManifest } from "./assets";
import { readLocationAssets } from "./load-assets";
import { replaySnapshot } from "../snapshot";

const FORMAT = "gridsentinel.backup/1";
const DATA_FORMAT = "gridsentinel.data-backup/1";

function key(): Buffer {
  const value = process.env.ETL_BACKUP_KEY ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error("ETL_BACKUP_KEY must be a 32-byte hex key");
  return Buffer.from(value, "hex");
}

/**
 * AES-256-GCM envelope fields must be a 12-byte nonce and a full 16-byte tag.
 * Checked before decryption: without `authTagLength`, Node accepts a truncated
 * tag (as short as 4 bytes) and verifies only that prefix (DEP0182).
 */
function checkEnvelope(envelope: { nonce?: unknown; tag?: unknown }): void {
  if (typeof envelope.nonce !== "string" || !/^[a-fA-F0-9]{24}$/.test(envelope.nonce)) throw new Error("Invalid backup nonce");
  if (typeof envelope.tag !== "string" || !/^[a-fA-F0-9]{32}$/.test(envelope.tag)) throw new Error("Invalid backup authentication tag");
}

/** Asset source ids become a directory name on restore. */
const ASSET_SOURCE = /^[a-z0-9_-]{1,64}$/;

interface BoundInventory { location: string; revision: string; sha256: string; bytes: string }

/** Exact stored bytes of the inventory revision a report is bound to. */
async function boundInventory({ location, revision }: { location: string; revision: string }): Promise<BoundInventory> {
  if (!await readLocationAssets(location, revision)) throw new Error("Bound asset inventory missing");
  const bytes = await readFile(resolve(stateRoot(), "loaded-assets", location, `${revision}.json`));
  if (digest(JSON.parse(bytes.toString("utf8"))) !== revision) throw new Error("Bound asset inventory checksum mismatch");
  return { location, revision, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.toString("base64") };
}

/** Republish a backed-up inventory revision; keeps an existing latest pointer. */
async function republishInventory(binding: { location: string; revision: string }, inventory: BoundInventory): Promise<void> {
  if (inventory.location !== binding.location || inventory.revision !== binding.revision ||
      !/^location-[a-f0-9]{24}$/.test(inventory.location) || !/^[a-f0-9]{64}$/.test(inventory.revision)) {
    throw new Error("Backup inventory does not match report binding");
  }
  const bytes = Buffer.from(inventory.bytes, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== inventory.sha256) throw new Error("Backup inventory checksum mismatch");
  const data: unknown = JSON.parse(bytes.toString("utf8"));
  if (digest(data) !== inventory.revision) throw new Error("Backup inventory revision mismatch");
  const directory = resolve(stateRoot(), "loaded-assets", inventory.location);
  await atomicJson(resolve(directory, `${inventory.revision}.json`), data);
  // Point latest at the restored revision only if no pointer exists; link() never clobbers.
  const temporary = resolve(directory, `latest.json.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ revision: inventory.revision }) + "\n", { flag: "wx" });
    await link(temporary, resolve(directory, "latest.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function backupReport(report: LocationReport, destination: string): Promise<void> {
  await verifyLocation(report);
  const blobs: Record<string, string> = {};
  for (const snapshot of report.evidence.snapshots) {
    blobs[snapshot.sha256] = (await readFile(snapshot.cache_path)).toString("base64");
  }
  const inventory = report.assets ? await boundInventory(report.assets) : undefined;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(FORMAT));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ report, blobs, ...(inventory ? { inventory } : {}) }), "utf8"), cipher.final()]);
  await atomicJson(destination, {
    format: FORMAT, nonce: nonce.toString("hex"), tag: cipher.getAuthTag().toString("hex"),
    ciphertext: bytes.toString("base64"),
  });
}

export async function restoreReport(path: string): Promise<LocationReport> {
  const envelope = JSON.parse(await readFile(path, "utf8"));
  if (envelope.format !== FORMAT) throw new Error("Unsupported backup format");
  checkEnvelope(envelope);
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(envelope.nonce, "hex"), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(FORMAT));
  decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
  const payload = JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final(),
  ]).toString("utf8")) as { report: LocationReport; blobs: Record<string, string>; inventory?: BoundInventory };
  const root = stateRoot();
  const id = payload.report.evidence.region.id;
  if (!/^location-[a-f0-9]{24}$/.test(id)) throw new Error("Invalid backup location");
  const paths = new Map<string, string>();
  await mkdir(resolve(root, "blobs"), { recursive: true });
  for (const snapshot of payload.report.evidence.snapshots) {
    const bytes = Buffer.from(payload.blobs[snapshot.sha256], "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256) throw new Error("Backup blob checksum mismatch");
    const target = `${root}/blobs/${snapshot.sha256}.json`;
    try {
      await writeFile(target, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    paths.set(snapshot.id, target);
    snapshot.cache_path = target;
  }
  for (const state of Object.values(payload.report.feeds)) {
    if (state.snapshot) {
      const restored = paths.get(state.snapshot.id);
      if (!restored) throw new Error("Backup omitted a feed snapshot");
      state.snapshot.cache_path = restored;
    }
  }
  await verifyLocation(payload.report);
  // Backups written before inventory embedding carry no `inventory` and restore as before.
  if (payload.report.assets && payload.inventory) await republishInventory(payload.report.assets, payload.inventory);
  const revision = reportRevision(payload.report);
  await atomicJson(resolve(root, "revisions", id, `${revision}.json`), payload.report);
  return payload.report;
}

async function seal(payload: unknown, destination: string): Promise<void> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(DATA_FORMAT));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  await atomicJson(destination, { format: DATA_FORMAT, nonce: nonce.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("base64") });
}

async function unseal(path: string): Promise<any> {
  const envelope = JSON.parse(await readFile(path, "utf8"));
  if (envelope.format !== DATA_FORMAT) throw new Error("Unsupported data backup format");
  checkEnvelope(envelope);
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(envelope.nonce, "hex"), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(DATA_FORMAT));
  decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
}

async function readBlob(sha256: string, cachePath: string): Promise<string> {
  const bytes = await readFile(cachePath);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Capture checksum mismatch");
  return bytes.toString("base64");
}

async function writeBlobs(blobs: Record<string, string>): Promise<Map<string, string>> {
  const root = stateRoot();
  await mkdir(resolve(root, "blobs"), { recursive: true });
  const paths = new Map<string, string>();
  for (const [sha256, encoded] of Object.entries(blobs)) {
    const bytes = Buffer.from(encoded, "base64");
    if (!/^[a-f0-9]{64}$/.test(sha256) || createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new Error("Backup blob checksum mismatch");
    }
    const path = resolve(root, "blobs", `${sha256}.json`);
    try { await writeFile(path, bytes, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    paths.set(sha256, path);
  }
  return paths;
}

async function manifestsUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? manifestsUnder(child) : entry.name === "manifest.json" ? [child] : [];
  }));
  return nested.flat();
}

export async function backupAssets(id: string, revision: string, destination: string): Promise<void> {
  const loaded = await readLocationAssets(id, revision);
  if (!loaded) throw new Error("Loaded asset revision not found");
  const datasets = (loaded.data as { datasets?: { source: string; snapshots: { id: string; sha256: string; cache_path: string }[] }[] }).datasets;
  if (!Array.isArray(datasets)) throw new Error("Invalid loaded asset revision");
  const manifests: AssetManifest[] = [];
  const blobs: Record<string, string> = {};
  const candidates = await manifestsUnder(resolve(stateRoot(), "assets", id));
  for (const dataset of datasets) {
    const wanted = new Set(dataset.snapshots.map(({ id: snapshotId }) => snapshotId));
    let matched: AssetManifest | undefined;
    for (const path of candidates) {
      const value = JSON.parse(await readFile(path, "utf8")) as AssetManifest;
      if (value.source === dataset.source && [value.index, ...value.pages].every((item) => wanted.has(item.id)) &&
          wanted.size === 1 + value.pages.length) { matched = value; break; }
    }
    if (!matched) throw new Error(`Asset manifest missing for ${dataset.source}`);
    await replayAssets(matched);
    manifests.push(matched);
    for (const snapshot of [matched.index, ...matched.pages]) blobs[snapshot.sha256] = await readBlob(snapshot.sha256, snapshot.cache_path);
  }
  await seal({ kind: "assets", location: id, revision, data: loaded.data, manifests, blobs }, destination);
}

export async function restoreAssets(path: string): Promise<{ location: string; revision: string }> {
  const payload = await unseal(path) as { kind: string; location: string; revision: string; data: unknown; manifests: AssetManifest[]; blobs: Record<string, string> };
  if (payload.kind !== "assets" || !/^location-[a-f0-9]{24}$/.test(payload.location) || digest(payload.data) !== payload.revision) {
    throw new Error("Invalid asset backup revision");
  }
  for (const manifest of payload.manifests) {
    if (typeof manifest?.source !== "string" || !ASSET_SOURCE.test(manifest.source)) throw new Error("Invalid asset backup source");
  }
  const paths = await writeBlobs(payload.blobs);
  const restoredSnapshots = new Map<string, string>();
  for (const manifest of payload.manifests) {
    for (const snapshot of [manifest.index, ...manifest.pages]) {
      const restored = paths.get(snapshot.sha256);
      if (!restored) throw new Error("Asset backup omitted a capture");
      snapshot.cache_path = restored;
      restoredSnapshots.set(snapshot.id, restored);
    }
    await replayAssets(manifest);
    const directory = resolve(stateRoot(), "assets", payload.location, manifest.source, digest(manifest));
    await atomicJson(resolve(directory, "manifest.json"), manifest);
  }
  const data = payload.data as { datasets: { snapshots: { id: string; cache_path: string }[] }[] };
  for (const dataset of data.datasets) for (const snapshot of dataset.snapshots) {
    const restored = restoredSnapshots.get(snapshot.id);
    if (!restored) throw new Error("Asset backup omitted a revision capture");
    snapshot.cache_path = restored;
  }
  const revision = digest(data);
  const directory = resolve(stateRoot(), "loaded-assets", payload.location);
  await atomicJson(resolve(directory, `${revision}.json`), data);
  await atomicJson(resolve(directory, "latest.json"), { revision });
  return { location: payload.location, revision };
}

export async function backupWeather(snapshotId: string, destination: string): Promise<void> {
  if (!/^[a-z]+_[a-f0-9]{16}$/.test(snapshotId)) throw new Error("Expected weather snapshot ID");
  const path = resolve(stateRoot(), "weather", `${snapshotId}.json`);
  const archive = JSON.parse(await readFile(path, "utf8"));
  if (archive.schema !== "gridsentinel.weather-history/1" || archive.snapshot?.id !== snapshotId) throw new Error("Invalid weather archive");
  await replaySnapshot(archive.snapshot);
  const blob = await readBlob(archive.snapshot.sha256, archive.snapshot.cache_path);
  await seal({ kind: "weather", archive, blob }, destination);
}

export async function restoreWeather(path: string): Promise<{ snapshot: string; rows: number }> {
  const payload = await unseal(path) as { kind: string; archive: any; blob: string };
  const archive = payload.archive;
  if (payload.kind !== "weather" || archive?.schema !== "gridsentinel.weather-history/1" ||
      !/^[a-z]+_[a-f0-9]{16}$/.test(archive.snapshot?.id)) throw new Error("Invalid weather backup");
  const bytes = Buffer.from(payload.blob, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== archive.snapshot.sha256) throw new Error("Backup blob checksum mismatch");
  const root = stateRoot();
  const blobPath = resolve(root, "blobs", `${archive.snapshot.sha256}.json`);
  await mkdir(resolve(root, "blobs"), { recursive: true });
  try { await writeFile(blobPath, bytes, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  archive.snapshot.cache_path = blobPath;
  await replaySnapshot(archive.snapshot);
  await atomicJson(resolve(root, "weather", `${archive.snapshot.id}.json`), archive);
  return { snapshot: archive.snapshot.id, rows: archive.rows.length };
}
