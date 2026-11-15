import { ownerContext, json, jsonError, dbErrorResponse } from "@/lib/owner/db";
import { isRecord, parseAreaKey, parseWorkspaceId } from "@/lib/workflowStore/validation";
import { resolveWorkflowWorkspace } from "@/lib/workflowStore/server";

export async function POST(request: Request) {
  const auth = await ownerContext();
  if (!auth.ok) return auth.response;
  const params = new URL(request.url).searchParams;
  const areaKey = parseAreaKey(params.get("areaKey"));
  if (!areaKey) return jsonError(400, "invalid_area_key");
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError(400, "invalid_json"); }
  if (!isRecord(body) || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) return jsonError(400, "invalid_revision");
  if (params.has("workspaceId") && !parseWorkspaceId(params.get("workspaceId"))) return jsonError(400, "invalid_workspace");
  const resolved = await resolveWorkflowWorkspace(auth.ctx, params.get("workspaceId") ?? undefined, "editor");
  if ("response" in resolved) return resolved.response;
  const { data, error } = await auth.ctx.db.rpc("workflow_save_draft", {
    p_workspace_id: resolved.workspaceId, p_area_key: areaKey,
    p_expected_revision: body.expectedRevision, p_state: {},
  }).maybeSingle();
  if (error?.code === "23505") return jsonError(409, "draft_conflict");
  if (error?.code === "22023") return jsonError(400, "invalid_state");
  if (error) return dbErrorResponse(error);
  const saved = data as { revision: number; state: unknown } | null;
  if (!saved) return jsonError(409, "draft_conflict");
  return json({ draft: { revision: saved.revision, state: saved.state }, workspaceId: resolved.workspaceId });
}
