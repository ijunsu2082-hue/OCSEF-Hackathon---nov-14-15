import type {
  DailyRating, FuelKey, GenEvent, GridData, Line, NicheCase, Plant, RatingSiteSummary, Substation,
} from "./types";
import { haversineMi } from "./geo";
import { lineIndex } from "./lineIndex";
import { enrichGrid } from "./enrich";

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

async function getText(path: string): Promise<string> {
  const res = await fetch(`${LAYERS_BASE}/${path}`);
  if (!res.ok) throw new Error(`GET ${LAYERS_BASE}/${path} -> ${res.status}`);
  return res.text();
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
    };
  });
}

let gridPromise: Promise<GridData> | null = null;

export function loadGridData(): Promise<GridData> {
  if (!gridPromise) {
    gridPromise = (async () => {
      const [plants, lines, subs, cases, events, summary] = await Promise.all([
        getJson<FC<PointG, Record<string, unknown>>>("plants.geojson"),
        getJson<FC<LineG, Record<string, unknown>>>("transmission.geojson"),
        getJson<FC<PointG, Record<string, unknown>>>("substations.geojson"),
        getJson<NicheCase[]>("niche_cases.json"),
        getJson<GenEvent[]>("gen_events.json"),
        getJson<SummaryJson>("line_ratings/summary.json"),
      ]);
      const data: GridData = {
        plants: plants.features.filter((f) => f.geometry?.type === "Point").map(toPlant),
        lines: lines.features.filter((f) => f.geometry?.type === "LineString" && f.geometry.coordinates.length >= 2).map(toLine),
        substations: subs.features.filter((f) => f.geometry?.type === "Point").map(toSubstation),
        cases,
        events,
        ratingSites: toSites(summary),
      };
      enrichGrid(data); // fill missing voltages / names from connected data, once per load
      lineIndex(data); // precompute segment lengths so the first scanArea() stays fast
      return data;
    })();
    gridPromise.catch(() => { gridPromise = null; }); // allow retry after a failed load
  }
  return gridPromise;
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

const csvCache = new Map<string, Promise<RatingRow[]>>();

export function loadRatingCsv(siteKey: string): Promise<RatingRow[]> {
  let p = csvCache.get(siteKey);
  if (!p) {
    p = getText(`line_ratings/line_rating_2025_${siteKey}.csv`).then((text) => {
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
