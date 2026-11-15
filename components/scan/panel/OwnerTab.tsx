"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReportTarget } from "@/lib/scan/target";
import { KIND_WORD, assetName, claimHref, fromTarget } from "@/components/owner/assets";
import { daysBetween, fmtDate, todayIso } from "@/components/owner/calendar";
import { deadlinesIn, nextDeadline, previewFor } from "@/components/owner/engine";
import { FREQUENCY_WORD } from "@/components/owner/ui";
import type { Deadline, Obligation } from "@/lib/owner/types";
import {
  applicableOnly,
  determineAll,
  loadFactAnswers,
  loadProgramIndex,
  saveFactAnswers,
  summarize,
  type Determination,
  type FactAnswer,
  type FactAnswers,
  type ProgramIndex,
} from "@/lib/owner/applicability";
import {
  loadFormCatalog,
  resolveWorksheets,
  worksheetCoverage,
  type ExtractionStatus,
  type FormCatalog,
  type FormWorksheet,
} from "@/lib/owner/forms";
import { Caption } from "./ui";

/*
 * Compliance tab for one plant, substation or power line.
 *
 * Two things, in this order:
 *   1. The schedule: what has to be filed or signed, and by when.
 *   2. The forms behind those items: what the agency's own page says the form asks
 *      for (lib/owner/forms.ts reads public/compliance/forms.json, which
 *      research/etl/compliance writes), which fields public data fills, and which
 *      ones a person has to fill or sign.
 *
 * Nothing here claims a filing was made. The public preview shows how the rules
 * apply from public data; a verified owner gets the full calendar at /owner.
 */

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";
const LINK = `text-[#0369a1] underline-offset-2 hover:underline ${FOCUS}`;

interface ScheduleRow {
  key: string;
  due: string;
  obligation: Obligation;
  deadline: Deadline;
  action: "file" | "sign";
}

const STATUS_WORD: Record<ExtractionStatus, string> = {
  extracted: "Read from the agency page",
  partial: "Form known, field list partly read",
  manual: "Open the form: fields not read yet",
};

function DueTag({ due, today }: { due: string; today: string }) {
  const days = daysBetween(today, due);
  if (days < 0) {
    return <span className="font-semibold text-[#dc2626]">{Math.abs(days)} d overdue</span>;
  }
  if (days <= 30) return <span className="font-semibold text-[#b45309]">in {days} d</span>;
  return <span className="text-[#556070]">in {days} d</span>;
}

/** The decision itself, with the fact that settles it and where it came from. */
function DecisionLine({ d }: { d: Determination }) {
  const word =
    d.applicability === "applies" ? "Applies" : d.applicability === "does_not_apply" ? "Does not apply" : "Not settled yet";
  return (
    <p className="mt-1 text-[13px] leading-snug text-[#556070]">
      <span className="font-semibold text-[#1d2733]">{word}.</span> {d.basis}
      {d.source ? <span className="text-[#6b7583]"> Source: {d.source}.</span> : null}
    </p>
  );
}

function ApplicabilityBadge({
  d,
  onAnswer,
  onClear,
}: {
  d: Determination;
  onAnswer: (id: string, answer: FactAnswer) => void;
  onClear: (id: string) => void;
}) {
  if (d.applicability === "applies" || d.applicability === "does_not_apply") {
    const answered = !!d.source?.startsWith("Your answer");
    return (
      <span className="flex items-baseline gap-2 text-[13px] font-medium">
        <span className={d.applicability === "applies" ? "text-[#0369a1]" : "text-[#556070]"}>
          {d.applicability === "applies" ? "Applies" : "Does not apply"}
        </span>
        {answered && (
          <button type="button" onClick={() => onClear(d.obligationId)} className={`text-[13px] font-normal ${LINK}`}>
            change
          </button>
        )}
      </span>
    );
  }
  const q = d.question;
  if (!q) return null;
  return (
    <span className="flex flex-col items-start gap-1 text-[13px]">
      <span className="font-medium text-[#1d2733]">One fact needed: {q.question}</span>
      <span className="flex gap-2">
        <button
          type="button"
          onClick={() => onAnswer(q.id, "yes")}
          className={`h-7 rounded-[6px] border border-[#e6e9ee] bg-white px-2 text-[13px] font-medium text-[#1d2733] hover:bg-[#f6f8fa] ${FOCUS}`}
        >
          Yes
        </button>
        <button
          type="button"
          onClick={() => onAnswer(q.id, "no")}
          className={`h-7 rounded-[6px] border border-[#e6e9ee] bg-white px-2 text-[13px] font-medium text-[#1d2733] hover:bg-[#f6f8fa] ${FOCUS}`}
        >
          No
        </button>
      </span>
    </span>
  );
}

function Worksheet({
  w,
  assetLabel,
  determination,
  onAnswer,
  onClear,
}: {
  w: FormWorksheet;
  assetLabel: string;
  determination: Determination;
  onAnswer: (id: string, answer: FactAnswer) => void;
  onClear: (id: string) => void;
}) {
  const form = w.form;
  const status = form?.status ?? "manual";
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h4 className="min-w-0 text-[15px] font-semibold leading-snug">{w.obligation.title}</h4>
        <ApplicabilityBadge d={determination} onAnswer={onAnswer} onClear={onClear} />
      </div>
      <DecisionLine d={determination} />
      <p className="mt-0.5 text-[13px] leading-snug text-[#556070]">
        {form?.form ?? w.obligation.form} · {form?.agency ?? w.obligation.agency}
        {form ? ` · ${form.jurisdiction}` : ""}
      </p>
      <p className="mt-0.5 text-[13px] leading-snug text-[#6b7583]">
        {FREQUENCY_WORD[w.obligation.frequency]} ·{" "}
        {form?.action === "sign" ? "Signed by an authorized official" : "Filed by the owner"} · {STATUS_WORD[status]}
      </p>

      <p className="mt-2 text-[14px] font-semibold">Prefilled from public data</p>
      {w.prefilled.length === 0 ? (
        <p className="mt-1 text-[14px] text-[#556070]">
          No field on this form could be filled from public data for {assetLabel}.
        </p>
      ) : (
        <table className="mt-1 w-full border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-[#e6e9ee] text-[#556070]">
              <th scope="col" className="py-1.5 pr-3 font-medium">Field on the form</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Value</th>
              <th scope="col" className="py-1.5 font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {w.prefilled.map((f, i) => (
              <tr key={`${f.label}|${i}`} className="border-b border-[#e6e9ee] align-top">
                <td className="py-1.5 pr-3 text-[#556070]">{f.label}</td>
                <td className="py-1.5 pr-3 font-semibold tabular-nums text-[#1d2733]">{f.value}</td>
                <td className="py-1.5 text-[#6b7583]">{f.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {w.awaiting.length > 0 && (
        <div className="mt-3">
          <p className="text-[14px] font-semibold">Needs your input</p>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-[13px] leading-snug text-[#556070]">
            {w.awaiting.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </div>
      )}

      {form && form.evidence.length > 0 && (
        <details className="mt-3 rounded-[6px] border border-[#e6e9ee] px-3 py-2">
          <summary className={`cursor-pointer text-[14px] font-medium ${LINK}`}>
            What the agency page said
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {form.evidence.map((e, i) => (
              <li key={`${e.url}|${i}`} className="text-[13px] leading-snug text-[#556070]">
                <span className="block">&ldquo;{e.excerpt}&rdquo;</span>
                <a href={e.url} target="_blank" rel="noopener noreferrer" className={LINK}>
                  {e.url}
                </a>
              </li>
            ))}
          </ul>
          {form.dueText && <p className="mt-2 text-[13px] leading-snug text-[#556070]">Deadline text: {form.dueText}</p>}
        </details>
      )}

      <p className="mt-2 text-[13px] leading-snug text-[#556070]">The rule: {w.obligation.appliesBecause}</p>
      <p className="mt-1 text-[13px] leading-snug text-[#556070]">When it is due: {w.obligation.dueRule}</p>
      {w.obligation.notes && <p className="mt-1 text-[13px] leading-snug text-[#556070]">{w.obligation.notes}</p>}

      <p className="mt-2 text-[14px]">
        <a href={w.obligation.formUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
          Open the official form
        </a>
      </p>
    </li>
  );
}

export default function OwnerTab({ target }: { target: ReportTarget | null }) {
  const asset = fromTarget(target);
  const [catalog, setCatalog] = useState<FormCatalog | null>(null);
  const [index, setIndex] = useState<ProgramIndex | null>(null);
  const [answers, setAnswers] = useState<FactAnswers>({});
  const today = todayIso();

  // The ETL snapshots: forms read from the agencies' own pages, and the agency
  // program lists that decide which filings apply.
  useEffect(() => {
    let alive = true;
    loadFormCatalog().then((next) => {
      if (alive) setCatalog(next);
    });
    loadProgramIndex().then((next) => {
      if (alive) setIndex(next);
    });
    setAnswers(loadFactAnswers());
    return () => {
      alive = false;
    };
  }, []);

  const answerFact = (id: string, answer: FactAnswer) => {
    setAnswers((prev) => {
      const next = { ...prev, [id]: { answer, at: new Date().toISOString() } };
      saveFactAnswers(next);
      return next;
    });
  };

  const clearFact = (id: string) => {
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[id];
      saveFactAnswers(next);
      return next;
    });
  };

  const obligations = useMemo(() => (asset ? previewFor(asset) : []), [asset]);
  const determinations = useMemo(
    () => (asset ? determineAll(asset, obligations, index, answers) : {}),
    [asset, obligations, index, answers],
  );
  const applicable = useMemo(() => applicableOnly(obligations, determinations), [obligations, determinations]);
  const setAside = useMemo(
    () => obligations.filter((o) => determinations[o.id]?.applicability === "does_not_apply"),
    [obligations, determinations],
  );
  const counts = useMemo(
    () => summarize(obligations.map((o) => determinations[o.id]).filter(Boolean)),
    [obligations, determinations],
  );

  const rows = useMemo(() => {
    if (!asset) return [];
    return applicable.map((o) => ({ o, schedule: deadlinesIn(o, today, 12).slice(0, 3), next: nextDeadline(o, today) }));
  }, [asset, applicable, today]);

  const worksheets = useMemo(
    () => (asset ? resolveWorksheets(asset, rows.map((r) => r.o), catalog) : []),
    [asset, rows, catalog],
  );
  const worksheetById = useMemo(() => new Map(worksheets.map((w) => [w.obligation.id, w])), [worksheets]);
  const coverage = useMemo(() => worksheetCoverage(worksheets), [worksheets]);

  const schedule = useMemo<ScheduleRow[]>(() => {
    const out: ScheduleRow[] = [];
    for (const { o, schedule: dueDates } of rows) {
      const action = worksheetById.get(o.id)?.form?.action ?? "file";
      for (const d of dueDates) out.push({ key: `${o.id}|${d.due}`, due: d.due, obligation: o, deadline: d, action });
    }
    return out.sort((a, b) => a.due.localeCompare(b.due)).slice(0, 10);
  }, [rows, worksheetById]);

  return (
    <div className="text-[15px] leading-snug text-[#1d2733]">
      <p role="note" className="px-6 pt-5 pb-4 text-[14px] leading-snug text-[#1d2733]">
        <span className="font-semibold">Emergency (fire, sparks, a wire down, someone hurt)? </span>
        <a href="tel:911" className={`font-semibold ${LINK}`}>
          Call 911 now.
        </a>
      </p>

      {!asset ? (
        <section className="border-t border-[#e6e9ee] px-6 py-6">
          <h3 className="text-[15px] font-semibold leading-snug">Compliance</h3>
          <p className="mt-2 text-[14px] leading-relaxed text-[#556070]">
            Click a power plant, substation or power line on the map to see what its owner must file or sign,
            the deadlines, and the forms themselves with the fields public data can fill in.
          </p>
        </section>
      ) : (
        <>
          <section className="border-t border-[#e6e9ee] px-6 py-6" aria-labelledby="compliance-title">
            <p className="text-[13px] text-[#6b7583]">{KIND_WORD[asset.kind]}</p>
            <h3 id="compliance-title" className="mt-0.5 text-[16px] font-semibold leading-snug">
              {assetName(asset)}
            </h3>
            <Caption className="mt-1">
              Public preview. Forms and fields are read from the agencies&apos; own pages; nothing here is filed for you.
            </Caption>
          </section>

          <section className="border-t border-[#e6e9ee] px-6 py-6" aria-labelledby="compliance-schedule">
            <h3 id="compliance-schedule" className="text-[16px] font-semibold leading-snug">
              Compliance schedule
            </h3>
            <Caption className="mt-1">
              What has to be filed or signed, in date order. Dates follow each agency&apos;s published rule.
            </Caption>
            {obligations.length > 0 && (
              <p className="mt-2 text-[14px] leading-snug text-[#1d2733]">
                We checked the {obligations.length} filing{obligations.length === 1 ? "" : "s"} in our list against this
                asset: {counts.applies} appl{counts.applies === 1 ? "ies" : "y"}, {counts.doesNotApply} do
                {counts.doesNotApply === 1 ? "es" : ""} not apply, and {counts.needsFact} need
                {counts.needsFact === 1 ? "s" : ""} one fact from you.
              </p>
            )}
            {schedule.length === 0 ? (
              <p className="mt-3 text-[14px] leading-relaxed text-[#556070]">
                No dated filing in our list matches this asset&apos;s public data in the next 12 months.
              </p>
            ) : (
              <table className="mt-3 w-full border-collapse text-left text-[14px]">
                <thead>
                  <tr className="border-b border-[#e6e9ee] text-[13px] text-[#556070]">
                    <th scope="col" className="py-2 pr-3 font-medium">Due</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Form</th>
                    <th scope="col" className="py-2 pr-3 font-medium">What to do</th>
                    <th scope="col" className="py-2 font-medium">Agency</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((row) => (
                    <tr key={row.key} className="border-b border-[#e6e9ee] align-top">
                      <td className="py-2.5 pr-3 whitespace-nowrap tabular-nums">
                        <span className="block font-semibold">{fmtDate(row.due)}</span>
                        <span className="block text-[13px]">
                          <DueTag due={row.due} today={today} />
                        </span>
                      </td>
                      <td className="py-2.5 pr-3">
                        {worksheetById.get(row.obligation.id)?.form?.form ?? row.obligation.form}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className="block font-medium">
                          {row.action === "sign" ? "File and sign" : "File"}: {row.obligation.title}
                        </span>
                        <span className="block text-[13px] text-[#556070]">{row.deadline.periodLabel}</span>
                      </td>
                      <td className="py-2.5 text-[13px] text-[#556070]">{row.obligation.agency}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {rows.some((r) => r.next === null) && (
              <p className="mt-3 text-[13px] leading-snug text-[#6b7583]">
                Some items depend on an event (an incident, a retirement) and have no fixed date; they are listed below with their rule.
              </p>
            )}

            {setAside.length > 0 && (
              <details className="mt-4 rounded-[6px] border border-[#e6e9ee] px-3 py-2">
                <summary className={`cursor-pointer text-[14px] font-medium ${LINK}`}>
                  Set aside: {setAside.length} filing{setAside.length === 1 ? "" : "s"} that do
                  {setAside.length === 1 ? "es" : ""} not apply here
                </summary>
                <ul className="mt-2 flex flex-col gap-2">
                  {setAside.map((o) => (
                    <li key={o.id} className="text-[13px] leading-snug">
                      <span className="font-medium">{o.title}</span>
                      <span className="text-[#556070]"> · {o.form} · {o.agency}</span>
                      <DecisionLine d={determinations[o.id]} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="border-t border-[#e6e9ee] px-6 py-6" aria-labelledby="compliance-forms">
            <h3 id="compliance-forms" className="text-[16px] font-semibold leading-snug">
              Government forms for this asset
            </h3>
            <Caption className="mt-1">
              {catalog
                ? `Form pages read ${fmtDate(catalog.generated_at.slice(0, 10))}. ${coverage.filled} field${
                    coverage.filled === 1 ? "" : "s"
                  } can be filled from public data; ${coverage.manual} need${
                    coverage.manual === 1 ? "s" : ""
                  } a person.`
                : "The form extraction has not run yet, so only the filing rules are shown. Run npm run compliance:forms."}
            </Caption>

            {worksheets.length === 0 ? (
              <p className="mt-3 text-[14px] leading-relaxed text-[#556070]">
                No filing in our list matches what public data shows about this asset. An owner can still sign in to check.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col divide-y divide-[#e6e9ee] border-y border-[#e6e9ee]">
                {worksheets.map((w) => (
                  <Worksheet
                    key={w.obligation.id}
                    w={w}
                    assetLabel={assetName(asset)}
                    determination={determinations[w.obligation.id]}
                    onAnswer={answerFact}
                    onClear={clearFact}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="border-t border-[#e6e9ee] px-6 py-6">
            <p className="text-[13px] leading-snug text-[#6b7583]">
              Field labels come from the agency&apos;s page for each form. When a page cannot be read (a PDF, a
              blocked page), the item says so and sends you to the form instead of guessing.
            </p>
            <a
              href={claimHref(asset)}
              className={`mt-4 inline-flex min-h-10 items-center justify-center rounded-[6px] bg-[#0ea5e9] px-4 text-[14px] font-semibold text-[#1d2733] transition-colors hover:bg-[#38bdf8] ${FOCUS}`}
            >
              I own this — sign in to manage filings
            </a>
          </section>
        </>
      )}
    </div>
  );
}
