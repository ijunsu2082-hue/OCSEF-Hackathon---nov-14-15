"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ReportTarget } from "@/lib/scan/target";
import { KIND_WORD, assetName, claimHref, fromTarget } from "@/components/owner/assets";
import { daysBetween, fmtDate, todayIso } from "@/components/owner/calendar";
import { deadlinesIn, nextDeadline, previewFor } from "@/components/owner/engine";
import { CopyButton, FREQUENCY_WORD } from "@/components/owner/ui";
import type { Deadline, Obligation } from "@/lib/owner/types";
import {
  applicableOnly,
  determineAll,
  loadFactAnswers,
  loadProgramIndex,
  saveFactAnswers,
  type Determination,
  type FactAnswer,
  type FactAnswers,
  type ProgramIndex,
} from "@/lib/owner/applicability";
import {
  assetFieldValue,
  loadFormCatalog,
  resolveWorksheets,
  type AssetFieldKey,
  type ExtractionStatus,
  type FormCatalog,
  type FormWorksheet,
} from "@/lib/owner/forms";
import { Caption } from "./ui";

/*
 * Compliance tab for one plant, substation or power line.
 *
 * The screen answers three questions in order, and nothing else:
 *   1. Who is this for, and what is next?      (header + "Do these next")
 *   2. What must I file or sign, by cadence?   ("Your filings", one row per filing)
 *   3. What did you rule out, and why?         ("Not yours", one line each)
 *
 * Each filing is one row, not two lists: the decision, its basis, the prefilled fields,
 * the fields only a person can fill, and the agency's own words sit behind the row.
 * Filings are decided by lib/owner/applicability.ts from the asset's facts and the
 * agency lists in public/compliance/applicability.json; form fields come from
 * public/compliance/forms.json, which research/etl/compliance reads.
 *
 * Nothing here claims a filing was made.
 */

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";
const LINK = `text-[#0369a1] underline-offset-2 hover:underline ${FOCUS}`;
const CHIP = "inline-flex items-center rounded-full border border-[#e6e9ee] bg-white px-2 py-0.5 text-[12px] font-medium text-[#556070]";

const STATUS_WORD: Record<ExtractionStatus, string> = {
  extracted: "read from the agency page",
  partial: "field list partly read",
  manual: "open the form to read it",
};

const DETAIL_KEYS: { key: AssetFieldKey; label: string }[] = [
  { key: "plant_name", label: "Name" },
  { key: "plant_code", label: "EIA plant code" },
  { key: "operator", label: "Owner or operator" },
  { key: "county", label: "County" },
  { key: "city", label: "City" },
  { key: "capacity_mw", label: "Capacity" },
  { key: "primary_source", label: "Primary fuel" },
  { key: "voltage_kv", label: "Voltage" },
  { key: "generators", label: "Generators" },
  { key: "latitude", label: "Latitude" },
  { key: "longitude", label: "Longitude" },
];

const GROUPS: { key: string; label: string; hint: string }[] = [
  { key: "monthly", label: "Every month", hint: "One filing a month, same form each time." },
  { key: "quarterly", label: "Every quarter or half year", hint: "Four or two filings a year." },
  { key: "annual", label: "Once a year", hint: "One filing a year, with a fixed date." },
  { key: "event", label: "When something happens", hint: "No fixed date: these follow an event." },
];

function groupOf(o: Obligation): string {
  if (o.frequency === "monthly") return "monthly";
  if (o.frequency === "quarterly" || o.frequency === "semiannual") return "quarterly";
  if (o.frequency === "annual") return "annual";
  return "event";
}

/* ------------------------------------------------------------- small pieces */

function DueTag({ due, today }: { due: string; today: string }) {
  const days = daysBetween(today, due);
  if (days < 0) return <span className="font-semibold text-[#dc2626]">{Math.abs(days)} d overdue</span>;
  if (days === 0) return <span className="font-semibold text-[#b45309]">today</span>;
  if (days <= 30) return <span className="font-semibold text-[#b45309]">in {days} d</span>;
  return <span className="text-[#556070]">in {days} d</span>;
}

/** The decision, the fact behind it, and where that fact came from. */
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

function AnswerButtons({
  d,
  onAnswer,
  onClear,
}: {
  d: Determination;
  onAnswer: (id: string, answer: FactAnswer) => void;
  onClear: (id: string) => void;
}) {
  if (d.applicability !== "needs_fact" || !d.question) {
    return d.source?.startsWith("Your answer") ? (
      <button type="button" onClick={() => onClear(d.obligationId)} className={`text-[13px] ${LINK}`}>
        change your answer
      </button>
    ) : null;
  }
  const q = d.question;
  return (
    <div className="mt-2 rounded-[6px] border border-[#e6e9ee] bg-[#f6f8fa] px-3 py-2">
      <p className="text-[13px] font-medium text-[#1d2733]">{q.question}</p>
      <p className="mt-0.5 text-[13px] leading-snug text-[#556070]">{q.detail}</p>
      <div className="mt-2 flex gap-2">
        {(["yes", "no"] as const).map((answer) => (
          <button
            key={answer}
            type="button"
            onClick={() => onAnswer(q.id, answer)}
            className={`h-7 rounded-[6px] border border-[#e6e9ee] bg-white px-3 text-[13px] font-medium text-[#1d2733] hover:bg-[#eef2f6] ${FOCUS}`}
          >
            {answer === "yes" ? "Yes" : "No"}
          </button>
        ))}
      </div>
    </div>
  );
}

function StatusWord({ d }: { d: Determination }) {
  if (d.applicability === "applies") return <span className="text-[13px] font-medium text-[#0369a1]">Applies</span>;
  if (d.applicability === "does_not_apply")
    return <span className="text-[13px] font-medium text-[#556070]">Does not apply</span>;
  return <span className="text-[13px] font-medium text-[#b45309]">One question</span>;
}

/* ------------------------------------------------------------- one filing */

function FilingRow({
  w,
  d,
  next,
  today,
  onAnswer,
  onClear,
}: {
  w: FormWorksheet;
  d: Determination;
  next: Deadline | null;
  today: string;
  onAnswer: (id: string, answer: FactAnswer) => void;
  onClear: (id: string) => void;
}) {
  const o = w.obligation;
  const form = w.form;
  const total = w.prefilled.length + w.awaiting.length;
  return (
    <details className="group border-b border-[#e6e9ee] py-3 last:border-b-0">
      <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold leading-snug">{o.title}</span>
          <span className="mt-0.5 block text-[13px] leading-snug text-[#556070]">
            {form?.form ?? o.form} · {form?.agency ?? o.agency}
            {next ? ` · next ${fmtDate(next.due)}` : " · no fixed date"}
          </span>
        </span>
        <span className="flex items-baseline gap-3 whitespace-nowrap">
          <StatusWord d={d} />
          {next && (
            <span className="text-[13px]">
              <DueTag due={next.due} today={today} />
            </span>
          )}
        </span>
      </summary>

      <div className="mt-2">
        <p className="text-[13px] text-[#556070]">
          {FREQUENCY_WORD[o.frequency]} ·{" "}
          {form?.action === "sign" ? "Signed by an authorized official" : "Filed by the owner"} ·{" "}
          {w.prefilled.length} of {total} fields prefilled
          {form ? ` · ${STATUS_WORD[form.status]}` : ""}
        </p>
        <DecisionLine d={d} />
        <AnswerButtons d={d} onAnswer={onAnswer} onClear={onClear} />

        {w.prefilled.length > 0 && (
          <div className="mt-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[14px] font-semibold">Prefilled from public data</p>
              <CopyButton
                text={w.prefilled.map((f) => `${f.label}: ${f.value}`).join("\n")}
                label="Copy values"
              />
            </div>
            <table className="mt-1 w-full border-collapse text-left text-[13px]">
              <tbody>
                {w.prefilled.map((f, i) => (
                  <tr key={`${f.label}|${i}`} className="border-b border-[#e6e9ee] align-top last:border-b-0">
                    <td className="py-1 pr-3 text-[#556070]">{f.label}</td>
                    <td className="py-1 pr-3 font-semibold tabular-nums">{f.value}</td>
                    <td className="py-1 text-[#6b7583]">{f.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {w.awaiting.length > 0 && (
          <p className="mt-2 text-[13px] leading-snug text-[#556070]">
            <span className="font-semibold text-[#1d2733]">Only you can fill: </span>
            {w.awaiting.join(" · ")}
          </p>
        )}

        <p className="mt-2 text-[13px] leading-snug text-[#6b7583]">
          Rule: {o.appliesBecause} Due: {o.dueRule}
        </p>
        {o.notes && <p className="mt-1 text-[13px] leading-snug text-[#6b7583]">{o.notes}</p>}

        {form && form.evidence.length > 0 && (
          <details className="mt-2 rounded-[6px] border border-[#e6e9ee] px-3 py-2">
            <summary className={`cursor-pointer text-[13px] font-medium ${LINK}`}>What the agency page said</summary>
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

        <p className="mt-2 text-[14px]">
          <a href={o.formUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
            Open the official form
          </a>
        </p>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------- the tab */

interface Row {
  obligation: Obligation;
  worksheet: FormWorksheet;
  determination: Determination;
  next: Deadline | null;
}

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-t border-[#e6e9ee] px-6 py-6" aria-labelledby={id}>
      <h3 id={id} className="text-[16px] font-semibold leading-snug">
        {title}
      </h3>
      {hint && <Caption className="mt-1">{hint}</Caption>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function OwnerTab({ target }: { target: ReportTarget | null }) {
  const asset = fromTarget(target);
  const [catalog, setCatalog] = useState<FormCatalog | null>(null);
  const [index, setIndex] = useState<ProgramIndex | null>(null);
  const [answers, setAnswers] = useState<FactAnswers>({});
  const today = todayIso();

  useEffect(() => {
    let alive = true;
    loadFormCatalog().then((next) => alive && setCatalog(next));
    loadProgramIndex().then((next) => alive && setIndex(next));
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

  const all = useMemo(() => (asset ? previewFor(asset) : []), [asset]);
  const determinations = useMemo(
    () => (asset ? determineAll(asset, all, index, answers) : {}),
    [asset, all, index, answers],
  );
  const applicable = useMemo(() => applicableOnly(all, determinations), [all, determinations]);
  const setAside = useMemo(
    () => all.filter((o) => determinations[o.id]?.applicability === "does_not_apply"),
    [all, determinations],
  );

  const rows = useMemo<Row[]>(() => {
    if (!asset) return [];
    const worksheets = new Map(resolveWorksheets(asset, applicable, catalog).map((w) => [w.obligation.id, w]));
    return applicable
      .map((o) => {
        const worksheet = worksheets.get(o.id);
        const determination = determinations[o.id];
        const next = nextDeadline(o, today);
        if (!worksheet || !determination) return null;
        return { obligation: o, worksheet, determination, next };
      })
      .filter((r): r is Row => r !== null)
      .sort((a, b) => (a.next?.due ?? "9999").localeCompare(b.next?.due ?? "9999") || a.obligation.title.localeCompare(b.obligation.title));
  }, [asset, applicable, catalog, determinations, today]);

  const upcoming = rows.filter((r) => r.next).slice(0, 3);
  const openQuestions = rows.filter((r) => r.determination.applicability === "needs_fact");
  const covered = rows.reduce((n, r) => n + r.worksheet.prefilled.length, 0);
  const details = useMemo(() => {
    if (!asset) return [];
    return DETAIL_KEYS.map(({ key, label }) => {
      const hit = assetFieldValue(asset, key);
      return hit ? { label, value: hit.value } : null;
    }).filter((d): d is { label: string; value: string } => d !== null);
  }, [asset]);

  const ownerName =
    asset?.kind === "plant"
      ? asset.plant.utility_name
      : asset?.kind === "substation"
        ? asset.substation.operator
        : asset?.line.operator;

  if (!asset) {
    return (
      <div className="text-[15px] leading-snug text-[#1d2733]">
        <section className="px-6 py-6">
          <h3 className="text-[15px] font-semibold leading-snug">Compliance</h3>
          <p className="mt-2 text-[14px] leading-relaxed text-[#556070]">
            Click a power plant, substation or power line on the map. You get one row per filing that applies to it,
            the date it is due, and the fields public data already fills in.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="text-[15px] leading-snug text-[#1d2733]">
      <p role="note" className="px-6 pt-5 pb-4 text-[14px] leading-snug">
        <span className="font-semibold">Emergency (fire, sparks, a wire down, someone hurt)? </span>
        <a href="tel:911" className={`font-semibold ${LINK}`}>
          Call 911 now.
        </a>
      </p>

      <Section id="compliance-title" title={assetName(asset)} hint={KIND_WORD[asset.kind]}>
        <p className="text-[14px] leading-snug">
          <span className="font-semibold">Owner: </span>
          {ownerName || "not recorded in public data"}
        </p>
        <p className="mt-2 text-[14px] leading-snug">
          <span className="font-semibold">{rows.length}</span> filing{rows.length === 1 ? "" : "s"} to make
          {upcoming.length > 0 && (
            <>
              {" "}
              · next is <span className="font-semibold">{upcoming[0].worksheet.form?.form ?? upcoming[0].obligation.form}</span>{" "}
              due {fmtDate(upcoming[0].next!.due)} (<DueTag due={upcoming[0].next!.due} today={today} />)
            </>
          )}
          {openQuestions.length > 0 && (
            <>
              {" "}
              · <span className="font-semibold text-[#b45309]">{openQuestions.length}</span>{" "}
              {openQuestions.length === 1 ? "needs" : "need"} one answer from you
            </>
          )}
          {setAside.length > 0 && (
            <>
              {" "}
              · <span className="font-semibold">{setAside.length}</span> ruled out
            </>
          )}
          .
        </p>
        <p className="mt-1 text-[13px] leading-snug text-[#6b7583]">
          {covered} fields prefilled from public data. Forms and fields are read from the agencies&apos; own pages;
          nothing here is filed for you.
        </p>
      </Section>

      {upcoming.length > 0 && (
        <Section id="compliance-next" title="Do these next" hint="In date order. A date follows each agency's published rule.">
          <ol className="flex flex-col divide-y divide-[#e6e9ee] border-y border-[#e6e9ee]">
            {upcoming.map((r) => (
              <li key={`next-${r.obligation.id}`} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="font-semibold">
                    {r.next!.due === today ? "Today" : fmtDate(r.next!.due)} ·{" "}
                    {r.worksheet.form?.action === "sign" ? "File and sign" : "File"}
                  </span>
                  <span className="text-[13px]">
                    <DueTag due={r.next!.due} today={today} />
                  </span>
                </div>
                <p className="mt-0.5 text-[15px] font-medium leading-snug">{r.obligation.title}</p>
                <p className="mt-0.5 text-[13px] text-[#556070]">
                  {r.worksheet.form?.form ?? r.obligation.form} · {r.obligation.agency} ·{" "}
                  {r.worksheet.prefilled.length} fields prefilled
                </p>
                {r.determination.applicability === "needs_fact" && (
                  <AnswerButtons d={r.determination} onAnswer={answerFact} onClear={clearFact} />
                )}
              </li>
            ))}
          </ol>
        </Section>
      )}

      <Section
        id="compliance-filings"
        title="Your filings"
        hint={
          rows.length === 0
            ? undefined
            : `One row per filing. ${rows.length} apply to this asset; open a row for the prefilled fields, the fields only you can fill, and the agency's own words.`
        }
      >
        {rows.length === 0 ? (
          <p className="text-[14px] leading-relaxed text-[#556070]">
            No filing in our list applies to what public data shows about this asset.
          </p>
        ) : (
          GROUPS.map((g) => {
            const items = rows.filter((r) => groupOf(r.obligation) === g.key);
            if (items.length === 0) return null;
            return (
              <div key={g.key} className={g.key === "monthly" ? "" : "mt-5"}>
                <h4 className="text-[14px] font-semibold">{g.label}</h4>
                <p className="text-[13px] text-[#6b7583]">{g.hint}</p>
                <div className="mt-1 border-t border-[#e6e9ee]">
                  {items.map((r) => (
                    <FilingRow
                      key={r.obligation.id}
                      w={r.worksheet}
                      d={r.determination}
                      next={r.next}
                      today={today}
                      onAnswer={answerFact}
                      onClear={clearFact}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </Section>

      <Section id="compliance-details" title="Your details" hint="The facts public data holds about this asset. Copy them into any form.">
        <div className="flex items-start justify-between gap-3">
          <dl className="grid flex-1 grid-cols-1 gap-x-6 gap-y-1 text-[14px] sm:grid-cols-2">
            {details.map((d) => (
              <div key={d.label} className="flex justify-between gap-3 border-b border-[#e6e9ee] py-1">
                <dt className="text-[#556070]">{d.label}</dt>
                <dd className="font-semibold tabular-nums">{d.value}</dd>
              </div>
            ))}
          </dl>
          <CopyButton text={details.map((d) => `${d.label}: ${d.value}`).join("\n")} label="Copy all" />
        </div>
      </Section>

      {setAside.length > 0 && (
        <Section
          id="compliance-set-aside"
          title="Not yours"
          hint="Checked against this asset and set aside. Each line says what decided it."
        >
          <ul className="flex flex-col gap-2">
            {setAside.map((o) => (
              <li key={o.id} className="text-[13px] leading-snug">
                <span className="font-medium">{o.title}</span>
                <span className="text-[#556070]"> · {o.form} · {o.agency}</span>
                <DecisionLine d={determinations[o.id]} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <section className="border-t border-[#e6e9ee] px-6 py-6">
        <p className="text-[13px] leading-snug text-[#6b7583]">
          When a page cannot be read (a PDF, a blocked page), the row says so and sends you to the form instead of
          guessing. Answers to the one-fact questions are kept on this device.
        </p>
        <a
          href={claimHref(asset)}
          className={`mt-4 inline-flex min-h-10 items-center justify-center rounded-[6px] bg-[#0ea5e9] px-4 text-[14px] font-semibold text-[#1d2733] transition-colors hover:bg-[#38bdf8] ${FOCUS}`}
        >
          I own this — sign in to keep these filings on file
        </a>
      </section>
    </div>
  );
}
