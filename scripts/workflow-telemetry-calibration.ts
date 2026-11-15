import {
  closeTelemetryPools, freezePredictions, persistReplay, persistReplayReview,
  qualifyOperatorMeasurement, recordOperatorMeasurement,
} from "../lib/workflowTelemetry/store";

async function main() {
  const [action, raw] = process.argv.slice(2);
  const actorId = process.env.WORKFLOW_TELEMETRY_ACTOR_ID;
  if (!action || !raw || !actorId) {
  console.error("Usage: npm run workflow-telemetry:calibration -- <freeze|measurement|qualify|replay|review> '<JSON>' (WORKFLOW_TELEMETRY_ACTOR_ID required)");
  process.exitCode = 2;
  } else {
  try {
    const input = JSON.parse(raw) as Record<string, unknown>;
    const required = (key: string) => {
      const value = input[key];
      if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
      return value.trim();
    };
    let result: unknown;
    switch (action) {
      case "freeze":
        if (!Array.isArray(input.predictions)) throw new Error("predictions must be an array");
        result = await freezePredictions({ workspaceId: required("workspaceId"), assetKey: required("assetKey"), modelVersion: required("modelVersion"), inputs: input.inputs, predictions: input.predictions as Parameters<typeof freezePredictions>[0]["predictions"], actorId });
        break;
      case "measurement":
        result = await recordOperatorMeasurement({ workspaceId: required("workspaceId"), assetKey: required("assetKey"), target: required("target"), observedAt: required("observedAt"), value: Number(input.value), unit: required("unit"), instrumentId: required("instrumentId"), evidenceRef: required("evidenceRef"), actorId });
        break;
      case "qualify":
        if (input.decision !== "qualified" && input.decision !== "rejected") throw new Error("decision must be qualified or rejected");
        result = await qualifyOperatorMeasurement({ workspaceId: required("workspaceId"), measurementId: required("measurementId"), reviewerId: actorId, note: required("note"), decision: input.decision });
        break;
      case "replay":
        result = await persistReplay({ workspaceId: required("workspaceId"), assetKey: required("assetKey"), freezeId: required("freezeId"), commissioningAt: required("commissioningAt"), actorId, minimumPairsPerPeriod: input.minimumPairsPerPeriod == null ? undefined : Number(input.minimumPairsPerPeriod) });
        break;
      case "review":
        if (input.decision !== "accepted" && input.decision !== "rejected") throw new Error("decision must be accepted or rejected");
        result = await persistReplayReview({ workspaceId: required("workspaceId"), replayId: required("replayId"), reviewerId: actorId, reviewerName: required("reviewerName"), reviewerCredential: required("reviewerCredential"), decision: input.decision, evidenceRef: required("evidenceRef"), notes: required("notes") });
        break;
      default: throw new Error("Unknown action. Use freeze, measurement, qualify, replay, or review.");
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Telemetry calibration action failed");
    process.exitCode = 1;
  } finally {
    await closeTelemetryPools();
  }
  }
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : "Telemetry calibration action failed"); process.exitCode = 1; });
