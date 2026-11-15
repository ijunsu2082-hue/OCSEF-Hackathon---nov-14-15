/**
 * Server-side access to the real grid layers for the provider memo.
 *
 * The memo runs in the Node runtime (`app/api/generate-brief/route.ts` sets
 * `runtime = "nodejs"`), so it can read the same GeoJSON the browser fetches
 * from `public/layers/`. One index is built per process; a missing or broken
 * file yields `null` and the chain reports the gap instead of inventing assets.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAssetIndex, summarizeAssets, type AssetIndex, type LonLat, type RealGridAssets } from "./gridAssets";
import type { PlantFeature, SubstationFeature, TransmissionFeature } from "./gridLayers";
import { adaptLocationAssets, type AdaptedLocationAssets, type LoadedAssetsBody } from "./etlAssets";

let cached: AssetIndex | null | undefined;

function readFeatures<T>(file: string): T[] {
  const raw = readFileSync(path.join(process.cwd(), "public", "layers", file), "utf8");
  const parsed = JSON.parse(raw) as { features?: T[] };
  return Array.isArray(parsed.features) ? parsed.features : [];
}

function index(): AssetIndex | null {
  if (cached !== undefined) return cached;
  try {
    cached = buildAssetIndex(
      readFeatures<PlantFeature>("plants.geojson"),
      readFeatures<TransmissionFeature>("transmission.geojson"),
      readFeatures<SubstationFeature>("substations.geojson"),
    );
  } catch {
    cached = null;
  }
  return cached;
}

/** Real-layer summaries around one point, or null when the layers are absent. */
export function assetsForSite(point: LonLat): RealGridAssets | null {
  const built = index();
  if (!built) return null;
  if (built.plants.length === 0 && built.lines.length === 0 && built.substations.length === 0) {
    return null;
  }
  return summarizeAssets(built, point);
}

// ---- Optional loaded-ETL source ----------------------------------------------
//
// `assetsForSite` above is unchanged and always reads the bundled layers. The
// async variant below reads a location's loaded ETL assets when a source is
// passed, or when MAPERGY_ASSETS_LOCATION (+ optional
// MAPERGY_ASSETS_REVISION) is set, and otherwise behaves like
// assetsForSite. Plants stay bundled: the loaded EIA atlas inventory has no
// nameplate MW or fuel mix, which the generation summary sums.

export interface SiteAssetSource {
  locationId: string;
  /** Loaded-asset revision; omitted → latest loaded inventory. */
  revision?: string;
}

type LayerSource = "etl" | "bundled";

export interface SourcedSiteAssets {
  assets: RealGridAssets | null;
  source: LayerSource;
  layers: { plants: LayerSource; transmission: LayerSource; substations: LayerSource };
  etl: { location: string; revision: string } | null;
  fallback_reasons: string[];
}

interface EtlIndex {
  index: AssetIndex;
  location: string;
  revision: string;
  layers: SourcedSiteAssets["layers"];
  reasons: string[];
}

/** Built once per location + loaded revision. */
const etlIndexes = new Map<string, EtlIndex | null>();

/**
 * Asset source from MAPERGY_ASSETS_LOCATION (+ optional MAPERGY_ASSETS_REVISION).
 * The pre-rename GRIDSENTINEL_ASSETS_* pair is still read when the new location is
 * unset, so existing deployments keep working. The pair is taken together, never
 * a new location with a legacy revision.
 */
export function assetsSourceFromEnv(env: Record<string, string | undefined> = process.env): SiteAssetSource | undefined {
  const legacy = !env.MAPERGY_ASSETS_LOCATION;
  const locationId = legacy ? env.GRIDSENTINEL_ASSETS_LOCATION : env.MAPERGY_ASSETS_LOCATION;
  if (!locationId) return undefined;
  const revision = legacy ? env.GRIDSENTINEL_ASSETS_REVISION : env.MAPERGY_ASSETS_REVISION;
  return revision ? { locationId, revision } : { locationId };
}

const envSource = () => assetsSourceFromEnv();

function bundledResult(point: LonLat, reasons: string[]): SourcedSiteAssets {
  return {
    assets: assetsForSite(point), source: "bundled",
    layers: { plants: "bundled", transmission: "bundled", substations: "bundled" },
    etl: null, fallback_reasons: reasons,
  };
}

export async function assetsForSiteFromSource(point: LonLat, source = envSource()): Promise<SourcedSiteAssets> {
  if (!source) return bundledResult(point, []);
  let loaded: Awaited<ReturnType<typeof import("../research/etl/load-assets").readLocationAssets>>;
  try {
    const { readLocationAssets } = await import("../research/etl/load-assets");
    loaded = await readLocationAssets(source.locationId, source.revision);
  } catch (error) {
    return bundledResult(point, [error instanceof Error ? error.message : "loaded assets unreadable"]);
  }
  if (!loaded) return bundledResult(point, [`no loaded assets for ${source.locationId}`]);
  const key = `${source.locationId}:${loaded.revision}`;
  if (!etlIndexes.has(key)) etlIndexes.set(key, buildEtlIndex(loaded as LoadedAssetsBody));
  const built = etlIndexes.get(key);
  if (!built) return bundledResult(point, [`loaded assets for ${source.locationId} carry no line or substation layer`]);
  const { index: idx } = built;
  // Unavailable only when no layer has features or a confirmed (successfully loaded) source;
  // a loaded ETL layer with 0 features is confirmed empty.
  const unavailable = (["plants", "lines", "substations"] as const)
    .every((layer) => idx[layer].length === 0 && idx.confirmed?.[layer] !== true);
  return {
    assets: unavailable ? null : summarizeAssets(idx, point),
    source: "etl",
    layers: built.layers,
    etl: { location: built.location, revision: built.revision },
    fallback_reasons: built.reasons,
  };
}

function buildEtlIndex(body: LoadedAssetsBody): EtlIndex | null {
  let adapted: AdaptedLocationAssets;
  try {
    adapted = adaptLocationAssets(body);
  } catch {
    return null;
  }
  if (!adapted.transmission && !adapted.substations) return null;
  const reasons = [adapted.plants
    ? "loaded plant dataset has no nameplate MW or fuel mix; bundled plants kept"
    : "loaded assets have no plant dataset"];
  if (!adapted.transmission) reasons.push("loaded assets have no transmission dataset");
  if (!adapted.substations) reasons.push("loaded assets have no substation dataset");
  const bundledOr = <T>(file: string): T[] => {
    try {
      return readFeatures<T>(file);
    } catch {
      reasons.push(`bundled ${file} unreadable`);
      return [];
    }
  };
  return {
    index: buildAssetIndex(
      bundledOr<PlantFeature>("plants.geojson"),
      adapted.transmission ? adapted.transmission.features : bundledOr<TransmissionFeature>("transmission.geojson"),
      adapted.substations ? adapted.substations.features : bundledOr<SubstationFeature>("substations.geojson"),
      { lines: adapted.transmission !== null, substations: adapted.substations !== null },
    ),
    location: adapted.location,
    revision: adapted.revision,
    layers: {
      plants: "bundled",
      transmission: adapted.transmission ? "etl" : "bundled",
      substations: adapted.substations ? "etl" : "bundled",
    },
    reasons,
  };
}
