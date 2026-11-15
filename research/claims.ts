/**
 * Claim builders used by the region build.
 *
 * Every builder enforces the registry: unit comes from the predicate, method is
 * checked against the allowed set, and confidence is capped by the evidence
 * method. A caller cannot hand-set a confidence above what the provenance
 * supports.
 */

import { computeClaimId } from "../lib/evidence/canonical";
import {
  evaluateDerivation,
  getFormula,
  maxConfidence,
  roundAt,
} from "../lib/evidence/formulas";
import { getPredicate } from "../lib/evidence/predicates";
import type {
  Authority,
  Claim,
  DerivationInput,
  SourceSnapshot,
} from "../lib/evidence/schema";

function predicateFor(id: string) {
  const predicate = getPredicate(id);
  if (!predicate) throw new Error(`unregistered predicate: ${id}`);
  return predicate;
}

export interface ObservedArgs {
  subject: string;
  predicate: string;
  value: string | number | boolean;
  sourceId: string;
  snapshot: SourceSnapshot;
  locator: string;
  authority: Authority;
  caveats?: string[];
}

export function observedClaim(args: ObservedArgs): Claim {
  const predicate = predicateFor(args.predicate);
  if (!predicate.allowed_methods.includes("observed")) {
    throw new Error(`${args.predicate} does not allow observed claims`);
  }
  const withoutMeta = {
    subject: args.subject,
    predicate: args.predicate,
    value: args.value,
    unit: predicate.unit,
    method: "observed" as const,
    confidence: "high" as const,
    source_id: args.sourceId,
    snapshot_id: args.snapshot.id,
    locator: args.locator,
    retrieved_at: args.snapshot.retrieved_at,
    derivation: null,
    basis: null,
    caveats: args.caveats ?? [],
    escalation: null,
  };
  // maxConfidence reads method and inputs only; computeClaimId supplies the id.
  const confidence = maxConfidence({ ...withoutMeta, id: "" }, args.authority, []);
  return { id: computeClaimId(withoutMeta), ...withoutMeta, confidence };
}

export interface ModeledArgs {
  subject: string;
  predicate: string;
  value: string | number | boolean;
  basis: string;
  sourceId?: string | null;
  snapshot?: SourceSnapshot | null;
  locator?: string | null;
  caveats?: string[];
}

export function modeledClaim(args: ModeledArgs): Claim {
  const predicate = predicateFor(args.predicate);
  if (!predicate.allowed_methods.includes("modeled")) {
    throw new Error(`${args.predicate} does not allow modeled claims`);
  }
  if (args.basis.trim().length < 8) {
    throw new Error(`${args.predicate}: a modeled claim needs a real basis`);
  }
  const withoutMeta = {
    subject: args.subject,
    predicate: args.predicate,
    value: args.value,
    unit: predicate.unit,
    method: "modeled" as const,
    confidence: "medium" as const,
    source_id: args.sourceId ?? null,
    snapshot_id: args.snapshot?.id ?? null,
    locator: args.locator ?? null,
    retrieved_at: args.snapshot?.retrieved_at ?? null,
    derivation: null,
    basis: args.basis,
    caveats: args.caveats ?? [],
    escalation: null,
  };
  const confidence = maxConfidence({ ...withoutMeta, id: "" }, "modeled", []);
  return { id: computeClaimId(withoutMeta), ...withoutMeta, confidence };
}

export interface DerivedArgs {
  subject: string;
  predicate: string;
  formulaId: string;
  inputs: (Claim | null | undefined)[];
  params?: Record<string, string | number | boolean | null>;
  /** For artifact formulas only. */
  snapshot?: SourceSnapshot | null;
  caveats?: string[];
}

export function derivedClaim(args: DerivedArgs): Claim {
  const predicate = predicateFor(args.predicate);
  if (!predicate.allowed_methods.includes("derived")) {
    throw new Error(`${args.predicate} does not allow derived claims`);
  }
  const formula = getFormula(args.formulaId);
  if (!formula) throw new Error(`unknown formula: ${args.formulaId}`);
  const inputClaims = args.inputs.filter((claim): claim is Claim => Boolean(claim));

  const inputNames = formula.inputs === "any" ? null : formula.inputs;
  const derivationInputs: DerivationInput[] = inputClaims.map((claim, index) => ({
    claim_id: claim.id,
    as: inputNames ? inputNames[index] : `v${index}`,
  }));

  // For a fixed-arity formula the caller supplies inputs in registry order.
  // Guard that the names really line up, rather than silently binding the
  // wrong value to the wrong slot.
  if (inputNames && inputNames.length !== inputClaims.length) {
    throw new Error(
      `${args.predicate}: ${formula.id} expects ${inputNames.length} inputs, got ${inputClaims.length}`,
    );
  }

  const derivation = {
    formula_id: formula.id,
    expression: formula.expression,
    inputs: derivationInputs,
    params: args.params ?? {},
    rounding: formula.rounding,
  };

  const raw = evaluateDerivation(
    derivation,
    inputClaims,
    args.snapshot ?? null,
  );
  const value = typeof raw === "number" ? roundAt(raw, derivation.rounding) : raw;

  const artifact = formula.id === "artifact.count";
  const withoutMeta = {
    subject: args.subject,
    predicate: args.predicate,
    value,
    unit: predicate.unit,
    method: "derived" as const,
    confidence: "high" as const,
    source_id: artifact && args.snapshot ? args.snapshot.source_id : null,
    snapshot_id: artifact && args.snapshot ? args.snapshot.id : null,
    locator: artifact && args.snapshot ? "artifact.record_count" : null,
    retrieved_at: null,
    derivation,
    basis: null,
    caveats: args.caveats ?? [],
    escalation: null,
  };
  const confidence = maxConfidence(
    { ...withoutMeta, id: "" },
    artifact ? "derived" : null,
    inputClaims,
  );
  return { id: computeClaimId(withoutMeta), ...withoutMeta, confidence };
}

/** Deduplicate by content id, preserving first-seen order. */
export function dedupeClaims(claims: Claim[]): Claim[] {
  const seen = new Set<string>();
  const out: Claim[] = [];
  for (const claim of claims) {
    if (seen.has(claim.id)) continue;
    seen.add(claim.id);
    out.push(claim);
  }
  return out;
}

export function findClaim(
  claims: Claim[],
  subject: string,
  predicate: string,
): Claim {
  const claim = claims.find(
    (candidate) => candidate.subject === subject && candidate.predicate === predicate,
  );
  if (!claim) throw new Error(`missing claim ${subject}/${predicate}`);
  return claim;
}

/**
 * Order inputs exactly as the formula registry declares them. Prefer this over
 * hand-ordering arrays: a swapped nameplate/utilization pair is a silent 100×
 * error that still typechecks.
 */
export function orderedInputs(
  formulaId: string,
  map: Record<string, Claim>,
): Claim[] {
  const formula = getFormula(formulaId);
  if (!formula) throw new Error(`unknown formula: ${formulaId}`);
  if (formula.inputs === "any") {
    throw new Error(`${formulaId} is variadic; pass inputs explicitly`);
  }
  return formula.inputs.map((name) => {
    const claim = map[name];
    if (!claim) throw new Error(`${formulaId} is missing input "${name}"`);
    return claim;
  });
}
