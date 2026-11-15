import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGridData } from "../lib/scan/data";
import { scanArea } from "../lib/scan/scan";
import { CENTER } from "../lib/scan/geo";
import { heatwaveWeather, rateLine } from "../lib/scan/rating";
import { CURTAILED_TOTAL_2025, co2RangeTonnes, CURTAILED_LOCAL_2025, homesForYear, localSharePct } from "../lib/scan/impact";
import { riskRange } from "../lib/scan/risk";
import { provenanceFor, staticRatingA, type ProvenanceRow } from "../lib/scan/provenance";
import { fmtNum, fmtPct, fmtPowerText, fmtRatio } from "../components/scan/panel/format";
import type { LineRatingNow, ScanResult, WeatherNow } from "../lib/scan/types";
import { stubFetchFromPublic } from "./helpers";

stubFetchFromPublic();

const METHODS = new Set(["MEASURED", "MODELED", "SCENARIO", "ESTIMATE"]);
const LIVE_WEATHER: WeatherNow = { temp_c: 22, wind_ms: 3, sun_wm2: 600, time: "2026-11-14T13:00", source: "open-meteo-live" };

async function westminster5(heatwave = false): Promise<ScanResult> {
  const data = await loadGridData();
  return scanArea(data, { lat: CENTER.lat, lon: CENTER.lon, radius_mi: 5 }, { heatwave });
}

function row(rows: ProvenanceRow[], label: string): ProvenanceRow {
  const r = rows.find((x) => x.label === label);
  assert.ok(r, `missing row "${label}"`);
  return r;
}

function checkRows(rows: ProvenanceRow[]) {
  assert.ok(rows.length > 0);
  const labels = new Set<string>();
  for (const r of rows) {
    assert.ok(!labels.has(r.label), `duplicate label ${r.label}`);
    labels.add(r.label);
    assert.ok(METHODS.has(r.method), `${r.label}: bad method ${r.method}`);
    assert.match(r.source.url, /^https:\/\/\S+$/, `${r.label}: url ${r.source.url}`);
    assert.ok(r.source.label.length > 0, `${r.label}: empty source label`);
    assert.ok(r.how.length > 0 && r.value.length > 0, `${r.label}: empty value or how`);
    const text = `${r.label} ${r.value} ${r.source.label} ${r.how}`;
    assert.doesNotMatch(text, /unknown|NaN|undefined|null|Infinity/i, `${r.label}: ${text}`);
  }
}

test("live scan: every row has a method, an https source and no unknowns; values match lib", async () => {
  const r = await westminster5();
  const live = rateLine(LIVE_WEATHER);
  const rows = provenanceFor(r, live, false);
  checkRows(rows);

  assert.equal(row(rows, "Weather now").method, "MEASURED");
  assert.equal(row(rows, "Temperature-adjusted rating vs fixed").value, fmtRatio(live.aar_A / live.static_A));
  assert.equal(row(rows, "Temperature-adjusted rating vs fixed").method, "MODELED");
  assert.equal(row(rows, "Wind-based rating vs fixed").value, fmtRatio(live.ratio));
  assert.equal(row(rows, "Fixed (static) rating").value, `${live.static_A} A`);
  assert.equal(staticRatingA(), 723);
  assert.equal(row(rows, "Nameplate").value, fmtPowerText(r.totals.nameplate_mw));
  assert.equal(row(rows, "Nameplate").method, "MEASURED");
  assert.equal(row(rows, "Power plants").value, fmtNum(r.totals.plant_count));
  assert.equal(row(rows, "Renewables share").value, fmtPct(r.totals.renewable_pct));
  assert.equal(row(rows, "Substations").value, fmtNum(r.totals.substation_count));
  assert.equal(row(rows, "Substation names from the state list").value,
    fmtNum(r.substations.filter((s) => s.name_source === "state_list").length));
  const risk = row(rows, "Risk index");
  assert.equal(risk.method, "MODELED");
  assert.equal(risk.value, `${fmtNum(r.risk.score, 0)} / 100 (${r.risk.level})`);
  const rr = riskRange(r.risk);
  assert.ok(risk.how.includes(`${rr.min}–${rr.max}`), risk.how);
  assert.ok(risk.how.includes("±50%"));

  assert.equal(row(rows, `Solar and wind curtailed in ${CURTAILED_TOTAL_2025.year}`).value, "3.77 million MWh");
  assert.equal(row(rows, "Cut because local lines were full").value, fmtPct(localSharePct(), 0));
  const co2 = co2RangeTonnes(CURTAILED_LOCAL_2025.value);
  const co2Row = row(rows, "CO2 if congestion curtailment had replaced other power");
  assert.equal(co2Row.value, `${fmtNum(co2.low / 1e6, 1)}–${fmtNum(co2.high / 1e6, 1)} million t`);
  assert.ok(co2Row.how.includes("428.5") && co2Row.how.includes("958.3"));
  assert.equal(co2Row.method, "ESTIMATE");
  const homes = row(rows, "Homes that power could supply for a year");
  assert.equal(homes.value, `about ${fmtNum(Math.round(homesForYear(CURTAILED_LOCAL_2025.value) / 10_000) * 10_000, 0)}`);
  assert.ok(homes.how.includes("503"));
  assert.ok(!rows.some((x) => x.method === "SCENARIO"), "no scenario row without heatwave");
});

test("heatwave: a SCENARIO row at 105 °F and no measured weather row", async () => {
  const r = await westminster5(true);
  const live: LineRatingNow = rateLine(heatwaveWeather());
  const rows = provenanceFor(r, live, true);
  checkRows(rows);
  const hw = row(rows, "Heatwave scenario");
  assert.equal(hw.method, "SCENARIO");
  assert.equal(hw.value, "105 °F");
  assert.ok(!rows.some((x) => x.label === "Weather now"));
  assert.equal(row(rows, "Temperature-adjusted rating vs fixed").value, fmtRatio(live.aar_A / live.static_A));
});

test("no live rating: live rows are left out, the rest still check out", async () => {
  const r = await westminster5();
  const rows = provenanceFor(r, null, false);
  checkRows(rows);
  assert.ok(!rows.some((x) => x.label === "Weather now" || x.label === "Temperature-adjusted rating vs fixed"));
  assert.equal(row(rows, "Fixed (static) rating").value, "723 A");
});

test("2025 fallback weather is not labeled as live", async () => {
  const r = await westminster5();
  const rows = provenanceFor(r, rateLine({ ...LIVE_WEATHER, source: "fallback-2025" }), false);
  checkRows(rows);
  assert.ok(!rows.some((x) => x.label === "Weather now"));
  assert.equal(row(rows, "Weather used (live unavailable)").source.url, "https://open-meteo.com/en/docs/historical-weather-api");
});
