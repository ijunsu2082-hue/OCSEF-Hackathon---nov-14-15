/**
 * Read-side helpers for evidence bundles. Browser-safe and dependency-free.
 *
 * The UI never formats a raw literal and then attaches a citation. It resolves a
 * `(subject, predicate)` pair to a claim and renders the claim's own value. If
 * the pair is missing, the component renders an explicit unverified marker
 * instead of a plausible-looking number.
 */

import { fmtNumber } from "../format";
import { verifyBundle } from "./verify";
import {
  claimKey,
  type Claim,
  type ClaimIndex,
  type Confidence,
  type EvidenceBundle,
  type SourceDefinition,
  type SourceSnapshot,
} from "./schema";

export function facilitySubject(facilityId: string): string {
  return `facility:${facilityId}`;
}

export function regionSubject(regionId: string): string {
  return `region:${regionId}`;
}

export function indexBundle(bundle: EvidenceBundle): ClaimIndex {
  const { active } = verifyBundle(bundle);
  const byId = new Map<string, Claim>();
  const bySubject = new Map<string, Claim[]>();

  for (const claim of bundle.claims) {
    byId.set(claim.id, claim);
    const list = bySubject.get(claim.subject) ?? [];
    list.push(claim);
    bySubject.set(claim.subject, list);
  }
  for (const list of bySubject.values()) {
    list.sort((a, b) => a.predicate.localeCompare(b.predicate));
  }

  return { active, byId, bySubject, bundle };
}

export function getClaim(
  index: ClaimIndex,
  subject: string,
  predicate: string,
): Claim | null {
  return index.active.get(claimKey(subject, predicate)) ?? null;
}

export function claimsFor(index: ClaimIndex, subject: string): Claim[] {
  return index.bySubject.get(subject) ?? [];
}

/** Claims whose resolution made them lose; shown in the audit drawer only. */
export function losingClaimsFor(index: ClaimIndex, subject: string): Claim[] {
  const activeIds = new Set(claimsFor(index, subject).map((claim) => claim.id));
  return (index.bySubject.get(subject) ?? []).filter((claim) => !activeIds.has(claim.id));
}

export function getSource(
  index: ClaimIndex,
  claim: Claim | null,
): SourceDefinition | null {
  if (!claim?.source_id) return null;
  return index.bundle.sources.find((source) => source.id === claim.source_id) ?? null;
}

export function getSnapshot(
  index: ClaimIndex,
  claim: Claim | null,
): SourceSnapshot | null {
  if (!claim?.snapshot_id) return null;
  return index.bundle.snapshots.find((snapshot) => snapshot.id === claim.snapshot_id) ?? null;
}

export interface ChainNode {
  claim: Claim;
  depth: number;
}

/**
 * Every leaf claim behind a derived claim, depth-first, deterministic order.
 * Used by the UI to render "this number is a formula over these citations".
 */
export function provenanceChain(index: ClaimIndex, claim: Claim): ChainNode[] {
  const out: ChainNode[] = [];
  const seen = new Set<string>();

  const walk = (current: Claim, depth: number) => {
    if (seen.has(current.id)) return;
    seen.add(current.id);
    out.push({ claim: current, depth });
    if (!current.derivation) return;
    for (const input of current.derivation.inputs) {
      const next = index.byId.get(input.claim_id);
      if (next) walk(next, depth + 1);
    }
  };

  walk(claim, 0);
  return out;
}

export function methodLabel(method: Claim["method"]): string {
  switch (method) {
    case "observed":
      return "Observed";
    case "derived":
      return "Derived";
    case "modeled":
      return "Modeled";
    case "inferred":
      return "AI-assisted";
  }
}

export const METHOD_COLOR: Record<Claim["method"], string> = {
  observed: "#2DD4A7",
  derived: "#4C8DFF",
  modeled: "#E8A33D",
  inferred: "#B98BFF",
};

export function confidenceLabel(confidence: Confidence): string {
  return confidence === "high" ? "High" : confidence === "medium" ? "Medium" : "Low";
}

/** Stable `S1`, `S2` codes for the source list. Ordered by publisher + id. */
export function sourceCodes(bundle: EvidenceBundle): Map<string, string> {
  const ordered = [...bundle.sources].sort((a, b) =>
    `${a.publisher}\u0000${a.id}`.localeCompare(`${b.publisher}\u0000${b.id}`),
  );
  return new Map(ordered.map((source, index) => [source.id, `S${index + 1}`]));
}

export function formatClaimValue(claim: Claim, digits?: number): string {
  if (claim.value === null) return "n/a";
  if (typeof claim.value === "number") {
    return fmtNumber(claim.value, digits ?? decimalHint(claim));
  }
  if (typeof claim.value === "boolean") return claim.value ? "yes" : "no";
  return claim.value;
}

function decimalHint(claim: Claim): number {
  const value = claim.value;
  if (typeof value !== "number") return 0;
  if (claim.unit === "MW" || claim.unit === "mi") return 2;
  if (claim.unit === "%" || claim.unit === "ratio") return 1;
  if (claim.unit === "yr") return Number.isInteger(value) ? 0 : 1;
  if (claim.unit === "USD" || claim.unit === "USD/yr") return 0;
  return Math.abs(value) >= 1000 ? 0 : 1;
}

/** JSON Pointer (`/features/3/properties/...`) into the snapshot. */
export function pointerSegments(pointer: string): string[] {
  if (!pointer.startsWith("/")) return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}
