import { ownerContext, json, jsonError } from "@/lib/owner/db";
import { parseFeedback, parseWorkspaceId, isRecord } from "@/lib/workflowStore/validation";
import { resolveWorkflowWorkspace } from "@/lib/workflowStore/server";

export async function POST(request: Request) {
  const auth = await ownerContext();
  if (!auth.ok) return auth.response;
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError(400, "invalid_json"); }
  if (!isRecord(body)) return jsonError(400, "invalid_request");
  const feedback = parseFeedback(body);
  if (!feedback) return jsonError(400, "invalid_feedback");
  if (body.workspaceId !== undefined && !parseWorkspaceId(body.workspaceId)) return jsonError(400, "invalid_workspace");
  const resolved = await resolveWorkflowWorkspace(auth.ctx, body.workspaceId as string | undefined, "viewer");
  if ("response" in resolved) return resolved.response;

  const { data: impression, error: lookupError } = await auth.ctx.db.from("workflow_impressions")
    .select("candidate_ids").eq("id", feedback.impressionId).eq("workspace_id", resolved.workspaceId).maybeSingle();
  if (lookupError) return jsonError(500, "feedback_unavailable");
  if (!impression) return jsonError(404, "impression_not_found");
  const allowed = Array.isArray(impression.candidate_ids) && impression.candidate_ids.includes(feedback.optionId);
  if (!allowed && !(feedback.optionId === "packet" && feedback.event === "export")) return jsonError(400, "option_not_in_impression");

  const { data: result, error } = await auth.ctx.db.rpc("workflow_submit_feedback", {
    p_workspace_id: resolved.workspaceId, p_impression_id: feedback.impressionId,
    p_option_id: feedback.optionId, p_event: feedback.event, p_value: feedback.value ?? null,
  });
  if (error) {
    if (error.code === "42501") return jsonError(403, "workspace_forbidden");
    if (error.code === "22023" || error.code === "23503") return jsonError(400, "invalid_feedback");
    console.error("[workflow] feedback insert failed", error.code, error.message);
    return jsonError(500, "feedback_unavailable");
  }
  return json({ accepted: true, duplicate: result === "duplicate", result });
}
