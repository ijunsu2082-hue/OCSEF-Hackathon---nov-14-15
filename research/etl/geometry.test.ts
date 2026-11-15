import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clipFeature, clipLine, greatCircleMiles, polylineMiles, STUDY_RING_VERTICES, studyRing, voltageBand, type Position,
} from "./geometry";

const CENTER: Position = [-118, 34];
const RADIUS = 10;

function close(actual: number, expected: number, relative: number, label: string) {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * relative,
    `${label}: expected ${expected} within ${relative * 100}%, got ${actual}`);
}

/** Independent reference: haversine with R = 3958.8 statute miles. */
function haversineMiles([lon1, lat1]: Position, [lon2, lat2]: Position): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(a));
}

test("chord through the centre with both endpoints outside keeps only the inside 2r", () => {
  const line: Position[] = [[-118.5, 34], [-117.5, 34]];
  assert.ok(greatCircleMiles(CENTER, line[0]) > RADIUS && greatCircleMiles(CENTER, line[1]) > RADIUS);
  const pieces = clipLine(CENTER, RADIUS, line);
  assert.equal(pieces.length, 1);
  close(pieces[0].miles, 2 * RADIUS, 0.001, "chord miles");
  for (const end of [pieces[0].coordinates[0], pieces[0].coordinates.at(-1)!]) {
    close(greatCircleMiles(CENTER, end), RADIUS, 0.001, "clip point on circle");
  }
  const feature = clipFeature(CENTER, RADIUS, { type: "LineString", coordinates: line });
  assert.ok(feature);
  assert.equal(feature.segments, 1);
  close(feature.miles, 2 * RADIUS, 0.001, "feature chord miles");
  assert.ok(polylineMiles(line) > 50, "whole provider line is much longer than the inside part");
});

test("fully inside line is kept whole", () => {
  const line: Position[] = [[-118, 34], [-118.05, 34.02], [-117.98, 34.05]];
  const pieces = clipLine(CENTER, RADIUS, line);
  assert.equal(pieces.length, 1);
  close(pieces[0].miles, polylineMiles(line), 1e-9, "inside miles == total");
  const feature = clipFeature(CENTER, RADIUS, { type: "LineString", coordinates: line });
  assert.deepEqual(feature, { miles: Math.round(polylineMiles(line) * 100) / 100, segments: 1 });
});

test("fully outside line contributes nothing", () => {
  const line: Position[] = [[-118.2, 35], [-117.8, 35]];
  assert.deepEqual(clipLine(CENTER, RADIUS, line), []);
  assert.deepEqual(clipFeature(CENTER, RADIUS, { type: "LineString", coordinates: line }), { miles: 0, segments: 0 });
});

test("line that exits and re-enters the circle yields two inside segments", () => {
  // North out of the circle, east along a parallel ~20.7 mi away, then south back toward centre latitude.
  const line: Position[] = [[-118, 34], [-118, 34.3], [-117.9, 34.3], [-117.9, 34]];
  const pieces = clipLine(CENTER, RADIUS, line);
  assert.equal(pieces.length, 2);
  close(pieces[0].miles, RADIUS, 0.001, "outbound leg");
  const east = greatCircleMiles(CENTER, [-117.9, 34]);
  close(pieces[1].miles, Math.sqrt(RADIUS ** 2 - east ** 2), 0.002, "return leg");
  assert.equal(clipFeature(CENTER, RADIUS, { type: "LineString", coordinates: line })?.segments, 2);
});

test("MultiLineString sums its parts and non-line geometry is not clipped", () => {
  const chord: Position[] = [[-118.5, 34], [-117.5, 34]];
  const inside: Position[] = [[-118, 34], [-118.05, 34.02]];
  const outside: Position[] = [[-118.2, 35], [-117.8, 35]];
  const feature = clipFeature(CENTER, RADIUS, { type: "MultiLineString", coordinates: [chord, inside, outside] });
  assert.ok(feature);
  assert.equal(feature.segments, 2);
  close(feature.miles, 2 * RADIUS + polylineMiles(inside), 0.001, "multi miles");
  assert.equal(clipFeature(CENTER, RADIUS, { type: "Point", coordinates: CENTER }), null);
  assert.equal(clipFeature(CENTER, RADIUS, null), null);
});

test("greatCircleMiles matches an independent haversine for Los Angeles to San Diego", () => {
  const la: Position = [-118.2437, 34.0522];
  const sd: Position = [-117.1611, 32.7157];
  const reference = haversineMiles(la, sd);
  assert.ok(reference > 110 && reference < 113, `reference ${reference}`);
  close(greatCircleMiles(la, sd), reference, 0.001, "LA to SD");
  close(greatCircleMiles(sd, la), reference, 0.001, "SD to LA");
});

test("voltageBand boundaries and unknown values", () => {
  for (const unknown of [null, Number.NaN, Number.POSITIVE_INFINITY, -1, -999999]) {
    assert.equal(voltageBand(unknown), "unknown", String(unknown));
  }
  const cases: [number, string][] = [
    [68.9, "below-69"], [69, "69-115"], [114.9, "69-115"], [115, "115-230"], [229.9, "115-230"],
    [230, "230-345"], [344.9, "230-345"], [345, "345-500"], [499.9, "345-500"], [500, "500-765"],
    [764.9, "500-765"], [765, "765-plus"], [1100, "765-plus"],
  ];
  for (const [kv, band] of cases) assert.equal(voltageBand(kv), band, String(kv));
});

test("voltageBand puts direct-current lines in dc whatever the voltage", () => {
  for (const kv of [1000, 500, 765, null]) assert.equal(voltageBand(kv, { dc: true }), "dc", String(kv));
  assert.equal(voltageBand(500, { dc: false }), "500-765");
  assert.equal(voltageBand(1000, {}), "765-plus");
});

test("studyRing is a closed clockwise ring that circumscribes the great-circle study circle", () => {
  const center: Position = [-118.0111, 33.7538];
  const radius = 100;
  const ring = studyRing(center, radius);
  assert.equal(ring.length, STUDY_RING_VERTICES + 1);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  for (const [lon, lat] of ring) {
    assert.equal(Math.round(lon * 1e4) / 1e4, lon);
    assert.equal(Math.round(lat * 1e4) / 1e4, lat);
  }
  // Shoelace in lon/lat: negative area means clockwise (Esri outer ring).
  let area = 0;
  for (let i = 1; i < ring.length; i += 1) area += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  assert.ok(area < 0, `signed area ${area}`);
  // Every edge stays outside the great-circle circle (not clipLine's local-plane circle, which differs
  // from it by up to about 0.33% here; see the geometry.ts module note).
  for (let i = 1; i < ring.length; i += 1) {
    assert.ok(edgeMinMiles(center, ring[i - 1], ring[i]) >= radius * (1 - 1e-5), `edge ${i}`);
  }
  // ...and hugs it: vertices sit on great circles about radius * sec(pi/n) out, plus a few metres.
  const limit = radius / Math.cos(Math.PI / STUDY_RING_VERTICES) + 30 / 1609.344;
  for (const vertex of ring) {
    const miles = greatCircleMiles(center, vertex);
    assert.ok(miles > radius && miles <= limit, `vertex at ${miles} mi`);
  }
  // A line one metre inside the circle edge is inside both the circle and the ring.
  const justInside: Position = [center[0], center[1] + ((radius * 1609.344 - 1) / 6_371_008.8) * (180 / Math.PI)];
  assert.ok(clipLine(center, radius, [justInside, [justInside[0] + 0.0001, justInside[1]]]).length === 1);
  assert.throws(() => studyRing(center, 0), /positive/);
  assert.throws(() => studyRing(center, 10, 4), /at least 8/);
});

/** Smallest great-circle distance from `center` to a straight lon/lat edge a→b (dense sampling). */
function edgeMinMiles(center: Position, a: Position, b: Position): number {
  let min = Infinity;
  for (let step = 0; step <= 400; step += 1) {
    const t = step / 400;
    min = Math.min(min, haversineMiles(center, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]));
  }
  return min;
}

test("studyRing encloses every point within the great-circle radius and overshoots it only slightly", () => {
  // haversineMiles uses R = 3958.8 mi, about 1e-5 larger than greatCircleMiles' R, hence the 1e-5 slack.
  for (const center of [[-117.99, 33.75], [-118.0111, 33.7538], [-105, 39.8], [-100, 45], [-100, 25], [-150, 60], [0, 0], [170, -40]] as Position[]) {
    for (const radius of [1, 10, 100, 500]) {
      const ring = studyRing(center, radius);
      let edgeMin = Infinity;
      for (let i = 1; i < ring.length; i += 1) edgeMin = Math.min(edgeMin, edgeMinMiles(center, ring[i - 1], ring[i]));
      assert.ok(edgeMin >= radius * (1 - 1e-5), `${center} r=${radius}: an edge comes within ${edgeMin} mi`);
      const vertexMax = Math.max(...ring.map((vertex) => greatCircleMiles(center, vertex)));
      assert.ok(vertexMax <= radius * 1.0016 + 15 / 1609.344, `${center} r=${radius}: vertex at ${vertexMax} mi`);
    }
  }
});
