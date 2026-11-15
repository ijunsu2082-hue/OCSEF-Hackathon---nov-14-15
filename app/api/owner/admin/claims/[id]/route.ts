import { CLAIM_COLUMNS, dbErrorResponse, findAssetRecord, isAdmin, json, jsonError, ownerContext, toClaim } from "@/lib/owner/db";
import { checkClaimAgainstPublicData, isAssetKind, isUuid, parseDecisionBody } from "@/lib/owner/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/owner/admin/claims/:id  body { decision: "verified" | "rejected", reason? } -> { claim }
 * Uses the admin's own session token; RLS and the claims_guard trigger allow only
 * pending -> verified/rejected, never on the admin's own claim, and stamp decided_by/decided_at.
 * Before approving, the stored owner_name / asset_name are re-checked against public data,
 * because a user can insert a claim through the Supabase REST API and skip that lookup.
 * A claim that does not match is 409 for "verified"; it can still be rejected.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await ownerContext();
  if (!gate.ok) return gate.response;
  if (!(await isAdmin(gate.ctx))) return jsonError(403, "Only admins can review claims.");
  const { id } = await params;
  if (!isUuid(id)) return jsonError(400, "Claim id is not valid.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Body must be valid JSON.");
  }
  const parsed = parseDecisionBody(body);
  if (!parsed.ok) return jsonError(400, parsed.error);

  const { data: current, error: readErr } = await gate.ctx.db
    .from("claims")
    .select("id,user_id,status,asset_kind,asset_id,asset_name,owner_name")
    .eq("id", id.toLowerCase())
    .maybeSingle();
  if (readErr) return dbErrorResponse(readErr);
  if (!current) return jsonError(404, "Claim not found.");
  if (current.user_id === gate.ctx.userId) return jsonError(403, "You cannot decide your own claim.");
  if (current.status !== "pending") return jsonError(409, "This claim has already been decided.");

  if (parsed.value.decision === "verified") {
    const kind = current.asset_kind;
    let record = null;
    if (isAssetKind(kind)) {
      try {
        record = await findAssetRecord({ kind, id: String(current.asset_id) });
      } catch (e) {
        console.error("[owner] asset data unavailable", e);
        return jsonError(503, "Asset data is not available right now. Try again.");
      }
    }
    const check = checkClaimAgainstPublicData(
      { owner_name: String(current.owner_name ?? ""), asset_name: String(current.asset_name ?? "") },
      record,
    );
    if (!check.ok) {
      return jsonError(
        409,
        check.mismatches.includes("not_in_public_data")
          ? "This asset is not in our public data, so the claim cannot be approved. Reject it instead."
          : "The owner or asset name on this claim does not match public data, so it cannot be approved. Reject it instead.",
      );
    }
  }

  const { data, error } = await gate.ctx.db
    .from("claims")
    .update({ status: parsed.value.decision, reason: parsed.value.reason })
    .eq("id", id.toLowerCase())
    .eq("status", "pending")
    .select(CLAIM_COLUMNS)
    .maybeSingle();
  if (error) return dbErrorResponse(error);
  if (!data) return jsonError(409, "This claim has already been decided.");
  return json({ claim: toClaim(data as Record<string, unknown>) });
}
