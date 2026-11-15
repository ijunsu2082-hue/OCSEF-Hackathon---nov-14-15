/**
 * Outbound HTTP for the ETL.
 *
 * Every collector request goes through this module so three properties hold for
 * the whole pipeline:
 *
 *   1. A normalized upstream request is fetched once per process, even when two
 *      locations share it (a shared NWS station, one EIA respondent, the CAISO
 *      system feed). Concurrent callers receive the same bytes.
 *   2. Per-host concurrency is bounded and failures retry with exponential
 *      backoff honouring `Retry-After`, so a provider's rate limit is respected
 *      instead of hammered.
 *   3. An unchanged resource is revalidated with `If-None-Match` /
 *      `If-Modified-Since`; a `304` reuses the bytes already captured, so a
 *      five-minute loop does not re-download identical CSV.
 *
 * The layer is deliberately process-local. Cross-process deduplication needs
 * shared state (Redis) and is not claimed here: two collector processes may
 * still fetch the same URL.
 */

export interface HttpOptions {
  accept?: string;
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
}

export interface HttpResponse {
  bytes: Uint8Array;
  status: number;
  headers: Headers;
  /** True when the provider answered 304 and the cached bytes were reused. */
  revalidated: boolean;
}

export interface HttpMetrics {
  requests: number;
  deduped: number;
  revalidated: number;
  retries: number;
}

const MAX_CACHE_ENTRIES = 256;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 60_000;

interface Validator {
  etag: string | null;
  lastModified: string | null;
  bytes: Uint8Array;
  headers: Headers;
  status: number;
}

interface Gate {
  active: number;
  waiters: (() => void)[];
}

const validators = new Map<string, Validator>();
const inflight = new Map<string, Promise<HttpResponse>>();
const gates = new Map<string, Gate>();
const metrics: HttpMetrics = { requests: 0, deduped: 0, revalidated: 0, retries: 0 };

function setting(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gateFor(host: string): Gate {
  let gate = gates.get(host);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    gates.set(host, gate);
  }
  return gate;
}

function acquire(host: string): Promise<void> | void {
  const limit = Math.max(1, Math.floor(setting("ETL_HTTP_HOST_CONCURRENCY", 4)));
  const gate = gateFor(host);
  if (gate.waiters.length === 0 && gate.active < limit) {
    gate.active += 1;
    return;
  }
  // The releasing request hands its slot straight to this waiter, so the
  // active count never dips below the limit while a queue exists.
  return new Promise<void>((resolve) => gate.waiters.push(resolve));
}

function release(host: string): void {
  const gate = gates.get(host);
  if (!gate) return;
  const next = gate.waiters.shift();
  if (next) {
    next();
    return;
  }
  gate.active -= 1;
  if (gate.active <= 0) gates.delete(host);
}

function remember(key: string, response: Response, bytes: Uint8Array): void {
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  if (!etag && !lastModified) return;
  if (validators.size >= MAX_CACHE_ENTRIES) {
    const oldest = validators.keys().next();
    if (!oldest.done) validators.delete(oldest.value);
  }
  validators.set(key, {
    etag,
    lastModified,
    bytes,
    headers: new Headers(response.headers),
    status: response.status,
  });
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, seconds * 1000);
  const instant = Date.parse(raw);
  if (Number.isFinite(instant)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, instant - Date.now()));
  return null;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("Upstream response has no body");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error("Upstream response exceeds capture limit");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts);
}

class RetryableError extends Error {
  readonly retryable = true;
  readonly waitMs: number | null;
  constructor(message: string, waitMs: number | null) {
    super(message);
    this.waitMs = waitMs;
  }
}

function isRetryable(error: unknown): error is RetryableError {
  return error instanceof RetryableError;
}

async function attempt(url: URL, key: string, options: HttpOptions): Promise<HttpResponse> {
  const retries = options.retries ?? setting("ETL_HTTP_RETRY_ATTEMPTS", 3);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const accept = options.accept ?? "application/json";
  let lastError: unknown;
  for (let round = 0; round <= retries; round += 1) {
    await acquire(url.hostname);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const validator = validators.get(key);
        const headers: Record<string, string> = {
          accept,
          "user-agent": options.userAgent ?? "GridSentinel/1.0",
        };
        if (validator?.etag) headers["if-none-match"] = validator.etag;
        else if (validator?.lastModified) headers["if-modified-since"] = validator.lastModified;
        metrics.requests += 1;
        const response = await fetch(url, { redirect: "error", signal: controller.signal, headers });
        if (response.status === 304 && validator) {
          metrics.revalidated += 1;
          return {
            bytes: validator.bytes,
            status: validator.status,
            headers: validator.headers,
            revalidated: true,
          };
        }
        if (RETRYABLE_STATUS.has(response.status)) {
          await response.body?.cancel().catch(() => {});
          throw new RetryableError(`Upstream HTTP ${response.status}`, retryAfterMs(response.headers));
        }
        if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
        const bytes = await readCapped(response, maxBytes);
        remember(key, response, bytes);
        return { bytes, status: response.status, headers: new Headers(response.headers), revalidated: false };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const retryable = isRetryable(error) || (error instanceof Error && /^(fetch failed|aborted)/i.test(error.message));
      lastError = retryable && !(error instanceof RetryableError)
        ? new RetryableError(error instanceof Error ? error.message : "Network failure", null)
        : error;
      if (!retryable || round === retries) break;
      metrics.retries += 1;
      const wait = isRetryable(lastError) && lastError.waitMs !== null
        ? lastError.waitMs
        : setting("ETL_HTTP_RETRY_BASE_MS", 300) * 2 ** round;
      await sleep(Math.max(0, wait));
    } finally {
      release(url.hostname);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Upstream request failed");
}

/**
 * Fetch a URL through the shared request layer. Callers own the bytes; the
 * layer never parses or normalizes them.
 */
export async function requestBytes(url: URL, options: HttpOptions = {}): Promise<HttpResponse> {
  const accept = options.accept ?? "application/json";
  const key = `${url.href}\u0000${accept}`;
  const running = inflight.get(key);
  if (running) {
    metrics.deduped += 1;
    return running;
  }
  const task = attempt(url, key, { ...options, accept });
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

export function httpMetrics(): HttpMetrics {
  return { ...metrics };
}

/** Test hook: clear validators, in-flight requests and counters. */
export function resetHttpState(): void {
  validators.clear();
  inflight.clear();
  gates.clear();
  metrics.requests = 0;
  metrics.deduped = 0;
  metrics.revalidated = 0;
  metrics.retries = 0;
}
