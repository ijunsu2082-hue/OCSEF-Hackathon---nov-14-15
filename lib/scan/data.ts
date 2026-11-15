import type {
  DailyRating, FuelKey, GenEvent, GridData, Line, NicheCase, Plant, RatingSiteSummary, Substation,
} from "./types";
import { haversineMi } from "./geo";
import { lineIndex } from "./lineIndex";
import {
  fetchEtlAssets, type EtlProvenance, type EtlSourceSelector,
  type EtlSubstationFeature, type EtlTransmissionFeature,
} from "../etlAssets";
import { enrichGrid, type SubstationNames } from "./enrich";

export const LAYERS_BASE = "/layers";

/** The 7 line-rating weather sites (coords match research/data/weather). */
export const RATING_SITES: { key: string; name: string; lat: number; lon: number }[] = [
  { key: "westminster_hs", name: "Westminster HS", lat: 33.778557, lon: -117.98506 },
  { key: "irvine", name: "Irvine", lat: 33.70826, lon: -117.8385 },
  { key: "la_basin_downtown", name: "Downtown LA", lat: 34.059753, lon: -118.2375 },
  { key: "santa_ana_canyon", name: "Santa Ana Canyon", lat: 33.848858, lon: -117.79576 },
  { key: "san_gorgonio_pass", name: "San Gorgonio Pass", lat: 33.919155, lon: -116.59601 },
  { key: "inland_empire_riverside", name: "Riverside", lat: 33.989452, lon: -117.415726 },
  { key: "san_onofre", name: "San Onofre", lat: 33.427063, lon: -117.589615 },
];

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${LAYERS_BASE}/${path}`);
  if (!res.ok) throw new Error(`GET ${LAYERS_BASE}/${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Like getJson, but a 404 means "not shipped on this branch" and yields null. */
async function getJsonIfPresent<T>(path: string): Promise<T | null> {
  const res = await fetch(`${LAYERS_BASE}/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${LAYERS_BASE}/${path} -> ${res.status}`);
  return (await res.json()) as T;
}

interface Feature<G, P> { geometry: G; properties: P }
interface FC<G, P> { features: Feature<G, P>[] }
type PointG = { type: "Point"; coordinates: [number, number] };
type LineG = { type: "LineString"; coordinates: [number, number][] };

const numOrNull = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;
const strOrNull = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);

function toPlant(f: Feature<PointG, Record<string, unknown>>): Plant {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  return {
    plant_code: Number(p.plant_code),
    plant_name: String(p.plant_name ?? ""),
    utility_name: String(p.utility_name ?? ""),
    city: String(p.city ?? ""),
    county: String(p.county ?? ""),
    nameplate_mw: numOrNull(p.nameplate_mw) ?? 0,
    mw_by_source: (p.mw_by_source ?? {}) as Partial<Record<FuelKey, number>>,
    primary_source: (p.primary_source ?? "other") as FuelKey,
    technologies: Array.isArray(p.technologies) ? (p.technologies as string[]) : [],
    oldest_year: numOrNull(p.oldest_year),
    newest_year: numOrNull(p.newest_year),
    capacity_weighted_year: numOrNull(p.capacity_weighted_year),
    capacity_weighted_age_years: numOrNull(p.capacity_weighted_age_years),
    planned_retirement_mw: numOrNull(p.planned_retirement_mw) ?? 0,
    generator_count: numOrNull(p.generator_count) ?? 0,
    grid_voltage_kv: numOrNull(p.grid_voltage_kv),
    lat, lon,
  };
}

function toLine(f: Feature<LineG, Record<string, unknown>>): Line {
  const p = f.properties;
  return {
    osm_id: Number(p.osm_id),
    voltage_kv: numOrNull(p.voltage_kv),
    operator: strOrNull(p.operator),
    name: strOrNull(p.name),
    circuits: strOrNull(p.circuits),
    coords: f.geometry.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]),
  };
}

function toSubstation(f: Feature<PointG, Record<string, unknown>>): Substation {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  return {
    osm_id: String(p.osm_id),
    name: strOrNull(p.name),
    operator: strOrNull(p.operator),
    voltage_kv: numOrNull(p.voltage_kv),
    substation: strOrNull(p.substation),
    lat, lon,
  };
}

type SummaryJson = Record<string, Partial<Omit<RatingSiteSummary, "key" | "name" | "lat" | "lon">>>;

function toSites(summary: SummaryJson): RatingSiteSummary[] {
  return RATING_SITES.map((s) => {
    const j = summary[s.key] ?? {};
    return {
      ...s,
      median_conservative_dlr_vs_static: j.median_conservative_dlr_vs_static ?? 1,
      pct_hours_conservative_dlr_above_static: j.pct_hours_conservative_dlr_above_static ?? 0,
      summer_4to8pm_median_wind_gain_over_aar: j.summer_4to8pm_median_wind_gain_over_aar ?? 1,
      hottest_hour: j.hottest_hour ?? "",
      hottest_temp_c: j.hottest_temp_c ?? 0,
      hottest_hour_dlr_vs_static: j.hottest_hour_dlr_vs_static ?? 1,
      median_aar_vs_static: j.median_aar_vs_static,
      median_wind_gain_over_aar: j.median_wind_gain_over_aar,
    };
  });
}

type LayerSource = "etl" | "bundled";

/** GridData plus where each layer came from and which bundled files are absent. */
export interface LoadedGridData extends GridData {
  /** "etl" when at least one layer came from the location's loaded assets. */
  source: LayerSource;
  layers: { plants: LayerSource; lines: LayerSource; substations: LayerSource };
  /**
   * Bundled files that 404 (gen_events.json, line_ratings/summary.json are not
   * shipped on this branch). Absent events → `events: []`; absent summary →
   * `ratingSites` carry toSites() placeholder figures, not measured ones.
   */
  unavailable: string[];
  /** Why a selected ETL layer was not used. Empty without a selector. */
  fallback_reasons: string[];
  etl: { location: string; revision: string; report_revision: string | null } | null;
}

/**
 * ETL lines carry no OSM id or circuit tag; `osm_id` is NaN, `circuits` null.
 * HIFLD OWNER stays `owner`; `operator` is null (HIFLD publishes no operator).
 */
function etlLine(f: EtlTransmissionFeature): Line & { owner: string | null; etl: EtlProvenance } {
  return {
    osm_id: Number.NaN,
    voltage_kv: f.properties.voltage_kv,
    operator: f.properties.operator,
    owner: f.properties.owner,
    name: f.properties.name,
    circuits: null,
    coords: f.geometry.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]),
    etl: f.etl,
  };
}

/** HIFLD substations carry no OSM id, `substation=*` class, owner or operator; `osm_id` is "". */
function etlSubstation(f: EtlSubstationFeature): Substation & { owner: string | null; etl: EtlProvenance } {
  const [lon, lat] = f.geometry.coordinates;
  return {
    osm_id: "",
    name: f.properties.name,
    operator: f.properties.operator,
    owner: f.properties.owner,
    voltage_kv: f.properties.voltage_kv,
    substation: null,
    lat, lon,
    etl: f.etl,
  };
}

const gridCache = new Map<string, Promise<LoadedGridData>>();
const BUNDLED_KEY = "bundled";

async function buildGridData(selector: EtlSourceSelector | undefined): Promise<LoadedGridData> {
  const [plants, lines, subs, cases, events, summary, subNames, loaded] = await Promise.all([
    getJson<FC<PointG, Record<string, unknown>>>("plants.geojson"),
    getJson<FC<LineG, Record<string, unknown>>>("transmission.geojson"),
    getJson<FC<PointG, Record<string, unknown>>>("substations.geojson"),
    getJson<NicheCase[]>("niche_cases.json"),
    getJsonIfPresent<GenEvent[]>("gen_events.json"),
    getJsonIfPresent<SummaryJson>("line_ratings/summary.json"),
    // Optional: a missing or broken names file just leaves OSM names as they are.
    getJson<SubstationNames>("substation_names.json").catch(() => null),
    selector ? fetchEtlAssets(selector) : Promise.resolve(null),
  ]);
  const unavailable: string[] = [];
  if (events === null) unavailable.push(`${LAYERS_BASE}/gen_events.json`);
  if (summary === null) unavailable.push(`${LAYERS_BASE}/line_ratings/summary.json`);
  const data: LoadedGridData = {
    plants: plants.features.filter((f) => f.geometry?.type === "Point").map(toPlant),
    lines: lines.features.filter((f) => f.geometry?.type === "LineString" && f.geometry.coordinates.length >= 2).map(toLine),
    substations: subs.features.filter((f) => f.geometry?.type === "Point").map(toSubstation),
    cases,
    events: events ?? [],
    ratingSites: toSites(summary ?? {}),
    source: "bundled",
    layers: { plants: "bundled", lines: "bundled", substations: "bundled" },
    unavailable,
    fallback_reasons: [],
    etl: null,
  };
  // Fill missing voltages / names in the bundled OSM layers, once per load. It runs
  // before the ETL swap so provider (HIFLD) nulls stay null instead of being inferred.
  enrichGrid(data, subNames);
  if (loaded && !loaded.ok) data.fallback_reasons.push(loaded.reason);
  if (loaded?.ok) {
    const { assets } = loaded;
    data.etl = { location: assets.location, revision: assets.revision, report_revision: loaded.reportRevision };
    if (assets.transmission) {
      data.lines = assets.transmission.features.map(etlLine);
      data.layers.lines = "etl";
    } else data.fallback_reasons.push("loaded assets have no transmission dataset");
    if (assets.substations) {
      data.substations = assets.substations.features.map(etlSubstation);
      data.layers.substations = "etl";
    } else data.fallback_reasons.push("loaded assets have no substation dataset");
    // Scan scoring sums nameplate MW and fuel mix, which the loaded plant
    // inventory does not carry; mapping it would score every plant as 0 MW.
    data.fallback_reasons.push(assets.plants
      ? "loaded plant dataset has no nameplate MW or fuel mix; bundled plants kept for scoring"
      : "loaded assets have no plant dataset");
    if (data.layers.lines === "etl" || data.layers.substations === "etl") data.source = "etl";
  }
  lineIndex(data); // precompute segment lengths so the first scanArea() stays fast
  return data;
}

/**
 * Grid data for the scan. With no selector this reads the bundled layers; with
 * `{ locationId, reportRevision? }` lines and substations come from that
 * location's loaded ETL assets when available. Cached per location + revision.
 */
export function loadGridData(selector?: EtlSourceSelector): Promise<LoadedGridData> {
  const key = selector ? `etl:${selector.locationId ?? ""}:${selector.reportRevision ?? "latest"}` : BUNDLED_KEY;
  let pending = gridCache.get(key);
  if (!pending) {
    pending = buildGridData(selector);
    gridCache.set(key, pending);
    pending.then(
      // An unavailable ETL load is not pinned, so a later call can pick up assets loaded since.
      (data) => { if (selector && data.etl === null) gridCache.delete(key); },
      () => { gridCache.delete(key); }, // allow retry after a failed load
    );
  }
  return pending;
}

export function nearestSite(sites: RatingSiteSummary[], lat: number, lon: number): RatingSiteSummary & { distance_mi: number } {
  let best = sites[0];
  let bestD = Infinity;
  for (const s of sites) {
    const d = haversineMi(lat, lon, s.lat, s.lon);
    if (d < bestD) { bestD = d; best = s; }
  }
  return { ...best, distance_mi: Math.round(bestD * 10) / 10 };
}

// ---------- line-rating CSVs ----------

export interface RatingRow {
  time: string; temp_c: number; wind_ms: number; sun_wm2: number;
  static_A: number; aar_A: number; dlr_A: number; dlr_conservative_A: number;
}

/**
 * The one place the committed hourly line-rating archive URL is built. Files
 * ship flat in `public/layers/` (`line_rating_<year>_<site>.csv`); only
 * `westminster_hs` is committed, so other sites 404 here.
 */
export function ratingCsvUrl(siteKey: string, year: 2024 | 2025 = 2025): string {
  return `${LAYERS_BASE}/line_rating_${year}_${siteKey}.csv`;
}

/** Per-site 2025 archive that scripts/sync-layers.mjs copies into `public/layers/line_ratings/` (gitignored). */
function syncedRatingCsvUrl(siteKey: string): string {
  return `${LAYERS_BASE}/line_ratings/line_rating_2025_${siteKey}.csv`;
}

const csvCache = new Map<string, Promise<RatingRow[]>>();

/** Committed flat file first; on a 404, the synced per-site copy (every rating site once sync-layers has run). */
async function getRatingCsvText(siteKey: string): Promise<string> {
  const url = ratingCsvUrl(siteKey);
  const res = await fetch(url);
  if (res.ok) return res.text();
  if (res.status !== 404) throw new Error(`GET ${url} -> ${res.status}`);
  const synced = syncedRatingCsvUrl(siteKey);
  const res2 = await fetch(synced);
  if (!res2.ok) throw new Error(`GET ${synced} -> ${res2.status}`);
  return res2.text();
}

export function loadRatingCsv(siteKey: string): Promise<RatingRow[]> {
  let p = csvCache.get(siteKey);
  if (!p) {
    p = getRatingCsvText(siteKey).then((text) => {
      const out: RatingRow[] = [];
      const lines = text.split(/\r?\n/);
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(",");
        if (c.length < 8) continue;
        out.push({
          time: c[0], temp_c: +c[1], wind_ms: +c[2], sun_wm2: +c[3],
          static_A: +c[4], aar_A: +c[5], dlr_A: +c[6], dlr_conservative_A: +c[7],
        });
      }
      return out;
    });
    p.catch(() => csvCache.delete(siteKey));
    csvCache.set(siteKey, p);
  }
  return p;
}

const dailyCache = new Map<string, Promise<DailyRating[]>>();

export function loadDailyRatings(siteKey: string): Promise<DailyRating[]> {
  let p = dailyCache.get(siteKey);
  if (!p) {
    p = loadRatingCsv(siteKey).then((rows) => {
      const byDate = new Map<string, RatingRow[]>();
      for (const r of rows) {
        const d = r.time.slice(0, 10);
        const arr = byDate.get(d);
        if (arr) arr.push(r); else byDate.set(d, [r]);
      }
      const out: DailyRating[] = [];
      for (const [date, rs] of byDate) {
        const c = rs.map((r) => r.dlr_conservative_A).sort((a, b) => a - b);
        const n = c.length;
        const median = n % 2 ? c[(n - 1) / 2] : (c[n / 2 - 1] + c[n / 2]) / 2;
        out.push({
          date,
          static_A: rs[0].static_A,
          worst_A: c[0],
          median_A: Math.round(median),
          max_temp_c: Math.max(...rs.map((r) => r.temp_c)),
        });
      }
      return out;
    });
    p.catch(() => dailyCache.delete(siteKey));
    dailyCache.set(siteKey, p);
  }
  return p;
}
