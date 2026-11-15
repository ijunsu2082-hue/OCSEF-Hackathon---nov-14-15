import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { GET } from "../../app/api/weather/route";

// Every /api/weather response is JSON with Cache-Control: no-store, including
// errors; a broken store or upstream never surfaces as a bare 500.

const dir = mkdtempSync(join(tmpdir(), "gs-weather-route-"));
let upstream: () => Response | Promise<Response> = () => new Response("", { status: 200 });
let dbCount = 0;

globalThis.fetch = (async () => upstream()) as typeof fetch;

beforeEach(() => {
  dbCount += 1;
  process.env.WEATHER_DB_PATH = join(dir, `weather-${dbCount}.sqlite`);
  upstream = () => new Response("", { status: 200 });
});

after(() => rmSync(dir, { recursive: true, force: true }));

async function call(query: string) {
  const res = await GET(new Request(`http://localhost/api/weather${query}`));
  assert.equal(res.headers.get("cache-control"), "no-store", `${query}: cache-control`);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/, `${query}: content-type`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("missing or bad coordinates are a JSON 400/422 with no-store", async () => {
  const missing = await call("");
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { error: { code: "INVALID_COORDINATES", message: "lat and lon must be finite numbers." } });
  assert.equal((await call("?lat=abc&lon=1")).status, 400);
  assert.equal((await call("?lat=91&lon=0")).status, 422);
});

test("an empty upstream body (Unexpected end of JSON input) falls back to source none, not a 500", async () => {
  const { status, body } = await call("?lat=33.7538&lon=-118.0111");
  assert.equal(status, 200);
  assert.equal(body.current, null);
  assert.equal(body.source, "none");
});

test("a live upstream sample is returned and persisted", async () => {
  const now = Math.floor(Date.now() / 1000) - 120;
  upstream = () => Response.json({
    current: { time: now, temperature_2m: 21.5, wind_speed_10m: 3.2, wind_direction_10m: 270, shortwave_radiation: 410 },
    current_units: { wind_speed_10m: "m/s" },
  });
  const { status, body } = await call("?lat=33.7538&lon=-118.0111");
  assert.equal(status, 200);
  assert.equal(body.source, "live");
  assert.equal((body.current as { temp_c: number }).temp_c, 21.5);

  upstream = () => new Response("", { status: 200 });
  const again = await call("?lat=33.7538&lon=-118.0111");
  assert.equal(again.body.source, "persisted", "upstream now empty → last saved sample");
});

test("an unreadable weather store is a JSON 503, not an uncaught 500", async () => {
  writeFileSync(process.env.WEATHER_DB_PATH!, "not a sqlite file");
  const { status, body } = await call("?lat=33.7538&lon=-118.0111");
  assert.equal(status, 503);
  const error = body.error as { code: string; message: string };
  assert.equal(error.code, "WEATHER_STORE_UNAVAILABLE");
  assert.match(error.message, /file is not a database/);
});
