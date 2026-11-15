/**
 * File-level verification: the checks that need the actual bytes on disk.
 *
 * `lib/evidence/verify.ts` proves the bundle is internally consistent. This
 * module proves the bundle still corresponds to the world it cites:
 *   - each snapshot file still hashes to the recorded sha256;
 *   - each parser still yields the recorded record_count;
 *   - each observed/modeled claim's JSON Pointer still resolves to its value.
 */

import type {
  Claim,
  EvidenceBundle,
  VerificationIssue,
} from "../lib/evidence/schema";
import { resolvePointer } from "./parsers";
import { replaySnapshot } from "./snapshot";

export interface FileVerification {
  issues: VerificationIssue[];
  checkedSnapshots: number;
  checkedLocators: number;
}

function valuesMatch(a: unknown, b: Claim["value"]): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= 1e-9;
  }
  return a === b;
}

export async function verifyEvidenceFiles(bundle: EvidenceBundle): Promise<FileVerification> {
  const issues: VerificationIssue[] = [];
  const parsed = new Map<string, unknown>();
  let checkedSnapshots = 0;
  let checkedLocators = 0;

  for (const snapshot of bundle.snapshots) {
    try {
      const loaded = await replaySnapshot(snapshot);
      parsed.set(snapshot.id, loaded.data);
      checkedSnapshots += 1;
    } catch (error) {
      issues.push({
        code: "SNAPSHOT_REPLAY",
        severity: "error",
        snapshot_id: snapshot.id,
        detail: (error as Error).message,
      });
    }
  }

  for (const claim of bundle.claims) {
    if (!claim.snapshot_id || !claim.locator) continue;
    if (claim.derivation?.formula_id === "artifact.count") continue;
    const data = parsed.get(claim.snapshot_id);
    if (data === undefined) continue;
    try {
      const value = resolvePointer(data, claim.locator);
      checkedLocators += 1;
      if (!valuesMatch(value, claim.value)) {
        issues.push({
          code: "LOCATOR_MISMATCH",
          severity: "error",
          claim_id: claim.id,
          snapshot_id: claim.snapshot_id,
          detail: `${claim.subject}/${claim.predicate}: ${claim.locator} is ${JSON.stringify(
            value,
          )}, claim stores ${JSON.stringify(claim.value)}`,
        });
      }
    } catch (error) {
      issues.push({
        code: "LOCATOR_MISSING",
        severity: "error",
        claim_id: claim.id,
        snapshot_id: claim.snapshot_id,
        detail: `${claim.subject}/${claim.predicate}: ${(error as Error).message}`,
      });
    }
  }

  return { issues, checkedSnapshots, checkedLocators };
}
