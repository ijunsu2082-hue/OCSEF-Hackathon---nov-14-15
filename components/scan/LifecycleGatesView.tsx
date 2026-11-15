"use client";

import { useEffect, useMemo, useState } from "react";
import type { BuiltOwnerPlan } from "@/lib/owner/ownerPlan";
import { current, evaluateGate, GATE_STAGE, GATES, type GateEvaluation } from "@/lib/owner/lifecycle";
import { PROCEDURES, proceduresForStage } from "@/lib/owner/procedures";
import type { OwnerSourceItem, OwnerSourcesResponse } from "@/lib/owner/ownerSources";
import type { GateId, PlanTarget } from "@/lib/owner/types";
import { lifecycleFromPlan, STAGE_LABEL } from "./ownerPlanExport";
import s from "./owner-plan.module.css";

const GATE_STATUS_LABEL: Record<GateEvaluation["status"], string> = { pass: "Pass", blocked: "Blocked", not_ready: "Not ready" };

/** M0–M9 readiness from the event log the plan's task statuses support. A pass is evidence readiness, never an approval. */
export default function LifecycleGatesView({ plan, asOf }: { plan: BuiltOwnerPlan; asOf: string }) {
  const mapping = useMemo(() => lifecycleFromPlan(plan, asOf), [plan, asOf]);
  const evaluations = useMemo(() => {
    const procedures = [...PROCEDURES];
    if (!mapping.state) {
      return GATES.map((gate): GateEvaluation => ({
        gate, status: "not_ready", blockers: [], asOf,
        missingInputs: [`lifecycle event log could not be replayed: ${mapping.error ?? "unknown error"}`],
      }));
    }
    return GATES.map((gate) => evaluateGate(mapping.state!, gate, asOf, { procedures }));
  }, [mapping, asOf]);
  const [selected, setSelected] = useState<GateId>("M0");
  const ev = evaluations.find((e) => e.gate === selected)!;
  const gateTasks = plan.tasks.filter((t) => t.gate === selected);
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
        {GATE_STAGE[selected].map((stage) => (
          <div key={stage} className={s.stage}>
            <h4 className={s.subhead}>{STAGE_LABEL[stage]}</h4>
            <ul className={s.tasks}>
              {proceduresForStage(stage).map((p) => {
                const done = mapping.state ? current(mapping.state.procedures[p.code]) : undefined;
                return (
                  <li key={p.code} className={s.task} data-status={done ? "done" : "not_started"}>
                    <div className={s.taskHead}><code>{p.code}</code> <b className={s.title}>{p.title}</b></div>
                    <p className={s.meta}>{p.role}{p.gate ? ` · gate ${p.gate}` : " · no gate"} · {done ? "credited (user assertion)" : "not recorded"}</p>
                    {p.blocksGateOn?.length ? <p className={s.meta}>Blocks the gate on: {p.blocksGateOn.join("; ")}</p> : null}
                    <p className={s.source}>Source: <code>{p.sourceDoc}</code></p>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
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
