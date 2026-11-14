import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { atomicJson, reportRevision, stateRoot, verifyLocation, type LocationReport } from "./pipeline";

const FORMAT = "gridsentinel.backup/1";

function key(): Buffer {
  const value = process.env.ETL_BACKUP_KEY ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error("ETL_BACKUP_KEY must be a 32-byte hex key");
  return Buffer.from(value, "hex");
}

export async function backupReport(report: LocationReport, destination: string): Promise<void> {
  await verifyLocation(report);
  const blobs: Record<string, string> = {};
  for (const snapshot of report.evidence.snapshots) {
    blobs[snapshot.sha256] = (await readFile(snapshot.cache_path)).toString("base64");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(FORMAT));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ report, blobs }), "utf8"), cipher.final()]);
  await atomicJson(destination, {
    format: FORMAT, nonce: nonce.toString("hex"), tag: cipher.getAuthTag().toString("hex"),
    ciphertext: bytes.toString("base64"),
  });
}

export async function restoreReport(path: string): Promise<LocationReport> {
  const envelope = JSON.parse(await readFile(path, "utf8"));
  if (envelope.format !== FORMAT) throw new Error("Unsupported backup format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(envelope.nonce, "hex"));
  decipher.setAAD(Buffer.from(FORMAT));
  decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
  const payload = JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final(),
  ]).toString("utf8")) as { report: LocationReport; blobs: Record<string, string> };
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
  const revision = reportRevision(payload.report);
  await atomicJson(resolve(root, "revisions", id, `${revision}.json`), payload.report);
  return payload.report;
}
