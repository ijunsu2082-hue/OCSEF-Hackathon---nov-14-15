// Copies research layers into public/layers and builds public/layers/gen_events.json.
// Plain Node ESM, no dependencies. Run: node scripts/sync-layers.mjs
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "layers");
const OUT_RATINGS = join(OUT, "line_ratings");
const RESEARCH = join(ROOT, "research");

mkdirSync(OUT_RATINGS, { recursive: true });

// 1. Static layers
for (const f of ["plants.geojson", "transmission.geojson", "substations.geojson", "niche_cases.json",
  // niche_cases.json chart.data_url points at /layers/line_rating_2024_westminster_hs.csv
  "line_rating_2024_westminster_hs.csv"]) {
  copyFileSync(join(RESEARCH, "layers", f), join(OUT, f));
}

// 2. Line ratings
const ratingsDir = join(RESEARCH, "data", "line_ratings");
let ratingFiles = 0;
for (const f of readdirSync(ratingsDir)) {
  if (f.endsWith(".csv") || f === "summary.json") {
    copyFileSync(join(ratingsDir, f), join(OUT_RATINGS, f));
    ratingFiles++;
  }
}

// 3. Generator events
/** RFC 4180-style CSV parser (quoted fields, escaped quotes, CRLF). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", i = 0, q = false;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.filter((r) => r.length > 1 || r[0] !== "").map((r) =>
    Object.fromEntries(header.map((h, j) => [h.trim(), (r[j] ?? "").trim()])));
}

const FUEL = {
  SUN: "solar", MWH: "battery", NG: "natural_gas", WND: "wind", WAT: "hydro",
  LFG: "biogas", OBG: "biogas", AB: "biogas", MSW: "biogas", OBS: "biogas", WDS: "biogas", BLQ: "biogas", OBL: "biogas",
  DFO: "oil", RFO: "oil", JF: "oil", KER: "oil", WO: "oil",
  OG: "other_gas", BFG: "other_gas", PG: "other_gas", SGC: "other_gas",
  WH: "waste_heat",
};
const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };
const year = (s) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : null; };

function events(file, kind, yearCol, keepStatus) {
  const rows = parseCsv(readFileSync(join(RESEARCH, "data", "plants", file), "utf8"));
  const out = [];
  for (const r of rows) {
    if (keepStatus && !keepStatus(r["Status"])) continue;
    const lat = num(r.lat), lon = num(r.lon);
    if (lat === null || lon === null) continue;
    out.push({
      kind,
      plant_name: r["Plant Name"],
      technology: r["Technology"],
      fuel: FUEL[r["Energy Source 1"]] ?? "other",
      mw: num(r["Nameplate Capacity (MW)"]) ?? 0,
      year: year(r[yearCol]),
      lat, lon,
    });
  }
  return out;
}

const gen = [
  // The EIA-860 "Retired and Canceled" sheet also holds CN (canceled) and IP (indefinitely postponed)
  // projects that never ran; only RE rows are real retirements.
  ...events("retired_generators_westminster100mi.csv", "retired", "Retirement Year", (s) => s === "RE"),
  // EIA-860 Proposed sheet: "Current Year" is the currently planned operating year; "Effective Year"
  // is when the status took effect (can be years in the past, e.g. 2016).
  ...events("proposed_generators_westminster100mi.csv", "proposed", "Current Year"),
];
writeFileSync(join(OUT, "gen_events.json"), JSON.stringify(gen));
console.log(`sync-layers: 5 layer files, ${ratingFiles} line-rating files, ${gen.length} gen events -> ${OUT}`);
