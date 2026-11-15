import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKFLOW_OPTION_IDS, feedbackReward, parseArea, parseAreaKey, parseFeedback,
  parseWorkflowState, parseWorkspaceId,
} from "../lib/workflowStore/validation";
import { activeTrainingEpochs, featureVector, rankWorkflowOptions, screenWorkflowOptions, type StoredWorkflowContext } from "../lib/workflowStore/ranking";

const context: StoredWorkflowContext = {
  plant_count: 4, line_miles: 12, high_voltage_line_miles: 3, substation_count: 2,
  renewable_mw: 80, storage_mw: 5, operator_asset_match: null, network_study: null,
  site_cost: null, missing: { operator_asset_match: true, network_study: true, site_cost: true },
};

test("workflow validators enforce bounded area, workspace and draft state inputs", () => {
  assert.deepEqual(parseArea({ lat: 34, lon: -118, radius_mi: 25 }), { lat: 34, lon: -118, radius_mi: 25 });
  assert.equal(parseArea({ lat: 91, lon: 0, radius_mi: 1 }), null);
  assert.equal(parseAreaKey("34.0000:-118.0000:25"), "34.0000:-118.0000:25");
  assert.equal(parseAreaKey("NaN:-118:25"), null);
  assert.equal(parseWorkspaceId("team:west"), "team:west");
  assert.equal(parseWorkspaceId("bad\nworkspace"), null);
  assert.deepEqual(parseWorkflowState({ confirmed: true }), { confirmed: true });
  assert.equal(parseWorkflowState([]), null);
});

test("feedback accepts only known choices and uses explicit reward weights", () => {
  assert.deepEqual(parseFeedback({
    impressionId: "00000000-0000-4000-8000-000000000001",
    optionId: WORKFLOW_OPTION_IDS[0], event: "approve",
  }), {
    impressionId: "00000000-0000-4000-8000-000000000001",
    optionId: WORKFLOW_OPTION_IDS[0], event: "approve",
  });
  assert.equal(parseFeedback({ impressionId: "x", optionId: "invented", event: "approve" }), null);
  assert.deepEqual([feedbackReward("approve"), feedbackReward("reject"), feedbackReward("export"), feedbackReward("capex")], [1, -1, 0.25, 0]);
});

test("LinUCB learns from stored context and breaks fresh ties canonically", () => {
  const base = rankWorkflowOptions(context, []);
  assert.deepEqual(base.map((x) => x.id), [...WORKFLOW_OPTION_IDS]);
  const learned = rankWorkflowOptions(context, [{ optionId: WORKFLOW_OPTION_IDS[2], features: featureVector(context), reward: 1 }]);
  assert.equal(learned[0].id, WORKFLOW_OPTION_IDS[2]);
  assert.ok(learned[0].score > learned[1].score);
});

test("server screening requires mapped inventory evidence and labels it as screening only", () => {
  assert.equal(screenWorkflowOptions({ ...context, plant_count: 0, line_miles: 0, high_voltage_line_miles: 0, substation_count: 0, renewable_mw: 0, storage_mw: 0 }).some((gate) => gate.passed), false);
  const passes = screenWorkflowOptions(context).filter((gate) => gate.passed);
  assert.ok(passes.length > 0);
  assert.ok(passes.every((gate) => gate.caveat === "mapped_screening_only"));
  assert.ok(passes.every((gate) => gate.evidence.length > 0));
});

test("rank reset isolates old feedback; rollback explicitly restores epoch lineage", () => {
  assert.deepEqual(activeTrainingEpochs(4, []), [4]);
  assert.deepEqual(activeTrainingEpochs(7, [2, 3, 2]), [2, 3, 7]);
  assert.deepEqual(activeTrainingEpochs(1, [0, -1, 1.5]), [1]);
});
