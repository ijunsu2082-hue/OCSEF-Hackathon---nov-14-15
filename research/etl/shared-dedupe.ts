/**
 * Cross-process request dedupe over Redis, layered under `http.ts`.
 *
 * Lease protocol, per normalized request key `k = sha256(href \0 accept)`:
 *
 *   1. `GET etl:resp:<k>`. A stored response whose body checksum verifies is
 *      served without touching the upstream.
 *   2. `SET etl:lease:<k> <owner> NX PX <lease>`. The winner fetches, stores
 *      the bytes + status + headers under `etl:resp:<k>` with a short TTL
 *      (`ETL_HTTP_SHARED_TTL_MS`, default 30000) when they fit the size cap
 *      (`ETL_HTTP_SHARED_MAX_BYTES`, default 1 MiB), then releases its lease.
 *   3. Everyone else polls `GET etl:resp:<k>` with exponential backoff until
 *      the response appears, the lease disappears, or the lease TTL
 *      (`ETL_HTTP_SHARED_LEASE_MS`, default 30000) elapses; then fetches itself.
 *
 * Safety properties: waiting is bounded by the lease TTL plus one command
 * timeout, so a crashed leader can never deadlock a follower; any Redis error
 * degrades to a direct fetch; a stored body is served only when its sha256 and
 * length match the stored metadata, the metadata digest matches, and an
 * HMAC-SHA256 (key `ETL_HTTP_SHARED_HMAC_KEY`) over the whole record and its
 * request key verifies. Plain digests only catch corruption; the HMAC stops
 * anyone who can write to Redis but lacks the key from injecting a capture.
 *
 * Release is GET-then-DEL (no Lua), so a lease that expired and was re-acquired
 * between those two commands can be deleted early. The cost is one extra
 * upstream fetch, never a wrong body.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { setSharedDedupe, type HttpResponse, type SharedDedupe } from "./http";
import { RespClient } from "./resp";

/** The three commands the protocol needs; `RespClient` satisfies it. */
export interface SharedStore {
  set(key: string, value: string | Uint8Array, options?: { nx?: boolean; px?: number }): Promise<boolean>;
  get(key: string): Promise<Buffer | null>;
  del(key: string): Promise<number>;
}

export interface SharedDedupeOptions {
  /** HMAC-SHA256 key (at least 32 bytes) that signs and verifies stored records. */
  hmacKey: Uint8Array;
  /** Lease TTL and the follower's maximum wait. */
  leaseMs?: number;
  /** TTL of a stored response. */
  ttlMs?: number;
  /** Largest body that is stored for other processes. */
  maxBytes?: number;
  pollMinMs?: number;
  pollMaxMs?: number;
}

export interface SharedDedupeMetrics {
  /** Requests this instance fetched while holding the lease. */
  led: number;
  /** Requests served from a stored response (immediately or after waiting). */
  hits: number;
  /** Followers that gave up waiting and fetched themselves. */
  fallbacks: number;
  /** Stored responses rejected because a checksum did not verify. */
  rejected: number;
  /** Responses not stored because they exceeded the size cap. */
  oversize: number;
  /** Redis failures that degraded to a direct fetch. */
  errors: number;
}

type Env = Record<string, string | undefined>;

const SCHEMA = "gridsentinel.http-shared/2";
const MIN_HMAC_KEY_BYTES = 32;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function setting(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

interface Stored {
  schema: typeof SCHEMA;
  status: number;
  headers: [string, string][];
  length: number;
  sha256: string;
  meta: string;
  body: string;
  hmac: string;
}

/**
 * Parse `ETL_HTTP_SHARED_HMAC_KEY`: hex, or base64 / base64url, decoding to at
 * least 32 bytes. Null when absent or invalid.
 */
export function parseSharedHmacKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim() ?? "";
  let key: Buffer | null = null;
  if (/^(?:[0-9a-fA-F]{2})+$/.test(value)) key = Buffer.from(value, "hex");
  else if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0) key = Buffer.from(value, "base64");
  else if (/^[A-Za-z0-9_-]+$/.test(value)) key = Buffer.from(value, "base64url");
  return key && key.length >= MIN_HMAC_KEY_BYTES ? key : null;
}

/** HMAC over the canonical record (every field but `hmac`) bound to its request key id. */
function recordMac(hmacKey: Uint8Array, id: string, stored: Omit<Stored, "hmac">): Buffer {
  return createHmac("sha256", hmacKey).update(JSON.stringify([
    SCHEMA, id, stored.status, stored.headers, stored.length, stored.sha256, stored.meta, stored.body,
  ])).digest();
}

function metaDigest(status: number, headers: [string, string][], length: number, bodySha: string): string {
  return sha256(JSON.stringify([SCHEMA, status, headers, length, bodySha]));
}

/** Encode a response for `etl:resp:<id>`, signed with `hmacKey` and bound to `id`. */
export function encodeStored(response: HttpResponse, hmacKey: Uint8Array, id: string): string {
  const headers = [...response.headers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const bodySha = sha256(response.bytes);
  const unsigned: Omit<Stored, "hmac"> = {
    schema: SCHEMA,
    status: response.status,
    headers,
    length: response.bytes.length,
    sha256: bodySha,
    meta: metaDigest(response.status, headers, response.bytes.length, bodySha),
    body: Buffer.from(response.bytes).toString("base64"),
  };
  const stored: Stored = { ...unsigned, hmac: recordMac(hmacKey, id, unsigned).toString("hex") };
  return JSON.stringify(stored);
}

/** Decode a stored response for request key `id`; `"corrupt"` when anything fails to verify. */
export function decodeStored(raw: Buffer, hmacKey: Uint8Array, id: string): HttpResponse | "corrupt" {
  let stored: Stored;
  try {
    stored = JSON.parse(raw.toString("utf8"));
  } catch {
    return "corrupt";
  }
  if (typeof stored !== "object" || stored === null || stored.schema !== SCHEMA ||
      !Number.isInteger(stored.status) || !Number.isInteger(stored.length) ||
      typeof stored.sha256 !== "string" || typeof stored.meta !== "string" || typeof stored.body !== "string" ||
      typeof stored.hmac !== "string" || !/^[0-9a-f]{64}$/.test(stored.hmac) ||
      !Array.isArray(stored.headers) ||
      !stored.headers.every((pair) => Array.isArray(pair) && pair.length === 2 &&
        typeof pair[0] === "string" && typeof pair[1] === "string")) {
    return "corrupt";
  }
  // Authenticate first, in constant time; nothing below runs on an unsigned record.
  const { hmac, ...unsigned } = stored;
  if (!timingSafeEqual(Buffer.from(hmac, "hex"), recordMac(hmacKey, id, unsigned))) return "corrupt";
  const bytes = Buffer.from(stored.body, "base64");
  if (bytes.length !== stored.length || sha256(bytes) !== stored.sha256 ||
      metaDigest(stored.status, stored.headers, stored.length, stored.sha256) !== stored.meta) {
    return "corrupt";
  }
  let headers: Headers;
  try {
    headers = new Headers(stored.headers);
  } catch {
    return "corrupt";
  }
  return { bytes: new Uint8Array(bytes), status: stored.status, headers, revalidated: false };
}

export class RedisSharedDedupe implements SharedDedupe {
  private readonly store: SharedStore;
  private readonly hmacKey: Buffer;
  private readonly leaseMs: number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly pollMinMs: number;
  private readonly pollMaxMs: number;
  private readonly owner = randomUUID();
  private sequence = 0;
  readonly metrics: SharedDedupeMetrics = { led: 0, hits: 0, fallbacks: 0, rejected: 0, oversize: 0, errors: 0 };

  constructor(store: SharedStore, options: SharedDedupeOptions) {
    if (!options?.hmacKey || options.hmacKey.length < MIN_HMAC_KEY_BYTES) {
      throw new Error(`Shared dedupe needs an HMAC key of at least ${MIN_HMAC_KEY_BYTES} bytes`);
    }
    this.store = store;
    this.hmacKey = Buffer.from(options.hmacKey);
    this.leaseMs = Math.max(1, Math.floor(options.leaseMs ?? 30_000));
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? 30_000));
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes ?? 1024 * 1024));
    this.pollMinMs = Math.max(1, options.pollMinMs ?? 25);
    this.pollMaxMs = Math.max(this.pollMinMs, options.pollMaxMs ?? 500);
  }

  async run(key: string, fetch: () => Promise<HttpResponse>): Promise<HttpResponse> {
    const id = sha256(key);
    const leaseKey = `etl:lease:${id}`;
    const respKey = `etl:resp:${id}`;
    let acquired: boolean;
    const owner = `${this.owner}:${(this.sequence += 1)}`;
    try {
      const cached = await this.load(respKey, id);
      if (cached && cached !== "corrupt") {
        this.metrics.hits += 1;
        return cached;
      }
      acquired = await this.store.set(leaseKey, owner, { nx: true, px: this.leaseMs });
    } catch {
      this.metrics.errors += 1;
      return fetch();
    }
    return acquired ? this.lead(leaseKey, respKey, id, owner, fetch) : this.follow(leaseKey, respKey, id, fetch);
  }

  private async load(respKey: string, id: string): Promise<HttpResponse | "corrupt" | null> {
    const raw = await this.store.get(respKey);
    if (raw === null) return null;
    const decoded = decodeStored(raw, this.hmacKey, id);
    if (decoded === "corrupt") this.metrics.rejected += 1;
    return decoded;
  }

  private async lead(leaseKey: string, respKey: string, id: string, owner: string, fetch: () => Promise<HttpResponse>) {
    this.metrics.led += 1;
    try {
      const response = await fetch();
      if (response.bytes.length > this.maxBytes) {
        this.metrics.oversize += 1;
      } else {
        await this.store.set(respKey, encodeStored(response, this.hmacKey, id), { px: this.ttlMs }).catch(() => {
          this.metrics.errors += 1;
        });
      }
      return response;
    } finally {
      await this.release(leaseKey, owner).catch(() => {
        this.metrics.errors += 1;
      });
    }
  }

  private async release(leaseKey: string, owner: string): Promise<void> {
    const holder = await this.store.get(leaseKey);
    if (holder !== null && holder.toString("utf8") === owner) await this.store.del(leaseKey);
  }

  private async follow(leaseKey: string, respKey: string, id: string, fetch: () => Promise<HttpResponse>) {
    const deadline = Date.now() + this.leaseMs;
    let wait = this.pollMinMs;
    try {
      while (Date.now() < deadline) {
        await sleep(Math.min(wait, Math.max(1, deadline - Date.now())));
        wait = Math.min(wait * 2, this.pollMaxMs);
        const cached = await this.load(respKey, id);
        if (cached === "corrupt") break;
        if (cached) {
          this.metrics.hits += 1;
          return cached;
        }
        if ((await this.store.get(leaseKey)) === null) {
          // The leader stores before it releases, so check once more after the lease is gone.
          const late = await this.load(respKey, id);
          if (late && late !== "corrupt") {
            this.metrics.hits += 1;
            return late;
          }
          break;
        }
      }
    } catch {
      this.metrics.errors += 1;
    }
    this.metrics.fallbacks += 1;
    return fetch();
  }
}

/**
 * A Redis-backed dedupe when `REDIS_URL` is set; null (no-op) otherwise. With
 * `REDIS_URL` but no valid `ETL_HTTP_SHARED_HMAC_KEY` it refuses to enable:
 * logs one warning (never the key) and returns null.
 */
export function sharedDedupeFromEnv(env: Env = process.env): RedisSharedDedupe | null {
  const url = env.REDIS_URL;
  if (!url) return null;
  const hmacKey = parseSharedHmacKey(env.ETL_HTTP_SHARED_HMAC_KEY);
  if (!hmacKey) {
    console.warn(`GridSentinel: shared HTTP dedupe disabled (ETL_HTTP_SHARED_HMAC_KEY must be hex or base64 decoding to at least ${MIN_HMAC_KEY_BYTES} bytes)`);
    return null;
  }
  return new RedisSharedDedupe(new RespClient(url), {
    hmacKey,
    leaseMs: setting(env, "ETL_HTTP_SHARED_LEASE_MS", 30_000),
    ttlMs: setting(env, "ETL_HTTP_SHARED_TTL_MS", 30_000),
    maxBytes: setting(env, "ETL_HTTP_SHARED_MAX_BYTES", 1024 * 1024),
  });
}

/** Install the env-configured dedupe into `http.ts`; returns whether one was installed. */
export function enableSharedDedupeFromEnv(env: Env = process.env): boolean {
  const impl = sharedDedupeFromEnv(env);
  setSharedDedupe(impl);
  return impl !== null;
}
