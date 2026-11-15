/**
 * Outbound HTTP for the ETL.
 *
 * Every collector request goes through this module so three properties hold for
 * the whole pipeline:
 *
 *   1. A normalized upstream request is fetched once per process, even when two
 *      locations share it (a shared NWS station, one EIA respondent, the CAISO
 *      system feed). Concurrent callers receive the same bytes.
 *   2. Per-host concurrency is bounded, request starts to a host can be spaced
 *      by a minimum interval (`ETL_HTTP_HOST_MIN_INTERVAL_MS`, default
 *      `oasis.caiso.com=6000`), and failures retry with exponential backoff
 *      honouring `Retry-After`, so a provider's rate limit is respected instead
 *      of hammered.
 *   3. An unchanged resource is revalidated with `If-None-Match` /
 *      `If-Modified-Since`; a `304` reuses the bytes already captured, so a
 *      five-minute loop does not re-download identical CSV.
 *
 * The layer is deliberately process-local. Cross-process deduplication needs
 * shared state (Redis) and is not claimed here: two collector processes may
 * still fetch the same URL. `setSharedDedupe` lets a caller inject an optional
 * cross-process layer (see `shared-dedupe.ts`); it is null by default.
 */

/**
 * How a request treats a 3xx answer. `"error"` (the default) fails closed: any
 * redirect is rejected. `follow` walks at most `maxHops` (default 3) `Location`
 * headers, and only to HTTPS origins listed in `allowOrigins`.
 */
export type RedirectPolicy = "error" | { follow: true; allowOrigins: string[]; maxHops?: number };

export interface HttpOptions {
  accept?: string;
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  redirect?: RedirectPolicy;
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
const DEFAULT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"]);
const DEFAULT_MAX_HOPS = 3;
const MAX_RETRY_AFTER_MS = 60_000;
/** Hosts that throttle anonymous callers by request rate. Others are unspaced. */
const DEFAULT_HOST_MIN_INTERVAL_MS = "oasis.caiso.com=6000";

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
/**
 * Per-host start spacing. `next` is the earliest start a new request may wait
 * for outside its slot; `last` is the most recent start claimed; `fetched` is
 * when the most recent request was actually handed to `fetch`.
 */
const spacings = new Map<string, { next: number; last: number; fetched: number }>();
const metrics: HttpMetrics = { requests: 0, deduped: 0, revalidated: 0, retries: 0 };
let cacheBytes = 0;

function setting(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep until the wall clock reaches `instant`; a timer may fire a millisecond early. */
async function sleepUntil(instant: number): Promise<void> {
  while (Date.now() < instant) await sleep(instant - Date.now());
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

function parseIntervals(raw: string): Map<string, number> | null {
  const entries: [string, unknown][] = [];
  const text = raw.trim();
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    entries.push(...Object.entries(parsed));
  } else {
    for (const part of text.split(",")) {
      if (!part.trim()) continue;
      const match = /^\s*([^=\s]+)\s*=\s*([^=\s]+)\s*$/.exec(part);
      if (!match) return null;
      entries.push([match[1], Number(match[2])]);
    }
  }
  const result = new Map<string, number>();
  for (const [host, value] of entries) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !host) return null;
    result.set(host.toLowerCase(), value);
  }
  return result;
}

/**
 * Minimum milliseconds between request starts to `host`. The setting is a JSON
 * object (`{"oasis.caiso.com":6000}`) or `host=ms,host=ms`; it replaces the
 * default map. A malformed value falls back to the default, like other settings.
 */
export function hostMinIntervalMs(host: string): number {
  const raw = process.env.ETL_HTTP_HOST_MIN_INTERVAL_MS;
  const map = (raw !== undefined && raw.trim() !== "" ? parseIntervals(raw) : null) ??
    parseIntervals(DEFAULT_HOST_MIN_INTERVAL_MS)!;
  return map.get(host.toLowerCase()) ?? 0;
}

/**
 * Acquire a host slot whose request start is at least the host's minimum
 * interval after the previous start. The bulk of the wait happens before the
 * slot is taken; the slot is held only for the remainder when slot contention
 * delayed an earlier start past its reservation.
 */
async function acquireSpaced(host: string): Promise<void> {
  const interval = hostMinIntervalMs(host);
  if (interval <= 0) return acquire(host);
  let spacing = spacings.get(host);
  if (!spacing) {
    spacing = { next: -Infinity, last: -Infinity, fetched: -Infinity };
    spacings.set(host, spacing);
  }
  const reserved = Math.max(Date.now(), spacing.next);
  spacing.next = reserved + interval;
  await sleepUntil(reserved);
  await acquire(host);
  // Starts are claimed synchronously in slot order, so concurrent requests
  // cannot both start inside one interval.
  const start = Math.max(Date.now(), spacing.last + interval);
  spacing.last = start;
  spacing.next = Math.max(spacing.next, start + interval);
  await sleepUntil(start);
  // The previous request reaches `fetch` a few microtasks after its claim; a
  // strict comparison also absorbs the clock's millisecond rounding.
  while (Date.now() <= spacing.fetched + interval) await sleepUntil(spacing.fetched + interval + 1);
}

/** Record that a spaced host's request is being handed to `fetch` now. */
function markFetched(host: string): void {
  const spacing = spacings.get(host);
  if (spacing) spacing.fetched = Math.max(spacing.fetched, Date.now());
}

function forget(key: string): void {
  const entry = validators.get(key);
  if (!entry) return;
  validators.delete(key);
  cacheBytes -= entry.bytes.length;
}

/** Mark a validator most recently used; Map order is the LRU order. */
function touch(key: string, entry: Validator): void {
  validators.delete(key);
  validators.set(key, entry);
}

function remember(key: string, response: Response, bytes: Uint8Array): void {
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  forget(key);
  if (!etag && !lastModified) return;
  // Bytes are the binding limit; the entry ceiling only bounds map overhead.
  const maxBytes = setting("ETL_HTTP_CACHE_MAX_BYTES", DEFAULT_CACHE_MAX_BYTES);
  if (bytes.length > maxBytes) return;
  while (validators.size > 0 && (cacheBytes + bytes.length > maxBytes || validators.size >= MAX_CACHE_ENTRIES)) {
    const oldest = validators.keys().next();
    if (oldest.done) break;
    forget(oldest.value);
  }
  validators.set(key, {
    etag,
    lastModified,
    bytes,
    headers: new Headers(response.headers),
    status: response.status,
  });
  cacheBytes += bytes.length;
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

/**
 * A transport failure worth retrying, judged by error type rather than message
 * text: a timeout, an abort raised by this layer's own timer, an undici network
 * `TypeError`, or a socket/DNS error code on `cause`.
 */
function isNetworkFailure(error: unknown, timedOut: boolean): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, cause } = error as { name?: unknown; cause?: unknown };
  if (name === "TimeoutError" || name === "TypeError") return true;
  if (name === "AbortError") return timedOut;
  const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" && (NETWORK_CODES.has(code) || code.startsWith("UND_ERR_"));
}

function nextHop(current: URL, response: Response, policy: RedirectPolicy, hop: number): URL {
  if (policy === "error") {
    throw new Error(`Upstream HTTP ${response.status} redirect from ${current.origin} refused: redirects are not allowed for this request`);
  }
  const maxHops = policy.maxHops ?? DEFAULT_MAX_HOPS;
  if (hop >= maxHops) throw new Error(`Upstream exceeded ${maxHops} redirects at ${current.origin}`);
  const location = response.headers.get("location");
  if (!location) throw new Error(`Upstream HTTP ${response.status} redirect from ${current.origin} has no Location`);
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new Error(`Upstream redirect from ${current.origin} has an invalid Location`);
  }
  if (next.protocol !== "https:") throw new Error(`Upstream redirect to non-HTTPS origin ${next.origin} refused`);
  const allowed = new Set(policy.allowOrigins.map((origin) => new URL(origin).origin));
  if (!allowed.has(next.origin)) throw new Error(`Upstream redirect to disallowed origin ${next.origin} refused`);
  return next;
}

/** One round: a single fetch (plus any permitted redirect hops) under one timeout. */
async function fetchOnce(url: URL, key: string, options: HttpOptions): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const accept = options.accept ?? "application/json";
  const policy = options.redirect ?? "error";
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const transport = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (!isNetworkFailure(error, timedOut)) throw error;
      const message = error instanceof Error && error.message ? error.message : "Network failure";
      throw new RetryableError(message, null);
    }
  };
  try {
    const validator = validators.get(key);
    if (validator) touch(key, validator);
    const headers: Record<string, string> = {
      accept,
      "user-agent": options.userAgent ?? "GridSentinel/1.0",
    };
    if (validator?.etag) headers["if-none-match"] = validator.etag;
    else if (validator?.lastModified) headers["if-modified-since"] = validator.lastModified;
    let target = url;
    let response: Response;
    for (let hop = 0; ; hop += 1) {
      metrics.requests += 1;
      const current = target;
      response = await transport(() => fetch(current, { redirect: "manual", signal: controller.signal, headers }));
      if (!REDIRECT_STATUS.has(response.status)) break;
      await response.body?.cancel().catch(() => {});
      target = nextHop(current, response, policy, hop);
    }
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
    const ok = response;
    const bytes = await transport(() => readCapped(ok, maxBytes));
    remember(key, response, bytes);
    return { bytes, status: response.status, headers: new Headers(response.headers), revalidated: false };
  } finally {
    clearTimeout(timer);
  }
}

async function attempt(url: URL, key: string, options: HttpOptions): Promise<HttpResponse> {
  const retries = options.retries ?? setting("ETL_HTTP_RETRY_ATTEMPTS", 3);
  for (let round = 0; ; round += 1) {
    let failure: unknown = undefined;
    // The host slot covers only the fetch itself; it is released before any
    // backoff so a rate-limited request does not starve its neighbours. Each
    // round is a request start and so respects the host's minimum spacing.
    await acquireSpaced(url.hostname);
    try {
      // fetchOnce calls fetch synchronously, so this marks the actual start.
      markFetched(url.hostname);
      return await fetchOnce(url, key, options);
    } catch (error) {
      failure = error;
    } finally {
      release(url.hostname);
    }
    if (!isRetryable(failure) || round >= retries) {
      throw failure instanceof Error ? failure : new Error("Upstream request failed");
    }
    metrics.retries += 1;
    const wait = failure.waitMs ?? setting("ETL_HTTP_RETRY_BASE_MS", 300) * 2 ** round;
    await sleep(Math.max(0, wait));
  }
}

/**
 * Optional cross-process dedupe consulted inside the in-process dedupe. `key`
 * is the in-process key (`href \0 accept`); `fetch` performs the normal
 * attempt. An implementation must fall back to `fetch` on any shared-state
 * failure and must return bytes only after verifying them.
 */
export interface SharedDedupe {
  run(key: string, fetch: () => Promise<HttpResponse>): Promise<HttpResponse>;
}

let sharedDedupe: SharedDedupe | null = null;

/** Install (or with null, remove) the cross-process dedupe layer. */
export function setSharedDedupe(impl: SharedDedupe | null): void {
  sharedDedupe = impl;
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
  const fetcher = () => attempt(url, key, { ...options, accept });
  const task = sharedDedupe ? sharedDedupe.run(key, fetcher) : fetcher();
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
  cacheBytes = 0;
  inflight.clear();
  gates.clear();
  spacings.clear();
  metrics.requests = 0;
  metrics.deduped = 0;
  metrics.revalidated = 0;
  metrics.retries = 0;
}
