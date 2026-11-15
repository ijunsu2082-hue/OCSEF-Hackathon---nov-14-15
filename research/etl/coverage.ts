import { readFile } from "node:fs/promises";
import { PREDICATES } from "../../lib/evidence/predicates";

const inventory = [
  ["public/layers/plants.geojson", "EIA-860", "plant_code", "plant", "annual", "public", "workbook adapter pending"],
  ["public/layers/transmission.geojson", "OpenStreetMap", "osm_id", "line", "extract", "public", "extract adapter pending"],
  ["public/layers/substations.geojson", "OpenStreetMap", "osm_id", "substation", "extract", "public", "extract adapter pending"],
  ["public/layers/niche_cases.json", "Case scenario", "id", "case", "scenario", "model", "field provenance review pending"],
  ["data/nodes.json", "Operator records or scenario assumptions", "id", "facility", "varies", "operator", "field provenance review pending"],
  ["data/regions.json", "Region configuration", "id", "region", "configuration", "model", "caller configuration"],
] as const;

function fields(value: unknown, prefix: string, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) fields(item, `${prefix}[]`, result);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) fields(item, prefix ? `${prefix}.${key}` : key, result);
  } else if (prefix) {
    result.add(prefix);
  }
}

export async function coverageInventory() {
  const artifacts = await Promise.all(inventory.map(async ([path, dataset, entityKey, scope, grain, acquisition, status]) => {
    const paths = new Set<string>();
    fields(JSON.parse(await readFile(path, "utf8")), "", paths);
    return {
      path, dataset, entityKey, scope, grain, acquisition, status,
      fallback: "Pinned artifact for existing region", fields: [...paths].sort(),
    };
  }));
  return {
    artifacts,
    predicates: Object.values(PREDICATES).map(({ id, unit, allowed_methods }) => ({ id, unit, allowed_methods })),
    gaps: [
      "Workbook and regional extract regeneration",
      "Field-level attribution for seed and case outputs",
      "Hourly weather CSV regeneration",
      "Simulator input inventory and operator import",
      "Provider equivalence validation and automated reconciliation",
    ],
  };
}
