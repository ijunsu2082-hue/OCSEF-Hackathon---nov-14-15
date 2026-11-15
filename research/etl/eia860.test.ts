import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  compareMonthly, diffPlants, importEia860Archive, importEia860M, importEia860Workbooks, joinAtlasPlants,
  regeneratePlants, roundHalfEven, STATUS_CLASS, type RegenFeature,
} from "./eia860";
import { buildXlsx, type CellInput } from "./fixtures/eia860/xlsx-builder";

const PLANT_TITLE = "2025 Form EIA-860 Data - Schedule 2, 'Plant Data'";
// Deliberately not EIA's column order, with an unrelated column in front.
const PLANT_HEADER = [
  "Street Address", "Utility ID", "Utility Name", "Plant Code", "Plant Name", "City", "State", "County", "Latitude", "Longitude",
  "NERC Region", "Balancing Authority Code", "Balancing Authority Name", "Sector", "Sector Name",
  "Grid Voltage (kV)", "Grid Voltage 2 (kV)", "Grid Voltage 3 (kV)",
];

function plantRow(code: number, name: string, lat: number | string, lon: number | string, extra: Partial<Record<string, CellInput>> = {}): CellInput[] {
  const values: Record<string, CellInput> = {
    "Street Address": "1 Main St", "Utility ID": 100 + code, "Utility Name": `Utility ${code}`, "Plant Code": code, "Plant Name": name,
    City: "Long Beach", State: "CA", County: "Los Angeles", Latitude: lat, Longitude: lon, "NERC Region": "WECC",
    "Balancing Authority Code": "CISO", "Balancing Authority Name": "California Independent System Operator", Sector: 2,
    "Sector Name": "IPP Non-CHP", "Grid Voltage (kV)": 230, "Grid Voltage 2 (kV)": " ", "Grid Voltage 3 (kV)": " ", ...extra,
  };
  return PLANT_HEADER.map((name) => values[name] ?? null);
}

const GEN_COMMON = ["Utility ID", "Utility Name", "Plant Code", "Plant Name", "State", "County", "Generator ID", "Technology", "Prime Mover",
  "Nameplate Capacity (MW)", "Summer Capacity (MW)", "Winter Capacity (MW)", "Status", "Sector Name", "Energy Source 1"];
const GEN_HEADERS = {
  Operable: [...GEN_COMMON, "Operating Month", "Operating Year", "Planned Retirement Month", "Planned Retirement Year"],
  Proposed: [...GEN_COMMON, "Current Month", "Current Year", "Effective Month", "Effective Year"],
  "Retired and Canceled": [...GEN_COMMON, "Operating Month", "Operating Year", "Retirement Month", "Retirement Year"],
};
type GenSheet = keyof typeof GEN_HEADERS;

function genRow(sheet: GenSheet, values: Record<string, CellInput>): CellInput[] {
  const base: Record<string, CellInput> = { "Utility ID": 1, "Utility Name": "U", "Plant Name": "P", State: "CA", County: "Los Angeles", "Summer Capacity (MW)": " ", "Winter Capacity (MW)": " ", "Sector Name": "IPP Non-CHP" };
  const merged = { ...base, ...values };
  return GEN_HEADERS[sheet].map((name) => merged[name] ?? " ");
}

const NOTE = "NOTE: Information on planned capacity changes are data reported to EIA.";

function generatorBook(rows: Partial<Record<GenSheet, CellInput[][]>>, title = "2025 Form EIA-860 Data - Schedule 3, 'Generator Data'"): Uint8Array {
  return buildXlsx({
    sheets: (Object.keys(GEN_HEADERS) as GenSheet[]).map((sheet) => ({
      name: sheet,
      rows: [[`${title} (${sheet})`], GEN_HEADERS[sheet], ...(rows[sheet] ?? []), [NOTE]],
    })),
  });
}

function plantBook(rows: CellInput[][], title = PLANT_TITLE): Uint8Array {
  // Two title rows (one blank) above the header.
  return buildXlsx({ sheets: [{ name: "Plant", rows: [[title], [], PLANT_HEADER, ...rows, [NOTE]] }] });
}

const CENTER_LAT = 33.7538;
const CENTER_LON = -118.0111;

function fixture() {
  const plants = plantBook([
    plantRow(400, "Haynes", 33.764741, -118.09913),
    plantRow(350, "Ormond Beach", 34.1292, -119.1689),
    plantRow(9001, "Far Away", 40.0, -100.0),
    plantRow(9002, "Proposed Only", 33.8, -118.0),
    plantRow(9003, "No Coordinates", " ", " "),
  ]);
  const generators = generatorBook({
    Operable: [
      genRow("Operable", { "Plant Code": 400, "Generator ID": "1", Technology: "Natural Gas Steam Turbine", "Prime Mover": "ST", "Nameplate Capacity (MW)": 230, Status: "OP", "Energy Source 1": "NG", "Operating Month": 9, "Operating Year": 1962 }),
      genRow("Operable", { "Plant Code": 400, "Generator ID": "B1", Technology: "Batteries", "Prime Mover": "BA", "Nameplate Capacity (MW)": 0.25, Status: "SB", "Energy Source 1": "MWH", "Operating Month": 1, "Operating Year": 2020 }),
      genRow("Operable", { "Plant Code": 350, "Generator ID": "1", Technology: "Natural Gas Steam Turbine", "Prime Mover": "ST", "Nameplate Capacity (MW)": 806, Status: "OP", "Energy Source 1": "NG", "Operating Month": 1, "Operating Year": 1971, "Planned Retirement Month": 1, "Planned Retirement Year": 2027 }),
      genRow("Operable", { "Plant Code": 350, "Generator ID": "2", Technology: "Natural Gas Steam Turbine", "Prime Mover": "ST", "Nameplate Capacity (MW)": 806, Status: "OP", "Energy Source 1": "NG", "Operating Month": 1, "Operating Year": 1972, "Planned Retirement Month": 1, "Planned Retirement Year": 2027 }),
      genRow("Operable", { "Plant Code": 9001, "Generator ID": "W", Technology: "Onshore Wind Turbine", "Prime Mover": "WT", "Nameplate Capacity (MW)": 50, Status: "OP", "Energy Source 1": "WND", "Operating Month": 1, "Operating Year": 2010 }),
    ],
    Proposed: [
      genRow("Proposed", { "Plant Code": 9002, "Generator ID": "PV1", Technology: "Solar Photovoltaic", "Prime Mover": "PV", "Nameplate Capacity (MW)": 20, Status: "U", "Energy Source 1": "SUN", "Current Month": 6, "Current Year": 2027, "Effective Month": 3, "Effective Year": 2025 }),
    ],
    "Retired and Canceled": [
      genRow("Retired and Canceled", { "Plant Code": 400, "Generator ID": "3", Technology: "Natural Gas Steam Turbine", "Prime Mover": "ST", "Nameplate Capacity (MW)": 222, Status: "RE", "Energy Source 1": "NG", "Operating Month": 1, "Operating Year": 1970, "Retirement Month": 12, "Retirement Year": 2023 }),
      genRow("Retired and Canceled", { "Plant Code": 9002, "Generator ID": "X", Technology: "Batteries", "Prime Mover": "BA", "Nameplate Capacity (MW)": 5, Status: "CN", "Energy Source 1": "MWH" }),
      genRow("Retired and Canceled", { "Plant Code": 9002, "Generator ID": "Y", Technology: "Batteries", "Prime Mover": "BA", "Nameplate Capacity (MW)": 5, Status: "IP", "Energy Source 1": "MWH" }),
    ],
  });
  return { plants, generators };
}

test("finds headers by name below title rows and cites every field", () => {
  const { plants, generators } = fixture();
  const data = importEia860Workbooks(plants, generators);
  assert.equal(data.reporting_year, 2025);
  assert.equal(data.plants.size, 5);
  const plantSheet = data.sheets.find((sheet) => sheet.sheet === "Plant")!;
  assert.equal(plantSheet.header_row, 3);
  assert.deepEqual(plantSheet.title, [PLANT_TITLE]);
  assert.deepEqual(plantSheet.skipped.map((skip) => skip.reason), ["footnote"]);
  const haynes = data.plants.get(400)!;
  assert.equal(haynes.reporting_year, 2025);
  assert.equal(haynes.plant_name, "Haynes");
  assert.equal(haynes.grid_voltage_2_kv, null, "a blank (single space) cell is null");
  const sha = createHash("sha256").update(plants).digest("hex");
  // Plant Code is the 4th header column (D), Haynes is the first data row (4).
  assert.deepEqual(haynes.citations.plant_code, { workbook: "2___Plant_Y2025.xlsx", workbook_sha256: sha, sheet: "Plant", cell: "D4" });
  assert.equal(haynes.citations.latitude.cell, "I4");
  assert.equal(data.plants.get(9003)!.latitude, null);
  assert.equal(data.generators.length, 9);
  assert.ok(data.generators.every((generator) => generator.reporting_year === 2025));
  const one = data.generators.find((generator) => generator.key === "400:1")!;
  assert.equal(one.citations.nameplate_mw.cell, "J3");
  assert.equal(one.citations.nameplate_mw.sheet, "Operable");
});

test("planned and completed retirements stay distinct; canceled and postponed are not retirements", () => {
  const { plants, generators } = fixture();
  const data = importEia860Workbooks(plants, generators);
  const by = (key: string) => data.generators.find((generator) => generator.key === key)!;
  const planned = by("350:1");
  assert.equal(planned.retirement_state, "planned");
  assert.deepEqual([planned.planned_retirement_year, planned.planned_retirement_month, planned.retirement_year], [2027, 1, null]);
  assert.equal(planned.citations.planned_retirement_year.cell, "S5");
  const retired = by("400:3");
  assert.equal(retired.retirement_state, "completed");
  assert.equal(retired.status_class, "retired");
  assert.deepEqual([retired.retirement_year, retired.retirement_month, retired.planned_retirement_year], [2023, 12, null]);
  assert.equal(retired.citations.retirement_year.sheet, "Retired and Canceled");
  assert.deepEqual([by("9002:X").status_class, by("9002:X").retirement_state], ["canceled", "none"]);
  assert.deepEqual([by("9002:Y").status_class, by("9002:Y").retirement_state], ["indefinitely_postponed", "none"]);
  const proposed = by("9002:PV1");
  assert.deepEqual([proposed.status_class, proposed.proposed_current_year, proposed.operating_year, proposed.retirement_state], ["proposed", 2027, null, "none"]);
  assert.equal(by("400:B1").status_class, "operable", "SB (standby) is on the Operable sheet");
});

test("rejects workbooks that break the pins or the status semantics", () => {
  const { plants, generators } = fixture();
  assert.throws(() => importEia860Workbooks(plantBook([plantRow(1, "x", 33, -118)], "2024 Form EIA-860 Data - Schedule 2"), generators),
    /do not include "2025 Form EIA-860"/);
  const missing = buildXlsx({ sheets: [{ name: "Plant", rows: [[PLANT_TITLE], PLANT_HEADER.filter((name) => name !== "Latitude")] }] });
  assert.throws(() => importEia860Workbooks(missing, generators), /no header row with/);
  const reOnOperable = generatorBook({ Operable: [genRow("Operable", { "Plant Code": 1, "Generator ID": "1", "Nameplate Capacity (MW)": 1, Status: "RE", "Energy Source 1": "NG", "Operating Month": 1, "Operating Year": 2000 })] });
  assert.throws(() => importEia860Workbooks(plants, reOnOperable), /status RE is not a Operable status/);
  const canceledWithDate = generatorBook({ "Retired and Canceled": [genRow("Retired and Canceled", { "Plant Code": 1, "Generator ID": "1", "Nameplate Capacity (MW)": 1, Status: "CN", "Energy Source 1": "NG", "Retirement Month": 1, "Retirement Year": 2024 })] });
  assert.throws(() => importEia860Workbooks(plants, canceledWithDate), /status CN carries a Retirement Year/);
  const retiredNoDate = generatorBook({ "Retired and Canceled": [genRow("Retired and Canceled", { "Plant Code": 1, "Generator ID": "1", "Nameplate Capacity (MW)": 1, Status: "RE", "Energy Source 1": "NG" })] });
  assert.throws(() => importEia860Workbooks(plants, retiredNoDate), /status RE without a Retirement Year/);
  const textInNumber = generatorBook({ Operable: [genRow("Operable", { "Plant Code": 1, "Generator ID": "1", "Nameplate Capacity (MW)": "about 5", Status: "OP", "Energy Source 1": "NG", "Operating Month": 1, "Operating Year": 2000 })] });
  assert.throws(() => importEia860Workbooks(plants, textInNumber), /Operable!J3: expected a number for "Nameplate Capacity \(MW\)"/);
  const duplicate = generatorBook({
    Operable: [genRow("Operable", { "Plant Code": 1, "Generator ID": "1", "Nameplate Capacity (MW)": 1, Status: "OP", "Energy Source 1": "NG", "Operating Month": 1, "Operating Year": 2000 })],
    "Retired and Canceled": [genRow("Retired and Canceled", { "Plant Code": 1, "Generator ID": "1", "Nameplate Capacity (MW)": 1, Status: "RE", "Energy Source 1": "NG", "Retirement Month": 1, "Retirement Year": 2024 })],
  });
  assert.throws(() => importEia860Workbooks(plants, duplicate), /generator 1:1 is on both Operable and Retired and Canceled/);
  const keylessData = plantBook([plantRow(1, "x", 33, -118), [null, null, "orphan", null, "row"]]);
  assert.throws(() => importEia860Workbooks(keylessData, generators), /row 5 has no Plant Code but 2 filled cells/);
  // The accepted codes are exactly EIA's layout Tables 4 and 6 (asserted against the real workbook in xlsx.test.ts).
  const accepted = Object.values(STATUS_CLASS).flatMap((codes) => Object.keys(codes)).sort();
  assert.deepEqual(accepted, ["CN", "IP", "L", "OA", "OP", "OS", "OT", "P", "RE", "SB", "T", "TS", "U", "V"]);
});

test("round half to even on the exact double value (Python round semantics)", () => {
  const cases: Array<[number, number, number]> = [
    [0.25, 1, 0.2], [0.75, 1, 0.8], [0.35, 1, 0.3], [0.05, 1, 0.1], [9.95, 1, 9.9], [53.45, 1, 53.5],
    [2.5, 0, 2], [3.5, 0, 4], [1982.5, 0, 1982], [2016.5, 0, 2016], [-2.5, 0, -2], [-0.05, 1, -0.1], [99.96, 1, 100], [0, 1, 0],
  ];
  for (const [value, digits, expected] of cases) assert.equal(roundHalfEven(value, digits), expected, `${value} -> ${expected}`);
});

test("regenerates the committed layer's fields from the inferred rules", () => {
  const { plants, generators } = fixture();
  const data = importEia860Workbooks(plants, generators);
  const regen = regeneratePlants(data, [CENTER_LON, CENTER_LAT], 100);
  assert.equal(regen.withoutCoordinates, 1);
  assert.equal(regen.withinRadius, 3, "Haynes, Ormond Beach, Proposed Only");
  assert.deepEqual(regen.features.map((feature) => feature.properties.plant_code), [350, 400], "no Operable generators or outside radius: excluded; ordered by MW");
  const ormond = regen.features[0].properties;
  assert.deepEqual(
    { mw: ormond.nameplate_mw, retire: ormond.planned_retirement_mw, year: ormond.capacity_weighted_year, age: ormond.capacity_weighted_age_years, count: ormond.generator_count },
    { mw: 1612, retire: 1612, year: 1972, age: 53, count: 2 },
    "1971.5 rounds half to even",
  );
  const haynes = regen.features[1].properties;
  assert.deepEqual(haynes.mw_by_source, { natural_gas: 230, battery: 0.2 });
  assert.equal(haynes.nameplate_mw, 230.2);
  assert.equal(haynes.primary_source, "natural_gas");
  assert.deepEqual(haynes.technologies, ["Batteries", "Natural Gas Steam Turbine"]);
  assert.deepEqual([haynes.oldest_year, haynes.newest_year, haynes.planned_retirement_mw], [1962, 2020, 0]);
  assert.equal(haynes.distance_mi, 5.1);
  assert.deepEqual(regen.features[1].geometry.coordinates, [-118.09913, 33.764741]);
  const unknown = generatorBook({ Operable: [genRow("Operable", { "Plant Code": 400, "Generator ID": "N", "Nameplate Capacity (MW)": 1, Status: "OP", "Energy Source 1": "NUC", "Operating Month": 1, "Operating Year": 2000 })] });
  assert.throws(() => regeneratePlants(importEia860Workbooks(plants, unknown)), /No inferred mw_by_source category for Energy Source 1 "NUC"/);
});

test("diff classifies membership and field changes", () => {
  const { plants, generators } = fixture();
  const data = importEia860Workbooks(plants, generators);
  const regen = regeneratePlants(data).features;
  const committed = structuredClone(regen) as Array<RegenFeature & { properties: Record<string, unknown> }>;
  committed[1].properties.nameplate_mw = 231;
  committed.push({ type: "Feature", geometry: { type: "Point", coordinates: [-100, 40] }, properties: { ...committed[0].properties, plant_code: 9001, plant_name: "Far Away" } });
  committed.push({ type: "Feature", geometry: { type: "Point", coordinates: [-118, 33.8] }, properties: { ...committed[0].properties, plant_code: 9002, plant_name: "Proposed Only" } });
  committed.push({ type: "Feature", geometry: { type: "Point", coordinates: [-118, 33.8] }, properties: { ...committed[0].properties, plant_code: 5555, plant_name: "Gone" } });
  committed.shift();
  const diff = diffPlants(committed as never, regen, data);
  assert.deepEqual([diff.committed_features, diff.regenerated_features, diff.matched, diff.identical], [4, 2, 1, 0]);
  assert.deepEqual(diff.added.map((change) => change.plant_code), [350]);
  assert.deepEqual(diff.removed.map((change) => [change.plant_code, change.explanation.split(" ")[0]]), [[9001, "regenerated"], [9002, "no"], [5555, "Plant"]]);
  assert.deepEqual(diff.fields.nameplate_mw.classes, { unexplained: 1 });
  assert.equal(diff.order_identical, false);
});

test("joins loaded EIA Atlas plants by plant_code and explains misses", () => {
  const { plants, generators } = fixture();
  const data = importEia860Workbooks(plants, generators);
  const regen = regeneratePlants(data).features;
  const feature = (id: number, code: unknown, name: string) => ({ id: `eia-atlas-plants:${id}`, geometry: { coordinates: [-118.09913, 33.764741] as [number, number] }, properties: { name, plant_code: code }, citations: { plant_code: { snapshot: "snp_x", locator: `/features/${id}/properties/Plant_Code` } } });
  const loaded = { datasets: [{ source: "eia-atlas-plants", features: { features: [feature(0, 400, "Haynes"), feature(1, 9002, "Proposed Only"), feature(2, 777, "Unknown"), feature(3, null, "No code")] } }] };
  const join = joinAtlasPlants(loaded, regen, data);
  assert.deepEqual(
    [join.atlas_features, join.matched_regenerated, join.matched_plant_sheet_not_regenerated, join.unmatched, join.atlas_without_plant_code, join.regenerated_not_in_atlas],
    [4, 1, 1, 1, 1, 1],
  );
  assert.deepEqual(join.not_regenerated_reasons, { "no Operable generators in the reporting year": 1, "not on Plant sheet": 1 });
  assert.equal(join.rows[0].distance_between_points_mi, 0);
  assert.deepEqual(join.regenerated_only.map((row) => row.plant_code), [350]);
  assert.throws(() => joinAtlasPlants({ datasets: [] }, regen, data), /no eia-atlas-plants dataset/);
});

test("EIA-860M: period from the title row, header found below a blank row, status compared", () => {
  const { plants, generators } = fixture();
  const data = importEia860Workbooks(plants, generators);
  const common = ["Entity ID", "Plant ID", "Generator ID", "Nameplate Capacity (MW)"];
  const operating = [...common, "Status", "Planned Retirement Month", "Planned Retirement Year"];
  const retired = [...common, "Retirement Month", "Retirement Year"];
  const book = (period: string) => buildXlsx({
    sheets: [
      { name: "Operating", rows: [[`Inventory of Operating Generators as of ${period}`], [" ", " "], operating, [1, 350, "1", 806, "OP", 6, 2028], [1, 400, "B1", 0.25, "SB", " ", " "], ["NOTES:\r\nCapacity below 1 MW is excluded."]] },
      { name: "Retired", rows: [[`Inventory of Retired Generators as of September 2026`], [], retired, [1, 350, "2", 806, 3, 2026], [1, 400, "3", 222, 12, 2023]] },
    ],
  });
  const monthly = importEia860M(book("September 2026"), "september_generator2026.xlsx");
  assert.equal(monthly.period, "September 2026");
  assert.equal(monthly.sheets[0].header_row, 3);
  assert.equal(monthly.generators.get("350:2")!.citations.retirement_year.cell, "F4");
  const comparison = compareMonthly(data, monthly, new Set([350, 400]));
  assert.equal(comparison.annual_operable_at_regenerated_plants, 4);
  assert.equal(comparison.still_operating, 2);
  assert.deepEqual(comparison.retired_since.map((row) => [row.key, row.annual_planned_retirement, row.monthly_retirement]), [["350:2", "2027-01", "2026-03"]]);
  assert.deepEqual(comparison.absent_from_monthly, ["400:1"]);
  assert.deepEqual(comparison.planned_retirement_changed, [{ key: "350:1", annual: "2027-01", monthly: "2028-06" }]);
  assert.equal(comparison.annual_completed_retirements_at_regenerated_plants, 1);
  assert.throws(() => importEia860M(book("August 2026"), "x.xlsx"), /sheets disagree on the period/);
});

const PINNED_ZIP = "research/etl-state/eia860/raw/eia8602025.zip";
const PINNED_SHA256 = "2b27929d26cc1da9ad6a530da1cac6718cd8496098ee560c4d47cfffd96d08ba";

test("pinned EIA-860 2025 archive reproduces the committed plants layer", { skip: !existsSync(PINNED_ZIP) && "pinned archive not downloaded (research/etl-state is not committed)" }, async () => {
  const bytes = new Uint8Array(await readFile(PINNED_ZIP));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), PINNED_SHA256);
  const data = importEia860Archive(bytes);
  assert.equal(data.plants.size, 17349);
  assert.deepEqual(["Operable", "Proposed", "Retired and Canceled"].map((sheet) => data.generators.filter((g) => g.sheet === sheet).length), [27918, 2850, 5805]);
  const regen = regeneratePlants(data).features;
  const committed = JSON.parse(await readFile("public/layers/plants.geojson", "utf8"));
  const diff = diffPlants(committed.features, regen, data);
  assert.deepEqual([diff.matched, diff.identical, diff.added.length, diff.removed.length, diff.order_identical], [697, 695, 0, 0, true]);
  assert.deepEqual(Object.keys(diff.fields), ["distance_mi"]);
  assert.deepEqual(diff.fields.distance_mi.classes, { "rule_mismatch:earth_radius": 2 });
});
