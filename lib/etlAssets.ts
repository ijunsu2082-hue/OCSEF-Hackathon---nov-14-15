/**
 * Loaded ETL assets (research/etl/load-assets.ts, schema
 * gridsentinel.location-assets/1) adapted to the app's grid-layer shapes.
 *
 * The adapter is pure. Fields the provider does not carry stay `null`; nothing
 * is filled from the bundled layers or from defaults (an EIA atlas plant has no
 * nameplate MW here, so `nameplate_mw` is null, never 0). Every feature keeps
 * its provenance under `etl`, beside `geometry`/`properties`, so existing
 * consumers that read only those two keys are unaffected.
 */

import type { PlantFeature, SubstationFeature, TransmissionFeature } from "./gridLayers";

export const LOCATION_ASSETS_SCHEMA = "gridsentinel.location-assets/1";

// ---- Loaded document (input) -------------------------------------------------

export interface EtlCitation { snapshot: string; locator: string }

export interface EtlRecord {
  id: string;
  geometry: { type: string; coordinates: unknown } | null;
  geometryCitation: EtlCitation;
  properties: Record<string, unknown>;
  citations: Record<string, EtlCitation>;
  study_clip?: unknown;
}

export interface EtlDataset {
  source: string;
  scope: unknown;
  snapshots: { id: string }[];
  counts: { features: number; missing: Record<string, number> };
  mileage?: unknown;
  features: { type: "FeatureCollection"; features: EtlRecord[] };
}

/** Body of GET /api/location-report/[id]/assets and of readLocationAssets(). */
export interface LoadedAssetsBody {
  revision: string;
  data: { schema: string; location: string; datasets: EtlDataset[] };
}

// ---- Adapted shapes (output) -------------------------------------------------

export interface EtlProvenance {
  source: string;
  /** Snapshot the geometry was cited from. */
  snapshot: string;
  /** Loaded-asset revision (sha256 of the loaded document). */
  revision: string;
  location: string;
  id: string;
  geometry_locator: string;
  citations: Record<string, EtlCitation>;
  /** Index into a provider MultiLineString that was split into LineStrings. */
  part?: number;
}

type Nullable<T> = { [K in keyof T]-?: T[K] | null };

/** PlantFeature with every provider-absent field explicitly null. */
export interface EtlPlantFeature {
  geometry: PlantFeature["geometry"];
  properties: Nullable<PlantFeature["properties"]>;
  etl: EtlProvenance;
}

/**
 * HIFLD publishes an OWNER (transmission only), never an operator. `owner`
 * carries it; `operator` is always null for HIFLD so owner is never shown as
 * the operator.
 */
export interface EtlTransmissionFeature extends Omit<TransmissionFeature, "type" | "properties"> {
  /** HIFLD carries no OSM id, so `osm_id` is absent rather than invented (and no GeoJSON `type` is added). */
  properties: Omit<TransmissionFeature["properties"], "osm_id"> & { osm_id?: number; status: string | null; owner: string | null };
  etl: EtlProvenance;
}

/** HIFLD Substations has no OWNER or OPERATOR field: `owner` and `operator` are null. */
export interface EtlSubstationFeature extends Omit<SubstationFeature, "type" | "properties"> {
  /** HIFLD carries no OSM id, so `osm_id` is absent rather than invented (and no GeoJSON `type` is added). */
  properties: Omit<SubstationFeature["properties"], "osm_id"> & { osm_id?: string; owner: string | null };
  etl: EtlProvenance;
}

export interface EtlLayerMeta {
  dataset: string;
  location: string;
  revision: string;
  snapshots: string[];
  counts: EtlDataset["counts"];
  /** Records whose geometry did not fit the layer (wrong type, too short). */
  skipped: number;
  /**
   * Records excluded because load-assets' `study_clip.status` is "outside":
   * the provider query returned them but no part lies inside the study radius.
   */
  outside_radius: number;
}

export interface EtlLayer<F> { features: F[]; meta: EtlLayerMeta }

export interface AdaptedLocationAssets {
  location: string;
  revision: string;
  plants: EtlLayer<EtlPlantFeature> | null;
  transmission: EtlLayer<EtlTransmissionFeature> | null;
  substations: EtlLayer<EtlSubstationFeature> | null;
}

/** Which loaded dataset feeds which app layer. */
export const LAYER_DATASETS = {
  plants: "eia-atlas-plants",
  transmission: "hifld-transmission",
  substations: "hifld-substations",
} as const;

// ---- Adapter -----------------------------------------------------------------

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() !== "" ? x : null);

function position(x: unknown): [number, number] | null {
  if (!Array.isArray(x) || x.length < 2) return null;
  const lon = num(x[0]), lat = num(x[1]);
  return lon === null || lat === null ? null : [lon, lat];
}

function path(x: unknown): [number, number][] | null {
  if (!Array.isArray(x)) return null;
  const out: [number, number][] = [];
  for (const p of x) {
    const at = position(p);
    if (!at) return null;
    out.push(at);
  }
  return out.length >= 2 ? out : null;
}

function provenance(dataset: EtlDataset, record: EtlRecord, location: string, revision: string): EtlProvenance {
  return {
    source: dataset.source,
    snapshot: record.geometryCitation?.snapshot ?? "",
    revision,
    location,
    id: record.id,
    geometry_locator: record.geometryCitation?.locator ?? "",
    citations: record.citations ?? {},
  };
}

function meta(dataset: EtlDataset, location: string, revision: string, skipped: number, outside = 0): EtlLayerMeta {
  return {
    dataset: dataset.source, location, revision,
    snapshots: dataset.snapshots.map((s) => s.id), counts: dataset.counts, skipped, outside_radius: outside,
  };
}

const isOutside = (record: EtlRecord) =>
  (record.study_clip as { status?: unknown } | undefined)?.status === "outside";

export function adaptPlants(dataset: EtlDataset, location: string, revision: string): EtlLayer<EtlPlantFeature> {
  const features: EtlPlantFeature[] = [];
  let skipped = 0;
  for (const record of dataset.features.features) {
    const at = record.geometry?.type === "Point" ? position(record.geometry.coordinates) : null;
    if (!at) { skipped++; continue; }
    const p = record.properties ?? {};
    features.push({
      geometry: { type: "Point", coordinates: at },
      properties: {
        plant_code: num(p.plant_code),
        plant_name: str(p.name),
        utility_name: str(p.utility_name),
        distance_mi: null,
        county: null,
        city: null,
        grid_voltage_kv: null,
        generator_count: null,
        nameplate_mw: num(p.nameplate_mw),
        mw_by_source: null,
        oldest_year: null,
        newest_year: null,
        planned_retirement_mw: null,
        primary_source: null,
        technologies: null,
        capacity_weighted_age_years: null,
      },
      etl: provenance(dataset, record, location, revision),
    });
  }
  return { features, meta: meta(dataset, location, revision, skipped) };
}

export function adaptTransmission(dataset: EtlDataset, location: string, revision: string): EtlLayer<EtlTransmissionFeature> {
  const features: EtlTransmissionFeature[] = [];
  let skipped = 0;
  let outside = 0;
  for (const record of dataset.features.features) {
    // The provider's spatial query over-returns; map and scan get only lines
    // with some length inside the study radius. Crossing lines keep their full
    // provider geometry (study_clip carries the inside miles).
    if (isOutside(record)) { outside++; continue; }
    const g = record.geometry;
    const parts = g?.type === "LineString" ? [g.coordinates]
      : g?.type === "MultiLineString" && Array.isArray(g.coordinates) ? g.coordinates as unknown[] : null;
    const p = record.properties ?? {};
    const lines = (parts ?? []).map(path);
    if (!parts || lines.every((line) => line === null)) { skipped++; continue; }
    lines.forEach((coordinates, part) => {
      if (!coordinates) return;
      const etl = provenance(dataset, record, location, revision);
      features.push({
        geometry: { type: "LineString", coordinates },
        properties: { voltage_kv: num(p.voltage_kv), operator: null, owner: str(p.owner), name: null, status: str(p.status) },
        etl: g?.type === "MultiLineString" ? { ...etl, part } : etl,
      });
    });
  }
  return { features, meta: meta(dataset, location, revision, skipped, outside) };
}

export function adaptSubstations(dataset: EtlDataset, location: string, revision: string): EtlLayer<EtlSubstationFeature> {
  const features: EtlSubstationFeature[] = [];
  let skipped = 0;
  for (const record of dataset.features.features) {
    const at = record.geometry?.type === "Point" ? position(record.geometry.coordinates) : null;
    if (!at) { skipped++; continue; }
    const p = record.properties ?? {};
    features.push({
      geometry: { type: "Point", coordinates: at },
      // HIFLD carries no OSM `substation=*` class, so `substation` is null.
      properties: {
        name: str(p.name), operator: null, owner: str(p.owner), voltage_kv: num(p.maximum_voltage_kv), substation: null,
      },
      etl: provenance(dataset, record, location, revision),
    });
  }
  return { features, meta: meta(dataset, location, revision, skipped) };
}

/** Throws on a document that is not a loaded-asset inventory. */
export function adaptLocationAssets(body: LoadedAssetsBody): AdaptedLocationAssets {
  const data = body?.data;
  if (!data || data.schema !== LOCATION_ASSETS_SCHEMA || !Array.isArray(data.datasets) ||
      typeof data.location !== "string" || typeof body.revision !== "string") {
    throw new Error(`Expected a ${LOCATION_ASSETS_SCHEMA} document`);
  }
  const { location } = data;
  const { revision } = body;
  const find = (source: string) => data.datasets.find((d) => d.source === source);
  const plants = find(LAYER_DATASETS.plants);
  const transmission = find(LAYER_DATASETS.transmission);
  const substations = find(LAYER_DATASETS.substations);
  return {
    location, revision,
    plants: plants ? adaptPlants(plants, location, revision) : null,
    transmission: transmission ? adaptTransmission(transmission, location, revision) : null,
    substations: substations ? adaptSubstations(substations, location, revision) : null,
  };
}

// ---- Source selector + fetch (client) -----------------------------------------

export interface EtlSourceSelector {
  locationId?: string;
  /** Report revision whose bound asset inventory to read; omitted → route default (latest report). */
  reportRevision?: string;
}

export type EtlFetch =
  | { ok: true; assets: AdaptedLocationAssets; reportRevision: string | null; url: string }
  | { ok: false; status: number | null; reason: string };

const LOCATION_ID = /^location-[a-f0-9]{24}$/;
const REVISION = /^[a-f0-9]{64}$/;

export function etlCacheKey(selector: EtlSourceSelector): string {
  return `etl:${selector.locationId ?? ""}:${selector.reportRevision ?? "latest"}`;
}

export function etlAssetsUrl(selector: EtlSourceSelector): string {
  const base = `/api/location-report/${encodeURIComponent(selector.locationId ?? "")}/assets`;
  return selector.reportRevision ? `${base}?report=${encodeURIComponent(selector.reportRevision)}` : base;
}

const etlCache = new Map<string, Promise<EtlFetch>>();

/** Test hook. */
export function clearEtlAssetCache(): void {
  etlCache.clear();
}

/**
 * Fetch and adapt a location's loaded assets. Successful loads are cached per
 * location + report revision; unavailable results are not, so a later call
 * picks up an inventory that has since been loaded. Never rejects.
 */
export function fetchEtlAssets(selector: EtlSourceSelector): Promise<EtlFetch> {
  if (!selector.locationId || !LOCATION_ID.test(selector.locationId)) {
    return Promise.resolve({ ok: false, status: null, reason: "no valid location id selected" });
  }
  if (selector.reportRevision !== undefined && !REVISION.test(selector.reportRevision)) {
    return Promise.resolve({ ok: false, status: null, reason: "invalid report revision" });
  }
  const key = etlCacheKey(selector);
  const hit = etlCache.get(key);
  if (hit) return hit;
  const url = etlAssetsUrl(selector);
  const pending: Promise<EtlFetch> = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let reason = `loaded assets unavailable (${res.status})`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body?.error === "string") reason = `${reason}: ${body.error}`;
        } catch { /* non-JSON error body */ }
        return { ok: false, status: res.status, reason };
      }
      // `assets.location` is the inventory id (center + radius), which can
      // differ from the report id in the URL; the route owns that binding.
      const assets = adaptLocationAssets((await res.json()) as LoadedAssetsBody);
      // X-Report-Revision is absent on the legacy (unbound) route.
      return { ok: true, assets, reportRevision: res.headers.get("X-Report-Revision"), url };
    } catch (error) {
      return { ok: false, status: null, reason: error instanceof Error ? error.message : "loaded assets unreadable" };
    }
  })();
  etlCache.set(key, pending);
  pending.then((result) => { if (!result.ok) etlCache.delete(key); });
  return pending;
}
