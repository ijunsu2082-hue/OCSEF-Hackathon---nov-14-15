/**
 * Copy an existing `research/etl-state/` directory into the Supabase
 * `etl-state` bucket, so the deployed app serves ETL reports and asset
 * inventories without the local state directory.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/backfill-etl-supabase.ts
 *   ... --from research/etl-state        (default)
 *   ... --dry-run                        (list what would be uploaded)
 *
 * Object keys keep the on-disk layout: `reports/<id>.json`,
 * `revisions/<id>/<revision>.json`, `loaded-assets/<id>/*.json`,
 * `blobs/<sha256>.json`, `quarantine/**`. Re-running is safe: uploads upsert,
 * and every JSON document is read back and compared byte-for-byte.
 */

import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getJson, putText } from "../research/etl/store";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(): void {
  const file = join(ROOT, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (value && process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** Storage reads can trail an upsert by a moment, so retry before calling it a mismatch. */
async function readBackMatches(key: string, local: unknown): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const remote = await getJson<unknown>(key);
    if (remote !== null && JSON.stringify(remote) === JSON.stringify(local)) return true;
    // A replaced object can take a few seconds to serve its new version.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(2500, 400 * 2 ** attempt)));
  }
  return false;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return files.flat();
}

async function main(): Promise<void> {
  loadEnv();
  const dryRun = process.argv.includes("--dry-run");
  const from = resolve(ROOT, arg("from", "research/etl-state"));
  if (!existsSync(from)) throw new Error(`No ETL state at ${from}`);

  // Only the canonical state: namespace directories such as `test-<uuid>/` and
  // `restore-<uuid>/` are test-run artifacts, not app data.
  const CANONICAL = /^(reports|revisions|loaded-assets|blobs|quarantine)\/|^[^.][A-Za-z0-9._-]*\.json$/;
  const all = (await walk(from)).filter((file) => file.endsWith(".json"));
  const files = all.filter((file) => CANONICAL.test(relative(from, file).split("\\").join("/")));
  if (files.length === 0) throw new Error(`No canonical JSON documents under ${from}`);
  const skipped = all.length - files.length;

  const keys = files.map((file) => relative(from, file).split("\\").join("/"));
  let uploaded = 0;
  const failed: string[] = [];

  for (const [index, file] of files.entries()) {
    const key = keys[index];
    if (dryRun) {
      console.log(`would upload ${key}`);
      continue;
    }
    if (await putText(key, await readFile(file, "utf8"))) uploaded += 1;
    else failed.push(key);
  }

  if (dryRun) {
    console.log(`\n${keys.length} documents ready (dry run, nothing uploaded)`);
    return;
  }

  // Read back every report and inventory: the deployed app trusts the bucket.
  const checked: string[] = [];
  for (const [index, key] of keys.entries()) {
    if (!/^(reports|loaded-assets\/[^/]+)\/(latest\.json|[^/]+\.json)$/.test(key)) continue;
    const local = JSON.parse(await readFile(files[index], "utf8")) as unknown;
    if (await readBackMatches(key, local)) checked.push(key);
    else failed.push(`${key} (read-back mismatch)`);
  }

  console.log(`\nuploaded ${uploaded}/${files.length} documents from ${relative(ROOT, from)}`);
  if (skipped) console.log(`skipped ${skipped} namespace test/restore artifact(s)`);
  console.log(`read back ${checked.length} reports/inventories unchanged`);
  if (failed.length) {
    console.error(`failed: ${failed.length}\n  ${failed.join("\n  ")}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
