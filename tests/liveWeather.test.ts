import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineMi } from "../lib/scan/geo";
import { aarRatio, rateLine } from "../lib/scan/rating";
import {
  buildWeatherFeed,
  feedStatus,
  parseAlerts,
  parseNwsHourly,
  parseNwsObservation,
  parseOpenMeteo,
  parseWindString,
  samplePoints,
  tagAlert,
  tempCrossCheck,
  windCrossCheck,
  worstSample,
} from "../lib/live/weather";

/* ---------------------------------------------------------------- fixtures (shapes copied from real responses) */

const NOW = Date.parse("2026-11-15T01:40:00Z");

const NWS_OBS = {
  properties: {
    timestamp: "2026-11-15T01:15:00+00:00",
    stationId: "KPHX",
    temperature: { unitCode: "wmoUnit:degC", value: 20, qualityControl: "V" },
    windSpeed: { unitCode: "wmoUnit:km_h-1", value: 5.4, qualityControl: "V" },
    windDirection: { unitCode: "wmoUnit:degree_(angle)", value: 270, qualityControl: "V" },
    windGust: { unitCode: "wmoUnit:km_h-1", value: null, qualityControl: "Z" },
  },
};
const NWS_OBS_EMPTY = {
  properties: {
    timestamp: "2026-11-14T23:55:00+00:00",
    temperature: { unitCode: "wmoUnit:degC", value: null, qualityControl: "Z" },
    windSpeed: { unitCode: "wmoUnit:km_h-1", value: null, qualityControl: "Z" },
    windDirection: { unitCode: "wmoUnit:degree_(angle)", value: null },
    windGust: { unitCode: "wmoUnit:km_h-1", value: null },
  },
};

const alert = (id: string, event: string, severity = "Severe") => ({
  id: `https://api.weather.gov/alerts/${id}`,
  type: "Feature",
  properties: { id, event, severity, headline: `${event} issued`, onset: "2026-11-15T00:00:00-07:00", ends: null },
});
const ALERTS_A = { type: "FeatureCollection", features: [alert("urn:1", "Red Flag Warning", "Extreme"), alert("urn:2", "High Surf Advisory", "Minor")] };
const ALERTS_B = { type: "FeatureCollection", features: [alert("urn:1", "Red Flag Warning", "Extreme"), alert("urn:3", "Excessive Heat Warning")] };

const omCur = (t: number, w: number, s = 0) => ({
  latitude: 33.45, longitude: -112.07,
  current: { time: Math.floor(Date.parse("2026-11-15T01:30:00Z") / 1000), interval: 900, temperature_2m: t, wind_speed_10m: w, wind_direction_10m: 180, shortwave_radiation: s },
});
const OM_MULTI = [omCur(17.9, 0.4), omCur(14.9, 0.5), omCur(17.1, 1.8), omCur(15.7, 2.5), omCur(17.8, 1.7)];

const HOURLY = {
  properties: {
    periods: [
      { startTime: "2026-11-14T16:00:00-08:00", endTime: "2026-11-14T17:00:00-08:00", temperature: 22, temperatureUnit: "C", windSpeed: "5 km/h" },
      { startTime: "2026-11-14T17:00:00-08:00", endTime: "2026-11-14T18:00:00-08:00", temperature: 21, temperatureUnit: "C", windSpeed: "5 km/h" },
      { startTime: "2026-11-14T18:00:00-08:00", endTime: "2026-11-14T19:00:00-08:00", temperature: 68, temperatureUnit: "F", windSpeed: "10 to 20 mph" },
    ],
  },
};

/* ---------------------------------------------------------------- geometry */

test("five sample points: center plus N/S/E/W at 0.6 x radius", () => {
  for (const [lat, lon, r] of [[33.7538, -118.0111, 5], [33.45, -112.07, 50], [41.88, -87.63, 25]] as const) {
    const pts = samplePoints(lat, lon, r);
    assert.deepEqual(pts.map((p) => p.label), ["Center", "North", "South", "East", "West"]);
    assert.equal(pts[0].lat, lat);
    assert.equal(pts[0].lon, lon);
    for (const p of pts.slice(1)) {
      const d = haversineMi(lat, lon, p.lat, p.lon);
      assert.ok(Math.abs(d - 0.6 * r) / (0.6 * r) < 0.01, `${p.label} at ${d.toFixed(3)} mi, want ${0.6 * r}`);
      assert.ok(d < r, "inside the scan circle");
    }
    assert.ok(pts[1].lat > lat && pts[1].lon === lon);
    assert.ok(pts[2].lat < lat && pts[2].lon === lon);
    assert.ok(pts[3].lon > lon && pts[3].lat === lat);
    assert.ok(pts[4].lon < lon && pts[4].lat === lat);
  }
});

/* ---------------------------------------------------------------- parsing */

test("NWS observation: km/h -> m/s, nulls stay null", () => {
  const o = parseNwsObservation(NWS_OBS);
  assert.equal(o.tempC, 20);
  assert.ok(Math.abs((o.windMs ?? NaN) - 1.5) < 1e-9);
  assert.equal(o.windDirDeg, 270);
  assert.equal(o.gustMs, null);
  assert.equal(o.observedAt, "2026-11-15T01:15:00.000Z");
  const e = parseNwsObservation(NWS_OBS_EMPTY);
  assert.equal(e.tempC, null);
  assert.equal(e.windMs, null);
});

test("hourly forecast: drops past hours, converts F and mph ranges", () => {
  assert.equal(parseWindString("5 km/h")?.toFixed(3), (5 / 3.6).toFixed(3));
  assert.equal(parseWindString("10 to 20 mph")?.toFixed(3), (15 * 0.44704).toFixed(3));
  assert.equal(parseWindString("calm"), null);
  const h = parseNwsHourly(HOURLY, NOW); // NOW = 17:40 PST, so the 16:00 period is past
  assert.equal(h.length, 2);
  assert.equal(h[0].tempC, 21);
  assert.equal(h[1].tempC, 20); // 68 F
  assert.equal(h[1].windMs, 6.7);
});

test("Open-Meteo multi-location array and single object", () => {
  const om = parseOpenMeteo(OM_MULTI, 5);
  assert.equal(om.length, 5);
  assert.equal(om[1]?.tempC, 14.9);
  assert.equal(om[0]?.time, "2026-11-15T01:30:00.000Z");
  assert.equal(parseOpenMeteo(omCur(10, 1), 1)[0]?.tempC, 10);
  assert.equal(parseOpenMeteo([{ current: { temperature_2m: 5 } }], 1)[0], null, "missing fields -> null, not zero");
});

/* ---------------------------------------------------------------- alerts */

test("alert relevance tagging", () => {
  for (const e of [
    "Excessive Heat Warning", "Extreme Heat Warning", "Extreme Heat Watch", "Heat Advisory", "Red Flag Warning",
    "High Wind Warning", "High Wind Watch", "Winter Storm Warning", "Ice Storm Warning", "Hurricane Warning",
    "Tropical Storm Watch", "Fire Weather Watch",
  ]) {
    const t = tagAlert(e);
    assert.ok(t.gridRelevant, e);
    assert.ok(t.why && t.why.length > 10, e);
  }
  for (const e of ["Small Craft Advisory", "High Surf Advisory", "Dense Fog Advisory", "Frost Advisory", "Test Message", "Wind Advisory"]) {
    assert.equal(tagAlert(e).gridRelevant, false, e);
  }
});

test("alerts dedupe by id across sample points, grid-relevant first", () => {
  const a = parseAlerts([ALERTS_A, ALERTS_B, { features: [] }]);
  assert.deepEqual(a.map((x) => x.id).sort(), ["urn:1", "urn:2", "urn:3"]);
  assert.equal(a[a.length - 1].event, "High Surf Advisory");
  assert.ok(a.slice(0, 2).every((x) => x.gridRelevant));
  assert.equal(a.find((x) => x.id === "urn:1")?.severity, "Extreme");
});

/* ---------------------------------------------------------------- cross-checks, rating, status */

test("cross-check math and tolerances", () => {
  const t = tempCrossCheck(20, 17.9, 4.1);
  assert.equal(t.diff, 2.1);
  assert.equal(t.diffPct, null);
  assert.equal(t.agree, true);
  assert.match(t.note ?? "", /4\.1 mi/);
  assert.equal(tempCrossCheck(20, 16.9, null).agree, false, "3.1 °C apart differs");
  assert.equal(tempCrossCheck(20, 17, null).agree, true, "exactly 3 °C agrees");
  const w = windCrossCheck(1.5, 0.4, 4.1);
  assert.equal(w.diff, 1.1);
  assert.equal(w.diffPct, 275);
  assert.equal(w.agree, true);
  assert.equal(windCrossCheck(6.5, 3, null).agree, false);
  assert.equal(windCrossCheck(0, 0, null).diffPct, null);
});

test("ratios come from rateLine; worst is the lowest", () => {
  const r = rateLine({ temp_c: 17.9, wind_ms: 0.4, sun_wm2: 0, time: "t", source: "open-meteo-live" });
  const samples = [
    { label: "Center", lat: 0, lon: 0, tempC: 17.9, windMs: 0.4, ratio: { aar: aarRatio(r)!, dlr: r.ratio } },
    { label: "East", lat: 0, lon: 0, tempC: 15, windMs: 3, ratio: { aar: 1.6, dlr: 1.7 } },
  ];
  assert.equal(worstSample(samples)?.label, "Center");
  assert.equal(worstSample([]), null);
});

test("status: live within 90 min, stale after, error with no data", () => {
  assert.equal(feedStatus("2026-11-15T00:15:00Z", true, NOW), "live"); // 85 min
  assert.equal(feedStatus("2026-11-15T00:05:00Z", true, NOW), "stale"); // 95 min
  assert.equal(feedStatus(null, false, NOW), "error");
});

/* ---------------------------------------------------------------- full path with stubbed fetch (no network) */

function stubUpstream(opts: { omDown?: boolean; nwsDown?: boolean; staleObs?: boolean }) {
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  const fresh = new Date(Date.now() - (opts.staleObs ? 4 * 3600_000 : 10 * 60_000)).toISOString();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("open-meteo")) {
      if (opts.omDown) throw new Error("timed out after 8 s");
      const cur = Math.floor(Date.now() / 1000);
      return json(OM_MULTI.map((o) => ({ ...o, current: { ...o.current, time: cur } })));
    }
    if (opts.nwsDown) return new Response("down", { status: 503 });
    if (url.includes("/points/")) {
      return json({ properties: { observationStations: "https://api.weather.gov/gridpoints/PSR/1,1/stations", forecastHourly: "https://api.weather.gov/gridpoints/PSR/1,1/forecast/hourly" } });
    }
    if (url.includes("/gridpoints/PSR/1,1/stations")) {
      return json({ features: [
        { geometry: { coordinates: [-112.0, 33.43] }, properties: { stationIdentifier: "KPHX", name: "Phoenix" } },
        { geometry: { coordinates: [-112.07, 33.45] }, properties: { stationIdentifier: "EMPTY", name: "Nearest but empty" } },
      ] });
    }
    if (url.includes("/stations/EMPTY/")) return json(NWS_OBS_EMPTY);
    if (url.includes("/stations/KPHX/")) return json({ properties: { ...NWS_OBS.properties, timestamp: fresh } });
    if (url.includes("forecast/hourly")) return json({ properties: { periods: [] } });
    if (url.includes("/alerts/active")) return json(url.includes("point=33.4500,-112.0700") ? ALERTS_A : ALERTS_B);
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

test("buildWeatherFeed: both providers up", async () => {
  stubUpstream({});
  const f = await buildWeatherFeed(33.45, -112.07, 50);
  assert.equal(f.status, "live");
  assert.equal(f.refreshSec, 300);
  assert.equal(f.data?.samples.length, 5);
  assert.equal(f.data?.center.station?.id, "KPHX", "skips the nearest station with no temperature");
  assert.equal(f.data?.center.tempC, 20);
  assert.equal(f.crossChecks.length, 2);
  assert.ok(f.crossChecks.every((c) => c.agree));
  assert.equal(f.data?.alerts.length, 3, "deduped across 5 points");
  assert.deepEqual(f.data?.tempRange, { minC: 14.9, maxC: 17.9 });
  assert.ok(f.errors.some((e) => /EMPTY/.test(e)));
});

test("buildWeatherFeed: Open-Meteo down -> NWS only, still live, no fabricated samples", async () => {
  stubUpstream({ omDown: true });
  const f = await buildWeatherFeed(33.46, -112.08, 10);
  assert.equal(f.status, "live");
  assert.equal(f.data?.samples.length, 0);
  assert.equal(f.data?.worst, null);
  assert.equal(f.data?.center.sunWm2, null);
  assert.equal(f.data?.center.tempC, 20);
  assert.equal(f.crossChecks.length, 0);
  assert.ok(f.errors.some((e) => /Open-Meteo unavailable/.test(e)));
});

test("buildWeatherFeed: NWS down -> Open-Meteo only", async () => {
  stubUpstream({ nwsDown: true });
  const f = await buildWeatherFeed(33.47, -112.09, 10);
  assert.equal(f.status, "live");
  assert.equal(f.data?.center.station, null);
  assert.equal(f.data?.center.tempC, 17.9);
  assert.equal(f.data?.center.gustMs, null);
  assert.equal(f.data?.alerts.length, 0);
  assert.ok(f.errors.some((e) => /National Weather Service unavailable/.test(e)));
});

test("buildWeatherFeed: only an old station reading -> used, but flagged with its age", async () => {
  stubUpstream({ staleObs: true });
  const f = await buildWeatherFeed(33.49, -112.11, 10);
  assert.equal(f.data?.center.station?.id, "KPHX");
  assert.ok(f.errors.some((e) => /KPHX\) is 4 h old/.test(e)), f.errors.join(" | "));
  assert.equal(f.status, "live", "Open-Meteo is fresh, so the newest reading is within 90 min");
});

test("buildWeatherFeed: everything down -> error, data null", async () => {
  stubUpstream({ omDown: true, nwsDown: true });
  const f = await buildWeatherFeed(33.48, -112.1, 10);
  assert.equal(f.status, "error");
  assert.equal(f.data, null);
  assert.ok(f.errors.length > 0);
});
