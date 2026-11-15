import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crossReference,
  deriveStatus,
  parseFires,
  parseNri,
  parsePerimeters,
  parseQuakes,
  parseSvi,
  type HazardFire,
  type HazardQuake,
  type HazardsNri,
} from "../lib/live/hazards";

// No network in these tests: every upstream call is a fixture below.
globalThis.fetch = (async () => {
  throw new Error("test: no network");
}) as typeof fetch;

const LAT = 33.7538;
const LON = -118.0111;
const NOW = Date.parse("2026-11-14T20:00:00Z");

/* ---------------------------------------------------------------- fixtures */

/** Shape of a WFIGS_Incident_Locations_Current query (f=json, outSR=4326). */
const WFIGS_JSON = {
  features: [
    {
      attributes: {
        OBJECTID: 1,
        UniqueFireIdentifier: "2026-CALAC-000001",
        IncidentName: "NEAR",
        IncidentSize: 120.5,
        PercentContained: 40,
        FireDiscoveryDateTime: Date.parse("2026-11-13T10:00:00Z"),
        ModifiedOnDateTime_dt: Date.parse("2026-11-14T18:00:00Z"),
        IncidentTypeCategory: "WF",
      },
      geometry: { x: -118.0111, y: 33.9 }, // ~10 mi north
    },
    {
      attributes: { OBJECTID: 2, IncidentName: "BURN PILES RX", IncidentTypeCategory: "RX" },
      geometry: { x: -118.0, y: 33.76 },
    },
    {
      attributes: { OBJECTID: 3, IncidentName: "FAR", IncidentSize: null, PercentContained: null, IncidentTypeCategory: "WF" },
      geometry: { x: -116.0, y: 36.0 }, // ~200 mi away
    },
    {
      attributes: { OBJECTID: 4, IrwinID: "{ABC}", IncidentName: "", IncidentTypeCategory: "CX" },
      geometry: { x: -118.0111, y: 34.15 }, // ~27 mi
    },
    { attributes: { OBJECTID: 5, IncidentName: "NO GEOMETRY" } },
  ],
};

const PERIM_GEOJSON = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[-118, 33.9], [-117.99, 33.9], [-117.99, 33.91], [-118, 33.9]]] },
      properties: {
        poly_IncidentName: "NEAR",
        attr_IncidentSize: 120.5,
        attr_PercentContained: 40,
        attr_IncidentTypeCategory: "WF",
        attr_UniqueFireIdentifier: "2026-CALAC-000001",
      },
    },
    {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[-118, 33.7], [-117.99, 33.7], [-117.99, 33.71], [-118, 33.7]]] },
      properties: { poly_IncidentName: "RX UNIT", attr_IncidentTypeCategory: "RX" },
    },
    { type: "Feature", geometry: null, properties: { poly_IncidentName: "EMPTY" } },
  ],
};

/** Shape of a USGS FDSN / summary GeoJSON response. */
const USGS_GEOJSON = {
  metadata: { generated: NOW - 60_000 },
  features: [
    {
      id: "ci1",
      properties: { mag: 3.1, place: "5 km S of Somewhere, CA", time: NOW - 2 * 86_400_000, alert: null, url: "https://earthquake.usgs.gov/earthquakes/eventpage/ci1" },
      geometry: { coordinates: [-118.0, 33.6, 8.0] },
    },
    {
      id: "ci2",
      properties: { mag: 4.6, place: "Offshore", time: NOW - 3_600_000, alert: "green", url: "https://earthquake.usgs.gov/earthquakes/eventpage/ci2" },
      geometry: { coordinates: [-118.5, 33.5, 10.0] },
    },
    {
      id: "old",
      properties: { mag: 5.0, place: "Too old", time: NOW - 9 * 86_400_000 },
      geometry: { coordinates: [-118.0, 33.7, 5.0] },
    },
    {
      id: "far",
      properties: { mag: 5.0, place: "Too far", time: NOW - 3_600_000 },
      geometry: { coordinates: [-110.0, 40.0, 5.0] },
    },
    {
      id: "tiny",
      properties: { mag: 1.2, place: "Too small", time: NOW - 3_600_000 },
      geometry: { coordinates: [-118.0, 33.75, 5.0] },
    },
  ],
};

/** Shape of the FEMA NRI census tract point query (f=json). */
const NRI_JSON = {
  features: [
    {
      attributes: {
        NRI_ID: "T06059099601",
        STATE: "California",
        COUNTY: "Orange",
        COUNTYTYPE: "County",
        TRACT: "099601",
        RISK_SCORE: 92.85,
        RISK_RATNG: "Relatively High",
        EAL_VALT: 4543932.5,
        WFIR_RISKS: 55.5,
        WFIR_RISKR: "Very Low",
        HWAV_RISKS: 32.9,
        HWAV_RISKR: "Relatively Low",
        SWND_RISKS: 10.8,
        SWND_RISKR: "Very Low",
        ISTM_RISKS: null,
        ISTM_RISKR: "Not Applicable",
        WNTW_RISKS: 0,
        WNTW_RISKR: "No Rating",
        HRCN_RISKS: 0,
        HRCN_RISKR: "No Rating",
        ERQK_RISKS: 98.6,
        ERQK_RISKR: "Very High",
        IFLD_RISKS: 48.6,
        IFLD_RISKR: "Relatively Moderate",
      },
    },
  ],
};

/** Shape of the CDC SVI 2022 tract point query (f=json). */
const SVI_JSON = {
  features: [
    {
      attributes: {
        FIPS: "06059099601",
        LOCATION: "Census Tract 996.01; Orange County; California",
        RPL_THEMES: 0.854,
        RPL_THEME1: 0.8759,
        RPL_THEME2: -999,
        RPL_THEME3: 0.8592,
        RPL_THEME4: 0.7418,
      },
    },
  ],
};

/* ---------------------------------------------------------------- parsing */

test("parseFires keeps wildfires inside the radius, drops RX and missing geometry, sorts by distance", () => {
  const fires = parseFires(WFIGS_JSON, LAT, LON, 100);
  assert.deepEqual(
    fires.map((f) => f.name),
    ["NEAR", "Unnamed fire"],
  );
  const near = fires[0];
  assert.equal(near.id, "2026-CALAC-000001");
  assert.equal(near.acres, 120.5);
  assert.equal(near.containedPct, 40);
  assert.equal(near.discovered, "2026-11-13T10:00:00.000Z");
  assert.equal(near.updated, "2026-11-14T18:00:00.000Z");
  assert.ok(near.distanceMi > 9.5 && near.distanceMi < 10.5, `distance ${near.distanceMi}`);
  assert.equal(fires[1].id, "{ABC}", "falls back to IrwinID");
  assert.ok(fires[1].distanceMi > fires[0].distanceMi);
});

test("parseFires distance filter: a 20 mi radius drops the 27 mi fire", () => {
  const fires = parseFires(WFIGS_JSON, LAT, LON, 20);
  assert.deepEqual(
    fires.map((f) => f.name),
    ["NEAR"],
  );
  assert.deepEqual(parseFires({}, LAT, LON, 100), []);
  assert.deepEqual(parseFires(null, LAT, LON, 100), []);
});

test("parsePerimeters keeps simplified wildfire polygons with plain properties", () => {
  const fc = parsePerimeters(PERIM_GEOJSON);
  assert.ok(fc);
  assert.equal(fc.features.length, 1);
  assert.deepEqual(fc.features[0].properties, { id: "2026-CALAC-000001", name: "NEAR", acres: 120.5, containedPct: 40 });
  assert.equal(parsePerimeters({ error: "x" }), null);
});

test("parseQuakes filters by radius, 7 days and minimum magnitude; newest first", () => {
  const quakes = parseQuakes(USGS_GEOJSON, LAT, LON, 100, NOW);
  assert.deepEqual(
    quakes.map((q) => q.id),
    ["ci2", "ci1"],
  );
  assert.equal(quakes[0].alert, "green");
  assert.equal(quakes[1].alert, null);
  assert.equal(quakes[0].mag, 4.6);
  assert.equal(quakes[1].time, new Date(NOW - 2 * 86_400_000).toISOString());
  assert.ok(quakes[1].distanceMi > 10 && quakes[1].distanceMi < 12, `distance ${quakes[1].distanceMi}`);
  // A tighter radius drops the offshore quake (~33 mi away).
  assert.deepEqual(
    parseQuakes(USGS_GEOJSON, LAT, LON, 20, NOW).map((q) => q.id),
    ["ci1"],
  );
});

test("parseNri maps tract name, overall risk and grid-relevant hazard ratings", () => {
  const nri = parseNri(NRI_JSON, "tract");
  assert.ok(nri);
  assert.equal(nri.scope, "tract");
  assert.equal(nri.name, "Census tract 099601, Orange County, California");
  assert.equal(nri.riskScore, 92.85);
  assert.equal(nri.riskRating, "Relatively High");
  assert.equal(nri.eal, 4543932.5);
  assert.equal(nri.hazards.length, 8);
  const by = Object.fromEntries(nri.hazards.map((h) => [h.name, h]));
  assert.deepEqual(by["Wildfire"], { name: "Wildfire", rating: "Very Low", score: 55.5 });
  assert.deepEqual(by["Ice storm"], { name: "Ice storm", rating: "Not Applicable", score: null });
  assert.equal(by["Earthquake"].rating, "Very High");
  assert.equal(by["Riverine (inland) flooding"].score, 48.6);
  assert.equal(parseNri({ features: [] }, "tract"), null);
  const county = parseNri({ features: [{ attributes: { STATE: "Oregon", COUNTY: "Umatilla", COUNTYTYPE: "County" } }] }, "county");
  assert.equal(county?.name, "Umatilla County, Oregon");
  assert.equal(county?.riskScore, null);
});

test("parseSvi converts 0-1 ranks to percentiles and -999 to null", () => {
  const svi = parseSvi(SVI_JSON);
  assert.ok(svi);
  assert.equal(svi.tract, "Census Tract 996.01, Orange County, California");
  assert.equal(svi.overallPct, 85.4);
  assert.deepEqual(
    svi.themes.map((t) => t.pct),
    [87.6, null, 85.9, 74.2],
  );
  assert.equal(parseSvi({ features: [] }), null);
});

/* ---------------------------------------------------------------- cross-reference */

function nriWith(wildfire: string, wfScore: number | null, quake: string, eqScore: number | null): HazardsNri {
  const base = parseNri(NRI_JSON, "tract")!;
  return {
    ...base,
    hazards: base.hazards.map((h) =>
      h.name === "Wildfire"
        ? { ...h, rating: wildfire, score: wfScore }
        : h.name === "Earthquake"
          ? { ...h, rating: quake, score: eqScore }
          : h,
    ),
  };
}

const fire = (name: string, distanceMi: number): HazardFire => ({
  id: name,
  name,
  lat: 0,
  lon: 0,
  acres: null,
  containedPct: null,
  discovered: null,
  updated: null,
  distanceMi,
});
const quake = (mag: number): HazardQuake => ({
  id: `q${mag}`,
  mag,
  place: "x",
  time: new Date(NOW).toISOString(),
  lat: 0,
  lon: 0,
  distanceMi: 10,
  alert: null,
  url: "",
});

test("cross-reference: nearby fire under an elevated wildfire rating is consistent", () => {
  const { checks, summary } = crossReference([fire("Ridge", 12)], [], nriWith("Relatively High", 91.2, "Very High", 98), 100);
  const wf = checks[0];
  assert.equal(wf.a.provider, "NIFC");
  assert.equal(wf.a.value, 1);
  assert.equal(wf.b.provider, "FEMA NRI (tract)");
  assert.equal(wf.b.value, 91.2);
  assert.equal(wf.diff, Math.round((1 - 91.2) * 10) / 10);
  assert.equal(wf.diffPct, null);
  assert.equal(wf.agree, true);
  assert.match(wf.note ?? "", /Active fire 12 mi away \(Ridge\); FEMA wildfire risk uses the higher tract rating \(county rating not available; tract Relatively High\)/);
  assert.equal(summary[0], wf.note);
});

test("cross-reference: nearby fire under a Very Low rating is flagged; fires only beyond 25 mi are not", () => {
  const low = nriWith("Very Low", 20, "Very High", 98);
  assert.equal(crossReference([fire("A", 8)], [], low, 100).checks[0].agree, false);
  const far = crossReference([fire("B", 60)], [], low, 100).checks[0];
  assert.equal(far.agree, true);
  assert.equal(far.a.value, 0);
  assert.match(far.note ?? "", /nearest 60 mi away/);
  const none = crossReference([], [], nriWith("No Rating", 0, "Very High", 98), 50).checks[0];
  assert.equal(none.agree, true);
  assert.match(none.note ?? "", /tract unrated/);
});

/** County-level NRI with only a wildfire rating set. */
function county(rating: string, score: number | null): HazardsNri {
  return {
    scope: "county",
    name: "Orange County, California",
    riskScore: null,
    riskRating: null,
    eal: null,
    hazards: [{ name: "Wildfire", rating, score }],
  };
}

test("wildfire cross-check uses the HIGHER of tract and county ratings and says which", () => {
  const tractLow = nriWith("Very Low", 20, "Very High", 98);
  // Urban tract Very Low, county Relatively Moderate, fire 15 mi away: consistent via the county.
  const viaCounty = crossReference([fire("North Cayuse", 15)], [], tractLow, 50, county("Relatively Moderate", 96.2)).checks[0];
  assert.equal(viaCounty.agree, true);
  assert.equal(viaCounty.b.provider, "FEMA NRI (county)");
  assert.equal(viaCounty.b.value, 96.2);
  assert.match(viaCounty.note ?? "", /higher county rating \(county rating Relatively Moderate; tract Very Low\)/);
  // Tract higher than county: the tract is used.
  const viaTract = crossReference([fire("A", 5)], [], nriWith("Relatively High", 90, "Very High", 98), 50, county("Relatively Low", 40)).checks[0];
  assert.equal(viaTract.b.provider, "FEMA NRI (tract)");
  assert.equal(viaTract.agree, true);
  // Fire near, both Very Low / unrated: flagged.
  const bothLow = crossReference([fire("A", 5)], [], tractLow, 50, county("No Rating", 0)).checks[0];
  assert.equal(bothLow.agree, false);
  assert.match(bothLow.note ?? "", /county rating unrated; tract Very Low/);
  // No fire within 25 mi but county Very High: flagged as a consistency note.
  const quietHigh = crossReference([fire("Far", 40)], [], tractLow, 50, county("Very High", 99.5)).checks[0];
  assert.equal(quietHigh.agree, false);
  assert.equal(quietHigh.a.value, 0);
  assert.match(quietHigh.note ?? "", /No active fire within 25 mi \(nearest 40 mi away\)/);
  // No fire near and county only Relatively High: no conflict.
  assert.equal(crossReference([], [], tractLow, 50, county("Relatively High", 90)).checks[0].agree, true);
  // County only (tract missing) still produces the wildfire check.
  const countyOnly = crossReference([fire("A", 3)], null, null, 50, county("Relatively High", 90));
  assert.equal(countyOnly.checks.length, 1);
  assert.equal(countyOnly.checks[0].agree, true);
});

test("cross-reference: quakes vs NRI earthquake rating", () => {
  const high = crossReference([], [quake(2.4), quake(3.0)], nriWith("Very Low", 1, "Very High", 98.6), 100).checks[1];
  assert.equal(high.a.value, 2);
  assert.equal(high.b.value, 98.6);
  assert.equal(high.agree, true);
  assert.match(high.note ?? "", /largest M3\.0/);
  // Small quakes under a low rating: still consistent. An M4+ under a low rating: flagged.
  const lowSmall = crossReference([], [quake(2.2)], nriWith("Very Low", 1, "Relatively Low", 30), 100).checks[1];
  assert.equal(lowSmall.agree, true);
  const lowBig = crossReference([], [quake(4.5)], nriWith("Very Low", 1, "Relatively Low", 30), 100).checks[1];
  assert.equal(lowBig.agree, false);
});

test("cross-reference is skipped for a provider that failed or when NRI is missing", () => {
  const nri = nriWith("Very High", 99, "Very High", 99);
  assert.equal(crossReference(null, [quake(3)], nri, 50).checks.length, 1);
  assert.equal(crossReference([fire("A", 1)], null, nri, 50).checks.length, 1);
  assert.deepEqual(crossReference([fire("A", 1)], [quake(3)], null, 50), { checks: [], summary: [] });
});

/* ---------------------------------------------------------------- status */

test("deriveStatus: USGS sets live (30 min), NIFC only goes stale after 6 h, sourceUpdatedAt is the newest", () => {
  const all = { nifc: true, usgs: true, nri: true, svi: true };
  // NIFC unchanged for 45 min (normal at quiet hours) with a fresh USGS feed: live.
  const quietNifc = deriveStatus(all, NOW - 45 * 60_000, NOW - 60_000, NOW);
  assert.equal(quietNifc.status, "live");
  assert.equal(quietNifc.sourceUpdatedAt, new Date(NOW - 60_000).toISOString(), "newest of the two stamps");
  // Unknown NIFC edit time does not by itself make it stale.
  assert.equal(deriveStatus(all, null, NOW - 60_000, NOW).status, "live");
  // NIFC older than 6 h: stale.
  assert.equal(deriveStatus(all, NOW - 7 * 3600_000, NOW - 60_000, NOW).status, "stale");
  // USGS feed older than 30 min: stale.
  assert.equal(deriveStatus(all, NOW - 60_000, NOW - 31 * 60_000, NOW).status, "stale");
  // One of NIFC/USGS missing: stale.
  assert.equal(deriveStatus({ ...all, usgs: false }, NOW - 60_000, null, NOW).status, "stale");
  assert.equal(deriveStatus({ ...all, nifc: false }, null, NOW - 60_000, NOW).status, "stale");
  assert.equal(deriveStatus({ nifc: false, usgs: false, nri: false, svi: true }, null, null, NOW).status, "stale");
  const dead = deriveStatus({ nifc: false, usgs: false, nri: false, svi: false }, null, null, NOW);
  assert.equal(dead.status, "error");
  assert.equal(dead.sourceUpdatedAt, null);
});
