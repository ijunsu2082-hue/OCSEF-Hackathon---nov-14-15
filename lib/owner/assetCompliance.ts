/*
 * Per-asset compliance snapshot (written by research/etl/compliance/assets.ts).
 *
 * The ETL decides each filing for each asset and records the answer, the fact behind
 * it and the legal sources it rests on. The Compliance tab reads this record, so the
 * screen shows the ETL's personalised answer rather than recomputing a decision in the
 * browser. When the snapshot has no record for an asset (a stale build, a line), the
 * tab falls back to lib/owner/applicability.ts, so nothing breaks.
 */
import type { AssetKind, OwnedAsset } from "./types";
import type { Determination, FactAnswers } from "./applicability";
import type { AssetFieldKey } from "./forms";

export const ASSETS_SCHEMA = "compliance-assets/1";

export type AssetFilingStatus = "applies" | "not_applicable" | "needs_fact";

export interface SnapshotPrefill {
  label: string;
  value: string;
}

export interface AssetFiling {
  /** Rule id, matching lib/owner/rules.ts and the forms catalog. */
  id: string;
  status: AssetFilingStatus;
  /** Why, in the owner's words. */
  basis: string;
  /** The record the decision rests on, or null when it rests on the owner's answer. */
  source: string | null;
  question?: { id: string; question: string; detail: string };
  /** Instrument URLs for this rule, so a row can cite them without another file. */
  sources: string[];
  /** Values filled from public data, ready to paste into the form. */
  prefill?: SnapshotPrefill[];
  /** Field labels only a person can fill or sign. */
  manual?: string[];
  /** Which public property each prefilled value came from, e.g. "EIA-860 2025". */
  prefill_source?: string | null;
}

export interface AssetComplianceRecord {
  kind: AssetKind;
  id: string;
  name: string;
  owner: string | null;
  filings: AssetFiling[];
}

export interface AssetComplianceIndex {
  schema: typeof ASSETS_SCHEMA;
  generated_at: string;
  program_index: string | null;
  forms: string | null;
  counts: { kind: AssetKind; assets: number; filings: number; prefilled: number }[];
}

export function assetKey(kind: AssetKind, id: string | number): string {
  return `${kind}:${id}`;
}

/**
 * File name for an asset record. Substation ids look like "way/767650531", so anything
 * that is not a letter or digit is folded to a dash: substation-way-767650531.json.
 */
export function assetFileName(kind: AssetKind, id: string | number): string {
  return `${kind}-${String(id).replace(/[^A-Za-z0-9]+/g, "-").replace(/-+$/, "")}.json`;
}

/** Stable id for an owned asset, matching the ETL's keys. */
export function keyForAsset(asset: OwnedAsset): string {
  if (asset.kind === "plant") return assetKey("plant", asset.plant.plant_code);
  if (asset.kind === "substation") return assetKey("substation", asset.substation.osm_id);
  return assetKey("line", asset.line.osm_id);
}

const cache = new Map<string, Promise<AssetComplianceRecord | null>>();

/**
 * The ETL's record for one asset (a few KB), or null when the snapshot has none. One
 * request per asset, kept for the session so switching tabs does not refetch.
 */
export function loadAssetRecord(kind: AssetKind, id: string | number): Promise<AssetComplianceRecord | null> {
  const key = assetKey(kind, id);
  let pending = cache.get(key);
  if (!pending) {
    pending = fetch(`/compliance/assets/${assetFileName(kind, id)}`)
      .then(async (res) => {
        if (!res.ok) return null;
        const data = (await res.json()) as AssetComplianceRecord;
        return data && Array.isArray(data.filings) ? data : null;
      })
      .catch(() => null);
    cache.set(key, pending);
  }
  return pending;
}

/** The manifest written alongside the records: how many assets and when. */
export function loadAssetIndex(): Promise<AssetComplianceIndex | null> {
  return fetch("/compliance/assets/index.json")
    .then(async (res) => (res.ok ? ((await res.json()) as AssetComplianceIndex) : null))
    .catch(() => null);
}

/** Apply the owner's saved answer to a snapshot filing, the same way live decisions do. */
export function determinationFromFiling(filing: AssetFiling, answers: FactAnswers = {}): Determination {
  const question = filing.question;
  const answer = question ? answers[question.id] : undefined;
  const base: Determination = {
    obligationId: filing.id,
    applicability: filing.status === "not_applicable" ? "does_not_apply" : filing.status,
    basis: filing.basis,
    source: filing.source,
    question,
  };
  if (!question || !answer) return base;
  return {
    obligationId: filing.id,
    applicability: answer.answer === "yes" ? "applies" : "does_not_apply",
    basis: `You answered "${answer.answer === "yes" ? "yes" : "no"}" to: ${question.question}`,
    source: "Your answer, saved on this device",
  };
}

/** Field keys the ETL fills, kept here so the snapshot and the resolver agree. */
export const SNAPSHOT_FIELD_KEYS: AssetFieldKey[] = [
  "plant_code",
  "plant_name",
  "operator",
  "county",
  "city",
  "capacity_mw",
  "primary_source",
  "voltage_kv",
  "generators",
  "line_length_mi",
  "osm_id",
  "latitude",
  "longitude",
];
