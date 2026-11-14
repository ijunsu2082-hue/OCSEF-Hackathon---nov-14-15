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

export interface PlantFeature {
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    plant_name: string;
    utility_name: string;
    nameplate_mw: number;
    mw_by_source: Record<string, number>;
    oldest_year: number | null;
    newest_year: number | null;
    planned_retirement_mw: number;
    primary_source: string;
    technologies: string[];
    capacity_weighted_age_years: number | null;
  };
}

export interface TransmissionFeature {
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: { voltage_kv: number | null; operator: string | null; name: string | null };
}

export interface SubstationFeature {
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { name: string | null; operator: string | null; voltage_kv: number | null };
}

interface FeatureCollection<T> {
  features: T[];
}

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
 * a risk level. Fuels without a token (biogas, oil, waste heat) share `other`.
 */
const SOURCE_CLASSES: Record<string, string> = {
  natural_gas: "src-gas",
  other_gas: "src-gas",
  solar: "src-solar",
  battery: "src-battery",
  wind: "src-wind",
  hydro: "src-hydro",
};

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

export function sourceClass(source: string): string {
  return SOURCE_CLASSES[source] ?? "src-other";
}

export function sourceLabel(source: string): string {
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

// ---- Loaders (each file is fetched at most once per session) ----------------

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

export function loadPlants(): Promise<FeatureCollection<PlantFeature>> {
  return loadJson("/layers/plants.geojson");
}

export function loadTransmission(): Promise<FeatureCollection<TransmissionFeature>> {
  return loadJson("/layers/transmission.geojson");
}

export function loadSubstations(): Promise<FeatureCollection<SubstationFeature>> {
  return loadJson("/layers/substations.geojson");
}

export function loadNicheCases(): Promise<NicheCase[]> {
  return loadJson("/layers/niche_cases.json");
}
