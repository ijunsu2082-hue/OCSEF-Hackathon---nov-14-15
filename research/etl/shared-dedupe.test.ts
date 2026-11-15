import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { requestBytes, resetHttpState, setSharedDedupe, type HttpResponse } from "./http";
import { encodeCommand, parseReply, RespClient } from "./resp";
import { decodeStored, encodeStored, enableSharedDedupeFromEnv, RedisSharedDedupe, sharedDedupeFromEnv } from "./shared-dedupe";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");
const keyId = (key: string) => createHash("sha256").update(key).digest("hex");
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const KEY = Buffer.alloc(32, 7);
const KEY_HEX = KEY.toString("hex");

/**
 * In-test fake of the Redis subset the protocol uses: SET key value [NX] [PX ms],
 * GET, DEL, with lazy millisecond expiry. Speaks RESP2 over a real TCP socket.
 */
class FakeRedis {
  readonly data = new Map<string, { value: Buffer; expires: number | null }>();
  readonly commands: string[] = [];
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  async start(): Promise<string> {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const parsed = parseReply(buffer);
          if (typeof parsed === "symbol") break;
          buffer = buffer.subarray(parsed.next);
          const parts = (parsed.value as Buffer[]).map((part) => Buffer.from(part));
          socket.write(this.execute(parts));
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `redis://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  live(key: string): Buffer | null {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expires !== null && entry.expires <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  put(key: string, value: string | Buffer, px?: number): void {
    this.data.set(key, { value: Buffer.from(value), expires: px ? Date.now() + px : null });
  }

  private execute(parts: Buffer[]): Buffer {
    const name = parts[0].toString().toUpperCase();
    this.commands.push(name);
    if (name === "GET") {
      const value = this.live(parts[1].toString());
      return value === null ? Buffer.from("$-1\r\n") : Buffer.concat([Buffer.from(`$${value.length}\r\n`), value, Buffer.from("\r\n")]);
    }
    if (name === "DEL") {
      const key = parts[1].toString();
      const existed = this.live(key) !== null;
      this.data.delete(key);
      return Buffer.from(`:${existed ? 1 : 0}\r\n`);
    }
    if (name === "SET") {
      const key = parts[1].toString();
      let nx = false;
      let px: number | undefined;
      for (let index = 3; index < parts.length; index += 1) {
        const flag = parts[index].toString().toUpperCase();
        if (flag === "NX") nx = true;
        else if (flag === "PX") px = Number(parts[(index += 1)].toString());
        else return Buffer.from("-ERR syntax error\r\n");
      }
      if (nx && this.live(key) !== null) return Buffer.from("$-1\r\n");
      this.put(key, parts[2], px);
      return Buffer.from("+OK\r\n");
    }
    return Buffer.from(`-ERR unknown command '${name}'\r\n`);
  }
}

async function fakeRedis(t: TestContext): Promise<{ server: FakeRedis; url: string; client: () => RespClient }> {
  const server = new FakeRedis();
  const url = await server.start();
  const clients: RespClient[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await server.stop();
  });
  return {
    server, url,
    client: () => {
      const client = new RespClient(url);
      clients.push(client);
      return client;
    },
  };
}

function response(body: string, headers: Record<string, string> = { "content-type": "text/plain" }): HttpResponse {
  return { bytes: new Uint8Array(Buffer.from(body)), status: 200, headers: new Headers(headers), revalidated: false };
}

test("RESP client speaks SET NX PX, GET and DEL against a RESP2 server", async (t) => {
  const { client } = await fakeRedis(t);
  const redis = client();
  assert.equal(await redis.set("a", "1", { nx: true, px: 1000 }), true);
  assert.equal(await redis.set("a", "2", { nx: true, px: 1000 }), false);
  assert.equal((await redis.get("a"))?.toString(), "1");
  const binary = Buffer.from([0, 13, 10, 255, 36]);
  assert.equal(await redis.set("b", binary), true);
  assert.deepEqual(await redis.get("b"), binary);
  assert.equal(await redis.del("a"), 1);
  assert.equal(await redis.get("a"), null);
  assert.equal(await redis.set("c", "x", { px: 20 }), true);
  await delay(40);
  assert.equal(await redis.get("c"), null);
  assert.deepEqual(encodeCommand(["GET", "k"]), Buffer.from("*2\r\n$3\r\nGET\r\n$1\r\nk\r\n"));
});

test("two independent processes sharing one Redis cause one upstream fetch", async (t) => {
  const { server, client } = await fakeRedis(t);
  const processA = new RedisSharedDedupe(client(), { hmacKey: KEY, pollMinMs: 5, pollMaxMs: 20 });
  const processB = new RedisSharedDedupe(client(), { hmacKey: KEY, pollMinMs: 5, pollMaxMs: 20 });
  let upstream = 0;
  const fetcherFor = (label: string) => async () => {
    upstream += 1;
    await delay(60);
    return response(`body-from-${label}`, { "content-type": "text/csv", etag: '"v1"' });
  };
  const key = "https://example.test/feed\u0000text/csv";
  const [a, b] = await Promise.all([
    processA.run(key, fetcherFor("A")),
    (async () => {
      await delay(10);
      return processB.run(key, fetcherFor("B"));
    })(),
  ]);
  assert.equal(upstream, 1);
  assert.equal(text(a.bytes), "body-from-A");
  assert.equal(text(b.bytes), "body-from-A");
  assert.equal(b.headers.get("content-type"), "text/csv");
  assert.equal(b.headers.get("etag"), '"v1"');
  assert.equal(b.status, 200);
  assert.equal(processA.metrics.led, 1);
  assert.equal(processB.metrics.hits, 1);
  assert.equal(processB.metrics.fallbacks, 0);
  // The leader released its lease; the response stays for its TTL.
  assert.equal(server.live(`etl:lease:${keyId(key)}`), null);
  assert.notEqual(server.live(`etl:resp:${keyId(key)}`), null);

  // A third process arriving later is served from Redis without fetching.
  const processC = new RedisSharedDedupe(client(), { hmacKey: KEY });
  const c = await processC.run(key, fetcherFor("C"));
  assert.equal(upstream, 1);
  assert.equal(text(c.bytes), "body-from-A");
});

test("an expired lease from a crashed leader falls back to a direct fetch", async (t) => {
  const { server, client } = await fakeRedis(t);
  const key = "https://example.test/stuck\u0000application/json";
  // A leader that took the lease and died: nothing is ever stored.
  server.put(`etl:lease:${keyId(key)}`, "ghost", 120);
  const follower = new RedisSharedDedupe(client(), { hmacKey: KEY, leaseMs: 400, pollMinMs: 5, pollMaxMs: 20 });
  let upstream = 0;
  const started = Date.now();
  const result = await follower.run(key, async () => {
    upstream += 1;
    return response("self-fetched");
  });
  const elapsed = Date.now() - started;
  assert.equal(upstream, 1);
  assert.equal(text(result.bytes), "self-fetched");
  assert.equal(follower.metrics.fallbacks, 1);
  assert.ok(elapsed >= 100 && elapsed < 400, `fell back after ${elapsed} ms, when the lease vanished`);
});

test("a lease that never clears is bounded by the lease TTL (no deadlock)", async (t) => {
  const { server, client } = await fakeRedis(t);
  const key = "https://example.test/forever\u0000application/json";
  server.put(`etl:lease:${keyId(key)}`, "ghost");
  const follower = new RedisSharedDedupe(client(), { hmacKey: KEY, leaseMs: 150, pollMinMs: 5, pollMaxMs: 20 });
  const started = Date.now();
  const result = await follower.run(key, async () => response("after-timeout"));
  const elapsed = Date.now() - started;
  assert.equal(text(result.bytes), "after-timeout");
  assert.equal(follower.metrics.fallbacks, 1);
  assert.ok(elapsed >= 140 && elapsed < 1000, `waited ${elapsed} ms`);
});

test("a corrupted stored body is never served", async (t) => {
  const { server, client } = await fakeRedis(t);
  const key = "https://example.test/corrupt\u0000application/json";
  const stored = JSON.parse(encodeStored(response("genuine"), KEY, keyId(key)));
  stored.body = Buffer.from("tampered").toString("base64");
  stored.length = "tampered".length;
  server.put(`etl:resp:${keyId(key)}`, JSON.stringify(stored), 30_000);
  const reader = new RedisSharedDedupe(client(), { hmacKey: KEY, pollMinMs: 5 });
  let upstream = 0;
  const result = await reader.run(key, async () => {
    upstream += 1;
    return response("fresh");
  });
  assert.equal(upstream, 1);
  assert.equal(text(result.bytes), "fresh");
  assert.equal(reader.metrics.rejected, 1);
  // The leader overwrote the corrupt entry with a verifiable one.
  const repaired = decodeStored(server.live(`etl:resp:${keyId(key)}`)!, KEY, keyId(key));
  assert.notEqual(repaired, "corrupt");
  assert.equal(text((repaired as HttpResponse).bytes), "fresh");

  // A follower that sees a corrupt entry while waiting falls back instead of serving it.
  const other = "https://example.test/corrupt-wait\u0000application/json";
  server.put(`etl:lease:${keyId(other)}`, "ghost", 10_000);
  server.put(`etl:resp:${keyId(other)}`, "{not json", 10_000);
  const waiter = new RedisSharedDedupe(client(), { hmacKey: KEY, pollMinMs: 5 });
  const fallback = await waiter.run(other, async () => response("own"));
  assert.equal(text(fallback.bytes), "own");
  assert.equal(waiter.metrics.fallbacks, 1);

  // Header tampering is caught by the metadata digest.
  const headerTamper = JSON.parse(encodeStored(response("x"), KEY, "id"));
  headerTamper.headers = [["content-type", "text/html"]];
  assert.equal(decodeStored(Buffer.from(JSON.stringify(headerTamper)), KEY, "id"), "corrupt");
});

test("bodies over the size cap are fetched but not stored", async (t) => {
  const { server, client } = await fakeRedis(t);
  const key = "https://example.test/big\u0000application/json";
  const dedupe = new RedisSharedDedupe(client(), { hmacKey: KEY, maxBytes: 4 });
  const result = await dedupe.run(key, async () => response("too large"));
  assert.equal(text(result.bytes), "too large");
  assert.equal(dedupe.metrics.oversize, 1);
  assert.equal(server.live(`etl:resp:${keyId(key)}`), null);
});

test("an unreachable Redis degrades to a direct fetch", async (t) => {
  const { url, server } = await fakeRedis(t);
  await server.stop();
  const client = new RespClient(url, { timeoutMs: 500 });
  t.after(() => client.close());
  const dedupe = new RedisSharedDedupe(client, { hmacKey: KEY });
  const result = await dedupe.run("https://example.test/x\u0000a", async () => response("direct"));
  assert.equal(text(result.bytes), "direct");
  assert.equal(dedupe.metrics.errors, 1);
});

test("REDIS_URL unset is a no-op", async (t) => {
  assert.equal(sharedDedupeFromEnv({}), null);
  assert.equal(sharedDedupeFromEnv({ REDIS_URL: "" }), null);
  assert.equal(enableSharedDedupeFromEnv({}), false);
  resetHttpState();
  t.after(() => {
    setSharedDedupe(null);
    resetHttpState();
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("plain"));
  const result = await requestBytes(new URL("https://example.test/noop"));
  assert.equal(text(result.bytes), "plain");
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.throws(() => sharedDedupeFromEnv({ REDIS_URL: "rediss://example.test:6380", ETL_HTTP_SHARED_HMAC_KEY: KEY_HEX }), /TLS is not supported/);
});

test("requestBytes consults the injected dedupe: a second process-local miss is served from Redis", async (t) => {
  const { server, url } = await fakeRedis(t);
  resetHttpState();
  assert.equal(enableSharedDedupeFromEnv({ REDIS_URL: url, ETL_HTTP_SHARED_TTL_MS: "5000", ETL_HTTP_SHARED_HMAC_KEY: KEY_HEX }), true);
  t.after(() => {
    setSharedDedupe(null);
    resetHttpState();
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("from-upstream", {
    headers: { "content-type": "application/json" },
  }));
  const target = new URL("https://example.test/shared");
  const first = await requestBytes(target);
  // Simulate a second process: wipe all process-local state, keep Redis.
  resetHttpState();
  const second = await requestBytes(target);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(text(first.bytes), "from-upstream");
  assert.equal(text(second.bytes), "from-upstream");
  assert.equal(second.headers.get("content-type"), "application/json");
  assert.ok(server.commands.includes("SET"));
  // The Redis key is a hash, so a URL carrying an API key is never written as a key name.
  assert.ok([...server.data.keys()].every((name) => /^etl:(resp|lease):[a-f0-9]{64}$/.test(name)));
});

/** A record whose body, length, sha256 and metadata digest all verify, but whose HMAC was not made with KEY. */
function forgedRecord(id: string, body: string): string {
  const stored = JSON.parse(encodeStored(response("genuine"), KEY, id));
  const bytes = Buffer.from(body);
  stored.body = bytes.toString("base64");
  stored.length = bytes.length;
  stored.sha256 = sha256(bytes);
  stored.meta = sha256(JSON.stringify([stored.schema, stored.status, stored.headers, stored.length, stored.sha256]));
  stored.hmac = createHash("sha256").update("attacker has no key").digest("hex");
  return JSON.stringify(stored);
}

test("a forged record with a valid sha256 but the wrong HMAC is rejected and the leader refetches", async (t) => {
  const { server, client } = await fakeRedis(t);
  const key = "https://example.test/forged\u0000application/json";
  server.put(`etl:resp:${keyId(key)}`, forgedRecord(keyId(key), "injected evidence"), 30_000);
  const reader = new RedisSharedDedupe(client(), { hmacKey: KEY, pollMinMs: 5 });
  let upstream = 0;
  const result = await reader.run(key, async () => {
    upstream += 1;
    return response("fresh");
  });
  assert.equal(upstream, 1);
  assert.equal(text(result.bytes), "fresh");
  assert.equal(reader.metrics.rejected, 1);
  assert.equal(reader.metrics.led, 1);
  // A record signed with a different key, or moved from another request key, is also rejected.
  assert.equal(decodeStored(Buffer.from(encodeStored(response("x"), Buffer.alloc(32, 9), "a")), KEY, "a"), "corrupt");
  assert.equal(decodeStored(Buffer.from(encodeStored(response("x"), KEY, "a")), KEY, "b"), "corrupt");
  const genuine = decodeStored(Buffer.from(encodeStored(response("x"), KEY, "a")), KEY, "a");
  assert.notEqual(genuine, "corrupt");
  assert.equal(text((genuine as HttpResponse).bytes), "x");
});

test("REDIS_URL without a valid HMAC key refuses to enable and warns once", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  for (const bad of [undefined, "", "abcd", "00".repeat(31), Buffer.alloc(31).toString("base64"), "not a key! ".repeat(8)]) {
    warn.mock.resetCalls();
    assert.equal(sharedDedupeFromEnv({ REDIS_URL: "redis://127.0.0.1:1", ETL_HTTP_SHARED_HMAC_KEY: bad }), null, `key ${bad}`);
    assert.equal(warn.mock.callCount(), 1, `one warning for key ${bad}`);
    assert.match(String(warn.mock.calls[0].arguments[0]), /ETL_HTTP_SHARED_HMAC_KEY/);
    if (bad) assert.ok(!String(warn.mock.calls[0].arguments[0]).includes(bad), "the key is never logged");
  }
  warn.mock.resetCalls();
  for (const good of [KEY_HEX, KEY_HEX.toUpperCase(), Buffer.alloc(32, 3).toString("base64"), Buffer.alloc(48, 3).toString("base64url")]) {
    const impl = sharedDedupeFromEnv({ REDIS_URL: "redis://127.0.0.1:1", ETL_HTTP_SHARED_HMAC_KEY: good });
    assert.ok(impl instanceof RedisSharedDedupe, `key ${good}`);
  }
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(enableSharedDedupeFromEnv({ REDIS_URL: "redis://127.0.0.1:1" }), false);
  setSharedDedupe(null);
});
