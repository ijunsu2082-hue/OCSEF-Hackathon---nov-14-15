import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkClaimAgainstPublicData,
  decideVerification,
  isTrustedEmailVerification,
  LIMITS,
  sniffType,
  domainMatches,
  emailDomain,
  evidencePath,
  isFreeMailDomain,
  isIsoDate,
  normalizeOwnerName,
  officialDomainsFor,
  ownerEntryFor,
  parseAssetRef,
  parseClaimBody,
  parseDecisionBody,
  parseStatusFilter,
  parseTaskBody,
  safeFileName,
  validateEvidenceFile,
} from "../lib/owner/verify";
import { FREE_MAIL_DOMAINS, OWNER_DOMAINS } from "../lib/owner/domains";
import { readJson } from "./helpers";

const SCE = "Southern California Edison Co"; // EIA-860 utility_name as it appears in plants.geojson
const verified = (address: string) => ({ address, verified: true });
const emailClaim = (ownerName: string, address: string | null, isVerified = true) =>
  decideVerification({
    method: "email_domain",
    ownerName,
    primaryEmail: address === null ? null : { address, verified: isVerified },
  });

/* ---- domain matching ----------------------------------------------------- */

test("exact official domain verifies", () => {
  const r = emailClaim(SCE, "pat.lee@sce.com");
  assert.equal(r.status, "verified");
  assert.equal(r.reason, "email_domain_match");
  assert.equal(r.matchedDomain, "sce.com");
});

test("subdomain of the official domain verifies, and case does not matter", () => {
  assert.equal(emailClaim(SCE, "Pat.Lee@Mail.SCE.com").status, "verified");
  assert.equal(domainMatches("ops.sce.com", "sce.com"), true);
});

test("lookalike domains are rejected", () => {
  for (const addr of ["a@sce.com.evil.io", "a@evilsce.com", "a@sce-com.io", "a@sce.co", "a@xsce.com"]) {
    const r = emailClaim(SCE, addr);
    assert.equal(r.status, "pending", addr);
    assert.equal(r.reason, "domain_mismatch", addr);
  }
  assert.equal(domainMatches("sce.com.evil.io", "sce.com"), false);
  assert.equal(domainMatches("evilsce.com", "sce.com"), false);
});

test("free-mail addresses never verify", () => {
  for (const addr of ["someone@gmail.com", "someone@yahoo.com", "someone@outlook.com", "someone@icloud.com"]) {
    const r = emailClaim(SCE, addr);
    assert.equal(r.status, "pending", addr);
    assert.equal(r.reason, "free_mail", addr);
  }
  assert.equal(isFreeMailDomain("googlemail.com"), true);
});

test("an unverified primary email does not verify, even on the right domain", () => {
  const r = emailClaim(SCE, "pat.lee@sce.com", false);
  assert.equal(r.status, "pending");
  assert.equal(r.reason, "email_not_verified");
});

test("no primary email or a malformed one stays pending", () => {
  assert.equal(emailClaim(SCE, null).reason, "no_primary_email");
  assert.equal(emailClaim(SCE, "not-an-email").reason, "email_malformed");
  assert.equal(emailClaim(SCE, "a@b@sce.com").reason, "email_malformed");
  assert.equal(emailDomain("a@sce"), null);
});

test("owner must be in the curated list; no owner in data stays pending", () => {
  assert.equal(emailClaim("Acme Solar LLC", "a@acmesolar.com").reason, "owner_not_in_list");
  assert.equal(emailClaim("", "a@sce.com").reason, "owner_not_in_list");
});

test("a valid email for one owner does not verify a different owner", () => {
  const r = emailClaim("San Diego Gas & Electric Co", "pat.lee@sce.com");
  assert.equal(r.status, "pending");
  assert.equal(r.reason, "domain_mismatch");
  assert.equal(emailClaim("San Diego Gas & Electric Co", "pat@sdge.com").status, "verified");
  assert.equal(emailClaim("Los Angeles Department of Water and Power", "pat@ladwp.com").status, "verified");
});

test("document claims always start pending", () => {
  const r = decideVerification({ method: "document", ownerName: SCE, primaryEmail: verified("pat@sce.com") });
  assert.equal(r.status, "pending");
  assert.equal(r.reason, "document_needs_review");
});

test("owner names match exactly after normalization, not by substring", () => {
  assert.equal(normalizeOwnerName("San Diego Gas & Electric Co"), normalizeOwnerName("San Diego Gas and Electric"));
  assert.deepEqual(officialDomainsFor("SoCal Edison"), ["sce.com"]);
  assert.deepEqual(officialDomainsFor("SCE"), ["sce.com"]);
  assert.equal(ownerEntryFor("SunEdison LLC"), null);
  assert.equal(ownerEntryFor("SDGE Batteries"), null);
  assert.equal(ownerEntryFor("Edison"), null);
});

test("curated list: no free-mail domain, valid domains, unique aliases", () => {
  const seen = new Map<string, string>();
  for (const e of OWNER_DOMAINS) {
    assert.ok(e.domains.length > 0, e.owner);
    for (const d of e.domains) {
      assert.equal(FREE_MAIL_DOMAINS.has(d), false, d);
      assert.match(d, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, d);
    }
    for (const a of [e.owner, ...e.aliases]) {
      const k = normalizeOwnerName(a);
      const prev = seen.get(k);
      assert.ok(prev === undefined || prev === e.owner, `alias "${a}" used by ${prev} and ${e.owner}`);
      seen.set(k, e.owner);
    }
  }
});

test("utility and operator names in our public data resolve to the curated owners", () => {
  type FC = { features: { properties: Record<string, unknown> }[] };
  const names = new Set<string>();
  for (const [file, key] of [["public/layers/plants.geojson", "utility_name"], ["public/layers/substations.geojson", "operator"]] as const) {
    for (const f of readJson<FC>(file).features) if (typeof f.properties[key] === "string") names.add(f.properties[key] as string);
  }
  for (const n of ["Southern California Edison Co", "Southern California Edison", "San Diego Gas & Electric Co", "Los Angeles Department of Water & Power"]) {
    assert.ok(names.has(n), `expected "${n}" in public data`);
    assert.ok(ownerEntryFor(n), n);
  }
});

/* ---- input validation ---------------------------------------------------- */

test("asset refs: kind and id formats", () => {
  assert.deepEqual(parseAssetRef({ kind: "plant", id: "335" }), { ok: true, value: { kind: "plant", id: "335" } });
  assert.equal(parseAssetRef({ kind: "substation", id: "node/1742528740" }).ok, true);
  assert.equal(parseAssetRef({ kind: "substation", id: "way/12" }).ok, true);
  assert.equal(parseAssetRef({ kind: "line", id: "5941178" }).ok, true);
  for (const bad of [
    { kind: "plant", id: "0" },
    { kind: "plant", id: "12a" },
    { kind: "plant", id: 335 },
    { kind: "substation", id: "1742528740" },
    { kind: "substation", id: "node/../x" },
    { kind: "line", id: "way/1" },
    { kind: "tower", id: "1" },
    null,
  ]) {
    assert.equal(parseAssetRef(bad).ok, false, JSON.stringify(bad));
  }
});

test("claim body: method enum, note length, client owner_name and user_id ignored", () => {
  const good = parseClaimBody({
    asset: { kind: "plant", id: "335" },
    asset_name: "Haynes",
    owner_name: "Someone Else Inc",
    user_id: "user_attacker",
    method: "email_domain",
    note: "  Operated by a subsidiary  ",
  });
  assert.ok(good.ok);
  if (good.ok) {
    assert.equal(good.value.note, "Operated by a subsidiary");
    assert.equal(good.value.assetNameHint, "Haynes");
    assert.equal("owner_name" in good.value, false);
    assert.equal("user_id" in good.value, false);
  }
  assert.equal(parseClaimBody({ asset: { kind: "plant", id: "335" }, method: "magic" }).ok, false);
  assert.equal(parseClaimBody({ asset: { kind: "plant", id: "335" }, method: "document", note: "x".repeat(501) }).ok, false);
  assert.equal(parseClaimBody({ asset: { kind: "plant", id: "335" }, method: "document", note: 5 }).ok, false);
  assert.equal(parseClaimBody("nope").ok, false);
});

test("task body: uuid, obligation id, real date, status enum, lengths", () => {
  const base = { claim_id: "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b", obligation_id: "eia-923-annual", due: "2027-02-28", status: "filed" };
  assert.equal(parseTaskBody(base).ok, true);
  assert.equal(parseTaskBody({ ...base, claim_id: "1" }).ok, false);
  assert.equal(parseTaskBody({ ...base, obligation_id: "Bad Id!" }).ok, false);
  assert.equal(parseTaskBody({ ...base, due: "2027-02-30" }).ok, false);
  assert.equal(parseTaskBody({ ...base, due: "02/28/2027" }).ok, false);
  assert.equal(parseTaskBody({ ...base, status: "done" }).ok, false);
  assert.equal(parseTaskBody({ ...base, confirmation: "x".repeat(101) }).ok, false);
  assert.equal(isIsoDate("2028-02-29"), true);
  assert.equal(isIsoDate("2027-02-29"), false);
});

test("admin decision body and status filter", () => {
  assert.equal(parseDecisionBody({ decision: "verified" }).ok, true);
  assert.equal(parseDecisionBody({ decision: "rejected", reason: "Letter is unsigned." }).ok, true);
  assert.equal(parseDecisionBody({ decision: "pending" }).ok, false);
  assert.equal(parseDecisionBody({ decision: "rejected", reason: "x".repeat(501) }).ok, false);
  assert.deepEqual(parseStatusFilter("pending"), { ok: true, value: "pending" });
  assert.deepEqual(parseStatusFilter(null), { ok: true, value: null });
  assert.equal(parseStatusFilter("all").ok, false);
});

/* ---- evidence files ------------------------------------------------------ */

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);

test("evidence files: pdf, png, jpg, jpeg accepted when content matches", () => {
  assert.equal(validateEvidenceFile({ name: "letter.pdf", size: 2048, type: "application/pdf", head: PDF }).ok, true);
  assert.equal(validateEvidenceFile({ name: "scan.PNG", size: 2048, type: "image/png", head: PNG }).ok, true);
  assert.equal(validateEvidenceFile({ name: "photo.jpg", size: 2048, type: "image/jpeg", head: JPG }).ok, true);
  assert.equal(validateEvidenceFile({ name: "photo.jpeg", size: 2048, type: "", head: JPG }).ok, true);
});

test("evidence files: wrong type, mismatched content, too big, empty", () => {
  assert.equal(validateEvidenceFile({ name: "tool.exe", size: 2048, type: "application/octet-stream", head: EXE }).ok, false);
  assert.equal(validateEvidenceFile({ name: "fake.pdf", size: 2048, type: "application/pdf", head: EXE }).ok, false);
  assert.equal(validateEvidenceFile({ name: "image.png", size: 2048, type: "image/png", head: PDF }).ok, false);
  assert.equal(validateEvidenceFile({ name: "letter.pdf", size: 2048, type: "text/html", head: PDF }).ok, false);
  assert.equal(validateEvidenceFile({ name: "doc.svg", size: 2048, type: "image/svg+xml", head: PDF }).ok, false);
  assert.equal(validateEvidenceFile({ name: "big.pdf", size: 5 * 1024 * 1024 + 1, type: "application/pdf", head: PDF }).ok, false);
  assert.equal(validateEvidenceFile({ name: "limit.pdf", size: 5 * 1024 * 1024, type: "application/pdf", head: PDF }).ok, true);
  const big = validateEvidenceFile({ name: "big.pdf", size: 6 * 1024 * 1024, type: "application/pdf", head: PDF });
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.error, /5 MB/);
  assert.equal(validateEvidenceFile({ name: "empty.pdf", size: 0, type: "application/pdf", head: PDF }).ok, false);
});

test("evidence file names are made safe and paths sit in the user's folder", () => {
  assert.equal(safeFileName("../../etc/passwd.pdf"), "passwd.pdf");
  assert.equal(safeFileName("C:\\Users\\me\\Interconnection agreement (signed).PDF"), "Interconnection-agreement-signed.pdf");
  assert.equal(safeFileName(".pdf"), "pdf");
  assert.equal(
    evidencePath("user_2abc", "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b", "letter.pdf"),
    "user_2abc/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b/letter.pdf",
  );
});

/* ---- trusted email verification strategies -------------------------------- */

test("only email_code, email_link and from_oauth_google verifications are trusted", () => {
  assert.equal(isTrustedEmailVerification({ status: "verified", strategy: "email_code" }), true);
  assert.equal(isTrustedEmailVerification({ status: "verified", strategy: "email_link" }), true);
  assert.equal(isTrustedEmailVerification({ status: "verified", strategy: "from_oauth_google" }), true);
  assert.equal(isTrustedEmailVerification({ status: "verified", strategy: "from_oauth_microsoft" }), false);
  assert.equal(isTrustedEmailVerification({ status: "verified", strategy: "from_oauth_github" }), false);
  assert.equal(isTrustedEmailVerification({ status: "verified", strategy: null }), false);
  assert.equal(isTrustedEmailVerification({ status: "verified" }), false);
  assert.equal(isTrustedEmailVerification({ status: "unverified", strategy: "email_code" }), false);
  assert.equal(isTrustedEmailVerification(null), false);
  assert.equal(isTrustedEmailVerification(undefined), false);
});

test("an untrusted strategy on a matching work email stays pending", () => {
  const verifiedFlag = isTrustedEmailVerification({ status: "verified", strategy: "from_oauth_microsoft" });
  const r = emailClaim(SCE, "pat.lee@sce.com", verifiedFlag);
  assert.equal(r.status, "pending");
  assert.equal(r.reason, "email_not_verified");
});

/* ---- evidence limit and admin re-sniff ------------------------------------ */

test("evidence limit is 5 MB (under Netlify's ~6 MB request cap)", () => {
  assert.equal(LIMITS.fileBytes, 5 * 1024 * 1024);
});

test("re-sniff accepts PDF, PNG and JPEG signatures only", () => {
  assert.equal(sniffType(PDF), "application/pdf");
  assert.equal(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffType(new TextEncoder().encode("<html><script>")), null);
  assert.equal(sniffType(new TextEncoder().encode("%PDF")), null); // needs "%PDF-"
  assert.equal(sniffType(new Uint8Array([])), null);
});

/* ---- stored claim vs public data ------------------------------------------ */

test("stored claim that matches public data passes", () => {
  const r = checkClaimAgainstPublicData({ owner_name: SCE, asset_name: "Alamitos" }, { name: "Alamitos", owner: SCE });
  assert.equal(r.ok, true);
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.owner_name, SCE);
  assert.equal(r.asset_name, "Alamitos");
});

test("forged owner_name is flagged and replaced with the public-data owner", () => {
  const r = checkClaimAgainstPublicData({ owner_name: SCE, asset_name: "Alamitos" }, { name: "Alamitos", owner: "AES Alamitos LLC" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches, ["owner_name"]);
  assert.equal(r.owner_name, "AES Alamitos LLC");
});

test("forged owner_name on an asset with no public owner is flagged", () => {
  const r = checkClaimAgainstPublicData({ owner_name: SCE, asset_name: "Substation" }, { name: null, owner: "" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches, ["owner_name"]);
  assert.equal(r.owner_name, "");
  assert.equal(r.asset_name, "Substation"); // no public name: the stored display name stays
});

test("forged asset_name is flagged and replaced when public data has a name", () => {
  const r = checkClaimAgainstPublicData({ owner_name: SCE, asset_name: "Something Else" }, { name: "Alamitos", owner: SCE });
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches, ["asset_name"]);
  assert.equal(r.asset_name, "Alamitos");
});

test("asset missing from public data is flagged and keeps stored values", () => {
  const r = checkClaimAgainstPublicData({ owner_name: SCE, asset_name: "Ghost" }, null);
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches, ["not_in_public_data"]);
  assert.equal(r.owner_name, SCE);
  assert.equal(r.asset_name, "Ghost");
});
