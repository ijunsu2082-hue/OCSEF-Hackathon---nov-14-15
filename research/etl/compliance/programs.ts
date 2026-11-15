/*
 * ETL: read the agency lists that decide whether a filing applies, and match them to
 * the plants on the map.
 *
 * Right now that is EPA's Greenhouse Gas Reporting Program. Its Envirofacts tables are
 * public and need no key:
 *   GHG/PUB_DIM_FACILITY            one row per reporting facility, with lat/lon
 *   GHG/PUB_FACTS_SECTOR_GHG_EMISSION  reported CO2e by facility and year
 *
 * A plant is matched to a facility by coordinates (closest within MATCH_MI). The match
 * is recorded with its distance and the reported emissions, so the compliance section
 * can say "EPA's list has this plant, 0.4 mi away, 412,000 t CO2e for 2023" instead of
 * asking the owner to check.
 *
 * A list that cannot be read is written into `unavailable`, and the app keeps the
 * question for that program instead of guessing in either direction.
 */
import { readFile } from "node:fs/promises";
import { requestBytes } from "../http";
import { atomicJson } from "../pipeline";
import {
  APPLICABILITY_SCHEMA,
  type GhgrpFacility,
  type GhgrpNearMiss,
  type ProgramIndex,
} from "../../../lib/owner/applicability";

export const DEFAULT_OUT = "public/compliance/applicability.json";
export const PLANTS_PATH = "public/layers/plants.geojson";

/**
 * One row per facility and reporting year. The whole CA slice is about 8,300 rows and
 * 5 MB, so the job asks county by county for just the counties our plants are in.
 */
const GHGRP_COUNTY = (county: string) =>
  `https://data.epa.gov/efservice/GHG/PUB_DIM_FACILITY/STATE/CONTAINING/CA/COUNTY/CONTAINING/${encodeURIComponent(
    county.toUpperCase(),
  )}/rows/0:9000/JSON`;
const GHGRP_EMISSIONS = (facilityId: string) =>
  `https://data.epa.gov/efservice/GHG/PUB_FACTS_SECTOR_GHG_EMISSION/FACILITY_ID/='${facilityId}'/rows/0:500/JSON`;

/**
 * A plant and a GHGRP facility are the same site when they sit on top of each other
 * (the two datasets often share coordinates), or when they are close and share a name
 * word. Distance alone at 1.5 mi would attach a plant to a neighbouring refinery.
 */
const SAME_SITE_MI = 0.25;
const MATCH_MI = 1.5;
/** Inside this radius an untied facility is a near miss (a question), not a "no". */
const NEAR_MI = 1;
/** Nearest-listed-facility distances are recorded up to here, for the "how far" note. */
const NEAREST_MI = 50;
/** Cap on emissions lookups per run; the rest keep a null figure rather than a wrong one. */
const MAX_EMISSION_LOOKUPS = 200;

export interface ProgramsOptions {
  offline?: boolean;
  out?: string;
  plantsPath?: string;
  /** Fetch each matched facility's reported CO2e (one EPA request each; slow and rate limited). */
  withEmissions?: boolean;
}

export interface ProgramsSummary {
  out: string;
  plants: number;
  ca_facilities: number;
  matched: number;
  near_misses: number;
  with_emissions: number;
  unavailable: string[];
}

interface RawFacility {
  facility_id?: unknown;
  facility_name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

interface RawEmission {
  year?: unknown;
  co2e_emission?: unknown;
}

interface OurPlant {
  plant_code: number;
  plant_name: string;
  county: string | null;
  lat: number;
  lon: number;
}

async function getJson(url: string): Promise<unknown> {
  const res = await requestBytes(new URL(url), {
    accept: "application/json",
    userAgent: process.env.COMPLIANCE_USER_AGENT || "GridSentinel/1.0 (compliance applicability)",
    maxBytes: 16 * 1024 * 1024,
    timeoutMs: 30000,
  });
  return JSON.parse(Buffer.from(res.bytes).toString("utf8"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

/** Great-circle miles; the same test the app uses for "near this point". */
function words(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3 && !["power", "plant", "station", "energy", "generating", "generation", "llc", "inc"].includes(w)),
  );
}

function sameName(a: string, b: string): boolean {
  const left = words(a);
  for (const w of words(b)) if (left.has(w)) return true;
  return false;
}

function miles(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 3958.7613;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

async function ourPlants(path: string): Promise<OurPlant[]> {
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    features?: { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> }[];
  };
  const out: OurPlant[] = [];
  for (const f of raw.features ?? []) {
    const coords = f.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = num(coords[0]);
    const lat = num(coords[1]);
    const code = num(f.properties?.plant_code);
    if (lat == null || lon == null || code == null) continue;
    out.push({
      plant_code: code,
      plant_name: str(f.properties?.plant_name),
      county: str(f.properties?.county) || null,
      lat,
      lon,
    });
  }
  return out;
}

/** Reported CO2e for the latest year EPA lists for this facility, or null. */
async function reportedEmissions(facilityId: string): Promise<{ year: number | null; tons: number | null }> {
  const rows = (await getJson(GHGRP_EMISSIONS(facilityId))) as RawEmission[];
  if (!Array.isArray(rows)) return { year: null, tons: null };
  const byYear = new Map<number, number>();
  for (const row of rows) {
    const year = num(row.year);
    const value = num(row.co2e_emission);
    if (year == null || value == null) continue;
    byYear.set(year, (byYear.get(year) ?? 0) + value);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);
  if (years.length === 0) return { year: null, tons: null };
  return { year: years[0], tons: Math.round(byYear.get(years[0]) ?? 0) };
}

export async function syncApplicability(options: ProgramsOptions = {}): Promise<ProgramsSummary> {
  const out = options.out ?? DEFAULT_OUT;
  const plants = await ourPlants(options.plantsPath ?? PLANTS_PATH);
  const unavailable: string[] = [];
  const ghgrp: Record<string, GhgrpFacility> = {};
  const nearMisses: Record<string, GhgrpNearMiss> = {};
  const nearestFacilities: Record<string, GhgrpNearMiss> = {};
  const countiesRead: Record<string, { facilities: number }> = {};
  let caFacilities = 0;

  if (options.offline) {
    unavailable.push("ghgrp");
  } else {
    try {
      // Keep one row per facility (the table repeats facilities by reporting year).
      const seen = new Set<string>();
      const facilities: { id: string; name: string; lat: number; lon: number }[] = [];
      const counties = [...new Set(plants.map((p) => p.county?.trim()).filter((c): c is string => !!c))];
      if (counties.length === 0) throw new Error("no counties in the plant data");
      for (const [index, county] of counties.entries()) {
        // EPA's Envirofacts answers 429 when a run walks counties too quickly.
        if (index > 0) await sleep(1500);
        let rows: RawFacility[] = [];
        try {
          const body = (await getJson(GHGRP_COUNTY(county))) as RawFacility[];
          if (Array.isArray(body)) rows = body;
        } catch (error) {
          console.error(
            `${county}: GHGRP rows not read: ${error instanceof Error ? error.message : "unknown error"}`,
          );
          unavailable.push(`ghgrp:${county}`);
          continue;
        }
        const uniqueInCounty = new Set(rows.map((row) => str(row.facility_id)).filter(Boolean));
        countiesRead[county] = { facilities: uniqueInCounty.size };
        for (const row of rows) {
          const id = str(row.facility_id);
          const lat = num(row.latitude);
          const lon = num(row.longitude);
          if (!id || lat == null || lon == null || seen.has(id)) continue;
          seen.add(id);
          facilities.push({ id, name: str(row.facility_name), lat, lon });
        }
      }
      caFacilities = facilities.length;
      if (facilities.length === 0) throw new Error("no facility rows read for any county");

      const matches: {
        plant: OurPlant;
        facility: (typeof facilities)[number];
        distance: number;
        nameMatched: boolean;
      }[] = [];
      for (const plant of plants) {
        let best: { facility: (typeof facilities)[number]; distance: number; nameMatched: boolean } | null = null;
        // Nearest facility of any kind, so a near-but-untied reporter is recorded rather
        // than silently read as "this plant is not in the program".
        let nearest: { facility: (typeof facilities)[number]; distance: number } | null = null;
        for (const facility of facilities) {
          const d = miles(plant.lat, plant.lon, facility.lat, facility.lon);
          if (!nearest || d < nearest.distance) nearest = { facility, distance: d };
          if (d > MATCH_MI) continue;
          const named = sameName(plant.plant_name, facility.name);
          if (d > SAME_SITE_MI && !named) continue;
          if (!best || d < best.distance) best = { facility, distance: d, nameMatched: named };
        }
        if (best) {
          matches.push({ plant, facility: best.facility, distance: best.distance, nameMatched: best.nameMatched });
          continue;
        }
        if (!nearest || nearest.distance > NEAREST_MI) continue;
        const entry = {
          facility_id: nearest.facility.id,
          facility_name: nearest.facility.name || `GHGRP facility ${nearest.facility.id}`,
          distance_mi: Math.round(nearest.distance * 100) / 100,
        };
        nearestFacilities[String(plant.plant_code)] = entry;
        if (nearest.distance <= NEAR_MI) nearMisses[String(plant.plant_code)] = entry;
      }

      // Reported emissions are a separate table and a request per facility. EPA rate
      // limits the shared Envirofacts API, so this stays off unless asked for; GHGRP
      // membership on its own already means 25,000 t CO2e or more.
      const emissions = new Map<string, { year: number | null; tons: number | null }>();
      if (options.withEmissions) {
        const uniqueIds = [...new Set(matches.map((m) => m.facility.id))].slice(0, MAX_EMISSION_LOOKUPS);
        for (const [index, id] of uniqueIds.entries()) {
          if (index > 0) await sleep(1200);
          try {
            emissions.set(id, await reportedEmissions(id));
          } catch {
            emissions.set(id, { year: null, tons: null });
          }
        }
      }

      for (const m of matches) {
        const reported = emissions.get(m.facility.id);
        ghgrp[String(m.plant.plant_code)] = {
          facility_id: m.facility.id,
          facility_name: m.facility.name || `GHGRP facility ${m.facility.id}`,
          distance_mi: Math.round(m.distance * 100) / 100,
          year: reported?.year ?? null,
          co2e_tons: reported?.tons ?? null,
          name_matched: m.nameMatched,
        };
      }
    } catch (error) {
      unavailable.push("ghgrp");
      console.error(
        `GHGRP list not read: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  const index: ProgramIndex = {
    schema: APPLICABILITY_SCHEMA,
    generated_at: new Date().toISOString(),
    ghgrp,
    ghgrp_near: nearMisses,
    ghgrp_nearest: nearestFacilities,
    counties: countiesRead,
    unavailable,
  };
  await atomicJson(out, index);

  return {
    out,
    plants: plants.length,
    ca_facilities: caFacilities,
    matched: Object.keys(ghgrp).length,
    near_misses: Object.keys(nearMisses).length,
    with_emissions: Object.values(ghgrp).filter((g) => g.co2e_tons != null).length,
    unavailable,
  };
}
