import type { ScanResult } from "@/lib/scan";
import { WORKFLOW_OPTION_IDS, type WorkflowOptionId } from "./validation";

export const FEATURE_NAMES = [
  "intercept",
  "plant_count_norm",
  "line_miles_norm",
  "high_voltage_line_miles_norm",
  "substation_count_norm",
  "renewable_mw_norm",
  "storage_mw_norm",
  "operator_asset_match_missing",
  "network_study_missing",
  "site_cost_missing",
] as const;

export interface StoredWorkflowContext {
  plant_count: number;
  line_miles: number;
  high_voltage_line_miles: number;
  substation_count: number;
  renewable_mw: number;
  storage_mw: number;
  operator_asset_match: null;
  network_study: null;
  site_cost: null;
  missing: {
    operator_asset_match: true;
    network_study: true;
    site_cost: true;
  };
}

export function contextFromScan(result: ScanResult): StoredWorkflowContext {
  const t = result.totals;
  return {
    plant_count: t.plant_count,
    line_miles: t.line_miles,
    high_voltage_line_miles: t.line_miles_by_kv["200-499"] + t.line_miles_by_kv["500+"],
    substation_count: t.substation_count,
    renewable_mw: t.renewable_mw,
    storage_mw: t.storage_mw,
    // Inputs absent from public scan data stay explicitly unknown.
    operator_asset_match: null,
    network_study: null,
    site_cost: null,
    missing: { operator_asset_match: true, network_study: true, site_cost: true },
  };
}

export function featureVector(context: StoredWorkflowContext): number[] {
  const unit = (n: number, max: number) => Math.max(0, Math.min(1, Math.log1p(Math.max(0, n)) / Math.log1p(max)));
  return [
    1,
    unit(context.plant_count, 100),
    unit(context.line_miles, 500),
    unit(context.high_voltage_line_miles, 500),
    unit(context.substation_count, 50),
    unit(context.renewable_mw, 2500),
    unit(context.storage_mw, 500),
    context.missing.operator_asset_match ? 1 : 0,
    context.missing.network_study ? 1 : 0,
    context.missing.site_cost ? 1 : 0,
  ];
}

export interface WorkflowObservation {
  optionId: string;
  features: number[];
  reward: number;
}

export interface RankedOption {
  id: WorkflowOptionId;
  score: number;
}

export const RANKER_VERSION = "linucb-v1";
export const SCREENING_VERSION = "scan-gates-v1";
export function activeTrainingEpochs(currentEpoch: number, trainingEpochs: number[]): number[] {
  return [...new Set([currentEpoch, ...trainingEpochs].filter((epoch) => Number.isSafeInteger(epoch) && epoch > 0))].sort((a, b) => a - b);
}
export interface ScreeningGate {
  optionId: WorkflowOptionId;
  passed: boolean;
  evidence: string;
  caveat: "mapped_screening_only";
}

/** Server-derived inventory gates; these are not feasibility, approval, or owner-rule passes. */
export function screenWorkflowOptions(context: StoredWorkflowContext): ScreeningGate[] {
  const hasAnyGrid = context.plant_count > 0 || context.line_miles > 0 || context.substation_count > 0;
  return [
    { optionId: "intervention:microgrid-storage", passed: context.plant_count > 0 && (context.renewable_mw > 0 || context.storage_mw > 0), evidence: "Requires mapped generation and mapped renewable or storage capacity.", caveat: "mapped_screening_only" },
    { optionId: "intervention:dynamic-line-rating", passed: context.high_voltage_line_miles > 0, evidence: "Requires mapped line mileage in the 200 kV and higher bands.", caveat: "mapped_screening_only" },
    { optionId: "intervention:substation-capacity", passed: context.substation_count > 0, evidence: "Requires at least one mapped substation; mapped presence does not establish capacity.", caveat: "mapped_screening_only" },
    { optionId: "intervention:feeder-hardening", passed: context.line_miles > 0 && context.substation_count > 0, evidence: "Requires mapped line mileage and at least one mapped substation.", caveat: "mapped_screening_only" },
    { optionId: "intervention:renewables-storage", passed: context.renewable_mw > 0 && hasAnyGrid, evidence: "Requires mapped renewable capacity and mapped grid infrastructure.", caveat: "mapped_screening_only" },
  ];
}

function invert(matrix: number[][]): number[][] {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => Number(i === j))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error("LinUCB matrix is singular");
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const scale = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= scale;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = 0; j < 2 * n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, v, i) => sum + v * b[i], 0);
}

/** Deterministic contextual LinUCB. Fresh arms tie in canonical ID order. */
export function rankWorkflowOptions(
  context: StoredWorkflowContext,
  observations: WorkflowObservation[],
  alpha = 0.35,
): RankedOption[] {
  const x = featureVector(context);
  const ranked = WORKFLOW_OPTION_IDS.map((id) => {
    const a = Array.from({ length: x.length }, (_, i) => Array.from({ length: x.length }, (_, j) => Number(i === j)));
    const b = Array.from({ length: x.length }, () => 0);
    for (const observation of observations) {
      if (observation.optionId !== id || observation.features.length !== x.length || !Number.isFinite(observation.reward)) continue;
      for (let i = 0; i < x.length; i++) {
        b[i] += observation.reward * observation.features[i];
        for (let j = 0; j < x.length; j++) a[i][j] += observation.features[i] * observation.features[j];
      }
    }
    const inverse = invert(a);
    const theta = inverse.map((row) => dot(row, b));
    const variance = Math.max(0, dot(x, inverse.map((row) => dot(row, x))));
    return { id, score: dot(theta, x) + alpha * Math.sqrt(variance) };
  });
  return ranked.sort((left, right) => right.score - left.score || WORKFLOW_OPTION_IDS.indexOf(left.id) - WORKFLOW_OPTION_IDS.indexOf(right.id));
}
