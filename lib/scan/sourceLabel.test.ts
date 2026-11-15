import assert from "node:assert/strict";
import { test } from "node:test";
import type { EtlPlantFeature } from "../etlAssets";
import type { PlantFeature } from "../gridLayers";
import { gridDataSourceLabel, layerSourceLabel, plantTooltipHtml } from "./sourceLabel";

const REV = "abcd1234".padEnd(64, "0");

test("ETL label names the inventory revision and report binding", () => {
  assert.equal(layerSourceLabel({ source: "etl", revision: REV, reportRevision: "f".repeat(64) }),
    "ETL inventory rev abcd1234 (report-bound)");
  assert.equal(layerSourceLabel({ source: "etl", revision: REV }), "ETL inventory rev abcd1234");
  assert.equal(gridDataSourceLabel({
    source: "etl", etl: { revision: REV, report_revision: "f".repeat(64) },
    fallback_reasons: ["loaded plant dataset has no nameplate MW or fuel mix; bundled plants kept for scoring"],
  }), "ETL inventory rev abcd1234 (report-bound) · loaded plant dataset has no nameplate MW or fuel mix; bundled plants kept for scoring");
});

test("bundled label carries the fallback reason", () => {
  assert.equal(layerSourceLabel({ source: "bundled" }), "Bundled layers");
  assert.equal(gridDataSourceLabel({ source: "bundled", etl: null, fallback_reasons: ["loaded assets unavailable (404)"] }),
    "Bundled layers (fallback: loaded assets unavailable (404))");
});

test("ETL plant with null fields reads 'not reported by source', never 0 or NaN", () => {
  const plant: EtlPlantFeature = {
    geometry: { type: "Point", coordinates: [-118, 33.7] },
    properties: {
      plant_code: null, plant_name: null, utility_name: null, distance_mi: null, county: null, city: null,
      grid_voltage_kv: null, generator_count: null, nameplate_mw: null, mw_by_source: null, oldest_year: null,
      newest_year: null, planned_retirement_mw: null, primary_source: null, technologies: null,
      capacity_weighted_age_years: null,
    },
    etl: {
      source: "eia-atlas-plants", snapshot: "snp_x", revision: REV, location: "location-x", id: "p1",
      geometry_locator: "/features/0", citations: {},
    },
  };
  const html = plantTooltipHtml(plant);
  assert.match(html, /Plant name not reported by source/);
  assert.match(html, /nameplate MW not reported by source/);
  assert.match(html, /fuel not reported by source/);
  assert.match(html, /eia-atlas-plants/);
  assert.doesNotMatch(html, /NaN|null|undefined|\b0(\.0)? MW/);
});

test("bundled plant tooltip is unchanged", () => {
  const plant: PlantFeature = {
    geometry: { type: "Point", coordinates: [-118, 33.7] },
    properties: {
      plant_name: "Haynes", utility_name: "LADWP", nameplate_mw: 1730.2, mw_by_source: { natural_gas: 1730.2 },
      oldest_year: 1962, newest_year: 2013, planned_retirement_mw: 0, primary_source: "natural_gas",
      technologies: [], capacity_weighted_age_years: 20,
    },
  };
  assert.equal(plantTooltipHtml(plant),
    "<b>Haynes</b><br/>1730.2 MW · natural gas<br/>in service 1962–2013<br/><span class=\"tt-src\">EIA-860 2025</span>");
});
