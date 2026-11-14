"use client";

import type { ReactNode } from "react";
import { formatClaimValue, methodLabel, METHOD_COLOR } from "@/lib/evidence/citation";
import type { Claim } from "@/lib/evidence/schema";
import { useEvidence } from "./EvidenceProvider";

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
}: {
  claim?: Claim | null;
  subject?: string;
  predicate?: string;
  label?: string;
  quiet?: boolean;
}) {
  const evidence = useEvidence();
  const resolved =
    claim ?? (subject && predicate ? evidence.claim(subject, predicate) : null);
  if (!evidence.bundle) return null;
  if (!resolved) {
    return (
      <span
        className="cite cite-missing"
        title={`No verified claim for ${subject ?? "?"}/${predicate ?? "?"}`}
      >
        ?
      </span>
    );
  }
  const code = resolved.source_id
    ? evidence.codes.get(resolved.source_id) ?? resolved.source_id
    : "∂";
  return (
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
}) {
  const evidence = useEvidence();
  const resolved =
    claim ?? (subject && predicate ? evidence.claim(subject, predicate) : null);

  if (!resolved) {
    return (
      <span className={className}>
        {fallback ?? "—"}
        {showCite && evidence.bundle ? (
          <Cite subject={subject} predicate={predicate} />
        ) : null}
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
      {showCite ? <Cite claim={resolved} /> : null}
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
