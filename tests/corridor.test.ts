import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIXED_A,
  corridorBearingDeg,
  corridorMidpoint,
  kAngle,
  rateCorridor,
  windAngleToLine,
} from "../lib/scan/corridor";
import { ampacity, rateLine } from "../lib/scan/rating";
import type { WeatherNow } from "../lib/scan/types";

const near = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} ± ${tol}, got ${a}`);
/** Axial bearing: N-S line may come out 0 or 180 depending on drawing order. */
const axial = (deg: number) => deg % 180;

// Line.coords are [lat, lon].
const NS: [number, number][] = [[33.6, -118.0], [33.8, -118.0]];
const SN: [number, number][] = [[33.8, -118.0], [33.6, -118.0]];
const EW: [number, number][] = [[33.7, -118.2], [33.7, -117.9]];

test("bearing of a north-south line is about 0 / 180", () => {
  const b1 = corridorBearingDeg(NS)!, b2 = corridorBearingDeg(SN)!;
  near(b1, 0, 0.01, "N-S");
  near(b2, 180, 0.01, "S-N");
  near(axial(b2), 0, 0.01);
});

test("bearing of an east-west line is about 90 / 270", () => {
  const b = corridorBearingDeg(EW)!;
  near(b, 90, 0.2, "E-W"); // great-circle initial bearing on a parallel is slightly off 90
  near(corridorBearingDeg([...EW].reverse())!, 270, 0.2, "W-E");
});

test("bearing uses the segment at the midpoint", () => {
  // short north leg, then a long east leg: the midpoint is on the east leg
  const L: [number, number][] = [[33.7, -118.0], [33.71, -118.0], [33.71, -117.5]];
  near(corridorBearingDeg(L)!, 90, 0.5);
});

test("midpoint is halfway along the line by length", () => {
  const [lat, lon] = corridorMidpoint(NS)!;
  near(lat, 33.7, 1e-6);
  near(lon, -118.0, 1e-9);
  // two equal-length segments north then north again: midpoint at the shared vertex
  const [la2] = corridorMidpoint([[33.0, -118], [33.1, -118], [33.2, -118]])!;
  near(la2, 33.1, 1e-4);
  // uneven: 0.1 deg then 0.3 deg north -> halfway is 0.2 deg from the start
  const [la3] = corridorMidpoint([[33.0, -118], [33.1, -118], [33.4, -118]])!;
  near(la3, 33.2, 1e-3);
  assert.deepEqual(corridorMidpoint([[33, -118]]), [33, -118]);
  assert.equal(corridorMidpoint([]), null);
  assert.equal(corridorBearingDeg([[33, -118]]), null);
});

test("IEEE 738 wind-angle factor: 1 at 90°, about 0.388 at 0°", () => {
  near(kAngle(90), 1.0, 1e-9);
  near(kAngle(0), 0.388, 1e-9);
});

test("wind angle to the line folds into 0..90", () => {
  assert.equal(windAngleToLine(0, 0), 0);     // wind along a N-S line
  assert.equal(windAngleToLine(180, 0), 0);
  assert.equal(windAngleToLine(90, 0), 90);   // crosswind
  assert.equal(windAngleToLine(270, 180), 90);
  near(windAngleToLine(30, 0), 30, 1e-9);
  near(windAngleToLine(330, 0), 30, 1e-9);
  near(windAngleToLine(200, 90), 70, 1e-9);
});

test("rating wrapper matches rating.ts: fixed 723 A, 45° default equals rateLine", () => {
  near(FIXED_A, 723, 1);
  const w: WeatherNow = { temp_c: 22, wind_ms: 4, sun_wm2: 600, time: "2026-11-14T10:00", source: "open-meteo-live" };
  const base = rateLine(w);
  const r45 = rateCorridor(w, null);
  assert.equal(r45.angle_known, false);
  assert.equal(Math.round(r45.now_A), base.dlr_conservative_A);
  assert.equal(Math.round(r45.still_A), base.aar_A);
  // crosswind cools more than wind along the wire
  const cross = rateCorridor(w, 90), along = rateCorridor(w, 0);
  assert.ok(cross.now_A > r45.now_A && r45.now_A > along.now_A);
  near(cross.now_A, ampacity(22, 2, 600, 90), 1e-9);
  // 105 °F day is below the fixed rating
  assert.ok(cross.hot_ratio < 1);
});
