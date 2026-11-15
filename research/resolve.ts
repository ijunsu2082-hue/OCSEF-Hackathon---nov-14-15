/**
 * Deterministic conflict resolution.
 *
 * Two sources can disagree. The platform does not average them, pick the newer
 * one silently, or ask a model to choose. It records every candidate and writes
 * a resolution with the rule that decided it. The winner is then the only value
 * the UI may render; the losers remain in the bundle for audit.
 */

import type {
  Claim,
  ConflictResolution,
  SourceDefinition,
} from "../lib/evidence/schema";

const AUTHORITY_RANK: Record<string, number> = {
  primary: 0,
  secondary: 1,
  derived: 2,
  modeled: 3,
};

const CONFIDENCE_RANK: Record<Claim["confidence"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function distinctValues(claims: Claim[]): Claim[] {
  const out: Claim[] = [];
  for (const claim of claims) {
    if (!out.some((candidate) => candidate.value === claim.value)) out.push(claim);
  }
  return out;
}

function compare(a: Claim, b: Claim, sources: Map<string, SourceDefinition>): number {
  const authority = (claim: Claim) =>
    AUTHORITY_RANK[claim.source_id ? sources.get(claim.source_id)?.authority ?? "derived" : "derived"] ?? 9;
  return (
    authority(a) - authority(b) ||
    CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
    (b.retrieved_at ?? "").localeCompare(a.retrieved_at ?? "") ||
    a.id.localeCompare(b.id)
  );
}

export function resolveConflicts(
  claims: Claim[],
  sources: SourceDefinition[],
): ConflictResolution[] {
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    const key = `${claim.subject}\u0000${claim.predicate}`;
    const list = groups.get(key) ?? [];
    list.push(claim);
    groups.set(key, list);
  }

  const resolutions: ConflictResolution[] = [];
  for (const [, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (distinctValues(list).length <= 1) continue;
    const ranked = [...list].sort((a, b) => compare(a, b, sourceMap));
    const winner = ranked[0];
    const losers = ranked.slice(1);
    const winnerAuthority = winner.source_id
      ? sourceMap.get(winner.source_id)?.authority ?? "derived"
      : "derived";
    const loserAuthorities = losers.map((loser) =>
      loser.source_id ? sourceMap.get(loser.source_id)?.authority ?? "derived" : "derived",
    );
    const authorityDecided = loserAuthorities.some((authority) => authority !== winnerAuthority);
    const times = new Set(ranked.map((claim) => claim.retrieved_at ?? ""));
    const rule: ConflictResolution["rule"] = authorityDecided
      ? "authority"
      : times.size > 1
        ? "recency"
        : "manual";
    const decidedAt =
      ranked.map((claim) => claim.retrieved_at).filter((value): value is string => Boolean(value)).sort()[0] ??
      "1970-01-01T00:00:00.000Z";

    resolutions.push({
      subject: winner.subject,
      predicate: winner.predicate,
      winner_claim_id: winner.id,
      loser_claim_ids: losers.map((loser) => loser.id).sort(),
      rule,
      decided_at: decidedAt,
      note: authorityDecided
        ? `Winner selected by source authority (${winnerAuthority} over ${[...new Set(loserAuthorities)].join(", ")}).`
        : times.size > 1
          ? "Winner selected by most recent retrieval among equally authoritative sources."
          : "Values disagree with equal authority and retrieval time; manual review required.",
    });
  }
  return resolutions;
}
