import { ownerContext, json, jsonError, dbErrorResponse } from "@/lib/owner/db";
import { parseAreaKey, parseWorkflowState, isRecord } from "@/lib/workflowStore/validation";
import { resolveWorkflowWorkspace } from "@/lib/workflowStore/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await ownerContext();
  if (!auth.ok) return auth.response;
  const params = new URL(request.url).searchParams;
  const areaKey = parseAreaKey(params.get("areaKey"));
  if (!areaKey) return jsonError(400, "invalid_area_key");
  const resolved = await resolveWorkflowWorkspace(auth.ctx, params.has("workspaceId") ? params.get("workspaceId") ?? "" : undefined, "viewer");
  if ("response" in resolved) return resolved.response;
  const { data, error } = await auth.ctx.db.from("workflow_drafts")
    .select("revision,state").eq("workspace_id", resolved.workspaceId).eq("area_key", areaKey).maybeSingle();
  if (error) return dbErrorResponse(error);
  return json({ draft: data ?? null, workspaceId: resolved.workspaceId });
}

export async function PUT(request: Request) {
  const auth = await ownerContext();
  if (!auth.ok) return auth.response;
  const params = new URL(request.url).searchParams;
  const areaKey = parseAreaKey(params.get("areaKey"));
  if (!areaKey) return jsonError(400, "invalid_area_key");
  const resolved = await resolveWorkflowWorkspace(auth.ctx, params.has("workspaceId") ? params.get("workspaceId") ?? "" : undefined, "editor");
  if ("response" in resolved) return resolved.response;
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError(400, "invalid_json"); }
  if (!isRecord(body) || !Number.isSafeInteger(body.revision) || (body.revision as number) < 0) return jsonError(400, "invalid_revision");
  const state = parseWorkflowState(body.state);
  if (!state) return jsonError(400, "invalid_state");
  const { data, error } = await auth.ctx.db.rpc("workflow_save_draft", {
    p_workspace_id: resolved.workspaceId, p_area_key: areaKey,
    p_expected_revision: body.revision, p_state: state,
  }).maybeSingle();
  if (error?.code === "23505") return jsonError(409, "draft_conflict");
  if (error?.code === "22023") return jsonError(400, "invalid_state");
  if (error) return dbErrorResponse(error);
  const saved = data as { revision: number; state: unknown } | null;
  if (!saved) return jsonError(409, "draft_conflict");
  return json({ draft: { revision: saved.revision, state: saved.state }, workspaceId: resolved.workspaceId });
}
