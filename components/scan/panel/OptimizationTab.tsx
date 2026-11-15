"use client";

import { useEffect, useMemo, useState } from "react";
import type { DailyRating, LineRatingNow, ScanResult } from "@/lib/scan";
import { buildOwnerPlan, getOwnerPlanFixture, OWNER_PLAN_FIXTURES } from "@/lib/ownerPlan";
import type { OwnerPlanFixtureId } from "@/lib/ownerPlan";
import type { OwnerCandidate, OwnerPlan } from "@/lib/ownerPlan";
import { composeWorkflow } from "@/lib/ownerPlan/compose";
import { fmtNum, fmtPct, fmtRatio, isNum } from "./format";
import { Caption, Section } from "./ui";
import { WorkflowTelemetryPanel } from "./WorkflowTelemetryPanel";

type Objective = "transfer" | "resilience" | "emissions" | "cost";
type WorkflowItem = { owner: string; due: string; evidence: string; notes: string };
type PlanState = {
  objective: Objective; items: Record<string, WorkflowItem>; confirmed: boolean;
  evidenceFingerprints?: Record<string, string>; reviewRequired?: string[];
  selectedOptionId?: string; selectedFundingId?: string | null; selectedAuthorizationIds?: string[];
};
type Candidate = { id: string; title: string; risk: string[]; opportunity: string[]; prerequisites: string[]; next: string; evidence: string[]; tasks: OwnerCandidate["tasks"] };
const OBJECTIVES: Record<Objective, string> = {
  transfer: "Increase transfer capability", resilience: "Improve reliability and resilience",
  emissions: "Reduce operating emissions", cost: "Minimize lifecycle cost",
};
const EMPTY: PlanState = { objective: "transfer", items: {}, confirmed: false };
const box = "rounded-lg border border-[#e6e9ee] bg-white p-4";
const input = "h-9 min-w-0 rounded-md border border-[#d8dee6] bg-white px-2 text-[13px] text-[#1d2733] focus-visible:outline-2 focus-visible:outline-[#0ea5e9]";

function itemFor(state: PlanState, id: string): WorkflowItem { return state.items[id] ?? { owner: "", due: "", evidence: "", notes: "" }; }
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function evidenceFingerprints(plan: OwnerPlan): Record<string, string> {
  const out: Record<string, string> = {};
  for (const candidate of [...plan.interventions, ...plan.funding, ...plan.authorizations]) {
    out[candidate.id] = fingerprint({ title: candidate.title, summary: candidate.summary, tradeoff: candidate.tradeoff, evidence: candidate.evidence, rules: candidate.rules.map((rule) => ({ id: rule.id, required: rule.required })) });
    for (const task of candidate.tasks) out[task.id] = fingerprint({ title: task.title, dependsOn: task.dependsOn, inputs: task.inputs, output: task.output, evidence: task.evidence, recovery: task.recovery });
  }
  for (const stage of plan.lifecycle) for (const task of stage.tasks) out[task.id] = fingerprint({ stage: stage.id, title: task.title, dependsOn: task.dependsOn, inputs: task.inputs, output: task.output, evidence: task.evidence, recovery: task.recovery });
  for (const fixture of OWNER_PLAN_FIXTURES) for (const task of fixture.lifecycle) out[task.id] = fingerprint({ phase: task.phase, title: task.title, owner: task.owner, prerequisites: task.prerequisites, dependsOn: task.dependsOn, deliverable: task.deliverable, evidence: task.evidence, recovery: task.recovery });
  return out;
}
function reconcilePlan(value: unknown, current: Record<string, string>): PlanState {
  const raw = value && typeof value === "object" ? { ...EMPTY, ...(value as Partial<PlanState>) } : EMPTY;
  const previous = raw.evidenceFingerprints ?? {};
  const assigned = Object.keys(raw.items ?? {}).filter((id) => current[id]);
  const changed = Object.keys(previous).length
    ? assigned.filter((id) => previous[id] !== current[id])
    : raw.confirmed ? ["baseline-missing"] : [];
  return { ...raw, evidenceFingerprints: current, reviewRequired: changed, ...(changed.length ? { confirmed: false } : {}) };
}
function TaskAssignment({ id, state, change, disabled }: { id: string; state: PlanState; change: (id: string, key: keyof WorkflowItem, value: string) => void; disabled: boolean }) {
  const item = itemFor(state, id);
  return <div className="mt-2 grid gap-2 rounded-md border border-[#e6e9ee] p-2 sm:grid-cols-2"><label className="grid gap-1 text-[11px] font-medium">Task owner<input className={input} value={item.owner} placeholder="Name or team" disabled={disabled} onChange={(e) => change(id, "owner", e.target.value)} /></label><label className="grid gap-1 text-[11px] font-medium">Task deadline<input className={input} type="date" value={item.due} disabled={disabled} onChange={(e) => change(id, "due", e.target.value)} /></label>{item.owner || item.due ? <p className="sm:col-span-2 text-[11px] text-[#6b7583]">{item.owner ? `Owner: ${item.owner}` : "Waiting on: task owner"}{item.due ? ` · Due ${item.due}` : " · Waiting on: deadline"}</p> : <p className="sm:col-span-2 text-[11px] text-[#6b7583]">Waiting on: task owner and deadline</p>}</div>;
}
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
function icsDate(date: string) { return date.replaceAll("-", "") + "T090000"; }

export function OptimizationTab({ result, live, daily }: { result: ScanResult; live: LineRatingNow | null; daily: DailyRating[] | null }) {
  const t = result.totals;
  const ownerPlan = useMemo(() => buildOwnerPlan(result, live, daily), [result, live, daily]);
  const CANDIDATES: Candidate[] = ownerPlan.interventions.map((candidate) => ({
    id: candidate.id, title: candidate.title, opportunity: [candidate.summary], risk: [candidate.tradeoff],
    prerequisites: candidate.rules.map((r) => r.description), evidence: candidate.evidence, tasks: candidate.tasks,
    next: candidate.tasks[0]?.title ?? "Confirm prerequisites with the responsible owner.",
  }));
  const areaKey = `${result.area.lat.toFixed(4)}:${result.area.lon.toFixed(4)}:${result.area.radius_mi}`;
  const [plan, setPlan] = useState<PlanState>(EMPTY);
  const [revision, setRevision] = useState(0);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [serverState, setServerState] = useState<"loading" | "connected" | "local" | "blocked">("loading");
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState("");
  const [stale, setStale] = useState(false);
  const [ranking, setRanking] = useState<string[]>([]);
  const [impressionId, setImpressionId] = useState<string | null>(null);
  const [explanations, setExplanations] = useState<Record<string, { text: string; sourceIds: string[] }>>({});
  const [reasonStatus, setReasonStatus] = useState<"idle" | "available" | "unavailable">("idle");
  const [busy, setBusy] = useState(false);
  const [selectedOptionId, setSelectedOptionId] = useState(CANDIDATES[0]?.id ?? "");
  const selectedWorkflow = useMemo(() => composeWorkflow(ownerPlan, {
    interventionId: selectedOptionId,
    fundingId: plan.selectedFundingId ?? null,
    authorizationIds: plan.selectedAuthorizationIds ?? [],
  }), [ownerPlan, selectedOptionId, plan.selectedFundingId, plan.selectedAuthorizationIds]);
  const composedTasks = useMemo(() => new Map(selectedWorkflow.tasks.map((task) => [task.id, task])), [selectedWorkflow]);
  const composedOrderIndex = useMemo(() => new Map(selectedWorkflow.orderedTaskIds.map((id, index) => [id, index])), [selectedWorkflow]);
  const [fixtureId, setFixtureId] = useState<OwnerPlanFixtureId>(OWNER_PLAN_FIXTURES[0].id);
  const selectedFixture = useMemo(() => getOwnerPlanFixture(fixtureId), [fixtureId]);
  const currentFingerprints = useMemo(() => evidenceFingerprints(ownerPlan), [ownerPlan]);
  const dayRatios = useMemo(() => (daily ?? []).filter((d) => isNum(d.worst_A) && isNum(d.static_A) && d.static_A > 0).map((d) => d.worst_A / d.static_A).sort((a, b) => a - b), [daily]);

  const load = async () => {
    setBusy(true); setHydrated(false); setServerState("loading"); setMessage(""); setStale(false);
    try {
      const q = new URLSearchParams({ areaKey }); if (workspaceId) q.set("workspaceId", workspaceId);
      const response = await fetch(`/api/owner/workflows?${q}`);
      if (response.status === 401 || response.status === 403) { setServerState("blocked"); setPlan(EMPTY); setWorkspaceId(null); setMessage("Sign in with an authorized owner account to use this workspace. Local drafts are not loaded for this account."); return; }
      if (!response.ok) throw new Error(`Workflow service unavailable (${response.status})`);
      const body = await response.json();
      setWorkspaceId(body.workspaceId ?? null); setRevision(body.draft?.revision ?? 0);
      const restored = body.draft?.state && typeof body.draft.state === "object" ? reconcilePlan(body.draft.state, currentFingerprints) : { ...EMPTY, evidenceFingerprints: currentFingerprints, reviewRequired: [] };
      setPlan(restored);
      if (restored.selectedOptionId && CANDIDATES.some((candidate) => candidate.id === restored.selectedOptionId)) setSelectedOptionId(restored.selectedOptionId);
      setServerState("connected");
    } catch {
      const raw = localStorage.getItem(`optimization:${areaKey}`);
      if (raw) { try { const stored = JSON.parse(raw); const restored = reconcilePlan(stored.state, currentFingerprints); setPlan(restored); if (restored.selectedOptionId && CANDIDATES.some((candidate) => candidate.id === restored.selectedOptionId)) setSelectedOptionId(restored.selectedOptionId); setRevision(stored.revision ?? 0); } catch { setPlan({ ...EMPTY, evidenceFingerprints: currentFingerprints, reviewRequired: [] }); } }
      else setPlan({ ...EMPTY, evidenceFingerprints: currentFingerprints, reviewRequired: [] });
      setServerState("local"); setMessage("Server unavailable. This draft is saved in this browser only; no shared assignments or learning are active.");
    } finally { setBusy(false); setHydrated(true); }
  };
  useEffect(() => { void load(); // areaKey intentionally scopes the workflow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaKey]);
  useEffect(() => {
    if (!hydrated || !plan.evidenceFingerprints) return;
    const changed = Object.keys(plan.items).filter((id) => currentFingerprints[id] && plan.evidenceFingerprints?.[id] !== currentFingerprints[id]);
    if (!changed.length) return;
    setPlan((previous) => ({ ...previous, evidenceFingerprints: currentFingerprints, reviewRequired: [...new Set([...(previous.reviewRequired ?? []), ...changed])], confirmed: false }));
  }, [hydrated, currentFingerprints, plan.items, plan.evidenceFingerprints]);

  const change = (id: string, key: keyof WorkflowItem, value: string) => setPlan((p) => ({ ...p, items: { ...p.items, [id]: { ...itemFor(p, id), [key]: value } } }));
  const selectIntervention = (id: string) => { setSelectedOptionId(id); setPlan((previous) => ({ ...previous, selectedOptionId: id })); };
  const selectFunding = (id: string) => setPlan((previous) => ({ ...previous, selectedFundingId: id || null }));
  const toggleAuthorization = (id: string, checked: boolean) => setPlan((previous) => {
    const next = new Set(previous.selectedAuthorizationIds ?? []);
    if (checked) next.add(id); else next.delete(id);
    return { ...previous, selectedAuthorizationIds: [...next] };
  });
  const save = async () => {
    setBusy(true); setMessage("");
    if (serverState === "blocked" || !hydrated) { setBusy(false); return; }
    const stateToSave = { ...plan, selectedOptionId, selectedFundingId: plan.selectedFundingId ?? null, selectedAuthorizationIds: plan.selectedAuthorizationIds ?? [], evidenceFingerprints: currentFingerprints };
    if (serverState === "local") {
      const next = revision + 1; localStorage.setItem(`optimization:${areaKey}`, JSON.stringify({ revision: next, state: stateToSave })); setRevision(next); setMessage("Saved locally in this browser."); setBusy(false); return;
    }
    try {
      const response = await fetch("/api/owner/workflows?" + new URLSearchParams({ areaKey, ...(workspaceId ? { workspaceId } : {}) }), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision, state: stateToSave }) });
      if (response.status === 409) { setStale(true); setMessage("A newer draft exists. Reload it before saving your changes."); return; }
      if (response.status === 401 || response.status === 403) { setServerState("blocked"); setMessage("Owner access is required to save this workspace. No local copy was written."); return; }
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      const body = await response.json(); setRevision(body.draft.revision); setMessage("Draft saved to workspace.");
    } catch { setServerState("local"); localStorage.setItem(`optimization:${areaKey}`, JSON.stringify({ revision: revision + 1, state: stateToSave })); setRevision((r) => r + 1); setMessage("Server unavailable. Saved locally in this browser; no shared assignments or learning are active."); }
    finally { setBusy(false); }
  };
  const rank = async () => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/owner/workflows/rank", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(workspaceId ? { workspaceId } : {}), area: result.area }) });
      if (!response.ok) throw new Error("Ranking service unavailable");
      const body = await response.json(); const allowed = new Set(CANDIDATES.map((c) => c.id));
      const orderedIds = (body.orderedIds ?? []).filter((id: string) => allowed.has(id));
      setRanking(orderedIds); setImpressionId(body.impressionId ?? null); setServerState("connected");
      setMessage(orderedIds.length
        ? `Server order applied to ${orderedIds.length} options with mapped scan evidence. This screen does not establish feasibility; remaining options keep their existing order.`
        : body.message ?? "No options passed the mapped scan evidence checks. Existing order is unchanged.");
    } catch { setMessage("Server ranking unavailable. Showing the evidence based option order; no learning or ranking was simulated."); }
    finally { setBusy(false); }
  };
  const explain = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/owner/workflows/reason", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ area: result.area, candidateIds: CANDIDATES.slice(0, 3).map((c) => c.id) }) });
      if (!response.ok) throw new Error("Explanation service unavailable");
      const body = await response.json();
      setReasonStatus(body.status === "available" ? "available" : "unavailable");
      setExplanations(Object.fromEntries((body.explanations ?? []).map((x: { candidateId: string; text: string; sourceIds: string[] }) => [x.candidateId, { text: x.text, sourceIds: x.sourceIds }] )));
    } catch { setReasonStatus("unavailable"); setExplanations({}); }
    finally { setBusy(false); }
  };
  const feedback = async (id: string, event: "approve" | "reject" | "export" | "capex", value?: string) => {
    if (!impressionId || serverState !== "connected") return;
    try { await fetch("/api/owner/workflows/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(workspaceId ? { workspaceId } : {}), impressionId, optionId: id, event, ...(value ? { value } : {}) }) }); }
    catch { setMessage("Feedback could not reach the server; the draft remains unchanged."); }
  };
  const ordered = useMemo(() => {
    if (!ranking.length) return CANDIDATES;
    return [...CANDIDATES].sort((a, b) => { const ai = ranking.indexOf(a.id); const bi = ranking.indexOf(b.id); return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi); });
  }, [ranking]);
  const exportPacket = () => {
    const chosen = ordered.find((c) => c.id === selectedOptionId);
    if (!chosen) return;
    const x = itemFor(plan, chosen.id);
    const rows = `## ${chosen.title}\n- Decision: ${x.evidence || "Not recorded"}\n- Owner: ${x.owner || "Unassigned"}\n- Deadline: ${x.due || "Unscheduled"}\n- Evidence / notes: ${x.notes || "None recorded"}\n- Evidence: ${chosen.evidence.join("; ")}\n- Prerequisites: ${chosen.prerequisites.join("; ")}\n- Risks: ${chosen.risk.join("; ")}\n- Opportunities: ${chosen.opportunity.join("; ")}\n- Next action: ${chosen.next}`;
    download("optimization-confirmed-packet.md", `# Area Optimization Packet\n\nArea: ${result.area_label} (${result.area.lat.toFixed(4)}, ${result.area.lon.toFixed(4)}) · ${result.area.radius_mi} mi\nObjective: ${OBJECTIVES[plan.objective]}\nPrepared: ${new Date().toISOString()}\n\n${plan.confirmed ? "User confirmed this packet for export." : "UNCONFIRMED DRAFT — review sources and confirm before relying on this packet."}\n\nThis is an area screen, not an engineering recommendation or feasibility determination.\n\n${rows}\n\n## Scan evidence\n- ${fmtNum(t.line_miles, 1)} mi mapped line; ${t.substation_count} substations; ${fmtNum(t.renewable_mw, 1)} MW renewables; ${fmtNum(t.storage_mw, 1)} MW storage.\n- Current weather rating ratio: ${live ? fmtRatio(live.ratio) : "Unavailable"}.\n`, "text/markdown");
    void feedback(chosen.id, "export");
  };
  const exportCalendar = () => {
    const events = ordered.map((c) => ({ c, item: itemFor(plan, c.id) })).filter(({ item }) => /^\d{4}-\d{2}-\d{2}$/.test(item.due));
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Area Scan//Optimization//EN", ...events.flatMap(({ c, item }) => ["BEGIN:VEVENT", `UID:${c.id}-${item.due}@areascan`, `DTSTART:${icsDate(item.due)}`, `SUMMARY:${c.title.replaceAll(",", "\\,")} deadline`, `DESCRIPTION:Owner ${item.owner || "unassigned"}. ${c.next.replaceAll(",", "\\,")}`, "END:VEVENT"]), "END:VCALENDAR"];
    download("optimization-deadlines.ics", lines.join("\r\n"), "text/calendar");
  };
  const csvCell = (value: string) => {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const locked = !hydrated || busy || serverState === "blocked";

  return <div className="px-6 py-6">
    <Section title="Optimization workspace" subtitle={`Area plan · ${result.area_label}`} sources={["osm", "eia860", "era5_2025", "ieee738"]}>
      <p className="text-[14px] leading-relaxed text-[#556070]">Compare upgrade paths, collect missing evidence, assign follow-up and prepare a review packet. Area screening does not calculate an optimum, establish engineering feasibility or recommend a project.</p>
      <label className="mt-4 block text-[13px] font-semibold" htmlFor="optimization-objective">Planning objective</label>
      <select id="optimization-objective" className={`${input} mt-1 w-full`} value={plan.objective} disabled={locked} onChange={(e) => setPlan((p) => ({ ...p, objective: e.target.value as Objective }))}>{Object.entries(OBJECTIVES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      <Caption className="mt-2">Objective orders evidence requests only; it does not change scan results or determine feasibility.</Caption>
      <div className={`${box} mt-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[14px] font-semibold">Workspace draft</p><p className="text-[12px] text-[#6b7583]">{serverState === "loading" ? "Loading…" : serverState === "connected" ? `Shared service · revision ${revision}` : serverState === "blocked" ? "Owner access required" : "Local browser fallback"}</p></div><div className="flex gap-2">{serverState === "blocked" && <button className={`${input} px-3`} onClick={() => void load()} disabled={busy}>Retry owner access</button>}<button className={`${input} px-3`} onClick={() => void load()} disabled={busy || !stale}>Reload newer draft</button><button className={`${input} px-3 font-semibold`} onClick={() => void save()} disabled={locked || stale}>Save draft</button></div></div>
        {message && <p role="status" className="mt-2 text-[13px] text-[#556070]">{message}</p>}
      </div>
      <WorkflowTelemetryPanel workspaceId={workspaceId} />
      <div className={`${box} mt-4`}>
        <h3 className="text-[14px] font-semibold">Area decision summary</h3>
        <p className="mt-1 text-[13px] text-[#556070]">Evidence coverage {ownerPlan.confidenceGap.score}% · {ownerPlan.confidenceGap.gap}% evidence gap. This measures completeness, not project success or approval.</p>
        {ownerPlan.topRisks.length > 0 ? <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] text-[#1d2733]">{ownerPlan.topRisks.map((risk) => <li key={risk.key}><b>{risk.label}</b> · score {risk.score}/100 × weight {(risk.weight * 100).toFixed(0)}% = {risk.weightedScore.toFixed(2)} weighted points. {risk.evidence}</li>)}</ol> : <p className="mt-2 text-[13px] text-[#556070]">No weighted scan risk factors supplied.</p>}
        <p className="mt-3 text-[13px] font-semibold">Sustainability screen</p><p className="text-[13px] text-[#556070]">{ownerPlan.sustainability.summary} {ownerPlan.sustainability.caveat}</p>
        <p className="mt-3 text-[13px] font-semibold">Next step · {ownerPlan.nextStep.owner} · {ownerPlan.nextStep.timing}</p><p className="text-[13px] text-[#556070]">{ownerPlan.nextStep.title} {ownerPlan.nextStep.rationale}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">{ownerPlan.decisionComparison.map((option) => <article className="rounded-md bg-[#f6f8fa] p-3" key={option.option}><p className="text-[13px] font-semibold">{option.option === "defer" ? "Defer capital" : "Continue operating"}</p><p className="text-[13px]">{option.summary}</p><p className="mt-1 text-[12px] text-[#556070]">Tradeoff: {option.tradeoff}</p></article>)}</div>
        {!!ownerPlan.confidenceGap.missing.length && <p className="mt-3 text-[12px] text-[#6b7583]">Waiting on: {ownerPlan.confidenceGap.missing.join(", ")}.</p>}
        {!!plan.reviewRequired?.length && <p role="status" className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-[13px] text-amber-900">Evidence changed for {plan.reviewRequired.slice(0, 4).join(", ")}{plan.reviewRequired.length > 4 ? ` and ${plan.reviewRequired.length - 4} more` : ""}. Review the updated evidence before reconfirming or exporting.</p>}
      </div>
      <div className={`${box} mt-4`}>
        <h3 className="text-[14px] font-semibold">Assembled workflow</h3>
        <p className="mt-1 text-[12px] text-[#556070]">Choose one intervention, then optionally add a funding lead and authorization tracks. Unknown checks remain explicit verification tasks.</p>
        <label className="mt-3 grid gap-1 text-[12px] font-medium">Intervention<select className={input} value={selectedOptionId} disabled={locked} onChange={(e) => selectIntervention(e.target.value)}>{ownerPlan.interventions.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></label>
        <label className="mt-2 grid gap-1 text-[12px] font-medium">Funding lead (optional)<select className={input} value={plan.selectedFundingId ?? ""} disabled={locked} onChange={(e) => selectFunding(e.target.value)}><option value="">No funding branch</option>{ownerPlan.funding.map((funding) => <option key={funding.id} value={funding.id}>{funding.title} · {funding.status}</option>)}</select></label>
        <fieldset className="mt-3"><legend className="text-[12px] font-semibold">Authorization tracks (optional)</legend><div className="mt-1 grid gap-1 sm:grid-cols-3">{ownerPlan.authorizations.map((authorization) => <label className="flex items-start gap-2 rounded-md border border-[#e6e9ee] p-2 text-[12px]" key={authorization.id}><input type="checkbox" checked={(plan.selectedAuthorizationIds ?? []).includes(authorization.id)} disabled={locked} onChange={(e) => toggleAuthorization(authorization.id, e.target.checked)} /><span>{authorization.title}</span></label>)}</div></fieldset>
        {!selectedWorkflow.isValid && <p role="status" className="mt-2 text-[12px] text-rose-700">Workflow cannot be assembled: {selectedWorkflow.errors.join("; ")}</p>}
        <p className="mt-3 text-[12px] text-[#556070]">{selectedWorkflow.modules.length} modules · {selectedWorkflow.tasks.length} tasks · {selectedWorkflow.tasks.filter((task) => task.verification).length} unresolved verification checks. {selectedWorkflow.modules.find((module) => module.kind === "funding")?.gate ?? "Funding gate not selected."}</p>
        <details className="mt-2"><summary className="cursor-pointer text-[13px] font-semibold">Inspect dependency order · screen through retirement</summary>
          <ol className="mt-2 space-y-3">{selectedWorkflow.stages.map((stage) => <li className="rounded-md bg-[#f6f8fa] p-3" key={stage.id}><p className="text-[13px] font-semibold">{stage.title}</p><p className="text-[11px] text-[#6b7583]">Gate: {stage.gate}</p><ol className="mt-2 list-decimal space-y-2 pl-5">{stage.taskIds.filter((id) => selectedWorkflow.orderedTaskIds.includes(id)).sort((a, b) => (composedOrderIndex.get(a) ?? 9999) - (composedOrderIndex.get(b) ?? 9999)).map((id) => { const task = composedTasks.get(id)!; return <li className="text-[12px]" key={id}><b>{task.title}</b> · {task.role} · {task.branchKind}{task.dependsOn.length ? ` · after ${task.dependsOn.join(", ")}` : " · no prerequisite task"}<p className="text-[#556070]">Output: {task.output}. Evidence: {task.evidence.join("; ") || "Record required"}. Recovery: {task.recovery}</p>{task.verification && <p className="text-amber-800">Unresolved {task.verification.status} check: {task.verification.missing.join(", ") || task.verification.ruleId}</p>}<TaskAssignment id={task.id} state={plan} change={change} disabled={locked} /></li>; })}</ol></li>)}</ol>
        </details>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><p className="text-[14px] font-semibold">Upgrade options</p><div className="flex gap-2"><button className={`${input} px-3`} onClick={() => void explain()} disabled={locked}>Ask for explanations</button><button className={`${input} px-3`} onClick={() => void rank()} disabled={locked || serverState !== "connected"}>Request server ranking</button></div></div>
      <Caption className="mt-1">Risks, opportunities and prerequisites are shown for every option. Server ranking is advisory and only reorders eligible options.</Caption>
      {reasonStatus === "unavailable" && <p role="status" className="mt-2 text-[13px] text-[#556070]">Explanations unavailable. Deterministic evidence, risks and prerequisites remain available below.</p>}
      <div className="mt-3 grid gap-3">{ordered.map((c, index) => { const item = itemFor(plan, c.id); return <article className={box} key={c.id}>
        <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[12px] font-medium text-[#6b7583]">Option {index + 1}</p><h4 className="text-[15px] font-semibold">{c.title}</h4></div><span className="rounded-full border border-[#e6e9ee] px-2 py-1 text-[12px] text-[#556070]">Evidence incomplete</span></div>
        <p className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-[#6b7583]">Opportunity</p><ul className="list-disc pl-4 text-[14px] text-[#1d2733]">{c.opportunity.map((x) => <li key={x}>{x}</li>)}</ul>
        <p className="mt-2 text-[12px] font-semibold uppercase tracking-wide text-[#6b7583]">Scan evidence</p><ul className="list-disc pl-4 text-[14px] text-[#556070]">{c.evidence.map((x) => <li key={x}>{x}</li>)}</ul>
        <p className="mt-2 text-[12px] font-semibold uppercase tracking-wide text-[#6b7583]">Risks and unknowns</p><ul className="list-disc pl-4 text-[14px] text-[#556070]">{c.risk.map((x) => <li key={x}>{x}</li>)}</ul>
        <p className="mt-2 text-[12px] font-semibold uppercase tracking-wide text-[#6b7583]">Prerequisites</p><ul className="list-disc pl-4 text-[14px] text-[#556070]">{c.prerequisites.map((x) => <li key={x}>{x}</li>)}</ul>
        <p className="mt-2 text-[14px] leading-snug"><b>Next action:</b> {c.next}</p>
        {!!c.tasks.length && <details className="mt-2"><summary className="cursor-pointer text-[13px] font-medium">Suggested sequence ({c.tasks.length} tasks)</summary><ol className="mt-2 list-decimal space-y-2 pl-5 text-[13px] text-[#556070]">{c.tasks.map((task) => <li key={task.id}><b>{task.title}</b> · {task.role}; target +{task.offsetDays} days{task.dependsOn.length ? ` · after ${task.dependsOn.join(", ")}` : ""}<p>{task.output}. Evidence: {task.evidence.join(", ")}</p></li>)}</ol></details>}
        {explanations[c.id] && <div className="mt-2 rounded-md bg-[#f6f8fa] p-3"><p className="text-[13px] font-semibold">Planning explanation</p><p className="mt-1 text-[14px] text-[#556070]">{explanations[c.id].text}</p>{explanations[c.id].sourceIds.length > 0 && <p className="mt-1 text-[12px] text-[#6b7583]">Sources: {explanations[c.id].sourceIds.join(", ")}</p>}</div>}
        <div className="mt-3 grid gap-2 sm:grid-cols-2"><label className="grid gap-1 text-[12px] font-medium">Assigned owner<input className={input} value={item.owner} placeholder="Name or team" disabled={locked} onChange={(e) => change(c.id, "owner", e.target.value)} /></label><label className="grid gap-1 text-[12px] font-medium">Deadline<input className={input} type="date" value={item.due} disabled={locked} onChange={(e) => change(c.id, "due", e.target.value)} /></label></div>
        <label className="mt-2 grid gap-1 text-[12px] font-medium">Evidence status<select className={input} value={item.evidence} disabled={locked} onChange={(e) => change(c.id, "evidence", e.target.value)}><option value="">Not recorded</option><option value="Requested">Requested</option><option value="Received · unverified">Received · unverified</option><option value="Verified by team">Verified by team</option></select></label>
        <label className="mt-2 grid gap-1 text-[12px] font-medium">Evidence reference and notes<textarea className="min-h-16 rounded-md border border-[#d8dee6] p-2 text-[13px]" value={item.notes} disabled={locked} placeholder="Source, date, file reference, caveats" onChange={(e) => change(c.id, "notes", e.target.value)} /></label>
        <div className="mt-3 flex gap-2"><button className={input} onClick={() => void feedback(c.id, "approve")} disabled={!impressionId}>Advance for review</button><button className={input} onClick={() => void feedback(c.id, "reject")} disabled={!impressionId}>Set aside</button></div>
      </article>; })}</div>
    </Section>
    <Section title="Funding leads" subtitle="Five official program and solicitation pages · applicability remains unverified" sources={[]}>
      <div className="grid gap-3">{ownerPlan.funding.map((lead) => <article className={box} key={lead.id}>
        <div className="flex flex-wrap items-start justify-between gap-2"><div><h4 className="text-[14px] font-semibold">{lead.title}</h4><p className="text-[12px] text-[#6b7583]">{lead.status.toUpperCase()} · {lead.deadline ? `deadline ${lead.deadline}` : "no verified deadline"} · confidence {Math.round(lead.confidenceScore * 100)}%</p></div><a className="text-[13px] text-[#0369a1] underline" href={lead.url} target="_blank" rel="noreferrer">Official source</a></div>
        <p className="mt-2 text-[13px]">{lead.summary}</p><p className="mt-1 text-[12px] text-[#556070]">Applicability: {lead.applicability}</p><p className="mt-1 text-[12px] text-[#556070]">Tradeoff: {lead.tradeoff}</p>
        <details className="mt-2"><summary className="cursor-pointer text-[13px] font-medium">Decision and closeout tasks ({lead.tasks.length})</summary><ol className="mt-2 list-decimal space-y-2 pl-5 text-[13px] text-[#556070]">{lead.tasks.map((task) => <li key={task.id}><b>{task.title}</b> · {task.role}; target +{task.offsetDays} days{task.dependsOn.length ? ` · after ${task.dependsOn.join(", ")}` : ""}. <span>Output: {task.output}. Evidence: {task.evidence.join("; ") || "Owner record required"}. Recovery: {task.recovery}</span><TaskAssignment id={task.id} state={plan} change={change} disabled={locked} /></li>)}</ol></details>
      </article>)}</div>
    </Section>
    <Section title="Authorization tracks" subtitle="Required authorities and conditions remain unconfirmed" sources={[]}>
      <div className="grid gap-3">{ownerPlan.authorizations.map((track) => <article className={box} key={track.id}><h4 className="text-[14px] font-semibold">{track.title}</h4><p className="text-[12px] text-[#6b7583]">Authority: {track.authority} · evidence completeness {Math.round(track.confidenceScore * 100)}%</p><p className="mt-2 text-[13px]">{track.summary}</p><p className="mt-1 text-[12px] text-[#556070]">Tradeoff: {track.tradeoff}</p><details className="mt-2"><summary className="cursor-pointer text-[13px] font-medium">Pathway, decision and renewal tasks ({track.tasks.length})</summary><ol className="mt-2 list-decimal space-y-2 pl-5 text-[13px] text-[#556070]">{track.tasks.map((task) => <li key={task.id}><b>{task.title}</b> · {task.role}; target +{task.offsetDays} days{task.dependsOn.length ? ` · after ${task.dependsOn.join(", ")}` : ""}. Output: {task.output}. Evidence: {task.evidence.join("; ") || "Authority/owner record required"}. Recovery: {task.recovery}<TaskAssignment id={task.id} state={plan} change={change} disabled={locked} /></li>)}</ol></details></article>)}</div>
    </Section>
    <Section title="Delivery lifecycle" subtitle="Dependency sequence from initial screen through safe retirement" sources={[]}>
      <ol className="grid gap-3">{ownerPlan.lifecycle.map((stage) => <li className={box} key={stage.id}><h4 className="text-[14px] font-semibold">{stage.title}</h4><p className="text-[13px] text-[#556070]">{stage.description}</p><p className="mt-1 text-[12px]"><b>Gate:</b> {stage.gate} · <b>Owner:</b> {stage.owner}</p><p className="mt-1 text-[12px] text-[#6b7583]">Evidence: {stage.evidence.join("; ")}</p>{stage.tasks.map((task) => <div className="mt-2 text-[12px] text-[#556070]" key={task.id}><p><b>{task.title}</b> · {task.role}; target +{task.offsetDays} days{task.dependsOn.length ? ` · after ${task.dependsOn.join(", ")}` : ""}. Output: {task.output}. Recovery: {task.recovery}</p><TaskAssignment id={task.id} state={plan} change={change} disabled={locked} /></div>)}</li>)}</ol>
    </Section>
    <Section title="Sector scenario fixtures" subtitle="Six synthetic examples; non-electric sectors require their own source data" sources={[]}>
      <label className="block text-[13px] font-semibold" htmlFor="owner-plan-fixture">Select a scenario</label><select id="owner-plan-fixture" className={`${input} mt-1 w-full`} value={fixtureId} onChange={(e) => setFixtureId(e.target.value as OwnerPlanFixtureId)}>{OWNER_PLAN_FIXTURES.map((fixture) => <option key={fixture.id} value={fixture.id}>{fixture.title} · {fixture.sector}</option>)}</select>
      <article className={`${box} mt-3`}><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-[14px] font-semibold">{selectedFixture.title}</h4><span className="rounded-full border border-[#e6e9ee] px-2 py-1 text-[11px]">Synthetic scenario</span></div><p className="mt-2 text-[13px]">Objective: {selectedFixture.objective}</p><p className="mt-2 text-[12px] font-semibold">Top risks</p><ul className="list-disc pl-4 text-[13px]">{selectedFixture.topRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul><p className="mt-2 text-[12px] font-semibold">Sustainability evidence</p><ul className="list-disc pl-4 text-[13px]">{selectedFixture.sustainabilityEvidence.map((item) => <li key={item}>{item}</li>)}</ul><p className="mt-2 text-[13px]"><b>Next step:</b> {selectedFixture.nextStep}</p><div className="mt-2 grid gap-2 sm:grid-cols-2"><p className="rounded-md bg-[#f6f8fa] p-2 text-[12px]"><b>Defer:</b> {selectedFixture.defer}</p><p className="rounded-md bg-[#f6f8fa] p-2 text-[12px]"><b>Continue operating:</b> {selectedFixture.operate}</p></div><p className="mt-2 text-[12px] text-[#556070]">Evidence coverage {selectedFixture.confidenceScore}% · evidence gap {selectedFixture.confidenceGap}%. Waiting on: {selectedFixture.missingEvidence.join(", ")}.</p><ul className="mt-1 list-disc pl-4 text-[12px] text-[#6b7583]">{selectedFixture.notes.map((note) => <li key={note}>{note}</li>)}</ul><details className="mt-3"><summary className="cursor-pointer text-[13px] font-semibold">Full scenario task DAG through retirement ({selectedFixture.lifecycle.length} tasks)</summary><ol className="mt-2 list-decimal space-y-2 pl-5">{selectedFixture.lifecycle.map((task) => <li key={task.id}><b>{task.phase}: {task.title}</b> · owner {task.owner}; prerequisite: {task.prerequisites.join("; ")}; dependency: {task.dependsOn.join(", ") || "none"}; deliverable: {task.deliverable}; evidence: {task.evidence.join("; ")}; recovery: {task.recovery}<TaskAssignment id={task.id} state={plan} change={change} disabled={locked} /></li>)}</ol></details></article>
    </Section>
    <Section title="Scan evidence and sensitivity" subtitle="Screening signals · verify against asset owners" sources={["osm", "eia860", "era5_2025", "ieee738"]}>
      <div className="grid gap-2 text-[14px]"><p>{fmtNum(t.line_miles, 1)} mi mapped line; {fmtNum(t.line_miles_by_kv["200-499"] + t.line_miles_by_kv["500+"], 1)} mi mapped at 200 kV or higher.</p><p>{t.substation_count} substations · {fmtNum(t.renewable_mw, 1)} MW renewable nameplate · {fmtNum(t.storage_mw, 1)} MW battery nameplate.</p><p>Current modeled weather ratio: {live ? fmtRatio(live.ratio) : "Unavailable"} · 2025 daily range: {dayRatios.length ? `${fmtRatio(dayRatios[0])}–${fmtRatio(dayRatios.at(-1)!)}` : "Unavailable"}.</p></div><Caption className="mt-2">The weather site and representative conductor are not line-specific ratings. Confirm operator asset identity, conductor, protection and operating constraints.</Caption>
      <ul className="mt-3 space-y-1 text-[14px] text-[#556070]"><li>Interconnection and transfer limits: unknown.</li><li>Capital, operating and lifecycle cost: not supplied.</li><li>Site, route, land and permits: not assessed.</li><li>Reliability target and outage limits: not supplied.</li></ul>
    </Section>
    <Section title="Review packet and calendar">
      <label className="flex items-start gap-2 text-[14px] leading-snug"><input type="checkbox" checked={plan.confirmed} disabled={locked} onChange={(e) => setPlan((p) => ({ ...p, confirmed: e.target.checked, ...(e.target.checked ? { reviewRequired: [] } : {}) }))} /><span>I reviewed the evidence references and confirm this packet is ready to share.</span></label>
      <Caption className="mt-2">Confirmation is your review record. It does not verify the sources or approve an engineering option.</Caption>
      <label className="mt-3 grid max-w-xl gap-1 text-[12px] font-medium">Option tracked for export<select className={input} value={selectedOptionId} disabled={locked} onChange={(e) => selectIntervention(e.target.value)}>{ordered.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></label>
      <div className="mt-3 flex flex-wrap gap-2"><button className={`${input} px-3`} onClick={exportPacket} disabled={!plan.confirmed || !!plan.reviewRequired?.length || locked}>Export confirmed packet</button><button className={`${input} px-3`} onClick={exportCalendar} disabled={!hydrated}>Export deadlines to calendar</button><button className={`${input} px-3`} disabled={!hydrated} onClick={() => { download("optimization-evidence.csv", `option,owner,deadline,evidence status,notes\n${ordered.map((c) => { const x = itemFor(plan, c.id); return [c.title, x.owner, x.due, x.evidence, x.notes].map(csvCell).join(","); }).join("\n")}`, "text/csv"); }}>Export evidence list</button></div>
    </Section>
  </div>;
}
