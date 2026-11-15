/**
 * Canonical JSON + content-addressed ids.
 *
 * Every id in the evidence bundle is a hash of canonical bytes. That means:
 *  - two machines building from the same snapshots produce the same ids;
 *  - the UI can prove a claim was not edited after the fact;
 *  - re-fetching an unchanged source does not churn citation links.
 */

import { sha256Hex } from "./sha256";
import type {
  Claim,
  Derivation,
  EvidenceBundle,
  SourceDefinition,
  SourceSnapshot,
} from "./schema";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Deterministic JSON: sorted object keys, no whitespace, rejected non-finite
 * numbers, rejected undefined. This is the only serialisation allowed near an id.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) throw new Error("canonicalJson: undefined is not a JSON value");
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof value}`);
}

export function digest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function shortDigest(value: unknown, length = 16): string {
  return digest(value).slice(0, length);
}

function derivationCanonical(derivation: Derivation | null) {
  if (!derivation) return null;
  return {
    formula_id: derivation.formula_id,
    expression: derivation.expression,
    rounding: derivation.rounding,
    params: derivation.params,
    inputs: [...derivation.inputs].sort((a, b) => a.as.localeCompare(b.as)),
  };
}

/**
 * Claim identity: the assertion, not the fetch. `retrieved_at`, caveats and
 * confidence are excluded so a re-verified claim keeps the same citation anchor.
 */
export function computeClaimId(claim: Omit<Claim, "id" | "runtime">): string {
  return `clm_${shortDigest({
    subject: claim.subject,
    predicate: claim.predicate,
    value: claim.value,
    unit: claim.unit,
    method: claim.method,
    source_id: claim.source_id,
    snapshot_id: claim.snapshot_id,
    locator: claim.locator,
    derivation: derivationCanonical(claim.derivation),
    basis: claim.basis,
  })}`;
}

/** Snapshot identity is content-addressed: same bytes from same request => same id. */
export function computeSnapshotId(input: {
  source_id: string;
  url: string;
  method: "GET" | "POST";
  request_digest: string | null;
  sha256: string;
}): string {
  return `snp_${shortDigest({
    source_id: input.source_id,
    url: input.url,
    method: input.method,
    request_digest: input.request_digest,
    sha256: input.sha256,
  })}`;
}

/**
 * Bundle identity excludes `generated_at` and the embedded verification report.
 * It hashes the bundle's own schema id, so legacy `gridsentinel.evidence/1`
 * bundles keep their committed ids and new `mapergy.evidence/1` bundles get new ones.
 */
export function computeBundleId(bundle: {
  schema: EvidenceBundle["schema"];
  region: EvidenceBundle["region"];
  sources: SourceDefinition[];
  snapshots: SourceSnapshot[];
  claims: Claim[];
  resolutions: EvidenceBundle["resolutions"];
}): string {
  return `bnd_${shortDigest({
    schema: bundle.schema,
    region: bundle.region,
    sources: [...bundle.sources]
      .map((source) => source.id)
      .sort(),
    snapshots: [...bundle.snapshots]
      .map((snapshot) => `${snapshot.id}:${snapshot.sha256}`)
      .sort(),
    claims: [...bundle.claims]
      .map((claim) => claim.id)
      .sort(),
    resolutions: [...bundle.resolutions]
      .map((resolution) => canonicalJson(resolution))
      .sort(),
  })}`;
}

export function computeRegistryDigest(sources: SourceDefinition[]): string {
  return `reg_${digest([...sources].sort((a, b) => a.id.localeCompare(b.id)))}`;
}

export function asJson(value: unknown): Json {
  return JSON.parse(canonicalJson(value)) as Json;
}
