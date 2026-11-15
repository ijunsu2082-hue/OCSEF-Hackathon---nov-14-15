import test from "node:test";
import assert from "node:assert/strict";
import { replayFrozenPredictions } from "../lib/workflowTelemetry/replay";

test("replay matches only predictions frozen before qualified pre/post measurements", () => {
  const result = replayFrozenPredictions(
    [
      { target: "line-1", predictedFor: "2026-01-01T10:00:00Z", frozenAt: "2026-01-01T09:00:00Z", value: 105, unit: "MW" },
      { target: "line-1", predictedFor: "2026-02-01T10:00:00Z", frozenAt: "2026-02-01T09:00:00Z", value: 110, unit: "MW" },
      { target: "line-1", predictedFor: "2026-02-01T10:01:00Z", frozenAt: "2026-02-01T10:05:00Z", value: 999, unit: "MW" },
    ],
    [
      { target: "line-1", observedAt: "2026-01-01T10:02:00Z", value: 100, unit: "MW", qualificationStatus: "qualified" },
      { target: "line-1", observedAt: "2026-02-01T10:00:00Z", value: 100, unit: "MW", qualificationStatus: "qualified" },
      { target: "line-1", observedAt: "2026-02-01T10:05:00Z", value: 100, unit: "MW", qualificationStatus: "pending" },
      { target: "line-2", observedAt: "2026-02-01T10:00:00Z", value: 1, unit: "MW", qualificationStatus: "qualified" },
    ],
    "2026-02-01T00:00:00Z", 1,
  );
  assert.equal(result.status, "ready-for-independent-review");
  assert.equal(result.preCommissioning.sampleCount, 1);
  assert.equal(result.preCommissioning.bias, 5);
  assert.equal(result.postCommissioning.sampleCount, 1);
  assert.equal(result.postCommissioning.meanAbsoluteError, 10);
  assert.equal(result.excludedMeasurements, 1);
  assert.equal(result.unmatchedQualifiedMeasurements, 1);
  assert.match(result.note, /independent engineer/);
});

test("replay stays blocked when either measurement period lacks enough qualifying pairs", () => {
  const result = replayFrozenPredictions([], [], "2026-02-01T00:00:00Z");
  assert.equal(result.status, "insufficient-data");
  assert.equal(result.preCommissioning.bias, null);
  assert.equal(result.postCommissioning.meanAbsoluteError, null);
});
