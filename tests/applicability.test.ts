import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPLICABILITY_SCHEMA,
  applicableOnly,
  determine,
  determineAll,
  summarize,
  type FactAnswers,
  type ProgramIndex,
} from "../lib/owner/applicability";
import { previewObligations } from "../lib/owner/obligations";
import { RULES } from "../lib/owner/rules";
import type { Obligation, OwnedAsset } from "../lib/owner/types";
import type { Plant } from "../lib/scan/types";

/* ------------------------------------------------------------- fixtures */

function plant(over: Partial<Plant>): Plant {
  return {
    plant_code: 99001,
    plant_name: "Test Plant",
    utility_name: "Test Generation LLC",
    city: "Long Beach",
    county: "Los Angeles",
    nameplate_mw: 547,
    mw_by_source: { natural_gas: 547 },
    primary_source: "natural_gas",
    technologies: ["Natural Gas Fired Combined Cycle"],
    oldest_year: 2003,
    newest_year: 2020,
    capacity_weighted_year: 2010,
    capacity_weighted_age_years: 16,
    planned_retirement_mw: 0,
    generator_count: 4,
    grid_voltage_kv: 230,
    lat: 33.77,
    lon: -118.19,
    ...over,
  };
}

const gasPlant: OwnedAsset = { kind: "plant", plant: plant({}) };
const kernSolar: OwnedAsset = {
  kind: "plant",
  plant: plant({
    plant_code: 99002,
    nameplate_mw: 60,
    mw_by_source: { solar: 60 },
    primary_source: "solar",
    technologies: ["Solar Photovoltaic"],
    county: "Kern",
    city: "Bakersfield",
    generator_count: 1,
    lat: 35.37,
    lon: -119.02,
  }),
};
const pouPlant: OwnedAsset = {
  kind: "plant",
  plant: plant({ plant_code: 99005, utility_name: "Los Angeles Department of Water & Power" }),
};

function emptyIndex(over: Partial<ProgramIndex> = {}): ProgramIndex {
  return { schema: APPLICABILITY_SCHEMA, generated_at: "2026-11-01T00:00:00.000Z", ghgrp: {}, unavailable: [], ...over };
}

function listed(co2e: number): ProgramIndex {
  return emptyIndex({
    ghgrp: {
      "99001": {
        facility_id: "1000123",
        facility_name: "Test Generating Station",
        distance_mi: 0.12,
        year: 2024,
        co2e_tons: co2e,
      },
    },
  });
}

/** One rule as the engine would hand it to a screen, without the asset's prefill. */
function rule(id: string): Obligation {
  const r = RULES[id];
  assert.ok(r, `expected rule ${id}`);
  return {
    id: r.id,
    title: r.title,
    agency: r.agency,
    form: r.form,
    formUrl: r.formUrl,
    appliesBecause: r.notes ?? r.title,
    frequency: r.frequency,
    dueRule: r.dueRule,
    citations: r.citations,
    prefill: [],
    confidence: "check",
  };
}

/** The decision does not depend on the asset for these fixtures beyond its own facts. */
const obligation = (_asset: OwnedAsset, id: string): Obligation => rule(id);

/* ------------------------------------------------------------- EPA GHGRP */

test("a GHGRP match decides the greenhouse gas filing", () => {
  const d = determine(gasPlant, obligation(gasPlant, "epa-ghgrp"), listed(412_000), {});
  assert.equal(d.applicability, "applies");
  assert.match(d.basis, /1000123/);
  assert.match(d.basis, /0\.12 mi/);
  assert.match(d.source ?? "", /Greenhouse Gas Reporting Program/);
  assert.equal(d.question, undefined);
});

test("the GHGRP list sets a plant aside when it was read and holds nothing nearby", () => {
  const d = determine(gasPlant, obligation(gasPlant, "epa-ghgrp"), emptyIndex(), {});
  assert.equal(d.applicability, "does_not_apply");
  // The claim names the county and the date, so it is about a list that was actually read.
  assert.match(d.basis, /Los Angeles County/);
  assert.match(d.basis, /Nov 1, 2026/);
});

test("a reporter nearby that could not be tied to the plant asks instead of denying", () => {
  const idx = emptyIndex({
    ghgrp_near: {
      "99001": { facility_id: "1000999", facility_name: "Harbor Cogen", distance_mi: 2.4 },
    },
  });
  const d = determine(gasPlant, obligation(gasPlant, "epa-ghgrp"), idx, {});
  assert.equal(d.applicability, "needs_fact");
  assert.equal(d.question?.id, "epa-ghgrp:nearby-facility");
  assert.match(d.question?.detail ?? "", /Harbor Cogen/);
  assert.match(d.question?.detail ?? "", /2\.4 mi/);
});

test("an unread GHGRP list leaves one question instead of guessing", () => {
  const d = determine(gasPlant, obligation(gasPlant, "epa-ghgrp"), emptyIndex({ unavailable: ["ghgrp"] }), {});
  assert.equal(d.applicability, "needs_fact");
  assert.equal(d.question?.id, "epa-ghgrp:in-program");
  assert.match(d.question?.question ?? "", /GHGRP/);
});

/* ------------------------------------------------------------- CARB */

test("CARB thresholds follow the reported emissions", () => {
  const reportOver = determine(gasPlant, obligation(gasPlant, "carb-mrr-report"), listed(31_400), {});
  assert.equal(reportOver.applicability, "applies");

  const reportUnder = determine(gasPlant, obligation(gasPlant, "carb-mrr-report"), listed(6_200), {});
  assert.equal(reportUnder.applicability, "does_not_apply");

  const verify = determine(gasPlant, obligation(gasPlant, "carb-mrr-verification"), listed(31_400), {});
  assert.equal(verify.applicability, "applies");

  const verifyUnder = determine(gasPlant, obligation(gasPlant, "carb-mrr-verification"), listed(12_000), {});
  assert.equal(verifyUnder.applicability, "needs_fact");
});

test("with no reported figure the CARB item asks for the annual total", () => {
  const d = determine(gasPlant, obligation(gasPlant, "carb-mrr-report"), emptyIndex(), {});
  assert.equal(d.applicability, "needs_fact");
  assert.equal(d.question?.id, "carb-mrr-report:annual-co2e");
});

/* ------------------------------------------------------------- location and size */

test("South Coast AQMD membership follows the county", () => {
  const inside = determine(gasPlant, obligation(gasPlant, "scaqmd-aer"), emptyIndex(), {});
  assert.equal(inside.applicability, "needs_fact");
  assert.equal(inside.question?.id, "scaqmd-aer:annual-emissions");

  const outside = determine(kernSolar, obligation(kernSolar, "scaqmd-aer"), emptyIndex(), {});
  assert.equal(outside.applicability, "does_not_apply");
  assert.match(outside.basis, /Kern County is outside/);
});

test("no planned retirement takes the monthly retirement update off the list", () => {
  const none = determine(gasPlant, obligation(gasPlant, "eia-860m"), emptyIndex(), {});
  assert.equal(none.applicability, "does_not_apply");

  const retiring: OwnedAsset = {
    kind: "plant",
    plant: plant({ planned_retirement_mw: 120 }),
  };
  const some = determine(retiring, obligation(retiring, "eia-860m"), emptyIndex(), {});
  assert.equal(some.applicability, "needs_fact");
  assert.equal(some.question?.id, "eia-860m:retirement-within-12-months");
});

test("a public-agency plant is outside GO 167-C", () => {
  const d = determine(pouPlant, obligation(pouPlant, "go167c-incident"), emptyIndex(), {});
  assert.equal(d.applicability, "does_not_apply");
  assert.match(d.basis, /public agency/);
});

test("a plant with no fossil capacity above 25 MW is outside the Acid Rain quarterly report", () => {
  const d = determine(kernSolar, obligation(kernSolar, "epa-part75-quarterly"), emptyIndex(), {});
  assert.equal(d.applicability, "does_not_apply");
});

/* ------------------------------------------------------------- answering */

test("an answer settles an undecided filing and is attributed to the owner", () => {
  const o = obligation(gasPlant, "scaqmd-aer");
  const answers: FactAnswers = { "scaqmd-aer:annual-emissions": { answer: "yes", at: "2026-11-14T00:00:00.000Z" } };
  const d = determine(gasPlant, o, emptyIndex(), answers);
  assert.equal(d.applicability, "applies");
  assert.match(d.basis, /You answered "yes"/);
  assert.match(d.source ?? "", /Your answer/);
});

test("a 'no' answer sets the filing aside", () => {
  const o = obligation(gasPlant, "scaqmd-aer");
  const answers: FactAnswers = { "scaqmd-aer:annual-emissions": { answer: "no", at: "2026-11-14T00:00:00.000Z" } };
  const d = determine(gasPlant, o, emptyIndex(), answers);
  assert.equal(d.applicability, "does_not_apply");
});

/* ------------------------------------------------------------- the set */

test("each filing gets one decision, and set-aside items leave the working list", () => {
  const asset: OwnedAsset = pouPlant;
  const all = previewObligations(asset);
  const decisions = determineAll(asset, all, emptyIndex(), {});
  assert.equal(Object.keys(decisions).length, all.length);
  for (const o of all) assert.ok(decisions[o.id], `${o.id} has a decision`);

  const kept = applicableOnly(all, decisions);
  assert.ok(kept.length < all.length, "some filings are set aside");
  for (const o of kept) assert.notEqual(decisions[o.id].applicability, "does_not_apply");

  const counts = summarize(all.map((o) => decisions[o.id]));
  assert.equal(counts.applies + counts.doesNotApply + counts.needsFact, all.length);
});
