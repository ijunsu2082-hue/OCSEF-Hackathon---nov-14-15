import { json, jsonError, ownerContext } from "@/lib/owner/db";
import { resolveWorkflowWorkspace } from "@/lib/workflowStore/server";
import { calibrationStatus, listWorkspaceObservations } from "@/lib/workflowTelemetry/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/owner/workflows/telemetry?workspaceId=...&limit=...
 * Provider readings are environmental context. They are not proof of asset calibration.
 */
export async function GET(request: Request) {
  const auth = await ownerContext();
  if (!auth.ok) return auth.response;
  const params = new URL(request.url).searchParams;
  const resolved = await resolveWorkflowWorkspace(auth.ctx, params.has("workspaceId") ? params.get("workspaceId") ?? "" : undefined, "viewer");
  if ("response" in resolved) return resolved.response;
  const parsedLimit = Number(params.get("limit") ?? 100);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) return jsonError(400, "invalid_limit");
  try {
    const [observations, calibration] = await Promise.all([
      listWorkspaceObservations(resolved.workspaceId, parsedLimit),
      calibrationStatus(resolved.workspaceId),
    ]);
    return json({ workspaceId: resolved.workspaceId, observations, calibration, providerDataIsCalibrationEvidence: false });
  } catch (error) {
    console.error("[workflow-telemetry] read failed", error instanceof Error ? error.message : "unknown error");
    return jsonError(503, "telemetry_unavailable");
  }
}
