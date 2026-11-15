import { test } from "node:test";
import assert from "node:assert/strict";
import { recordFor } from "../research/etl/compliance/assets";
import { buildLegalSources } from "../research/etl/compliance/sources";
import { APPLICABILITY_SCHEMA, type ProgramIndex } from "../lib/owner/applicability";
import type { FormCatalog } from "../lib/owner/forms";
import { RULES } from "../lib/owner/rules";
import type { OwnedAsset } from "../lib/owner/types";
import type { Plant } from "../lib/scan/types";

/* ------------------------------------------------------------- fixtures */

function plant(over: Partial<Plant>): Plant {
  return {
    plant_code: 60698,
    plant_name: "Stanton Energy Reliability Center Hybrid",
    utility_name: "Wellhead Services, Inc.",
    city: "Stanton",
    county: "Orange",
    nameplate_mw: 161,
    mw_by_source: { natural_gas: 120, battery: 41 },
    primary_source: "natural_gas",
    technologies: ["Natural Gas Fired Combined Cycle"],
    oldest_year: 2020,
    newest_year: 2021,
    capacity_weighted_year: 2020,
    capacity_weighted_age_years: 6,
    planned_retirement_mw: 0,
    generator_count: 4,
    grid_voltage_kv: 66,
    lat: 33.8068,
    lon: -117.98576,
    ...over,
  };
}

const stanton: OwnedAsset = { kind: "plant", plant: plant({}) };
const pou: OwnedAsset = {
  kind: "plant",
  plant: plant({ plant_code: 99999, utility_name: "Los Angeles Department of Water & Power" }),
};

function index(over: Partial<ProgramIndex> = {}): ProgramIndex {
  return { schema: APPLICABILITY_SCHEMA, generated_at: "2026-11-15T20:00:00.000Z", ghgrp: {}, unavailable: [], ...over };
}

const catalog: FormCatalog = {
  schema: "compliance-forms/1",
  generated_at: "2026-11-15T19:36:54.252Z",
  entries: {
    "epa-ghgrp": {
      ruleId: "epa-ghgrp",
      form: "Form EPA 430-B",
      title: "Annual greenhouse gas report",
      agency: "U.S. Environmental Protection Agency (EPA)",
      jurisdiction: "United States (federal)",
      action: "sign",
      status: "partial",
      formUrl: "https://www.epa.gov/ghgreporting",
      sourceUrl: "https://www.epa.gov/ghgreporting/reporting-data",
      retrievedAt: "2026-11-15T19:36:54.252Z",
      sha256: null,
      dueText: "By March 31 for the prior year.",
      evidence: [{ url: "https://www.epa.gov/ghgreporting/reporting-data", excerpt: "Facility name and county." }],
      fields: [
        { label: "Facility name", key: "plant_name" },
        { label: "County", key: "county" },
        { label: "Reporting contact", key: null },
      ],
    },
  },
};

/* ------------------------------------------------------------- asset records */

test("a plant record carries the decision, its basis and the prefilled values", () => {
  const record = recordFor(stanton, index(), catalog);
  assert.equal(record.kind, "plant");
  assert.equal(record.id, "60698");
  assert.equal(record.owner, "Wellhead Services, Inc.");

  const ghg = record.filings.find((f) => f.id === "epa-ghgrp");
  assert.ok(ghg);
  assert.equal(ghg.status, "not_applicable", "the list was read and holds nothing nearby");
  assert.equal(ghg.question, undefined);
  assert.equal(ghg.prefill?.[0].label, "Facility name");
  assert.ok(ghg.manual?.includes("Reporting contact"));
  assert.ok(ghg.sources.length > 0, "instrument urls travel with the record");
});

test("a public-agency asset records rulings with reasons, and drops rules that never reach it", () => {
  const record = recordFor(pou, index(), catalog);
  const setAside = record.filings.filter((f) => f.status === "not_applicable");
  assert.ok(setAside.length > 0, "some filings are ruled out for this asset");
  for (const filing of setAside) {
    assert.equal(filing.question, undefined, "a ruling is not a question");
    assert.ok(filing.basis.length > 0, "every ruling carries a reason");
  }
  assert.equal(
    record.filings.some((f) => f.id.startsWith("go167c-")),
    false,
    "GO 167-C is never listed for a public-agency plant",
  );
});

test("a GHGRP match turns the greenhouse gas filing into applies", () => {
  const record = recordFor(
    stanton,
    index({
      ghgrp: {
        "60698": {
          facility_id: "1000517",
          facility_name: "Barre Generating Station",
          distance_mi: 0.15,
          year: null,
          co2e_tons: null,
        },
      },
    }),
    catalog,
  );
  assert.equal(record.filings.find((f) => f.id === "epa-ghgrp")?.status, "applies");
});

/* ------------------------------------------------------------- legal sources */

test("every rule gets its instruments and the page that was read", () => {
  const file = buildLegalSources(catalog, new Date("2026-11-15T21:00:00.000Z"));
  assert.equal(file.schema, "compliance-sources/1");
  assert.equal(file.summary.rules, Object.keys(RULES).length);

  const ghg = file.rules["epa-ghgrp"];
  assert.equal(ghg.agency, RULES["epa-ghgrp"].agency);
  assert.ok(ghg.instruments.length > 0);
  assert.ok(ghg.instruments.every((i) => i.url.startsWith("http")));
  assert.equal(ghg.pages[0].url, "https://www.epa.gov/ghgreporting/reporting-data");
  assert.equal(ghg.pages[0].status, "partial");
  assert.equal(ghg.pages[0].fields, 3);

  const withPage = Object.values(file.rules).filter((r) => r.pages.length > 0);
  assert.equal(file.summary.pages, withPage.length);
  assert.equal(file.summary.pages_read + file.summary.pages_unread, file.summary.pages);
});

test("a rule with no extracted form still lists its instruments", () => {
  const file = buildLegalSources(null, new Date("2026-11-15T21:00:00.000Z"));
  const anyRule = file.rules["epa-ghgrp"];
  assert.ok(anyRule.instruments.length > 0);
  assert.equal(anyRule.pages.length, 0);
  assert.equal(file.summary.pages, 0);
});
