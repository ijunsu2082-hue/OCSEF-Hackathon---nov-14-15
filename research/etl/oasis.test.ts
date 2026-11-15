import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { deflateRawSync } from "node:zlib";
import { OASIS_ENDPOINT, oasisFeeds, oasisUrl, oasisWindow } from "./oasis";
import { locationId, locationQuery, runLocation, stateRoot, verifyLocation } from "./pipeline";
import { resetHttpState } from "./http";
import { crc32, readZip } from "./zip";
import { feedsFor, type Metric } from "./sources";
import { parseSnapshot, resolvePointer } from "../parsers";
import { verifyEvidenceFiles } from "../verify-files";
import { PREDICATES } from "../../lib/evidence/predicates";

const FIXTURES = "research/etl/fixtures/oasis";
const NODE = "TH_SP15_GEN-APND";
const RTM_ZIP = `${FIXTURES}/rtm-prc-intvl-lmp-${NODE}.zip`;
const DAM_ZIP = `${FIXTURES}/dam-prc-lmp-${NODE}.zip`;
const ERROR_ZIP = `${FIXTURES}/error-no-data.zip`;
// The fixtures were captured for these windows (RTM 08:00Z-09:00Z, DAM operating day 2026-11-14).
const capturedAt = new Date("2026-11-14T09:20:00Z");
const [rtmFeed, damFeed] = oasisFeeds(NODE);
// RTM answers are checked against the window of the stored request URL.
const RTM_URL = oasisUrl("RTM", NODE, capturedAt).href;

async function parsed(path: string) {
  return parseSnapshot(new Uint8Array(await readFile(path)), "zip.csv").data;
}

function values(metrics: Metric[]): Record<string, string | number> {
  return Object.fromEntries(metrics.map(({ predicate, value }) => [predicate, value]));
}

/** Single-entry stored ZIP around a CSV body, so drifted payloads can be tested. */
function zipOf(name: string, body: string): Uint8Array {
  const data = Buffer.from(body);
  const payload = deflateRawSync(data);
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(0x0808, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0808, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(local.length + fileName.length + payload.length, 16);
  return new Uint8Array(Buffer.concat([local, fileName, payload, central, fileName, end]));
}

/** The real archive's CSV text, for mutation tests. */
async function fixtureCsv(path: string): Promise<string> {
  return Buffer.from(readZip(new Uint8Array(await readFile(path)))[0].data).toString("utf8").replace(/\r/g, "");
}

test("real RTM archive maps its newest interval and DAM the hour containing the capture", async () => {
  const rtm = await parsed(RTM_ZIP);
  const rtmMetrics = rtmFeed.extract(rtm, undefined, RTM_URL);
  assert.deepEqual(values(rtmMetrics), {
    "telemetry.period": "2026-11-14T08:55:00-00:00",
    "caiso.oasis.rtm.lmp_usd_mwh": 27.01521,
    "caiso.oasis.rtm.energy_usd_mwh": 33.8842,
    "caiso.oasis.rtm.congestion_usd_mwh": -5.06296,
    "caiso.oasis.rtm.loss_usd_mwh": -1.80603,
  });
  // VALUE is column 13 in PRC_INTVL_LMP; rows are grouped by LMP_TYPE, not time.
  assert.deepEqual(rtmMetrics.map(({ locator }) => locator),
    ["/rows/59/0", "/rows/59/13", "/rows/23/13", "/rows/11/13", "/rows/47/13"]);
  assert.deepEqual(rtmFeed.observationTime!(rtm, undefined, RTM_URL), { timestamp: "2026-11-14T08:55:00.000Z", basis: "utc" });

  const dam = await parsed(DAM_ZIP);
  // Capture 09:20Z falls in the 09:00Z-10:00Z hour, not the operating day's newest (future) hour.
  const damMetrics = damFeed.extract(dam, capturedAt.toISOString());
  assert.deepEqual(values(damMetrics), {
    "telemetry.period": "2026-11-14T09:00:00-00:00",
    "caiso.oasis.dam.lmp_usd_mwh": 35.32855,
    "caiso.oasis.dam.energy_usd_mwh": 38.0005,
    "caiso.oasis.dam.congestion_usd_mwh": -1.78645,
    "caiso.oasis.dam.loss_usd_mwh": -1.87544,
  });
  // PRC_LMP names its $/MWh price column MW (column 14).
  assert.ok(damMetrics.slice(1).every(({ locator }) => locator.endsWith("/14")));
  assert.deepEqual(damFeed.observationTime!(dam, capturedAt.toISOString()), { timestamp: "2026-11-14T09:00:00.000Z", basis: "utc" });
  // The interval start is inclusive and its end exclusive.
  assert.equal(values(damFeed.extract(dam, "2026-11-14T09:00:00.000Z"))["telemetry.period"], "2026-11-14T09:00:00-00:00");
  assert.equal(values(damFeed.extract(dam, "2026-11-14T09:59:59.999Z"))["telemetry.period"], "2026-11-14T09:00:00-00:00");
  assert.equal(values(damFeed.extract(dam, "2026-11-14T10:00:00.000Z"))["telemetry.period"], "2026-11-14T10:00:00-00:00");
  assert.equal(values(damFeed.extract(dam, "2026-11-15T07:59:00.000Z"))["telemetry.period"], "2026-11-15T07:00:00-00:00");
  // RTM selection does not depend on the capture instant.
  assert.deepEqual(rtmFeed.extract(rtm, "2026-11-14T08:01:00.000Z", RTM_URL), rtmMetrics);

  for (const [data, metrics] of [[rtm, rtmMetrics], [dam, damMetrics]] as const) {
    for (const { predicate, locator, value } of metrics) {
      assert.ok(PREDICATES[predicate], `${predicate} is registered`);
      assert.equal(resolvePointer(data, locator), value, `${locator} resolves to the claimed value`);
    }
  }
  assert.ok(rtmFeed.source.caveats.some((text) => text.includes(`node ${NODE}, market RTM`) && text.includes("INTERVALSTARTTIME_GMT")));
  assert.ok(rtmFeed.source.caveats.some((text) => text.startsWith("Units are $/MWh")));
  assert.ok(rtmFeed.source.caveats.some((text) => /not system demand, not a local retail price/.test(text)));
});

test("a DAM capture outside the returned operating day, or without a capture instant, fails closed", async () => {
  const dam = await parsed(DAM_ZIP);
  for (const outside of ["2026-11-14T07:59:59.999Z", "2026-11-15T08:00:00.000Z", "2026-11-16T09:20:00.000Z"]) {
    assert.throws(() => damFeed.extract(dam, outside),
      new RegExp(`no interval with a numeric LMP containing capture ${outside.replace(/\./g, "\\.")}`), outside);
    assert.throws(() => damFeed.observationTime!(dam, outside), /no interval with a numeric LMP containing capture/);
  }
  assert.throws(() => damFeed.extract(dam), /requires the snapshot capture instant/);
  assert.throws(() => damFeed.extract(dam, "not a time"), /requires the snapshot capture instant/);
  assert.throws(() => damFeed.observationTime!(dam), /requires the snapshot capture instant/);

  // The containing hour's LMP is blank: fail closed rather than fall back to another hour.
  const damText = await fixtureCsv(DAM_ZIP);
  const parse = (text: string) => parseSnapshot(zipOf("x.csv", text), "zip.csv").data;
  const blank = damText.split("\n").map((line) => line.startsWith("2026-11-14T09:00") && line.includes(",LMP,LMP_PRC,")
    ? line.replace(",35.32855,", ",,") : line).join("\n");
  assert.throws(() => damFeed.extract(parse(blank), capturedAt.toISOString()), /no interval with a numeric LMP containing capture/);
  assert.throws(() => damFeed.extract(parse(damText.replace("INTERVALENDTIME_GMT", "END_GMT")), capturedAt.toISOString()),
    /missing INTERVALENDTIME_GMT/);
});

test("an OASIS XML error report fails the parse with its message", async () => {
  const errorZip = new Uint8Array(await readFile(ERROR_ZIP));
  assert.throws(() => parseSnapshot(errorZip, "zip.csv"),
    /error report \(ERR_CODE 1000\): No data returned for the specified selection/);
  assert.throws(() => parseSnapshot(zipOf("report.xml", "<a>not an OASIS error</a>"), "zip.csv"), /holds XML/);
  assert.throws(() => parseSnapshot(zipOf("report.txt", "x"), "zip.csv"), /is not a \.csv file/);
});

test("wrong node, mixed or wrong market and ambiguous price columns fail closed", async () => {
  const rtmText = await fixtureCsv(RTM_ZIP);
  const damText = await fixtureCsv(DAM_ZIP);
  const parse = (text: string) => parseSnapshot(zipOf("x.csv", text), "zip.csv").data;

  assert.throws(() => oasisFeeds("SOMEWHERE_ELSE")[0].extract(parse(rtmText)), /is for node TH_SP15_GEN-APND, not SOMEWHERE_ELSE/);
  const lines = rtmText.trimEnd().split("\n");
  const mixed = [...lines.slice(0, -1), lines.at(-1)!.replace(",RTM,", ",DAM,")].join("\n");
  assert.throws(() => rtmFeed.extract(parse(mixed)), /mixes markets: RTM, DAM/);
  assert.throws(() => damFeed.extract(parse(rtmText)), /missing MW/);
  assert.throws(() => rtmFeed.extract(parse(damText)), /missing VALUE/);
  const bothColumns = lines.map((line, index) => `${line},${index === 0 ? "MW" : "0"}`).join("\n");
  assert.throws(() => rtmFeed.extract(parse(bothColumns)), /carries both VALUE and MW/);
  assert.throws(() => rtmFeed.extract(parse(rtmText.replace("LMP_TYPE", "PRICE_TYPE"))), /missing LMP_TYPE/);
  const badTime = rtmText.replace("2026-11-14T08:00:00-00:00,", "2026-11-14 08:00,");
  assert.throws(() => rtmFeed.extract(parse(badTime)), /invalid INTERVALSTARTTIME_GMT/);
  const repeated = [...lines, lines.at(-1)!].join("\n");
  assert.throws(() => rtmFeed.extract(parse(repeated)), /repeats LMP for 2026-11-14T08:55:00-00:00/);

  // An interval whose LMP is blank is skipped for the newest interval that has one.
  const blankLatest = lines.map((line) => line.startsWith("2026-11-14T08:55") && line.includes(",LMP,LMP_PRC,")
    ? line.replace(",27.01521,", ",,") : line).join("\n");
  assert.equal(values(rtmFeed.extract(parse(blankLatest), undefined, RTM_URL))["telemetry.period"], "2026-11-14T08:50:00-00:00");
  assert.deepEqual(rtmFeed.extract(parse(lines[0])), []);
  assert.equal(rtmFeed.observationTime!(parse(lines[0])), null);
});

test("query windows are derived from the capture instant", () => {
  const at = (iso: string) => new Date(iso);
  const iso = ({ start, end }: { start: number; end: number }) => [new Date(start).toISOString(), new Date(end).toISOString()];
  assert.deepEqual(iso(oasisWindow("RTM", at("2026-11-14T08:37:12Z"))), ["2026-11-14T07:00:00.000Z", "2026-11-14T08:00:00.000Z"]);
  assert.deepEqual(iso(oasisWindow("RTM", at("2026-11-14T08:00:00Z"))), ["2026-11-14T07:00:00.000Z", "2026-11-14T08:00:00.000Z"]);
  // 2026-11-14T07:30Z is 23:30 PST on 2026-11-13: the operating day is still the 13th.
  assert.deepEqual(iso(oasisWindow("DAM", at("2026-11-14T07:30:00Z"))), ["2026-11-13T08:00:00.000Z", "2026-11-14T08:00:00.000Z"]);
  assert.deepEqual(iso(oasisWindow("DAM", at("2026-11-14T09:20:00Z"))), ["2026-11-14T08:00:00.000Z", "2026-11-15T08:00:00.000Z"]);
  // Fall back (25 h) and spring forward (23 h) operating days.
  assert.deepEqual(iso(oasisWindow("DAM", at("2026-11-01T20:00:00Z"))), ["2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z"]);
  assert.deepEqual(iso(oasisWindow("DAM", at("2026-03-08T20:00:00Z"))), ["2026-03-08T08:00:00.000Z", "2026-03-09T07:00:00.000Z"]);

  assert.equal(oasisUrl("RTM", NODE, capturedAt).href,
    "https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_INTVL_LMP&startdatetime=20261114T08:00-0000&enddatetime=20261114T09:00-0000&version=3&market_run_id=RTM&node=TH_SP15_GEN-APND&resultformat=6");
  assert.equal(oasisUrl("DAM", NODE, capturedAt).href,
    "https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP&startdatetime=20261114T08:00-0000&enddatetime=20261115T08:00-0000&version=12&market_run_id=DAM&node=TH_SP15_GEN-APND&resultformat=6");
  assert.equal(rtmFeed.urlAt!(at("2026-11-14T10:05:00Z")).searchParams.get("startdatetime"), "20261114T09:00-0000");
});

test("node ids are validated and only change location ids when set", () => {
  for (const bad of ["", "ab", "th_sp15", "NODE&market_run_id=DAM", "A".repeat(65), "NODE ID"]) {
    assert.throws(() => oasisFeeds(bad), /Invalid OASIS node id/, bad);
    assert.throws(() => locationQuery(34, -118, 100, undefined, false, bad), /optional OASIS node id/, bad);
  }
  const plain = locationQuery(34.0522, -118.2437, 100, "CISO", true);
  assert.deepEqual(locationQuery(34.0522, -118.2437, 100, "CISO", true, undefined), plain);
  assert.equal("oasis_node" in plain, false);
  // Digest of { center, radius_miles, respondent, caiso } as before this option existed.
  assert.equal(locationId(plain), locationId({ center: [34.0522, -118.2437], radius_miles: 100, respondent: "CISO", caiso: true }));
  const priced = locationQuery(34.0522, -118.2437, 100, "CISO", true, NODE);
  assert.equal(priced.oasis_node, NODE);
  assert.notEqual(locationId(priced), locationId(plain));
  const ids = feedsFor(priced).map(({ source }) => source.id);
  assert.ok(ids.includes("caiso-oasis-rtm-lmp") && ids.includes("caiso-oasis-dam-lmp"));
  assert.equal(feedsFor(plain).some(({ source }) => source.id.startsWith("caiso-oasis-")), false);
});

// The production default spaces OASIS request starts 6 s apart; tests use a short interval.
const OASIS_SPACING_MS = 40;

function isolateState(t: TestContext): string {
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const saved = process.env.ETL_HTTP_HOST_MIN_INTERVAL_MS;
  process.env.ETL_HTTP_HOST_MIN_INTERVAL_MS = `oasis.caiso.com=${OASIS_SPACING_MS}`;
  const root = stateRoot();
  resetHttpState();
  t.after(async () => {
    delete process.env.ETL_STATE_NAMESPACE;
    if (saved === undefined) delete process.env.ETL_HTTP_HOST_MIN_INTERVAL_MS;
    else process.env.ETL_HTTP_HOST_MIN_INTERVAL_MS = saved;
    resetHttpState();
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function mockUpstreams(t: TestContext, oasis: (url: URL) => Promise<Uint8Array>, seen: string[], startedAt: number[] = []) {
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    switch (url.hostname) {
      case "oasis.caiso.com":
        seen.push(url.href);
        startedAt.push(Date.now());
        return new Response(Buffer.from(await oasis(url)), { headers: { "content-type": "application/x-zip-compressed" } });
      case "geocoding.geo.census.gov":
        return Response.json({ result: { geographies: {
          States: [{ GEOID: "06" }], Counties: [{ GEOID: "06037", NAME: "Los Angeles County" }],
        } } });
      case "services.arcgis.com":
      case "services1.arcgis.com":
        return Response.json({ count: 42 });
      case "api.weather.gov":
        if (url.pathname === "/alerts/active") return Response.json({ features: [] });
        if (url.pathname.startsWith("/points/")) return Response.json({
          properties: { observationStations: "https://api.weather.gov/gridpoints/LOX/1,2/stations" },
        });
        if (url.pathname.endsWith("/stations")) return Response.json({
          features: [{ id: "https://api.weather.gov/stations/KLAX" }],
        });
        return Response.json({ properties: {
          timestamp: "2026-11-14T09:00:00Z", temperature: { unitCode: "wmoUnit:degC", value: 20 },
        } });
      default:
        throw new Error(`Unexpected source ${url}`);
    }
  });
}

const query = locationQuery(34.0522, -118.2437, 100, undefined, false, NODE);

test("pipeline captures OASIS archives at capture-time URLs and replays them offline", async (t) => {
  isolateState(t);
  const seen: string[] = [];
  const startedAt: number[] = [];
  mockUpstreams(t, async (url) => readFile(url.searchParams.get("market_run_id") === "RTM" ? RTM_ZIP : DAM_ZIP), seen, startedAt);
  const captured = await runLocation(query, true, capturedAt);
  assert.equal(captured.evidence.verification.ok, true);
  assert.deepEqual(seen.sort(), [oasisUrl("RTM", NODE, capturedAt).href, oasisUrl("DAM", NODE, capturedAt).href].sort());
  // RTM and DAM are captured concurrently, but their OASIS request starts are spaced.
  assert.equal(startedAt.length, 2);
  assert.ok(startedAt[1] - startedAt[0] >= OASIS_SPACING_MS, `OASIS starts ${startedAt[1] - startedAt[0]} ms apart`);
  const snapshot = (id: string) => captured.evidence.snapshots.find(({ source_id }) => source_id === id)!;
  assert.equal(snapshot("caiso-oasis-rtm-lmp").url, oasisUrl("RTM", NODE, capturedAt).href);
  assert.equal(snapshot("caiso-oasis-rtm-lmp").parser, "zip.csv");
  assert.equal(snapshot("caiso-oasis-rtm-lmp").record_count, 60);

  assert.equal(captured.feeds["caiso-oasis-rtm-lmp"].status, "fresh");
  assert.equal(captured.feeds["caiso-oasis-rtm-lmp"].observation_at, "2026-11-14T08:55:00.000Z");
  // DAM reports the hour containing the capture, so its age is non-negative and within max_age_days.
  const dam = captured.feeds["caiso-oasis-dam-lmp"];
  assert.equal(dam.observation_at, "2026-11-14T09:00:00.000Z");
  assert.equal(dam.status, "fresh");
  assert.equal(dam.source_age_seconds, 20 * 60);
  assert.ok(dam.source_age_seconds! <= damFeed.source.freshness.max_age_days * 86400);
  assert.equal(dam.issue, undefined);
  assert.equal(captured.evidence.unresolved.some(({ predicate }) => predicate === "caiso-oasis-dam-lmp"), false);

  const cited = (predicate: string) => captured.evidence.claims.find((claim) => claim.predicate === predicate);
  assert.equal(cited("caiso.oasis.rtm.lmp_usd_mwh")?.value, 27.01521);
  assert.equal(cited("caiso.oasis.rtm.lmp_usd_mwh")?.unit, "$/MWh");
  assert.equal(cited("caiso.oasis.dam.lmp_usd_mwh")?.value, 35.32855);
  assert.ok(cited("caiso.oasis.rtm.lmp_usd_mwh")?.caveats.some((text) => text.includes(NODE)));
  const files = await verifyEvidenceFiles(captured.evidence);
  assert.deepEqual(files.issues, []);
  assert.ok(files.checkedLocators >= 10);

  // Replay at a different wall clock reads the stored bytes; no URL is rebuilt and nothing is fetched.
  seen.length = 0;
  const replay = await runLocation(query, false, new Date(capturedAt.getTime() + 3 * 3_600_000));
  assert.deepEqual(seen, []);
  assert.equal(replay.evidence.snapshots.find(({ source_id }) => source_id === "caiso-oasis-rtm-lmp")?.url,
    oasisUrl("RTM", NODE, capturedAt).href);
  // Replay selects the DAM hour from the stored capture instant, not the replay clock.
  assert.equal(replay.feeds["caiso-oasis-dam-lmp"].observation_at, "2026-11-14T09:00:00.000Z");
  assert.equal(replay.evidence.claims.find((claim) => claim.predicate === "caiso.oasis.dam.lmp_usd_mwh")?.value, 35.32855);
  await verifyLocation(captured);
});

test("pipeline quarantines an OASIS error report instead of publishing it", async (t) => {
  const root = isolateState(t);
  const seen: string[] = [];
  mockUpstreams(t, async () => readFile(ERROR_ZIP), seen);
  const report = await runLocation(query, true, capturedAt);
  assert.equal(report.evidence.verification.ok, true);
  for (const source of ["caiso-oasis-rtm-lmp", "caiso-oasis-dam-lmp"]) {
    assert.equal(report.feeds[source].status, "unavailable");
    assert.match(report.feeds[source].issue ?? "", /ERR_CODE 1000\): No data returned/);
  }
  assert.equal(report.evidence.claims.filter((claim) => claim.predicate.startsWith("caiso.oasis.")).length, 0);
  assert.equal((await readdir(`${root}/quarantine`)).length, 2);
});

test("an RTM answer is checked against the window its stored URL requested", async () => {
  const rtm = await parsed(RTM_ZIP);
  const asked = oasisUrl("RTM", NODE, capturedAt).href;
  assert.equal(values(rtmFeed.extract(rtm, capturedAt.toISOString(), asked))["telemetry.period"], "2026-11-14T08:55:00-00:00");
  assert.deepEqual(rtmFeed.observationTime!(rtm, capturedAt.toISOString(), asked),
    { timestamp: "2026-11-14T08:55:00.000Z", basis: "utc" });
  // The same bytes stored against the next hour's request are out of window.
  const nextHour = oasisUrl("RTM", NODE, new Date(capturedAt.getTime() + 3_600_000)).href;
  assert.throws(() => rtmFeed.extract(rtm, capturedAt.toISOString(), nextHour),
    /OASIS RTM CSV row \d+ interval 2026-11-14T08:\d{2}:00-00:00 is outside the requested window 2026-11-14T09:00:00.000Z to 2026-11-14T10:00:00.000Z/);
  assert.throws(() => rtmFeed.observationTime!(rtm, capturedAt.toISOString(), nextHour), /outside the requested window/);
  assert.throws(() => rtmFeed.extract(rtm, capturedAt.toISOString()), /requires the stored request URL/);
  assert.throws(() => rtmFeed.extract(rtm, capturedAt.toISOString(), OASIS_ENDPOINT), /requires the stored request URL/);
});

test("OASIS feed URLs do not depend on the wall clock", (t) => {
  const first = oasisFeeds(NODE).map(({ url }) => url.href);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2031-02-03T04:05:06Z") });
  const second = oasisFeeds(NODE).map(({ url }) => url.href);
  t.mock.timers.reset();
  assert.deepEqual(second, first);
  for (const href of first) {
    const url = new URL(href);
    assert.equal(url.searchParams.has("startdatetime") || url.searchParams.has("enddatetime"), false, href);
    assert.equal(url.searchParams.get("node"), NODE);
  }
});
