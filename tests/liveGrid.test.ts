import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baFromPlants,
  balanceCrossCheck,
  caisoHourMix,
  caisoMix,
  cleanShare,
  demandCrossCheck,
  eiaPeriodToIso,
  eiaUrl,
  forecastCrossCheck,
  fuelMixFrom,
  gridStatus,
  hourAverage,
  latestWith,
  pacificToUtcMs,
  parseCaisoCsv,
  parseControlAreaQuery,
  parseEiaFuel,
  parseEiaRegion,
  pickControlArea,
  shareCrossCheck,
  solarWindShare,
} from "../lib/live/grid";

// No network in these tests: every input below is a fixture string trimmed from real responses (2026-11-14/15).
globalThis.fetch = (async () => {
  throw new Error("no network in tests");
}) as typeof fetch;

/* ---------------------------------------------------------------- fixtures */

// CAISO Today's Outlook demand.csv, Nov 14 2026 (PST, UTC-8). 12:05..13:00 = hour ending 21:00 UTC.
const CAISO_DEMAND = [
  "Time,Day ahead forecast,Hour ahead forecast,Current demand,Demand response",
  "12:00,16063,16500,16700,",
  ...["12:05", "12:10", "12:15", "12:20", "12:25", "12:30", "12:35", "12:40", "12:45", "12:50", "12:55", "13:00"].map(
    (t, i) => `${t},16250,16600,${17000 + i * 10},`,
  ),
  "13:05,16900,17000,,",
  "23:55,20851,20617,,",
  "00:00,20851,20617,,",
].join("\n");

const CAISO_FUEL = [
  "Time,Solar,Wind,Geothermal,Biomass,Biogas,Small hydro,Coal,Nuclear,Natural Gas,Large Hydro,Batteries,Imports,Other",
  "00:00,-58,5696,733,149,156,109,3,2208,6954,1066,500,3754,0",
  "00:05,-57,5617,724,149,155,107,3,2208,6967,1097,-200,3766,0",
].join("\n");

// EIA v2 region-data, CISO, trimmed.
const EIA_REGION = JSON.stringify({
  response: {
    total: 6,
    data: [
      { period: "2026-11-15T00", respondent: "CISO", "respondent-name": "California Independent System Operator", type: "D", value: "22816" },
      { period: "2026-11-15T00", respondent: "CISO", "respondent-name": "California Independent System Operator", type: "DF", value: "20744" },
      { period: "2026-11-14T07", respondent: "CISO", "respondent-name": "California Independent System Operator", type: "D", value: "23467" },
      { period: "2026-11-14T07", respondent: "CISO", "respondent-name": "California Independent System Operator", type: "NG", value: "18988" },
      { period: "2026-11-14T07", respondent: "CISO", "respondent-name": "California Independent System Operator", type: "TI", value: "-4873" },
      { period: "2026-11-14T07", respondent: "CISO", "respondent-name": "California Independent System Operator", type: "XX", value: "1" },
    ],
  },
});

const EIA_FUEL = JSON.stringify({
  response: {
    total: 9,
    data: [
      ["COL", "3"], ["GEO", "734"], ["NG", "8377"], ["NUC", "2208"], ["OIL", "46"],
      ["OTH", "2070"], ["SUN", "-49"], ["WAT", "1362"], ["WND", "4237"],
    ].map(([fueltype, value]) => ({ period: "2026-11-14T07", respondent: "CISO", fueltype, value })),
  },
});

/* ---------------------------------------------------------------- tests */

test("EIA period is the UTC hour ending; parse to ISO", () => {
  assert.equal(eiaPeriodToIso("2026-11-15T00"), "2026-11-15T00:00:00.000Z");
  assert.equal(eiaPeriodToIso("garbage"), null);
});

test("EIA URL encodes facets so the response is filtered", () => {
  const u = new URL(eiaUrl("region-data", "CISO", "2026-11-13T00", "DEMO_KEY"));
  assert.deepEqual(u.searchParams.getAll("facets[respondent][]"), ["CISO"]);
  assert.deepEqual(u.searchParams.getAll("facets[type][]"), ["D", "DF", "NG", "TI"]);
  assert.equal(u.searchParams.get("start"), "2026-11-13T00");
  assert.ok(u.href.includes("facets%5Brespondent%5D%5B%5D=CISO"));
  const f = new URL(eiaUrl("fuel-type-data", "ERCO", "2026-11-13T00", "K"));
  assert.equal(f.searchParams.getAll("facets[type][]").length, 0);
});

test("parseEiaRegion groups by hour and keeps only D/DF/NG/TI", () => {
  const p = parseEiaRegion(JSON.parse(EIA_REGION), "CISO");
  assert.equal(p.respondentName, "California Independent System Operator");
  assert.deepEqual(p.hours.get("2026-11-15T00"), { D: 22816, DF: 20744, NG: null, TI: null });
  assert.deepEqual(p.hours.get("2026-11-14T07"), { D: 23467, DF: null, NG: 18988, TI: -4873 });
});

test("parseEiaRegion rejects an unfiltered response and EIA errors", () => {
  const bad = JSON.parse(EIA_REGION);
  bad.response.data[0].respondent = "ERCO";
  assert.throws(() => parseEiaRegion(bad, "CISO"), /not filtered/);
  assert.throws(() => parseEiaRegion({ response: { total: 999999, data: [] } }, "CISO"), /expected a small/);
  assert.throws(() => parseEiaRegion({ error: "invalid api_key" }, "CISO"), /invalid api_key/);
});

test("fuel mix and clean share from EIA fuel-type data", () => {
  const fuel = parseEiaFuel(JSON.parse(EIA_FUEL), "CISO");
  const mix = fuelMixFrom(fuel.get("2026-11-14T07")!);
  assert.equal(mix[0].fuel, "Natural gas");
  const solar = mix.find((f) => f.fuel === "Solar")!;
  assert.equal(solar.mw, -49);
  assert.equal(solar.pct, 0, "negative (night-time station load) counts as 0 %");
  const pos = 3 + 734 + 8377 + 2208 + 46 + 2070 + 1362 + 4237;
  assert.equal(cleanShare(mix), Math.round(((2208 + 1362 + 4237) / pos) * 1000) / 10);
  assert.equal(solarWindShare(mix), Math.round((4237 / pos) * 1000) / 10);
  const sum = mix.reduce((s, f) => s + f.pct, 0);
  assert.ok(Math.abs(sum - 100) < 0.5, `pcts sum to ${sum}`);
});

test("Pacific wall clock -> UTC handles PST and PDT", () => {
  assert.equal(new Date(pacificToUtcMs(2026, 11, 14, 12, 0)).toISOString(), "2026-11-14T20:00:00.000Z");
  assert.equal(new Date(pacificToUtcMs(2026, 7, 1, 12, 0)).toISOString(), "2026-07-01T19:00:00.000Z");
});

test("parseCaisoCsv: times, blanks and the trailing next-day 00:00", () => {
  const rows = parseCaisoCsv(CAISO_DEMAND, { y: 2026, m: 11, d: 14 });
  assert.equal(new Date(rows[0].at).toISOString(), "2026-11-14T20:00:00.000Z");
  assert.equal(rows[rows.length - 1].values["Current demand"], null);
  assert.equal(new Date(rows[rows.length - 1].at).toISOString(), "2026-11-15T08:00:00.000Z");
  const last = latestWith(rows, "Current demand")!;
  assert.equal(new Date(last.at).toISOString(), "2026-11-14T21:00:00.000Z");
  assert.throws(() => parseCaisoCsv("Foo,Bar\n1,2", { y: 2026, m: 1, d: 1 }), /header/);
});

test("CAISO hour average uses readings in (end-1h, end]", () => {
  const rows = parseCaisoCsv(CAISO_DEMAND, { y: 2026, m: 11, d: 14 });
  const avg = hourAverage(rows, "Current demand", Date.parse("2026-11-14T21:00:00Z"));
  assert.equal(avg, 17055); // mean of 17000..17110, the 12:00 reading (16700) excluded
  assert.equal(hourAverage(rows, "Current demand", Date.parse("2026-11-14T22:00:00Z")), null);
});

test("CAISO fuel mix excludes imports; batteries charging count as 0 %", () => {
  const rows = parseCaisoCsv(CAISO_FUEL, { y: 2026, m: 11, d: 14 });
  const { mix, importsMW } = caisoMix(rows[1].values);
  assert.equal(importsMW, 3766);
  assert.equal(mix.find((f) => f.fuel === "Imports"), undefined);
  assert.equal(mix.find((f) => f.fuel === "Hydro")!.mw, 107 + 1097);
  assert.equal(mix.find((f) => f.fuel === "Battery")!.pct, 0);
  assert.equal(caisoHourMix(rows, rows[1].at), null, "fewer than 10 readings -> no hour mix");
});

test("cross-checks: agree/differ honestly at the tolerance", () => {
  const d = demandCrossCheck(17055, 24580, "2026-11-14 21:00 UTC");
  assert.equal(d.agree, false);
  assert.equal(d.diff, 17055 - 24580);
  assert.equal(d.diffPct, Math.round(((17055 - 24580) / 24580) * 1000) / 10);
  assert.equal(demandCrossCheck(1029, 1000, "h").agree, true);
  assert.equal(demandCrossCheck(1031, 1000, "h").agree, false);

  assert.equal(shareCrossCheck(30, 25, "h").agree, true);
  assert.equal(shareCrossCheck(30, 24.9, "h").agree, false);

  const f = forecastCrossCheck(22816, 20744, "h");
  assert.equal(f.agree, false);
  assert.match(f.note!, /forecast error \+10%/);

  // Real CISO hour: NG - D = -4479, TI = -4873 -> 394 MW apart = 1.7 % of demand.
  const b = balanceCrossCheck(23467, 18988, -4873, "h");
  assert.equal(b.a.value, -4479);
  assert.equal(b.diff, 394);
  assert.equal(b.agree, true);
  assert.equal(balanceCrossCheck(23467, 18988, 4873, "h").agree, false, "wrong sign must differ");
});

test("control-area pick: smallest polygon with an EIA code", () => {
  const hits = parseControlAreaQuery({
    features: [
      { attributes: { ID: "1738", NAME: "BONNEVILLE POWER ADMINISTRATION", Shape__Area: 80.98 } },
      { attributes: { ID: "18429", NAME: "CITY OF TACOMA", Shape__Area: 2.25 } },
      { attributes: { ID: "16868", NAME: "SEATTLE CITY LIGHT", Shape__Area: 0.038 } },
    ],
  });
  assert.equal(pickControlArea(hits)!.code, "SCL");
  // Houston: MISO polygon overlaps ERCOT; ERCOT is smaller.
  assert.equal(
    pickControlArea([
      { id: "56669", name: "MISO", area: 178.4 },
      { id: "5723", name: "ERCOT", area: 48.1 },
    ])!.code,
    "ERCO",
  );
  assert.equal(pickControlArea([{ id: "19547", name: "HAWAIIAN ELECTRIC", area: 1 }]), null);
  assert.throws(() => parseControlAreaQuery({ error: { message: "Invalid URL" } }), /Invalid URL/);
});

test("plant fallback: majority of nearest plants", () => {
  const plants = [
    { lat: 33.76, lon: -118.1, ba: "LDWP" },
    { lat: 33.75, lon: -118.0, ba: "CISO" },
    { lat: 33.8, lon: -118.0, ba: "CISO" },
    { lat: 33.7, lon: -118.05, ba: "CISO" },
  ];
  const v = baFromPlants(plants, 33.7538, -118.0111, 3)!;
  assert.equal(v.code, "CISO");
  assert.equal(baFromPlants(plants, 47.6, -122.33), null);
});

test("status: EIA <= 3 h or CAISO <= 15 min is live", () => {
  const now = Date.parse("2026-11-15T01:45:00Z");
  assert.equal(gridStatus("2026-11-15T00:00:00Z", null, true, now), "live");
  assert.equal(gridStatus("2026-11-14T22:00:00Z", null, true, now), "stale");
  assert.equal(gridStatus("2026-11-14T22:00:00Z", "2026-11-15T01:35:00Z", true, now), "live");
  assert.equal(gridStatus(null, null, false, now), "error");
});
