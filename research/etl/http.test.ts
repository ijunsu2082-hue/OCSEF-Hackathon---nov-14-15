import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { hostMinIntervalMs, httpMetrics, requestBytes, resetHttpState } from "./http";

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function setup(t: TestContext, env: Record<string, string> = {}): void {
  resetHttpState();
  const values = { ETL_HTTP_RETRY_BASE_MS: "5", ...env };
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetHttpState();
  });
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

test("concurrent identical requests share one fetch", async (t) => {
  setup(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    await delay(10);
    return new Response("shared");
  });
  const url = new URL("https://example.test/a");
  const [first, second] = await Promise.all([requestBytes(url), requestBytes(url)]);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(text(first.bytes), "shared");
  assert.equal(text(second.bytes), "shared");
  assert.equal(httpMetrics().deduped, 1);
});

test("ETag revalidation sends If-None-Match and reuses bytes on 304", async (t) => {
  setup(t);
  const seen: (string | undefined)[] = [];
  t.mock.method(globalThis, "fetch", async (_url: URL, init?: RequestInit) => {
    const sent = headerOf(init, "if-none-match");
    seen.push(sent);
    if (sent === '"v1"') return new Response(null, { status: 304 });
    return new Response("payload", { headers: { etag: '"v1"' } });
  });
  const url = new URL("https://example.test/etag");
  const first = await requestBytes(url);
  const second = await requestBytes(url);
  assert.deepEqual(seen, [undefined, '"v1"']);
  assert.equal(first.revalidated, false);
  assert.equal(second.revalidated, true);
  assert.equal(second.status, 200);
  assert.equal(text(second.bytes), "payload");
  assert.equal(httpMetrics().revalidated, 1);
});

test("Last-Modified revalidation sends If-Modified-Since and reuses bytes on 304", async (t) => {
  setup(t);
  const stamp = "Sat, 14 Nov 2026 19:00:00 GMT";
  const seen: (string | undefined)[] = [];
  t.mock.method(globalThis, "fetch", async (_url: URL, init?: RequestInit) => {
    const sent = headerOf(init, "if-modified-since");
    seen.push(sent);
    if (sent === stamp) return new Response(null, { status: 304 });
    return new Response("dated", { headers: { "last-modified": stamp } });
  });
  const url = new URL("https://example.test/dated");
  await requestBytes(url);
  const second = await requestBytes(url);
  assert.deepEqual(seen, [undefined, stamp]);
  assert.equal(second.revalidated, true);
  assert.equal(text(second.bytes), "dated");
});

test("429 with Retry-After: 0 retries once then succeeds", async (t) => {
  setup(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) return new Response(null, { status: 429, headers: { "retry-after": "0" } });
    return new Response("ok");
  });
  const response = await requestBytes(new URL("https://example.test/limited"));
  assert.equal(text(response.bytes), "ok");
  assert.equal(calls, 2);
  assert.equal(httpMetrics().retries, 1);
});

test("429 waits for the Retry-After seconds before retrying", async (t) => {
  setup(t);
  const times: number[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    times.push(performance.now());
    if (times.length === 1) return new Response(null, { status: 429, headers: { "retry-after": "0.25" } });
    return new Response("ok");
  });
  await requestBytes(new URL("https://example.test/slow"));
  assert.equal(times.length, 2);
  const gap = times[1] - times[0];
  // Base backoff is 5 ms, so a gap this long can only come from Retry-After.
  assert.ok(gap >= 240, `expected >= 240 ms between attempts, saw ${gap.toFixed(1)} ms`);
});

test("per-host concurrency is capped and other hosts are not blocked", async (t) => {
  setup(t, { ETL_HTTP_HOST_CONCURRENCY: "2" });
  const active = new Map<string, number>();
  const peak = new Map<string, number>();
  let otherDoneWhileCapped = false;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    const host = url.hostname;
    active.set(host, (active.get(host) ?? 0) + 1);
    peak.set(host, Math.max(peak.get(host) ?? 0, active.get(host)!));
    await delay(host === "capped.test" ? 40 : 1);
    if (host === "other.test" && (active.get("capped.test") ?? 0) > 0) otherDoneWhileCapped = true;
    active.set(host, active.get(host)! - 1);
    return new Response(url.pathname);
  });
  const capped = [1, 2, 3, 4, 5].map((n) => requestBytes(new URL(`https://capped.test/${n}`)));
  const other = requestBytes(new URL("https://other.test/x"));
  const results = await Promise.all([...capped, other]);
  assert.deepEqual(results.map((r) => text(r.bytes)), ["/1", "/2", "/3", "/4", "/5", "/x"]);
  assert.equal(peak.get("capped.test"), 2);
  assert.equal(otherDoneWhileCapped, true);
});

test("a request in backoff releases its host slot", async (t) => {
  setup(t, { ETL_HTTP_HOST_CONCURRENCY: "1" });
  const events: string[] = [];
  let firstA!: () => void;
  const firstAStarted = new Promise<void>((resolve) => { firstA = resolve; });
  let aCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.pathname === "/a") {
      aCalls += 1;
      events.push(`a${aCalls}`);
      if (aCalls === 1) {
        firstA();
        return new Response(null, { status: 429, headers: { "retry-after": "0.3" } });
      }
      return new Response("a");
    }
    events.push("b");
    return new Response("b");
  });
  const a = requestBytes(new URL("https://one.test/a"));
  await firstAStarted;
  const b = requestBytes(new URL("https://one.test/b")).then((r) => { events.push("b-done"); return r; });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(text(ra.bytes), "a");
  assert.equal(text(rb.bytes), "b");
  assert.deepEqual(events, ["a1", "b", "b-done", "a2"]);
});

test("transport errors retry by type; other errors do not", async (t) => {
  setup(t);
  const sequence: unknown[] = [
    new DOMException("The operation timed out", "TimeoutError"),
    new TypeError("fetch failed"),
    Object.assign(new Error("socket"), { cause: { code: "ECONNRESET" } }),
  ];
  t.mock.method(globalThis, "fetch", async () => {
    const next = sequence.shift();
    if (next) throw next;
    return new Response("recovered");
  });
  const response = await requestBytes(new URL("https://flaky.test/"));
  assert.equal(text(response.bytes), "recovered");
  assert.equal(httpMetrics().retries, 3);

  resetHttpState();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    throw Object.assign(new Error("fetch failed"), { name: "SomethingElse" });
  });
  await assert.rejects(requestBytes(new URL("https://flaky.test/bug")), { name: "SomethingElse" });
  assert.equal(calls, 1);
  assert.equal(httpMetrics().retries, 0);
});

test("an oversized body is not retried", async (t) => {
  setup(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response("x".repeat(64));
  });
  await assert.rejects(requestBytes(new URL("https://big.test/"), { maxBytes: 16 }), /exceeds capture limit/);
  assert.equal(calls, 1);
});

test("validator cache is bounded by bytes with LRU eviction", async (t) => {
  setup(t, { ETL_HTTP_CACHE_MAX_BYTES: "25" });
  const conditional = new Map<string, string | undefined>();
  t.mock.method(globalThis, "fetch", async (url: URL, init?: RequestInit) => {
    const sent = headerOf(init, "if-none-match");
    conditional.set(url.pathname, sent);
    if (sent) return new Response(null, { status: 304 });
    const size = url.pathname === "/huge" ? 30 : 10;
    return new Response("y".repeat(size), { headers: { etag: `"${url.pathname}"` } });
  });
  const get = (path: string) => requestBytes(new URL(`https://cache.test${path}`));
  await get("/1");
  await get("/2");
  await get("/1"); // revalidated: /1 becomes most recent, /2 is now oldest
  assert.equal(conditional.get("/1"), '"/1"');
  await get("/3"); // 30 bytes > 25: evict the oldest (/2)
  await get("/2");
  assert.equal(conditional.get("/2"), undefined, "/2 should have been evicted");
  await get("/1");
  assert.equal(conditional.get("/1"), undefined, "/1 should have been evicted to make room for /2");
  await get("/3");
  assert.equal(conditional.get("/3"), undefined, "/3 should have been evicted to make room for /1");
  await get("/huge");
  await get("/huge");
  assert.equal(conditional.get("/huge"), undefined, "a body larger than the cap is never cached");
});

test("redirects are refused by default", async (t) => {
  setup(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: URL, init?: RequestInit) => {
    calls += 1;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } });
  });
  await assert.rejects(requestBytes(new URL("https://origin.test/")), /redirect from https:\/\/origin\.test refused/);
  assert.equal(calls, 1);
});

test("follow policy walks allowlisted hops and rejects others", async (t) => {
  setup(t);
  const visited: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    visited.push(url.href);
    if (url.href === "https://origin.test/start") {
      return new Response(null, { status: 302, headers: { location: "https://mirror.test/data", etag: '"r"' } });
    }
    if (url.href === "https://origin.test/relative") return new Response(null, { status: 301, headers: { location: "/final" } });
    if (url.href === "https://origin.test/evil") return new Response(null, { status: 307, headers: { location: "https://evil.test/x" } });
    if (url.href === "https://origin.test/plain") return new Response(null, { status: 302, headers: { location: "http://mirror.test/x" } });
    if (url.href === "https://origin.test/loop") return new Response(null, { status: 302, headers: { location: "/loop" } });
    return new Response(`body:${url.pathname}`, { headers: { etag: '"final"' } });
  });
  const redirect = { follow: true as const, allowOrigins: ["https://origin.test", "https://mirror.test"] };

  const followed = await requestBytes(new URL("https://origin.test/start"), { redirect });
  assert.equal(text(followed.bytes), "body:/data");
  assert.deepEqual(visited, ["https://origin.test/start", "https://mirror.test/data"]);

  const relative = await requestBytes(new URL("https://origin.test/relative"), { redirect });
  assert.equal(text(relative.bytes), "body:/final");

  await assert.rejects(
    requestBytes(new URL("https://origin.test/evil"), { redirect }),
    /disallowed origin https:\/\/evil\.test/,
  );
  await assert.rejects(
    requestBytes(new URL("https://origin.test/plain"), { redirect: { ...redirect, allowOrigins: ["http://mirror.test"] } }),
    /non-HTTPS origin http:\/\/mirror\.test/,
  );
  visited.length = 0;
  await assert.rejects(requestBytes(new URL("https://origin.test/loop"), { redirect }), /exceeded 3 redirects/);
  assert.equal(visited.length, 4);
  assert.equal(httpMetrics().retries, 0);
});

test("host minimum interval is configurable as JSON or host=ms pairs, defaulting to OASIS", (t) => {
  setup(t, { ETL_HTTP_HOST_MIN_INTERVAL_MS: "" });
  assert.equal(hostMinIntervalMs("oasis.caiso.com"), 6000);
  assert.equal(hostMinIntervalMs("OASIS.caiso.com"), 6000);
  assert.equal(hostMinIntervalMs("api.eia.gov"), 0);
  process.env.ETL_HTTP_HOST_MIN_INTERVAL_MS = "a.test=150, b.test=20";
  assert.equal(hostMinIntervalMs("a.test"), 150);
  assert.equal(hostMinIntervalMs("b.test"), 20);
  // An explicit setting replaces the default map.
  assert.equal(hostMinIntervalMs("oasis.caiso.com"), 0);
  process.env.ETL_HTTP_HOST_MIN_INTERVAL_MS = '{"a.test":75,"oasis.caiso.com":0}';
  assert.equal(hostMinIntervalMs("a.test"), 75);
  assert.equal(hostMinIntervalMs("oasis.caiso.com"), 0);
  // Malformed values fall back to the default, like the other settings.
  for (const bad of ["a.test", "a.test=-1", "a.test=x", "{not json", '{"a.test":"5"}', "[1]"]) {
    process.env.ETL_HTTP_HOST_MIN_INTERVAL_MS = bad;
    assert.equal(hostMinIntervalMs("oasis.caiso.com"), 6000, bad);
    assert.equal(hostMinIntervalMs("a.test"), 0, bad);
  }
});

/**
 * Run `work` under a mocked `Date` and `setTimeout`, advancing the clock 1 ms
 * per real event-loop turn. Time then moves only between turns, so a start
 * recorded inside the fetch mock equals the instant the request layer handed
 * the request to `fetch` (it calls `fetch` synchronously). On the real clock a
 * busy event loop could put a millisecond or two between the two, which made a
 * correctly spaced pair read as 149 ms apart.
 */
async function onMockClock<T>(t: TestContext, work: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-15T00:00:00Z") });
  let settled = false;
  const result = work().finally(() => { settled = true; });
  for (let turns = 0; !settled; turns += 1) {
    if (turns > 100_000) throw new Error("mock clock did not settle");
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!settled) t.mock.timers.tick(1);
  }
  t.mock.timers.reset();
  return result;
}

test("concurrent requests to a spaced host start at least the interval apart; other hosts are not delayed", async (t) => {
  setup(t, { ETL_HTTP_HOST_MIN_INTERVAL_MS: "spaced.test=150" });
  const starts: [string, number][] = [];
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    starts.push([url.href, Date.now()]);
    return new Response(url.pathname);
  });
  let began = 0;
  let otherDoneAt = 0;
  const results = await onMockClock(t, () => {
    began = Date.now();
    return Promise.all([
      requestBytes(new URL("https://spaced.test/rtm")),
      requestBytes(new URL("https://spaced.test/dam")),
      requestBytes(new URL("https://spaced.test/third")),
      requestBytes(new URL("https://free.test/x")).then((r) => { otherDoneAt = Date.now(); return r; }),
    ]);
  });
  assert.deepEqual(results.map((r) => text(r.bytes)), ["/rtm", "/dam", "/third", "/x"]);
  const spaced = starts.filter(([href]) => href.startsWith("https://spaced.test/")).map(([, at]) => at);
  assert.equal(spaced.length, 3);
  for (let i = 1; i < spaced.length; i += 1) {
    assert.ok(spaced[i] - spaced[i - 1] >= 150, `start ${i} came ${spaced[i] - spaced[i - 1]} ms after the previous`);
  }
  // The first request is not delayed, nor is a host without a configured interval.
  assert.ok(spaced[0] - began < 50, `first spaced start waited ${spaced[0] - began} ms`);
  assert.ok(otherDoneAt - began < 50, `unspaced host waited ${otherDoneAt - began} ms`);
});

test("spacing applies to retries and overlaps, rather than adds to, a wait for the host slot", async (t) => {
  setup(t, { ETL_HTTP_HOST_MIN_INTERVAL_MS: "{\"spaced.test\":100}", ETL_HTTP_HOST_CONCURRENCY: "1" });
  const starts: [string, number][] = [];
  let retried = false;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    starts.push([url.pathname, Date.now()]);
    if (url.pathname === "/slow") await delay(250);
    if (url.pathname === "/retry" && !retried) {
      retried = true;
      return new Response(null, { status: 429, headers: { "retry-after": "0" } });
    }
    return new Response(url.pathname);
  });
  // /slow holds the only slot for 250 ms; /next's 100 ms spacing elapses while it waits for that slot.
  await Promise.all([requestBytes(new URL("https://spaced.test/slow")), requestBytes(new URL("https://spaced.test/next"))]);
  const [slow, next] = starts.map(([, at]) => at);
  assert.ok(next - slow >= 250, `next started ${next - slow} ms after slow`);
  assert.ok(next - slow < 330, `spacing was added after the slot wait: ${next - slow} ms`);

  // A Retry-After: 0 retry is still a new request start and waits out the interval.
  starts.length = 0;
  await delay(110);
  await requestBytes(new URL("https://spaced.test/retry"));
  assert.deepEqual(starts.map(([path]) => path), ["/retry", "/retry"]);
  assert.ok(starts[1][1] - starts[0][1] >= 100, `retry came ${starts[1][1] - starts[0][1]} ms after the first attempt`);
});

test("deduped requests to a spaced host share one start and are not spaced", async (t) => {
  setup(t, { ETL_HTTP_HOST_MIN_INTERVAL_MS: "spaced.test=500" });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("shared"));
  const began = Date.now();
  const url = new URL("https://spaced.test/same");
  await Promise.all([requestBytes(url), requestBytes(url)]);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(httpMetrics().deduped, 1);
  assert.ok(Date.now() - began < 100);
});
