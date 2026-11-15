/**
 * Evidence verifier — pure, deterministic, and fail-closed.
 *
 * Nothing here trusts the bundle. It re-hashes every id, re-checks every
 * predicate against the registry, re-evaluates every derivation from its input
 * claims, and re-applies conflict resolution. If a number cannot be reproduced,
 * `ok` is false and the UI is forbidden from presenting it as evidence.
 *
 * File-level checks (does the snapshot on disk still hash to `sha256`?) live in
 * `research/verify-files.ts` because they need filesystem access. This module is
 * safe to run in the browser.
 */

import { computeBundleId, computeClaimId, computeRegistryDigest, computeSnapshotId } from "./canonical";
import {
  evaluateDerivation,
  getFormula,
  maxConfidence,
  roundAt,
  weakerConfidence,
} from "./formulas";
import { getPredicate } from "./predicates";
import {
  EVIDENCE_SCHEMA,
  EVIDENCE_SCHEMAS,
  type Claim,
  type Confidence,
  type EvidenceBundle,
  type SourceDefinition,
  type SourceSnapshot,
  type VerificationIssue,
  type VerificationReport,
} from "./schema";

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?$/;

export interface VerifyOptions {
  /** Treat any unresolved item as a failure. Use in CI. */
  strict?: boolean;
  /** Verify freshness against this instant. Defaults to Date.now(). */
  now?: Date;
  /** A snapshot older than its source's max age becomes a warning (or error in strict). */
  enforceFreshness?: boolean;
}

function issue(code: string, detail: string, extra?: Partial<VerificationIssue>): VerificationIssue {
  return { code, severity: "error", detail, ...extra };
}

function warn(code: string, detail: string, extra?: Partial<VerificationIssue>): VerificationIssue {
  return { code, severity: "warning", detail, ...extra };
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

function checkSource(source: SourceDefinition, errors: VerificationIssue[]) {
  if (!source.id) errors.push(issue("SOURCE_ID", "source has an empty id"));
  if (!source.title) errors.push(issue("SOURCE_TITLE", `source ${source.id} has no title`));
  if (!source.publisher) errors.push(issue("SOURCE_PUBLISHER", `source ${source.id} has no publisher`));
  if (!source.homepage) errors.push(issue("SOURCE_HOMEPAGE", `source ${source.id} has no homepage`));
  if (!source.license) errors.push(issue("SOURCE_LICENSE", `source ${source.id} has no license`));
  if (!source.access.endpoint) {
    errors.push(issue("SOURCE_ENDPOINT", `source ${source.id} has no endpoint`));
  }
}

function snapshotById(snapshots: SourceSnapshot[]): Map<string, SourceSnapshot> {
  return new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
}

function sourceById(sources: SourceDefinition[]): Map<string, SourceDefinition> {
  return new Map(sources.map((source) => [source.id, source]));
}

function valueEquals(a: Claim["value"], b: Claim["value"], digits: number): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "number" && typeof b === "number") {
    return roundAt(a, digits) === roundAt(b, digits);
  }
  return a === b;
}

/**
 * Deterministic winner when several claims agree in value. Higher confidence,
 * then primary authority, then most recent retrieval, then lexicographic id.
 */
function rankClaim(claim: Claim, sources: Map<string, SourceDefinition>): string {
  const authority = claim.source_id ? sources.get(claim.source_id)?.authority ?? "derived" : "derived";
  const authorityRank: Record<string, string> = {
    primary: "0",
    secondary: "1",
    derived: "2",
    modeled: "3",
  };
  return [
    String(2 - CONFIDENCE_RANK[claim.confidence]),
    authorityRank[authority] ?? "9",
    claim.retrieved_at ? invertTime(claim.retrieved_at) : "~",
    claim.id,
  ].join("|");
}

function invertTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "~";
  return String(9_999_999_999_999 - ms).padStart(13, "0");
}

export interface VerificationResult {
  report: VerificationReport;
  /** Winner per subject+predicate. Empty when the bundle is invalid. */
  active: Map<string, Claim>;
}

export function verifyBundle(bundle: EvidenceBundle, options: VerifyOptions = {}): VerificationResult {
  const errors: VerificationIssue[] = [];
  const warnings: VerificationIssue[] = [];
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const now = options.now ?? new Date();

  const pushCheck = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
  };

  // ---- schema ---------------------------------------------------------------
  if (!EVIDENCE_SCHEMAS.includes(bundle.schema)) {
    errors.push(issue("SCHEMA", `expected ${EVIDENCE_SCHEMA}, got ${String(bundle.schema)}`));
  }
  if (!bundle.region?.id) errors.push(issue("REGION", "region.id is missing"));
  if (!Array.isArray(bundle.sources)) errors.push(issue("SOURCES", "sources must be an array"));
  if (!Array.isArray(bundle.snapshots)) errors.push(issue("SNAPSHOTS", "snapshots must be an array"));
  if (!Array.isArray(bundle.claims)) errors.push(issue("CLAIMS", "claims must be an array"));
  pushCheck("schema", errors.length === 0, bundle.schema);

  const sources = new Map<string, SourceDefinition>();
  for (const source of bundle.sources ?? []) {
    if (sources.has(source.id)) {
      errors.push(issue("SOURCE_DUPLICATE", `duplicate source id ${source.id}`));
    }
    sources.set(source.id, source);
    checkSource(source, errors);
  }

  const expectedRegistry = computeRegistryDigest(bundle.sources ?? []);
  if (bundle.registry_digest !== expectedRegistry) {
    errors.push(
      issue(
        "REGISTRY_DIGEST",
        `registry_digest ${bundle.registry_digest} does not match ${expectedRegistry}`,
      ),
    );
  }
  pushCheck("registry", sources.size > 0, `${sources.size} sources`);

  // ---- snapshots ------------------------------------------------------------
  const snapshots = new Map<string, SourceSnapshot>();
  for (const snapshot of bundle.snapshots ?? []) {
    if (snapshots.has(snapshot.id)) {
      errors.push(issue("SNAPSHOT_DUPLICATE", `duplicate snapshot id ${snapshot.id}`));
    }
    snapshots.set(snapshot.id, snapshot);

    if (!sources.has(snapshot.source_id)) {
      errors.push(
        issue("SNAPSHOT_SOURCE", `snapshot ${snapshot.id} references unknown source ${snapshot.source_id}`),
      );
    }
    if (!SHA256.test(snapshot.sha256)) {
      errors.push(issue("SNAPSHOT_SHA", `snapshot ${snapshot.id} has a malformed sha256`));
    }
    const expectedId = computeSnapshotId({
      source_id: snapshot.source_id,
      url: snapshot.url,
      method: snapshot.method,
      request_digest: snapshot.request_digest,
      sha256: snapshot.sha256,
    });
    if (snapshot.id !== expectedId) {
      errors.push(
        issue("SNAPSHOT_ID", `snapshot ${snapshot.id} does not hash to ${expectedId}`),
      );
    }
    if (!isIso(snapshot.retrieved_at)) {
      errors.push(issue("SNAPSHOT_TIME", `snapshot ${snapshot.id} has an invalid retrieved_at`));
    }
    if (!snapshot.cache_path) {
      errors.push(issue("SNAPSHOT_PATH", `snapshot ${snapshot.id} has no cache_path`));
    }
    if (!Number.isFinite(snapshot.bytes) || snapshot.bytes < 0) {
      errors.push(issue("SNAPSHOT_BYTES", `snapshot ${snapshot.id} has an invalid byte count`));
    }
    if (!snapshot.parser) {
      errors.push(issue("SNAPSHOT_PARSER", `snapshot ${snapshot.id} has no parser`));
    }

    if (options.enforceFreshness) {
      const source = sources.get(snapshot.source_id);
      const ageDays = (now.getTime() - Date.parse(snapshot.retrieved_at)) / 86_400_000;
      if (source && Number.isFinite(ageDays) && ageDays > source.freshness.max_age_days) {
        const entry = warn(
          "SNAPSHOT_STALE",
          `${snapshot.id} is ${Math.round(ageDays)} days old; ${source.id} allows ${source.freshness.max_age_days}`,
          { snapshot_id: snapshot.id },
        );
        if (options.strict) errors.push({ ...entry, severity: "error" });
        else warnings.push(entry);
      }
    }
  }
  pushCheck("snapshots", snapshots.size > 0, `${snapshots.size} snapshots`);

  // ---- claims ---------------------------------------------------------------
  const claims = new Map<string, Claim>();
  for (const claim of bundle.claims ?? []) {
    if (claims.has(claim.id)) {
      errors.push(issue("CLAIM_DUPLICATE", `duplicate claim id ${claim.id}`, { claim_id: claim.id }));
      continue;
    }
    claims.set(claim.id, claim);
    validateClaimShape(claim, sources, snapshots, errors);
  }
  pushCheck("claim shape", errors.length === 0, `${claims.size} claims`);

  // ---- derivation graph -----------------------------------------------------
  const memo = new Map<string, Claim["value"]>();
  const visiting = new Set<string>();

  const resolveValue = (claimId: string): Claim["value"] => {
    if (memo.has(claimId)) return memo.get(claimId) ?? null;
    const claim = claims.get(claimId);
    if (!claim) throw new Error(`unknown claim ${claimId}`);
    if (!claim.derivation) {
      memo.set(claimId, claim.value);
      return claim.value;
    }
    if (visiting.has(claimId)) throw new Error(`cycle at ${claimId}`);
    visiting.add(claimId);

    const formula = getFormula(claim.derivation.formula_id);
    if (!formula) throw new Error(`unknown formula ${claim.derivation.formula_id}`);

    const inputClaims = claim.derivation.inputs.map((input) => {
      const inputClaim = claims.get(input.claim_id);
      if (!inputClaim) throw new Error(`missing input ${input.claim_id}`);
      // Force evaluation of nested derivations so a cycle anywhere is caught.
      resolveValue(input.claim_id);
      return inputClaim;
    });

    const snapshot = claim.snapshot_id ? snapshots.get(claim.snapshot_id) ?? null : null;
    const computed = evaluateDerivation(claim.derivation, inputClaims, snapshot);
    visiting.delete(claimId);
    memo.set(claimId, computed);
    return computed;
  };

  for (const claim of claims.values()) {
    if (claim.method !== "derived" || !claim.derivation) continue;
    try {
      const computed = resolveValue(claim.id);
      const digits = claim.derivation.rounding;
      const formula = getFormula(claim.derivation.formula_id);
      if (!formula) {
        errors.push(issue("FORMULA_UNKNOWN", `claim ${claim.id} names ${claim.derivation.formula_id}`, { claim_id: claim.id }));
        continue;
      }
      if (digits !== formula.rounding) {
        errors.push(
          issue(
            "FORMULA_ROUNDING",
            `claim ${claim.id} declares ${digits} decimals; ${formula.id} requires ${formula.rounding}`,
            { claim_id: claim.id },
          ),
        );
      }
      if (computed === null) {
        if (claim.value !== null) {
          errors.push(
            issue("DERIVATION_NULL", `claim ${claim.id} should be null but stores ${String(claim.value)}`, {
              claim_id: claim.id,
            }),
          );
        }
      } else if (typeof computed === "number" && typeof claim.value === "number") {
        if (!valueEquals(claim.value, computed, digits)) {
          errors.push(
            issue(
              "DERIVATION_MISMATCH",
              `claim ${claim.id} stores ${claim.value}; formula ${formula.id} yields ${computed} at ${digits} dp`,
              { claim_id: claim.id },
            ),
          );
        }
      } else if (computed !== claim.value) {
        errors.push(
          issue("DERIVATION_MISMATCH", `claim ${claim.id} does not match formula output`, {
            claim_id: claim.id,
          }),
        );
      }
      if (claim.derivation.expression !== formula.expression) {
        warnings.push(
          warn(
            "FORMULA_EXPRESSION_DRIFT",
            `claim ${claim.id} expression differs from registry template for ${formula.id}`,
            { claim_id: claim.id },
          ),
        );
      }
    } catch (err) {
      errors.push(
        issue("DERIVATION_ERROR", `claim ${claim.id}: ${(err as Error).message}`, {
          claim_id: claim.id,
        }),
      );
    }
  }
  pushCheck("derivations", !errors.some((entry) => entry.code.startsWith("DERIVATION")), "recomputed");

  // ---- confidence ceiling ---------------------------------------------------
  for (const claim of claims.values()) {
    const basis: Omit<Claim, "confidence"> = { ...claim };
    delete (basis as Partial<Claim>).confidence;
    let inputClaims: Claim[] = [];
    if (claim.derivation) {
      inputClaims = claim.derivation.inputs
        .map((input) => claims.get(input.claim_id))
        .filter((input): input is Claim => Boolean(input));
    }
    const authority = claim.source_id ? sources.get(claim.source_id)?.authority ?? null : null;
    const ceiling = maxConfidence(basis, authority, inputClaims);
    if (CONFIDENCE_RANK[claim.confidence] > CONFIDENCE_RANK[ceiling]) {
      errors.push(
        issue(
          "CONFIDENCE_OVERSTATED",
          `claim ${claim.id} declares ${claim.confidence}; max permitted is ${ceiling}`,
          { claim_id: claim.id },
        ),
      );
    }
  }
  pushCheck("confidence", !errors.some((entry) => entry.code === "CONFIDENCE_OVERSTATED"), "capped");

  // ---- conflict resolution --------------------------------------------------
  const byKey = new Map<string, Claim[]>();
  for (const claim of claims.values()) {
    const key = `${claim.subject}\u0000${claim.predicate}`;
    const list = byKey.get(key) ?? [];
    list.push(claim);
    byKey.set(key, list);
  }

  const active = new Map<string, Claim>();
  const resolutions = bundle.resolutions ?? [];
  const seenResolutionKeys = new Set<string>();

  for (const [key, list] of byKey) {
    const [subject, predicate] = key.split("\u0000");
    const distinct: Claim[] = [];
    for (const claim of list) {
      if (!distinct.some((candidate) => valueEquals(candidate.value, claim.value, 9))) {
        distinct.push(claim);
      }
    }

    if (distinct.length === 1) {
      const winner = [...list].sort((a, b) =>
        rankClaim(a, sources).localeCompare(rankClaim(b, sources)),
      )[0];
      active.set(key, winner);
      const matching = resolutions.filter(
        (resolution) => resolution.subject === subject && resolution.predicate === predicate,
      );
      if (matching.length > 0) {
        warnings.push(
          warn("RESOLUTION_UNUSED", `resolution present for ${subject}/${predicate} but no conflict exists`),
        );
      }
      continue;
    }

    const resolution = resolutions.find(
      (candidate) => candidate.subject === subject && candidate.predicate === predicate,
    );
    if (!resolution) {
      errors.push(
        issue(
          "CONFLICT_UNRESOLVED",
          `${subject}/${predicate} has ${distinct.length} distinct values and no resolution`,
        ),
      );
      continue;
    }
    seenResolutionKeys.add(key);

    const winner = claims.get(resolution.winner_claim_id);
    const losers = resolution.loser_claim_ids.map((id) => claims.get(id));
    if (!winner) {
      errors.push(issue("RESOLUTION_WINNER", `${subject}/${predicate} winner is not in the bundle`));
      continue;
    }
    if (winner.subject !== subject || winner.predicate !== predicate) {
      errors.push(issue("RESOLUTION_WINNER_SUBJECT", `${resolution.winner_claim_id} is not ${subject}/${predicate}`));
    }
    if (losers.some((loser) => !loser)) {
      errors.push(issue("RESOLUTION_LOSER", `${subject}/${predicate} references a missing loser`));
      continue;
    }
    const expectedLosers = list
      .map((claim) => claim.id)
      .filter((id) => id !== winner.id)
      .sort();
    const declaredLosers = [...resolution.loser_claim_ids].sort();
    if (expectedLosers.join(",") !== declaredLosers.join(",")) {
      errors.push(
        issue(
          "RESOLUTION_COVERAGE",
          `${subject}/${predicate} resolution does not cover exactly the non-winning claims`,
        ),
      );
    }
    if (resolution.rule === "manual" && !resolution.note) {
      errors.push(issue("RESOLUTION_NOTE", `manual resolution for ${subject}/${predicate} needs a note`));
    }
    if (!isIso(resolution.decided_at)) {
      errors.push(issue("RESOLUTION_TIME", `${subject}/${predicate} has an invalid decided_at`));
    }
    active.set(key, winner);
  }

  for (const resolution of resolutions) {
    const key = `${resolution.subject}\u0000${resolution.predicate}`;
    if (!byKey.has(key)) {
      errors.push(
        issue(
          "RESOLUTION_ORPHAN",
          `resolution for ${resolution.subject}/${resolution.predicate} has no claims`,
        ),
      );
    }
  }
  pushCheck(
    "conflicts",
    !errors.some((entry) => entry.code.startsWith("CONFLICT") || entry.code.startsWith("RESOLUTION")),
    `${active.size} active claims`,
  );

  // ---- unresolved + disclosures --------------------------------------------
  const unresolved = bundle.unresolved ?? [];
  for (const item of unresolved) {
    if (!getPredicate(item.predicate) && !item.predicate.startsWith("any.")) {
      warnings.push(
        warn("UNRESOLVED_PREDICATE", `unresolved ${item.subject}/${item.predicate} uses an unknown predicate`),
      );
    }
    for (const id of item.candidate_claim_ids) {
      if (!claims.has(id)) {
        errors.push(issue("UNRESOLVED_CANDIDATE", `${item.subject}/${item.predicate} references missing claim ${id}`));
      }
    }
    if (options.strict) {
      errors.push(
        issue(
          "UNRESOLVED_ITEMS",
          `${item.subject}/${item.predicate}: ${item.reason} — ${item.detail}`,
        ),
      );
    } else if (item.reason === "conflict") {
      errors.push(
        issue("UNRESOLVED_CONFLICT", `${item.subject}/${item.predicate}: ${item.detail}`),
      );
    }
  }
  pushCheck("unresolved", unresolved.length === 0 || !options.strict, `${unresolved.length} open`);

  const disclosureIds = new Set<string>();
  for (const disclosure of bundle.disclosures ?? []) {
    if (!disclosure.id || !disclosure.text) {
      errors.push(issue("DISCLOSURE", "disclosure requires id and text"));
    }
    if (disclosureIds.has(disclosure.id)) {
      errors.push(issue("DISCLOSURE_DUPLICATE", `duplicate disclosure ${disclosure.id}`));
    }
    disclosureIds.add(disclosure.id);
  }

  // ---- bundle identity + stats ---------------------------------------------
  const expectedBundle = computeBundleId({
    schema: bundle.schema,
    region: bundle.region,
    sources: bundle.sources ?? [],
    snapshots: bundle.snapshots ?? [],
    claims: bundle.claims ?? [],
    resolutions: bundle.resolutions ?? [],
  });
  if (bundle.bundle_id !== expectedBundle) {
    errors.push(
      issue("BUNDLE_ID", `bundle_id ${bundle.bundle_id} does not match ${expectedBundle}`),
    );
  }
  pushCheck("bundle id", bundle.bundle_id === expectedBundle, expectedBundle);

  const stats = {
    claims: claims.size,
    observed: [...claims.values()].filter((claim) => claim.method === "observed").length,
    derived: [...claims.values()].filter((claim) => claim.method === "derived").length,
    modeled: [...claims.values()].filter((claim) => claim.method === "modeled").length,
    inferred: [...claims.values()].filter((claim) => claim.method === "inferred").length,
    sources: bundle.sources?.length ?? 0,
    snapshots: bundle.snapshots?.length ?? 0,
    unresolved: unresolved.length,
  };
  if (bundle.stats) {
    for (const [key, expected] of Object.entries(stats)) {
      const actual = bundle.stats[key as keyof typeof stats];
      if (actual !== expected) {
        warnings.push(
          warn("STATS_STALE", `stats.${key} is ${String(actual)}; bundle contains ${expected}`),
        );
      }
    }
  }

  const report: VerificationReport = {
    ok: errors.length === 0,
    verified_at: now.toISOString(),
    bundle_id: bundle.bundle_id,
    errors,
    warnings,
    checks,
  };

  return { report, active };
}

function validateClaimShape(
  claim: Claim,
  sources: Map<string, SourceDefinition>,
  snapshots: Map<string, SourceSnapshot>,
  errors: VerificationIssue[],
) {
  const id = claim.id;
  if (!claim.subject || !claim.subject.includes(":")) {
    errors.push(issue("CLAIM_SUBJECT", `claim ${id} has an invalid subject`, { claim_id: id }));
  }
  const predicate = getPredicate(claim.predicate);
  if (!predicate) {
    errors.push(issue("PREDICATE_UNKNOWN", `claim ${id} uses unregistered predicate ${claim.predicate}`, { claim_id: id }));
    return;
  }
  if (predicate.subject_prefix && !claim.subject.startsWith(`${predicate.subject_prefix}:`)) {
    errors.push(
      issue(
        "PREDICATE_SUBJECT",
        `claim ${id} predicate ${claim.predicate} requires subject prefix ${predicate.subject_prefix}:`,
        { claim_id: id },
      ),
    );
  }
  if (!predicate.allowed_methods.includes(claim.method)) {
    errors.push(
      issue(
        "METHOD_NOT_ALLOWED",
        `claim ${id} uses ${claim.method}; ${claim.predicate} allows ${predicate.allowed_methods.join("|")}`,
        { claim_id: id },
      ),
    );
  }
  if (claim.method === "inferred" && !predicate.allow_inferred) {
    errors.push(
      issue("INFERRED_NOT_ALLOWED", `claim ${id} is inferred but ${claim.predicate} forbids inference`, {
        claim_id: id,
      }),
    );
  }

  // value domain
  if (claim.value === null) {
    if (!predicate.nullable) {
      errors.push(issue("VALUE_NULL", `claim ${id} is null but ${claim.predicate} is not nullable`, { claim_id: id }));
    }
  } else if (predicate.value_type === "number") {
    if (typeof claim.value !== "number" || !Number.isFinite(claim.value)) {
      errors.push(issue("VALUE_TYPE", `claim ${id} must be a finite number`, { claim_id: id }));
    } else {
      if (predicate.integer && !Number.isInteger(claim.value)) {
        errors.push(issue("VALUE_INTEGER", `claim ${id} must be an integer`, { claim_id: id }));
      }
      if (predicate.min !== undefined && claim.value < predicate.min) {
        errors.push(issue("VALUE_RANGE", `claim ${id} ${claim.value} < ${predicate.min}`, { claim_id: id }));
      }
      if (predicate.max !== undefined && claim.value > predicate.max) {
        errors.push(issue("VALUE_RANGE", `claim ${id} ${claim.value} > ${predicate.max}`, { claim_id: id }));
      }
    }
  } else if (predicate.value_type === "string") {
    if (typeof claim.value !== "string") {
      errors.push(issue("VALUE_TYPE", `claim ${id} must be a string`, { claim_id: id }));
    } else if (predicate.enum_values && !predicate.enum_values.includes(claim.value)) {
      errors.push(
        issue("VALUE_ENUM", `claim ${id} value "${claim.value}" is not in the closed domain`, { claim_id: id }),
      );
    }
  } else if (predicate.value_type === "boolean" && typeof claim.value !== "boolean") {
    errors.push(issue("VALUE_TYPE", `claim ${id} must be a boolean`, { claim_id: id }));
  }

  if (claim.unit !== predicate.unit) {
    errors.push(
      issue(
        "UNIT",
        `claim ${id} unit ${String(claim.unit)} != ${String(predicate.unit)} for ${claim.predicate}`,
        { claim_id: id },
      ),
    );
  }

  // provenance by method
  if (claim.method === "observed") {
    if (!claim.source_id || !sources.has(claim.source_id)) {
      errors.push(issue("OBSERVED_SOURCE", `claim ${id} has no registered source`, { claim_id: id }));
    }
    if (!claim.snapshot_id || !snapshots.has(claim.snapshot_id)) {
      errors.push(issue("OBSERVED_SNAPSHOT", `claim ${id} has no registered snapshot`, { claim_id: id }));
    } else if (claim.source_id) {
      const snapshot = snapshots.get(claim.snapshot_id);
      if (snapshot && snapshot.source_id !== claim.source_id) {
        errors.push(issue("OBSERVED_SOURCE_MISMATCH", `claim ${id} source does not own its snapshot`, { claim_id: id }));
      }
    }
    if (!claim.locator) {
      errors.push(issue("OBSERVED_LOCATOR", `claim ${id} has no locator`, { claim_id: id }));
    }
    if (!isIso(claim.retrieved_at)) {
      errors.push(issue("OBSERVED_TIME", `claim ${id} has no valid retrieval time`, { claim_id: id }));
    }
    if (claim.derivation) {
      errors.push(issue("OBSERVED_DERIVATION", `claim ${id} is observed but carries a derivation`, { claim_id: id }));
    }
    if (claim.basis) {
      errors.push(issue("OBSERVED_BASIS", `claim ${id} is observed but carries a model basis`, { claim_id: id }));
    }
  }

  if (claim.method === "modeled") {
    if (!claim.basis || claim.basis.trim().length < 8) {
      errors.push(issue("MODELED_BASIS", `claim ${id} needs a model basis`, { claim_id: id }));
    }
    if (claim.derivation) {
      errors.push(issue("MODELED_DERIVATION", `claim ${id} is modeled but carries a derivation`, { claim_id: id }));
    }
    if (claim.source_id && !sources.has(claim.source_id)) {
      errors.push(issue("MODELED_SOURCE", `claim ${id} references an unknown source`, { claim_id: id }));
    }
    if (claim.snapshot_id && !snapshots.has(claim.snapshot_id)) {
      errors.push(issue("MODELED_SNAPSHOT", `claim ${id} references an unknown snapshot`, { claim_id: id }));
    }
  }

  if (claim.method === "derived") {
    if (!claim.derivation) {
      errors.push(issue("DERIVED_FORMULA", `claim ${id} is derived but has no derivation`, { claim_id: id }));
    } else {
      const formula = getFormula(claim.derivation.formula_id);
      if (formula) {
        const names = claim.derivation.inputs.map((input) => input.as);
        if (new Set(names).size !== names.length) {
          errors.push(issue("DERIVED_INPUT_DUP", `claim ${id} binds an input name twice`, { claim_id: id }));
        }
        if (formula.inputs !== "any") {
          const expected = [...formula.inputs].sort().join(",");
          const actual = [...names].sort().join(",");
          if (expected !== actual) {
            errors.push(
              issue("DERIVED_INPUTS", `claim ${id} inputs [${actual}] != [${expected}] for ${formula.id}`, {
                claim_id: id,
              }),
            );
          }
        } else if (names.length < (formula.min_inputs ?? 0)) {
          errors.push(issue("DERIVED_INPUTS", `claim ${id} has too few inputs for ${formula.id}`, { claim_id: id }));
        }
        for (const param of formula.required_params ?? []) {
          if (!(param in claim.derivation.params)) {
            errors.push(issue("DERIVED_PARAM", `claim ${id} is missing param ${param}`, { claim_id: id }));
          }
        }
      }
      const artifact = claim.derivation.formula_id === "artifact.count";
      if (!artifact && (claim.source_id || claim.snapshot_id || claim.locator)) {
        errors.push(
          issue("DERIVED_PROVENANCE", `claim ${id} is derived from claims but also carries source provenance`, {
            claim_id: id,
          }),
        );
      }
      if (artifact) {
        if (!claim.snapshot_id || !snapshots.has(claim.snapshot_id)) {
          errors.push(issue("ARTIFACT_SNAPSHOT", `claim ${id} needs a snapshot for artifact.count`, { claim_id: id }));
        }
        if (claim.derivation.inputs.length !== 0) {
          errors.push(issue("ARTIFACT_INPUTS", `claim ${id} artifact.count must have no claim inputs`, { claim_id: id }));
        }
      }
    }
  }

  if (claim.method === "inferred") {
    if (!claim.escalation) {
      errors.push(issue("INFERRED_ESCALATION", `claim ${id} is inferred without an escalation record`, { claim_id: id }));
    } else if (claim.escalation.verdict !== "accepted") {
      errors.push(issue("INFERRED_VERDICT", `claim ${id} escalation was not accepted`, { claim_id: id }));
    }
    if (claim.confidence !== "low") {
      errors.push(issue("INFERRED_CONFIDENCE", `claim ${id} must be low confidence`, { claim_id: id }));
    }
    if (!claim.source_id || !sources.has(claim.source_id)) {
      errors.push(issue("INFERRED_SOURCE", `claim ${id} must cite a registered source`, { claim_id: id }));
    }
    if (!claim.locator) {
      errors.push(issue("INFERRED_LOCATOR", `claim ${id} must cite a locator`, { claim_id: id }));
    }
    if (!claim.basis) {
      errors.push(issue("INFERRED_BASIS", `claim ${id} must state the reasoning basis`, { claim_id: id }));
    }
  }

  const expectedId = computeClaimId(claim);
  if (claim.id !== expectedId) {
    errors.push(issue("CLAIM_ID", `claim ${claim.id} does not hash to ${expectedId}`, { claim_id: claim.id }));
  }
}

/** Active claims only; use this in UI and reports. */
export function activeClaims(bundle: EvidenceBundle): Claim[] {
  const { active } = verifyBundle(bundle);
  return [...active.values()].sort(
    (a, b) => a.subject.localeCompare(b.subject) || a.predicate.localeCompare(b.predicate),
  );
}

export { weakerConfidence };
