import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { osmSubstationSource } from "../../lib/substationSource";
import { replayAssets, type AssetManifest } from "./assets";

interface SubstationProperties {
  osm_id?: string;
  name?: string | null;
  operator?: string | null;
  voltage_kv?: number | null;
}

interface Crosswalk {
  osm: string;
  hifld: string;
  snapshot: string;
  evidence: string;
  /** Absent on legacy reviewed arrays. When present, only `reviewed` with a named reviewer counts. */
  review?: { status?: unknown; reviewer?: unknown };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** HIFLD NAME, or null for the layer's "<TYPE><ID>" placeholders (e.g. UNKNOWN300042, TAP300101). */
export function hifldSubstationName(properties: Record<string, unknown>): string | null {
  const name = text(properties.NAME);
  const id = text(properties.ID);
  return name && id && ["UNKNOWN", "TAP", "RISER", "DEADEND"].some((type) => name === `${type}${id}`) ? null : name;
}

/** HIFLD MAX_VOLT/MIN_VOLT in kV, or null for the -999999 "not available" sentinel and other non-positive values. */
export function hifldVoltage(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

const isReviewed = ({ review }: Crosswalk) =>
  review === undefined || (review?.status === "reviewed" && text(review.reviewer) !== null);

function check(left: string | null, right: string | null) {
  const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
  return {
    osm: left, hifld: right,
    status: left === null || right === null ? "missing"
      : normalized(left) === normalized(right) ? "agreement" : "conflict",
  };
}

/**
 * Tokens that describe the kind of facility rather than name it. Same list as
 * crosswalk-candidates.ts GENERIC_NAME_TOKENS, so a candidate's name_similarity
 * of 1 and an audit name "agreement" mean the same thing.
 */
const GENERIC_NAME_TOKENS = new Set([
  "substation", "sub", "station", "switching", "switchyard", "electric", "electricity", "power", "the", "ss",
  "receiving", "distributing",
]);

/**
 * Comparison key for a substation name, or null when nothing specific is left.
 * Steps: Unicode compatibility decomposition with accents removed; case fold;
 * every run of non-letter, non-digit characters (punctuation, brackets,
 * whitespace) becomes a token break; generic tokens above, "kv" and "<n>kv"
 * are dropped; the remaining tokens are joined without spaces, so word
 * splitting does not matter ("Mira Loma" = "MIRALOMA").
 * Example: "Lucas Substation (electricity)" and "LUCAS" both give "lucas".
 */
export function substationNameKey(name: string | null): string | null {
  if (name === null) return null;
  const key = name.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token && !GENERIC_NAME_TOKENS.has(token) && !/^\d*kv$/.test(token))
    .join("");
  return key || null;
}

/**
 * Name comparison on `substationNameKey`. The raw values stay side by side;
 * "missing" when either side has no name or only generic words ("Substation").
 */
function checkName(osm: string | null, hifld: string | null) {
  const [left, right] = [substationNameKey(osm), substationNameKey(hifld)];
  return {
    osm, hifld,
    status: left === null || right === null ? "missing" : left === right ? "agreement" : "conflict",
  };
}

export async function auditSubstations(osmFile: string, manifestFile: string, crosswalkFile: string) {
  const [osm, manifest, crosswalk] = await Promise.all(
    [osmFile, manifestFile, crosswalkFile].map(async (path) => JSON.parse(await readFile(resolve(path), "utf8"))),
  ) as [{ features: { properties: SubstationProperties }[] }, AssetManifest, Crosswalk[]];
  if (manifest.source !== "hifld-substations") throw new Error("Expected a HIFLD substation manifest");
  if (!Array.isArray(crosswalk)) throw new Error("Expected a reviewed crosswalk array");
  const unreviewed = crosswalk.filter((row) => !isReviewed(row));
  const official = await replayAssets(manifest);
  const byOsm = new Map<string, SubstationProperties>();
  for (const { properties } of osm.features) {
    const id = osmSubstationSource(properties.osm_id)?.id;
    if (!id || byOsm.has(id)) throw new Error("Invalid or duplicate substation OSM ID");
    byOsm.set(id, properties);
  }
  const byHifld = new Map(official.features.map((feature) => [feature.id, feature]));
  const matchedOsm = new Set<string>();
  const matchedHifld = new Set<string>();
  const comparisons = crosswalk.filter(isReviewed).map(({ osm, hifld, snapshot, evidence }) => {
    const community = byOsm.get(osm);
    const inventory = byHifld.get(hifld);
    if (!community || !inventory || inventory.citation.snapshot !== snapshot ||
        !text(evidence) || matchedOsm.has(osm) || matchedHifld.has(hifld)) {
      throw new Error(`Invalid or ambiguous crosswalk: ${osm} / ${hifld}`);
    }
    matchedOsm.add(osm);
    matchedHifld.add(hifld);
    const properties = inventory.properties;
    return {
      osm: osmSubstationSource(osm), hifld, mappingEvidence: evidence, citation: inventory.citation,
      name: checkName(text(community.name), hifldSubstationName(properties)),
      operator: check(text(community.operator), text(properties.OPERATOR)),
      hifldOwner: text(properties.OWNER),
      // HIFLD maximum voltage and an OSM voltage tag have distinct definitions.
      voltage: { osm: community.voltage_kv ?? null, hifldMaximum: hifldVoltage(properties.MAX_VOLT), status: "incomparable" },
    };
  });
  return {
    schema: "gridsentinel.substation-audit/1",
    totals: {
      osm: byOsm.size, hifld: byHifld.size, matched: comparisons.length, unreviewed: unreviewed.length,
      osmNameUnavailable: [...byOsm.values()].filter((record) => !text(record.name)).length,
    },
    comparisons,
    // Unreviewed or rejected candidates establish nothing; they are listed, never compared.
    unreviewed: unreviewed.map(({ osm, hifld, review }) =>
      ({ osm, hifld, status: text(review?.status) ?? "unspecified" })),
    unmatchedOsm: [...byOsm.keys()].filter((id) => !matchedOsm.has(id)).sort(),
    unmatchedHifld: [...byHifld.keys()].filter((id) => !matchedHifld.has(id)).sort(),
  };
}
