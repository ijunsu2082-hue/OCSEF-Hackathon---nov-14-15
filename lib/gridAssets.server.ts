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
