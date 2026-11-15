import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPORT_RADIUS_MAX,
  REPORT_RADIUS_MIN,
  parseReportId,
  reportIdFor,
  reportUrl,
} from "../lib/scan/reportLink";

test("reportIdFor formats 4-decimal coordinates and whole-mile radius", () => {
  assert.equal(reportIdFor(33.7538, -118.0111, 5), "area_33.7538_-118.0111_5");
  assert.equal(reportIdFor(33.778557, -117.98506, 12.4), "area_33.7786_-117.9851_12");
});

test("reportUrl returns a path, or an absolute URL with an origin", () => {
  assert.equal(reportUrl(33.7538, -118.0111, 5), "/location-report/area_33.7538_-118.0111_5");
  assert.equal(
    reportUrl(33.7538, -118.0111, 5, "https://example.org/"),
    "https://example.org/location-report/area_33.7538_-118.0111_5",
  );
});

test("id round-trips through parseReportId", () => {
  for (const [lat, lon, r] of [
    [33.7538, -118.0111, 5],
    [34.059753, -118.2375, 1],
    [33.427063, -117.589615, 30],
    [-12.5, 0, 7],
  ] as const) {
    const id = reportIdFor(lat, lon, r);
    const area = parseReportId(id);
    assert.ok(area, `parse failed for ${id}`);
    assert.equal(reportIdFor(area.lat, area.lon, area.radius_mi), id);
    assert.ok(Math.abs(area.lat - lat) <= 0.00005);
    assert.ok(Math.abs(area.lon - lon) <= 0.00005);
    assert.equal(area.radius_mi, r);
  }
});

test("parseReportId rejects malformed ids", () => {
  for (const bad of [
    "",
    "area",
    "area_33.7538_-118.0111",
    "area_33.7538_-118.0111_5_extra",
    "zone_33.7538_-118.0111_5",
    "area_abc_-118.0111_5",
    "area_33.7538_-118.0111_-5",
    "area_33.7538_-118.0111_five",
    "area_91.0000_-118.0111_5",
    "area_33.7538_-181.0000_5",
    "area_1e2_-118.0111_5",
    "area_33.7538_-118.0111_5; drop",
    "%E0%A4%A",
  ]) {
    assert.equal(parseReportId(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("radius is clamped to the /scan slider range", () => {
  assert.equal(parseReportId("area_33.7538_-118.0111_0")?.radius_mi, REPORT_RADIUS_MIN);
  assert.equal(parseReportId("area_33.7538_-118.0111_250")?.radius_mi, REPORT_RADIUS_MAX);
  assert.equal(parseReportId("area_33.7538_-118.0111_4.6")?.radius_mi, 5);
  assert.equal(reportIdFor(33.7538, -118.0111, 0.2), "area_33.7538_-118.0111_1");
  assert.equal(reportIdFor(33.7538, -118.0111, 99), "area_33.7538_-118.0111_30");
  assert.equal(reportIdFor(33.7538, -118.0111, Number.NaN), "area_33.7538_-118.0111_1");
});
