import { currentUser } from "@clerk/nextjs/server";
import type { AssetKind, Claim } from "@/lib/owner/types";
import {
  CLAIM_COLUMNS,
  dbErrorResponse,
  findAssetRecord,
  json,
  jsonError,
  markVerifiedByEmailDomain,
  ownerContext,
  toClaim,
} from "@/lib/owner/db";
import {
  decideVerification,
  isTrustedEmailVerification,
  parseClaimBody,
  type PrimaryEmail,
  type VerifyResult,
} from "@/lib/owner/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KIND_WORD: Record<AssetKind, string> = { plant: "Power plant", substation: "Substation", line: "Power line" };

/** GET /api/owner/claims -> { claims } for the signed-in user. */
export async function GET() {
  const gate = await ownerContext();
  if (!gate.ok) return gate.response;
  const { db, userId } = gate.ctx;
  const { data, error } = await db
    .from("claims")
    .select(CLAIM_COLUMNS)
    .eq("user_id", userId) // admins can read all claims; this list is only the user's own
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return dbErrorResponse(error);
  return json({ claims: (data ?? []).map((r) => toClaim(r as Record<string, unknown>)) });
}

/**
 * POST /api/owner/claims  body { asset, asset_name, owner_name, method, note? } -> { claim, verification }
 * owner_name and asset details come from public data (EIA-860 / OpenStreetMap), not the body.
 * The claimant can add a note (for example a subsidiary name).
 */
export async function POST(request: Request) {
  const gate = await ownerContext();
  if (!gate.ok) return gate.response;
  const { db, userId } = gate.ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Body must be valid JSON.");
  }
  const parsed = parseClaimBody(body);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const input = parsed.value;

  let record;
  try {
    record = await findAssetRecord(input.asset);
  } catch (e) {
    console.error("[owner] asset data unavailable", e);
    return jsonError(503, "Asset data is not available right now. Try again.");
  }
  if (!record) return jsonError(404, "This asset is not in our public data.");

  if (input.method === "email_domain" && !record.owner) {
    return jsonError(400, "Public data does not name an owner for this asset, so it can be verified only with a document.");
  }

  const assetName = record.name ?? input.assetNameHint ?? KIND_WORD[input.asset.kind];

  const { data, error } = await db
    .from("claims")
    .insert({
      // user_id, status and decided_* are set by the database from the session token.
      asset_kind: input.asset.kind,
      asset_id: input.asset.id,
      asset_name: assetName,
      owner_name: record.owner,
      method: input.method,
      note: input.note,
    })
    .select(CLAIM_COLUMNS)
    .single();
  if (error) return dbErrorResponse(error);
  let claim: Claim = toClaim(data as Record<string, unknown>);

  let primary: PrimaryEmail | null = null;
  if (input.method === "email_domain") {
    const user = await currentUser();
    const p = user?.primaryEmailAddress ?? null;
    // Only email_code, email_link or from_oauth_google count (see TRUSTED_EMAIL_STRATEGIES).
    primary = p ? { address: p.emailAddress, verified: isTrustedEmailVerification(p.verification) } : null;
  }
  let verification: VerifyResult = decideVerification({ method: input.method, ownerName: record.owner, primaryEmail: primary });

  if (verification.status === "verified" && verification.matchedDomain) {
    const updated = await markVerifiedByEmailDomain(claim.id, userId, verification.matchedDomain);
    if (updated) {
      claim = updated;
    } else {
      verification = {
        status: "pending",
        reason: verification.reason,
        message: "Your work email matches, but automatic approval is turned off on this server. An admin will review this claim.",
      };
    }
  }

  return json({ claim, verification: { status: claim.status, reason: verification.reason, message: verification.message } }, 201);
}
