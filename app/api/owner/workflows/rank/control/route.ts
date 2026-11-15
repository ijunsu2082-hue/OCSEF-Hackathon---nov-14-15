import { ownerContext, json, jsonError, dbErrorResponse } from "@/lib/owner/db";
import { isRecord, parseWorkspaceId } from "@/lib/workflowStore/validation";
import { resolveWorkflowWorkspace } from "@/lib/workflowStore/server";

export async function POST(request: Request) {
  const auth = await ownerContext();
  if (!auth.ok) return auth.response;
  const params = new URL(request.url).searchParams;
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError(400, "invalid_json"); }
  if (!isRecord(body) || (body.action !== "reset" && body.action !== "rollback")) return jsonError(400, "invalid_rank_control");
  if (body.action === "rollback" && (!Number.isSafeInteger(body.targetEpoch) || (body.targetEpoch as number) < 1)) return jsonError(400, "invalid_target_epoch");
  if (body.action === "reset" && body.targetEpoch !== undefined) return jsonError(400, "invalid_target_epoch");
  if (params.has("workspaceId") && !parseWorkspaceId(params.get("workspaceId"))) return jsonError(400, "invalid_workspace");
  const resolved = await resolveWorkflowWorkspace(auth.ctx, params.get("workspaceId") ?? undefined, "owner");
  if ("response" in resolved) return resolved.response;
  const { data, error } = await auth.ctx.db.rpc("workflow_control_rank", {
    p_workspace_id: resolved.workspaceId,
    p_action: body.action, p_target_epoch: body.action === "rollback" ? body.targetEpoch : null,
  }).maybeSingle();
  if (error?.code === "P0002") return jsonError(404, "rank_epoch_not_found");
  if (error?.code === "22023") return jsonError(400, "invalid_rank_control");
  if (error?.code === "42501") return jsonError(403, "workspace_owner_required");
  if (error) return dbErrorResponse(error);
  if (!data) return jsonError(500, "rank_control_unavailable");
  const state = data as { current_epoch: number; training_epochs: number[] };
  return json({ action: body.action, workspaceId: resolved.workspaceId,
    currentEpoch: state.current_epoch, trainingEpochs: state.training_epochs ?? [] });
}
