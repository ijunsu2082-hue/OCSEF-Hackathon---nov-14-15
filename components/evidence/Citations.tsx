"use client";

import type { ReactNode } from "react";
import { formatClaimValue, methodLabel, METHOD_COLOR } from "@/lib/evidence/citation";
import type { Claim } from "@/lib/evidence/schema";
import { useEvidence } from "./EvidenceProvider";
import { ReconciliationBadge, type ReconciliationMark } from "./ReconciliationBadge";

/** Badges for optional reconciliation marks; null when none were passed. */
function reconciliationBadges(reconciliation?: ReconciliationMark | ReconciliationMark[]): ReactNode {
  if (!reconciliation) return null;
  const marks = Array.isArray(reconciliation) ? reconciliation : [reconciliation];
  if (!marks.length) return null;
  return marks.map((mark, index) => <ReconciliationBadge key={`${mark.policy ?? ""}:${index}`} {...mark} />);
}

/**
 * Inline citation chip. Resolves `(subject, predicate)` against the verified
 * bundle; if the claim is absent it renders a visible missing marker instead of
 * silently dropping the citation.
 */
export function Cite({
  claim,
  subject,
  predicate,
  label,
  quiet,
  reconciliation,
}: {
  claim?: Claim | null;
  subject?: string;
  predicate?: string;
  label?: string;
  quiet?: boolean;
  /** Optional provider reconciliation outcome(s) shown after the chip. */
  reconciliation?: ReconciliationMark | ReconciliationMark[];
}) {
  const evidence = useEvidence();
  const resolved =
    claim ?? (subject && predicate ? evidence.claim(subject, predicate) : null);
  const badges = reconciliationBadges(reconciliation);
  if (!evidence.bundle) return badges ? <>{badges}</> : null;
  if (!resolved) {
    const missing = (
      <span
        className="cite cite-missing"
        title={`No verified claim for ${subject ?? "?"}/${predicate ?? "?"}`}
      >
        ?
      </span>
    );
    return badges ? <>{missing}{badges}</> : missing;
  }
  const code = resolved.source_id
    ? evidence.codes.get(resolved.source_id) ?? resolved.source_id
    : "∂";
  const chip = (
    <button
      type="button"
      className={`cite ${quiet ? "is-quiet" : ""}`}
      data-method={resolved.method}
      onClick={(event) => {
        event.stopPropagation();
        evidence.open(resolved);
      }}
      title={`${methodLabel(resolved.method)} · ${code} · click for provenance`}
    >
      {label ?? code}
    </button>
  );
  return badges ? <>{chip}{badges}</> : chip;
}

/**
 * Renders a claim's value and its citation. The value comes from the claim, not
 * from a literal at the call site, so display and evidence cannot drift.
 */
export function ClaimValue({
  claim,
  subject,
  predicate,
  fallback,
  digits,
  suffix,
  format,
  className,
  showCite = true,
  reconciliation,
}: {
  claim?: Claim | null;
  subject?: string;
  predicate?: string;
  fallback?: ReactNode;
  digits?: number;
  suffix?: string;
  format?: (value: number) => string;
  className?: string;
  showCite?: boolean;
  /** Optional provider reconciliation outcome(s) shown after the citation. */
  reconciliation?: ReconciliationMark | ReconciliationMark[];
}) {
  const evidence = useEvidence();
  const resolved =
    claim ?? (subject && predicate ? evidence.claim(subject, predicate) : null);

  if (!resolved) {
    return (
      <span className={className}>
        {fallback ?? "—"}
        {showCite && evidence.bundle ? (
          <Cite subject={subject} predicate={predicate} reconciliation={reconciliation} />
        ) : reconciliationBadges(reconciliation)}
      </span>
    );
  }

  const rendered =
    typeof resolved.value === "number" && format
      ? format(resolved.value)
      : formatClaimValue(resolved, digits);

  return (
    <span className={className}>
      {rendered}
      {suffix ?? ""}
      {showCite ? <Cite claim={resolved} reconciliation={reconciliation} /> : reconciliationBadges(reconciliation)}
    </span>
  );
}

export function MethodBadge({ method }: { method: Claim["method"] }) {
  return (
    <span
      className={`method-badge method-${method}`}
      style={{ color: METHOD_COLOR[method] }}
      title={`${methodLabel(method)} evidence`}
    >
      {methodLabel(method)}
    </span>
  );
}

export function ScenarioTag() {
  return (
    <span className="scenario-tag" title="Scenario output computed from cited inputs; not a stored claim">
      scenario
    </span>
  );
}
