/**
 * Runtime derivations.
 *
 * Some numbers only exist after a user interaction (heatwave toggle, solar
 * slider). They are still claims: built from cited inputs through the same
 * formula registry as the persisted bundle, and rendered with the same citation
 * affordance. They are flagged `runtime: true` and are never written back to the
 * bundle, so the static audit remains reproducible.
 */

import { computeClaimId } from "./canonical";
import {
  evaluateDerivation,
  getFormula,
  maxConfidence,
  roundAt,
  type FormulaValue,
} from "./formulas";
import type { Claim, Derivation } from "./schema";

export interface RuntimeInput {
  claim: Claim;
  as: string;
}

export interface RuntimeClaimSpec {
  subject: string;
  predicate: string;
  formula_id: string;
  inputs: RuntimeInput[];
  params?: Record<string, string | number | boolean | null>;
  rounding?: number;
  caveats?: string[];
}

export function buildRuntimeClaim(spec: RuntimeClaimSpec): Claim {
  const formula = getFormula(spec.formula_id);
  if (!formula) throw new Error(`unknown formula: ${spec.formula_id}`);

  const derivation: Derivation = {
    formula_id: formula.id,
    expression: formula.expression,
    inputs: spec.inputs.map((input) => ({ claim_id: input.claim.id, as: input.as })),
    params: spec.params ?? {},
    rounding: spec.rounding ?? formula.rounding,
  };

  const raw = evaluateDerivation(
    derivation,
    spec.inputs.map((input) => input.claim),
    null,
  );
  const value: FormulaValue =
    typeof raw === "number" ? roundAt(raw, derivation.rounding) : raw;

  const withoutMeta = {
    subject: spec.subject,
    predicate: spec.predicate,
    value,
    unit: null,
    method: "derived" as const,
    confidence: "high" as const,
    source_id: null,
    snapshot_id: null,
    locator: null,
    retrieved_at: null,
    derivation,
    basis: null,
    caveats: spec.caveats ?? ["Computed in the browser from the cited inputs."],
    escalation: null,
  };

  // Unit is copied from the target predicate at render time; the id intentionally
  // excludes display-only unit metadata, which is registry-derived.
  // maxConfidence only inspects method and the input claims; the id is computed
  // from the resulting confidence below, so a placeholder satisfies the shape.
  const confidence = maxConfidence(
    { ...withoutMeta, id: "" },
    null,
    spec.inputs.map((i) => i.claim),
  );

  return {
    id: computeClaimId({ ...withoutMeta, confidence }),
    ...withoutMeta,
    confidence,
    runtime: true,
  };
}

/** Round a value the same way the evidence contract does. */
export function roundClaim(value: number, digits: number): number {
  return roundAt(value, digits);
}
