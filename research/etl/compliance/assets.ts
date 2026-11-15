/*
 * ETL: the personalised compliance record for each asset.
 *
 * This is where "what do I have to file" is decided, not in the browser. For every plant
 * and substation in the layers it runs the obligations engine, applies the decisions
 * (public/compliance/applicability.json) and the form prefill (public/compliance/forms.json),
 * and writes one small record per asset, public/compliance/assets/<kind>-<id>.json:
 *
 *   { kind, id, name, owner, filings: [{ id, status, basis, source, question,
 *                                       sources: [instrument urls], prefill, manual }] }
 *
 * One file per asset keeps the download to a few kilobytes when an owner opens a plant;
 * a single file for all 697 plants came to 6 MB. The Compliance tab reads the record for
 * the selected asset and shows it with the sources named. Lines are not written: their
 * filings come from four generic rules with no per-asset form, so the tab keeps computing
 * those at runtime.
 */
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { atomicJson } from "../pipeline";
import { toPlant, toSubstation } from "../../../lib/scan/data";
import type { AssetKind, Obligation, OwnedAsset } from "../../../lib/owner/types";
import { previewObligations } from "../../../lib/owner/obligations";
import { determineAll, type ProgramIndex } from "../../../lib/owner/applicability";
import { resolveWorksheet, type FormCatalog } from "../../../lib/owner/forms";
import {
  ASSETS_SCHEMA,
  assetKey,
  type AssetComplianceRecord,
  type AssetComplianceIndex,
  type AssetFiling,
} from "../../../lib/owner/assetCompliance";

export const DEFAULT_ASSETS_DIR = "public/compliance/assets";
const DEFAULT_INDEX = "public/compliance/applicability.json";
const DEFAULT_FORMS = "public/compliance/forms.json";
const PLANTS = "public/layers/plants.geojson";
const SUBSTATIONS = "public/layers/substations.geojson";

const KINDS: AssetKind[] = ["plant", "substation"];

export interface AssetsOptions {
  outDir?: string;
  programIndexPath?: string;
  formsPath?: string;
  plantsPath?: string;
  substationsPath?: string;
  /** Only decide the first N assets of each kind (a quick run). */
  limit?: number;
}

export interface AssetsSummary {
  out_dir: string;
  files: { kind: AssetKind; path: string; assets: number; filings: number; prefilled: number; bytes: number }[];
  unavailable: string[];
}

interface GeoFeature {
  geometry?: { type?: string; coordinates?: unknown };
  properties?: Record<string, unknown>;
}

function asFeature(value: unknown): GeoFeature {
  return (value && typeof value === "object" ? value : {}) as GeoFeature;
}

async function readFeatures(path: string): Promise<GeoFeature[]> {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(await readFile(path, "utf8")) as { features?: unknown[] };
  return Array.isArray(raw.features) ? raw.features.map(asFeature) : [];
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function sourceUrls(obligation: Obligation): string[] {
  const seen = new Set<string>();
  for (const c of obligation.citations ?? []) if (c.url) seen.add(c.url);
  return [...seen];
}

/** One asset's record: the decisions, the prefill, and the instruments behind them. */
export function recordFor(
  asset: OwnedAsset,
  index: ProgramIndex | null,
  catalog: FormCatalog | null,
  answers = {},
): AssetComplianceRecord {
  const obligations = previewObligations(asset);
  const determinations = determineAll(asset, obligations, index, answers);
  const filings: AssetFiling[] = obligations.map((o) => {
    const d = determinations[o.id];
    const worksheet = resolveWorksheet(asset, o, catalog);
    return {
      id: o.id,
      status:
        d.applicability === "does_not_apply"
          ? "not_applicable"
          : d.applicability === "needs_fact"
            ? "needs_fact"
            : "applies",
      basis: d.basis,
      source: d.source,
      question: d.question,
      sources: sourceUrls(o),
      prefill: worksheet.prefilled.flatMap((f) => (f.value == null ? [] : [{ label: f.label, value: f.value }])),
      manual: worksheet.awaiting,
      prefill_source: worksheet.prefilled[0]?.source ?? null,
    };
  });

  const name = asset.kind === "plant" ? asset.plant.plant_name : asset.kind === "substation" ? asset.substation.name ?? "" : asset.line.name ?? "";
  const owner =
    asset.kind === "plant" ? asset.plant.utility_name : asset.kind === "substation" ? asset.substation.operator : asset.line.operator;
  const id = asset.kind === "plant" ? asset.plant.plant_code : asset.kind === "substation" ? asset.substation.osm_id : asset.line.osm_id;

  return { kind: asset.kind, id: String(id), name, owner: owner ?? null, filings };
}

/** Run every asset of one kind through the engine and write one file for the kind. */
export async function syncAssetCompliance(options: AssetsOptions = {}): Promise<AssetsSummary> {
  const outDir = options.outDir ?? DEFAULT_ASSETS_DIR;
  const index = readJson<ProgramIndex>(options.programIndexPath ?? DEFAULT_INDEX);
  const catalog = readJson<FormCatalog>(options.formsPath ?? DEFAULT_FORMS);
  const unavailable: string[] = [];
  const files: AssetsSummary["files"] = [];

  const sources: Record<AssetKind, { path: string; assets: OwnedAsset[] }> = {
    plant: {
      path: options.plantsPath ?? PLANTS,
      assets: (await readFeatures(options.plantsPath ?? PLANTS))
        .filter((f) => f.geometry?.type === "Point")
        .map((f) => ({ kind: "plant" as const, plant: toPlant(f as never) })),
    },
    substation: {
      path: options.substationsPath ?? SUBSTATIONS,
      assets: (await readFeatures(options.substationsPath ?? SUBSTATIONS))
        .filter((f) => f.geometry?.type === "Point")
        .map((f) => ({ kind: "substation" as const, substation: toSubstation(f as never) })),
    },
    line: { path: "", assets: [] },
  };

  for (const kind of KINDS) {
    const assets = options.limit ? sources[kind].assets.slice(0, options.limit) : sources[kind].assets;
    let written = 0;
    let filings = 0;
    let prefilled = 0;
    let bytes = 0;

    for (const asset of assets) {
      const record = recordFor(asset, index, catalog);
      if (record.filings.length === 0) continue;
      const id = asset.kind === "plant" ? asset.plant.plant_code : asset.kind === "substation" ? asset.substation.osm_id : asset.line.osm_id;
      const body = JSON.stringify(record);
      const path = `${outDir}/${assetKey(kind, id).replace(":", "-")}.json`;
      await atomicJson(path, record);
      written += 1;
      bytes += Buffer.byteLength(body);
      filings += record.filings.length;
      prefilled += record.filings.reduce((n, f) => n + (f.prefill?.length ?? 0), 0);
    }

    files.push({ kind, path: `${outDir}/${kind}-<id>.json`, assets: written, filings, prefilled, bytes });
  }

  const manifest: AssetComplianceIndex = {
    schema: ASSETS_SCHEMA,
    generated_at: new Date().toISOString(),
    program_index: index?.generated_at ?? null,
    forms: catalog?.generated_at ?? null,
    counts: files.map(({ kind, assets, filings, prefilled }) => ({ kind, assets, filings, prefilled })),
  };
  await atomicJson(`${outDir}/index.json`, manifest);

  if (!index) unavailable.push("applicability index (run compliance:applicability)");
  if (!catalog) unavailable.push("forms catalog (run compliance:forms)");

  return { out_dir: outDir, files, unavailable };
}

