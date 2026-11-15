import { randomUUID } from "node:crypto";
import { collectCaisoNodeLmp, collectNoaa } from "../lib/workflowTelemetry/providers";
import { acquireLease, releaseLease } from "../lib/workflowTelemetry/redisLease";
import { closeTelemetryPools, loadTargets, saveObservations } from "../lib/workflowTelemetry/store";

const POLL_MS = 5 * 60_000;
const LEASE_MS = 4 * 60_000;
let stopping = false;
let wakeSleep: (() => void) | null = null;

async function collectTarget(target: Awaited<ReturnType<typeof loadTargets>>[number]) {
  const key = `workflow-telemetry:${target.workspaceId}:${target.key}`;
  const token = randomUUID();
  if (!(await acquireLease(key, token, LEASE_MS))) return;
  try {
    const settled = await Promise.allSettled([
      collectNoaa(target.latitude, target.longitude),
      collectCaisoNodeLmp(target.caisoNodeName),
    ]);
    const observations = settled.flatMap((item) => item.status === "fulfilled" ? item.value : []);
    const errors = settled.flatMap((item, i) => item.status === "rejected" ? [`${i === 0 ? "NOAA" : "CAISO"}: ${String(item.reason)}`] : []);
    if (observations.length) await saveObservations(target.workspaceId, observations);
    console.info(JSON.stringify({ event: "telemetry.collect", target: target.key, observationCount: observations.length, errors }));
    if (observations.length === 0 && errors.length === 2) throw new Error(errors.join("; "));
  } finally {
    await releaseLease(key, token);
  }
}

async function cycle() {
  let targets: Awaited<ReturnType<typeof loadTargets>>;
  try { targets = await loadTargets(); }
  catch (error) {
    console.error(JSON.stringify({ event: "telemetry.target_load_error", message: String(error) }));
    return;
  }
  for (const target of targets) {
    if (stopping) break;
    try { await collectTarget(target); }
    catch (error) { console.error(JSON.stringify({ event: "telemetry.error", target: target.key, message: String(error) })); }
  }
}

async function main() {
  console.info(JSON.stringify({ event: "telemetry.worker.started", pollMs: POLL_MS }));
  while (!stopping) {
    await cycle();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { wakeSleep = null; resolve(); }, POLL_MS);
      wakeSleep = () => { clearTimeout(timer); wakeSleep = null; resolve(); };
    });
  }
  await closeTelemetryPools();
}
const stop = () => { stopping = true; wakeSleep?.(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
void main().catch((error) => { console.error("Telemetry worker stopped:", error); process.exitCode = 1; });
