import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digest } from "../../lib/evidence/canonical";
import { replayAssets, type AssetManifest } from "./assets";
import { clipFeature, polylineMiles, voltageBand, type Position } from "./geometry";
import { atomicJson, locationId, stateRoot } from "./pipeline";
import { hifldSubstationName } from "./substation-audit";

/**
 * Normalized key -> [provider field, kind]. Provider field names were checked
 * against each layer's `?f=json` metadata on 2026-11-14 (docs/HIFLD-LIVE-CAPTURE.md).
 */
const FIELDS = {
  "hifld-substations": {
    name: ["NAME", "hifld-substation-name"], maximum_voltage_kv: ["MAX_VOLT", "positive"],
    minimum_voltage_kv: ["MIN_VOLT", "positive"], type: ["TYPE", "text"],
  },
  "hifld-transmission": {
    owner: ["OWNER", "text"], voltage_kv: ["VOLTAGE", "positive"], status: ["STATUS", "text"],
    type: ["TYPE", "text"], voltage_class: ["VOLT_CLASS", "text"],
  },
  "eia-atlas-plants": { name: ["Plant_Name", "text"], plant_code: ["Plant_Code", "positive"], utility_name: ["Utility_Na", "text"] },
} as const;

/** Normalized keys the layer does not publish. Always null and never cited. */
const NOT_PUBLISHED: Record<string, Record<string, string>> = {
  "hifld-substations": {
    owner: "Not published: the HIFLD Substations layer has no OWNER or OPERATOR field (layer ?f=json metadata). " +
      "Null means not published by this source, not a known absence. Do not backfill from transmission OWNER.",
  },
};

/** Per-dataset notes on how provider values become normalized properties. */
const FIELD_NOTES: Record<string, Record<string, string>> = {
  "hifld-substations": {
    name: "NAME, except the layer's \"<TYPE><ID>\" placeholders (UNKNOWN, TAP, RISER, DEADEND followed by ID) become null.",
    maximum_voltage_kv: "MAX_VOLT in kV. The -999999 sentinel and other non-positive values become null.",
    minimum_voltage_kv: "MIN_VOLT in kV. The -999999 sentinel and other non-positive values become null.",
    type: "TYPE as published (SUBSTATION, TAP, RISER, DEAD END; NOT AVAILABLE becomes null). " +
      "TAP, RISER and DEAD END records are kept; filter on this property if only substations are wanted.",
  },
  "hifld-transmission": {
    voltage_kv: "VOLTAGE in kV. Non-positive values become null.",
    status: "STATUS. NOT AVAILABLE becomes null.",
    voltage_band: "study_clip.voltage_band is \"dc\" when VOLT_CLASS is DC or TYPE begins with DC; otherwise the AC band " +
      "of voltage_kv. The layer marks DC inconsistently (one line has VOLT_CLASS DC with TYPE AC, another TYPE " +
      "\"DC, OVERHEAD\" with VOLT_CLASS 500), so either field is enough.",
  },
  "eia-atlas-plants": {},
};

type Kind = "text" | "positive" | "hifld-substation-name";

function value(raw: unknown, kind: Kind, properties: Record<string, unknown>): string | number | null {
  if (kind === "hifld-substation-name") return value(hifldSubstationName(properties), "text", properties);
  if (kind === "positive") return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed && !/^(not available|unknown|n\/a|null)$/i.test(trimmed) ? trimmed : null;
}

const round2 = (miles: number) => Math.round(miles * 100) / 100;

interface StudyClip {
  inside_miles: number;
  total_miles: number;
  segments: number;
  status: "inside" | "crossing" | "outside";
  voltage_band: string;
}

/** HIFLD direct-current marker: VOLT_CLASS "DC" or a TYPE such as "DC, OVERHEAD". */
function isDirectCurrent(properties: Record<string, unknown>): boolean {
  const { TYPE: type, VOLT_CLASS: voltClass } = properties;
  return (typeof voltClass === "string" && /^\s*dc\s*$/i.test(voltClass)) ||
    (typeof type === "string" && /^\s*dc\b/i.test(type));
}

/** Inside-radius length of a line feature. Provider geometry itself is never altered. */
function studyClip(
  center: Position, radiusMiles: number, geometry: unknown, voltageKv: unknown, dc: boolean,
): StudyClip | null {
  const clipped = clipFeature(center, radiusMiles, geometry);
  if (!clipped) return null;
  const { type, coordinates } = geometry as { type: string; coordinates: unknown[] };
  const lines = type === "LineString" ? [coordinates] : coordinates;
  const total = round2(lines.reduce<number>((sum, line) =>
    sum + (Array.isArray(line) ? polylineMiles(line as Position[]) : 0), 0));
  const inside = clipped.miles;
  const status = inside === 0 ? "outside" : Math.abs(total - inside) <= 0.01 ? "inside" : "crossing";
  return {
    inside_miles: inside, total_miles: total, segments: clipped.segments, status,
    voltage_band: voltageBand(typeof voltageKv === "number" ? voltageKv : null, { dc }),
  };
}

function mileage(center: [number, number], radiusMiles: number, clips: StudyClip[]) {
  const bands: Record<string, number> = {};
  const counts = { inside: 0, crossing: 0, outside: 0 };
  for (const clip of clips) {
    bands[clip.voltage_band] = (bands[clip.voltage_band] ?? 0) + clip.inside_miles;
    counts[clip.status] += 1;
  }
  return {
    method: "geodesic inside-radius length via local tangent plane clip (geometry.ts)",
    radius_miles: radiusMiles,
    center,
    inside_miles_total: round2(clips.reduce((sum, clip) => sum + clip.inside_miles, 0)),
    provider_miles_total: round2(clips.reduce((sum, clip) => sum + clip.total_miles, 0)),
    by_voltage_band: Object.fromEntries(Object.keys(bands).sort().map((band) => [band, round2(bands[band])])),
    counts,
  };
}

async function transform(manifest: AssetManifest) {
  const source = manifest.source;
  if (!Object.hasOwn(FIELDS, source)) throw new Error(`No asset transform for ${source}`);
  const fields = FIELDS[source as keyof typeof FIELDS];
  const notPublished = NOT_PUBLISHED[source] ?? {};
  const replayed = await replayAssets(manifest);
  const [lat, lon] = manifest.query.center;
  const center: Position = [lon, lat];
  const radiusMiles = manifest.query.radius_miles;
  const clips: StudyClip[] = [];
  const records = replayed.features.map((feature) => {
    const mappings = Object.entries(fields);
    const properties: Record<string, string | number | null> = {
      ...Object.fromEntries(mappings.map(([key, [providerKey, kind]]) =>
        [key, value(feature.properties[providerKey], kind, feature.properties)])),
      ...Object.fromEntries(Object.keys(notPublished).map((key) => [key, null])),
    };
    const citations = Object.fromEntries(mappings
      .filter(([, [providerKey]]) => Object.hasOwn(feature.properties, providerKey))
      .map(([key, [providerKey]]) => [key, {
        snapshot: feature.citation.snapshot,
        locator: `${feature.citation.locator}/properties/${providerKey}`,
      }]));
    const clip = studyClip(center, radiusMiles, feature.geometry,
      "voltage_kv" in properties ? properties.voltage_kv : null, isDirectCurrent(feature.properties));
    if (clip) clips.push(clip);
    return {
      id: feature.id, type: "Feature" as const, geometry: feature.geometry,
      geometryCitation: { snapshot: feature.citation.snapshot, locator: `${feature.citation.locator}/geometry` },
      properties, citations,
      ...(clip ? { study_clip: clip } : {}),
    };
  });
  return {
    source,
    scope: manifest.query,
    snapshots: [manifest.index, ...manifest.pages],
    counts: {
      features: records.length,
      missing: Object.fromEntries([...Object.keys(fields), ...Object.keys(notPublished)].map((key) =>
        [key, records.filter((record) => record.properties[key] === null).length])),
    },
    field_notes: { ...FIELD_NOTES[source], ...notPublished },
    features: { type: "FeatureCollection" as const, features: records },
    ...(clips.length ? { mileage: mileage(manifest.query.center, radiusMiles, clips) } : {}),
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
