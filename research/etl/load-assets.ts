import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digest } from "../../lib/evidence/canonical";
import { replayAssets, type AssetManifest } from "./assets";
import { atomicJson, locationId, stateRoot } from "./pipeline";

const FIELDS = {
  "hifld-substations": { name: ["NAME", "text"], owner: ["OWNER", "text"], maximum_voltage_kv: ["MAX_VOLT", "positive"] },
  "hifld-transmission": { owner: ["OWNER", "text"], voltage_kv: ["VOLTAGE", "positive"], status: ["STATUS", "text"] },
  "eia-atlas-plants": { name: ["Plant_Name", "text"], plant_code: ["Plant_Code", "positive"], utility_name: ["Utility_Na", "text"] },
} as const;

function value(raw: unknown, kind: "text" | "positive"): string | number | null {
  if (kind === "positive") return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed && !/^(not available|unknown|n\/a|null)$/i.test(trimmed) ? trimmed : null;
}

async function transform(manifest: AssetManifest) {
  const source = manifest.source;
  if (!Object.hasOwn(FIELDS, source)) throw new Error(`No asset transform for ${source}`);
  const fields = FIELDS[source as keyof typeof FIELDS];
  const replayed = await replayAssets(manifest);
  const records = replayed.features.map((feature) => {
    const mappings = Object.entries(fields);
    const properties = Object.fromEntries(mappings.map(([key, [providerKey, kind]]) =>
      [key, value(feature.properties[providerKey], kind)]));
    const citations = Object.fromEntries(mappings
      .filter(([, [providerKey]]) => Object.hasOwn(feature.properties, providerKey))
      .map(([key, [providerKey]]) => [key, {
        snapshot: feature.citation.snapshot,
        locator: `${feature.citation.locator}/properties/${providerKey}`,
      }]));
    return {
      id: feature.id, type: "Feature" as const, geometry: feature.geometry,
      geometryCitation: { snapshot: feature.citation.snapshot, locator: `${feature.citation.locator}/geometry` },
      properties, citations,
    };
  });
  return {
    source,
    scope: manifest.query,
    snapshots: [manifest.index, ...manifest.pages],
    counts: {
      features: records.length,
      missing: Object.fromEntries(Object.keys(fields).map((key) =>
        [key, records.filter((record) => record.properties[key] === null).length])),
    },
    features: { type: "FeatureCollection" as const, features: records },
  };
}

export async function loadLocationAssets(manifestFiles: string[]) {
  if (!manifestFiles.length) throw new Error("Provide at least one asset manifest");
  const manifests: AssetManifest[] = await Promise.all(manifestFiles.map(async (path) =>
    JSON.parse(await readFile(resolve(path), "utf8"))));
  const id = locationId(manifests[0].query);
  if (manifests.some((manifest) => locationId(manifest.query) !== id)) {
    throw new Error("Asset manifests must cover the same location and radius");
  }
  if (new Set(manifests.map(({ source }) => source)).size !== manifests.length) {
    throw new Error("Only one manifest per asset source");
  }
  manifests.sort((a, b) => a.source.localeCompare(b.source));
  const datasets = await Promise.all(manifests.map(transform));
  const data = { schema: "gridsentinel.location-assets/1", location: id, datasets };
  const revision = digest(data);
  const directory = resolve(stateRoot(), "loaded-assets", id);
  await atomicJson(resolve(directory, `${revision}.json`), data);
  await atomicJson(resolve(directory, "latest.json"), { revision });
  return { location: id, revision, counts: datasets.map(({ source, counts }) => ({ source, ...counts })) };
}

export async function readLocationAssets(id: string, revision?: string) {
  if (!/^location-[a-f0-9]{24}$/.test(id) || (revision !== undefined && !/^[a-f0-9]{64}$/.test(revision))) return null;
  const directory = resolve(stateRoot(), "loaded-assets", id);
  try {
    const chosen = revision ?? JSON.parse(await readFile(resolve(directory, "latest.json"), "utf8")).revision;
    if (typeof chosen !== "string" || !/^[a-f0-9]{64}$/.test(chosen)) throw new Error("Invalid asset revision");
    const data: unknown = JSON.parse(await readFile(resolve(directory, `${chosen}.json`), "utf8"));
    if (digest(data) !== chosen) throw new Error("Asset revision checksum mismatch");
    return { revision: chosen, data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
