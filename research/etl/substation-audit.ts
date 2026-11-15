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
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function check(left: string | null, right: string | null) {
  const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
  return {
    osm: left, hifld: right,
    status: left === null || right === null ? "missing"
      : normalized(left) === normalized(right) ? "agreement" : "conflict",
  };
}

export async function auditSubstations(osmFile: string, manifestFile: string, crosswalkFile: string) {
  const [osm, manifest, crosswalk] = await Promise.all(
    [osmFile, manifestFile, crosswalkFile].map(async (path) => JSON.parse(await readFile(resolve(path), "utf8"))),
  ) as [{ features: { properties: SubstationProperties }[] }, AssetManifest, Crosswalk[]];
  if (manifest.source !== "hifld-substations") throw new Error("Expected a HIFLD substation manifest");
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
  const comparisons = crosswalk.map(({ osm, hifld, snapshot, evidence }) => {
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
      name: check(text(community.name), text(properties.NAME)),
      operator: check(text(community.operator), text(properties.OPERATOR)),
      hifldOwner: text(properties.OWNER),
      // HIFLD maximum voltage and an OSM voltage tag have distinct definitions.
      voltage: { osm: community.voltage_kv ?? null, hifldMaximum: properties.MAX_VOLT ?? null, status: "incomparable" },
    };
  });
  return {
    schema: "gridsentinel.substation-audit/1",
    totals: {
      osm: byOsm.size, hifld: byHifld.size, matched: comparisons.length,
      osmNameUnavailable: [...byOsm.values()].filter((record) => !text(record.name)).length,
    },
    comparisons,
    unmatchedOsm: [...byOsm.keys()].filter((id) => !matchedOsm.has(id)).sort(),
    unmatchedHifld: [...byHifld.keys()].filter((id) => !matchedHifld.has(id)).sort(),
  };
}
