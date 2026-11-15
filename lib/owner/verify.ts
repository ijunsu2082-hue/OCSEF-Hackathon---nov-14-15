/*
 * Claim verification and input validation. Pure: no network, no Clerk, no Supabase,
 * so it runs the same in route handlers and in tests (tests/verify.test.ts).
 */
import type { AssetKind, AssetRef, ClaimStatus, TaskStatus, VerifyMethod } from "./types";
import { FREE_MAIL_DOMAINS, OWNER_DOMAINS, type OwnerDomainEntry } from "./domains";

/* ---- owner names and domains --------------------------------------------- */

const CORP_SUFFIXES = new Set(["co", "company", "inc", "incorporated", "llc", "corp", "corporation", "ltd", "lp"]);

/** Lowercase, "&" -> "and", punctuation -> space, drop trailing corporate suffixes. */
export function normalizeOwnerName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && CORP_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

const ALIAS_INDEX: Map<string, OwnerDomainEntry> = (() => {
  const m = new Map<string, OwnerDomainEntry>();
  for (const e of OWNER_DOMAINS) for (const a of [e.owner, ...e.aliases]) m.set(normalizeOwnerName(a), e);
  return m;
})();

/** The curated entry for an owner name from public data, or null. Exact normalized match only. */
export function ownerEntryFor(ownerName: string): OwnerDomainEntry | null {
  const key = normalizeOwnerName(ownerName);
  return key ? ALIAS_INDEX.get(key) ?? null : null;
}

export function officialDomainsFor(ownerName: string): string[] {
  return ownerEntryFor(ownerName)?.domains ?? [];
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Domain part of an email address, lowercased, or null if the address is malformed. */
export function emailDomain(address: string): string | null {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at <= 0 || at !== a.indexOf("@")) return null;
  const local = a.slice(0, at);
  const domain = a.slice(at + 1).replace(/\.$/, "");
  if (local.length > 64 || /\s/.test(local)) return null;
  return DOMAIN_RE.test(domain) ? domain : null;
}

/** True when `domain` equals `official` or is a subdomain of it ("mail.sce.com" ok, "sce.com.evil.io" not). */
export function domainMatches(domain: string, official: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, "");
  const o = official.toLowerCase().replace(/\.$/, "");
  if (!d || !o) return false;
  return d === o || d.endsWith("." + o);
}

export function isFreeMailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  for (const f of FREE_MAIL_DOMAINS) if (domainMatches(d, f)) return true;
  return false;
}

/* ---- verification decision ----------------------------------------------- */

/** What we know about the user's primary email, as read server-side from Clerk. */
export interface PrimaryEmail {
  address: string;
  /** Clerk verified this address with a trusted strategy (see isTrustedEmailVerification). */
  verified: boolean;
}

/**
 * Clerk verification strategies that prove the user controls the address. Other strategies
 * (for example other OAuth providers that may assert emails they never checked) do not
 * auto-verify; those claims stay pending for an admin.
 */
export const TRUSTED_EMAIL_STRATEGIES: readonly string[] = ["email_code", "email_link", "from_oauth_google"];

/** True when Clerk's verification of the email is "verified" AND used a trusted strategy. */
export function isTrustedEmailVerification(v: { status?: string | null; strategy?: string | null } | null | undefined): boolean {
  return !!v && v.status === "verified" && typeof v.strategy === "string" && TRUSTED_EMAIL_STRATEGIES.includes(v.strategy);
}

export interface VerifyInput {
  method: VerifyMethod;
  /** Owner name from the asset's public data (never from the claimant). "" when the data has none. */
  ownerName: string;
  /** The user's PRIMARY email address; null if the account has none. */
  primaryEmail: PrimaryEmail | null;
}

export type VerifyReason =
  | "email_domain_match"
  | "document_needs_review"
  | "no_primary_email"
  | "email_not_verified"
  | "email_malformed"
  | "free_mail"
  | "owner_not_in_list"
  | "domain_mismatch";

export interface VerifyResult {
  status: Extract<ClaimStatus, "pending" | "verified">;
  reason: VerifyReason;
  /** Official domain that matched, when verified. */
  matchedDomain?: string;
  /** Plain sentence for the claimant. */
  message: string;
}

/**
 * Initial status of a new claim.
 * - document: always "pending" until an admin decides.
 * - email_domain: "verified" only if the PRIMARY email is Clerk-verified and its domain is
 *   (a subdomain of) an official domain for the owner named in public data; else "pending".
 */
export function decideVerification(input: VerifyInput): VerifyResult {
  if (input.method === "document") {
    return { status: "pending", reason: "document_needs_review", message: "Upload a document. An admin reviews it before the claim is verified." };
  }
  const pending = (reason: VerifyReason, message: string): VerifyResult => ({ status: "pending", reason, message });
  const e = input.primaryEmail;
  if (!e) return pending("no_primary_email", "Your account has no primary email address, so an admin will review this claim.");
  if (!e.verified) return pending("email_not_verified", "Your primary email address is not verified yet, so an admin will review this claim.");
  const domain = emailDomain(e.address);
  if (!domain) return pending("email_malformed", "Your primary email address could not be read, so an admin will review this claim.");
  if (isFreeMailDomain(domain)) return pending("free_mail", "Personal email addresses cannot verify ownership. Sign in with your work email or upload a document.");
  const entry = input.ownerName ? ownerEntryFor(input.ownerName) : null;
  if (!entry) return pending("owner_not_in_list", "We have no official email domain on file for this owner yet. Upload a document for an admin to review.");
  const official = entry.domains.find((o) => !isFreeMailDomain(o) && domainMatches(domain, o));
  if (!official) return pending("domain_mismatch", `Your email domain does not match ${entry.domains.join(" or ")}. Upload a document for an admin to review.`);
  return { status: "verified", reason: "email_domain_match", matchedDomain: official, message: `Verified by your work email on ${official}.` };
}

/* ---- input validation ---------------------------------------------------- */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T = never>(error: string): Parsed<T> => ({ ok: false, error });

export const LIMITS = {
  note: 500,
  reason: 500,
  assetName: 200,
  confirmation: 100,
  taskNote: 1000,
  fileBytes: 5 * 1024 * 1024,
  fileName: 120,
} as const;

const ASSET_ID_RE: Record<AssetKind, RegExp> = {
  plant: /^[1-9][0-9]{0,6}$/, // EIA plant code
  substation: /^(node|way|relation)\/[1-9][0-9]{0,14}$/, // OSM element id
  line: /^[1-9][0-9]{0,14}$/, // OSM way id
};

export const isAssetKind = (k: unknown): k is AssetKind => k === "plant" || k === "substation" || k === "line";
export const isVerifyMethod = (m: unknown): m is VerifyMethod => m === "email_domain" || m === "document";
export const isTaskStatus = (s: unknown): s is TaskStatus => s === "not_started" || s === "in_progress" || s === "filed";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);

/** Strict YYYY-MM-DD that is a real calendar date. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const OBLIGATION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/** Trim, drop control characters; null for empty; error if over the limit. */
export function cleanText(v: unknown, max: number, field: string): Parsed<string | null> {
  if (v === undefined || v === null) return ok(null);
  if (typeof v !== "string") return fail(`${field} must be text.`);
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (s.length > max) return fail(`${field} must be ${max} characters or fewer.`);
  return ok(s === "" ? null : s);
}

export function parseAssetRef(v: unknown): Parsed<AssetRef> {
  if (!v || typeof v !== "object") return fail("asset must be an object with kind and id.");
  const { kind, id } = v as { kind?: unknown; id?: unknown };
  if (!isAssetKind(kind)) return fail('asset.kind must be "plant", "substation" or "line".');
  if (typeof id !== "string" || !ASSET_ID_RE[kind].test(id)) return fail(`asset.id is not a valid ${kind} id.`);
  return ok({ kind, id });
}

export interface ClaimInput {
  asset: AssetRef;
  /** Display name the client saw. Used only when public data has no name for the asset. */
  assetNameHint: string | null;
  method: VerifyMethod;
  note: string | null;
}

/** POST /api/owner/claims body. owner_name and any user_id from the client are ignored. */
export function parseClaimBody(body: unknown): Parsed<ClaimInput> {
  if (!body || typeof body !== "object") return fail("Body must be a JSON object.");
  const b = body as Record<string, unknown>;
  const asset = parseAssetRef(b.asset);
  if (!asset.ok) return asset;
  if (!isVerifyMethod(b.method)) return fail('method must be "email_domain" or "document".');
  const note = cleanText(b.note, LIMITS.note, "note");
  if (!note.ok) return note;
  const name = cleanText(b.asset_name, LIMITS.assetName, "asset_name");
  if (!name.ok) return name;
  return ok({ asset: asset.value, assetNameHint: name.value, method: b.method, note: note.value });
}

export interface TaskInput {
  claim_id: string;
  obligation_id: string;
  due: string;
  status: TaskStatus;
  confirmation: string | null;
  note: string | null;
}

export function parseTaskBody(body: unknown): Parsed<TaskInput> {
  if (!body || typeof body !== "object") return fail("Body must be a JSON object.");
  const b = body as Record<string, unknown>;
  if (!isUuid(b.claim_id)) return fail("claim_id must be a claim id.");
  if (typeof b.obligation_id !== "string" || !OBLIGATION_ID_RE.test(b.obligation_id)) return fail("obligation_id is not valid.");
  if (!isIsoDate(b.due)) return fail("due must be a date in YYYY-MM-DD form.");
  if (!isTaskStatus(b.status)) return fail('status must be "not_started", "in_progress" or "filed".');
  const confirmation = cleanText(b.confirmation, LIMITS.confirmation, "confirmation");
  if (!confirmation.ok) return confirmation;
  const note = cleanText(b.note, LIMITS.taskNote, "note");
  if (!note.ok) return note;
  return ok({
    claim_id: b.claim_id.toLowerCase(),
    obligation_id: b.obligation_id,
    due: b.due,
    status: b.status,
    confirmation: confirmation.value,
    note: note.value,
  });
}

export interface DecisionInput {
  decision: "verified" | "rejected";
  reason: string | null;
}

export function parseDecisionBody(body: unknown): Parsed<DecisionInput> {
  if (!body || typeof body !== "object") return fail("Body must be a JSON object.");
  const b = body as Record<string, unknown>;
  if (b.decision !== "verified" && b.decision !== "rejected") return fail('decision must be "verified" or "rejected".');
  const reason = cleanText(b.reason, LIMITS.reason, "reason");
  if (!reason.ok) return reason;
  return ok({ decision: b.decision, reason: reason.value });
}

export function parseStatusFilter(v: string | null): Parsed<ClaimStatus | null> {
  if (v === null || v === "") return ok(null);
  if (v === "pending" || v === "verified" || v === "rejected") return ok(v);
  return fail('status must be "pending", "verified" or "rejected".');
}

/* ---- evidence files ------------------------------------------------------ */

export type EvidenceType = "application/pdf" | "image/png" | "image/jpeg";

/** 413 message for evidence uploads. Keep in step with LIMITS.fileBytes. */
export const FILE_TOO_BIG = "The file must be 5 MB or smaller.";

const EXT_TYPE: Record<string, EvidenceType> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** Detect the real file type from its first bytes. */
export function sniffType(head: Uint8Array): EvidenceType | null {
  const b = (i: number) => head[i];
  if (head.length >= 5 && b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46 && b(4) === 0x2d) return "application/pdf"; // %PDF-
  if (head.length >= 8 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return "image/png";
  if (head.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  return null;
}

/** Safe storage file name: ASCII letters, digits, dot, dash, underscore; keeps the extension. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, LIMITS.fileName - 6) || "evidence";
  return ext ? `${stem}.${ext}` : stem;
}

export interface EvidenceFileInput {
  name: string;
  size: number;
  /** MIME type the browser sent (may be empty). */
  type: string;
  /** First bytes of the file (at least 8). */
  head: Uint8Array;
}

/** PDF, PNG, JPG/JPEG only, at most 5 MB, extension and content must agree. */
export function validateEvidenceFile(f: EvidenceFileInput): Parsed<{ fileName: string; contentType: EvidenceType }> {
  if (!Number.isFinite(f.size) || f.size <= 0) return fail("The file is empty.");
  if (f.size > LIMITS.fileBytes) return fail(FILE_TOO_BIG);
  const fileName = safeFileName(f.name);
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1) : "";
  const byExt = EXT_TYPE[ext];
  if (!byExt) return fail("Upload a PDF, PNG or JPG file.");
  const sniffed = sniffType(f.head);
  if (sniffed !== byExt) return fail("The file content does not match its type. Upload a PDF, PNG or JPG file.");
  if (f.type && f.type !== byExt && !(byExt === "image/jpeg" && f.type === "image/jpg")) {
    return fail("The file content does not match its type. Upload a PDF, PNG or JPG file.");
  }
  return ok({ fileName, contentType: byExt });
}

/** <user_id>/<claim_id>/<file name>. Matches the storage policies in the migration. */
export function evidencePath(userId: string, claimId: string, fileName: string): string {
  return `${userId}/${claimId}/${fileName}`;
}

/* ---- stored claim vs public data ----------------------------------------- */

/** Name and owner of an asset as read from public data (lib/owner/db.ts findAssetRecord). */
export interface PublicAssetData {
  /** null when the public data has no name. */
  name: string | null;
  /** "" when the public data names no owner. */
  owner: string;
}

export type PublicDataMismatch = "not_in_public_data" | "owner_name" | "asset_name";

export interface PublicDataCheck {
  /** True when the stored claim agrees with public data. */
  ok: boolean;
  mismatches: PublicDataMismatch[];
  /** Owner to show: the public-data owner when the asset is found, else the stored value. */
  owner_name: string;
  /** Name to show: the public-data name when it has one, else the stored value. */
  asset_name: string;
}

/**
 * Compare a stored claim's owner_name / asset_name with public data. A user can insert a
 * claim straight through the Supabase REST API and skip the server's lookup, so admin
 * screens and decisions must not trust the stored values. asset_name is compared only when
 * public data has a name (otherwise the server stored the client's display name).
 */
export function checkClaimAgainstPublicData(
  stored: { owner_name: string; asset_name: string },
  record: PublicAssetData | null,
): PublicDataCheck {
  if (!record) return { ok: false, mismatches: ["not_in_public_data"], owner_name: stored.owner_name, asset_name: stored.asset_name };
  const mismatches: PublicDataMismatch[] = [];
  if (record.owner !== stored.owner_name) mismatches.push("owner_name");
  if (record.name !== null && record.name !== stored.asset_name) mismatches.push("asset_name");
  return {
    ok: mismatches.length === 0,
    mismatches,
    owner_name: record.owner,
    asset_name: record.name ?? stored.asset_name,
  };
}
