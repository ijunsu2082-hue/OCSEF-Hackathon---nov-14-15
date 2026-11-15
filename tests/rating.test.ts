import { test } from "node:test";
import assert from "node:assert/strict";
import { aarSun, ampacity, conductorRange, rateLine } from "../lib/scan/rating";
import { readCsv } from "./helpers";

// Same inputs as research/scripts/line_rating.py:
//   static = ampacity(40, 0.61, 1000, 90)
//   aar    = ampacity(ta, 0.61, aar_sun(sun), 90)  (FERC Order 881 AAR: real temp, day/night sun
//                                                 1000 W/m2 by day, 0 at night; wind fixed 0.61 m/s)
//   dlr_c  = ampacity(ta, ws * 0.5, sun, 45)    (real wind halved, 45 deg to the line)
// The Python output CSV stores amps rounded to whole numbers.

const TOL = 0.015;
const rel = (a: number, b: number) => (b === 0 ? Math.abs(a) : Math.abs(a - b) / b);

test("TypeScript ampacity matches the Python line-rating output (Westminster HS 2025)", () => {
  const weather = readCsv("research/data/weather/weather_2025_westminster_hs.csv", "time,");
  const rated = readCsv("research/data/line_ratings/line_rating_2025_westminster_hs.csv", "time,");
  const byTime = new Map(rated.map((r) => [r.time, r]));
  assert.ok(rated.length >= 8000, `expected a full year of hours, got ${rated.length}`);

  const staticTs = ampacity(40, 0.61, 1000, 90);
  const step = Math.floor(weather.length / 120);
  let checked = 0, worst = 0;
  for (let i = 0; i < weather.length; i += step) {
    const w = weather[i];
    const ta = Number(w["temperature_2m (°C)"]);
    const ws = Number(w["wind_speed_10m (m/s)"]);
    const sun = Number(w["shortwave_radiation (W/m²)"]);
    if (![ta, ws, sun].every(Number.isFinite)) continue;
    const py = byTime.get(w.time);
    assert.ok(py, `no Python row for ${w.time}`);
    // Inputs in the output CSV must be the same weather we fed in.
    assert.equal(Number(py.temp_c), ta);
    assert.equal(Number(py.wind_ms), ws);
    assert.equal(Number(py.sun_wm2), sun);

    const pairs: [string, number, number][] = [
      ["static", staticTs, Number(py.static_A)],
      ["aar", ampacity(ta, 0.61, aarSun(sun), 90), Number(py.aar_A)],
      ["dlr", ampacity(ta, ws, sun, 45), Number(py.dlr_A)],
      ["dlr_conservative", ampacity(ta, ws * 0.5, sun, 45), Number(py.dlr_conservative_A)],
    ];
    for (const [name, ts, p] of pairs) {
      const e = rel(ts, p);
      worst = Math.max(worst, e);
      assert.ok(e <= TOL, `${w.time} ${name}: TS ${ts.toFixed(1)} vs Python ${p} (${(e * 100).toFixed(2)}%)`);
    }
    // rateLine() is what the app calls; its rounded outputs must match too.
    const rl = rateLine({ temp_c: ta, wind_ms: ws, sun_wm2: sun, time: w.time, source: "fallback-2025" });
    assert.ok(rel(rl.aar_A, Number(py.aar_A)) <= TOL, `${w.time} rateLine aar`);
    assert.ok(rel(rl.dlr_conservative_A, Number(py.dlr_conservative_A)) <= TOL, `${w.time} rateLine dlr_c`);
    checked++;
  }
  assert.ok(checked >= 50, `only ${checked} hours checked`);
  console.log(`rating parity: ${checked} hours, worst relative difference ${(worst * 100).toFixed(3)}%`);
});

test("static rating is 723 A, as stated in the sources panel", () => {
  assert.equal(Math.round(ampacity(40, 0.61, 1000, 90)), 723);
});

test("AAR uses Order 881 day/night sun, not measured sun", () => {
  const cloudyDay = rateLine({ temp_c: 30, wind_ms: 1, sun_wm2: 200, time: "t", source: "fallback-2025" });
  assert.equal(cloudyDay.aar_A, Math.round(ampacity(30, 0.61, 1000, 90)));
  const night = rateLine({ temp_c: 30, wind_ms: 1, sun_wm2: 0, time: "t", source: "fallback-2025" });
  assert.equal(night.aar_A, Math.round(ampacity(30, 0.61, 0, 90)));
  const drake = conductorRange({ temp_c: 30, wind_ms: 1, sun_wm2: 200, time: "t", source: "fallback-2025" }).rows.find((r) => r.key === "drake")!;
  assert.ok(Math.abs(drake.aar_ratio - ampacity(30, 0.61, 1000, 90) / ampacity(40, 0.61, 1000, 90)) < 1e-9);
  // Above 1000 W/m2 the AAR still uses 1000, so it cannot drop below static at or under 40 C.
  const bright = rateLine({ temp_c: 35, wind_ms: 1, sun_wm2: 1050, time: "t", source: "fallback-2025" });
  assert.ok(bright.aar_A > bright.static_A);
});
