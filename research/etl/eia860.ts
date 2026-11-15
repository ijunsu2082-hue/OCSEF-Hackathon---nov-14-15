/**
 * EIA-860 (annual, reporting year pinned) and EIA-860M (monthly) import,
 * regeneration of public/layers/plants.geojson, diff against the committed
 * layer, and a join to the loaded EIA Atlas plant assets.
 *
 * Never writes to public/layers. Everything goes under <stateRoot>/eia860/.
 *
 *   - Workbooks are read with the dependency-free reader in ./xlsx, from the
 *     pinned archive whose sha256 must match the manifest.
 *   - Columns are located by header text, never by position. EIA sheets carry
 *     one or more title rows above the header; the header row is the first row
 *     that contains every required column name, and the title rows above it
 *     must name the pinned reporting year ("2025 Form EIA-860").
 *   - Every normalized plant (Plant Code) and generator (Plant Code +
 *     Generator ID) field cites {workbook, workbook sha256, sheet, cell}.
 *   - Retirement semantics stay distinct: a planned retirement comes only from
 *     the Operable sheet's "Planned Retirement Year/Month"; a completed
 *     retirement comes only from the "Retired and Canceled" sheet's
 *     "Retirement Year/Month" on status RE. Canceled (CN) and indefinitely
 *     postponed (IP) rows on that sheet are not retirements.
 */

import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { digest } from "../../lib/evidence/canonical";
import { greatCircleMiles, type Position } from "./geometry";
import { stateRoot } from "./pipeline";
import { columnName, openXlsx, type XlsxCell, type XlsxRow, type XlsxWorkbook } from "./xlsx";
import { readZip } from "./zip";

/* ------------------------------------------------------------------------ */
/* Pins                                                                      */
/* ------------------------------------------------------------------------ */

export const EIA860_REPORTING_YEAR = 2025;
export const EIA860_URL = "https://www.eia.gov/electricity/data/eia860/xls/eia8602025.zip";
export const PLANT_WORKBOOK = `2___Plant_Y${EIA860_REPORTING_YEAR}.xlsx`;
export const GENERATOR_WORKBOOK = `3_1_Generator_Y${EIA860_REPORTING_YEAR}.xlsx`;
export const PLANT_SHEET = "Plant";
export const GENERATOR_SHEETS = ["Operable", "Proposed", "Retired and Canceled"] as const;
/** Study point and radius of public/layers/plants.geojson ([lon, lat]). */
export const CENTER: Position = [-118.0111, 33.7538];
export const RADIUS_MI = 100;
const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
const HEADER_SCAN_ROWS = 10;

export type GeneratorSheet = (typeof GENERATOR_SHEETS)[number];

/* ------------------------------------------------------------------------ */
/* Types                                                                     */
/* ------------------------------------------------------------------------ */

export interface Citation {
  workbook: string;
  workbook_sha256: string;
  sheet: string;
  cell: string;
}

export interface PlantRecord {
  reporting_year: number;
  plant_code: number;
  plant_name: string | null;
  utility_id: number | null;
  utility_name: string | null;
  city: string | null;
  state: string | null;
  county: string | null;
  latitude: number | null;
  longitude: number | null;
  nerc_region: string | null;
  balancing_authority_code: string | null;
  balancing_authority_name: string | null;
  sector: number | null;
  sector_name: string | null;
  grid_voltage_kv: number | null;
  grid_voltage_2_kv: number | null;
  grid_voltage_3_kv: number | null;
  citations: Record<string, Citation>;
}

export type GeneratorStatusClass = "operable" | "proposed" | "retired" | "canceled" | "indefinitely_postponed";
/** `planned`: Operable sheet carries a Planned Retirement Year. `completed`: Retired sheet, status RE. */
export type RetirementState = "none" | "planned" | "completed";

export interface GeneratorRecord {
  reporting_year: number;
  key: string;
  plant_code: number;
  generator_id: string;
  sheet: GeneratorSheet;
  status_code: string;
  status_class: GeneratorStatusClass;
  utility_id: number | null;
  plant_name: string | null;
  state: string | null;
  county: string | null;
  technology: string | null;
  prime_mover: string | null;
  energy_source_1: string | null;
  sector_name: string | null;
  nameplate_mw: number | null;
  summer_mw: number | null;
  winter_mw: number | null;
  operating_year: number | null;
  operating_month: number | null;
  /** Operable sheet only. */
  planned_retirement_year: number | null;
  planned_retirement_month: number | null;
  /** Retired and Canceled sheet, status RE only. */
  retirement_year: number | null;
  retirement_month: number | null;
  /** Proposed sheet only: the reported current expected in-service year/month and the effective date of that status. */
  proposed_current_year: number | null;
  proposed_current_month: number | null;
  proposed_effective_year: number | null;
  proposed_effective_month: number | null;
  retirement_state: RetirementState;
  citations: Record<string, Citation>;
}

export interface SheetSummary {
  workbook: string;
  workbook_sha256: string;
  sheet: string;
  header_row: number;
  title: string[];
  data_rows: number;
  skipped: Array<{ row: number; reason: string; text: string }>;
}

export interface Eia860Import {
  reporting_year: number;
  workbooks: Array<{ name: string; sha256: string; bytes: number }>;
  sheets: SheetSummary[];
  plants: Map<number, PlantRecord>;
  generators: GeneratorRecord[];
}

/* ------------------------------------------------------------------------ */
/* Header detection and cited cell reads                                     */
/* ------------------------------------------------------------------------ */

interface Table {
  summary: SheetSummary;
  columns: Map<string, number>;
  rows: XlsxRow[];
}

function cellText(cell: XlsxCell | undefined): string {
  if (!cell) return "";
  return typeof cell.value === "string" ? cell.value : cell.raw;
}

/**
 * Locate the header row by required column names (never by position) and
 * return the data rows below it. Title rows above the header must include
 * `titleMustInclude` when given (the reporting-year pin).
 */
export function readTable(
  workbook: XlsxWorkbook,
  sheet: string,
  required: readonly string[],
  source: { name: string; sha256: string },
  titleMustInclude?: string,
  keyColumn?: string,
): Table {
  const before: XlsxRow[] = [];
  const rows: XlsxRow[] = [];
  let header: XlsxRow | null = null;
  for (const row of workbook.rows(sheet)) {
    if (header) { rows.push(row); continue; }
    const names = new Set(row.cells.map((cell) => cellText(cell).trim()));
    if (required.every((name) => names.has(name))) { header = row; continue; }
    before.push(row);
    if (before.length >= HEADER_SCAN_ROWS) break;
  }
  if (!header) {
    throw new Error(`${source.name} ${sheet}: no header row with ${required.join(", ")} in the first ${HEADER_SCAN_ROWS} rows`);
  }
  const columns = new Map<string, number>();
  const duplicates = new Set<string>();
  for (const cell of header.cells) {
    const name = cellText(cell).trim();
    if (!name) continue;
    if (columns.has(name)) duplicates.add(name);
    columns.set(name, cell.column);
  }
  const ambiguous = required.filter((name) => duplicates.has(name));
  if (ambiguous.length) throw new Error(`${source.name} ${sheet}: header repeats ${ambiguous.join(", ")}`);
  const title = before.flatMap((row) => row.cells.map((cell) => cellText(cell).trim()).filter(Boolean));
  if (titleMustInclude && !title.some((text) => text.includes(titleMustInclude))) {
    throw new Error(`${source.name} ${sheet}: title rows ${JSON.stringify(title)} do not include "${titleMustInclude}"`);
  }
  // Footnote rows: no key cell, exactly one non-blank text cell. Anything else
  // without a key is an error, not a silent skip.
  const skipped: SheetSummary["skipped"] = [];
  const data: XlsxRow[] = [];
  const keyAt = keyColumn ? columns.get(keyColumn) : undefined;
  for (const row of rows) {
    const filled = row.cells.filter((cell) => cellText(cell).trim() !== "");
    if (!filled.length) { skipped.push({ row: row.row, reason: "blank", text: "" }); continue; }
    if (keyAt !== undefined && !row.cells.some((cell) => cell.column === keyAt && cellText(cell).trim() !== "")) {
      if (filled.length === 1 && typeof filled[0].value === "string") {
        skipped.push({ row: row.row, reason: "footnote", text: filled[0].value.slice(0, 160) });
        continue;
      }
      throw new Error(`${source.name} ${sheet}: row ${row.row} has no ${keyColumn} but ${filled.length} filled cells`);
    }
    data.push(row);
  }
  return {
    summary: {
      workbook: source.name, workbook_sha256: source.sha256, sheet, header_row: header.row, title,
      data_rows: data.length, skipped,
    },
    columns, rows: data,
  };
}

class CitedRow {
  private readonly byColumn = new Map<number, XlsxCell>();
  readonly citations: Record<string, Citation> = {};

  constructor(private readonly table: Table, private readonly row: XlsxRow) {
    for (const cell of row.cells) this.byColumn.set(cell.column, cell);
  }

  private locate(field: string, header: string): XlsxCell | undefined {
    const column = this.table.columns.get(header);
    if (column === undefined) throw new Error(`${this.table.summary.sheet}: no column "${header}"`);
    const { workbook, workbook_sha256, sheet } = this.table.summary;
    this.citations[field] = { workbook, workbook_sha256, sheet, cell: `${columnName(column)}${this.row.row}` };
    return this.byColumn.get(column);
  }

  private where(field: string): string {
    const citation = this.citations[field];
    return `${citation.workbook} ${citation.sheet}!${citation.cell}`;
  }

  /** Text as stored; blank (empty or whitespace-only) is null. Numeric cells give their exact stored text. */
  text(field: string, header: string): string | null {
    const cell = this.locate(field, header);
    if (!cell) return null;
    const text = typeof cell.value === "string" ? cell.value : cell.raw;
    return text.trim() === "" ? null : text;
  }

  /** Numeric cell, or null when blank. Non-blank text is an error. */
  number(field: string, header: string): number | null {
    const cell = this.locate(field, header);
    if (!cell) return null;
    if (typeof cell.value === "number") return cell.value;
    if (typeof cell.value === "string" && cell.value.trim() === "") return null;
    throw new Error(`${this.where(field)}: expected a number for "${header}", found ${JSON.stringify(cell.value)}`);
  }

  integer(field: string, header: string): number | null {
    const value = this.number(field, header);
    if (value !== null && !Number.isInteger(value)) throw new Error(`${this.where(field)}: expected an integer for "${header}", found ${value}`);
    return value;
  }

  requiredInteger(field: string, header: string): number {
    const value = this.integer(field, header);
    if (value === null) throw new Error(`${this.where(field)}: "${header}" is blank`);
    return value;
  }

  requiredText(field: string, header: string): string {
    const value = this.text(field, header);
    if (value === null) throw new Error(`${this.where(field)}: "${header}" is blank`);
    return value;
  }
}

/* ------------------------------------------------------------------------ */
/* Normalization                                                             */
/* ------------------------------------------------------------------------ */

const PLANT_COLUMNS = [
  "Plant Code", "Plant Name", "Utility ID", "Utility Name", "City", "State", "County", "Latitude", "Longitude",
  "NERC Region", "Balancing Authority Code", "Balancing Authority Name", "Sector", "Sector Name",
  "Grid Voltage (kV)", "Grid Voltage 2 (kV)", "Grid Voltage 3 (kV)",
] as const;

const GENERATOR_COMMON = [
  "Utility ID", "Plant Code", "Plant Name", "State", "County", "Generator ID", "Technology", "Prime Mover",
  "Nameplate Capacity (MW)", "Summer Capacity (MW)", "Winter Capacity (MW)", "Status", "Sector Name", "Energy Source 1",
] as const;

const GENERATOR_COLUMNS: Record<GeneratorSheet, readonly string[]> = {
  Operable: [...GENERATOR_COMMON, "Operating Year", "Operating Month", "Planned Retirement Year", "Planned Retirement Month"],
  Proposed: [...GENERATOR_COMMON, "Current Year", "Current Month", "Effective Year", "Effective Month"],
  "Retired and Canceled": [...GENERATOR_COMMON, "Operating Year", "Operating Month", "Retirement Year", "Retirement Month"],
};

/**
 * Status codes per sheet (EIA-860 layout, Reference Tables 4 and 6). A code
 * that is not listed for its sheet is an error.
 */
export const STATUS_CLASS: Record<GeneratorSheet, Record<string, GeneratorStatusClass>> = {
  Operable: { OP: "operable", SB: "operable", OS: "operable", OA: "operable" },
  Proposed: { P: "proposed", L: "proposed", T: "proposed", U: "proposed", V: "proposed", TS: "proposed", OT: "proposed" },
  "Retired and Canceled": { RE: "retired", CN: "canceled", IP: "indefinitely_postponed" },
};

function normalizePlant(table: Table, row: XlsxRow, year: number): PlantRecord {
  const cited = new CitedRow(table, row);
  const record: Omit<PlantRecord, "citations"> = {
    reporting_year: year,
    plant_code: cited.requiredInteger("plant_code", "Plant Code"),
    plant_name: cited.text("plant_name", "Plant Name"),
    utility_id: cited.integer("utility_id", "Utility ID"),
    utility_name: cited.text("utility_name", "Utility Name"),
    city: cited.text("city", "City"),
    state: cited.text("state", "State"),
    county: cited.text("county", "County"),
    latitude: cited.number("latitude", "Latitude"),
    longitude: cited.number("longitude", "Longitude"),
    nerc_region: cited.text("nerc_region", "NERC Region"),
    balancing_authority_code: cited.text("balancing_authority_code", "Balancing Authority Code"),
    balancing_authority_name: cited.text("balancing_authority_name", "Balancing Authority Name"),
    sector: cited.integer("sector", "Sector"),
    sector_name: cited.text("sector_name", "Sector Name"),
    grid_voltage_kv: cited.number("grid_voltage_kv", "Grid Voltage (kV)"),
    grid_voltage_2_kv: cited.number("grid_voltage_2_kv", "Grid Voltage 2 (kV)"),
    grid_voltage_3_kv: cited.number("grid_voltage_3_kv", "Grid Voltage 3 (kV)"),
  };
  if (record.plant_code <= 0) throw new Error(`${table.summary.sheet} row ${row.row}: Plant Code ${record.plant_code} is not positive`);
  return { ...record, citations: cited.citations };
}

function normalizeGenerator(table: Table, sheet: GeneratorSheet, row: XlsxRow, year: number): GeneratorRecord {
  const cited = new CitedRow(table, row);
  const plant_code = cited.requiredInteger("plant_code", "Plant Code");
  const generator_id = cited.requiredText("generator_id", "Generator ID");
  const status_code = cited.requiredText("status_code", "Status").trim();
  const status_class = STATUS_CLASS[sheet][status_code];
  if (!status_class) throw new Error(`${table.summary.workbook} ${sheet} row ${row.row}: status ${status_code} is not a ${sheet} status`);
  const operable = sheet === "Operable";
  const proposed = sheet === "Proposed";
  const retiredSheet = sheet === "Retired and Canceled";
  const record: Omit<GeneratorRecord, "citations" | "retirement_state"> = {
    reporting_year: year,
    key: `${plant_code}:${generator_id}`,
    plant_code, generator_id, sheet, status_code, status_class,
    utility_id: cited.integer("utility_id", "Utility ID"),
    plant_name: cited.text("plant_name", "Plant Name"),
    state: cited.text("state", "State"),
    county: cited.text("county", "County"),
    technology: cited.text("technology", "Technology"),
    prime_mover: cited.text("prime_mover", "Prime Mover"),
    energy_source_1: cited.text("energy_source_1", "Energy Source 1"),
    sector_name: cited.text("sector_name", "Sector Name"),
    nameplate_mw: cited.number("nameplate_mw", "Nameplate Capacity (MW)"),
    summer_mw: cited.number("summer_mw", "Summer Capacity (MW)"),
    winter_mw: cited.number("winter_mw", "Winter Capacity (MW)"),
    operating_year: proposed ? null : cited.integer("operating_year", "Operating Year"),
    operating_month: proposed ? null : cited.integer("operating_month", "Operating Month"),
    planned_retirement_year: operable ? cited.integer("planned_retirement_year", "Planned Retirement Year") : null,
    planned_retirement_month: operable ? cited.integer("planned_retirement_month", "Planned Retirement Month") : null,
    retirement_year: retiredSheet ? cited.integer("retirement_year", "Retirement Year") : null,
    retirement_month: retiredSheet ? cited.integer("retirement_month", "Retirement Month") : null,
    proposed_current_year: proposed ? cited.integer("proposed_current_year", "Current Year") : null,
    proposed_current_month: proposed ? cited.integer("proposed_current_month", "Current Month") : null,
    proposed_effective_year: proposed ? cited.integer("proposed_effective_year", "Effective Year") : null,
    proposed_effective_month: proposed ? cited.integer("proposed_effective_month", "Effective Month") : null,
  };
  const where = `${table.summary.workbook} ${sheet} row ${row.row}`;
  if (retiredSheet) {
    if (status_class === "retired" && record.retirement_year === null) throw new Error(`${where}: status RE without a Retirement Year`);
    if (status_class !== "retired" && record.retirement_year !== null) {
      throw new Error(`${where}: status ${status_code} carries a Retirement Year; only RE is a completed retirement`);
    }
  }
  const retirement_state: RetirementState = record.retirement_year !== null && status_class === "retired" ? "completed"
    : record.planned_retirement_year !== null ? "planned" : "none";
  return { ...record, retirement_state, citations: cited.citations };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Import the Plant and Generator workbooks (bytes of the two .xlsx files). */
export function importEia860Workbooks(
  plantBytes: Uint8Array,
  generatorBytes: Uint8Array,
  year = EIA860_REPORTING_YEAR,
  names = { plant: PLANT_WORKBOOK, generator: GENERATOR_WORKBOOK },
): Eia860Import {
  const titlePin = `${year} Form EIA-860`;
  const plantSource = { name: names.plant, sha256: sha256(plantBytes) };
  const generatorSource = { name: names.generator, sha256: sha256(generatorBytes) };
  const sheets: SheetSummary[] = [];

  const plantTable = readTable(openXlsx(plantBytes), PLANT_SHEET, PLANT_COLUMNS, plantSource, titlePin, "Plant Code");
  sheets.push(plantTable.summary);
  const plants = new Map<number, PlantRecord>();
  for (const row of plantTable.rows) {
    const plant = normalizePlant(plantTable, row, year);
    if (plants.has(plant.plant_code)) throw new Error(`${names.plant}: Plant Code ${plant.plant_code} appears twice`);
    plants.set(plant.plant_code, plant);
  }

  const generatorBook = openXlsx(generatorBytes);
  const generators: GeneratorRecord[] = [];
  const keys = new Map<string, GeneratorSheet>();
  for (const sheet of GENERATOR_SHEETS) {
    const table = readTable(generatorBook, sheet, GENERATOR_COLUMNS[sheet], generatorSource, titlePin, "Plant Code");
    sheets.push(table.summary);
    for (const row of table.rows) {
      const generator = normalizeGenerator(table, sheet, row, year);
      const seen = keys.get(generator.key);
      if (seen) throw new Error(`${names.generator}: generator ${generator.key} is on both ${seen} and ${sheet}`);
      keys.set(generator.key, sheet);
      generators.push(generator);
    }
  }
  return {
    reporting_year: year,
    workbooks: [
      { name: names.plant, sha256: plantSource.sha256, bytes: plantBytes.length },
      { name: names.generator, sha256: generatorSource.sha256, bytes: generatorBytes.length },
    ],
    sheets, plants, generators,
  };
}

/** Import straight from the published annual archive (eia860YYYY.zip). */
export function importEia860Archive(zipBytes: Uint8Array, year = EIA860_REPORTING_YEAR): Eia860Import {
  const names = { plant: `2___Plant_Y${year}.xlsx`, generator: `3_1_Generator_Y${year}.xlsx` };
  const entries = new Map(readZip(zipBytes, { maxTotalBytes: ARCHIVE_MAX_BYTES }).map((entry) => [entry.name, entry.data]));
  const plant = entries.get(names.plant);
  const generator = entries.get(names.generator);
  if (!plant || !generator) throw new Error(`Archive lacks ${!plant ? names.plant : names.generator}; has ${[...entries.keys()].join(", ")}`);
  return importEia860Workbooks(plant, generator, year, names);
}

/* ------------------------------------------------------------------------ */
/* Regeneration of plants.geojson                                            */
/* ------------------------------------------------------------------------ */

/**
 * Energy Source 1 code -> mw_by_source category, inferred from the committed
 * layer (every code below occurs in the study radius and reproduces the
 * committed category for every plant). A code outside this table is an
 * error, not a guess.
 */
export const SOURCE_CATEGORY: Record<string, string> = {
  NG: "natural_gas", WAT: "hydro", SUN: "solar", MWH: "battery", WND: "wind", OG: "other_gas",
  LFG: "biogas", OBG: "biogas", WH: "waste_heat", DFO: "oil", PG: "other", OTH: "other",
};

/**
 * Round half to even on the exact decimal value of the double (the semantics
 * of Python's round(x, n)). `toFixed(100)` yields the exact binary value's
 * decimal expansion for the magnitudes used here (|x| > 1e-30).
 */
export function roundHalfEven(value: number, digits: number): number {
  if (!Number.isFinite(value)) throw new Error(`Cannot round ${value}`);
  if (!Number.isInteger(digits) || digits < 0 || digits > 20) throw new Error(`Invalid digits ${digits}`);
  if (Math.abs(value) >= 1e21) return value;
  const negative = value < 0;
  const [whole, fraction] = Math.abs(value).toFixed(100).split(".");
  const kept = fraction.slice(0, digits);
  const rest = fraction.slice(digits);
  let digitsText = whole + kept;
  const first = rest.charCodeAt(0) - 48;
  const tail = /[1-9]/.test(rest.slice(1));
  const last = digitsText.charCodeAt(digitsText.length - 1) - 48;
  const up = first > 5 || (first === 5 && (tail || last % 2 === 1));
  if (up) {
    const chars = digitsText.split("");
    let index = chars.length - 1;
    while (index >= 0) {
      if (chars[index] === "9") { chars[index] = "0"; index -= 1; continue; }
      chars[index] = String.fromCharCode(chars[index].charCodeAt(0) + 1);
      break;
    }
    digitsText = (index < 0 ? "1" : "") + chars.join("");
  }
  const intPart = digitsText.slice(0, digitsText.length - digits) || "0";
  const out = Number(digits ? `${intPart}.${digitsText.slice(digitsText.length - digits)}` : intPart);
  return negative && out !== 0 ? -out : out;
}

export interface RegenProperties {
  plant_code: number;
  plant_name: string | null;
  utility_name: string | null;
  distance_mi: number;
  county: string | null;
  city: string | null;
  balancing_authority: string | null;
  sector: string | null;
  grid_voltage_kv: number | null;
  nameplate_mw: number;
  mw_by_source: Record<string, number>;
  oldest_year: number | null;
  newest_year: number | null;
  planned_retirement_mw: number;
  generator_count: number;
  primary_source: string;
  technologies: string[];
  capacity_weighted_year: number | null;
  capacity_weighted_age_years: number | null;
}

export interface RegenFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: RegenProperties;
}

/** Rules reproduced from the committed layer. Each is checked field-by-field by the diff. */
export const AGGREGATION_RULES = [
  "membership: Plant sheet plants with Latitude/Longitude whose greatCircleMiles(center) <= radius and that have >= 1 generator on the Operable sheet (statuses OP, SB, OS, OA)",
  "coordinates: [Longitude, Latitude] from the Plant sheet as stored",
  "distance_mi: greatCircleMiles (mean Earth radius 6371008.8 m), round-half-even to 0.1",
  "plant_name, utility_name, county, city, balancing_authority (Balancing Authority Code), sector (Sector Name), grid_voltage_kv (Grid Voltage (kV)): Plant sheet",
  "nameplate_mw: sum of Operable Nameplate Capacity (MW), round-half-even to 0.1",
  "mw_by_source: Operable Nameplate Capacity summed by SOURCE_CATEGORY[Energy Source 1], each round-half-even to 0.1",
  "primary_source: mw_by_source key with the largest rounded MW (first in generator order on a tie)",
  "oldest_year/newest_year: min/max Operable Operating Year",
  "planned_retirement_mw: sum of Operable Nameplate Capacity where Planned Retirement Year is set, round-half-even to 0.1",
  "generator_count: number of Operable generators",
  "technologies: distinct Operable Technology values, sorted by code unit",
  "capacity_weighted_year: round-half-even(sum(MW * Operating Year) / sum(MW)); capacity_weighted_age_years = reporting year - capacity_weighted_year",
  "order: unrounded summed Operable nameplate MW descending, then plant_code ascending",
];

export function regeneratePlants(
  data: Eia860Import,
  center: Position = CENTER,
  radiusMiles = RADIUS_MI,
): { features: RegenFeature[]; considered: number; withinRadius: number; withoutCoordinates: number } {
  const operable = new Map<number, GeneratorRecord[]>();
  for (const generator of data.generators) {
    if (generator.sheet !== "Operable") continue;
    const list = operable.get(generator.plant_code) ?? [];
    list.push(generator);
    operable.set(generator.plant_code, list);
  }
  const features: RegenFeature[] = [];
  const unrounded = new Map<number, number>();
  let withinRadius = 0;
  let withoutCoordinates = 0;
  for (const plant of data.plants.values()) {
    if (plant.latitude === null || plant.longitude === null) { withoutCoordinates += 1; continue; }
    const distance = greatCircleMiles(center, [plant.longitude, plant.latitude]);
    if (distance > radiusMiles) continue;
    withinRadius += 1;
    const generators = operable.get(plant.plant_code);
    if (!generators?.length) continue;
    let total = 0;
    let weighted = 0;
    let weightedMw = 0;
    let retiring = 0;
    const bySource = new Map<string, number>();
    const years: number[] = [];
    for (const generator of generators) {
      if (generator.nameplate_mw === null) throw new Error(`Operable generator ${generator.key} has no nameplate capacity`);
      const code = generator.energy_source_1 ?? "";
      const category = SOURCE_CATEGORY[code];
      if (!category) throw new Error(`No inferred mw_by_source category for Energy Source 1 "${code}" (generator ${generator.key})`);
      total += generator.nameplate_mw;
      bySource.set(category, (bySource.get(category) ?? 0) + generator.nameplate_mw);
      if (generator.planned_retirement_year !== null) retiring += generator.nameplate_mw;
      if (generator.operating_year !== null) {
        years.push(generator.operating_year);
        weighted += generator.nameplate_mw * generator.operating_year;
        weightedMw += generator.nameplate_mw;
      }
    }
    const mwBySource: Record<string, number> = {};
    for (const [category, mw] of bySource) mwBySource[category] = roundHalfEven(mw, 1);
    let primary = "";
    for (const [category, mw] of Object.entries(mwBySource)) if (!primary || mw > mwBySource[primary]) primary = category;
    const weightedYear = weightedMw > 0 ? roundHalfEven(weighted / weightedMw, 0) : null;
    unrounded.set(plant.plant_code, total);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [plant.longitude, plant.latitude] },
      properties: {
        plant_code: plant.plant_code,
        plant_name: plant.plant_name,
        utility_name: plant.utility_name,
        distance_mi: roundHalfEven(distance, 1),
        county: plant.county,
        city: plant.city,
        balancing_authority: plant.balancing_authority_code,
        sector: plant.sector_name,
        grid_voltage_kv: plant.grid_voltage_kv,
        nameplate_mw: roundHalfEven(total, 1),
        mw_by_source: mwBySource,
        oldest_year: years.length ? Math.min(...years) : null,
        newest_year: years.length ? Math.max(...years) : null,
        planned_retirement_mw: roundHalfEven(retiring, 1),
        generator_count: generators.length,
        primary_source: primary,
        technologies: [...new Set(generators.map((g) => g.technology).filter((t): t is string => t !== null))].sort(),
        capacity_weighted_year: weightedYear,
        capacity_weighted_age_years: weightedYear === null ? null : data.reporting_year - weightedYear,
      },
    });
  }
  const totalOf = (feature: RegenFeature) => unrounded.get(feature.properties.plant_code)!;
  features.sort((a, b) => totalOf(b) - totalOf(a) || a.properties.plant_code - b.properties.plant_code);
  return { features, considered: data.plants.size, withinRadius, withoutCoordinates };
}

/* ------------------------------------------------------------------------ */
/* Diff against the committed layer                                          */
/* ------------------------------------------------------------------------ */

interface CommittedFeature {
  geometry: { type: string; coordinates: [number, number] };
  properties: Record<string, unknown> & { plant_code: number };
}

export interface FieldChange {
  plant_code: number;
  field: string;
  committed: unknown;
  regenerated: unknown;
  class: string;
  explanation: string;
}

export interface MembershipChange {
  plant_code: number;
  plant_name: unknown;
  class: string;
  explanation: string;
}

export interface PlantDiff {
  committed_features: number;
  regenerated_features: number;
  matched: number;
  identical: number;
  added: MembershipChange[];
  removed: MembershipChange[];
  fields: Record<string, { changed: number; classes: Record<string, number>; examples: FieldChange[] }>;
  extra_committed_fields: string[];
  order_identical: boolean;
}

const HAVERSINE_ALT_RADIUS_MI = 3958.8;

function haversineMiles(from: Position, to: Position, radius: number): number {
  const r = Math.PI / 180;
  const dLat = (to[1] - from[1]) * r;
  const dLon = (to[0] - from[0]) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(from[1] * r) * Math.cos(to[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(a));
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffPlants(
  committed: CommittedFeature[],
  regenerated: RegenFeature[],
  data: Eia860Import,
  center: Position = CENTER,
  radiusMiles = RADIUS_MI,
): PlantDiff {
  const regenByCode = new Map(regenerated.map((feature) => [feature.properties.plant_code, feature]));
  const committedByCode = new Map(committed.map((feature) => [feature.properties.plant_code, feature]));
  const operableCount = new Map<number, number>();
  for (const generator of data.generators) {
    if (generator.sheet === "Operable") operableCount.set(generator.plant_code, (operableCount.get(generator.plant_code) ?? 0) + 1);
  }
  const fields: PlantDiff["fields"] = {};
  const record = (change: FieldChange) => {
    const entry = fields[change.field] ?? (fields[change.field] = { changed: 0, classes: {}, examples: [] });
    entry.changed += 1;
    entry.classes[change.class] = (entry.classes[change.class] ?? 0) + 1;
    if (entry.examples.length < 8) entry.examples.push(change);
  };
  const removed: MembershipChange[] = [];
  const extra = new Set<string>();
  let matched = 0;
  let identical = 0;
  for (const feature of committed) {
    const code = feature.properties.plant_code;
    const regen = regenByCode.get(code);
    if (!regen) {
      const plant = data.plants.get(code);
      let cls = "data_difference";
      let explanation = `Plant Code ${code} is not on the ${data.reporting_year} Plant sheet`;
      if (plant) {
        if (plant.latitude === null || plant.longitude === null) explanation = "Plant sheet has no coordinates";
        else {
          const miles = greatCircleMiles(center, [plant.longitude, plant.latitude]);
          if (miles > radiusMiles) {
            cls = haversineMiles(center, [plant.longitude, plant.latitude], HAVERSINE_ALT_RADIUS_MI) <= radiusMiles ? "rule_mismatch:earth_radius" : "data_difference";
            explanation = `regenerated distance ${miles.toFixed(4)} mi is outside the radius`;
          } else {
            explanation = `no Operable generators (${operableCount.get(code) ?? 0})`;
          }
        }
      }
      removed.push({ plant_code: code, plant_name: feature.properties.plant_name, class: cls, explanation });
      continue;
    }
    matched += 1;
    let differs = false;
    const props = regen.properties as unknown as Record<string, unknown>;
    for (const key of Object.keys(feature.properties)) if (!(key in props)) extra.add(key);
    const comparisons: Array<[string, unknown, unknown]> = [
      ["geometry.coordinates", feature.geometry.coordinates, regen.geometry.coordinates],
      ...Object.keys(props).map((key): [string, unknown, unknown] => [key, feature.properties[key], props[key]]),
    ];
    for (const [field, before, after] of comparisons) {
      if (same(before, after)) continue;
      differs = true;
      let cls = "unexplained";
      let explanation = "no rule found that reproduces the committed value";
      if (field === "distance_mi") {
        const [lon, lat] = regen.geometry.coordinates;
        const alt = haversineMiles(center, [lon, lat], HAVERSINE_ALT_RADIUS_MI);
        if (roundHalfEven(alt, 1) === before) {
          cls = "rule_mismatch:earth_radius";
          explanation = `committed value equals haversine with R=${HAVERSINE_ALT_RADIUS_MI} mi (${alt.toFixed(5)}); greatCircleMiles gives ${greatCircleMiles(center, [lon, lat]).toFixed(5)}`;
        }
      }
      record({ plant_code: code, field, committed: before, regenerated: after, class: cls, explanation });
    }
    if (!differs) identical += 1;
  }
  const added: MembershipChange[] = [];
  for (const feature of regenerated) {
    const code = feature.properties.plant_code;
    if (committedByCode.has(code)) continue;
    const [lon, lat] = feature.geometry.coordinates;
    const alt = haversineMiles(center, [lon, lat], HAVERSINE_ALT_RADIUS_MI);
    added.push({
      plant_code: code, plant_name: feature.properties.plant_name,
      class: alt > radiusMiles ? "rule_mismatch:earth_radius" : "data_difference",
      explanation: `within radius at ${feature.properties.distance_mi} mi with ${feature.properties.generator_count} Operable generators; absent from the committed layer`,
    });
  }
  const committedOrder = committed.map((feature) => feature.properties.plant_code);
  const regenOrder = regenerated.map((feature) => feature.properties.plant_code);
  return {
    committed_features: committed.length,
    regenerated_features: regenerated.length,
    matched, identical, added, removed, fields,
    extra_committed_fields: [...extra].sort(),
    order_identical: same(committedOrder, regenOrder),
  };
}

/* ------------------------------------------------------------------------ */
/* Join to loaded assets (EIA Atlas plants)                                  */
/* ------------------------------------------------------------------------ */

interface LoadedFeature {
  id: string;
  geometry?: { coordinates?: [number, number] };
  properties: Record<string, unknown>;
  citations?: Record<string, unknown>;
}

export interface AtlasJoin {
  dataset: string;
  join_field: string;
  join_field_citation_locator: unknown;
  atlas_features: number;
  atlas_without_plant_code: number;
  matched_regenerated: number;
  matched_plant_sheet_not_regenerated: number;
  unmatched: number;
  regenerated_not_in_atlas: number;
  name_agreement: { equal: number; different: number };
  not_regenerated_reasons: Record<string, number>;
  rows: Array<{
    atlas_id: string;
    plant_code: number | null;
    status: "matched" | "plant_sheet_only" | "unmatched" | "no_plant_code";
    reason?: string;
    atlas_name: unknown;
    eia860_name: string | null;
    distance_between_points_mi: number | null;
    nameplate_mw: number | null;
  }>;
  regenerated_only: Array<{ plant_code: number; plant_name: string | null; nameplate_mw: number; distance_mi: number }>;
}

export function joinAtlasPlants(
  loaded: { datasets?: Array<{ source: string; features?: { features?: LoadedFeature[] } }> },
  regenerated: RegenFeature[],
  data: Eia860Import,
  center: Position = CENTER,
  radiusMiles = RADIUS_MI,
): AtlasJoin {
  const dataset = loaded.datasets?.find((candidate) => candidate.source === "eia-atlas-plants");
  if (!dataset?.features?.features) throw new Error("Loaded assets have no eia-atlas-plants dataset");
  const features = dataset.features.features;
  const regenByCode = new Map(regenerated.map((feature) => [feature.properties.plant_code, feature]));
  const operable = new Set(data.generators.filter((g) => g.sheet === "Operable").map((g) => g.plant_code));
  const seen = new Set<number>();
  const rows: AtlasJoin["rows"] = [];
  const reasons: Record<string, number> = {};
  const nameAgreement = { equal: 0, different: 0 };
  let locator: unknown = null;
  for (const feature of features) {
    const raw = feature.properties.plant_code;
    if (locator === null && feature.citations?.plant_code) locator = feature.citations.plant_code;
    const code = typeof raw === "number" && Number.isInteger(raw) ? raw : null;
    const atlasPoint = feature.geometry?.coordinates;
    if (code === null) {
      rows.push({ atlas_id: feature.id, plant_code: null, status: "no_plant_code", atlas_name: feature.properties.name, eia860_name: null, distance_between_points_mi: null, nameplate_mw: null });
      continue;
    }
    seen.add(code);
    const plant = data.plants.get(code);
    const between = plant && plant.latitude !== null && plant.longitude !== null && atlasPoint
      ? roundHalfEven(greatCircleMiles([atlasPoint[0], atlasPoint[1]], [plant.longitude, plant.latitude]), 3) : null;
    const regen = regenByCode.get(code);
    if (plant) {
      if (plant.plant_name === feature.properties.name) nameAgreement.equal += 1; else nameAgreement.different += 1;
    }
    if (regen) {
      rows.push({ atlas_id: feature.id, plant_code: code, status: "matched", atlas_name: feature.properties.name, eia860_name: plant?.plant_name ?? null, distance_between_points_mi: between, nameplate_mw: regen.properties.nameplate_mw });
      continue;
    }
    let reason = `Plant Code ${code} not on the ${data.reporting_year} Plant sheet`;
    if (plant) {
      if (plant.latitude === null || plant.longitude === null) reason = "Plant sheet has no coordinates";
      else if (greatCircleMiles(center, [plant.longitude, plant.latitude]) > radiusMiles) reason = "outside radius by Plant sheet coordinates";
      else if (!operable.has(code)) reason = "no Operable generators in the reporting year";
      else reason = "unexplained";
    }
    const key = plant ? reason : "not on Plant sheet";
    reasons[key] = (reasons[key] ?? 0) + 1;
    rows.push({ atlas_id: feature.id, plant_code: code, status: plant ? "plant_sheet_only" : "unmatched", reason, atlas_name: feature.properties.name, eia860_name: plant?.plant_name ?? null, distance_between_points_mi: between, nameplate_mw: null });
  }
  const regeneratedOnly = regenerated
    .filter((feature) => !seen.has(feature.properties.plant_code))
    .map((feature) => ({ plant_code: feature.properties.plant_code, plant_name: feature.properties.plant_name, nameplate_mw: feature.properties.nameplate_mw, distance_mi: feature.properties.distance_mi }));
  return {
    dataset: "eia-atlas-plants",
    join_field: "properties.plant_code",
    join_field_citation_locator: locator,
    atlas_features: features.length,
    atlas_without_plant_code: rows.filter((row) => row.status === "no_plant_code").length,
    matched_regenerated: rows.filter((row) => row.status === "matched").length,
    matched_plant_sheet_not_regenerated: rows.filter((row) => row.status === "plant_sheet_only").length,
    unmatched: rows.filter((row) => row.status === "unmatched").length,
    regenerated_not_in_atlas: regeneratedOnly.length,
    name_agreement: nameAgreement,
    not_regenerated_reasons: reasons,
    rows,
    regenerated_only: regeneratedOnly,
  };
}

/* ------------------------------------------------------------------------ */
/* EIA-860M (monthly) status comparison                                      */
/* ------------------------------------------------------------------------ */

export interface MonthlyGenerator {
  sheet: "Operating" | "Retired";
  plant_code: number;
  generator_id: string;
  status_code: string | null;
  planned_retirement_year: number | null;
  planned_retirement_month: number | null;
  retirement_year: number | null;
  retirement_month: number | null;
  nameplate_mw: number | null;
  citations: Record<string, Citation>;
}

export interface MonthlyImport {
  period: string;
  workbook_sha256: string;
  sheets: SheetSummary[];
  generators: Map<string, MonthlyGenerator>;
}

const MONTHLY_COMMON = ["Plant ID", "Generator ID", "Nameplate Capacity (MW)"] as const;

/** Read the Operating and Retired sheets of an EIA-860M workbook; the period comes from the title row. */
export function importEia860M(bytes: Uint8Array, name: string): MonthlyImport {
  const workbook = openXlsx(bytes);
  const source = { name, sha256: sha256(bytes) };
  const sheets: SheetSummary[] = [];
  const generators = new Map<string, MonthlyGenerator>();
  let period: string | null = null;
  for (const sheet of ["Operating", "Retired"] as const) {
    const required = sheet === "Operating"
      ? [...MONTHLY_COMMON, "Status", "Planned Retirement Month", "Planned Retirement Year"]
      : [...MONTHLY_COMMON, "Retirement Month", "Retirement Year"];
    const table = readTable(workbook, sheet, required, source, undefined, "Plant ID");
    sheets.push(table.summary);
    const titled = table.summary.title.map((text) => /as of ([A-Z][a-z]+ \d{4})/.exec(text)?.[1]).find(Boolean);
    if (!titled) throw new Error(`${name} ${sheet}: title rows do not state "as of <Month YYYY>"`);
    if (period && period !== titled) throw new Error(`${name}: sheets disagree on the period (${period} vs ${titled})`);
    period = titled;
    for (const row of table.rows) {
      const cited = new CitedRow(table, row);
      const plant_code = cited.requiredInteger("plant_code", "Plant ID");
      const generator_id = cited.requiredText("generator_id", "Generator ID");
      const record: MonthlyGenerator = {
        sheet, plant_code, generator_id,
        status_code: sheet === "Operating" ? cited.text("status_code", "Status") : null,
        planned_retirement_year: sheet === "Operating" ? cited.integer("planned_retirement_year", "Planned Retirement Year") : null,
        planned_retirement_month: sheet === "Operating" ? cited.integer("planned_retirement_month", "Planned Retirement Month") : null,
        retirement_year: sheet === "Retired" ? cited.integer("retirement_year", "Retirement Year") : null,
        retirement_month: sheet === "Retired" ? cited.integer("retirement_month", "Retirement Month") : null,
        nameplate_mw: cited.number("nameplate_mw", "Nameplate Capacity (MW)"),
        citations: cited.citations,
      };
      const key = `${plant_code}:${generator_id}`;
      if (generators.has(key)) throw new Error(`${name}: generator ${key} appears on ${generators.get(key)!.sheet} and ${sheet}`);
      generators.set(key, record);
    }
  }
  return { period: period!, workbook_sha256: source.sha256, sheets, generators };
}

export interface StatusComparison {
  annual_reporting_year: number;
  monthly_period: string;
  annual_operable_at_regenerated_plants: number;
  still_operating: number;
  retired_since: Array<{ key: string; annual_planned_retirement: string | null; monthly_retirement: string; nameplate_mw: number | null; citations: { annual: Citation | undefined; monthly: Citation | undefined } }>;
  absent_from_monthly: string[];
  planned_retirement_changed: Array<{ key: string; annual: string | null; monthly: string | null }>;
  annual_planned_retirements: number;
  annual_completed_retirements_at_regenerated_plants: number;
}

function yearMonth(year: number | null, month: number | null): string | null {
  if (year === null) return null;
  return month === null ? `${year}` : `${year}-${String(month).padStart(2, "0")}`;
}

/** Compare annual Operable generators of the regenerated plants with their EIA-860M status. */
export function compareMonthly(data: Eia860Import, monthly: MonthlyImport, plantCodes: Set<number>): StatusComparison {
  const inRadius = data.generators.filter((generator) => plantCodes.has(generator.plant_code));
  const operable = inRadius.filter((generator) => generator.sheet === "Operable");
  const retiredSince: StatusComparison["retired_since"] = [];
  const absent: string[] = [];
  const changed: StatusComparison["planned_retirement_changed"] = [];
  let still = 0;
  for (const generator of operable) {
    const month = monthly.generators.get(generator.key);
    const annualPlanned = yearMonth(generator.planned_retirement_year, generator.planned_retirement_month);
    if (!month) { absent.push(generator.key); continue; }
    if (month.sheet === "Retired") {
      retiredSince.push({
        key: generator.key, annual_planned_retirement: annualPlanned,
        monthly_retirement: yearMonth(month.retirement_year, month.retirement_month) ?? "(blank)",
        nameplate_mw: generator.nameplate_mw,
        citations: { annual: generator.citations.planned_retirement_year, monthly: month.citations.retirement_year },
      });
      continue;
    }
    still += 1;
    const monthlyPlanned = yearMonth(month.planned_retirement_year, month.planned_retirement_month);
    if (annualPlanned !== monthlyPlanned) changed.push({ key: generator.key, annual: annualPlanned, monthly: monthlyPlanned });
  }
  return {
    annual_reporting_year: data.reporting_year,
    monthly_period: monthly.period,
    annual_operable_at_regenerated_plants: operable.length,
    still_operating: still,
    retired_since: retiredSince,
    absent_from_monthly: absent,
    planned_retirement_changed: changed,
    annual_planned_retirements: operable.filter((generator) => generator.retirement_state === "planned").length,
    annual_completed_retirements_at_regenerated_plants: inRadius.filter((generator) => generator.retirement_state === "completed").length,
  };
}

/* ------------------------------------------------------------------------ */
/* Command                                                                   */
/* ------------------------------------------------------------------------ */

function flag(args: string[], name: string, fallback?: string): string {
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] !== undefined) return args[index + 1];
  if (fallback === undefined) throw new Error(`Missing --${name}`);
  return fallback;
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Parse a `curl -D` header dump (possibly several responses after redirects). */
export function parseCurlHeaders(dump: string): { statuses: number[]; final: Record<string, string> } {
  const statuses: number[] = [];
  let final: Record<string, string> = {};
  for (const line of dump.split(/\r?\n/)) {
    const status = /^HTTP\/[\d.]+\s+(\d{3})/.exec(line);
    if (status) { statuses.push(Number(status[1])); final = {}; continue; }
    const colon = line.indexOf(":");
    if (colon > 0) final[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { statuses, final };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function latestLoadedAssets(root: string): Promise<string | null> {
  const base = resolve(root);
  if (!(await exists(base))) return null;
  for (const location of (await readdir(base)).sort()) {
    const latest = resolve(base, location, "latest.json");
    if (!(await exists(latest))) continue;
    const { revision } = JSON.parse(await readFile(latest, "utf8")) as { revision?: string };
    if (revision && /^[0-9a-f]{64}$/.test(revision)) return resolve(base, location, `${revision}.json`);
  }
  return null;
}

/**
 * eia860 pin   --file F --url U --headers curl-D-dump [--period P] [--out manifest.json]
 * eia860 regen [--zip F] [--manifest M] [--committed public/layers/plants.geojson] [--out-dir D]
 *              [--loaded loaded-assets.json] [--m860 F --m860-manifest M]
 */
export async function runEia860Command(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const dir = `${stateRoot()}/eia860`;
  if (sub === "pin") {
    const file = resolve(flag(rest, "file"));
    const { statuses, final } = parseCurlHeaders(await readFile(resolve(flag(rest, "headers")), "utf8"));
    const bytes = new Uint8Array(await readFile(file));
    if (final["content-length"] && Number(final["content-length"]) !== bytes.length) {
      throw new Error(`Downloaded size ${bytes.length} != Content-Length ${final["content-length"]}`);
    }
    const manifest = {
      url: flag(rest, "url"),
      http_statuses: statuses,
      size_bytes: bytes.length,
      content_length: final["content-length"] ? Number(final["content-length"]) : null,
      content_type: final["content-type"] ?? null,
      last_modified: final["last-modified"] ?? null,
      etag: final.etag ?? null,
      sha256: sha256(bytes),
      file: file.split("/").pop(),
      period: rest.includes("--period") ? flag(rest, "period") : null,
      pinned_at: new Date().toISOString(),
    };
    const out = resolve(flag(rest, "out", `${dir}/manifest.json`));
    await atomicWrite(out, JSON.stringify(manifest, null, 2) + "\n");
    console.log(JSON.stringify({ pinned: out, sha256: manifest.sha256, size: manifest.size_bytes }));
    return;
  }
  if (sub === "regen") {
    const started = Date.now();
    const outDir = resolve(flag(rest, "out-dir", dir));
    const manifestPath = resolve(flag(rest, "manifest", `${dir}/manifest.json`));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { sha256: string; url: string; last_modified: string | null; etag: string | null; size_bytes: number };
    const zipPath = resolve(flag(rest, "zip", `${dir}/raw/eia860${EIA860_REPORTING_YEAR}.zip`));
    const zipBytes = new Uint8Array(await readFile(zipPath));
    const zipSha = sha256(zipBytes);
    if (zipSha !== manifest.sha256) throw new Error(`${zipPath} sha256 ${zipSha} does not match the pinned ${manifest.sha256}`);
    const data = importEia860Archive(zipBytes);
    const importedAt = Date.now();
    const regen = regeneratePlants(data);
    const codes = new Set(regen.features.map((feature) => feature.properties.plant_code));

    const archive = { url: manifest.url, sha256: manifest.sha256, size_bytes: manifest.size_bytes, last_modified: manifest.last_modified, etag: manifest.etag };
    const metadata = {
      source: `EIA-860 ${EIA860_REPORTING_YEAR} annual (${manifest.url})`,
      reporting_year: data.reporting_year,
      center: [CENTER[1], CENTER[0]],
      radius_mi: RADIUS_MI,
      archive,
      workbooks: data.workbooks,
      rules: AGGREGATION_RULES,
    };
    const geojson = { type: "FeatureCollection", metadata, features: regen.features };
    await atomicWrite(resolve(outDir, "regen/plants.geojson"), JSON.stringify(geojson) + "\n");

    // Normalized, cited records for every plant in the radius (with or without
    // Operable generators) and all of their generators across the three sheets.
    const radiusPlants = [...data.plants.values()].filter((plant) =>
      plant.latitude !== null && plant.longitude !== null && greatCircleMiles(CENTER, [plant.longitude, plant.latitude]) <= RADIUS_MI);
    const radiusCodes = new Set(radiusPlants.map((plant) => plant.plant_code));
    const radiusGenerators = data.generators.filter((generator) => radiusCodes.has(generator.plant_code));
    const normalized = {
      schema: "mapergy.eia860-normalized/1",
      reporting_year: data.reporting_year, archive, workbooks: data.workbooks, sheets: data.sheets,
      totals: {
        plants: data.plants.size,
        generators: Object.fromEntries(GENERATOR_SHEETS.map((sheet) => [sheet, data.generators.filter((g) => g.sheet === sheet).length])),
        retirement_state: {
          planned: data.generators.filter((g) => g.retirement_state === "planned").length,
          completed: data.generators.filter((g) => g.retirement_state === "completed").length,
        },
      },
      radius: { center: CENTER, radius_mi: RADIUS_MI, plants: radiusPlants.length, generators: radiusGenerators.length },
      plants: radiusPlants,
      generators: radiusGenerators,
    };
    const normalizedDigest = digest({ plants: radiusPlants, generators: radiusGenerators });
    await atomicWrite(resolve(outDir, "normalized/radius.json"), JSON.stringify({ ...normalized, digest: normalizedDigest }) + "\n");

    const committedPath = resolve(flag(rest, "committed", "public/layers/plants.geojson"));
    const committed = JSON.parse(await readFile(committedPath, "utf8")) as { features: CommittedFeature[] };
    const diff = diffPlants(committed.features, regen.features, data);
    await atomicWrite(resolve(outDir, "regen/diff.json"), JSON.stringify({ committed: committedPath, archive, ...diff }, null, 2) + "\n");

    let join: AtlasJoin | null = null;
    const loadedPath = rest.includes("--loaded") ? resolve(flag(rest, "loaded"))
      : await latestLoadedAssets(`${stateRoot()}/hifld-live/loaded-assets`);
    if (loadedPath && (await exists(loadedPath))) {
      join = joinAtlasPlants(JSON.parse(await readFile(loadedPath, "utf8")), regen.features, data);
      await atomicWrite(resolve(outDir, "join/eia-atlas-plants.json"), JSON.stringify({ loaded_assets: loadedPath, reporting_year: data.reporting_year, ...join }, null, 2) + "\n");
    }

    let monthly: StatusComparison | null = null;
    const m860Path = rest.includes("--m860") ? resolve(flag(rest, "m860")) : null;
    if (m860Path) {
      const m860Manifest = JSON.parse(await readFile(resolve(flag(rest, "m860-manifest")), "utf8")) as { sha256: string; url: string; period: string | null };
      const m860Bytes = new Uint8Array(await readFile(m860Path));
      if (sha256(m860Bytes) !== m860Manifest.sha256) throw new Error(`${m860Path} does not match its pinned sha256`);
      const imported = importEia860M(m860Bytes, m860Path.split("/").pop()!);
      if (m860Manifest.period && m860Manifest.period !== imported.period) {
        throw new Error(`EIA-860M title period ${imported.period} != manifest period ${m860Manifest.period}`);
      }
      monthly = compareMonthly(data, imported, codes);
      await atomicWrite(resolve(outDir, "m860/status-comparison.json"), JSON.stringify({ workbook: m860Manifest, sheets: imported.sheets, ...monthly }, null, 2) + "\n");
    }

    const fieldCounts = Object.fromEntries(Object.entries(diff.fields).map(([field, entry]) => [field, entry.classes]));
    console.log(JSON.stringify({
      wall_ms: Date.now() - started,
      import_ms: importedAt - started,
      plants_on_sheet: data.plants.size,
      generators: normalized.totals.generators,
      retirement_state: normalized.totals.retirement_state,
      plants_within_radius: regen.withinRadius,
      regenerated_features: regen.features.length,
      diff: { committed: diff.committed_features, matched: diff.matched, identical: diff.identical, added: diff.added.length, removed: diff.removed.length, fields: fieldCounts, order_identical: diff.order_identical },
      join: join && { atlas: join.atlas_features, matched: join.matched_regenerated, plant_sheet_only: join.matched_plant_sheet_not_regenerated, unmatched: join.unmatched, regenerated_not_in_atlas: join.regenerated_not_in_atlas, reasons: join.not_regenerated_reasons, names: join.name_agreement },
      monthly: monthly && { period: monthly.monthly_period, operable: monthly.annual_operable_at_regenerated_plants, still_operating: monthly.still_operating, retired_since: monthly.retired_since.length, absent: monthly.absent_from_monthly.length, planned_changed: monthly.planned_retirement_changed.length },
    }, null, 2));
    return;
  }
  throw new Error("Usage: eia860 pin --file F --url U --headers H [--period P] [--out M] | eia860 regen [--zip F] [--manifest M] [--committed F] [--out-dir D] [--loaded F] [--m860 F --m860-manifest M]");
}
