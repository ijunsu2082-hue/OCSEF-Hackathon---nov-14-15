import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { replayFrozenPredictions } from "./replay";
import type { ProviderObservation, TelemetryTarget } from "./types";

const pools: Partial<Record<"api" | "worker" | "operator" | "review", Pool>> = {};
export function telemetryPool(role: "api" | "worker" | "operator" | "review" = "api"): Pool {
  const variable = { api: "WORKFLOW_TELEMETRY_API_DATABASE_URL", worker: "WORKFLOW_TELEMETRY_WORKER_DATABASE_URL", operator: "WORKFLOW_TELEMETRY_OPERATOR_DATABASE_URL", review: "WORKFLOW_TELEMETRY_REVIEW_DATABASE_URL" }[role];
  const connectionString = process.env[variable];
  if (!connectionString) throw new Error(`${variable} is not configured`);
  pools[role] ??= new Pool({ connectionString, ssl: process.env.WORKFLOW_TELEMETRY_SSL === "disable" ? false : { rejectUnauthorized: true }, max: role === "api" ? 4 : 2, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 });
  return pools[role]!;
}

export async function loadTargets(): Promise<TelemetryTarget[]> {
  const { rows } = await telemetryPool("worker").query("SELECT target_key, workspace_id, latitude, longitude, caiso_node FROM workflow_telemetry_targets WHERE enabled = true ORDER BY target_key");
  return rows.map((r) => ({ key: r.target_key, workspaceId: r.workspace_id, latitude: Number(r.latitude), longitude: Number(r.longitude), caisoNodeId: r.caiso_node, caisoNodeName: r.caiso_node }));
}

export async function saveObservations(workspaceId: string, observations: ProviderObservation[]): Promise<number> {
  if (!observations.length) return 0;
  const client = await telemetryPool("worker").connect();
  try {
    await client.query("BEGIN");
    let inserted = 0;
    for (const o of observations) {
      const result = await client.query(
        `INSERT INTO workflow_telemetry_observations
         (workspace_id, provider, series, target, observed_at, fetched_at, value, unit, source_revision, source_url, qualifiers)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT (workspace_id, provider, series, target, observed_at, source_revision)
         DO UPDATE SET fetched_at = GREATEST(workflow_telemetry_observations.fetched_at, EXCLUDED.fetched_at), qualifiers = EXCLUDED.qualifiers
         RETURNING (xmax = 0) AS inserted`,
        [workspaceId, o.provider, o.series, o.target, o.observedAt, o.fetchedAt, o.value, o.unit, o.sourceRevision ?? "unversioned", o.sourceUrl, JSON.stringify(o.qualifiers)],
      );
      if (result.rows[0]?.inserted) inserted++;
    }
    await client.query("COMMIT");
    return inserted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listWorkspaceObservations(workspaceId: string, limit: number) {
  const { rows } = await telemetryPool("api").query(
    `SELECT provider, series, target, observed_at, fetched_at, value, unit, source_revision, source_url, qualifiers
     FROM workflow_telemetry_observations WHERE workspace_id = $1
     ORDER BY observed_at DESC, fetched_at DESC LIMIT $2`, [workspaceId, limit]);
  return rows.map((r) => ({ provider: r.provider, series: r.series, target: r.target, observedAt: new Date(r.observed_at).toISOString(), fetchedAt: new Date(r.fetched_at).toISOString(), value: Number(r.value), unit: r.unit, sourceRevision: r.source_revision, sourceUrl: r.source_url, qualifiers: r.qualifiers }));
}

export async function calibrationStatus(workspaceId: string) {
  const { rows } = await telemetryPool("api").query(
    `SELECT c.status, c.verified_at, c.reviewer, c.commissioning_reference, rr.reviewed_at,
       COALESCE((r.result->>'matchedPairs')::integer, 0) AS matched_pairs
     FROM workflow_telemetry_calibration c
     LEFT JOIN workflow_telemetry_replay_reviews rr ON rr.review_id=c.accepted_review_id
     LEFT JOIN workflow_telemetry_replay_runs r ON r.replay_id=rr.replay_id
     WHERE c.workspace_id = $1`, [workspaceId]);
  const row = rows[0];
  if (!row) return { status: "pending-commissioning" as const, verifiedAt: null, reviewer: null, evidenceCount: 0, reason: "No operator commissioning record is present." };
  return { status: row.status, verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null, reviewer: row.reviewer, reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null, evidenceCount: Number(row.matched_pairs ?? 0), reason: row.status === "verified" ? "Frozen prediction replay has an independent review record." : "Commissioning and independent review are incomplete." };
}

export interface FrozenPredictionInput { target: string; predictedFor: string; value: number; unit: string }
export async function freezePredictions(input: { workspaceId: string; assetKey: string; modelVersion: string; inputs: unknown; predictions: FrozenPredictionInput[]; actorId: string }) {
  if (!input.assetKey.trim() || !input.modelVersion.trim() || input.inputs === undefined || input.predictions.length < 1 || input.predictions.length > 10_000) throw new Error("invalid_freeze");
  const freezeId = randomUUID();
  const client = await telemetryPool("operator").connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO workflow_telemetry_prediction_freezes (freeze_id, workspace_id, asset_key, model_version, input_snapshot, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6)", [freezeId, input.workspaceId, input.assetKey, input.modelVersion, JSON.stringify(input.inputs), input.actorId]);
    for (const p of input.predictions) {
      if (!p.target.trim() || !Number.isFinite(Date.parse(p.predictedFor)) || !Number.isFinite(p.value) || !p.unit.trim()) throw new Error("invalid_prediction");
      await client.query("INSERT INTO workflow_telemetry_frozen_predictions (freeze_id, workspace_id, target, predicted_for, value, unit) VALUES ($1,$2,$3,$4,$5,$6)", [freezeId, input.workspaceId, p.target, p.predictedFor, p.value, p.unit]);
    }
    await client.query("COMMIT");
    return { freezeId, frozenAt: new Date().toISOString(), predictionCount: input.predictions.length };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function recordOperatorMeasurement(input: { workspaceId: string; assetKey: string; target: string; observedAt: string; value: number; unit: string; instrumentId: string; evidenceRef: string; actorId: string }) {
  if (!input.assetKey.trim() || !input.target.trim() || !Number.isFinite(Date.parse(input.observedAt)) || !Number.isFinite(input.value) || !input.unit.trim() || !input.instrumentId.trim() || !input.evidenceRef.trim()) throw new Error("invalid_measurement");
  const { rows } = await telemetryPool("operator").query(
    `INSERT INTO workflow_telemetry_measurements (workspace_id, asset_key, target, observed_at, value, unit, instrument_id, evidence_ref, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING measurement_id, qualification_status, created_at`,
    [input.workspaceId, input.assetKey, input.target, input.observedAt, input.value, input.unit, input.instrumentId, input.evidenceRef, input.actorId]);
  return rows[0];
}

export async function qualifyOperatorMeasurement(input: { workspaceId: string; measurementId: string; reviewerId: string; note: string; decision: "qualified" | "rejected" }) {
  if (!input.note.trim()) throw new Error("qualification_note_required");
  const client = await telemetryPool("review").connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT created_by FROM workflow_telemetry_measurements WHERE workspace_id=$1 AND measurement_id=$2 FOR UPDATE", [input.workspaceId, input.measurementId]);
    if (!rows[0]) throw new Error("measurement_not_found");
    if (rows[0].created_by === input.reviewerId) throw new Error("independent_qualification_required");
    await client.query("UPDATE workflow_telemetry_measurements SET qualification_status=$5, qualified_by=$3, qualified_at=now(), qualification_note=$4 WHERE workspace_id=$1 AND measurement_id=$2", [input.workspaceId, input.measurementId, input.reviewerId, input.note, input.decision]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function persistReplay(input: { workspaceId: string; assetKey: string; freezeId: string; commissioningAt: string; actorId: string; minimumPairsPerPeriod?: number }) {
  const pool = telemetryPool("review");
  const { rows: freezes } = await pool.query("SELECT freeze_id, model_version, frozen_at FROM workflow_telemetry_prediction_freezes WHERE workspace_id=$1 AND asset_key=$2 AND freeze_id=$3", [input.workspaceId, input.assetKey, input.freezeId]);
  if (!freezes[0]) throw new Error("freeze_not_found");
  const [{ rows: predicted }, { rows: measured }] = await Promise.all([
    pool.query("SELECT target, predicted_for, value, unit FROM workflow_telemetry_frozen_predictions WHERE workspace_id=$1 AND freeze_id=$2 ORDER BY predicted_for", [input.workspaceId, input.freezeId]),
    pool.query("SELECT target, observed_at, value, unit, qualification_status FROM workflow_telemetry_measurements WHERE workspace_id=$1 AND asset_key=$2 ORDER BY observed_at", [input.workspaceId, input.assetKey]),
  ]);
  const result = replayFrozenPredictions(predicted.map((r) => ({ ...r, predictedFor: new Date(r.predicted_for).toISOString(), frozenAt: new Date(freezes[0].frozen_at).toISOString(), value: Number(r.value) })), measured.map((r) => ({ target: r.target, observedAt: new Date(r.observed_at).toISOString(), value: Number(r.value), unit: r.unit, qualificationStatus: r.qualification_status })), input.commissioningAt, input.minimumPairsPerPeriod ?? 3);
  const { rows } = await pool.query(
    `INSERT INTO workflow_telemetry_replay_runs (workspace_id, asset_key, freeze_id, commissioning_at, minimum_pairs_per_period, result, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING replay_id, created_at`,
    [input.workspaceId, input.assetKey, input.freezeId, input.commissioningAt, result.minimumPairsPerPeriod, JSON.stringify(result), result.status, input.actorId]);
  return { replayId: rows[0].replay_id, createdAt: new Date(rows[0].created_at).toISOString(), result };
}

export async function persistReplayReview(input: { workspaceId: string; replayId: string; reviewerId: string; reviewerName: string; reviewerCredential: string; decision: "accepted" | "rejected"; evidenceRef: string; notes: string }) {
  if (!input.reviewerName.trim() || !input.reviewerCredential.trim() || !input.evidenceRef.trim() || !input.notes.trim()) throw new Error("review_record_incomplete");
  const client = await telemetryPool("review").connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT r.created_by, r.status, r.commissioning_at, r.freeze_id, f.created_by AS freeze_author
      FROM workflow_telemetry_replay_runs r JOIN workflow_telemetry_prediction_freezes f ON f.freeze_id=r.freeze_id
      WHERE r.workspace_id=$1 AND r.replay_id=$2 FOR UPDATE OF r`, [input.workspaceId, input.replayId]);
    if (!rows[0]) throw new Error("replay_not_found");
    if (rows[0].created_by === input.reviewerId || rows[0].freeze_author === input.reviewerId) throw new Error("independent_reviewer_required");
    if (input.decision === "accepted" && rows[0].status !== "ready-for-independent-review") throw new Error("replay_not_ready");
    const { rows: authors } = await client.query(
      `SELECT DISTINCT created_by FROM workflow_telemetry_measurements WHERE workspace_id=$1 AND asset_key=(SELECT asset_key FROM workflow_telemetry_replay_runs WHERE replay_id=$2)`,
      [input.workspaceId, input.replayId]);
    if (authors.some((r) => r.created_by === input.reviewerId)) throw new Error("reviewer_must_be_independent_of_measurement_author");
    const { rows: reviewRows } = await client.query(
      `INSERT INTO workflow_telemetry_replay_reviews (replay_id, workspace_id, reviewer_id, reviewer_name, reviewer_credential, decision, evidence_ref, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING review_id`,
      [input.replayId, input.workspaceId, input.reviewerId, input.reviewerName, input.reviewerCredential, input.decision, input.evidenceRef, input.notes]);
    if (input.decision === "accepted") {
      await client.query(
        `INSERT INTO workflow_telemetry_calibration (workspace_id, status, accepted_review_id, verified_at, reviewer, commissioning_reference)
         VALUES ($1,'verified',$2,now(),$3,$4)
         ON CONFLICT (workspace_id) DO UPDATE SET status='verified', accepted_review_id=EXCLUDED.accepted_review_id,
          verified_at=EXCLUDED.verified_at, reviewer=EXCLUDED.reviewer, commissioning_reference=EXCLUDED.commissioning_reference, updated_at=now()`,
        [input.workspaceId, reviewRows[0].review_id, input.reviewerName, input.evidenceRef]);
    } else {
      await client.query("INSERT INTO workflow_telemetry_calibration (workspace_id, status) VALUES ($1,'review-required') ON CONFLICT (workspace_id) DO UPDATE SET status='review-required', updated_at=now()", [input.workspaceId]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function closeTelemetryPools() {
  await Promise.all(Object.values(pools).map((pool) => pool?.end()));
}
