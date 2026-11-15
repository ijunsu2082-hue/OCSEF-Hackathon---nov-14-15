/**
 * Formula registry — the only executable content a bundle can reference.
 *
 * A `derivation` names one of these formulas and binds claim ids to input names.
 * The verifier re-evaluates the formula from the *resolved input claim values*
 * and requires the stored value to match at the declared rounding. A bundle
 * therefore cannot smuggle in an expression, a script or an unstated constant.
 *
 * Domain formulas call the same pure functions the UI uses (`lib/simulation.ts`,
 * `lib/risk.ts`) wherever the math exists there, so the audit can never drift
 * away from the screen by copying a constant.
 */

import { energyRisk } from "../risk";
import type {
  Claim,
  Confidence,
  Derivation,
  SourceSnapshot,
} from "./schema";

export type FormulaValue = string | number | boolean | null;

export interface FormulaContext {
  /** Input values keyed by the `as` names in the derivation. */
  values: Record<string, FormulaValue>;
  /** Ordered input values, for variadic formulas. */
  list: FormulaValue[];
  params: Record<string, string | number | boolean | null>;
  /** Present for artifact formulas such as `artifact.count`. */
  snapshot: SourceSnapshot | null;
}

export interface FormulaDefinition {
  id: string;
  expression: string;
  inputs: string[] | "any";
  min_inputs?: number;
  required_params?: string[];
  rounding: number;
  evaluate: (ctx: FormulaContext) => FormulaValue;
}

function num(value: FormulaValue, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`formula input "${name}" must be a finite number`);
  }
  return value;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mixValue(values: Record<string, FormulaValue>, key: string): number {
  return num(values[key], key);
}

/** Rebuild the smallest `FacilityProperties` the risk function needs. */
function riskFromInputs(values: Record<string, FormulaValue>): number {
  const properties = {
    id: "evidence",
    name: "evidence",
    type: "Continuous Process",
    provider: { utility_name: "", contact_email: "" },
    infrastructure: {
      year_built: num(values.year_built, "year_built"),
      age_years: num(values.age_years, "age_years"),
      motor_efficiency_rating: num(
        values.motor_efficiency_rating,
        "motor_efficiency_rating",
      ),
      nameplate_draw_mw: num(values.nameplate_draw_mw, "nameplate_draw_mw"),
      utilization_pct: num(values.utilization_pct, "utilization_pct"),
    },
    energy_profile: {
      baseline_draw_mw: num(values.baseline_draw_mw, "baseline_draw_mw"),
      peak_draw_mw: num(values.peak_draw_mw, "peak_draw_mw"),
      grid_zone: "evidence",
      carbon_intensity_gco2_kwh: num(
        values.carbon_intensity_gco2_kwh,
        "carbon_intensity_gco2_kwh",
      ),
      source_mix: {
        natural_gas: mixValue(values, "mix_natural_gas"),
        solar: mixValue(values, "mix_solar"),
        hydro: mixValue(values, "mix_hydro"),
        wind: mixValue(values, "mix_wind"),
        other: mixValue(values, "mix_other"),
      },
    },
    upgrade_potential: {
      recommended_intervention: "",
      solar_capacity_add_mw: 0,
      efficiency_gain_pct: 0,
      capex_estimate_usd: 0,
      annual_savings_usd: 0,
      solar_capex_per_mw_usd: 0,
      solar_savings_per_mw_usd: 0,
      vfd_capex_usd: 0,
      vfd_savings_usd: 0,
    },
  };
  return energyRisk(properties as never, {
    heatwave: values.heatwave === true,
  });
}

const FORMULA_LIST: FormulaDefinition[] = [
  {
    id: "artifact.count",
    expression: "snapshot.record_count",
    inputs: [],
    rounding: 0,
    evaluate: ({ snapshot }) => {
      if (!snapshot || snapshot.record_count === null) {
        throw new Error("artifact.count requires a snapshot with record_count");
      }
      return snapshot.record_count;
    },
  },
  {
    id: "energy.baseline_draw_mw",
    expression: "nameplate_mw × utilization_pct ÷ 100",
    inputs: ["nameplate_mw", "utilization_pct"],
    rounding: 4,
    evaluate: ({ values }) =>
      (num(values.nameplate_mw, "nameplate_mw") *
        num(values.utilization_pct, "utilization_pct")) /
      100,
  },
  {
    id: "energy.age_years",
    expression: "as_of_year − year_built",
    inputs: ["year_built"],
    required_params: ["as_of_year"],
    rounding: 0,
    evaluate: ({ values, params }) =>
      num(params.as_of_year, "as_of_year") - num(values.year_built, "year_built"),
  },
  {
    id: "energy.annual_mwh",
    expression: "draw_mw × 24 × 365",
    inputs: ["draw_mw"],
    rounding: 0,
    evaluate: ({ values }) => num(values.draw_mw, "draw_mw") * 24 * 365,
  },
  {
    id: "energy.annual_co2_tons",
    expression: "annual_mwh × 1000 × gCO2/kWh ÷ 1,000,000",
    inputs: ["annual_mwh", "carbon_intensity_gco2_kwh"],
    rounding: 1,
    evaluate: ({ values }) =>
      (num(values.annual_mwh, "annual_mwh") *
        1000 *
        num(values.carbon_intensity_gco2_kwh, "carbon_intensity_gco2_kwh")) /
      1_000_000,
  },
  {
    id: "energy.homes_equivalent",
    expression: "annual_mwh ÷ 10.5",
    inputs: ["annual_mwh"],
    rounding: 0,
    evaluate: ({ values }) => Math.round(num(values.annual_mwh, "annual_mwh") / 10.5),
  },
  {
    id: "energy.heatwave_draw_mw",
    expression: "min(utilization_pct × 1.35, 105) ÷ 100 × nameplate_mw × 1.45",
    inputs: ["nameplate_mw", "utilization_pct"],
    rounding: 3,
    evaluate: ({ values }) =>
      (Math.min(
        num(values.utilization_pct, "utilization_pct") * 1.35,
        105,
      ) /
        100) *
      num(values.nameplate_mw, "nameplate_mw") *
      1.45,
  },
  {
    id: "energy.heatwave_ci",
    expression: "carbon_intensity_gco2_kwh × 1.25",
    inputs: ["carbon_intensity_gco2_kwh"],
    rounding: 1,
    evaluate: ({ values }) =>
      num(values.carbon_intensity_gco2_kwh, "carbon_intensity_gco2_kwh") * 1.25,
  },
  {
    id: "energy.risk_score",
    expression:
      "40×fossil + 25×CI + 20×inefficiency + 15×age (lib/risk.ts)",
    inputs: [
      "year_built",
      "age_years",
      "motor_efficiency_rating",
      "nameplate_draw_mw",
      "utilization_pct",
      "baseline_draw_mw",
      "peak_draw_mw",
      "carbon_intensity_gco2_kwh",
      "mix_natural_gas",
      "mix_solar",
      "mix_hydro",
      "mix_wind",
      "mix_other",
    ],
    rounding: 1,
    evaluate: ({ values }) => round(riskFromInputs(values), 1),
  },
  {
    id: "upgrade.capex_usd",
    expression: "solar_mw × solar_capex_per_mw_usd + (vfd ? vfd_capex_usd : 0)",
    inputs: [
      "solar_mw",
      "solar_capex_per_mw_usd",
      "vfd_capex_usd",
    ],
    required_params: ["vfd"],
    rounding: 0,
    evaluate: ({ values, params }) =>
      num(values.solar_mw, "solar_mw") *
        num(values.solar_capex_per_mw_usd, "solar_capex_per_mw_usd") +
      (params.vfd === true ? num(values.vfd_capex_usd, "vfd_capex_usd") : 0),
  },
  {
    id: "upgrade.savings_usd",
    expression:
      "solar_mw × solar_savings_per_mw_usd + (vfd ? vfd_savings_usd : 0)",
    inputs: [
      "solar_mw",
      "solar_savings_per_mw_usd",
      "vfd_savings_usd",
    ],
    required_params: ["vfd"],
    rounding: 0,
    evaluate: ({ values, params }) =>
      num(values.solar_mw, "solar_mw") *
        num(values.solar_savings_per_mw_usd, "solar_savings_per_mw_usd") +
      (params.vfd === true ? num(values.vfd_savings_usd, "vfd_savings_usd") : 0),
  },
  {
    id: "upgrade.payback_years",
    expression: "capex ÷ savings (null when savings ≤ 0)",
    inputs: ["capex_usd", "annual_savings_usd"],
    rounding: 2,
    evaluate: ({ values }) => {
      const savings = num(values.annual_savings_usd, "annual_savings_usd");
      if (savings <= 0) return null;
      return num(values.capex_usd, "capex_usd") / savings;
    },
  },
  {
    id: "region.sum",
    expression: "Σ inputs",
    inputs: "any",
    min_inputs: 0,
    required_params: ["decimals"],
    rounding: 0,
    evaluate: ({ list, params }) => {
      const decimals = num(params.decimals, "decimals");
      return round(
        list.reduce<number>((sum, value) => sum + num(value, "input"), 0),
        decimals,
      );
    },
  },
  {
    id: "region.weighted_mean",
    expression: "Σ(valueᵢ × weightᵢ) ÷ Σ(weightᵢ)",
    inputs: "any",
    min_inputs: 2,
    required_params: ["decimals"],
    rounding: 0,
    evaluate: ({ list, params }) => {
      if (list.length % 2 !== 0) {
        throw new Error("region.weighted_mean expects value/weight pairs");
      }
      let numerator = 0;
      let denominator = 0;
      for (let i = 0; i < list.length; i += 2) {
        const value = num(list[i], "value");
        const weight = num(list[i + 1], "weight");
        numerator += value * weight;
        denominator += weight;
      }
      if (denominator === 0) return 0;
      return round(numerator / denominator, num(params.decimals, "decimals"));
    },
  },
];

export const FORMULAS: Record<string, FormulaDefinition> = Object.fromEntries(
  FORMULA_LIST.map((formula) => [formula.id, formula]),
);

export function getFormula(id: string): FormulaDefinition | null {
  return FORMULAS[id] ?? null;
}

export function formulaIds(): string[] {
  return Object.keys(FORMULAS).sort();
}

/** Round to a declared number of decimals; mirrors what the verifier compares. */
export function roundAt(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function valuesEqualAt(a: number, b: number, digits: number): boolean {
  return roundAt(a, digits) === roundAt(b, digits);
}

/**
 * Evaluate a derivation against already-resolved input claims. Pure; identical
 * inputs always produce identical output on every JS runtime.
 */
export function evaluateDerivation(
  derivation: Derivation,
  inputs: Claim[],
  snapshot: SourceSnapshot | null,
): FormulaValue {
  const formula = getFormula(derivation.formula_id);
  if (!formula) throw new Error(`unknown formula: ${derivation.formula_id}`);

  const values: Record<string, FormulaValue> = {};
  const list: FormulaValue[] = [];
  for (const input of derivation.inputs) {
    const claim = inputs.find((candidate) => candidate.id === input.claim_id);
    if (!claim) throw new Error(`missing input claim: ${input.claim_id}`);
    values[input.as] = claim.value;
  }
  for (const input of derivation.inputs) list.push(values[input.as]);

  return formula.evaluate({
    values,
    list,
    params: derivation.params,
    snapshot,
  });
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function weakerConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/**
 * The maximum confidence a claim is permitted to carry. A claim may declare a
 * lower confidence (a downgrade is always allowed) but never a higher one.
 */
export function maxConfidence(
  claim: Omit<Claim, "confidence">,
  sourceAuthority: "primary" | "secondary" | "modeled" | "derived" | null,
  inputClaims: Claim[],
): Confidence {
  switch (claim.method) {
    case "inferred":
      return "low";
    case "modeled":
      return "medium";
    case "observed":
      return sourceAuthority === "primary"
        ? "high"
        : sourceAuthority === "secondary"
          ? "medium"
          : "low";
    case "derived": {
      if (inputClaims.length === 0) {
        return sourceAuthority === "primary" ? "high" : "medium";
      }
      return inputClaims.reduce<Confidence>(
        (weakest, input) => weakerConfidence(weakest, input.confidence),
        "high",
      );
    }
    default:
      return "low";
  }
}
