import { deadlinesFor, obligationsFor, previewObligations } from "@/lib/owner/obligations";
import type { Deadline, Obligation, OwnedAsset } from "@/lib/owner/types";

/*
 * The only place the owner screens call the obligations engine (lib/owner/obligations.ts).
 * Keeping the calls here means one file to touch if the engine signature changes.
 */

/** Public preview: what typically applies to this asset. */
export function previewFor(asset: OwnedAsset): Obligation[] {
  return previewObligations(asset);
}

/** Full list with prefill, for verified owners. */
export function obligationsForAsset(asset: OwnedAsset): Obligation[] {
  return obligationsFor(asset);
}

/** The engine reads UTC date parts, so pass the local calendar day as UTC midnight. */
function isoToUtcDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Deadlines for one obligation from the ISO day `fromIso` for `months` months. */
export function deadlinesIn(o: Obligation, fromIso: string, months = 12): Deadline[] {
  return deadlinesFor([o], isoToUtcDate(fromIso), months);
}

/** Earliest deadline on or after `fromIso` within 12 months, or null (event-driven / one-time items). */
export function nextDeadline(o: Obligation, fromIso: string): Deadline | null {
  const list = deadlinesIn(o, fromIso, 12);
  if (list.length === 0) return null;
  return [...list].sort((a, b) => a.due.localeCompare(b.due))[0];
}
