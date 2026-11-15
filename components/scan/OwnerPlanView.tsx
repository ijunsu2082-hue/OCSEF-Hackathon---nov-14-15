"use client";

import { useMemo, useState } from "react";
import type { ScanResult } from "@/lib/scan/areaScan";
import { buildOwnerPlan, planKey, type BuiltOwnerPlan, type Scenario } from "@/lib/owner/ownerPlan";
import { planInputFromHeadScan } from "@/lib/owner/planInput";
import {
  localStorageAdapter,
  mergeDraft,
  removeTaskEdit,
  setSelectedOption,
  setTaskEdit,
  type Draft,
  type LoadResult,
  type TaskEdit as DraftTaskEdit,
} from "@/lib/owner/draftStore";
import { STAGE_ORDER } from "@/lib/owner/procedures";
import type { Evidence, Finding, OptionKind, OwnerTaskWithNotes, PlanTarget, TaskStatus } from "@/lib/owner/planTypes";
import {
  deadlineKindLabel,
  deadlinesIcs,
  draftLocation,
  draftStoreFor,
  draftToEdits,
  evidenceJson,
  factValueText,
  planJson,
  PROVENANCE_LABEL,
  STAGE_LABEL,
  stagePackets,
} from "./ownerPlanExport";
import s from "./owner-plan.module.css";

// ---------------------------------------------------------------- state hook

export interface OwnerPlanState {
  target: PlanTarget;
  asOf: string;
  scenario: Scenario;
  plan: BuiltOwnerPlan;
  draft: Draft;
  storageKey: string;
  loadStatus: LoadResult["status"];
  saveFailed: boolean;
  changedUnderEdit: string[];
  orphanedOption: string | null;
  editTask: (taskId: string, patch: Partial<Pick<DraftTaskEdit, "owner" | "due" | "status" | "notes">>) => void;
  selectOption: (optionId: string) => void;
  discardEdit: (taskId: string) => void;
}

const SECTOR = "electric" as const;

/**
 * Owner plan for the current Area Scan. `asOf` is stamped once per scan
 * (point + radius) and reused across re-renders and heatwave toggles, so the
 * plan is deterministic for that scan. Edits live in localStorage under
 * ownerPlan.draftStorageKey(target) and are re-applied on every rebuild.
 */
export function useOwnerPlan(result: ScanResult | null, heatwave: boolean): { state: OwnerPlanState | null; error: string | null } {
  const scanKey = result ? `${result.point.lat}:${result.point.lon}:${result.point.radius_mi}` : null;
  const [stamp, setStamp] = useState<{ key: string | null; asOf: string | null }>({ key: null, asOf: null });
  if (stamp.key !== scanKey) setStamp({ key: scanKey, asOf: scanKey ? new Date().toISOString() : null });
  const asOf = stamp.key === scanKey ? stamp.asOf : null;
  const scenario: Scenario = heatwave ? "heatwave" : "baseline";

  const built = useMemo(() => {
    if (!result || !asOf) return null;
    try {
      const input = planInputFromHeadScan(result, { sector: SECTOR, scannedAt: asOf, label: result.label });
      const { store, storageKey } = draftStoreFor(localStorageAdapter(), input.target);
      return { input, store, storageKey, error: null as string | null };
    } catch (err) {
      return { input: null, store: null, storageKey: "", error: err instanceof Error ? err.message : String(err) };
    }
  }, [result, asOf]);

  const [local, setLocal] = useState<{ key: string; draft: Draft; status: LoadResult["status"]; saveFailed: boolean } | null>(null);
  let current = local;
  if (built?.store && (!local || local.key !== built.storageKey)) {
    // New target: load its draft once and keep it in state (React's "adjust state during render" pattern).
    const loaded = built.store.load(draftLocation(built.input.target));
    current = { key: built.storageKey, draft: loaded.draft, status: loaded.status, saveFailed: false };
    setLocal(current);
  }
  const currentDraft = current?.draft ?? null;

  const plans = useMemo(() => {
    if (!built?.input || !currentDraft || !asOf) return null;
    try {
      const edits = draftToEdits(currentDraft, built.input.target);
      const optionOnly = { planKey: edits.planKey, ...(edits.selectedOption !== undefined ? { selectedOption: edits.selectedOption } : {}) };
      // Base plan (same option, no task edits): the hash basis for draftStore's changed-under-edit check.
      const base = buildOwnerPlan(built.input, { scenario, asOf, edits: optionOnly });
      const plan = buildOwnerPlan(built.input, { scenario, asOf, edits });
      const merge = mergeDraft(base.tasks, currentDraft, plan.options.map((o) => o.id));
      return { base, plan, merge, error: null as string | null };
    } catch (err) {
      return { base: null, plan: null, merge: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [built, currentDraft, scenario, asOf]);

  if (!result) return { state: null, error: null };
  if (built?.error) return { state: null, error: built.error };
  if (plans?.error) return { state: null, error: plans.error };
  if (!built?.input || !built.store || !current || !plans?.plan || !plans.base || !plans.merge || !asOf) return { state: null, error: null };

  const { input, store, storageKey } = built;
  const loc = draftLocation(input.target);
  const draft = current.draft;
  const status = current.status;
  const base = plans.base;
  const commit = (next: Draft) => {
    const ok = store.save(loc, next);
    setLocal({ key: storageKey, draft: next, status, saveFailed: !ok });
  };

  return {
    error: null,
    state: {
      target: input.target,
      asOf,
      scenario,
      plan: plans.plan,
      draft,
      storageKey,
      loadStatus: status,
      saveFailed: current.saveFailed,
      changedUnderEdit: plans.merge.changedUnderEdit,
      orphanedOption: plans.merge.orphanedOption,
      editTask(taskId, patch) {
        const task = base.tasks.find((t) => t.id === taskId);
        if (!task) return;
        commit(setTaskEdit(draft, task, patch, new Date().toISOString()));
      },
      selectOption(optionId) {
        commit(setSelectedOption(draft, optionId, new Date().toISOString()));
      },
      discardEdit(taskId) {
        commit(removeTaskEdit(draft, taskId, new Date().toISOString()));
      },
    },
  };
}

// ---------------------------------------------------------------- helpers

const OPTION_KIND_LABEL: Record<OptionKind, string> = {
  repair: "Repair",
  operating_change: "Operating change",
  replacement: "Replacement",
  defer: "Defer",
  do_nothing: "Do nothing",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
  blocked: "Blocked",
};

const domId = (prefix: string, id: string) => `op-${prefix}-${id.replace(/[^A-Za-z0-9_-]+/g, "_")}`;

/** Bring a section into view and move focus to it; respects reduced motion and opens a closed <details>. */
function focusById(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  for (let p: HTMLElement | null = el; p; p = p.parentElement) if (p instanceof HTMLDetailsElement) p.open = true;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  el.focus({ preventScroll: true });
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Text input that commits on blur or Enter, so typing does not reshuffle the plan mid-word. */
function CommitField({ id, label, value, placeholder, multiline, onCommit }: {
  id: string; label: string; value: string; placeholder?: string; multiline?: boolean; onCommit: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) { setPrev(value); setText(value); }
  const commit = () => { if (text !== value) onCommit(text); };
  return (
    <label className={s.field} htmlFor={id}>
      <span>{label}</span>
      {multiline ? (
        <textarea id={id} rows={2} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} />
      ) : (
        <input
          id={id}
          type="text"
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
      )}
    </label>
  );
}

function EvidenceChips({ ids, evidence, emptyReason }: { ids: string[]; evidence: Map<string, Evidence>; emptyReason: string }) {
  if (!ids.length) return <p className={s.unknown}>No evidence attached: {emptyReason}</p>;
  return (
    <ul className={s.chips} aria-label="Evidence">
      {ids.map((id) => {
        const e = evidence.get(id);
        if (!e) return <li key={id}><span className={s.chip} data-prov="missing">Not in register: {id}</span></li>;
        return (
          <li key={id}>
            <button type="button" className={s.chip} data-prov={e.provenance} onClick={() => focusById(domId("ev", id))}
              aria-label={`Evidence ${e.title}, ${PROVENANCE_LABEL[e.provenance]}, ${e.freshness}. Show in register`}>
              <b>{PROVENANCE_LABEL[e.provenance]}</b> {e.title} · {e.freshness}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FindingCard({ f, evidence, label }: { f: Finding; evidence: Map<string, Evidence>; label: string }) {
  return (
    <article className={s.card} data-kind={f.kind}>
      <span className={s.kicker}>{label}{f.score !== undefined ? ` · ${f.score}/100` : ""}</span>
      <b className={s.title}>{f.title}</b>
      <p className={s.detail}>{f.detail}</p>
      <EvidenceChips ids={f.evidence} evidence={evidence}
        emptyReason={f.kind === "gap" ? "this is the gap; the named evidence task obtains it." : "no source recorded for this finding."} />
    </article>
  );
}

// ---------------------------------------------------------------- view

export default function OwnerPlanView({ owner }: { owner: OwnerPlanState }) {
  const { plan, asOf, draft } = owner;
  const asOfDay = asOf.slice(0, 10);
  const evidence = useMemo(() => new Map(plan.evidence.map((e) => [e.id, e])), [plan.evidence]);
  const taskById = useMemo(() => new Map(plan.tasks.map((t) => [t.id, t])), [plan.tasks]);
  const priority = useMemo(() => new Map(plan.tasks.map((t, i) => [t.id, i + 1])), [plan.tasks]);
  const next = plan.nextTaskId ? taskById.get(plan.nextTaskId) ?? null : null;

  const risks = plan.findings.filter((f) => f.kind === "risk").slice(0, 2);
  const sustainability = plan.findings.find((f) => f.kind === "sustainability") ?? null;
  const gaps = plan.findings.filter((f) => f.kind === "gap");
  const riskFacts = plan.facts.filter((f) => f.id.startsWith("f.risk."));
  const deadlines = plan.deadlines.slice(0, 5);
  const estimates = deadlines.length ? [] : plan.tasks.filter((t) => t.status !== "done" && t.due).sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0)).slice(0, 3);
  const byStage = STAGE_ORDER.map((stage) => ({ stage, tasks: plan.tasks.filter((t) => t.stage === stage) })).filter((g) => g.tasks.length);
  const selected = plan.options.find((o) => o.id === plan.selectedOption) ?? null;
  const safeKey = planKey(plan.target).replace(/[^A-Za-z0-9._-]+/g, "_");

  const issues: React.ReactNode[] = [];
  if (owner.loadStatus === "corrupt") issues.push(<li key="corrupt">The saved draft for this location could not be read, so the plan starts without edits. Your next edit replaces it.</li>);
  if (owner.loadStatus === "key_mismatch") issues.push(<li key="mismatch">The saved draft belongs to a different location and was not applied.</li>);
  if (owner.saveFailed) issues.push(<li key="save">This browser refused to save the draft (storage full or blocked). Edits stay in this tab only.</li>);
  if (plan.draft.rejected) issues.push(<li key="rejected">{plan.draft.rejected}</li>);
  if (owner.orphanedOption) issues.push(<li key="opt">Your selected option <code>{owner.orphanedOption}</code> is no longer offered; the plan shows no selection until you pick one.</li>);
  if (owner.changedUnderEdit.length) {
    issues.push(
      <li key="changed">
        The planner changed {owner.changedUnderEdit.length === 1 ? "this task" : "these tasks"} since you edited {owner.changedUnderEdit.length === 1 ? "it" : "them"}; your edits still apply, check them:{" "}
        {owner.changedUnderEdit.map((id, i) => (
          <span key={id}>{i ? ", " : ""}<button type="button" className={s.link} onClick={() => focusById(domId("task", id))}>{taskById.get(id)?.title ?? id}</button></span>
        ))}
      </li>,
    );
  }
  for (const o of plan.draft.orphaned) {
    const e = o.edit;
    const parts = [e.owner !== undefined && `owner "${e.owner}"`, e.due && `due ${e.due}`, e.status && `status ${STATUS_LABEL[e.status]}`, e.notes && `notes "${e.notes}"`].filter(Boolean).join(", ");
    issues.push(
      <li key={`orphan-${o.taskId}`}>
        Edit kept for <code>{o.taskId}</code> ({parts || "no fields"}): this {plan.scenario} plan does not generate that task. It applies again when the task returns.{" "}
        <button type="button" className={s.btnSmall} onClick={() => owner.discardEdit(o.taskId)}>Discard this edit</button>
      </li>,
    );
  }

  return (
    <div className={s.root}>
      <section className={s.mywork} aria-labelledby="op-mywork">
        <div className={s.headRow}>
          <h3 id="op-mywork">My work</h3>
          <span className={s.scenario} data-heat={plan.scenario === "heatwave"}>{plan.scenario === "heatwave" ? "105 °F heatwave" : "Baseline"}</span>
        </div>
        <p className={s.meta}>Electric sector · as of {asOfDay} · {plan.target.label}</p>

        <div className={s.next}>
          <span className={s.label}>Next action</span>
          {next ? (
            <>
              <b className={s.title}>{next.title}</b>
              <span className={s.meta}>
                Owner: {next.owner ? next.owner : <>{next.role} <em>(not assigned)</em></>} · Due {next.due ?? "not scheduled"}
              </span>
              <button type="button" className={s.btn} onClick={() => focusById(domId("task", next.id))}>Open task</button>
            </>
          ) : (
            <span className={s.unknown}>No task is ready: every open task waits on another task or is marked waiting, blocked or done.</span>
          )}
        </div>

        <div className={s.block}>
          <span className={s.label}>Waiting on</span>
          {plan.waitingOn.length ? (
            <ul className={s.list}>{plan.waitingOn.map((w) => <li key={w}>{w}</li>)}</ul>
          ) : <p className={s.meta}>Nothing is marked waiting or blocked.</p>}
        </div>

        <div className={s.block}>
          <span className={s.label}>Upcoming deadlines</span>
          {deadlines.length ? (
            <ul className={s.list}>
              {deadlines.map((d) => {
                const t = taskById.get(d.taskId);
                return (
                  <li key={`${d.taskId}-${d.kind}`}>
                    <b className={d.due < asOfDay ? s.overdue : undefined}>{d.due}{d.due < asOfDay ? " (past)" : ""}</b> {deadlineKindLabel(d.kind)}: {t ? t.title : d.taskId}
                  </li>
                );
              })}
            </ul>
          ) : (
            <>
              <p className={s.meta}>No dated deadlines: this scan carries no milestones. Set a due date on a task to add one.</p>
              {estimates.length ? (
                <ul className={s.list} aria-label="Planner estimates">
                  {estimates.map((t) => <li key={t.id}><b>{t.due}</b> {t.title} <em>(planner estimate, not a deadline)</em></li>)}
                </ul>
              ) : null}
            </>
          )}
        </div>
      </section>

      {issues.length ? (
        <div className={s.banner} role="status" aria-live="polite">
          <b>Draft notices</b>
          <ul>{issues}</ul>
        </div>
      ) : null}

      <section className={s.section} aria-labelledby="op-findings">
        <h3 id="op-findings">Findings</h3>
        {risks.length ? risks.map((f, i) => <FindingCard key={f.id} f={f} evidence={evidence} label={`Risk ${i + 1}`} />)
          : <p className={s.unknown}>No risk finding: the scan produced no scored risk.</p>}
        {riskFacts.length ? (
          <details className={s.details}>
            <summary>Risk factors ({plan.scenario})</summary>
            <ul className={s.list}>
              {riskFacts.map((f) => <li key={f.id}>{f.predicate.replace(/^risk_factor_|^risk_/, "").replace(/_/g, " ")}: {factValueText(f.value, f.unit)} <em>({PROVENANCE_LABEL[f.provenance]})</em></li>)}
            </ul>
          </details>
        ) : null}
        {sustainability ? <FindingCard f={sustainability} evidence={evidence} label="Sustainability opportunity" />
          : <p className={s.unknown}>No sustainability opportunity: not assessed for this scan (see gaps).</p>}
        {gaps.length ? (
          <>
            <h4 className={s.subhead}>Evidence gaps ({gaps.length})</h4>
            {gaps.map((f) => <FindingCard key={f.id} f={f} evidence={evidence} label="Gap" />)}
          </>
        ) : null}
      </section>

      <section className={s.section} aria-labelledby="op-options">
        <h3 id="op-options">Options</h3>
        <fieldset className={s.options}>
          <legend>
            {selected ? (draft.selectedOption ? "Your selected option" : "Provisional option (planner assumption)") : "Choose an option to expand its delivery tasks"}
          </legend>
          {plan.options.map((o) => (
            <div key={o.id} className={s.option} data-selected={o.id === plan.selectedOption}>
              <label className={s.radio}>
                <input type="radio" name="op-option" value={o.id} checked={o.id === plan.selectedOption} onChange={() => owner.selectOption(o.id)} />
                <span><b>{OPTION_KIND_LABEL[o.kind]}</b> {o.title}</span>
              </label>
              <p className={s.detail}>{o.tradeoffs}</p>
              {o.assumptions.length ? (
                <ul className={s.list} aria-label={`Assumptions for ${o.title}`}>
                  {o.assumptions.map((a) => <li key={a.id}>{a.predicate.replace(/_/g, " ")}: {factValueText(a.value, a.unit)} <em>({PROVENANCE_LABEL[a.provenance]})</em></li>)}
                </ul>
              ) : <p className={s.unknown}>No assumptions recorded for this option.</p>}
            </div>
          ))}
        </fieldset>
      </section>

      <section className={s.section} aria-labelledby="op-tasks">
        <h3 id="op-tasks">Tasks by stage</h3>
        <p className={s.meta}>Priority numbers follow the {plan.scenario} plan. Owner, due date, status and notes save to this browser for this location and radius.</p>
        {byStage.map(({ stage, tasks }) => (
          <div key={stage} className={s.stage}>
            <h4 className={s.subhead}>{STAGE_LABEL[stage]} <span>· {tasks.length} task{tasks.length === 1 ? "" : "s"}</span></h4>
            <ol className={s.tasks}>
              {tasks.map((t) => <TaskRow key={t.id} t={t} owner={owner} isNext={t.id === plan.nextTaskId} rank={priority.get(t.id)!} titleOf={(id) => taskById.get(id)?.title ?? id} />)}
            </ol>
          </div>
        ))}
      </section>

      <details className={s.details} id="op-register">
        <summary>Evidence and facts register ({plan.evidence.length} evidence, {plan.facts.length} facts)</summary>
        <ul className={s.list}>
          {plan.evidence.map((e) => (
            <li key={e.id} id={domId("ev", e.id)} tabIndex={-1}>
              <span className={s.chip} data-prov={e.provenance}><b>{PROVENANCE_LABEL[e.provenance]}</b> {e.kind}</span>{" "}
              {e.title} · {e.source.publisher}{e.source.locator ? ` (${e.source.locator})` : ""} · retrieved {e.retrievedAt.slice(0, 10)} · {e.freshness}
            </li>
          ))}
        </ul>
        <h4 className={s.subhead}>Facts (linked by id in packets, not retyped)</h4>
        <ul className={s.list}>
          {plan.facts.map((f) => (
            <li key={f.id}><code>{f.id}</code> {f.predicate.replace(/_/g, " ")}: {factValueText(f.value, f.unit)} <em>({PROVENANCE_LABEL[f.provenance]})</em></li>
          ))}
        </ul>
      </details>

      <section className={s.section} aria-labelledby="op-export">
        <h3 id="op-export">Export</h3>
        <div className={s.exports}>
          <button type="button" className={s.btn} onClick={() => download(`owner-plan-${safeKey}.json`, planJson(plan), "application/json")}>Plan JSON</button>
          <button type="button" className={s.btn} onClick={() => download(`owner-evidence-${safeKey}.json`, evidenceJson(plan, asOf), "application/json")}>Evidence JSON</button>
          <button type="button" className={s.btn} onClick={() => download(`owner-deadlines-${safeKey}.ics`, deadlinesIcs(plan, asOf), "text/calendar")}
            aria-describedby="op-ics-note">Calendar (.ics)</button>
        </div>
        <p id="op-ics-note" className={s.meta}>{plan.deadlines.length} dated deadline{plan.deadlines.length === 1 ? "" : "s"} in the calendar.</p>
        <span className={s.label}>Prepared packets (Markdown)</span>
        <div className={s.exports}>
          {stagePackets(plan, asOf).map((p) => (
            <button key={p.stage} type="button" className={s.btnSmall} onClick={() => download(p.filename, p.markdown, "text/markdown")}>{STAGE_LABEL[p.stage]}</button>
          ))}
        </div>
        <p className={s.meta}>Exports organize work. They do not record an approval, award, permit, or eligibility decision.</p>
      </section>
    </div>
  );
}

function TaskRow({ t, owner, isNext, rank, titleOf }: { t: OwnerTaskWithNotes; owner: OwnerPlanState; isNext: boolean; rank: number; titleOf: (id: string) => string }) {
  const id = domId("task", t.id);
  const edit = owner.draft.edits[t.id];
  const handoff = t.owner
    ? t.status === "not_started"
      ? { text: `Handed to ${t.owner}: not acknowledged yet`, ack: false }
      : { text: `Handed to ${t.owner}: acknowledged (status ${STATUS_LABEL[t.status].toLowerCase()})`, ack: true }
    : null;
  return (
    <li id={id} tabIndex={-1} className={s.task} data-next={isNext} data-status={t.status} aria-labelledby={`${id}-title`}>
      <div className={s.taskHead}>
        <span className={s.rank} aria-label={`Priority ${rank}`}>#{rank}</span>
        <b id={`${id}-title`} className={s.title}>{t.title}</b>
      </div>
      <p className={s.meta}>
        {isNext ? <span className={s.chip} data-prov="next">Next action</span> : null}{" "}
        {t.code ? <code>{t.code}</code> : null} · {t.role}{t.gate ? ` · gate ${t.gate}` : ""}
      </p>
      {t.dependsOn.length ? <p className={s.meta}>After: {t.dependsOn.map(titleOf).join("; ")}</p> : null}
      {handoff ? (
        <p className={s.handoff} data-ack={handoff.ack}>
          {handoff.text}
          {!handoff.ack ? <> <button type="button" className={s.btnSmall} onClick={() => owner.editTask(t.id, { status: "in_progress" })}>Acknowledge</button></> : null}
        </p>
      ) : null}
      <div className={s.taskGrid}>
        <CommitField id={`${id}-owner`} label="Owner" value={t.owner ?? ""} placeholder={t.role}
          onCommit={(v) => owner.editTask(t.id, { owner: v.trim() ? v.trim() : undefined })} />
        <label className={s.field} htmlFor={`${id}-due`}>
          <span>Due{edit?.due ? " (yours)" : " (planned)"}</span>
          <input id={`${id}-due`} type="date" value={t.due ?? ""} onChange={(e) => owner.editTask(t.id, { due: e.target.value || undefined })} />
        </label>
        <label className={s.field} htmlFor={`${id}-status`}>
          <span>Status</span>
          <select id={`${id}-status`} value={t.status} onChange={(e) => owner.editTask(t.id, { status: e.target.value as TaskStatus })}>
            {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
          </select>
        </label>
      </div>
      <CommitField id={`${id}-notes`} label="Notes" value={t.notes ?? ""} multiline onCommit={(v) => owner.editTask(t.id, { notes: v ? v : undefined })} />
      <details className={s.details}>
        <summary>Deliverable, acceptance and recovery</summary>
        <p className={s.detail}><b>Deliverable:</b> {t.output}</p>
        <p className={s.detail}><b>Inputs:</b> {t.inputs.join("; ") || "none listed"}</p>
        <p className={s.detail}><b>Acceptance evidence:</b> {t.evidence.join("; ") || "none listed"}</p>
        <p className={s.detail}><b>Recovery:</b> {t.recovery}</p>
      </details>
    </li>
  );
}
