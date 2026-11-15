export interface FrozenPrediction {
  target: string;
  predictedFor: string;
  frozenAt: string;
  value: number;
  unit: string;
}
export interface OperatorMeasurement {
  target: string;
  observedAt: string;
  value: number;
  unit: string;
  qualificationStatus: "pending" | "qualified" | "rejected";
}
export interface ReplayMetrics {
  sampleCount: number;
  bias: number | null;
  meanAbsoluteError: number | null;
  rootMeanSquaredError: number | null;
}
export interface ReplayResult {
  status: "insufficient-data" | "ready-for-independent-review";
  commissioningAt: string;
  minimumPairsPerPeriod: number;
  preCommissioning: ReplayMetrics;
  postCommissioning: ReplayMetrics;
  matchedPairs: number;
  excludedMeasurements: number;
  unmatchedQualifiedMeasurements: number;
  toleranceMs: number;
  note: string;
}

/** Replay an immutable forecast only against qualified, same-target/unit measurements. */
export function replayFrozenPredictions(
  predictions: FrozenPrediction[],
  measurements: OperatorMeasurement[],
  commissioningAt: string,
  minimumPairsPerPeriod = 3,
  toleranceMs = 5 * 60_000,
): ReplayResult {
  const commissioningMs = Date.parse(commissioningAt);
  if (!Number.isFinite(commissioningMs) || !Number.isInteger(minimumPairsPerPeriod) || minimumPairsPerPeriod < 1 || !Number.isFinite(toleranceMs) || toleranceMs < 0) {
    throw new Error("Invalid replay parameters");
  }
  const used = new Set<number>();
  const pairs: { period: "pre" | "post"; error: number }[] = [];
  let excluded = 0, unmatched = 0;
  for (const measurement of [...measurements].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))) {
    if (measurement.qualificationStatus !== "qualified") { excluded++; continue; }
    const measuredAt = Date.parse(measurement.observedAt);
    if (!Number.isFinite(measuredAt) || !Number.isFinite(measurement.value)) { excluded++; continue; }
    let best = -1, bestDistance = Infinity;
    predictions.forEach((prediction, index) => {
      if (used.has(index) || prediction.target !== measurement.target || prediction.unit !== measurement.unit) return;
      const frozenAt = Date.parse(prediction.frozenAt), predictedFor = Date.parse(prediction.predictedFor);
      const distance = Math.abs(predictedFor - measuredAt);
      if (!Number.isFinite(frozenAt) || frozenAt > measuredAt || distance > toleranceMs || distance >= bestDistance) return;
      best = index; bestDistance = distance;
    });
    if (best < 0) { unmatched++; continue; }
    used.add(best);
    const error = predictions[best].value - measurement.value;
    pairs.push({ period: measuredAt < commissioningMs ? "pre" : "post", error });
  }
  const metrics = (period: "pre" | "post"): ReplayMetrics => {
    const errors = pairs.filter((p) => p.period === period).map((p) => p.error);
    return errors.length ? {
      sampleCount: errors.length,
      bias: errors.reduce((a, b) => a + b, 0) / errors.length,
      meanAbsoluteError: errors.reduce((a, b) => a + Math.abs(b), 0) / errors.length,
      rootMeanSquaredError: Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length),
    } : { sampleCount: 0, bias: null, meanAbsoluteError: null, rootMeanSquaredError: null };
  };
  const preCommissioning = metrics("pre"), postCommissioning = metrics("post");
  const status = preCommissioning.sampleCount >= minimumPairsPerPeriod && postCommissioning.sampleCount >= minimumPairsPerPeriod
    ? "ready-for-independent-review" : "insufficient-data";
  return {
    status, commissioningAt: new Date(commissioningMs).toISOString(), minimumPairsPerPeriod,
    preCommissioning, postCommissioning, matchedPairs: pairs.length,
    excludedMeasurements: excluded, unmatchedQualifiedMeasurements: unmatched, toleranceMs,
    note: "Comparison is descriptive. It does not verify model fitness or asset calibration; an independent engineer must review the frozen inputs, instrument records, operating conditions, and acceptance criteria.",
  };
}
