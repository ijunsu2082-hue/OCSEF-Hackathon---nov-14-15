import { ownerContext, ownerServiceClient, json, jsonError } from "@/lib/owner/db";
import { buildOwnerPlan } from "@/lib/ownerPlan";
import { activeTrainingEpochs, contextFromScan, featureVector, rankWorkflowOptions, screenWorkflowOptions, RANKER_VERSION, SCREENING_VERSION, type WorkflowObservation } from "@/lib/workflowStore/ranking";
import { isRecord, parseArea, parseAreaKey, parseWorkspaceId, WORKFLOW_OPTION_IDS } from "@/lib/workflowStore/validation";
import { loadWorkflowArea, resolveWorkflowWorkspace } from "@/lib/workflowStore/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await ownerContext();
  if (!auth.ok) return auth.response;
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError(400, "invalid_json"); }
  if (!isRecord(body)) return jsonError(400, "invalid_request");
  const area = parseArea(body.area);
  if (!area) return jsonError(400, "invalid_area");
  if (body.workspaceId !== undefined && !parseWorkspaceId(body.workspaceId)) return jsonError(400, "invalid_workspace");
  const resolved = await resolveWorkflowWorkspace(auth.ctx, body.workspaceId as string | undefined, "viewer");
  if ("response" in resolved) return resolved.response;
  try {
    const result = await loadWorkflowArea(area);
    const areaKey = `${area.lat.toFixed(4)}:${area.lon.toFixed(4)}:${area.radius_mi}`;
    if (!parseAreaKey(areaKey)) return jsonError(400, "invalid_area");
    const context = contextFromScan(result);
    const knownCandidates = new Set(buildOwnerPlan(result, null, null).interventions.map((candidate) => candidate.id));
    const screening = screenWorkflowOptions(context);
    const eligible = screening.filter((gate) => gate.passed && knownCandidates.has(gate.optionId) && WORKFLOW_OPTION_IDS.includes(gate.optionId))
      .map((gate) => gate.optionId);
    if (!eligible.length) return json({ impressionId: null, orderedIds: [], rankerVersion: RANKER_VERSION,
      screeningVersion: SCREENING_VERSION, screening, message: "No options passed the mapped-inventory screening gates." });
    const { data: epochState, error: epochError } = await auth.ctx.db.rpc("workflow_get_rank_epoch", {
      p_workspace_id: resolved.workspaceId,
    }).maybeSingle();
    if (epochError || !epochState) {
      console.error("[workflow] rank epoch read failed", epochError?.code, epochError?.message);
      return jsonError(500, "ranking_unavailable");
    }
    const epochRow = epochState as { current_epoch: number; training_epochs: number[] };
    const epoch = Number(epochRow.current_epoch);
    const trainingEpochs = activeTrainingEpochs(epoch, Array.isArray(epochRow.training_epochs) ? epochRow.training_epochs : []);
    const { data: priorImpressions, error: impressionReadError } = await auth.ctx.db.from("workflow_impressions")
      .select("id").eq("workspace_id", resolved.workspaceId)
      .in("epoch", trainingEpochs).order("created_at", { ascending: false }).limit(2000);
    if (impressionReadError) {
      console.error("[workflow] impression history read failed", impressionReadError.code, impressionReadError.message);
      return jsonError(500, "ranking_unavailable");
    }
    const impressionIds = (priorImpressions ?? []).map((row) => row.id as string);
    const { data: rows, error: readError } = impressionIds.length
      ? await auth.ctx.db.from("workflow_feedback").select("option_id,reward,context_features")
        .eq("workspace_id", resolved.workspaceId).in("option_id", eligible).in("impression_id", impressionIds)
        .order("created_at", { ascending: false }).limit(5000)
      : { data: [], error: null };
    if (readError) {
      console.error("[workflow] feedback read failed", readError.code, readError.message);
      return jsonError(500, "ranking_unavailable");
    }
    const observations: WorkflowObservation[] = (rows ?? []).flatMap((row) => {
      const f = row.context_features as { features?: unknown } | null;
      return typeof row.option_id === "string" && typeof row.reward === "number" && Array.isArray(f?.features) && f.features.every((n) => typeof n === "number" && Number.isFinite(n))
        ? [{ optionId: row.option_id, reward: row.reward, features: f.features as number[] }]
        : [];
    });
    const orderedIds = rankWorkflowOptions(context, observations).map((x) => x.id).filter((id) => eligible.includes(id));
    const service = ownerServiceClient();
    if (!service) return jsonError(503, "not_configured");
    const { data: impression, error: insertError } = await service.from("workflow_impressions").insert({
      workspace_id: resolved.workspaceId, user_id: auth.ctx.userId, area_key: areaKey,
      candidate_ids: eligible, ordered_ids: orderedIds, epoch, ranker_version: RANKER_VERSION,
      screening_version: SCREENING_VERSION, screening_gates: screening,
      context_features: { features: featureVector(context), context },
    }).select("id").single();
    if (insertError || !impression) {
      console.error("[workflow] impression insert failed", insertError?.code, insertError?.message);
      return jsonError(500, "ranking_unavailable");
    }
    return json({ impressionId: impression.id, orderedIds, rankerVersion: RANKER_VERSION,
      screeningVersion: SCREENING_VERSION, screening, message: "Options are ordered by mapped-inventory screening passes." });
  } catch (error) {
    console.error("[workflow] ranking failed", error instanceof Error ? error.message : "unknown");
    return jsonError(503, "ranking_unavailable");
  }
}
