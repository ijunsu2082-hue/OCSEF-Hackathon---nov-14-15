import assert from "node:assert/strict";
import { test } from "node:test";
import { httpMetrics, requestBytes, resetHttpState } from "./http";

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

test("identical concurrent requests are fetched once", async (t) => {
  resetHttpState();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response("payload", { status: 200 });
  });
  const url = new URL("https://example.gov/shared.json");
  const [first, second] = await Promise.all([requestBytes(url), requestBytes(url)]);
  assert.equal(calls, 1);
  assert.equal(text(first.bytes), "payload");
  assert.equal(text(second.bytes), "payload");
  assert.equal(httpMetrics().deduped, 1);
});

test("a timeout is retried by error name even though its message has no known prefix", async (t) => {
  resetHttpState();
  process.env.ETL_HTTP_RETRY_BASE_MS = "1";
  t.after(() => { delete process.env.ETL_HTTP_RETRY_BASE_MS; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return new Response("ok");
  });
  const result = await requestBytes(new URL("https://example.gov/slow.json"));
  assert.equal(calls, 2);
  assert.equal(httpMetrics().retries, 1);
  assert.equal(text(result.bytes), "ok");
});

test("a transport failure reported as fetch failed is retried", async (t) => {
  resetHttpState();
  process.env.ETL_HTTP_RETRY_BASE_MS = "1";
  t.after(() => { delete process.env.ETL_HTTP_RETRY_BASE_MS; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return new Response("ok");
  });
  assert.equal(text((await requestBytes(new URL("https://example.gov/dns.json"))).bytes), "ok");
  assert.equal(calls, 2);
});

test("our own failures are not retried", async (t) => {
  resetHttpState();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    throw new Error("Upstream response exceeds capture limit");
  });
  await assert.rejects(requestBytes(new URL("https://example.gov/big.json")), /capture limit/);
  assert.equal(calls, 1);
  assert.equal(httpMetrics().retries, 0);
});

test("the host slot is released before a retry backoff", async (t) => {
  resetHttpState();
  process.env.ETL_HTTP_HOST_CONCURRENCY = "1";
  process.env.ETL_HTTP_RETRY_BASE_MS = "150";
  t.after(() => {
    delete process.env.ETL_HTTP_HOST_CONCURRENCY;
    delete process.env.ETL_HTTP_RETRY_BASE_MS;
  });
  const order: string[] = [];
  let limited = false;
  t.mock.method(globalThis, "fetch", async (input: URL | Request) => {
    const path = input instanceof URL ? input.pathname : new URL(input.url).pathname;
    if (path === "/limited.json" && !limited) {
      limited = true;
      return new Response("slow down", { status: 429 });
    }
    return new Response("ok");
  });
  const limitedRequest = requestBytes(new URL("https://example.gov/limited.json"))
    .then(() => { order.push("limited"); });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const queued = requestBytes(new URL("https://example.gov/other.json"))
    .then(() => { order.push("other"); });
  await Promise.all([limitedRequest, queued]);
  assert.deepEqual(order, ["other", "limited"]);
});

test("a provider 304 reuses the bytes already captured", async (t) => {
  resetHttpState();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_input: URL | Request, init?: RequestInit) => {
    calls += 1;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers["if-none-match"] === '"v1"') return new Response(null, { status: 304 });
    return new Response("csv", { status: 200, headers: { etag: '"v1"' } });
  });
  const url = new URL("https://example.gov/c.csv");
  const first = await requestBytes(url, { accept: "text/csv" });
  const second = await requestBytes(url, { accept: "text/csv" });
  assert.equal(calls, 2);
  assert.equal(first.revalidated, false);
  assert.equal(second.revalidated, true);
  assert.equal(text(second.bytes), "csv");
  assert.equal(httpMetrics().revalidated, 1);
});

test("per-host concurrency stays bounded", async (t) => {
  resetHttpState();
  process.env.ETL_HTTP_HOST_CONCURRENCY = "2";
  t.after(() => { delete process.env.ETL_HTTP_HOST_CONCURRENCY; });
  let live = 0;
  let peak = 0;
  t.mock.method(globalThis, "fetch", async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 10));
    live -= 1;
    return new Response("x");
  });
  await Promise.all(Array.from({ length: 6 }, (_, index) =>
    requestBytes(new URL(`https://example.gov/${index}.json`))));
  assert.ok(peak <= 2, `peak concurrency ${peak}`);
  assert.equal(peak, 2);
});
