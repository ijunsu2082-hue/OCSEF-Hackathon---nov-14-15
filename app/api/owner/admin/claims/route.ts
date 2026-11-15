import { clerkClient } from "@clerk/nextjs/server";
import type { Claim } from "@/lib/owner/types";
import { CLAIM_COLUMNS, dbErrorResponse, findAssetRecord, isAdmin, json, jsonError, ownerContext, toClaim } from "@/lib/owner/db";
import { checkClaimAgainstPublicData, isAssetKind, parseStatusFilter, type PublicDataMismatch } from "@/lib/owner/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A claim as shown to reviewers. owner_name and asset_name are replaced with the public-data
 * values (a user can insert a claim through the Supabase REST API with any values), and
 * public_data_mismatch lists what the stored claim got wrong. claimant_email is the
 * claimant's primary email from Clerk, or null if Clerk could not be read.
 */
type AdminClaim = Claim & { claimant_email: string | null; public_data_mismatch: PublicDataMismatch[] };

/** Clerk user id -> primary email. Clerk accepts up to 100 user ids per request. */
async function primaryEmails(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (userIds.length === 0) return out;
  try {
    const client = await clerkClient();
    for (let i = 0; i < userIds.length; i += 100) {
      const chunk = userIds.slice(i, i + 100);
      const { data } = await client.users.getUserList({ userId: chunk, limit: chunk.length });
      for (const u of data) {
        const e = u.primaryEmailAddress?.emailAddress;
        if (e) out.set(u.id, e);
      }
    }
  } catch (e) {
    console.error("[owner] claimant email lookup failed", e instanceof Error ? e.message : e);
  }
  return out;
}

/** GET /api/owner/admin/claims?status=pending -> { claims } (admins only; RLS admin policy). */
export async function GET(request: Request) {
  const gate = await ownerContext();
  if (!gate.ok) return gate.response;
  if (!(await isAdmin(gate.ctx))) return jsonError(403, "Only admins can review claims.");
  const status = parseStatusFilter(new URL(request.url).searchParams.get("status"));
  if (!status.ok) return jsonError(400, status.error);
  let q = gate.ctx.db.from("claims").select(CLAIM_COLUMNS);
  if (status.value) q = q.eq("status", status.value);
  const { data, error } = await q.order("created_at", { ascending: status.value === "pending" }).limit(200);
  if (error) return dbErrorResponse(error);
  const rows = (data ?? []).map((r) => toClaim(r as Record<string, unknown>));

  const emails = await primaryEmails([...new Set(rows.map((c) => c.user_id).filter(Boolean))]);

  let claims: AdminClaim[];
  try {
    claims = await Promise.all(
      rows.map(async (c) => {
        const record = isAssetKind(c.asset_kind) ? await findAssetRecord({ kind: c.asset_kind, id: c.asset_id }) : null;
        const check = checkClaimAgainstPublicData(c, record);
        return {
          ...c,
          owner_name: check.owner_name,
          asset_name: check.asset_name,
          public_data_mismatch: check.mismatches,
          claimant_email: emails.get(c.user_id) ?? null,
        };
      }),
    );
  } catch (e) {
    console.error("[owner] asset data unavailable", e);
    return jsonError(503, "Asset data is not available right now. Try again.");
  }
  return json({ claims });
}
