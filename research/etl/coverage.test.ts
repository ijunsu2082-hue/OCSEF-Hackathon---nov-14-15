import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { coverageGaps, coverageInventory, type CoverageProbe } from "./coverage";

const fn = () => undefined;

function probe(files: Record<string, string>, modules: Record<string, Record<string, unknown>>): CoverageProbe {
  return {
    async exists(path) {
      return path in files || path in modules;
    },
    async load(path) {
      return modules[path] ?? null;
    },
    async readText(path) {
      return files[path] ?? null;
    },
    async list(directory) {
      return Object.keys(files).filter((path) => path.startsWith(`${directory}/`)).map((path) => path.slice(directory.length + 1));
    },
  };
}

const attributedCase = { id: "c1", title: "T", stats: [{ v: 1 }], field_sources: { id: "s", title: "s", "stats[].v": "s" } };
const attributedNode = { id: "n1", name: "N", field_sources: { id: "s", name: "s" } };

const complete = {
  files: {
    "docs/OSM-REGENERATION-DIFF.md": "#",
    "docs/EIA860-REGENERATION-DIFF.md": "#",
    "research/etl/ratings.test.ts": "engineParity(sample)",
    "public/layers/niche_cases.json": JSON.stringify([attributedCase]),
    "data/nodes.json": JSON.stringify({ features: [{ properties: attributedNode }] }),
    "lib/region.ts": 'import rawData from "@/data/nodes.json";',
  },
  modules: {
    "research/etl/osm-regen.ts": { runOsmRegenCommand: fn },
    "research/etl/eia860.ts": { runEia860Command: fn },
    "research/etl/ratings.ts": { generateRatings: fn, engineParity: fn },
    "research/etl/operator-import.ts": { runOperatorImportCommand: fn, importOperatorInput: fn },
    "research/etl/reconcile-report.ts": { reconcileReport: fn },
    "research/etl/reconcile-policies.ts": { RECONCILE_POLICIES: [{ id: "p" }] },
  },
};

const byId = (gaps: Awaited<ReturnType<typeof coverageGaps>>) => new Map(gaps.map((gap) => [gap.id, gap]));

test("every gap is open when no evidence exists", async () => {
  const gaps = await coverageGaps(probe({}, {}));
  assert.deepEqual(gaps.map(({ id }) => id), [
    "workbook-regional-regeneration", "seed-case-field-attribution", "hourly-weather-csv-regeneration",
    "operator-import", "simulator-input-inventory", "provider-reconciliation",
  ]);
  for (const gap of gaps) {
    assert.equal(gap.status, "open", gap.id);
    assert.ok(gap.reason.length > 0);
    assert.ok(gap.evidence.length > 0);
  }
});

test("every gap closes when its evidence is present", async () => {
  const gaps = await coverageGaps(probe(complete.files, complete.modules));
  for (const gap of gaps) assert.equal(gap.status, "closed", `${gap.id}: ${gap.reason}`);
  assert.ok(byId(gaps).get("simulator-input-inventory")!.evidence.includes("data/nodes.json"));
});

test("a single missing piece of evidence reopens only its gap, with a precise reason", async () => {
  const { "docs/EIA860-REGENERATION-DIFF.md": _doc, ...files } = complete.files;
  const modules = { ...complete.modules, "research/etl/reconcile-policies.ts": { RECONCILE_POLICIES: [] } };
  const gaps = byId(await coverageGaps(probe(files, modules)));
  assert.equal(gaps.get("workbook-regional-regeneration")!.status, "open");
  assert.match(gaps.get("workbook-regional-regeneration")!.reason, /docs\/EIA860-REGENERATION-DIFF\.md/);
  assert.equal(gaps.get("provider-reconciliation")!.status, "open");
  assert.match(gaps.get("provider-reconciliation")!.reason, /at least one policy/);
  assert.equal(gaps.get("operator-import")!.status, "closed");
  assert.equal(gaps.get("hourly-weather-csv-regeneration")!.status, "closed");
});

test("a field_sources map must cover every leaf field of the record", async () => {
  const partial = { ...attributedCase, field_sources: { id: "s" } };
  const files = { ...complete.files, "public/layers/niche_cases.json": JSON.stringify([attributedCase, partial]) };
  const gap = byId(await coverageGaps(probe(files, complete.modules))).get("seed-case-field-attribution")!;
  assert.equal(gap.status, "open");
  assert.match(gap.reason, /niche_cases\.json: 1\/2 records/);
});

test("a module that fails to export its entry point leaves the gap open", async () => {
  const modules = { ...complete.modules, "research/etl/ratings.ts": { generateRatings: fn } };
  const files = { ...complete.files, "research/etl/ratings.test.ts": "no parity here" };
  const gap = byId(await coverageGaps(probe(files, modules))).get("hourly-weather-csv-regeneration")!;
  assert.equal(gap.status, "open");
  assert.match(gap.reason, /export engineParity/);
  assert.match(gap.reason, /engine parity test/);
});

test("the repository inventory reports computed gaps and --strict exits 1 iff any is open", async () => {
  const inventory = await coverageInventory();
  for (const gap of inventory.gaps) {
    assert.ok(gap.status === "open" || gap.status === "closed");
    assert.ok(Array.isArray(gap.evidence) && gap.reason);
  }
  // The seed and case layers carry no field-level sources in this repository.
  assert.equal(byId(inventory.gaps).get("seed-case-field-attribution")!.status, "open");
  const run = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "research/etl/cli.ts", "coverage", "--strict"], {
    encoding: "utf8",
  });
  const printed = JSON.parse(run.stdout) as typeof inventory;
  assert.deepEqual(printed.gaps, inventory.gaps);
  assert.equal(run.status, inventory.gaps.some((gap) => gap.status === "open") ? 1 : 0);
});
