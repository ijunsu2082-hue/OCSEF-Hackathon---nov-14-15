"use client";

import { useEffect, useState } from "react";
import { Caption } from "./ui";

type Observation = {
  provider: string;
  series: string;
  target: string;
  observedAt: string;
  fetchedAt: string;
  value: number;
  unit: string;
  sourceRevision: string | null;
  sourceUrl: string;
};
type Payload = {
  observations: Observation[];
  calibration: { status: string; verifiedAt: string | null; reviewer: string | null; reviewedAt?: string | null; evidenceCount: number; reason: string };
  providerDataIsCalibrationEvidence: false;
};

/** Workspace-wide source observations; deliberately separate from scan-area live weather. */
export function WorkflowTelemetryPanel({ workspaceId }: { workspaceId: string | null }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "unavailable">("loading");

  useEffect(() => {
    let active = true;
    setState("loading");
    setPayload(null);
    const query = new URLSearchParams({ limit: "24" });
    if (workspaceId) query.set("workspaceId", workspaceId);
    void fetch(`/api/owner/workflows/telemetry?${query}`)
      .then(async (response) => {
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          if (active) setState("denied");
          return null;
        }
        if (!response.ok) throw new Error("telemetry unavailable");
        return response.json() as Promise<Payload>;
      })
      .then((data) => {
        if (!active || data == null) return;
        setPayload(data);
        setState("ready");
      })
      .catch(() => { if (active) setState("unavailable"); });
    return () => { active = false; };
  }, [workspaceId]);

  const fmtTime = (value: string) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown time";
  };

  return <section className="mt-4 rounded-lg border border-[#e6e9ee] bg-white p-4" aria-labelledby="workflow-telemetry-title">
    <h3 id="workflow-telemetry-title" className="text-[14px] font-semibold">Workspace telemetry</h3>
    <p className="mt-1 text-[13px] text-[#556070]">Configured NOAA weather and CAISO market observations for this workspace. These are separate from the current scan’s area measurements.</p>
    {state === "loading" && <p role="status" className="mt-3 text-[13px] text-[#6b7583]">Loading workspace telemetry…</p>}
    {state === "denied" && <p role="status" className="mt-3 text-[13px] text-[#9b1c1c]">You do not have access to telemetry for the selected workspace. Choose a workspace where you have membership.</p>}
    {state === "unavailable" && <p role="status" className="mt-3 text-[13px] text-[#9b1c1c]">Telemetry service is unavailable. No local copy is shown.</p>}
    {state === "ready" && payload && <>
      <div className="mt-3 rounded-md bg-[#f6f8fa] p-3">
        <p className="text-[13px] font-semibold">Calibration: {payload.calibration.status.replaceAll("-", " ")}</p>
        <p className="mt-1 text-[13px] text-[#556070]">{payload.calibration.reason}</p>
        {payload.calibration.verifiedAt && <p className="mt-1 text-[12px] text-[#6b7583]">Reviewed {fmtTime(payload.calibration.reviewedAt ?? payload.calibration.verifiedAt)}{payload.calibration.reviewer ? ` · ${payload.calibration.reviewer}` : ""} · {payload.calibration.evidenceCount} matched measurements in replay</p>}
      </div>
      <Caption className="mt-2">Successful NOAA or CAISO collection verifies provider parsing only. It is not instrument commissioning or asset calibration evidence.</Caption>
      {payload.observations.length === 0
        ? <p className="mt-3 text-[13px] text-[#6b7583]">No stored observations yet.</p>
        : <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[34rem] text-left text-[12px]"><thead><tr className="border-b text-[#6b7583]"><th className="py-2 pr-3">Source / target</th><th className="py-2 pr-3">Reading</th><th className="py-2 pr-3">Observed</th><th className="py-2">Fetched</th></tr></thead><tbody>{payload.observations.slice(0, 12).map((o, i) => <tr key={`${o.provider}:${o.target}:${o.series}:${o.observedAt}:${o.sourceRevision ?? i}`} className="border-b border-[#eef0f3]"><td className="py-2 pr-3"><a className="text-[#0369a1] underline" href={o.sourceUrl} target="_blank" rel="noreferrer">{o.provider}</a><span className="block text-[#6b7583]">{o.target} · {o.series}</span></td><td className="py-2 pr-3 tabular-nums">{Number.isFinite(o.value) ? o.value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : "—"} {o.unit}</td><td className="py-2 pr-3">{fmtTime(o.observedAt)}</td><td className="py-2">{fmtTime(o.fetchedAt)}</td></tr>)}</tbody></table></div>}
    </>}
  </section>;
}
