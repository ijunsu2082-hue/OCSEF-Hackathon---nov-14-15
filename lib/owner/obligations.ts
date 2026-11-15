/*
 * Owner obligations engine (pure, no I/O). Given an asset from the public data, list the
 * filings its owner must make, why, when, and the fields we can prefill. Rule text and
 * citations live in rules.ts; this file decides which rules apply and how sure we are.
 *
 * confidence "verified": the rule's threshold is met by facts in our data.
 * confidence "check": it depends on facts we cannot see (emissions, permits, registration,
 * market-based rate authority, utility size, exact district boundary, unit sizes).
 */
import type { Deadline, Obligation, OwnedAsset, PrefillField } from "./types";
import type { FuelKey, Line, Plant, Substation } from "../scan/types";
import { lineMiles, lineName, substationName } from "../scan/labels";
import { POU_WMP, RULES, type QuarterDue, type Roll, type Schedule } from "./rules";

/* ------------------------------------------------------------ small helpers */

const FUEL_LABEL: Record<FuelKey, string> = {
  solar: "solar",
  battery: "battery storage",
  natural_gas: "natural gas",
  wind: "wind",
  hydro: "hydroelectric",
  biogas: "biogas",
  oil: "oil",
  other_gas: "other gas",
  waste_heat: "waste heat",
  other: "other fuel",
};

/** Fuels burned on site (combustion). Biogas counts: CARB and EPA include it in thresholds. */
const COMBUSTION: FuelKey[] = ["natural_gas", "oil", "other_gas", "biogas"];
/** Fossil fuels (Acid Rain Program "fossil fuel-fired"). */
const FOSSIL: FuelKey[] = ["natural_gas", "oil", "other_gas"];
/** Fuels a small power production qualifying facility can use (renewable resources and waste). */
const QF_FUELS: FuelKey[] = ["solar", "wind", "hydro", "biogas", "waste_heat"];
/** GADS conventional units: everything except wind, solar and storage. */
const GADS_CONVENTIONAL: FuelKey[] = ["natural_gas", "oil", "other_gas", "hydro", "biogas", "waste_heat", "other"];

const SCAQMD_COUNTIES = ["Los Angeles", "Orange", "Riverside", "San Bernardino"];

function mw(n: number): string {
  const r = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${r.toLocaleString("en-US")} MW`;
}

function sumMw(p: Plant, fuels: FuelKey[]): number {
  return fuels.reduce((s, f) => s + (p.mw_by_source[f] ?? 0), 0);
}

function fuelsOf(p: Plant): FuelKey[] {
  return (Object.keys(p.mw_by_source) as FuelKey[])
    .filter((f) => (p.mw_by_source[f] ?? 0) > 0)
    .sort((a, b) => (p.mw_by_source[b] ?? 0) - (p.mw_by_source[a] ?? 0));
}

function fuelPhrase(p: Plant): string {
  const fs = fuelsOf(p);
  if (fs.length === 0) return FUEL_LABEL[p.primary_source];
  if (fs.length === 1) return FUEL_LABEL[fs[0]];
  const labels = fs.slice(0, 3).map((f) => FUEL_LABEL[f]);
  return labels.length === 2 ? `${labels[0]} and ${labels[1]}` : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function plantDesc(p: Plant): string {
  return `${mw(p.nameplate_mw)} ${fuelPhrase(p)} plant in ${p.county} County`;
}

/* ------------------------------------------------------------ who owns it */

type OwnerKind = "iou" | "pou" | "other";

interface OwnerInfo {
  kind: OwnerKind;
  /** Display name (as given in the data). */
  name: string;
  /** WSAB schedule key for publicly owned utilities and cooperatives. */
  pouKey?: string;
}

/** Investor-owned utilities regulated by the CPUC (electrical corporations), by name pattern. */
const IOU_PATTERNS: RegExp[] = [
  /southern california edison|so\.? ?cal(ifornia)? edison|^sce$/i,
  /san die?go gas|san deigo gas|sdg&e/i,
  /pacific gas (and|&) electric|^pg&e$/i,
  /bear valley electric/i,
  /liberty utilities/i,
  /pacificorp/i,
];

/** Publicly owned utilities and cooperatives on the WSAB schedule, by name pattern. */
const POU_PATTERNS: [RegExp, string][] = [
  [/los angeles department|ladwp|los angeles dep(ar)?t\.? of water/i, "ladwp"],
  [/anaheim/i, "anaheim"],
  [/anza electric/i, "anza"],
  [/azusa/i, "azusa"],
  [/banning/i, "banning"],
  [/burbank/i, "burbank"],
  [/cerritos/i, "cerritos"],
  [/colton/i, "colton"],
  [/corona/i, "corona"],
  [/glendale/i, "glendale"],
  [/imperial irrigation/i, "iid"],
  [/industry public/i, "industry"],
  [/moreno valley/i, "moreno"],
  [/needles/i, "needles"],
  [/pasadena/i, "pasadena"],
  [/rancho cucamonga/i, "rancho"],
  [/riverside public|city of riverside/i, "riverside"],
  [/vernon/i, "vernon"],
  [/victorville/i, "victorville"],
];

/** Other names that clearly belong to a public agency (GO 167-C excludes their plants). */
const PUBLIC_AGENCY = /^city of |department of water|public utilit|irrigation district|municipal|public power authority|water (and|&) power/i;

export function classifyOwner(name: string | null | undefined): OwnerInfo | null {
  const n = (name ?? "").trim();
  if (!n) return null;
  if (IOU_PATTERNS.some((re) => re.test(n))) return { kind: "iou", name: n };
  for (const [re, key] of POU_PATTERNS) if (re.test(n)) return { kind: "pou", name: n, pouKey: key };
  if (PUBLIC_AGENCY.test(n)) return { kind: "pou", name: n };
  return { kind: "other", name: n };
}

/**
 * Rough test that a point is in Southern or Central California, for map data that reach into
 * Mexico and Nevada. Both borders there are straight lines: Mexico from the Pacific
 * (32.5343 N, 117.1241 W) to the Colorado River (32.7184 N, 114.7195 W); Nevada from Lake Tahoe
 * (39 N, 120 W) to the Colorado River (35.0 N, 114.6333 W). South of 35 N the Colorado River is
 * east of 114.13 W.
 */
export function inCalifornia(lat: number, lon: number): boolean {
  const tMx = (lon - -117.1241) / (-114.7195 - -117.1241);
  if (lat <= 32.5343 + tMx * (32.7184 - 32.5343)) return false;
  if (lat >= 35 && lat <= 39) {
    const nvLon = -120 + ((39 - lat) / (39 - 35)) * (-114.6333 - -120);
    return lon < nvLon;
  }
  return lat < 35 ? lon < -114.13 : lon < -120;
}

/* ------------------------------------------------------------ prefill */

const SRC_EIA = "Form EIA-860, 2025 final data";
const SRC_OSM = "OpenStreetMap, fetched Nov 2026";

function f(label: string, value: string, source: string): PrefillField {
  return { label, value, source };
}

function coord(n: number): string {
  return n.toFixed(5);
}

function plantIdentity(p: Plant): PrefillField[] {
  const out: PrefillField[] = [f("EIA plant code", String(p.plant_code), SRC_EIA)];
  if (p.plant_name) out.push(f("Plant name", p.plant_name, SRC_EIA));
  if (p.utility_name) out.push(f("Operator (EIA utility name)", p.utility_name, SRC_EIA));
  if (p.county) out.push(f("County", p.county, SRC_EIA));
  if (p.city) out.push(f("City", p.city, SRC_EIA));
  out.push(f("Latitude", coord(p.lat), SRC_EIA), f("Longitude", coord(p.lon), SRC_EIA));
  return out;
}

function plantCapacity(p: Plant): PrefillField[] {
  const out: PrefillField[] = [f("Nameplate capacity", mw(p.nameplate_mw), SRC_EIA)];
  for (const fuel of fuelsOf(p)) out.push(f(`Nameplate capacity, ${FUEL_LABEL[fuel]}`, mw(p.mw_by_source[fuel] ?? 0), SRC_EIA));
  if (p.technologies.length) out.push(f("Technologies", p.technologies.join("; "), SRC_EIA));
  if (p.generator_count > 0) out.push(f("Generators", String(p.generator_count), SRC_EIA));
  if (p.oldest_year != null) out.push(f("Oldest generator in service since", String(p.oldest_year), SRC_EIA));
  if (p.newest_year != null) out.push(f("Newest generator in service since", String(p.newest_year), SRC_EIA));
  if (p.planned_retirement_mw > 0) out.push(f("Planned retirements", mw(p.planned_retirement_mw), SRC_EIA));
  if (p.grid_voltage_kv != null) out.push(f("Grid connection voltage", `${Math.round(p.grid_voltage_kv)} kV`, SRC_EIA));
  return out;
}

function plantCombustion(p: Plant): PrefillField[] {
  const out: PrefillField[] = [];
  const fossil = sumMw(p, FOSSIL);
  if (fossil > 0) out.push(f("Fossil fuel capacity", mw(fossil), SRC_EIA));
  const techs = p.technologies.filter((t) => !/solar|wind|batter|hydro/i.test(t));
  if (techs.length) out.push(f("Combustion technologies", techs.join("; "), SRC_EIA));
  if (p.generator_count > 0) out.push(f("Generators", String(p.generator_count), SRC_EIA));
  return out;
}

function kv(v: number | null, inferred?: boolean): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  return inferred ? `${Math.round(v)} kV (from connected lines)` : `${Math.round(v)} kV`;
}

function substationPrefill(s: Substation): PrefillField[] {
  const out: PrefillField[] = [];
  if (s.name) out.push(f("Substation name", s.name, SRC_OSM));
  if (s.operator) out.push(f("Operator", s.operator, SRC_OSM));
  const v = kv(s.voltage_kv, s.kv_inferred);
  if (v) out.push(f("Voltage", v, SRC_OSM));
  if (s.substation) out.push(f("Substation type", s.substation, SRC_OSM));
  out.push(f("Latitude", coord(s.lat), SRC_OSM), f("Longitude", coord(s.lon), SRC_OSM));
  out.push(f("OpenStreetMap id", s.osm_id, SRC_OSM));
  return out;
}

function linePrefill(l: Line): PrefillField[] {
  const out: PrefillField[] = [];
  if (l.name) out.push(f("Line name", l.name, SRC_OSM));
  if (l.operator) out.push(f("Operator", l.operator, SRC_OSM));
  const v = kv(l.voltage_kv, l.kv_inferred);
  if (v) out.push(f("Voltage", v, SRC_OSM));
  if (l.circuits) out.push(f("Circuits", l.circuits, SRC_OSM));
  const miles = lineMiles(l);
  if (miles > 0) out.push(f("Length", `${miles >= 10 ? Math.round(miles) : Math.round(miles * 10) / 10} mi`, "Computed from OpenStreetMap line geometry"));
  out.push(f("OpenStreetMap id", String(l.osm_id), SRC_OSM));
  return out;
}

/* ------------------------------------------------------------ build obligations */

interface Hit {
  id: string;
  appliesBecause: string;
  confidence: "verified" | "check";
  prefill: PrefillField[];
  notes?: string;
}

function toObligation(h: Hit): Obligation {
  const r = RULES[h.id];
  if (!r) throw new Error(`unknown rule ${h.id}`);
  const notes = [r.notes, h.notes].filter(Boolean).join(" ");
  const o: Obligation = {
    id: r.id,
    title: r.title,
    agency: r.agency,
    form: r.form,
    formUrl: r.formUrl,
    appliesBecause: h.appliesBecause,
    frequency: r.frequency,
    dueRule: r.dueRule,
    citations: r.citations.map((c) => ({ ...c })),
    prefill: h.prefill,
    confidence: h.confidence,
  };
  if (notes) o.notes = notes;
  return o;
}

function plantHits(p: Plant): Hit[] {
  const hits: Hit[] = [];
  const desc = plantDesc(p);
  const id = plantIdentity(p);
  const cap = [...id, ...plantCapacity(p)];
  const comb = [...id, ...plantCombustion(p)];
  const atLeast1 = p.nameplate_mw >= 1;
  const combustionMw = sumMw(p, COMBUSTION);
  const fossilMw = sumMw(p, FOSSIL);
  const owner = classifyOwner(p.utility_name);
  const isPou = owner?.kind === "pou";

  /* EIA: plants of 1 MW or more on the grid (our plants come from EIA-860, so they are on it). */
  if (atLeast1) {
    hits.push({
      id: "eia-860",
      appliesBecause: `${desc}; EIA-860 covers grid-connected plants of 1 MW or more.`,
      confidence: "verified",
      prefill: cap,
    });
    hits.push({
      id: "eia-923",
      appliesBecause: `${desc}; EIA-923 is mandatory for grid-connected plants of 1 MW or more.`,
      confidence: "verified",
      prefill: cap,
    });
    hits.push({
      id: "eia-923-monthly",
      appliesBecause: `${desc}; EIA picks a sample of plants to report monthly. Check whether EIA selected this one.`,
      confidence: "check",
      prefill: cap,
    });
    if (p.planned_retirement_mw > 0) {
      hits.push({
        id: "eia-860m",
        appliesBecause: `EIA-860 lists ${mw(p.planned_retirement_mw)} of planned retirements at this plant; monthly updates start 12 months before a generator retires.`,
        confidence: "check",
        prefill: cap,
      });
    }
  }

  /* CEC QFER: owners of California plants; quarterly at 10 MW or more, annual from 1 to 10 MW. */
  if (p.nameplate_mw >= 10) {
    hits.push({
      id: "cec-qfer-quarterly",
      appliesBecause: `${desc}; California plants of 10 MW or more file CEC-1304 every quarter.`,
      confidence: "verified",
      prefill: cap,
    });
  } else if (atLeast1) {
    hits.push({
      id: "cec-qfer-annual",
      appliesBecause: `${desc}; California plants from 1 MW to under 10 MW file CEC-1304 once a year.`,
      confidence: "verified",
      prefill: cap,
    });
  }
  if (p.nameplate_mw >= 50 && (p.primary_source === "natural_gas" || p.primary_source === "solar")) {
    hits.push({
      id: "cec-1304-environmental",
      appliesBecause: `${desc}, mainly ${FUEL_LABEL[p.primary_source]}; natural gas and solar plants of 50 MW or more file Schedule 3.`,
      confidence: "verified",
      prefill: cap,
    });
  }

  /* Greenhouse gases and air quality: only plants that burn fuel. */
  if (combustionMw > 0) {
    hits.push({
      id: "epa-ghgrp",
      appliesBecause: `${desc} with ${mw(combustionMw)} of fuel-burning capacity. EPA reporting depends on whether its units report under 40 CFR part 75, or on its heat input and emissions (25,000 metric tons CO2e), which we cannot see.`,
      confidence: "check",
      prefill: comb,
    });
    hits.push({
      id: "carb-mrr-report",
      appliesBecause: `${desc} with ${mw(combustionMw)} of fuel-burning capacity. CARB reporting depends on part 75 units or emissions of 10,000 metric tons CO2e or more, which we cannot see.`,
      confidence: "check",
      prefill: comb,
    });
    hits.push({
      id: "carb-mrr-verification",
      appliesBecause: `${desc}; verification applies if reported emissions reach 25,000 metric tons CO2e, which we cannot see.`,
      confidence: "check",
      prefill: comb,
    });
    if (SCAQMD_COUNTIES.includes(p.county)) {
      hits.push({
        id: "scaqmd-aer",
        appliesBecause: `${desc}, which South Coast AQMD covers in large part. It applies if the plant is inside the District and emits 4 tons a year or more of NOx, SOx, VOC or PM (or 100 tons of CO).`,
        confidence: "check",
        prefill: comb,
      });
    }
  }
  if (fossilMw > 25) {
    hits.push({
      id: "epa-part75-quarterly",
      appliesBecause: `${desc} with ${mw(fossilMw)} of fossil fuel capacity across ${p.generator_count} generator${p.generator_count === 1 ? "" : "s"}. It applies to each unit serving a generator over 25 MW unless an Acid Rain exemption fits.`,
      confidence: "check",
      prefill: comb,
    });
  }

  /* CPUC GO 167-C: plants and storage in California, 1 MW or more, not owned by a public agency. */
  if (atLeast1 && !isPou) {
    const why = `${desc}; GO 167-C covers power plants and storage of 1 MW or more in California, except qualifying facilities, customer-site units serving their own load and public agency plants.`;
    hits.push({ id: "go167c-incident", appliesBecause: why, confidence: "check", prefill: id });
    hits.push({ id: "go167c-outage", appliesBecause: why, confidence: "check", prefill: id });
    if (p.nameplate_mw >= 50) {
      const why50 = `${desc}; plants and storage of 50 MW or more must meet GO 167-C logbook, maintenance and operation standards.`;
      hits.push({ id: "go167c-maintenance-logbook", appliesBecause: why50, confidence: "check", prefill: cap });
      hits.push({ id: "go167c-operation", appliesBecause: why50, confidence: "check", prefill: cap });
    }
  }

  /*
   * NERC GADS: required for owners on the NERC Compliance Registry. In California, GO 167-C
   * section 9.3.2 also requires the generating asset and storage owners it covers (not public
   * agencies, qualifying facilities or customer-site units serving their own load) to submit
   * the GADS data NERC accepts, whether or not they are registered.
   */
  const gadsGo167c = isPou
    ? " GO 167-C does not cover plants owned by a public agency."
    : " In California, GO 167-C section 9.3.2 also requires the generating asset owners it covers to submit the GADS data NERC accepts, registered or not.";
  const convMw = sumMw(p, GADS_CONVENTIONAL);
  if (convMw >= 20) {
    hits.push({
      id: "nerc-gads-conventional",
      appliesBecause: `${desc} with ${mw(convMw)} of conventional generation. It applies to NERC-registered owners of units of 20 MW or more.${gadsGo167c}`,
      confidence: "check",
      prefill: cap,
    });
  }
  const windMw = p.mw_by_source.wind ?? 0;
  if (windMw >= 75) {
    hits.push({
      id: "nerc-gads-wind",
      appliesBecause: `${mw(windMw)} of wind in ${p.county} County. It applies to NERC-registered Generator Owners if part of the plant began operating in 2005 or later.${gadsGo167c}`,
      confidence: "check",
      prefill: cap,
    });
  }
  const solarMw = p.mw_by_source.solar ?? 0;
  if (solarMw >= 20) {
    hits.push({
      id: "nerc-gads-solar",
      appliesBecause: `${mw(solarMw)} of solar in ${p.county} County. It applies to NERC-registered Generator Owners if the plant began operating in 2010 or later.${gadsGo167c}`,
      confidence: "check",
      prefill: cap,
    });
  }

  /* FERC. */
  if (atLeast1) {
    hits.push({
      id: "ferc-eqr",
      appliesBecause: `${desc}. It applies if the owner sells power at wholesale as a FERC public utility (for example under market-based rate authority), which our data do not show.`,
      confidence: "check",
      prefill: id,
    });
  }
  /*
   * Small power production QF (18 CFR 292.204): the whole facility is at most 80 MW (a), and
   * renewable or waste resources supply at least 75% of the energy input (b). We approximate (b)
   * with nameplate capacity, leaving out storage (it stores energy rather than producing it).
   * Cogeneration QFs (292.205, any size) are not tested here; the rule notes say so.
   */
  const qfMw = sumMw(p, QF_FUELS);
  const producingMw = p.nameplate_mw - (p.mw_by_source.battery ?? 0);
  if (p.nameplate_mw > 1 && p.nameplate_mw <= 80 && qfMw > 0 && qfMw >= 0.75 * producingMw) {
    hits.push({
      id: "ferc-556",
      appliesBecause: `${desc}: ${mw(p.nameplate_mw)} in total, within the 80 MW size limit, with ${mw(qfMw)} from renewable or waste resources (at least 75% of its generating capacity). It applies if the owner seeks qualifying facility status and renewable or waste resources supply at least 75% of the fuel energy.`,
      confidence: "check",
      prefill: cap,
    });
  }

  return hits;
}

function utilityWhy(owner: OwnerInfo | null, what: string): string {
  if (!owner) return `${what}; OpenStreetMap does not name its operator, so check who owns it.`;
  if (owner.kind === "iou") return `${what}, operated by ${owner.name}, an investor-owned utility regulated by the CPUC.`;
  if (owner.kind === "pou") return `${what}, operated by ${owner.name}, a publicly owned utility.`;
  return `${what}, operated by ${owner.name}.`;
}

/** Obligations every utility-owned grid asset shares (lines and substations). */
function utilityHits(owner: OwnerInfo | null, what: string, prefill: PrefillField[]): Hit[] {
  const hits: Hit[] = [];
  const why = utilityWhy(owner, what);
  const kind = owner?.kind ?? null;

  hits.push({
    id: "eia-861",
    appliesBecause: `${why} EIA-861 is filed once per operating company by utilities and transmission owners.`,
    confidence: kind === "iou" || kind === "pou" ? "verified" : "check",
    prefill,
  });
  if (kind !== "pou") {
    hits.push({
      id: "ferc-form-1",
      appliesBecause: `${why} Form 1 applies to Major utilities; check the company's size.`,
      confidence: "check",
      prefill,
    });
    hits.push({
      id: "ferc-form-3q",
      appliesBecause: `${why} Form 3-Q is filed each quarter by the utilities that file Form 1; check the company's size.`,
      confidence: "check",
      prefill,
    });
  }
  if (kind === "iou" || kind === null) {
    hits.push({
      id: "oeis-wmp",
      appliesBecause: `${why} Electrical corporations (investor-owned utilities) file wildfire mitigation plans with Energy Safety.`,
      confidence: kind === "iou" ? "verified" : "check",
      prefill,
    });
  }
  const entry = owner?.pouKey ? POU_WMP.find((p) => p.key === owner.pouKey) : undefined;
  if (entry) {
    hits.push({
      id: `wsab-wmp-${entry.key}`,
      appliesBecause: `${why} The Wildfire Safety Advisory Board's 2026-2029 schedule lists ${entry.name}.`,
      confidence: "verified",
      prefill,
    });
  }
  return hits;
}

function substationHits(s: Substation): Hit[] {
  const owner = classifyOwner(s.operator);
  const vText = kv(s.voltage_kv, s.kv_inferred);
  const what = `${substationName(s)}${vText ? ` (${vText})` : ""}`;
  const prefill = substationPrefill(s);
  if (!inCalifornia(s.lat, s.lon)) return [];
  if (owner?.kind === "other") {
    return [
      {
        id: "eia-861",
        appliesBecause: `${utilityWhy(owner, what)} It applies if the operator is a utility, transmission owner or power producer.`,
        confidence: "check",
        prefill,
      },
    ];
  }
  const hits = utilityHits(owner, what, prefill);
  if (owner?.kind !== "pou") {
    hits.push({
      id: "go174-annual",
      appliesBecause: `${utilityWhy(owner, what)} GO 174 covers CPUC-regulated utilities' substations, except those under CAISO operational control or FERC reliability standards.`,
      confidence: "check",
      prefill,
    });
  }
  return hits;
}

function lineHits(l: Line): Hit[] {
  const inCa = l.coords.filter(([la, lo]) => inCalifornia(la, lo)).length;
  if (inCa === 0) return [];
  const where = inCa === l.coords.length ? "in California" : "partly in California";
  const owner = classifyOwner(l.operator);
  const miles = lineMiles(l);
  const what = `${lineName(l)}, an overhead line about ${miles >= 10 ? Math.round(miles) : Math.round(miles * 10) / 10} mi long ${where}`;
  const prefill = linePrefill(l);
  const hits: Hit[] = [];

  hits.push({
    id: "go95-rule18",
    appliesBecause:
      owner?.kind === "iou"
        ? `${utilityWhy(owner, what)} GO 95 governs overhead lines in California.`
        : owner?.kind === "pou"
          ? `${utilityWhy(owner, what)} The CPUC applies its line safety rules to publicly owned utilities.`
          : `${utilityWhy(owner, what)} GO 95 Rule 18 applies to each company with overhead lines in California.`,
    confidence: owner?.kind === "iou" ? "verified" : "check",
    prefill,
  });
  if (owner?.kind === "other") return hits;

  if (owner?.kind !== "pou") {
    hits.push({
      id: "go165-transmission",
      appliesBecause: `${utilityWhy(owner, what)} GO 165 requires CPUC-regulated utilities to keep transmission inspection procedures and records.`,
      confidence: owner?.kind === "iou" ? "verified" : "check",
      prefill,
    });
    hits.push({
      id: "ferc-881-aar",
      appliesBecause: `${utilityWhy(owner, what)} The October 15, 2027 deadline applies to transmission owners in the CAISO grid.`,
      confidence: "check",
      prefill,
    });
  }
  hits.push(...utilityHits(owner, what, prefill));
  return hits;
}

/* ------------------------------------------------------------ public API */

export function obligationsFor(asset: OwnedAsset): Obligation[] {
  let hits: Hit[];
  if (asset.kind === "plant") hits = plantHits(asset.plant);
  else if (asset.kind === "substation") hits = substationHits(asset.substation);
  else hits = lineHits(asset.line);
  const out = hits.map(toObligation);
  if (asset.kind === "line" && classifyOwner(asset.line.operator)?.kind === "pou") {
    const go95 = out.find((o) => o.id === "go95-rule18");
    go95?.citations.push({
      label: "CPUC D.10-02-034: safety rules for publicly owned utilities' lines",
      url: "https://docs.cpuc.ca.gov/PUBLISHED/FINAL_DECISION/114225-01.htm",
    });
  }
  return out;
}

/** Same list as obligationsFor, for the public preview before a claim is verified. */
export function previewObligations(asset: OwnedAsset): Obligation[] {
  return obligationsFor(asset);
}

/* ------------------------------------------------------------ dates */

function ymd(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function nthWeekday(y: number, m: number, weekday: number, n: number): Date {
  const first = ymd(y, m, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return ymd(y, m, 1 + offset + (n - 1) * 7);
}

function lastWeekday(y: number, m: number, weekday: number): Date {
  const last = ymd(y, m, lastDayOfMonth(y, m));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return addDays(last, -offset);
}

/** U.S. legal public holidays (5 U.S.C. 6103), with Saturday/Sunday holidays observed Friday/Monday. */
function federalHolidays(y: number): Set<string> {
  const fixed = [ymd(y, 1, 1), ymd(y, 6, 19), ymd(y, 7, 4), ymd(y, 11, 11), ymd(y, 12, 25)];
  const floating = [
    nthWeekday(y, 1, 1, 3), // Birthday of Martin Luther King, Jr.
    nthWeekday(y, 2, 1, 3), // Washington's Birthday
    lastWeekday(y, 5, 1), // Memorial Day
    nthWeekday(y, 9, 1, 1), // Labor Day
    nthWeekday(y, 10, 1, 2), // Columbus Day
    nthWeekday(y, 11, 4, 4), // Thanksgiving Day
  ];
  const out = new Set<string>();
  for (const d of fixed) {
    out.add(iso(d));
    if (d.getUTCDay() === 6) out.add(iso(addDays(d, -1)));
    if (d.getUTCDay() === 0) out.add(iso(addDays(d, 1)));
  }
  for (const d of floating) out.add(iso(d));
  return out;
}

function isWeekend(d: Date): boolean {
  const w = d.getUTCDay();
  return w === 0 || w === 6;
}

function isFederalHoliday(d: Date): boolean {
  const k = iso(d);
  const y = d.getUTCFullYear();
  // A Saturday New Year's Day is observed on December 31, which federalHolidays stores in the next year's set.
  return federalHolidays(y).has(k) || federalHolidays(y + 1).has(k);
}

function isBusinessDay(d: Date, roll: Roll): boolean {
  if (isWeekend(d)) return false;
  if (roll === "federal" && isFederalHoliday(d)) return false;
  return true;
}

/** True if `isoDate` (YYYY-MM-DD) is a weekday that is not a U.S. legal public holiday (as observed). */
export function isFederalBusinessDay(isoDate: string): boolean {
  const [y, m, d] = isoDate.split("-").map(Number);
  return isBusinessDay(ymd(y, m, d), "federal");
}

function rollForward(d: Date, roll?: Roll): Date {
  if (!roll) return d;
  let x = d;
  while (!isBusinessDay(x, roll)) x = addDays(x, 1);
  return x;
}

interface Due {
  date: Date;
  label: string;
}

const QUARTER_END: [number, number][] = [
  [3, 31],
  [6, 30],
  [9, 30],
  [12, 31],
];

function quarterDue(q: QuarterDue, year: number): Date {
  return ymd(year + q.yearOffset, q.month, q.day);
}

/** Every due date the schedule produces for reporting periods in [y0, y1]. */
function expand(s: Schedule, y0: number, y1: number): Due[] {
  const out: Due[] = [];
  switch (s.kind) {
    case "none":
      return out;
    case "dates":
      return s.dates.map((d) => {
        const [y, m, dd] = d.due.split("-").map(Number);
        return { date: ymd(y, m, dd), label: d.label };
      });
    case "annual":
      for (let y = y0; y <= y1; y++) {
        const o = s.overrides?.[y];
        let date: Date;
        if (o) {
          const [yy, mm, dd] = o.split("-").map(Number);
          date = ymd(yy, mm, dd);
        } else {
          date = rollForward(ymd(y + 1, s.month, s.day), s.roll);
        }
        out.push({ date, label: `Calendar year ${y}` });
      }
      return out;
    case "annual-last-business-day":
      for (let y = y0; y <= y1; y++) {
        let d = ymd(y + 1, s.month, lastDayOfMonth(y + 1, s.month));
        while (!isBusinessDay(d, "federal")) d = addDays(d, -1);
        out.push({ date: d, label: `Calendar year ${y}` });
      }
      return out;
    case "annual-after-january-open":
      for (let y = y0; y <= y1; y++) {
        const open = rollForward(ymd(y + 1, 1, 1), "federal");
        out.push({ date: addDays(open, s.days), label: `Calendar year ${y}` });
      }
      return out;
    case "quarterly-after":
      for (let y = y0; y <= y1; y++) {
        QUARTER_END.forEach(([m, d], i) => {
          if (s.quarters && !s.quarters.includes((i + 1) as 1 | 2 | 3 | 4)) return;
          out.push({ date: rollForward(addDays(ymd(y, m, d), s.days), s.roll), label: `Q${i + 1} ${y}` });
        });
      }
      return out;
    case "quarterly-dates":
      for (let y = y0; y <= y1; y++) {
        s.due.forEach((q, i) => {
          out.push({ date: rollForward(quarterDue(q, y), s.roll), label: `Q${i + 1} ${y}` });
        });
      }
      return out;
    case "monthly": {
      const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      for (let y = y0; y <= y1; y++) {
        for (let m = 1; m <= 12; m++) {
          const ny = m === 12 ? y + 1 : y;
          const nm = m === 12 ? 1 : m + 1;
          const day = s.day === "last" ? lastDayOfMonth(ny, nm) : s.day;
          out.push({ date: ymd(ny, nm, day), label: `${MONTHS[m - 1]} ${y}` });
        }
      }
      return out;
    }
  }
}

/**
 * Concrete due dates from `from` through `from + months` (both ends included), sorted by date
 * and then obligation id. Event-driven obligations and plans without a set date produce none.
 * Dates move off weekends and holidays only where the rule itself says so.
 */
export function deadlinesFor(obligations: Obligation[], from: Date, months: number): Deadline[] {
  const start = ymd(from.getUTCFullYear(), from.getUTCMonth() + 1, from.getUTCDate());
  const endMonthIndex = start.getUTCMonth() + months;
  const endY = start.getUTCFullYear() + Math.floor(endMonthIndex / 12);
  const endM = (endMonthIndex % 12) + 1;
  const end = ymd(endY, endM, Math.min(start.getUTCDate(), lastDayOfMonth(endY, endM)));

  const out: Deadline[] = [];
  const seen = new Set<string>();
  for (const o of obligations) {
    const rule = RULES[o.id];
    if (!rule) continue;
    for (const d of expand(rule.schedule, start.getUTCFullYear() - 2, end.getUTCFullYear())) {
      if (d.date < start || d.date > end) continue;
      const key = `${o.id}|${iso(d.date)}|${d.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ obligationId: o.id, due: iso(d.date), periodLabel: d.label });
    }
  }
  out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.obligationId < b.obligationId ? -1 : a.obligationId > b.obligationId ? 1 : 0));
  return out;
}
