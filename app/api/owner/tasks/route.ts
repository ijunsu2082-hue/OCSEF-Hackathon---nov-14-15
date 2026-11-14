import { dbErrorResponse, json, jsonError, ownerContext, TASK_COLUMNS, toTask, type OwnerContext } from "@/lib/owner/db";
import { isUuid, parseTaskBody } from "@/lib/owner/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The user's own claim must exist and be verified. RLS enforces the same rule. */
async function checkVerifiedClaim(ctx: OwnerContext, claimId: string): Promise<Response | null> {
  const { data, error } = await ctx.db
    .from("claims")
    .select("id,status")
    .eq("id", claimId)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (error) return dbErrorResponse(error);
  if (!data) return jsonError(404, "Claim not found.");
  if (data.status !== "verified") return jsonError(403, "This claim is not verified yet.");
  return null;
}

/** GET /api/owner/tasks?claim_id= -> { tasks } */
export async function GET(request: Request) {
  const gate = await ownerContext();
  if (!gate.ok) return gate.response;
  const claimId = new URL(request.url).searchParams.get("claim_id");
  if (!isUuid(claimId)) return jsonError(400, "claim_id must be a claim id.");
  const bad = await checkVerifiedClaim(gate.ctx, claimId.toLowerCase());
  if (bad) return bad;
  const { data, error } = await gate.ctx.db
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("claim_id", claimId.toLowerCase())
    .order("due", { ascending: true })
    .limit(500);
  if (error) return dbErrorResponse(error);
  return json({ tasks: (data ?? []).map((r) => toTask(r as Record<string, unknown>)) });
}

/** PUT /api/owner/tasks body { claim_id, obligation_id, due, status, confirmation?, note? } -> { task } */
export async function PUT(request: Request) {
  const gate = await ownerContext();
  if (!gate.ok) return gate.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Body must be valid JSON.");
  }
  const parsed = parseTaskBody(body);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const t = parsed.value;
  const bad = await checkVerifiedClaim(gate.ctx, t.claim_id);
  if (bad) return bad;
  // filed_at and updated_at are set by the database trigger.
  const { data, error } = await gate.ctx.db
    .from("tasks")
    .upsert(
      { claim_id: t.claim_id, obligation_id: t.obligation_id, due: t.due, status: t.status, confirmation: t.confirmation, note: t.note },
      { onConflict: "claim_id,obligation_id,due" },
    )
    .select(TASK_COLUMNS)
    .single();
  if (error) return dbErrorResponse(error);
  return json({ task: toTask(data as Record<string, unknown>) });
}
