import "server-only";
import { jsonError, type OwnerContext } from "@/lib/owner/db";
import { loadGridData } from "@/lib/scan/data";
import { scanArea } from "@/lib/scan/scan";
import type { ScanResult } from "@/lib/scan/types";
import { parseArea, parseWorkspaceId, type AreaInput } from "./validation";

export type WorkflowRole = "viewer" | "editor" | "owner";
const ROLE_RANK: Record<WorkflowRole, number> = { viewer: 0, editor: 1, owner: 2 };

export async function requireWorkflowMembership(
  ctx: OwnerContext,
  workspaceId: string,
  minimumRole: WorkflowRole = "viewer",
): Promise<{ ok: true; role: WorkflowRole } | { ok: false; response: Response }> {
  const id = parseWorkspaceId(workspaceId);
  if (!id) return { ok: false, response: jsonError(400, "invalid_workspace") };
  const { data, error } = await ctx.db.from("workflow_workspace_members")
    .select("role").eq("workspace_id", id).eq("user_id", ctx.userId).maybeSingle();
  if (error) {
    console.error("[workflow] membership check failed", error.code, error.message);
    return { ok: false, response: jsonError(500, "database_error") };
  }
  const role = data?.role as WorkflowRole | undefined;
  if (!role || !(role in ROLE_RANK)) return { ok: false, response: jsonError(404, "workspace_not_found") };
  if (ROLE_RANK[role] < ROLE_RANK[minimumRole]) return { ok: false, response: jsonError(403, "workspace_forbidden") };
  return { ok: true, role };
}

export async function resolveWorkflowWorkspace(
  ctx: OwnerContext,
  requestedId?: string,
  minimumRole: WorkflowRole = "viewer",
): Promise<{ workspaceId: string } | { response: Response }> {
  if (requestedId !== undefined) {
    const id = parseWorkspaceId(requestedId);
    if (!id) return { response: jsonError(400, "invalid_workspace") };
    const access = await requireWorkflowMembership(ctx, id, minimumRole);
    return access.ok ? { workspaceId: id } : { response: access.response };
  }
  const { data, error } = await ctx.db.rpc("workflow_personal_workspace");
  if (error || typeof data !== "string") {
    console.error("[workflow] personal workspace resolution failed", error?.code, error?.message);
    return { response: jsonError(500, "workspace_unavailable") };
  }
  return { workspaceId: data };
}

export async function loadWorkflowArea(area: AreaInput): Promise<ScanResult> {
  const valid = parseArea(area);
  if (!valid) throw new Error("invalid_workflow_area");
  const data = await loadGridData();
  return scanArea(data, { lat: valid.lat, lon: valid.lon, radius_mi: valid.radius_mi });
}
