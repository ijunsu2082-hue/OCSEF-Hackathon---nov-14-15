/**
 * Real-grid layers — README §4.6.
 *
 * plants / transmission / substations / niche cases are read client-side from
 * Supabase (seeded by scripts/seed-supabase.mjs), falling back to the static
 * files in `public/layers/` (copied from `research/layers/`; rebuild them with
 * the scripts in `research/scripts/`). They never travel through
 * `RegionPayload` and never touch `lib/types.ts`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NicheCase } from "./niche";
import { getSupabase, selectAll } from "./supabase";

// ---- Shapes -----------------------------------------------------------------

export type PlantSource =
  | "natural_gas"
  | "solar"
  | "battery"
  | "wind"
  | "hydro"
  | "biogas"
  | "other_gas"
  | "waste_heat"
  | "oil"
  | string;

export interface PlantProperties {
  plant_code: number;
  plant_name: string;
  utility_name: string;
  distance_mi: number;
  nameplate_mw: number;
  mw_by_source: Record<string, number>;
  oldest_year: number | null;
  newest_year: number | null;
  planned_retirement_mw: number;
  generator_count: number;
  primary_source: PlantSource;
  technologies: string[];
  capacity_weighted_age_years: number | null;
}

export interface TransmissionProperties {
  osm_id: number;
  voltage_kv: number | null;
  operator: string | null;
  name: string | null;
  cables?: string | null;
  circuits?: string | null;
}

export interface SubstationProperties {
  osm_id: string;
  name: string | null;
  operator: string | null;
  voltage_kv: number | null;
  substation: string | null;
}

interface Collection<P> {
  type: "FeatureCollection";
  /** Source / license / radius block carried by each static file. */
  metadata?: Record<string, unknown>;
  features: { type: "Feature"; geometry: { type: string; coordinates: unknown }; properties: P }[];
}

export type PlantFeature = Collection<PlantProperties>["features"][number] & {
  geometry: { type: "Point"; coordinates: [number, number] };
};
export type TransmissionFeature =
  Collection<TransmissionProperties>["features"][number] & {
    geometry: { type: "LineString"; coordinates: [number, number][] };
  };
export type SubstationFeature = Collection<SubstationProperties>["features"][number] & {
  geometry: { type: "Point"; coordinates: [number, number] };
};

// ---- Layer toggles ----------------------------------------------------------

export interface LayerVisibility {
  plants: boolean;
  transmission: boolean;
  substations: boolean;
  loadCenters: boolean;
  nicheCases: boolean;
}

/** README §4.6: load centers, niche cases and transmission are on by default. */
export const DEFAULT_LAYERS: LayerVisibility = {
  plants: false,
  transmission: true,
  substations: false,
  loadCenters: true,
  nicheCases: true,
};

export const LAYER_OPTIONS: { id: keyof LayerVisibility; label: string }[] = [
  { id: "plants", label: "Plants" },
  { id: "transmission", label: "Transmission" },
  { id: "substations", label: "Substations" },
  { id: "loadCenters", label: "Load centers" },
  { id: "nicheCases", label: "Niche cases" },
];

// ---- Styling helpers --------------------------------------------------------

/**
 * `--src-*` tokens live in design/tokens.css. They are deliberately outside the
 * teal → amber → vermilion → crimson risk ramp so a fuel colour never reads as
 * a risk level.
 */
const SOURCE_CLASSES: Record<string, string> = {
  natural_gas: "src-gas",
  other_gas: "src-gas",
  solar: "src-solar",
  battery: "src-battery",
  wind: "src-wind",
  hydro: "src-hydro",
};

export function sourceClass(source: PlantSource): string {
  return SOURCE_CLASSES[source] ?? "src-other";
}

const SOURCE_LABELS: Record<string, string> = {
  natural_gas: "natural gas",
  other_gas: "other gas",
  solar: "solar",
  battery: "battery storage",
  wind: "wind",
  hydro: "hydro",
  biogas: "biogas",
  waste_heat: "waste heat",
  oil: "oil",
};

export function sourceLabel(source: PlantSource): string {
  return SOURCE_LABELS[source] ?? "other";
}

/** Marker area ∝ nameplate MW, so 4× the MW is 2× the radius. */
export function plantRadius(nameplateMw: number): number {
  if (!Number.isFinite(nameplateMw) || nameplateMw <= 0) return 2.5;
  return Math.min(14, Math.max(2.5, Math.sqrt(nameplateMw) * 0.42));
}

/** README §4.6: 500 kV 3 px, 230 kV 2 px, 115–138 kV 1.25 px, 69 kV 0.75 px. */
export function transmissionWeight(voltageKv: number | null): number {
  if (voltageKv === null || !Number.isFinite(voltageKv)) return 0.75;
  if (voltageKv >= 500) return 3;
  if (voltageKv >= 220) return 2;
  if (voltageKv >= 115) return 1.25;
  return 0.75;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Loaders (cached; every layer is fetched at most once) ------------------
//
// Each loader reads Supabase first (lib/supabase.ts) and rebuilds the exact
// shape of the static file; on a missing client, an error or an empty table it
// falls back to the file in public/layers/.

const cache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit as Promise<T>;
  const pending = load();
  // A failed load is not cached, so the next toggle retries instead of
  // pinning an empty layer for the rest of the session.
  pending.catch(() => cache.delete(key));
  cache.set(key, pending);
  return pending;
}

function fetchJson<T>(url: string): Promise<T> {
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json() as Promise<T>;
  });
}

function fetchText(url: string): Promise<string> {
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.text();
  });
}

/** Supabase first; any failure or empty result → the local loader. */
async function withFallback<T>(
  label: string,
  remote: (supabase: SupabaseClient) => Promise<T | null>,
  local: () => Promise<T>,
): Promise<T> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const value = await remote(supabase);
      if (value !== null) return value;
    } catch (err) {
      console.warn(`[gridLayers] ${label}: Supabase failed, using local file`, err);
    }
  }
  return local();
}

type LayerName = "plants" | "transmission" | "substations";

async function layerMetadata(
  supabase: SupabaseClient,
  layer: LayerName,
): Promise<Record<string, unknown> | undefined> {
  const { data, error } = await supabase
    .from("layer_metadata")
    .select("metadata")
    .eq("layer", layer)
    .maybeSingle();
  if (error) throw new Error(`supabase layer_metadata: ${error.message}`);
  return (data?.metadata as Record<string, unknown> | undefined) ?? undefined;
}

type PointRow<P> = P & { lon: number; lat: number };

async function pointCollection<P>(
  supabase: SupabaseClient,
  layer: LayerName,
  table: string,
  columns: readonly string[],
): Promise<Collection<P> | null> {
  const [rows, metadata] = await Promise.all([
    selectAll<PointRow<Record<string, unknown>>>(
      supabase,
      table,
      [...columns, "lon", "lat"].join(","),
      "sort_order",
    ),
    layerMetadata(supabase, layer),
  ]);
  if (rows.length === 0) return null;
  return {
    type: "FeatureCollection",
    ...(metadata !== undefined ? { metadata } : {}),
    features: rows.map((row) => {
      const properties: Record<string, unknown> = {};
      for (const c of columns) properties[c] = row[c];
      return {
        type: "Feature" as const,
        geometry: { type: "Point", coordinates: [row.lon, row.lat] },
        properties: properties as P,
      };
    }),
  };
}

const PLANT_COLUMNS = [
  "plant_code",
  "plant_name",
  "utility_name",
  "distance_mi",
  "county",
  "city",
  "balancing_authority",
  "sector",
  "grid_voltage_kv",
  "nameplate_mw",
  "mw_by_source",
  "oldest_year",
  "newest_year",
  "planned_retirement_mw",
  "generator_count",
  "primary_source",
  "technologies",
  "capacity_weighted_year",
  "capacity_weighted_age_years",
] as const;

const SUBSTATION_COLUMNS = ["osm_id", "name", "operator", "voltage_kv", "substation"] as const;

const TRANSMISSION_COLUMNS = [
  "osm_id",
  "voltage_kv",
  "operator",
  "name",
  "cables",
  "circuits",
  "line",
] as const;

export function loadPlants(): Promise<Collection<PlantProperties>> {
  return cached("plants", () =>
    withFallback(
      "plants",
      (sb) => pointCollection<PlantProperties>(sb, "plants", "plants", PLANT_COLUMNS),
      () => fetchJson<Collection<PlantProperties>>("/layers/plants.geojson"),
    ),
  );
}

export function loadTransmission(): Promise<Collection<TransmissionProperties>> {
  return cached("transmission", () =>
    withFallback(
      "transmission",
      async (sb) => {
        const [rows, metadata] = await Promise.all([
          selectAll<Record<string, unknown> & { geometry: Collection<unknown>["features"][number]["geometry"] }>(
            sb,
            "transmission_lines",
            [...TRANSMISSION_COLUMNS, "geometry"].join(","),
            "sort_order",
          ),
          layerMetadata(sb, "transmission"),
        ]);
        if (rows.length === 0) return null;
        return {
          type: "FeatureCollection" as const,
          ...(metadata !== undefined ? { metadata } : {}),
          features: rows.map((row) => {
            const properties: Record<string, unknown> = {};
            for (const c of TRANSMISSION_COLUMNS) properties[c] = row[c];
            return {
              type: "Feature" as const,
              geometry: row.geometry,
              properties: properties as unknown as TransmissionProperties,
            };
          }),
        };
      },
      () => fetchJson<Collection<TransmissionProperties>>("/layers/transmission.geojson"),
    ),
  );
}

export function loadSubstations(): Promise<Collection<SubstationProperties>> {
  return cached("substations", () =>
    withFallback(
      "substations",
      (sb) =>
        pointCollection<SubstationProperties>(sb, "substations", "substations", SUBSTATION_COLUMNS),
      () => fetchJson<Collection<SubstationProperties>>("/layers/substations.geojson"),
    ),
  );
}

const NICHE_COLUMNS = [
  "id",
  "title",
  "category",
  "location",
  "one_liner",
  "problem",
  "fix",
  "shock_line",
  "stats",
  "team_bullets",
  "chart",
] as const;

export function loadNicheCases(): Promise<NicheCase[]> {
  return cached("niche_cases", () =>
    withFallback(
      "niche_cases",
      async (sb) => {
        const rows = await selectAll<Record<string, unknown>>(
          sb,
          "niche_cases",
          NICHE_COLUMNS.join(","),
          "sort_order",
        );
        if (rows.length === 0) return null;
        return rows.map((row) => {
          const { chart, ...rest } = row;
          // The source file omits `chart` on cases without one.
          return (chart == null ? rest : { ...rest, chart }) as unknown as NicheCase;
        });
      },
      () => fetchJson<NicheCase[]>("/layers/niche_cases.json"),
    ),
  );
}

// ---- Hourly line-rating series (niche-case chart) ---------------------------

/** Static CSV url → `line_ratings.dataset` it was seeded into. */
const LINE_RATING_DATASETS: Record<string, string> = {
  "/layers/line_rating_2024_westminster_hs.csv": "westminster_hs_2024",
};

/** Source CSV header; the table stores these names lowercased. */
const LINE_RATING_HEADER = [
  "time",
  "temp_c",
  "wind_ms",
  "sun_wm2",
  "static_A",
  "aar_A",
  "dlr_A",
  "dlr_conservative_A",
  "dlr_vs_static",
  "dlr_conservative_vs_static",
] as const;

/**
 * CSV text for a niche-case `chart.data_url`. Known urls are rebuilt from the
 * `line_ratings` table (same header, ordered by time); anything else, or any
 * Supabase failure, is fetched from the url as before.
 */
export function loadLineRatingCsv(url: string): Promise<string> {
  const dataset = LINE_RATING_DATASETS[url];
  return cached(`csv:${url}`, () =>
    withFallback(
      `line_ratings ${url}`,
      async (sb) => {
        if (!dataset) return null;
        const columns = LINE_RATING_HEADER.map((c) => c.toLowerCase());
        const rows = await selectAll<Record<string, string | number | null>>(
          sb,
          "line_ratings",
          columns.join(","),
          "time",
          { column: "dataset", value: dataset },
        );
        if (rows.length === 0) return null;
        const lines = rows.map((row) =>
          columns
            .map((c) => {
              const v = row[c];
              if (v == null) return "";
              // Postgres returns "2024-01-01T00:00:00"; the source has no seconds.
              return c === "time" ? String(v).replace(/^(\d{4}-\d\d-\d\dT\d\d:\d\d):00$/, "$1") : String(v);
            })
            .join(","),
        );
        return [LINE_RATING_HEADER.join(","), ...lines].join("\n") + "\n";
      },
      () => fetchText(url),
    ),
  );
}

/** Headline totals for the intro beat, recomputed from the file — never quoted from memory. */
export function plantTotals(features: PlantFeature[]): {
  plants: number;
  mw: number;
  by_source: Record<string, number>;
} {
  const bySource: Record<string, number> = {};
  let mw = 0;
  for (const feature of features) {
    const props = feature.properties;
    if (!Number.isFinite(props.nameplate_mw)) continue;
    mw += props.nameplate_mw;
    const key = sourceClass(props.primary_source);
    bySource[key] = (bySource[key] ?? 0) + props.nameplate_mw;
  }
  return { plants: features.length, mw, by_source: bySource };
}
