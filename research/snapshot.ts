/**
 * Snapshot construction and replay.
 *
 * Three ways a snapshot enters a bundle:
 *   1. `fixture`  — a captured HTTP response + `<file>.meta.json` (committed).
 *   2. `artifact` — a file already in the repo (layers, seed data).
 *   3. `live`     — a fresh fetch; writes the bytes + metadata so it becomes (1).
 *
 * The build defaults to (1) and (2). That is what makes `npm run evidence:build`
 * deterministic and network-free. `--refresh` is the only path that performs I/O.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { computeSnapshotId } from "../lib/evidence/canonical";
import { sha256BytesHex } from "../lib/evidence/sha256";
import type { SourceSnapshot } from "../lib/evidence/schema";
import { parseSnapshot } from "./parsers";

export const REPO_ROOT = process.cwd();

export function toRepoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join("/");
}

export function fromRepoPath(relativePath: string): string {
  return resolve(REPO_ROOT, relativePath);
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".json":
    case ".geojson":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".txt":
    case ".md":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

export interface LoadedSnapshot {
  snapshot: SourceSnapshot;
  bytes: Uint8Array;
  data: unknown;
}

export interface SnapshotInput {
  sourceId: string;
  url: string;
  method?: "GET" | "POST";
  requestDigest?: string | null;
  retrievedAt: string;
  status?: number;
  contentType?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  bytes: Uint8Array;
  cachePath: string;
  parser: string;
  notes?: string[];
  extraRecordCount?: number | null;
}

/** Turn bytes + provenance into a content-addressed snapshot, and parse them. */
export function buildSnapshot(input: SnapshotInput): LoadedSnapshot {
  const sha256 = sha256BytesHex(input.bytes);
  const parsed = parseSnapshot(input.bytes, input.parser);
  const id = computeSnapshotId({
    source_id: input.sourceId,
    url: input.url,
    method: input.method ?? "GET",
    request_digest: input.requestDigest ?? null,
    sha256,
  });

  return {
    snapshot: {
      id,
      source_id: input.sourceId,
      url: input.url,
      method: input.method ?? "GET",
      request_digest: input.requestDigest ?? null,
      retrieved_at: input.retrievedAt,
      http: {
        status: input.status ?? 200,
        content_type: input.contentType ?? null,
        etag: input.etag ?? null,
        last_modified: input.lastModified ?? null,
      },
      bytes: input.bytes.length,
      sha256,
      cache_path: input.cachePath,
      parser: input.parser,
      parser_version: "1",
      record_count: input.extraRecordCount ?? parsed.recordCount,
      notes: input.notes ?? [],
    },
    bytes: input.bytes,
    data: parsed.data,
  };
}

/** Read a committed HTTP capture + its metadata sidecar. */
export async function loadFixture(
  sourceId: string,
  path: string,
  parser: string,
  notes: string[] = [],
): Promise<LoadedSnapshot> {
  const absolute = fromRepoPath(path);
  const [bytes, metaText] = await Promise.all([
    readFile(absolute),
    readFile(`${absolute}.meta.json`, "utf8").catch(() => null),
  ]);
  if (!metaText) {
    throw new Error(
      `fixture ${path} has no .meta.json; capture it with research/tools/capture.mjs`,
    );
  }
  const meta = JSON.parse(metaText) as {
    url: string;
    method?: "GET" | "POST";
    request_sha256?: string | null;
    status?: number;
    content_type?: string | null;
    etag?: string | null;
    last_modified?: string | null;
    captured_at: string;
  };
  return buildSnapshot({
    sourceId,
    url: meta.url,
    method: meta.method ?? "GET",
    requestDigest: meta.request_sha256 ?? null,
    retrievedAt: meta.captured_at,
    status: meta.status ?? 200,
    contentType: meta.content_type ?? null,
    etag: meta.etag ?? null,
    lastModified: meta.last_modified ?? null,
    bytes: new Uint8Array(bytes),
    cachePath: path,
    parser,
    notes,
  });
}

/** Hash an in-repo artifact (layer, seed dataset). */
export async function loadArtifact(
  sourceId: string,
  path: string,
  parser: string,
  options: { capturedAt: string; url?: string; notes?: string[] },
): Promise<LoadedSnapshot> {
  const absolute = fromRepoPath(path);
  const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute)]);
  return buildSnapshot({
    sourceId,
    url: options.url ?? `repo://${path}`,
    retrievedAt: options.capturedAt,
    status: 200,
    contentType: contentTypeFor(path),
    lastModified: info.mtime.toISOString(),
    bytes: new Uint8Array(bytes),
    cachePath: path,
    parser,
    notes: options.notes ?? [],
  });
}

/**
 * Re-read a snapshot recorded in a bundle and prove its bytes still hash to the
 * recorded digest. Used by `verify --files`; never by the web app.
 */
export async function replaySnapshot(snapshot: SourceSnapshot): Promise<LoadedSnapshot> {
  const absolute = fromRepoPath(snapshot.cache_path);
  const bytes = new Uint8Array(await readFile(absolute));
  const sha256 = sha256BytesHex(bytes);
  if (sha256 !== snapshot.sha256) {
    throw new Error(
      `snapshot ${snapshot.id}: ${snapshot.cache_path} hashes to ${sha256}, bundle records ${snapshot.sha256}`,
    );
  }
  const parsed = parseSnapshot(bytes, snapshot.parser);
  if (
    snapshot.record_count !== null &&
    parsed.recordCount !== null &&
    snapshot.record_count !== parsed.recordCount
  ) {
    throw new Error(
      `snapshot ${snapshot.id}: parser ${snapshot.parser} yields ${parsed.recordCount} records, bundle records ${snapshot.record_count}`,
    );
  }
  return { snapshot, bytes, data: parsed.data };
}

export interface LiveFetchOptions {
  sourceId: string;
  url: string;
  method?: "GET" | "POST";
  body?: Uint8Array;
  headers?: Record<string, string>;
  parser: string;
  /** Repo-relative path to write the bytes + meta. */
  fixturePath: string;
  attempts?: number;
  timeoutMs?: number;
}

/**
 * Fetch once and persist the exact response. Retries honour the Overpass 502
 * guidance (exponential backoff). A failed fetch throws; it never becomes an
 * empty snapshot.
 */
export async function fetchLive(options: LiveFetchOptions): Promise<LoadedSnapshot> {
  const attempts = options.attempts ?? 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
      const response = await fetch(options.url, {
        method: options.method ?? "GET",
        headers: {
          "user-agent": "Mapergy-Research/0.1 (evidence capture)",
          ...(options.headers ?? {}),
        },
        body: options.body ? (options.body as unknown as BodyInit) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const capturedAt = new Date().toISOString();
      const absolute = fromRepoPath(options.fixturePath);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes);
      const meta = {
        url: options.url,
        method: options.method ?? "GET",
        request_sha256: options.body ? sha256BytesHex(options.body) : null,
        status: response.status,
        bytes: bytes.length,
        sha256: sha256BytesHex(bytes),
        content_type: response.headers.get("content-type"),
        etag: response.headers.get("etag"),
        last_modified: response.headers.get("last-modified"),
        captured_at: capturedAt,
        captured_by: "research/snapshot.ts",
      };
      await writeFile(`${absolute}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
      return buildSnapshot({
        sourceId: options.sourceId,
        url: options.url,
        method: options.method ?? "GET",
        requestDigest: meta.request_sha256,
        retrievedAt: capturedAt,
        status: response.status,
        contentType: meta.content_type,
        etag: meta.etag,
        lastModified: meta.last_modified,
        bytes,
        cachePath: options.fixturePath,
        parser: options.parser,
        notes: [`Fetched live at ${capturedAt}; persisted as a replayable fixture.`],
      });
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const wait = 1000 * 2 ** (attempt - 1);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, wait));
    }
  }
  throw new Error(
    `fetchLive ${options.url} failed after ${attempts} attempts: ${(lastError as Error).message}`,
  );
}
