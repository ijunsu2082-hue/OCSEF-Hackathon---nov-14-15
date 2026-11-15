/**
 * Minimal RESP2 client over `node:net`, dependency-free.
 *
 * Only what the shared request dedupe needs: `SET key value [NX] [PX ms]`,
 * `GET`, `DEL`, plus `AUTH`/`SELECT` taken from the URL. Commands are
 * pipelined on one socket and answered in order. Any socket error or command
 * timeout fails every pending command and drops the connection; the next
 * command reconnects. The socket is unref'd so an idle client never keeps a
 * CLI process alive; a pending command's own timer does.
 *
 * Only `redis://` is supported. `rediss://` (TLS) is rejected rather than
 * silently sent in clear text.
 */

import { connect, type Socket } from "node:net";

export type RespValue = string | number | Buffer | null | RespValue[];

export class RespError extends Error {}

export interface RespOptions {
  /** Per-command timeout, including connect. Default 2000 ms. */
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: RespValue) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Target {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  db: number | null;
}

export function parseRedisUrl(raw: string): Target {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("REDIS_URL is not a valid URL");
  }
  if (url.protocol !== "redis:") throw new Error("REDIS_URL must use redis:// (TLS is not supported by this client)");
  const port = url.port ? Number(url.port) : 6379;
  const path = url.pathname.replace(/^\//, "");
  if (path && !/^\d{1,2}$/.test(path)) throw new Error("REDIS_URL database must be a small integer");
  return {
    host: url.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1",
    port,
    username: url.username ? decodeURIComponent(url.username) : null,
    password: url.password ? decodeURIComponent(url.password) : null,
    db: path ? Number(path) : null,
  };
}

export function encodeCommand(parts: (string | Uint8Array)[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : Buffer.from(part);
    chunks.push(Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n"));
  }
  return Buffer.concat(chunks);
}

const INCOMPLETE = Symbol("incomplete");

/** Parse one RESP2 value at `offset`; returns INCOMPLETE when more bytes are needed. */
export function parseReply(buffer: Buffer, offset = 0): typeof INCOMPLETE | { value: RespValue | RespError; next: number } {
  if (offset >= buffer.length) return INCOMPLETE;
  const end = buffer.indexOf("\r\n", offset);
  if (end < 0) return INCOMPLETE;
  const type = String.fromCharCode(buffer[offset]);
  const line = buffer.subarray(offset + 1, end).toString("utf8");
  const after = end + 2;
  switch (type) {
    case "+":
      return { value: line, next: after };
    case "-":
      return { value: new RespError(line), next: after };
    case ":": {
      const value = Number(line);
      if (!Number.isInteger(value)) throw new Error("RESP: invalid integer reply");
      return { value, next: after };
    }
    case "$": {
      const length = Number(line);
      if (length === -1) return { value: null, next: after };
      if (!Number.isInteger(length) || length < 0) throw new Error("RESP: invalid bulk length");
      if (buffer.length < after + length + 2) return INCOMPLETE;
      if (buffer[after + length] !== 13 || buffer[after + length + 1] !== 10) throw new Error("RESP: bulk string not terminated");
      return { value: Buffer.from(buffer.subarray(after, after + length)), next: after + length + 2 };
    }
    case "*": {
      const count = Number(line);
      if (count === -1) return { value: null, next: after };
      if (!Number.isInteger(count) || count < 0) throw new Error("RESP: invalid array length");
      const items: RespValue[] = [];
      let cursor = after;
      for (let index = 0; index < count; index += 1) {
        const parsed = parseReply(buffer, cursor);
        if (parsed === INCOMPLETE) return INCOMPLETE;
        if (parsed.value instanceof RespError) throw parsed.value;
        items.push(parsed.value);
        cursor = parsed.next;
      }
      return { value: items, next: cursor };
    }
    default:
      throw new Error(`RESP: unexpected reply type ${JSON.stringify(type)}`);
  }
}

export class RespClient {
  private readonly target: Target;
  private readonly timeoutMs: number;
  private socket: Socket | null = null;
  private ready: Promise<void> | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending: Pending[] = [];
  private closed = false;

  constructor(url: string, options: RespOptions = {}) {
    this.target = parseRedisUrl(url);
    this.timeoutMs = options.timeoutMs ?? 2000;
  }

  /** `SET key value [NX] [PX ms]`; resolves true on `OK`, false when NX refused. */
  async set(key: string, value: string | Uint8Array, options: { nx?: boolean; px?: number } = {}): Promise<boolean> {
    const parts: (string | Uint8Array)[] = ["SET", key, value];
    if (options.nx) parts.push("NX");
    if (options.px !== undefined) {
      if (!Number.isInteger(options.px) || options.px <= 0) throw new Error("SET PX must be a positive integer");
      parts.push("PX", String(options.px));
    }
    const reply = await this.command(parts);
    if (reply === null) return false;
    if (reply === "OK") return true;
    throw new Error("RESP: unexpected SET reply");
  }

  async get(key: string): Promise<Buffer | null> {
    const reply = await this.command(["GET", key]);
    if (reply === null || Buffer.isBuffer(reply)) return reply;
    throw new Error("RESP: unexpected GET reply");
  }

  async del(key: string): Promise<number> {
    const reply = await this.command(["DEL", key]);
    if (typeof reply !== "number") throw new Error("RESP: unexpected DEL reply");
    return reply;
  }

  close(): void {
    this.closed = true;
    this.teardown(new Error("RESP client closed"));
  }

  async command(parts: (string | Uint8Array)[]): Promise<RespValue> {
    if (this.closed) throw new Error("RESP client closed");
    await this.connect();
    return this.send(parts);
  }

  private send(parts: (string | Uint8Array)[]): Promise<RespValue> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("RESP: not connected"));
    return new Promise<RespValue>((resolve, reject) => {
      const timer = setTimeout(() => this.teardown(new Error("RESP command timed out")), this.timeoutMs);
      this.pending.push({ resolve, reject, timer });
      socket.write(encodeCommand(parts));
    });
  }

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    const attempt = new Promise<void>((resolve, reject) => {
      const socket = connect({ host: this.target.host, port: this.target.port });
      this.socket = socket;
      this.buffer = Buffer.alloc(0);
      // Events from a socket that has already been replaced must not tear down its successor.
      const fail = (error: Error) => {
        clearTimeout(timer);
        if (this.socket === socket) this.teardown(error);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("RESP connect timed out")), this.timeoutMs);
      socket.unref();
      socket.setNoDelay(true);
      socket.on("data", (chunk) => {
        if (this.socket === socket) this.onData(chunk);
      });
      socket.on("error", fail);
      socket.on("close", () => fail(new Error("RESP connection closed")));
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
    }).then(async () => {
      const { username, password, db } = this.target;
      if (password !== null) {
        const reply = await this.send(username ? ["AUTH", username, password] : ["AUTH", password]);
        if (reply !== "OK") throw new Error("RESP AUTH failed");
      }
      if (db !== null) {
        const reply = await this.send(["SELECT", String(db)]);
        if (reply !== "OK") throw new Error("RESP SELECT failed");
      }
    });
    this.ready = attempt;
    attempt.catch((error: unknown) => {
      // A failed AUTH/SELECT leaves a live socket behind; drop it so the next command reconnects.
      if (this.ready === attempt) this.teardown(error instanceof Error ? error : new Error("RESP connect failed"));
    });
    return attempt;
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let offset = 0;
    try {
      for (;;) {
        const parsed = parseReply(this.buffer, offset);
        if (parsed === INCOMPLETE) break;
        offset = parsed.next;
        const waiter = this.pending.shift();
        if (!waiter) throw new Error("RESP: reply without a pending command");
        clearTimeout(waiter.timer);
        if (parsed.value instanceof RespError) waiter.reject(parsed.value);
        else waiter.resolve(parsed.value);
      }
    } catch (error) {
      this.teardown(error instanceof Error ? error : new Error("RESP protocol error"));
      return;
    }
    this.buffer = offset >= this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(offset);
  }

  /** Fail every pending command and drop the socket; the next command reconnects. */
  private teardown(error: Error): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = null;
    this.buffer = Buffer.alloc(0);
    for (const waiter of this.pending.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    socket?.destroy();
  }
}
