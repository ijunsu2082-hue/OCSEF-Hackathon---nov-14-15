"use client";

import { useId, useState } from "react";
import type { Claim, Deadline, Obligation, Task, TaskStatus } from "@/lib/owner/types";
import { downloadText, fmtDate, groupByMonth, monthLabel, prefillCsv, slug, urgency, type Urgency } from "./calendar";
import { BTN, CopyButton, FOCUS, FREQUENCY_WORD, INPUT, LINK, api, ConfidenceText } from "./ui";

/*
 * 12-month filing timeline across all verified assets, grouped by month.
 * Overdue items are red (#dc2626), items due within 30 days amber (#b45309) with the word "Soon".
 */

export interface TimelineEntry {
  key: string; // claim_id|obligation_id|due
  claim: Claim;
  assetName: string;
  obligation: Obligation;
  deadline: Deadline;
  task: Task | null;
}

const STATUS_WORD: Record<TaskStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  filed: "Filed",
};

const URGENCY: Record<Urgency, { word: string; color: string } | null> = {
  overdue: { word: "Overdue", color: "#dc2626" },
  soon: { word: "Soon", color: "#b45309" },
  later: null,
  done: { word: "Filed", color: "#556070" },
};

export function PrefillTable({ o, assetName }: { o: Obligation; assetName: string }) {
  if (o.prefill.length === 0) {
    return <p className="mt-2 text-[13px] text-[#556070]">No fields could be prefilled from public data for this filing.</p>;
  }
  return (
    <div className="mt-2">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-[#e6e9ee] text-[#556070]">
            <th scope="col" className="py-1.5 pr-3 font-medium">Field</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Value</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Source</th>
            <th scope="col" className="py-1.5 font-medium"><span className="sr-only">Copy</span></th>
          </tr>
        </thead>
        <tbody>
          {o.prefill.map((f, i) => (
            <tr key={`${f.label}|${i}`} className="border-b border-[#e6e9ee] align-top">
              <td className="py-1.5 pr-3 text-[#556070]">{f.label}</td>
              <td className="py-1.5 pr-3 font-semibold tabular-nums text-[#1d2733]">{f.value}</td>
              <td className="py-1.5 pr-3 text-[#6b7583]">{f.source}</td>
              <td className="py-1.5 text-right">
                <CopyButton text={f.value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className={`${BTN} mt-3`}
        onClick={() => downloadText(`${slug(assetName)}-${slug(o.form)}-prefilled.csv`, "text/csv;charset=utf-8", prefillCsv(o.prefill))}
      >
        Download prefilled sheet (CSV)
      </button>
    </div>
  );
}

function Citations({ o }: { o: Obligation }) {
  if (o.citations.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-[13px] font-medium text-[#556070]">Rules and sources</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {o.citations.map((c) => (
          <li key={c.url + c.label} className="text-[13px]">
            <a href={c.url} target="_blank" rel="noopener noreferrer" className={LINK}>
              {c.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Item({ e, today, onSaved }: { e: TimelineEntry; today: string; onSaved: (key: string, t: Task) => void }) {
  const { obligation: o, deadline: d } = e;
  const [status, setStatus] = useState<TaskStatus>(e.task?.status ?? "not_started");
  const [confirmation, setConfirmation] = useState(e.task?.confirmation ?? "");
  const [save, setSave] = useState<{ state: "idle" | "saving" | "saved" | "error"; msg?: string }>({ state: "idle" });
  const ids = useId();
  const u = urgency(d.due, today, status === "filed");
  const tag = URGENCY[u];

  const put = async (next: TaskStatus, conf: string) => {
    setSave({ state: "saving" });
    try {
      const res = await api<{ task: Task }>("/api/owner/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claim_id: e.claim.id,
          obligation_id: o.id,
          due: d.due,
          status: next,
          ...(conf.trim() ? { confirmation: conf.trim() } : {}),
        }),
      });
      onSaved(e.key, res.task);
      setSave({ state: "saved" });
    } catch (err) {
      setSave({ state: "error", msg: err instanceof Error ? err.message : "Could not save" });
    }
  };

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h4 className="min-w-0 text-[15px] font-semibold leading-snug">{o.title}</h4>
        <p className="shrink-0 text-[14px] tabular-nums">
          Due <span className="font-semibold">{fmtDate(d.due)}</span>
          {tag && (
            <span className="ml-2 font-semibold" style={{ color: tag.color }}>
              {tag.word}
            </span>
          )}
        </p>
      </div>
      <p className="mt-0.5 text-[13px] leading-snug text-[#556070]">
        {o.form} · {o.agency}
      </p>
      <p className="mt-0.5 text-[13px] leading-snug text-[#556070]">
        {e.assetName} · {d.periodLabel} · {FREQUENCY_WORD[o.frequency]} · <ConfidenceText c={o.confidence} />
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${ids}-status`} className="block text-[13px] font-medium text-[#556070]">
            Status
          </label>
          <select
            id={`${ids}-status`}
            value={status}
            onChange={(ev) => {
              const next = ev.target.value as TaskStatus;
              setStatus(next);
              void put(next, confirmation);
            }}
            className={`mt-1 h-9 rounded-[6px] border border-[#e6e9ee] bg-white px-2 text-[14px] text-[#1d2733] ${FOCUS}`}
          >
            {(Object.keys(STATUS_WORD) as TaskStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_WORD[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[12rem] flex-1">
          <label htmlFor={`${ids}-conf`} className="block text-[13px] font-medium text-[#556070]">
            Confirmation number
          </label>
          <input
            id={`${ids}-conf`}
            value={confirmation}
            onChange={(ev) => setConfirmation(ev.target.value)}
            placeholder="From the agency's receipt"
            className={`${INPUT} mt-1 h-9`}
          />
        </div>
        <button type="button" className={BTN} disabled={save.state === "saving"} onClick={() => void put(status, confirmation)}>
          Save
        </button>
        <span aria-live="polite" className="text-[13px] text-[#556070]">
          {save.state === "saving" ? "Saving…" : save.state === "saved" ? "Saved" : ""}
        </span>
      </div>
      {save.state === "error" && (
        <p role="alert" className="mt-1 text-[13px] text-[#dc2626]">
          {save.msg}
        </p>
      )}

      <details className="mt-3 rounded-[6px] border border-[#e6e9ee] px-3 py-2">
        <summary className={`cursor-pointer text-[14px] font-medium text-[#0369a1] ${FOCUS}`}>Prefilled for you</summary>
        <PrefillTable o={o} assetName={e.assetName} />
        <p className="mt-3 text-[13px] leading-snug text-[#556070]">Why this applies: {o.appliesBecause}</p>
        <p className="mt-1 text-[13px] leading-snug text-[#556070]">When it is due: {o.dueRule}</p>
        {o.notes && <p className="mt-1 text-[13px] leading-snug text-[#556070]">{o.notes}</p>}
        <Citations o={o} />
      </details>

      <p className="mt-2 text-[14px]">
        <a href={o.formUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
          Open the official form
        </a>
      </p>
    </li>
  );
}

export function Timeline({
  entries,
  today,
  onSaved,
}: {
  entries: TimelineEntry[];
  today: string;
  onSaved: (key: string, t: Task) => void;
}) {
  const months = groupByMonth(entries.map((e) => ({ ...e, due: e.deadline.due })));
  if (months.length === 0) {
    return <p className="text-[14px] text-[#556070]">No dated filings in the next 12 months for your verified assets.</p>;
  }
  return (
    <ol className="flex flex-col gap-6">
      {months.map((m) => (
        <li key={m.month}>
          <h3 className="border-b border-[#e6e9ee] pb-2 text-[15px] font-semibold">{monthLabel(m.month)}</h3>
          <ul className="divide-y divide-[#e6e9ee]">
            {m.items.map((e) => (
              <Item key={e.key} e={e} today={today} onSaved={onSaved} />
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/** Obligations with no fixed date (event-driven or one-time). */
export function Undated({ items }: { items: { key: string; assetName: string; obligation: Obligation }[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="divide-y divide-[#e6e9ee] border-y border-[#e6e9ee]">
      {items.map(({ key, assetName, obligation: o }) => (
        <li key={key} className="py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h4 className="min-w-0 text-[15px] font-semibold leading-snug">{o.title}</h4>
            <ConfidenceText c={o.confidence} />
          </div>
          <p className="mt-0.5 text-[13px] leading-snug text-[#556070]">
            {o.form} · {o.agency} · {assetName}
          </p>
          <p className="mt-1 text-[14px] leading-snug text-[#1d2733]">{o.dueRule}</p>
          <details className="mt-3 rounded-[6px] border border-[#e6e9ee] px-3 py-2">
            <summary className={`cursor-pointer text-[14px] font-medium text-[#0369a1] ${FOCUS}`}>Prefilled for you</summary>
            <PrefillTable o={o} assetName={assetName} />
            <p className="mt-3 text-[13px] leading-snug text-[#556070]">Why this applies: {o.appliesBecause}</p>
            {o.notes && <p className="mt-1 text-[13px] leading-snug text-[#556070]">{o.notes}</p>}
            <Citations o={o} />
          </details>
          <p className="mt-2 text-[14px]">
            <a href={o.formUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
              Open the official form
            </a>
          </p>
        </li>
      ))}
    </ul>
  );
}
