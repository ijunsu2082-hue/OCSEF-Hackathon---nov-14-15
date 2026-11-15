import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digest } from "../../lib/evidence/canonical";
import { osmSubstationSource } from "../../lib/substationSource";
import { replayAssets, type AssetManifest } from "./assets";
import { greatCircleMiles, type Position } from "./geometry";
import { atomicJson, locationId, stateRoot } from "./pipeline";
import { hifldSubstationName, hifldVoltage } from "./substation-audit";

/**
 * Candidate OSM <-> HIFLD substation pairs for HUMAN review. Proximity, name similarity and
 * voltage hints only rank what a reviewer should look at; no candidate is a corroboration.
 * Every row is emitted with review.status "unreviewed" and substation-audit.ts ignores it
 * until a person sets status "reviewed", names the reviewer and records identity evidence.
 */

const METRES_PER_MILE = 1609.344;
const DEFAULT_MAX_METRES = 300;
// Nominal-voltage naming differs between sources (66 vs 69 kV, 220 vs 230 kV).
const VOLTAGE_TOLERANCE = 0.1;
const GENERIC_NAME_TOKENS = new Set([
  "substation", "sub", "station", "switching", "switchyard", "electric", "electricity", "power", "the", "ss",
  "receiving", "distributing",
]);

interface OsmProperties {
  osm_id?: unknown;
  name?: unknown;
  operator?: unknown;
  voltage_kv?: unknown;
  substation?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function point(geometry: unknown): Position | null {
  const { type, coordinates } = (geometry ?? {}) as { type?: string; coordinates?: unknown };
  if (type !== "Point" || !Array.isArray(coordinates)) return null;
  const [lon, lat] = coordinates;
  return typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat)
    ? [lon, lat] : null;
}

function nameCore(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !GENERIC_NAME_TOKENS.has(token) && !/^\d+kv$/.test(token) && token !== "kv")
    .join(" ");
}

function bigrams(value: string): string[] {
  const compact = value.replace(/\s+/g, "");
  return Array.from({ length: Math.max(compact.length - 1, 0) }, (_, index) => compact.slice(index, index + 2));
}

/** Dice coefficient over character bigrams of the names with generic words removed; null if either is unavailable. */
export function nameSimilarity(osm: string | null, hifld: string | null): number | null {
  if (!osm || !hifld) return null;
  const [left, right] = [nameCore(osm), nameCore(hifld)];
  if (!left || !right) return null;
  if (left === right) return 1;
  const a = bigrams(left);
  const pool = bigrams(right);
  if (!a.length || !pool.length) return 0;
  let shared = 0;
  for (const gram of a) {
    const index = pool.indexOf(gram);
    if (index >= 0) {
      shared += 1;
      pool.splice(index, 1);
    }
  }
  return Math.round((2 * shared / (a.length + bigrams(right).length)) * 1000) / 1000;
}

/**
 * Review hint only. An OSM voltage tag and HIFLD MAX_VOLT/MIN_VOLT have different definitions, so
 * "consistent" means the OSM value falls within the HIFLD range (+/-10%), never that they agree.
 */
export function voltageHint(osmKv: number | null, maxKv: number | null, minKv: number | null) {
  if (osmKv === null || (maxKv === null && minKv === null)) return "unknown" as const;
  const bounds = [maxKv, minKv].filter((value): value is number => value !== null);
  const low = maxKv !== null && minKv !== null ? Math.min(...bounds) : 0;
  const high = Math.max(...bounds);
  return osmKv >= low * (1 - VOLTAGE_TOLERANCE) && osmKv <= high * (1 + VOLTAGE_TOLERANCE)
    ? "consistent" as const : "inconsistent" as const;
}

function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

export async function crosswalkCandidates(osmFile: string, manifestFile: string, maxMetres = DEFAULT_MAX_METRES) {
  if (!Number.isFinite(maxMetres) || maxMetres <= 0 || maxMetres > 5000) {
    throw new Error("Expected a candidate distance between 0 and 5000 metres");
  }
  const osmBytes = await readFile(resolve(osmFile));
  const osm = JSON.parse(osmBytes.toString("utf8")) as { features: { properties: OsmProperties; geometry: unknown }[] };
  const manifest = JSON.parse(await readFile(resolve(manifestFile), "utf8")) as AssetManifest;
  if (manifest.source !== "hifld-substations") throw new Error("Expected a HIFLD substation manifest");
  const official = await replayAssets(manifest);
  const [centerLat, centerLon] = manifest.query.center;
  const center: Position = [centerLon, centerLat];
  const radiusMiles = manifest.query.radius_miles;

  const hifld = official.features.map((feature) => {
    const properties = feature.properties as Record<string, unknown>;
    const position = point(feature.geometry);
    if (!position) throw new Error(`HIFLD substation without point geometry: ${feature.id}`);
    return {
      id: feature.id, position, citation: feature.citation,
      recordId: text(properties.ID),
      name: hifldSubstationName(properties),
      rawName: text(properties.NAME),
      type: text(properties.TYPE),
      status: text(properties.STATUS),
      maxKv: hifldVoltage(properties.MAX_VOLT),
      minKv: hifldVoltage(properties.MIN_VOLT),
      withinRadius: greatCircleMiles(center, position) <= radiusMiles,
    };
  });

  const seen = new Set<string>();
  const community = osm.features.map(({ properties, geometry }) => {
    const source = osmSubstationSource(properties.osm_id);
    const position = point(geometry);
    if (!source || !position || seen.has(source.id)) throw new Error("Invalid or duplicate substation OSM record");
    seen.add(source.id);
    return {
      id: source.id, url: source.url, position,
      name: text(properties.name), operator: text(properties.operator),
      voltageKv: typeof properties.voltage_kv === "number" && properties.voltage_kv > 0 ? properties.voltage_kv : null,
      tag: text(properties.substation),
    };
  });

  const candidates = community.flatMap((record) => {
    const near = hifld
      .map((official) => ({ official, metres: greatCircleMiles(record.position, official.position) * METRES_PER_MILE }))
      .filter(({ metres }) => metres <= maxMetres)
      .sort((a, b) => a.metres - b.metres || a.official.id.localeCompare(b.official.id));
    return near.map(({ official, metres }, index) => ({
      osm: record.id,
      hifld: official.id,
      snapshot: official.citation.snapshot,
      citation: official.citation,
      rank: index + 1,
      osm_alternatives: near.length,
      distance_m: Math.round(metres * 10) / 10,
      osm_record: {
        url: record.url, name: record.name, operator: record.operator,
        voltage_kv_tag: record.voltageKv, substation_tag: record.tag,
      },
      hifld_record: {
        record_id: official.recordId, name: official.name, name_as_published: official.rawName,
        type: official.type, status: official.status,
        max_volt_kv: official.maxKv, min_volt_kv: official.minKv,
      },
      features: {
        name_similarity: nameSimilarity(record.name, official.name),
        voltage_hint: voltageHint(record.voltageKv, official.maxKv, official.minKv),
      },
      review: { status: "unreviewed" as const },
    }));
  });

  const nearestCount = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.rank === 1) nearestCount.set(candidate.hifld, (nearestCount.get(candidate.hifld) ?? 0) + 1);
  }
  const rows = candidates.map((candidate) => ({
    ...candidate, hifld_nearest_for_osm: nearestCount.get(candidate.hifld) ?? 0,
  }));

  const nearest = rows.filter(({ rank }) => rank === 1);
  const distances = nearest.map(({ distance_m }) => distance_m).sort((a, b) => a - b);
  const edges = [...[25, 50, 100, 200].filter((edge) => edge < maxMetres), maxMetres];
  const buckets = Object.fromEntries(edges.map((edge, index) => {
    const low = index ? edges[index - 1] : 0;
    return [`${low}-${edge}m`, distances.filter((value) => (index ? value > low : value >= 0) && value <= edge).length];
  }));
  const pairedHifld = new Set(rows.map(({ hifld: id }) => id));
  const inRadius = hifld.filter(({ withinRadius }) => withinRadius);
  const orphaned = inRadius.filter(({ id }) => !pairedHifld.has(id));
  const tally = (values: (string | null)[]) => {
    const counts: Record<string, number> = {};
    for (const value of values) counts[value ?? "unavailable"] = (counts[value ?? "unavailable"] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort());
  };
  const stats = {
    corroborated: 0,
    osm_total: community.length,
    osm_with_candidate: nearest.length,
    osm_unnamed: community.filter(({ name }) => !name).length,
    osm_unnamed_with_candidate: nearest.filter(({ osm_record }) => !osm_record.name).length,
    candidate_rows: rows.length,
    osm_with_multiple_candidates: nearest.filter(({ osm_alternatives }) => osm_alternatives > 1).length,
    nearest_distance_m: {
      min: distances[0] ?? null, p25: percentile(distances, 0.25), median: percentile(distances, 0.5),
      p75: percentile(distances, 0.75), p90: percentile(distances, 0.9), max: distances.at(-1) ?? null,
      buckets,
    },
    nearest_name_similarity: {
      unavailable: nearest.filter(({ features }) => features.name_similarity === null).length,
      at_least_0_8: nearest.filter(({ features }) => (features.name_similarity ?? -1) >= 0.8).length,
      between_0_4_and_0_8: nearest.filter(({ features }) =>
        features.name_similarity !== null && features.name_similarity >= 0.4 && features.name_similarity < 0.8).length,
      below_0_4: nearest.filter(({ features }) => features.name_similarity !== null && features.name_similarity < 0.4).length,
    },
    nearest_voltage_hint: tally(nearest.map(({ features }) => features.voltage_hint)),
    hifld_nearest_for_multiple_osm: [...nearestCount.values()].filter((count) => count > 1).length,
    hifld_total_in_capture: hifld.length,
    hifld_within_radius: inRadius.length,
    hifld_within_radius_without_candidate: orphaned.length,
    hifld_within_radius_without_candidate_by_type: tally(orphaned.map(({ type }) => type)),
  };

  const data = {
    schema: "mapergy.substation-crosswalk-candidates/1",
    notice: "Candidates only. None is corroborated until a person reviews it: set review.status to \"reviewed\", " +
      "add review.reviewer and an identity `evidence` string, keep one row per OSM and HIFLD record, and pass the " +
      "resulting array to audit-substations. Absence of a candidate does not imply a missing asset in either source.",
    method: {
      max_distance_m: maxMetres,
      distance: "great-circle between the OSM outline centroid and the HIFLD point (geometry.ts)",
      name_similarity: "character-bigram Dice on names with generic words removed; HIFLD <TYPE><ID> placeholders are unavailable",
      voltage_hint: "OSM voltage tag within HIFLD MIN_VOLT..MAX_VOLT +/-10%; a hint, not an agreement",
    },
    inputs: {
      osm: { path: osmFile, sha256: createHash("sha256").update(osmBytes).digest("hex") },
      hifld_manifest: { path: manifestFile, digest: digest(manifest), index_snapshot: manifest.index.id },
      query: manifest.query,
    },
    stats,
    candidates: rows,
  };
  const revision = digest(data);
  const directory = resolve(stateRoot(), "crosswalk", locationId(manifest.query));
  const json = resolve(directory, `candidates-${revision.slice(0, 16)}.json`);
  const csv = resolve(directory, `candidates-${revision.slice(0, 16)}.csv`);
  await atomicJson(json, data);
  const header = [
    "osm", "osm_url", "osm_name", "osm_operator", "osm_voltage_kv_tag", "osm_substation_tag",
    "hifld", "hifld_record_id", "hifld_name", "hifld_name_as_published", "hifld_type", "hifld_status",
    "hifld_max_volt_kv", "hifld_min_volt_kv", "distance_m", "rank", "osm_alternatives", "hifld_nearest_for_osm",
    "name_similarity", "voltage_hint", "snapshot", "locator", "review_status", "reviewer", "evidence",
  ];
  const lines = rows.map((row) => [
    row.osm, row.osm_record.url, row.osm_record.name, row.osm_record.operator, row.osm_record.voltage_kv_tag,
    row.osm_record.substation_tag, row.hifld, row.hifld_record.record_id, row.hifld_record.name,
    row.hifld_record.name_as_published, row.hifld_record.type, row.hifld_record.status,
    row.hifld_record.max_volt_kv, row.hifld_record.min_volt_kv, row.distance_m, row.rank, row.osm_alternatives,
    row.hifld_nearest_for_osm, row.features.name_similarity, row.features.voltage_hint,
    row.citation.snapshot, row.citation.locator, row.review.status, "", "",
  ].map(csvCell).join(","));
  await mkdir(directory, { recursive: true });
  const temporary = `${csv}.${randomUUID()}.tmp`;
  await writeFile(temporary, [header.join(","), ...lines].join("\n") + "\n");
  await rename(temporary, csv);
  return { json, csv, revision, stats };
}

/** CLI entry (not yet wired): crosswalk-candidates <osm.geojson> <hifld-substations manifest> [--max-metres N] */
export async function runCrosswalkCandidatesCommand(args: string[]) {
  const [osmFile, manifestFile, flag, value, ...extra] = args;
  if (!osmFile || !manifestFile || extra.length || (flag !== undefined && (flag !== "--max-metres" || !value))) {
    throw new Error("Expected crosswalk-candidates <osm.geojson> <hifld-substations manifest> [--max-metres N]");
  }
  return crosswalkCandidates(osmFile, manifestFile, flag ? Number(value) : DEFAULT_MAX_METRES);
}
