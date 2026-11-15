import { criticalityFor, type CriticalityResult } from "./criticality";
import type { FacilityProperties } from "./types";

export type RiskBucket = "LOW" | "WATCH" | "HIGH" | "CRITICAL";
export type RiskConfidence = "high" | "medium" | "low";

export const RISK_COLORS: Record<RiskBucket, string> = {
  LOW: "#2DD4A7",
  WATCH: "#E8A33D",
  HIGH: "#F97316",
  CRITICAL: "#F04D5E",
};

/**
 * Screening constants — platform choices, not an external standard.
 *
 * Maximo, FEMA's National Risk Index and Technosylva all publish reproducible
 * score maths, but none publishes this one, so these weights are ours and are
 * labelled "screening" everywhere they surface. The inputs they consume are
 * evidence-bundle claims (see `inputs` on each factor), so a reader can audit
 * the data even though the weighting is a product decision.
 */
export const RISK_WEIGHTS = { fossil: 40, carbon: 25, motor: 20, age: 15 } as const;
export const HEATWAVE_POINTS = 8;
export const OVERLOAD_POINTS = 10;
/** Carbon at or below this is scored zero. */
export const CARBON_FLOOR_GCO2_KWH = 200;
/** Drive-efficiency benchmark; the penalty is zero at or above it. */
export const MOTOR_BENCHMARK = 0.85;
/** Assets younger than this earn no age penalty. */
export const AGE_FLOOR_YEARS = 20;

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function riskBucket(score: number): RiskBucket {
  if (score < 35) return "LOW";
  if (score < 60) return "WATCH";
  if (score < 80) return "HIGH";
  return "CRITICAL";
}

export interface RiskFactor {
  id: "fossil" | "carbon" | "motor" | "age" | "heatwave" | "overload";
  label: string;
  points: number;
  max: number;
  detail: string;
  /**
   * Evidence predicates this factor is computed from, in display order. Empty
   * for scenario-only penalties, which have no stored claim to cite.
   */
  inputs: string[];
}

export interface RiskAssessment {
  /** Likelihood / exposure, 0–100. */
  exposure: number;
  /** Consequence / criticality, 1–5. 3 is neutral. */
  criticality: number;
  criticality_assumed: boolean;
  criticality_basis: string;
  /** Composite 0–100: `clamp(exposure × criticality / 3, 0, 100)`. */
  score: number;
  bucket: RiskBucket;
  confidence: RiskConfidence;
  factors: RiskFactor[];
  heatwave: boolean;
  overload: boolean;
  rank: number | null;
  total: number | null;
  /** Number of peers this asset scores worse than. */
  worse_than: number | null;
  /** 0–100, 100 = worst in the region. */
  percentile: number | null;
}

export interface RiskEntry extends RiskAssessment {
  color: string;
}

export interface RiskOptions {
  heatwave?: boolean;
  /** Demand exceeds nameplate at the stressed operating point. */
  overload?: boolean;
  /** A CriticalityResult, a bare 1–5 value, or a partial explicit input. */
  criticality?:
    | number
    | Pick<CriticalityResult, "value" | "assumed" | "basis">;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The single factor builder behind every risk number in the app.
 *
 * `energyRisk()` sums these factors and stops there; `assessRisk()` adds the
 * overload penalty and the consequence multiplier. Because both read the same
 * builder, the legacy exposure score and the v2 index can never drift apart.
 *
 * Heatwave mode recomputes carbon against the stressed intensity and appends a
 * flat stress penalty. Nothing here mutates the stored properties.
 */
export function buildRiskFactors(
  properties: FacilityProperties,
  options: { heatwave?: boolean } = {},
): RiskFactor[] {
  const heatwave = options.heatwave ?? false;
  const mix = properties.energy_profile.source_mix;
  const fossilShare = (100 - mix.solar - mix.hydro - mix.wind) / 100;
  const ci =
    properties.energy_profile.carbon_intensity_gco2_kwh * (heatwave ? 1.25 : 1);
  const motorEff = properties.infrastructure.motor_efficiency_rating;
  const age = properties.infrastructure.age_years;

  const factors: RiskFactor[] = [
    {
      id: "fossil",
      label: "Fossil exposure",
      points: RISK_WEIGHTS.fossil * fossilShare,
      max: RISK_WEIGHTS.fossil,
      detail: `${Math.round(fossilShare * 100)}% of the supply mix is fossil or other.`,
      inputs: ["facility.source_mix.natural_gas", "facility.source_mix.other"],
    },
    {
      id: "carbon",
      label: "Carbon intensity",
      points:
        RISK_WEIGHTS.carbon *
        clamp((ci - CARBON_FLOOR_GCO2_KWH) / CARBON_FLOOR_GCO2_KWH, 0, 1),
      max: RISK_WEIGHTS.carbon,
      detail: `${Math.round(ci)} gCO₂/kWh against the ${CARBON_FLOOR_GCO2_KWH} g/kWh floor.`,
      inputs: ["facility.carbon_intensity_gco2_kwh"],
    },
    {
      id: "motor",
      label: "Drive efficiency",
      points:
        RISK_WEIGHTS.motor *
        clamp((MOTOR_BENCHMARK - motorEff) / 0.35, 0, 1),
      max: RISK_WEIGHTS.motor,
      detail: `${motorEff.toFixed(2)} vs the ${MOTOR_BENCHMARK} benchmark.`,
      inputs: ["facility.motor_efficiency_rating"],
    },
    {
      id: "age",
      label: "Asset age",
      points:
        RISK_WEIGHTS.age * clamp((age - AGE_FLOOR_YEARS) / 60, 0, 1),
      max: RISK_WEIGHTS.age,
      detail: `${age} years in service against a ${AGE_FLOOR_YEARS}-year floor.`,
      inputs: ["facility.age_years"],
    },
  ];

  if (heatwave) {
    factors.push({
      id: "heatwave",
      label: "Heatwave stress",
      points: HEATWAVE_POINTS,
      max: HEATWAVE_POINTS,
      detail: "105 °F scenario penalty.",
      inputs: [],
    });
  }

  return factors;
}

/**
 * Energy Risk Score — the original 0–100 exposure score.
 * 40% fossil exposure · 25% carbon intensity · 20% motor inefficiency · 15% age,
 * plus the flat +8 heatwave penalty. Display-only: never mutates properties.
 *
 * A thin sum over `buildRiskFactors()`: this is what `/api/simulate` and the
 * evidence formulas call, and its output must not change.
 */
export function energyRisk(
  properties: FacilityProperties,
  options: { heatwave?: boolean } = {},
): number {
  const total = buildRiskFactors(properties, options).reduce(
    (sum, factor) => sum + factor.points,
    0,
  );
  return round1(total);
}

function normalizeCriticality(
  properties: FacilityProperties,
  input: RiskOptions["criticality"],
): Pick<CriticalityResult, "value" | "assumed" | "basis"> {
  if (input === undefined) return criticalityFor(properties);
  if (typeof input === "number") {
    return {
      value: clamp(input, 1, 5),
      assumed: false,
      basis: "Explicit criticality input.",
    };
  }
  return {
    value: clamp(input.value, 1, 5),
    assumed: input.assumed ?? false,
    basis: input.basis ?? "Explicit criticality input.",
  };
}

/**
 * Risk Index v2 — likelihood × consequence, with the full decomposition.
 *
 * `exposure` is the shared factor sum plus an overload penalty, scaled down
 * proportionally when it would exceed 100. `criticality` defaults to 3 and is
 * labelled assumed until a customer/CFI layer exists. `score` is deliberately
 * clamped to 0–100 and is a screening index, not a probability of failure.
 */
export function assessRisk(
  properties: FacilityProperties,
  options: RiskOptions = {},
): RiskAssessment {
  const heatwave = options.heatwave ?? false;
  const overload = options.overload ?? false;
  const criticality = normalizeCriticality(properties, options.criticality);

  const factors = buildRiskFactors(properties, { heatwave });
  if (overload) {
    factors.push({
      id: "overload",
      label: "Nameplate overload",
      points: OVERLOAD_POINTS,
      max: OVERLOAD_POINTS,
      detail: "Demand exceeds nameplate at the stressed operating point.",
      inputs: [],
    });
  }

  const rawExposure = factors.reduce((sum, factor) => sum + factor.points, 0);
  const scaled = rawExposure > 100 ? 100 / rawExposure : 1;
  if (scaled !== 1) {
    for (const factor of factors) factor.points *= scaled;
  }
  const exposure = round1(clamp(rawExposure, 0, 100));
  const score = round1(clamp((exposure * criticality.value) / 3, 0, 100));
  const bucket = riskBucket(score);

  return {
    exposure,
    criticality: round1(criticality.value),
    criticality_assumed: criticality.assumed,
    criticality_basis: criticality.basis,
    score,
    bucket,
    confidence: criticality.assumed ? "medium" : "high",
    factors,
    heatwave,
    overload,
    rank: null,
    total: null,
    worse_than: null,
    percentile: null,
  };
}

export interface RankedRisk {
  rank: number;
  total: number;
  worse_than: number;
  percentile: number;
}

/**
 * Rank a region's assessments by score (1 = worst). Deterministic: ties break
 * by id, so the same data always produces the same order.
 */
export function rankRisks(
  entries: { id: string; score: number }[],
): Record<string, RankedRisk> {
  const sorted = [...entries].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
  const total = sorted.length;
  const out: Record<string, RankedRisk> = {};
  sorted.forEach((entry, index) => {
    const rank = index + 1;
    out[entry.id] = {
      rank,
      total,
      worse_than: rank - 1,
      percentile:
        total > 1 ? Math.round((100 * (total - rank)) / (total - 1)) : 100,
    };
  });
  return out;
}

/** Screening risk points removed per $M of capex; null when capex is unusable. */
export function riskRemovedPerMillion(
  beforeScore: number,
  afterScore: number,
  capexUsd: number,
): number | null {
  if (
    !Number.isFinite(beforeScore) ||
    !Number.isFinite(afterScore) ||
    !Number.isFinite(capexUsd) ||
    capexUsd <= 0
  ) {
    return null;
  }
  return round1((beforeScore - afterScore) / (capexUsd / 1_000_000));
}
