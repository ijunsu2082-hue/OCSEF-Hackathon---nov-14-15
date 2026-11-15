import { resolve } from "node:path";
import { digest } from "../../lib/evidence/canonical";
import { buildSnapshot, replaySnapshot } from "../snapshot";
import type { SourceSnapshot } from "../../lib/evidence/schema";
import { atomicJson, locationId, request, stateRoot, storeCapture } from "./pipeline";
import { feedsFor, type LocationQuery } from "./sources";

export interface AssetManifest {
  /** `gridsentinel.asset-manifest/1` on manifests written before the rename. */
  schema: "mapergy.asset-manifest/1" | "gridsentinel.asset-manifest/1";
  query: LocationQuery;
  source: string;
  index: SourceSnapshot;
  pages: SourceSnapshot[];
}

async function capture(sourceId: string, url: URL) {
  const { bytes, headers } = await request(url);
  const { cachePath } = await storeCapture(bytes);
  return buildSnapshot({
    sourceId, url: url.href, bytes, cachePath, retrievedAt: new Date().toISOString(),
    parser: "json.object", contentType: headers.get("content-type"),
  });
}

function inventory(data: unknown): { field: string; ids: number[] } {
  const { objectIdFieldName: field, objectIds: ids, error } = data as {
    objectIdFieldName?: string; objectIds?: unknown[]; error?: unknown;
  };
  if (error || typeof field !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ||
      !Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id)) ||
      new Set(ids).size !== ids.length) throw new Error("Invalid ArcGIS object ID inventory");
  return { field, ids: (ids as number[]).sort((a, b) => a - b) };
}

function pageFeatures(data: unknown, field: string, snapshot: SourceSnapshot) {
  const page = data as {
    type?: string;
    exceededTransferLimit?: boolean;
    features?: { type: string; properties: Record<string, unknown>; geometry: unknown }[];
  };
  if (page.type !== "FeatureCollection" || page.exceededTransferLimit || !Array.isArray(page.features)) {
    throw new Error("Invalid or truncated ArcGIS feature page");
  }
  return page.features.map((feature, index) => {
    const id = feature.properties?.[field];
    if (feature.type !== "Feature" || typeof id !== "number" || !Number.isSafeInteger(id) || !feature.geometry) {
      throw new Error("Invalid ArcGIS feature");
    }
    return { id, feature, citation: { snapshot: snapshot.id, locator: `/features/${index}` } };
  });
}

export async function replayAssets(manifest: AssetManifest) {
  const { field, ids } = inventory((await replaySnapshot(manifest.index)).data);
  const result = new Map<number, ReturnType<typeof pageFeatures>[number]>();
  const expected = new Set(ids);
  for (const snapshot of manifest.pages) {
    for (const record of pageFeatures((await replaySnapshot(snapshot)).data, field, snapshot)) {
      if (!expected.has(record.id) || result.has(record.id)) throw new Error("Unexpected or duplicate ArcGIS feature ID");
      result.set(record.id, record);
    }
  }
  if (result.size !== ids.length) throw new Error("Incomplete ArcGIS inventory");
  return {
    type: "FeatureCollection",
    features: ids.map((id) => {
      const { feature, citation } = result.get(id)!;
      return { ...feature, id: `${manifest.source}:${id}`, citation };
    }),
  };
}

export async function collectAssets(query: LocationQuery, source: string) {
  const feed = feedsFor(query).find((item) => item.source.id === source && item.source.access.kind === "arcgis");
  if (!feed) throw new Error("Expected eia-atlas-plants, hifld-substations, or hifld-transmission");
  // Swap the flag in the query string itself: re-serializing through
  // searchParams would percent-encode a study polygon past the GET limit.
  const indexUrl = new URL(feed.url);
  indexUrl.search = feed.url.search.replace(/([?&])returnCountOnly=true(?=&|$)/, "$1returnIdsOnly=true");
  if (indexUrl.searchParams.get("returnIdsOnly") !== "true" || indexUrl.searchParams.has("returnCountOnly")) {
    throw new Error("Expected an ArcGIS count query");
  }
  const index = await capture(source, indexUrl);
  const { ids } = inventory(index.data);
  if (ids.length > 20000) throw new Error("Asset inventory exceeds 20,000 features. Reduce the radius.");
  const manifest: AssetManifest = {
    schema: "mapergy.asset-manifest/1", query, source, index: index.snapshot, pages: [],
  };
  for (let offset = 0; offset < ids.length; offset += 100) {
    const page = new URL(feed.url.origin + feed.url.pathname);
    page.search = new URLSearchParams({
      f: "geojson", objectIds: ids.slice(offset, offset + 100).join(","),
      outFields: "*", returnGeometry: "true", outSR: "4326",
    }).toString();
    manifest.pages.push((await capture(source, page)).snapshot);
  }
  const geojson = await replayAssets(manifest);
  const directory = resolve(stateRoot(), "assets", locationId(query), source, digest(manifest));
  await atomicJson(resolve(directory, "features.geojson"), geojson);
  const path = resolve(directory, "manifest.json");
  await atomicJson(path, manifest);
  return { path, features: geojson.features.length };
}
