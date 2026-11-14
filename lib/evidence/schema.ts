/**
 * GridSentinel evidence contract — `gridsentinel.evidence/1`.
 *
 * This file is the single source of truth for how a displayed number becomes
 * traceable. Every number the UI shows must resolve to one `Claim`. A claim is
 * one of exactly four things:
 *
 *   observed  — the value appears at `locator` inside `snapshot_id`.
 *   derived   — the value is recomputed by a registered formula from other claims.
 *   modeled   — the value is produced by a named model from published inputs.
 *   inferred  — a human or a constrained LLM proposed it from cited evidence.
 *
 * There is no fifth category and no free-text "source" field. If a value cannot
 * be expressed as one of these, it does not ship.
 *
 * Determinism rules:
 *  - ids are content hashes, never counters or timestamps.
 *  - floats are compared after an explicit `rounding` declared per derivation.
 *  - `generated_at` is metadata; it is excluded from every id.
 */

export const EVIDENCE_SCHEMA = "gridsentinel.evidence/1" as const;

export type ClaimMethod = "observed" | "derived" | "modeled" | "inferred";

export type Confidence = "high" | "medium" | "low";

export type Authority = "primary" | "secondary" | "modeled" | "derived";

export type AccessKind =
  | "rest"
  | "arcgis"
  | "overpass"
  | "bulk"
  | "csv"
  | "html"
  | "layer"
  | "seed"
  | "manual";

/** A source is a publisher + a retrieval contract, not a single URL. */
export interface SourceDefinition {
  /** Stable slug. Never reuse an id for a different publisher or dataset. */
  id: string;
  title: string;
  publisher: string;
  homepage: string;
  /** SPDX id or a plain description. Displayed verbatim in the evidence drawer. */
  license: string;
  authority: Authority;
  access: {
    kind: AccessKind;
    /** Endpoint template. `{center}`, `{radius_m}`, `{bbox}` are documented in research/README.md. */
    endpoint: string;
    docs: string;
    deterministic: boolean;
    /** Free-form retrieval caveat, e.g. "public endpoint, 2 req/s". */
    notes: string;
  };
  freshness: {
    /** Human cadence, e.g. "annual". */
    cadence: string;
    /** A snapshot older than this is a verification warning, never silently accepted. */
    max_age_days: number;
  };
  caveats: string[];
}

/** One immutable retrieval. Content-addressed: same bytes => same id. */
export interface SourceSnapshot {
  id: string;
  source_id: string;
  url: string;
  method: "GET" | "POST";
  /** sha256 of the request body, null for GET. */
  request_digest: string | null;
  retrieved_at: string;
  http: {
    status: number;
    content_type: string | null;
    etag: string | null;
    last_modified: string | null;
  };
  bytes: number;
  sha256: string;
  /** Repo-relative path to the exact bytes used to build the claim set. */
  cache_path: string;
  /** Parser id, so the verifier can re-derive `record_count` from the bytes. */
  parser: string;
  parser_version: string;
  record_count: number | null;
  notes: string[];
}

export interface DerivationInput {
  /** Claim id this input consumes. */
  claim_id: string;
  /** Name the formula sees. */
  as: string;
}

/**
 * A derivation is a call into the formula registry (`lib/evidence/formulas.ts`).
 * `formula_id` is the only executable thing in an evidence bundle; no bundle can
 * introduce code. The verifier re-evaluates it and compares at `rounding`.
 */
export interface Derivation {
  formula_id: string;
  inputs: DerivationInput[];
  params: Record<string, string | number | boolean | null>;
  /** Display-only expression. Must equal the registry's template when present. */
  expression: string;
  rounding: number;
}

export interface EscalationRecord {
  provider: "groq" | "gemini" | "none";
  model: string;
  prompt_sha256: string;
  response_sha256: string;
  at: string;
  verdict: "accepted" | "rejected";
  reason: string;
}

export interface Claim {
  /** clm_<16 hex>; content hash, stable across re-fetches of identical evidence. */
  id: string;
  /** `facility:node-la-05` | `region:westminster-100mi`. */
  subject: string;
  /** Registered predicate id (`facility.nameplate_draw_mw`), never free text. */
  predicate: string;
  value: string | number | boolean | null;
  /** Canonical unit symbol, or null for strings/booleans. */
  unit: string | null;
  method: ClaimMethod;
  confidence: Confidence;
  source_id: string | null;
  snapshot_id: string | null;
  /** JSON Pointer into the snapshot, e.g. `/features/3/properties/...`. */
  locator: string | null;
  retrieved_at: string | null;
  derivation: Derivation | null;
  /** Required for `modeled`: the exact model + input basis. */
  basis: string | null;
  caveats: string[];
  escalation: EscalationRecord | null;
  /** Set only on claims materialised in the browser from other claims. Never persisted. */
  runtime?: boolean;
}

export interface ConflictResolution {
  subject: string;
  predicate: string;
  winner_claim_id: string;
  loser_claim_ids: string[];
  rule: "authority" | "recency" | "exact_agreement" | "manual";
  decided_at: string;
  note: string;
}

export type UnresolvedReason =
  | "no_source"
  | "conflict"
  | "below_confidence"
  | "stale"
  | "missing_unit"
  | "requires_review";

export interface UnresolvedItem {
  subject: string;
  predicate: string;
  reason: UnresolvedReason;
  detail: string;
  candidate_claim_ids: string[];
  escalated: boolean;
}

export interface Disclosure {
  id: string;
  subject: string;
  severity: "info" | "caution";
  text: string;
}

export interface VerificationIssue {
  code: string;
  severity: "error" | "warning";
  claim_id?: string;
  snapshot_id?: string;
  detail: string;
}

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerificationReport {
  ok: boolean;
  verified_at: string;
  bundle_id: string;
  errors: VerificationIssue[];
  warnings: VerificationIssue[];
  checks: VerificationCheck[];
}

export interface EvidenceBundle {
  schema: typeof EVIDENCE_SCHEMA;
  bundle_id: string;
  region: {
    id: string;
    name: string;
    state: string;
    center: [number, number];
    radius_miles: number;
    bounds: [[number, number], [number, number]];
  };
  generated_at: string;
  /** sha256 of the sorted source registry this bundle was built against. */
  registry_digest: string;
  sources: SourceDefinition[];
  snapshots: SourceSnapshot[];
  claims: Claim[];
  resolutions: ConflictResolution[];
  unresolved: UnresolvedItem[];
  disclosures: Disclosure[];
  verification: VerificationReport;
  stats: {
    claims: number;
    observed: number;
    derived: number;
    modeled: number;
    inferred: number;
    sources: number;
    snapshots: number;
    unresolved: number;
  };
}

export interface ClaimIndex {
  /** Winner per subject+predicate, after conflict resolution. */
  active: Map<string, Claim>;
  /** Every claim by id, including losers. */
  byId: Map<string, Claim>;
  /** All claims for a subject, in deterministic predicate order. */
  bySubject: Map<string, Claim[]>;
  bundle: EvidenceBundle;
}

export function claimKey(subject: string, predicate: string): string {
  return `${subject}\u0000${predicate}`;
}
