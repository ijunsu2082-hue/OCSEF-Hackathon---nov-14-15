#!/usr/bin/env node
/**
 * Capture one HTTP response into the fixture store.
 *
 *   node research/tools/capture.mjs <url> <out> [--post <file>|--form <file>] [--header k:v]...
 *
 * The output is the exact bytes returned by the server. `research/fetch.ts`
 * hashes these files and records them as snapshots; the verifier re-hashes them
 * on every run. Never hand-edit a fixture — recapture it and let the digest move.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("usage: capture.mjs <url> <out> [--post <file>] [--header k:v]...");
  process.exit(2);
}

const url = args[0];
const out = resolve(args[1]);
const headers = { "user-agent": "Mapergy-Research/0.1 (+https://github.com/; evidence capture)" };
let method = "GET";
let body;

for (let i = 2; i < args.length; i += 1) {
  if (args[i] === "--post") {
    method = "POST";
    body = await readFile(resolve(args[i + 1]));
    i += 1;
  } else if (args[i] === "--form") {
    method = "POST";
    const query = await readFile(resolve(args[i + 1]), "utf8");
    body = `data=${encodeURIComponent(query)}`;
    headers["content-type"] = "application/x-www-form-urlencoded";
    i += 1;
  } else if (args[i] === "--header") {
    const [key, ...rest] = args[i + 1].split(":");
    headers[key.trim().toLowerCase()] = rest.join(":").trim();
    i += 1;
  }
}

const attempts = 4;
let lastError;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    clearTimeout(timer);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok && response.status !== 404) {
      throw new Error(`HTTP ${response.status}`);
    }
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const meta = {
      url,
      method,
      request_sha256: body ? createHash("sha256").update(body).digest("hex") : null,
      status: response.status,
      bytes: bytes.length,
      sha256: digest,
      content_type: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      last_modified: response.headers.get("last-modified"),
      captured_at: new Date().toISOString(),
      captured_by: "research/tools/capture.mjs",
    };
    await writeFile(`${out}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
    console.log(JSON.stringify({ ...meta, out }, null, 2));
    process.exit(0);
  } catch (error) {
    lastError = error;
    const wait = 1000 * 2 ** (attempt - 1);
    console.error(`[capture] attempt ${attempt}/${attempts} failed: ${error.message}; retrying in ${wait}ms`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

console.error(`[capture] failed: ${lastError?.message}`);
process.exit(1);
