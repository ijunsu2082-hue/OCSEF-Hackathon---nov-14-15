import { canonicalJson } from "../../lib/evidence/canonical";

export interface ComparisonScope {
  metric: string;
  entity: string;
  unit: string;
  start: string;
  end: string;
  statistic: string;
  basis: string;
}

export interface Observation {
  scope: ComparisonScope;
  source: string;
  publisher: string;
  release: string;
  snapshot: string;
  locator: string;
  value: number | string;
}

export interface MetricPolicy {
  scope: ComparisonScope;
  tolerance?: { absolute: number; basis: string };
  authority?: string;
}

function scopeKey(scope: ComparisonScope): string {
  const normalizeTime = (value: string) => {
    if (!/(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new Error("Comparison times require explicit offsets");
    }
    return new Date(value).toISOString();
  };
  const start = normalizeTime(scope.start);
  const end = normalizeTime(scope.end);
  if (start > end) throw new Error("Comparison interval ends before it starts");
  for (const field of [scope.metric, scope.entity, scope.unit, scope.statistic, scope.basis]) {
    if (typeof field !== "string" || !field.trim()) throw new Error("Incomplete comparison scope");
  }
  return canonicalJson({ ...scope, start, end });
}

export function reconcile(left: Observation, right: Observation, policy?: MetricPolicy) {
  const scope = scopeKey(left.scope);
  const candidates = [left, right];
  const independent = left.publisher !== right.publisher;
  if (scope !== scopeKey(right.scope)) {
    return { status: "incomparable", candidates, independent: false, selected: null };
  }
  if (policy && scopeKey(policy.scope) !== scope) throw new Error("Policy scope mismatch");
  const tolerance = policy?.tolerance;
  if (tolerance && (!Number.isFinite(tolerance.absolute) || tolerance.absolute < 0 || !tolerance.basis.trim())) {
    throw new Error("Tolerance requires a finite absolute bound and documented basis");
  }
  const difference = typeof left.value === "number" && typeof right.value === "number"
    ? Math.abs(left.value - right.value)
    : null;
  const status = left.value === right.value ? "agreement"
    : tolerance && difference !== null && difference <= tolerance.absolute ? "within_tolerance"
    : "conflict";
  const authoritative = candidates.filter(({ source }) => policy?.authority === source);
  return {
    status, candidates, independent, difference, tolerance: tolerance ?? null,
    selected: authoritative.length === 1 ? authoritative[0] : status === "agreement" ? left : null,
  };
}

export type ReconcileStatus = "agreement" | "within_tolerance" | "conflict" | "incomparable";

/**
 * Scope fields that differ between two observations, after the same offset
 * normalisation `reconcile` applies. Throws on offset-less times exactly as
 * `reconcile` does. An empty list means the scopes are identical.
 */
export function scopeDifferences(left: ComparisonScope, right: ComparisonScope): (keyof ComparisonScope)[] {
  const a = JSON.parse(scopeKey(left)) as ComparisonScope;
  const b = JSON.parse(scopeKey(right)) as ComparisonScope;
  return (["metric", "entity", "unit", "start", "end", "statistic", "basis"] as const)
    .filter((field) => a[field] !== b[field]);
}
