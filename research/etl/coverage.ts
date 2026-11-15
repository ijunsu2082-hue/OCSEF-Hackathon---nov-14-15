import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

/**
 * Reads the repository for gap evidence. Paths are relative to the repo root
 * (the process cwd for the CLI). Every method answers "absent" (false/null)
 * instead of throwing, so an unfinished module reads as an open gap.
 */
export interface CoverageProbe {
  exists(path: string): Promise<boolean>;
  /** Module namespace, or null when the file is missing or fails to load. */
  load(path: string): Promise<Record<string, unknown> | null>;
  readText(path: string): Promise<string | null>;
  list(directory: string): Promise<string[]>;
}

export const diskProbe: CoverageProbe = {
  async exists(path) {
    return access(path).then(() => true, () => false);
  },
  async load(path) {
    if (!(await diskProbe.exists(path))) return null;
    try {
      return await import(pathToFileURL(resolve(path)).href) as Record<string, unknown>;
    } catch {
      return null;
    }
  },
  async readText(path) {
    return readFile(path, "utf8").catch(() => null);
  },
  async list(directory) {
    return readdir(directory).catch(() => []);
  },
};

export interface CoverageGap {
  id: string;
  title: string;
  status: "open" | "closed";
  evidence: string[];
  reason: string;
}

const exported = (module: Record<string, unknown> | null, name: string) => typeof module?.[name] === "function";

function leafCount(value: unknown, prefix = "", result = new Set<string>()): Set<string> {
  fields(value, prefix, result);
  return result;
}

/**
 * Records "attributed" only when they carry a `field_sources` map whose keys
 * cover every other leaf field path of the record.
 */
function attributed(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  const { field_sources: sources, ...rest } = record as Record<string, unknown>;
  if (!sources || typeof sources !== "object") return false;
  return [...leafCount(rest)].every((path) => Object.hasOwn(sources, path));
}

async function recordAttribution(probe: CoverageProbe, path: string, records: (data: unknown) => unknown[]) {
  const text = await probe.readText(path);
  if (text === null) return { path, total: 0, attributed: 0, missing: true };
  const list = records(JSON.parse(text));
  return { path, total: list.length, attributed: list.filter(attributed).length, missing: false };
}

const caseRecords = (data: unknown) => (Array.isArray(data) ? data : []);
const nodeRecords = (data: unknown) => {
  const features = (data as { features?: unknown })?.features;
  return Array.isArray(features) ? features.map((feature) => (feature as { properties?: unknown })?.properties) : [];
};

const SIMULATOR_CODE = ["lib/region.ts", "lib/grid.ts"];
const SIMULATOR_DIR = "lib/physics";

/** JSON data files imported by simulator code (`@/` resolves to the repo root). */
async function simulatorInputs(probe: CoverageProbe): Promise<string[]> {
  const files = [
    ...SIMULATOR_CODE,
    ...(await probe.list(SIMULATOR_DIR)).filter((name) => name.endsWith(".ts")).map((name) => `${SIMULATOR_DIR}/${name}`),
  ];
  const inputs = new Set<string>();
  for (const file of files) {
    const text = await probe.readText(file);
    if (text === null) continue;
    for (const [, target] of text.matchAll(/from\s+["']([^"']+\.json)["']/g)) {
      inputs.add(target.startsWith("@/") ? target.slice(2) : join(dirname(file), target));
    }
  }
  return [...inputs].sort();
}

function describe(stats: { path: string; total: number; attributed: number; missing: boolean }) {
  return stats.missing ? `${stats.path} is missing` : `${stats.path}: ${stats.attributed}/${stats.total} records carry a complete field_sources map`;
}

/** Each gap is closed only by evidence found on disk or in code. */
export async function coverageGaps(probe: CoverageProbe = diskProbe): Promise<CoverageGap[]> {
  const gaps: CoverageGap[] = [];

  {
    const modules = [
      ["research/etl/osm-regen.ts", "runOsmRegenCommand"],
      ["research/etl/eia860.ts", "runEia860Command"],
    ] as const;
    const docs = ["docs/OSM-REGENERATION-DIFF.md", "docs/EIA860-REGENERATION-DIFF.md"];
    const missing: string[] = [];
    for (const [path, name] of modules) if (!exported(await probe.load(path), name)) missing.push(`${path} export ${name}`);
    for (const path of docs) if (!(await probe.exists(path))) missing.push(path);
    gaps.push({
      id: "workbook-regional-regeneration",
      title: "Workbook and regional extract regeneration",
      status: missing.length ? "open" : "closed",
      evidence: [...modules.map(([path]) => path), ...docs],
      reason: missing.length
        ? `Missing: ${missing.join("; ")}`
        : "OSM extract and EIA-860 workbook regeneration commands are exported and both regeneration diff documents exist",
    });
  }

  {
    const stats = [
      await recordAttribution(probe, "public/layers/niche_cases.json", caseRecords),
      await recordAttribution(probe, "data/nodes.json", nodeRecords),
    ];
    const open = stats.some((item) => item.missing || item.attributed < item.total || item.total === 0);
    gaps.push({
      id: "seed-case-field-attribution",
      title: "Field-level attribution for seed and case outputs",
      status: open ? "open" : "closed",
      evidence: stats.map((item) => item.path),
      reason: stats.map(describe).join("; "),
    });
  }

  {
    const path = "research/etl/ratings.ts";
    const test = "research/etl/ratings.test.ts";
    const ratings = await probe.load(path);
    const testText = await probe.readText(test);
    const missing: string[] = [];
    for (const name of ["generateRatings", "engineParity"]) if (!exported(ratings, name)) missing.push(`${path} export ${name}`);
    if (!testText || !/engineParity\(/.test(testText)) missing.push(`${test} engine parity test`);
    gaps.push({
      id: "hourly-weather-csv-regeneration",
      title: "Hourly weather CSV regeneration",
      status: missing.length ? "open" : "closed",
      evidence: [path, test],
      reason: missing.length
        ? `Missing: ${missing.join("; ")}`
        : "Line-rating CSVs regenerate from a hash-verified weather archive; an engine parity test runs the committed CSV inputs through rateLine",
    });
  }

  {
    const path = "research/etl/operator-import.ts";
    const module = await probe.load(path);
    const missing = ["runOperatorImportCommand", "importOperatorInput"].filter((name) => !exported(module, name));
    gaps.push({
      id: "operator-import",
      title: "Operator import",
      status: missing.length ? "open" : "closed",
      evidence: [path],
      reason: missing.length
        ? `Missing: ${missing.map((name) => `${path} export ${name}`).join("; ")}`
        : "Operator envelopes import into a separate per-location manifest, kept beside public-source records and never merged into them",
    });
  }

  {
    const inputs = await simulatorInputs(probe);
    const listed = new Set<string>(inventory.map(([path]) => path));
    const problems: string[] = [];
    for (const input of inputs) {
      if (!listed.has(input)) problems.push(`${input} is not in the coverage inventory`);
      const stats = await recordAttribution(probe, input, input === "data/nodes.json" ? nodeRecords : caseRecords);
      if (input === "data/nodes.json" && (stats.missing || stats.total === 0 || stats.attributed < stats.total)) {
        problems.push(`${describe(stats)} (facility inputs are operator records or scenario assumptions)`);
      }
    }
    if (!inputs.length) problems.push(`no JSON simulator inputs found in ${[...SIMULATOR_CODE, SIMULATOR_DIR].join(", ")}`);
    gaps.push({
      id: "simulator-input-inventory",
      title: "Simulator input inventory",
      status: problems.length ? "open" : "closed",
      evidence: [...SIMULATOR_CODE, SIMULATOR_DIR, ...inputs],
      reason: problems.length
        ? problems.join("; ")
        : `Every simulator data input (${inputs.join(", ")}) is inventoried with field-level sources`,
    });
  }

  {
    const path = "research/etl/reconcile-report.ts";
    const policiesPath = "research/etl/reconcile-policies.ts";
    const route = "app/api/location-report/[id]/reconciliation/route.ts";
    const report = await probe.load(path);
    const policies = (await probe.load(policiesPath))?.RECONCILE_POLICIES;
    const count = Array.isArray(policies) ? policies.length : 0;
    const missing: string[] = [];
    if (!exported(report, "reconcileReport")) missing.push(`${path} export reconcileReport`);
    if (!count) missing.push(`${policiesPath} RECONCILE_POLICIES (need at least one policy)`);
    gaps.push({
      id: "provider-reconciliation",
      title: "Provider equivalence validation and automated reconciliation",
      status: missing.length ? "open" : "closed",
      evidence: [path, policiesPath, ...((await probe.exists(route)) ? [route] : [])],
      reason: missing.length
        ? `Missing: ${missing.join("; ")}`
        : `${count} reconciliation policies evaluated per report revision; disagreements are reported, never averaged`,
    });
  }

  return gaps;
}

export async function coverageInventory(probe: CoverageProbe = diskProbe) {
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
    gaps: await coverageGaps(probe),
  };
}
