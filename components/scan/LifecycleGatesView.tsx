"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { BuiltOwnerPlan } from "@/lib/owner/ownerPlan";
import { current, evaluateGate, GATE_STAGE, GATES, triggerStatus, type GateEvaluation, type LifecycleState, type TriggerState } from "@/lib/owner/lifecycle";
import { gatingOf, PROCEDURES, RULE_IDS } from "@/lib/owner/procedures";
import type { ProcedureStep } from "@/lib/owner/planTypes";
import type { OwnerSourceItem, OwnerSourcesResponse } from "@/lib/owner/ownerSources";
import type { GateId, PlanTarget } from "@/lib/owner/planTypes";
import { lifecycleFromPlan, STAGE_LABEL } from "./ownerPlanExport";
import s from "./owner-plan.module.css";

const GATE_STATUS_LABEL: Record<GateEvaluation["status"], string> = { pass: "Pass", blocked: "Blocked", not_ready: "Not ready" };
const TRIGGER_LABEL: Record<TriggerState, string> = { active: "Trigger active: counts toward this gate", not_active: "Trigger evaluated, not active: does not count", not_evaluated: "Trigger not evaluated" };

function ProcedureItem({ p, state, children }: { p: ProcedureStep; state: LifecycleState | null; children?: ReactNode }) {
  const done = state ? current(state.procedures[p.code]) : undefined;
  return (
    <li className={s.task} data-status={done ? "done" : "not_started"}>
      <div className={s.taskHead}><code>{p.code}</code> <b className={s.title}>{p.title}</b></div>
      <p className={s.meta}>{p.role} · {STAGE_LABEL[p.stage]}{p.gateOverride ? ` · gate ${p.gateOverride} (named by doc, not stage default)` : ""} · {done ? "credited (user assertion)" : "not recorded"}</p>
      {children}
      {p.blocksGateOn?.length ? <p className={s.meta}>{gatingOf(p) === "non_gating" ? "Keeps the gate at risk on" : "Blocks the gate on"}: {p.blocksGateOn.join("; ")}</p> : null}
      <p className={s.source}>Source: <code>{p.sourceDoc}</code></p>
    </li>
  );
}

/** M0–M9 readiness from the event log the plan's task statuses support. A pass is evidence readiness, never an approval. */
export default function LifecycleGatesView({ plan, asOf }: { plan: BuiltOwnerPlan; asOf: string }) {
  const mapping = useMemo(() => lifecycleFromPlan(plan, asOf), [plan, asOf]);
  const evaluations = useMemo(() => {
    const procedures = [...PROCEDURES];
    if (!mapping.state) {
      return GATES.map((gate): GateEvaluation => ({
        gate, status: "not_ready", blockers: [], asOf, warnings: [],
        missingInputs: [`lifecycle event log could not be replayed: ${mapping.error ?? "unknown error"}`],
      }));
    }
    return GATES.map((gate) => evaluateGate(mapping.state!, gate, asOf, { procedures }));
  }, [mapping, asOf]);
  const [selected, setSelected] = useState<GateId>("M0");
  const ev = evaluations.find((e) => e.gate === selected)!;
  const gateTasks = plan.tasks.filter((t) => t.gate === selected);
  const atGate = PROCEDURES.filter((p) => p.gate === selected);
  const byMode = (m: ReturnType<typeof gatingOf>) => atGate.filter((p) => gatingOf(p) === m);
  const noGate = PROCEDURES.filter((p) => !p.gate);
  const eventCounts = mapping.events.reduce<Record<string, number>>((m, e) => ({ ...m, [e.type]: (m[e.type] ?? 0) + 1 }), {});

  return (
    <div className={s.root}>
      <section className={s.section} aria-labelledby="lg-gates">
        <h3 id="lg-gates">Lifecycle gates</h3>
        <p className={s.meta}>Evidence readiness as of {asOf.slice(0, 10)}. A pass means the recorded evidence is complete; it is not an approval.</p>
        <div className={s.gateStrip} role="group" aria-label="Gates M0 to M9">
          {evaluations.map((g) => (
            <button key={g.gate} type="button" className={s.gateBtn} data-status={g.status} aria-pressed={g.gate === selected}
              aria-label={`${g.gate} ${GATE_STATUS_LABEL[g.status]}`} onClick={() => setSelected(g.gate)}>
              <b>{g.gate}</b>
              <span>{GATE_STATUS_LABEL[g.status]}</span>
            </button>
          ))}
        </div>

        <div className={s.card} aria-live="polite">
          <span className={s.kicker}>{selected} · {GATE_STAGE[selected].map((st) => STAGE_LABEL[st]).join(" + ")}</span>
          <b className={s.title}>{GATE_STATUS_LABEL[ev.status]}</b>
          {ev.blockers.length ? (
            <>
              <span className={s.label}>Blockers ({ev.blockers.length})</span>
              <ul className={s.list}>
                {ev.blockers.map((b) => <li key={`${b.code}-${b.recordId}`}><code>{b.code}</code> {b.reason} <em>({b.recordId})</em></li>)}
              </ul>
            </>
          ) : <p className={s.meta}>No blockers recorded.</p>}
          {ev.missingInputs.length ? (
            <>
              <span className={s.label}>Missing inputs ({ev.missingInputs.length})</span>
              <ul className={s.list}>{ev.missingInputs.map((m) => <li key={m}>{m}</li>)}</ul>
            </>
          ) : null}
          {ev.warnings.length ? (
            <>
              <span className={s.label}>At risk, does not change status ({ev.warnings.length})</span>
              <ul className={s.list}>{ev.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </>
          ) : null}
          {gateTasks.length ? (
            <>
              <span className={s.label}>Plan tasks at this gate</span>
              <ul className={s.list}>{gateTasks.map((t) => <li key={t.id}>{t.title} <em>({t.status.replace(/_/g, " ")})</em></li>)}</ul>
            </>
          ) : null}
        </div>

        <details className={s.details}>
          <summary>How the plan maps to gate records</summary>
          <p className={s.detail}>Event log: {mapping.events.length} events ({Object.entries(eventCounts).map(([k, n]) => `${k} ×${n}`).join(", ") || "none"}), all at the scan time.</p>
          <p className={s.detail}>
            Credited procedures: {mapping.credited.length ? mapping.credited.join(", ") : "none"}. A procedure is credited only when every plan task with its code is marked done, recorded as a user-assertion attestation.
            {mapping.partial.length ? ` Partly done, not credited: ${mapping.partial.join(", ")}.` : ""}
          </p>
          <p className={s.detail}>Not mapped from the plan, so those gate inputs stay missing:</p>
          <ul className={s.list}>{mapping.notMapped.map((x) => <li key={x}>{x}</li>)}</ul>
          {mapping.error ? <p className={s.unknown}>Replay error: {mapping.error}</p> : null}
        </details>
      </section>

      <section className={s.section} aria-labelledby="lg-procs">
        <h3 id="lg-procs">Procedures for {selected}</h3>
        <div className={s.stage}>
          <h4 className={s.subhead}>Required ({byMode("required").length})</h4>
          <p className={s.meta}>Each must be recorded complete before {selected} can pass.</p>
          <ul className={s.tasks}>{byMode("required").map((p) => <ProcedureItem key={p.code} p={p} state={mapping.state} />)}</ul>
        </div>
        {byMode("conditional").length ? (
          <div className={s.stage}>
            <h4 className={s.subhead}>Conditional ({byMode("conditional").length})</h4>
            <p className={s.meta}>Count toward {selected} only while their trigger is recorded active; a completion counts only if recorded after the activation.</p>
            <ul className={s.tasks}>
              {byMode("conditional").map((p) => {
                const t = mapping.state ? triggerStatus(mapping.state, p.trigger!) : "not_evaluated";
                const rule = RULE_IDS[p.trigger!];
                const basis = mapping.triggers.find((x) => x.trigger === p.trigger)?.basis;
                return (
                  <ProcedureItem key={p.code} p={p} state={mapping.state}>
                    <p className={t === "not_evaluated" ? s.unknown : s.meta}>
                      <code>{p.trigger}</code>: {TRIGGER_LABEL[t]}
                      {t === "not_evaluated" ? (rule?.evaluationRequired ? ` (the doc requires this evaluation, so ${selected} lists it as missing)` : " (treated as not active)") : ""}
                      {basis ? `. Basis: ${basis}` : ""}
                    </p>
                    {rule ? <p className={s.detail}>Applies when: {rule.description}</p> : null}
                  </ProcedureItem>
                );
              })}
            </ul>
          </div>
        ) : null}
        {byMode("non_gating").length ? (
          <div className={s.stage}>
            <h4 className={s.subhead}>Non-gating ({byMode("non_gating").length})</h4>
            <p className={s.meta}>Lifelong, portfolio or post-gate work in these stages. Never affects {selected}.</p>
            <ul className={s.tasks}>{byMode("non_gating").map((p) => <ProcedureItem key={p.code} p={p} state={mapping.state} />)}</ul>
          </div>
        ) : null}
        <details className={s.details}>
          <summary>Procedures attached to no gate ({noGate.length})</summary>
          <p className={s.detail}>Grants (WORKFLOWS 5A) names no milestone, so these steps never affect M0 to M9. Committed funding still counts at M3 through funding records.</p>
          <ul className={s.tasks}>{noGate.map((p) => <ProcedureItem key={p.code} p={p} state={mapping.state} />)}</ul>
        </details>
      </section>

      <OwnerSourcesPanel target={plan.target} />
    </div>
  );
}

const SOURCE_STATUS_LABEL: Record<OwnerSourceItem["status"], string> = {
  open: "Open", closed: "Closed", forecasted: "Forecasted", informational: "Informational", unresolved: "Unresolved",
};
const SOURCE_KIND_LABEL: Record<OwnerSourceItem["kind"], string> = { funding: "Funding", jurisdiction: "Jurisdiction", permit_input: "Permit inputs" };

type SourcesState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; body: OwnerSourcesResponse };

/** Read-only official source lookups for the plan target (GET /api/owner-plan/sources). */
export function OwnerSourcesPanel({ target }: { target: PlanTarget }) {
  const [state, setState] = useState<SourcesState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const query = `lat=${target.lat}&lon=${target.lon}&radius=${target.radius_miles}&sector=${target.sector}`;

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetch(`/api/owner-plan/sources?${query}`, { signal: ctrl.signal })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
        if (!json || !Array.isArray(json.items)) throw new Error("response did not contain items");
        setState({ status: "ok", body: json as OwnerSourcesResponse });
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => ctrl.abort();
  }, [query, attempt]);

  return (
    <section className={s.section} aria-labelledby="lg-sources" aria-busy={state.status === "loading"}>
      <h3 id="lg-sources">Official sources</h3>
      <p className={s.meta}>Read-only lookups for this location. Listings are candidates; fit, eligibility and permit applicability are not assessed.</p>
      {state.status === "loading" ? <p className={s.meta} role="status">Looking up official sources…</p> : null}
      {state.status === "error" ? (
        <div className={s.banner} role="alert">
          <b>Lookup failed</b>
          <p>{state.message}</p>
          <button type="button" className={s.btnSmall} onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </div>
      ) : null}
      {state.status === "ok" ? (
        <>
          <p className={s.meta}>Retrieved {state.body.retrievedAt}</p>
          {(Object.keys(SOURCE_KIND_LABEL) as OwnerSourceItem["kind"][]).map((kind) => {
            const items = state.body.items.filter((i) => i.kind === kind);
            if (!items.length) return null;
            return (
              <div key={kind} className={s.stage}>
                <h4 className={s.subhead}>{SOURCE_KIND_LABEL[kind]} ({items.length})</h4>
                <ul className={s.tasks}>
                  {items.map((i) => {
                    const keywordOnly = /keyword match only/i.test(i.detail);
                    return (
                      <li key={i.id} className={s.task} data-status={i.status === "unresolved" ? "blocked" : "not_started"}>
                        <div className={s.taskHead}>
                          <span className={s.chip} data-src={i.status}>{SOURCE_STATUS_LABEL[i.status]}</span>
                          {keywordOnly ? <span className={s.chip} data-src="keyword">Keyword match only</span> : null}
                        </div>
                        {i.url ? (
                          <a className={s.title} href={i.url} target="_blank" rel="noopener noreferrer">{i.title}<span className={s.srOnly}> (opens in a new tab)</span></a>
                        ) : <b className={s.title}>{i.title}</b>}
                        {i.deadline ? <p className={s.meta}>Deadline {i.deadline}</p> : null}
                        <p className={i.status === "unresolved" ? s.unknown : s.detail}>
                          {i.status === "unresolved" ? "Unresolved: " : ""}{i.detail.trim() || "no reason returned by the lookup"}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {state.body.items.length === 0 ? <p className={s.unknown}>The lookup returned no items and no reason.</p> : null}
        </>
      ) : null}
    </section>
  );
}
