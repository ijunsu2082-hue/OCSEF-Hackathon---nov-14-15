/**
 * Real-grid layers — README §4.6.
 *
 * plants / transmission / substations / niche cases are static files copied from
 * `research/layers/` into `public/layers/` at integration. They are fetched
 * client-side, never travel through `RegionPayload`, and never touch
 * `lib/types.ts`. Rebuild them with the scripts in `research/scripts/`.
 */

import type { NicheCase } from "./niche";

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

const cache = new Map<string, Promise<unknown>>();

function loadJson<T>(url: string): Promise<T> {
  const hit = cache.get(url);
  if (hit) return hit as Promise<T>;
  const pending = fetch(url).then((res) => {
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json() as Promise<T>;
  });
  // A failed fetch is not cached, so the next toggle retries instead of
  // pinning an empty layer for the rest of the session.
  pending.catch(() => cache.delete(url));
  cache.set(url, pending);
  return pending;
}

export function loadPlants(): Promise<Collection<PlantProperties>> {
  return loadJson<Collection<PlantProperties>>("/layers/plants.geojson");
}

export function loadTransmission(): Promise<Collection<TransmissionProperties>> {
  return loadJson<Collection<TransmissionProperties>>("/layers/transmission.geojson");
}

export function loadSubstations(): Promise<Collection<SubstationProperties>> {
  return loadJson<Collection<SubstationProperties>>("/layers/substations.geojson");
}

export function loadNicheCases(): Promise<NicheCase[]> {
  return loadJson<NicheCase[]>("/layers/niche_cases.json");
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
