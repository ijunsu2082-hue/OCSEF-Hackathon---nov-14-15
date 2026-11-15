import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalog,
  detectFields,
  detectFormId,
  extractFormDocument,
  formSources,
  mergeFormEntry,
  readableText,
  seedFor,
} from "../research/etl/compliance/forms";
import {
  assetFieldValue,
  isAssetFieldKey,
  resolveWorksheet,
  worksheetCoverage,
  type ExtractedForm,
} from "../lib/owner/forms";
import type { Obligation, OwnedAsset } from "../lib/owner/types";

/* ------------------------------------------------------------ fixtures */

const RULE = {
  id: "eia-923",
  title: "Annual power plant operations report",
  agency: "U.S. Energy Information Administration (EIA)",
  form: "Form EIA-923",
  formUrl: "https://www.eia.gov/survey/form/eia_923/instructions.pdf",
  dueRule: "By the last day of February for the prior year",
};

const RULE_PAGE = `<html><head><title>Form EIA-923, Power Plant Operations Report</title>
<style>body{color:red}</style></head><body>
<h1>Form EIA-923</h1>
<p>The report is due no later than the last day of February following the reporting year.</p>
<table><tr><th>Plant name</th><th>Plant ID</th><th>County</th><th>Nameplate capacity (MW)</th></tr></table>
<p>The designated representative must sign this certification.</p>
</body></html>`;

const plant: OwnedAsset = {
  kind: "plant",
  plant: {
    plant_code: 335,
    plant_name: "Huntington Beach",
    utility_name: "AES Alamitos LLC",
    city: "Huntington Beach",
    county: "Orange",
    nameplate_mw: 450,
    mw_by_source: { natural_gas: 450 },
    primary_source: "natural_gas",
    technologies: ["Combined Cycle"],
    oldest_year: 1970,
    newest_year: 2003,
    capacity_weighted_year: 1990,
    capacity_weighted_age_years: 36,
    planned_retirement_mw: 0,
    generator_count: 4,
    grid_voltage_kv: 230,
    lat: 33.6583,
    lon: -118.0008,
  },
};

const obligation: Obligation = {
  id: RULE.id,
  title: RULE.title,
  agency: RULE.agency,
  form: RULE.form,
  formUrl: RULE.formUrl,
  appliesBecause: "450 MW natural gas plant in Orange County",
  frequency: "annual",
  dueRule: RULE.dueRule,
  citations: [],
  prefill: [],
  confidence: "verified",
};

/* ------------------------------------------------------------ extraction */

test("HTML is read as text without scripts, styles or tags", () => {
  const text = readableText(RULE_PAGE);
  assert.match(text, /Form EIA-923/);
  assert.ok(!text.includes("<h1>"));
  assert.ok(!text.includes("color:red"));
  assert.match(text, /Plant name/);
});

test("the form designation, deadline and signature requirement are read from the page", () => {
  const extraction = extractFormDocument({ url: RULE.formUrl, body: RULE_PAGE, rule: RULE });
  assert.equal(extraction.formId, "Form EIA-923");
  assert.match(extraction.dueText ?? "", /no later than the last day of February/i);
  assert.equal(extraction.action, "sign");
  assert.ok(extraction.evidence.length >= 2);
  assert.ok(extraction.evidence.every((e) => e.url === RULE.formUrl));
});

test("only field labels that appear on the page are detected", () => {
  const extraction = extractFormDocument({ url: RULE.formUrl, body: RULE_PAGE, rule: RULE });
  const labels = extraction.fields.map((f) => f.label);
  assert.ok(labels.includes("Plant name"));
  assert.ok(labels.includes("County"));
  assert.ok(labels.includes("Rated capacity (MW)"));
  // Never seen on this page, so it is not claimed:
  assert.ok(!labels.includes("Latitude"));
  assert.ok(!labels.includes("Line length (mi)"));
});

test("a page without any of the words yields no field claims", () => {
  const extraction = extractFormDocument({
    url: "https://example.gov/blank",
    body: "<html><body><p>Nothing about a filing lives here.</p></body></html>",
    rule: RULE,
  });
  assert.equal(extraction.fields.length, 0);
  assert.equal(extraction.dueText, null);
  assert.ok(extraction.gaps.length >= 2);
});

test("detectFormId falls back to a designation printed on the page", () => {
  assert.equal(
    detectFormId("Please file Form EIA-861 with us.", { ...RULE, form: "Calendar" }),
    "Form EIA-861",
  );
});

test("detectFields maps an agency's wording to the public-data property it fills", () => {
  const fields = detectFields("Facility name: ____  Plant code: ____  Latitude: ____");
  const byLabel = new Map(fields.map((f) => [f.label, f.key]));
  assert.equal(byLabel.get("Plant name"), "plant_name");
  assert.equal(byLabel.get("Plant ID (EIA plant code)"), "plant_code");
  assert.equal(byLabel.get("Latitude"), "latitude");
});

/* ------------------------------------------------------------ catalog */

test("an unreadable page is recorded as manual with its link, never as extracted", () => {
  const entry = mergeFormEntry({
    rule: RULE,
    extraction: null,
    retrievedAt: null,
    sha256: null,
    unreachable: "The agency publishes this form as a PDF.",
  });
  assert.equal(entry.status, "manual");
  assert.equal(entry.formUrl, RULE.formUrl);
  assert.ok(entry.evidence[0].excerpt.includes("PDF"));
  // The seed still says what this family of filing asks for.
  assert.ok(entry.fields.some((f) => f.key === "plant_code"));
});

test("a read page is extracted, and the page's own deadline wins over the seed", () => {
  const extraction = extractFormDocument({ url: RULE.formUrl, body: RULE_PAGE, rule: RULE });
  const entry = mergeFormEntry({
    rule: RULE,
    extraction,
    retrievedAt: "2026-11-15T00:00:00.000Z",
    sha256: "abc",
  });
  assert.equal(entry.status, "extracted");
  assert.equal(entry.form, "Form EIA-923");
  assert.match(entry.dueText ?? "", /last day of February/i);
  assert.equal(entry.action, "sign");
  assert.equal(entry.jurisdiction, "United States (federal)");
});

test("the catalog is keyed by rule id and names its own schema", () => {
  const entry = mergeFormEntry({ rule: RULE, extraction: null, retrievedAt: null, sha256: null });
  const catalog = buildCatalog([entry], "2026-11-15T00:00:00.000Z");
  assert.equal(catalog.schema, "compliance-forms/1");
  assert.equal(catalog.entries["eia-923"].ruleId, "eia-923");
});

test("sources are one per rule and point at the agency's page", () => {
  const rules = {
    "eia-923": RULE,
    "eia-860": { ...RULE, id: "eia-860", formUrl: "https://www.eia.gov/survey/form/eia_860/instructions.pdf" },
  };
  const sources = formSources(rules);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].rule.id, "eia-860");
  assert.equal(sources[1].url, RULE.formUrl);
});

test("a state rule is scoped to its jurisdiction", () => {
  assert.match(seedFor({ ...RULE, id: "cec-qfer-quarterly" }).jurisdiction, /California/);
  assert.match(seedFor({ ...RULE, id: "scaqmd-aer" }).jurisdiction, /South Coast AQMD/);
});

/* ------------------------------------------------------------ prefill */

test("public data fills the fields it carries and leaves the rest to a person", () => {
  const form: ExtractedForm = mergeFormEntry({
    rule: RULE,
    extraction: extractFormDocument({ url: RULE.formUrl, body: RULE_PAGE, rule: RULE }),
    retrievedAt: "2026-11-15T00:00:00.000Z",
    sha256: null,
  });
  const catalog = buildCatalog([form], "2026-11-15T00:00:00.000Z");
  const worksheet = resolveWorksheet(plant, obligation, catalog);

  const filled = new Map(worksheet.prefilled.map((f) => [f.label, f.value]));
  assert.equal(filled.get("Plant name"), "Huntington Beach");
  assert.equal(filled.get("Plant ID (EIA plant code)"), "335");
  assert.equal(filled.get("County"), "Orange");
  assert.equal(filled.get("Rated capacity (MW)"), "450 MW");

  // Nothing in public data supplies these, so the person must.
  assert.ok(worksheet.awaiting.some((label) => /signature|designated representative/i.test(label)));
  assert.ok(worksheet.prefilled.every((f) => f.value && f.source));

  const totals = worksheetCoverage([worksheet]);
  assert.equal(totals.forms, 1);
  assert.ok(totals.filled > 0);
  assert.ok(totals.manual > 0);
});

test("without a catalog entry the worksheet is honest about it", () => {
  const worksheet = resolveWorksheet(plant, obligation, null);
  assert.equal(worksheet.form, null);
  assert.ok(worksheet.awaiting.some((label) => /not been extracted/i.test(label)));
  assert.ok(worksheet.prefilled.length > 0);
});

test("asset field values never return a made-up string", () => {
  assert.equal(assetFieldValue(plant, "plant_code")?.value, "335");
  assert.equal(assetFieldValue(plant, "county")?.value, "Orange");
  assert.equal(assetFieldValue(plant, "osm_id"), null);
  assert.equal(isAssetFieldKey("plant_code"), true);
  assert.equal(isAssetFieldKey("not_a_key"), false);
});
