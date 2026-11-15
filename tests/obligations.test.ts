import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOwner, deadlinesFor, inCalifornia, isFederalBusinessDay, obligationsFor, previewObligations } from "../lib/owner/obligations";
import { RULES } from "../lib/owner/rules";
import type { Obligation, OwnedAsset } from "../lib/owner/types";
import type { Line, Plant, Substation } from "../lib/scan/types";
import { readJson } from "./helpers";

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

const bigGas: OwnedAsset = { kind: "plant", plant: plant({}) };
const smallSolar: OwnedAsset = {
  kind: "plant",
  plant: plant({
    plant_code: 99002,
    nameplate_mw: 4.5,
    mw_by_source: { solar: 4.5 },
    primary_source: "solar",
    technologies: ["Solar Photovoltaic"],
    county: "Kern",
    city: "Bakersfield",
    generator_count: 1,
    lat: 35.37,
    lon: -119.02,
  }),
};
const tinySolar: OwnedAsset = {
  kind: "plant",
  plant: plant({ plant_code: 99003, nameplate_mw: 0.9, mw_by_source: { solar: 0.9 }, primary_source: "solar", technologies: ["Solar Photovoltaic"] }),
};
const bigBattery: OwnedAsset = {
  kind: "plant",
  plant: plant({ plant_code: 99004, nameplate_mw: 100, mw_by_source: { battery: 100 }, primary_source: "battery", technologies: ["Batteries"], county: "Riverside" }),
};
const pouGas: OwnedAsset = {
  kind: "plant",
  plant: plant({ plant_code: 99005, utility_name: "Los Angeles Department of Water & Power" }),
};

function sub(over: Partial<Substation>): Substation {
  return { osm_id: "way/1", name: "Test Substation", operator: "Southern California Edison", voltage_kv: 220, substation: "transmission", lat: 34.1, lon: -117.6, ...over };
}

function line(over: Partial<Line>): Line {
  return { osm_id: 42, voltage_kv: 230, operator: "San Diego Gas & Electric", name: "Test Line", circuits: "2", coords: [[32.8, -117.1], [32.9, -117.0]], ...over };
}

const ids = (os: Obligation[]) => os.map((o) => o.id);
const byId = (os: Obligation[], id: string) => os.find((o) => o.id === id);
const FROM = new Date("2026-11-14T00:00:00Z");

/* ------------------------------------------------------------- plants */

test("big gas plant in Los Angeles County gets EIA, CEC, EPA/CARB GHG, Part 75 and South Coast AQMD", () => {
  const os = obligationsFor(bigGas);
  for (const id of ["eia-860", "eia-923", "cec-qfer-quarterly", "cec-1304-environmental", "epa-ghgrp", "carb-mrr-report", "carb-mrr-verification", "epa-part75-quarterly", "scaqmd-aer", "go167c-maintenance-logbook", "nerc-gads-conventional", "ferc-eqr"]) {
    assert.ok(ids(os).includes(id), `missing ${id}`);
  }
  assert.equal(byId(os, "eia-860")!.confidence, "verified");
  assert.equal(byId(os, "eia-923")!.confidence, "verified");
  assert.equal(byId(os, "epa-ghgrp")!.confidence, "check");
  assert.equal(byId(os, "carb-mrr-report")!.confidence, "check");
  assert.equal(byId(os, "scaqmd-aer")!.confidence, "check");
  assert.match(byId(os, "eia-860")!.appliesBecause, /^547 MW natural gas plant in Los Angeles County/);
  assert.match(byId(os, "scaqmd-aer")!.appliesBecause, /South Coast AQMD/);
  assert.ok(!ids(os).includes("ferc-556"), "547 MW gas is not a small power production QF");
  assert.ok(!ids(os).includes("eia-860m"), "no planned retirements");
});

test("plant prefill carries the EIA identity and capacity fields", () => {
  const p = byId(obligationsFor(bigGas), "eia-860")!.prefill;
  const get = (label: string) => p.find((f) => f.label === label)?.value;
  assert.equal(get("EIA plant code"), "99001");
  assert.equal(get("Plant name"), "Test Plant");
  assert.equal(get("Operator (EIA utility name)"), "Test Generation LLC");
  assert.equal(get("County"), "Los Angeles");
  assert.equal(get("Latitude"), "33.77000");
  assert.equal(get("Nameplate capacity, natural gas"), "547 MW");
  assert.equal(get("Generators"), "4");
  assert.equal(get("Oldest generator in service since"), "2003");
  assert.ok(p.every((f) => f.source.length > 0));
});

test("Part 75 needs more than 25 MW of fossil capacity", () => {
  const small = obligationsFor({ kind: "plant", plant: plant({ nameplate_mw: 20, mw_by_source: { natural_gas: 20 } }) });
  assert.ok(!ids(small).includes("epa-part75-quarterly"));
  assert.ok(ids(small).includes("epa-ghgrp"));
});

test("plants outside South Coast counties get no AQMD report", () => {
  const os = obligationsFor({ kind: "plant", plant: plant({ county: "Kern" }) });
  assert.ok(!ids(os).includes("scaqmd-aer"));
});

test("small solar plant gets EIA forms and the annual CEC report, no GHG or air rules", () => {
  const os = obligationsFor(smallSolar);
  assert.ok(ids(os).includes("eia-860"));
  assert.ok(ids(os).includes("eia-923"));
  assert.ok(ids(os).includes("cec-qfer-annual"));
  assert.ok(!ids(os).includes("cec-qfer-quarterly"));
  for (const id of ["epa-ghgrp", "carb-mrr-report", "epa-part75-quarterly", "scaqmd-aer", "cec-1304-environmental", "nerc-gads-solar", "go167c-maintenance-logbook"]) {
    assert.ok(!ids(os).includes(id), `unexpected ${id}`);
  }
  assert.equal(byId(os, "ferc-556")!.confidence, "check");
});

test("plants under 1 MW are below the EIA, CEC, Form 556 and GO 167-C thresholds", () => {
  const os = obligationsFor(tinySolar);
  for (const id of ["eia-860", "eia-923", "cec-qfer-annual", "ferc-556", "go167c-incident"]) assert.ok(!ids(os).includes(id), `unexpected ${id}`);
});

test("battery storage gets GO 167-C standards at 50 MW but no combustion rules", () => {
  const os = obligationsFor(bigBattery);
  assert.ok(ids(os).includes("go167c-operation"));
  assert.ok(ids(os).includes("eia-860"));
  for (const id of ["epa-ghgrp", "carb-mrr-report", "scaqmd-aer", "ferc-556", "cec-1304-environmental"]) assert.ok(!ids(os).includes(id), `unexpected ${id}`);
});

test("plants owned by a city utility are outside GO 167-C", () => {
  const os = obligationsFor(pouGas);
  assert.ok(!ids(os).some((id) => id.startsWith("go167c")));
  assert.ok(ids(os).includes("eia-860"));
});

test("planned retirements add the monthly EIA-860M update", () => {
  const os = obligationsFor({ kind: "plant", plant: plant({ planned_retirement_mw: 200 }) });
  assert.equal(byId(os, "eia-860m")!.confidence, "check");
});

/* ------------------------------------------------------------- grid assets */

test("investor-owned substation gets utility obligations", () => {
  const os = obligationsFor({ kind: "substation", substation: sub({}) });
  assert.deepEqual(ids(os).sort(), ["eia-861", "ferc-form-1", "ferc-form-3q", "go174-annual", "oeis-wmp"]);
  assert.equal(byId(os, "eia-861")!.confidence, "verified");
  const p = byId(os, "eia-861")!.prefill;
  assert.equal(p.find((f) => f.label === "Operator")?.value, "Southern California Edison");
  assert.equal(p.find((f) => f.label === "Voltage")?.value, "220 kV");
  assert.equal(p.find((f) => f.label === "OpenStreetMap id")?.value, "way/1");
});

test("city-owned substation gets the WSAB plan, not FERC Form 1 or GO 174", () => {
  const os = obligationsFor({ kind: "substation", substation: sub({ operator: "Los Angeles Department of Water and Power" }) });
  assert.ok(ids(os).includes("wsab-wmp-ladwp"));
  assert.ok(!ids(os).includes("ferc-form-1"));
  assert.ok(!ids(os).includes("go174-annual"));
});

test("substation with no operator gets the same rules marked check", () => {
  const os = obligationsFor({ kind: "substation", substation: sub({ operator: null, name: null }) });
  assert.ok(os.length > 0);
  assert.ok(os.every((o) => o.confidence === "check"));
  assert.ok(!os[0].prefill.some((f) => f.label === "Substation name"));
});

test("assets outside California get nothing", () => {
  assert.deepEqual(obligationsFor({ kind: "substation", substation: sub({ lat: 32.48, lon: -116.95 }) }), []);
  assert.deepEqual(obligationsFor({ kind: "line", line: line({ coords: [[36.0, -115.1], [36.1, -115.0]] }) }), []);
  assert.equal(inCalifornia(33.83, -117.91), true);
  assert.equal(inCalifornia(35.8, -115.0), false);
});

test("investor-owned line gets GO 95 Rule 18, GO 165, Order 881 and utility filings, with its length", () => {
  const os = obligationsFor({ kind: "line", line: line({}) });
  for (const id of ["go95-rule18", "go165-transmission", "ferc-881-aar", "eia-861", "ferc-form-1", "oeis-wmp"]) assert.ok(ids(os).includes(id), `missing ${id}`);
  assert.equal(byId(os, "go95-rule18")!.confidence, "verified");
  assert.ok(byId(os, "go95-rule18")!.prefill.some((f) => f.label === "Length" && /mi$/.test(f.value)));
});

test("owner names normalize to utility kinds", () => {
  assert.equal(classifyOwner("SoCal Edison")?.kind, "iou");
  assert.equal(classifyOwner("San Deigo Gas and Electric")?.kind, "iou");
  assert.equal(classifyOwner("City of Burbank")?.pouKey, "burbank");
  assert.equal(classifyOwner("AES")?.kind, "other");
  assert.equal(classifyOwner(null), null);
});

/* ------------------------------------------------------------- deadlines */

test("deadlinesFor gives exact dates for the big gas plant from 2026-11-14 for 12 months", () => {
  const ds = deadlinesFor(obligationsFor(bigGas), FROM, 12);
  const has = (id: string, due: string) => assert.ok(ds.some((d) => d.obligationId === id && d.due === due), `missing ${id} ${due}`);
  has("eia-860", "2027-02-26"); // last business day of February 2027 (Feb 27-28 are a weekend)
  has("eia-923", "2027-02-18"); // 45 days after Jan 4, 2027 (first business day)
  has("eia-923-monthly", "2026-11-30");
  has("epa-ghgrp", "2027-03-10"); // reporting year 2025, EPA extension
  has("epa-ghgrp", "2027-03-31"); // reporting year 2026
  has("carb-mrr-report", "2027-04-10");
  has("carb-mrr-verification", "2027-08-10");
  has("scaqmd-aer", "2027-04-12"); // April 10, 2027 is a Saturday
  for (const d of ["2027-01-30", "2027-04-30", "2027-07-30", "2027-10-30"]) has("epa-part75-quarterly", d);
  for (const d of ["2026-11-15", "2027-02-15", "2027-05-15", "2027-08-15"]) has("cec-qfer-quarterly", d);
  has("ferc-eqr", "2027-02-01"); // Jan 31, 2027 is a Sunday
  has("ferc-eqr", "2027-08-02"); // Jul 31, 2027 is a Saturday
  has("ferc-eqr", "2027-11-01");
  has("go167c-maintenance-logbook", "2027-02-01");
  has("nerc-gads-conventional", "2026-11-14"); // both ends are included
  has("nerc-gads-conventional", "2027-11-14");
  assert.ok(!ds.some((d) => d.obligationId === "go167c-operation"), "Feb 1, 2028 is past the window");
  assert.ok(!ds.some((d) => d.obligationId === "go167c-incident"), "event rules have no dates");
  assert.ok(ds.every((d) => d.due >= "2026-11-14" && d.due <= "2027-11-14"));
  const sorted = [...ds].sort((a, b) => (a.due === b.due ? a.obligationId.localeCompare(b.obligationId) : a.due.localeCompare(b.due)));
  assert.deepEqual(ds, sorted);
  assert.equal(ds.find((d) => d.obligationId === "epa-ghgrp" && d.due === "2027-03-10")!.periodLabel, "Calendar year 2025");
  assert.equal(ds.find((d) => d.obligationId === "epa-part75-quarterly" && d.due === "2027-01-30")!.periodLabel, "Q4 2026");
});

test("deadlinesFor for utility assets", () => {
  const ds = deadlinesFor(obligationsFor({ kind: "substation", substation: sub({}) }), FROM, 12);
  assert.deepEqual(
    ds.map((d) => [d.obligationId, d.due]),
    [
      ["ferc-form-3q", "2026-11-30"], // Q3 2026: Nov 29 is a Sunday
      ["ferc-form-1", "2027-04-19"], // April 18, 2027 is a Sunday
      ["eia-861", "2027-04-30"],
      ["ferc-form-3q", "2027-06-01"], // Q1 2027: May 30 is a Sunday, May 31 is Memorial Day
      ["go174-annual", "2027-07-01"],
      ["ferc-form-3q", "2027-08-30"], // Q2 2027: Aug 29 is a Sunday
    ],
  );
  const anaheim = deadlinesFor(obligationsFor({ kind: "substation", substation: sub({ operator: "Anaheim Public Utilities" }) }), FROM, 36);
  assert.deepEqual(anaheim.filter((d) => d.obligationId === "wsab-wmp-anaheim").map((d) => d.due), ["2027-10-01", "2029-10-05"]);
  const sdge = deadlinesFor(obligationsFor({ kind: "line", line: line({}) }), FROM, 12);
  assert.ok(sdge.some((d) => d.obligationId === "ferc-881-aar" && d.due === "2027-10-15"));
});

test("EPA GHG report moves off weekends and federal holidays (40 CFR 98.3(b)(4))", () => {
  const due = (from: string) =>
    deadlinesFor(obligationsFor(bigGas), new Date(`${from}T00:00:00Z`), 12)
      .filter((d) => d.obligationId === "epa-ghgrp")
      .map((d) => [d.due, d.periodLabel]);
  assert.deepEqual(due("2029-01-01"), [["2029-04-02", "Calendar year 2028"]]); // March 31, 2029 is a Saturday
  assert.deepEqual(due("2030-01-01"), [["2030-04-01", "Calendar year 2029"]]); // March 31, 2030 is a Sunday
  assert.deepEqual(due("2027-01-01"), [["2027-03-10", "Calendar year 2025"], ["2027-03-31", "Calendar year 2026"]]);
  assert.match(RULES["epa-ghgrp"].dueRule, /next business day if a weekend or federal holiday/);
});

test("GADS cites GO 167-C 9.3.2 for California owners whether or not NERC-registered", () => {
  const wind = obligationsFor({ kind: "plant", plant: plant({ nameplate_mw: 100, mw_by_source: { wind: 100 }, primary_source: "wind", county: "Kern" }) });
  const solar = obligationsFor({ kind: "plant", plant: plant({ nameplate_mw: 50, mw_by_source: { solar: 50 }, primary_source: "solar", county: "Kern" }) });
  const conv = obligationsFor(bigGas);
  for (const o of [byId(wind, "nerc-gads-wind")!, byId(solar, "nerc-gads-solar")!, byId(conv, "nerc-gads-conventional")!]) {
    assert.ok(o.citations.some((c) => /General Order 167-C/.test(c.label)), `${o.id} cites GO 167-C`);
    assert.match(o.notes ?? "", /GO 167-C section 9\.3\.2 also requires covered generating asset and storage owners to submit the GADS data NERC accepts/);
    assert.match(o.notes ?? "", /NERC-registered/);
    assert.match(o.appliesBecause, /GO 167-C section 9\.3\.2/);
  }
  const pou = byId(obligationsFor(pouGas), "nerc-gads-conventional")!;
  assert.doesNotMatch(pou.appliesBecause, /9\.3\.2/);
  assert.match(pou.appliesBecause, /NERC-registered/);
});

test("Form 556 small power test uses total size and the 75% renewable share", () => {
  const qf = (over: Partial<Plant>) => ids(obligationsFor({ kind: "plant", plant: plant({ county: "Kern", ...over }) })).includes("ferc-556");
  // Edwards Sanborn E5-like: 115 MW in total, 68 MW solar plus storage: over 80 MW.
  assert.equal(qf({ nameplate_mw: 115, mw_by_source: { solar: 68, battery: 47 }, primary_source: "solar" }), false);
  // San Diego State University-like: 0.8 MW solar with 14.3 MW gas: renewable share far under 75%.
  assert.equal(qf({ nameplate_mw: 15.1, mw_by_source: { solar: 0.8, natural_gas: 14.3 }, primary_source: "natural_gas" }), false);
  // Solar plus storage within 80 MW: storage is left out of the share.
  assert.equal(qf({ nameplate_mw: 70, mw_by_source: { solar: 50, battery: 20 }, primary_source: "solar" }), true);
  // Landfill gas with a little natural gas, 80 MW exactly.
  assert.equal(qf({ nameplate_mw: 80, mw_by_source: { biogas: 64, natural_gas: 16 }, primary_source: "biogas" }), true);
  assert.equal(qf({ nameplate_mw: 80.5, mw_by_source: { solar: 80.5 }, primary_source: "solar" }), false);
  const o = byId(obligationsFor(smallSolar), "ferc-556")!;
  assert.match(o.appliesBecause, /4\.5 MW in total, within the 80 MW size limit/);
  assert.match(o.notes ?? "", /[Cc]ogeneration/);
  assert.ok(o.citations.some((c) => /292\.205/.test(c.label)));
});

test("December 31 is a federal holiday when New Year's Day falls on a Saturday", () => {
  assert.equal(isFederalBusinessDay("2027-12-31"), false); // Jan 1, 2028 is a Saturday
  assert.equal(isFederalBusinessDay("2027-12-30"), true);
  assert.equal(isFederalBusinessDay("2028-01-03"), true);
  assert.equal(isFederalBusinessDay("2022-12-26"), false); // Christmas on a Sunday, observed Monday
  assert.equal(isFederalBusinessDay("2026-11-26"), false); // Thanksgiving
});

test("FERC Form 3-Q: same scope as Form 1, due 60 days after Q1-Q3", () => {
  const sce = obligationsFor({ kind: "substation", substation: sub({}) });
  assert.equal(byId(sce, "ferc-form-3q")!.confidence, "check");
  assert.ok(ids(obligationsFor({ kind: "line", line: line({}) })).includes("ferc-form-3q"));
  assert.ok(!ids(obligationsFor({ kind: "substation", substation: sub({ operator: "Los Angeles Department of Water and Power" }) })).includes("ferc-form-3q"));
  const ds = deadlinesFor(sce, new Date("2026-01-01T00:00:00Z"), 12).filter((d) => d.obligationId === "ferc-form-3q");
  // FERC's electric industry forms page lists June 1, August 31 and November 30, 2026.
  assert.deepEqual(ds.map((d) => [d.due, d.periodLabel]), [["2026-06-01", "Q1 2026"], ["2026-08-31", "Q2 2026"], ["2026-11-30", "Q3 2026"]]);
  assert.equal(RULES["ferc-form-3q"].citations[0].url, "https://www.ecfr.gov/current/title-18/section-141.400");
});

/* ------------------------------------------------------------- contract */

test("previewObligations returns the same list", () => {
  assert.deepEqual(previewObligations(bigGas), obligationsFor(bigGas));
});

const OFFICIAL = /^https:\/\/([a-z0-9-]+\.)*(eia\.gov|epa\.gov|ecfr\.gov|arb\.ca\.gov|aqmd\.gov|energy\.ca\.gov|cpuc\.ca\.gov|ferc\.gov|nerc\.com|caiso\.com|federalregister\.gov|govinfo\.gov|energysafety\.ca\.gov)\//;

test("every rule cites official pages", () => {
  for (const r of Object.values(RULES)) {
    assert.match(r.formUrl, OFFICIAL, r.id);
    assert.ok(r.citations.length > 0, r.id);
    for (const c of r.citations) assert.match(c.url, OFFICIAL, `${r.id}: ${c.url}`);
  }
});

test("no placeholder words for any asset in the real map data", () => {
  type FC = { features: { properties: Record<string, unknown>; geometry: { coordinates: unknown } }[] };
  const bad = /unknown|unnamed|not listed|niche case/i;
  const plants = readJson<FC>("public/layers/plants.geojson").features;
  for (const f of plants) {
    const [lon, lat] = f.geometry.coordinates as [number, number];
    const p = { ...(f.properties as unknown as Plant), lat, lon };
    for (const o of obligationsFor({ kind: "plant", plant: p })) assert.ok(!bad.test(JSON.stringify(o)), `${p.plant_name} ${o.id}`);
  }
  const subs = readJson<FC>("public/layers/substations.geojson").features.slice(0, 400);
  for (const f of subs) {
    const [lon, lat] = f.geometry.coordinates as [number, number];
    const s = { ...(f.properties as unknown as Substation), lat, lon };
    for (const o of obligationsFor({ kind: "substation", substation: s })) assert.ok(!bad.test(JSON.stringify(o)), `${s.osm_id} ${o.id}`);
  }
});
