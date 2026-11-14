"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LineRatingNow, ScanResult } from "@/lib/scan";
import type { ReportTarget } from "@/lib/scan/target";
import {
  EMPTY_DETAILS,
  SITUATIONS,
  assetInfo,
  buildComplianceReport,
  emergencyContacts,
  emergencyInfo,
  isBillChoice,
  loadBillChoice,
  loadReports,
  mailtoHref,
  osmUrl,
  reportFileName,
  reportText,
  resolveUtility,
  saveBillChoice,
  saveReports,
  situationById,
  toSaved,
  type BillChoice,
  type ComplianceDoc,
  type EmergencyContact,
  type ReportDetails,
  type SavedReport,
  type SituationId,
} from "@/lib/scan/compliance";
import { UTILITIES, type UtilityInfo, type UtilityKey } from "@/lib/scan/legal";
import type { SourceId } from "@/lib/scan/sources";
import { SourceNote, SourcesButton } from "./ui";

const REPORT_SOURCES: SourceId[] = ["cpuc_go95", "ca_codes_utility", "cpuc_complaints", "utility_safety_contacts", "osm", "eia860"];

/*
 * "Report a problem": a situation-based compliance report generator. No AI, no network.
 * Emergencies (fire, wire down, sparks, shock, gas) stop at a "call 911" screen. Everything
 * else becomes a formal report built from a fixed template with verified rules (lib/scan/legal.ts).
 * Nothing leaves the device until the person sends it (Email / Download / official page).
 */

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";
const BTN =
  `inline-flex min-h-11 items-center justify-center rounded-[6px] border border-[#e6e9ee] bg-white px-4 text-[15px] font-medium text-[#1d2733] transition-colors hover:bg-[#f6f8fa] ${FOCUS}`;
const PRIMARY =
  `inline-flex min-h-12 items-center justify-center rounded-[6px] bg-[#0ea5e9] px-5 text-[16px] font-semibold text-[#1d2733] transition-colors hover:bg-[#38bdf8] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const LINK = `text-[#0369a1] underline-offset-2 hover:underline ${FOCUS}`;
const INPUT =
  "mt-1.5 w-full rounded-[6px] border border-[#e6e9ee] bg-white px-3 py-2.5 text-[15px] text-[#1d2733] placeholder:text-[#6b7583] focus-visible:border-[#0ea5e9] focus-visible:outline-none";

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="border-t border-[#e6e9ee] px-6 py-6">
      <h3 className="flex items-center gap-3 text-[17px] font-semibold leading-snug text-[#1d2733]">
        <span
          aria-hidden
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[#0ea5e9] text-[14px] font-semibold text-[#0369a1]"
        >
          {n}
        </span>
        <span>
          <span className="sr-only">Step {n}: </span>
          {title}
        </span>
      </h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Emergency lines in one compact row, for when the person is not sure who their utility is. */
function EmergencyNumbers({ contacts, className = "" }: { contacts: EmergencyContact[]; className?: string }) {
  if (contacts.length === 0) return null;
  return (
    <p className={`text-[14px] leading-relaxed text-[#556070] ${className}`}>
      Emergency lines:{" "}
      {contacts.map((c, i) => (
        <span key={c.key}>
          {i > 0 && " · "}
          <a href={`tel:${c.phone.tel}`} className={`whitespace-nowrap ${LINK}`}>
            {c.short} {c.phone.display}
          </a>
        </span>
      ))}
    </p>
  );
}

const BILL_OPTIONS = (Object.keys(UTILITIES) as UtilityKey[]).map((k) => {
  const u: UtilityInfo = UTILITIES[k];
  return { key: k, name: u.name };
});

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function downloadTxt(text: string, name: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function DocHeading({ children }: { children: ReactNode }) {
  return <h4 className="mt-5 text-[15px] font-semibold text-[#1d2733] print:mt-4 print:text-[13pt]">{children}</h4>;
}

/** The formal document. Used on screen and (through a portal) for printing. */
export function ReportDocument({ doc }: { doc: ComplianceDoc }) {
  return (
    <article className="text-[15px] leading-relaxed text-[#1d2733] [overflow-wrap:anywhere] print:text-[11pt]">
      <h3 className="text-[18px] font-semibold leading-snug print:text-[16pt]">{doc.title}</h3>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[14px] print:text-[11pt]">
        <dt className="font-medium text-[#556070]">Date</dt>
        <dd>{doc.date}</dd>
        <dt className="font-medium text-[#556070]">To</dt>
        <dd>
          {doc.to.map((t) => (
            <span key={t} className="block">
              {t}
            </span>
          ))}
        </dd>
        <dt className="font-medium text-[#556070]">From</dt>
        <dd>{doc.from}</dd>
        <dt className="font-medium text-[#556070]">Subject</dt>
        <dd>{doc.subject}</dd>
      </dl>

      <DocHeading>Location and asset</DocHeading>
      <p className="mt-1">{doc.asset.label}</p>
      <p className="text-[14px] text-[#556070]">
        {doc.asset.placeText} ·{" "}
        <a href={doc.mapUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
          OpenStreetMap
        </a>
        <span className="hidden print:inline"> ({doc.mapUrl})</span>
      </p>
      <p className="text-[14px] text-[#556070]">
        Utility: {doc.utility.utility.name}. {doc.utility.basis.replace(/\.?$/, ".")}
        {doc.utility.hint ? ` ${doc.utility.hint}` : ""}
      </p>

      <DocHeading>What happened</DocHeading>
      {doc.happened.map((p, i) => (
        <p key={i} className="mt-1">
          {p}
        </p>
      ))}

      <DocHeading>Rules that apply</DocHeading>
      {doc.rules.length === 0 ? (
        <p className="mt-1">Your utility&apos;s own service rules. Ask it to send them to you in writing.</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-2">
          {doc.rules.map((r) => (
            <li key={r.citation}>
              <p className="font-medium">
                {r.citation}: {r.title}
              </p>
              <p className="text-[#556070]">{r.plain}</p>
              <a href={r.url} target="_blank" rel="noopener noreferrer" className={`text-[14px] ${LINK}`}>
                Official text
              </a>
              <span className="hidden text-[9pt] print:inline"> {r.url}</span>
            </li>
          ))}
        </ul>
      )}

      <DocHeading>Facts from public data</DocHeading>
      <ul className="mt-1 flex flex-col gap-0.5">
        {doc.asset.facts.map((f) => (
          <li key={f.label}>
            <span className="text-[#556070]">{f.label}:</span> {f.value}{" "}
            <span className="text-[13px] text-[#6b7583]">(source: {f.source})</span>
          </li>
        ))}
      </ul>

      <DocHeading>What I am asking for</DocHeading>
      <ol className="mt-1 list-decimal pl-5">
        {doc.asks.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ol>

      <DocHeading>Evidence checklist</DocHeading>
      <ul className="mt-1 list-disc pl-5">
        {doc.evidence.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>

      <DocHeading>Where to send it, in order</DocHeading>
      <ol className="mt-1 flex flex-col gap-2">
        {doc.steps.map((s, i) => (
          <li key={s.title}>
            <p className="font-medium">
              {i + 1}. {s.title}
            </p>
            <p className="text-[#556070]">{s.detail}</p>
            <p className="flex flex-wrap gap-x-4 text-[14px]">
              {s.phone && (
                <a href={`tel:${s.phone.tel}`} className={LINK}>
                  Call {s.phone.display}
                </a>
              )}
              {s.url && (
                <a href={s.url} target="_blank" rel="noopener noreferrer" className={LINK}>
                  Open page
                </a>
              )}
              {s.url && <span className="hidden text-[9pt] print:inline">{s.url}</span>}
            </p>
          </li>
        ))}
      </ol>

      {doc.deadlines.length > 0 && (
        <>
          <DocHeading>Deadlines and response times</DocHeading>
          <ul className="mt-1 list-disc pl-5">
            {doc.deadlines.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </>
      )}

      {doc.certification && (
        <p className="mt-5">
          {doc.certification}
          <span className="mt-6 block">Signature: ______________________</span>
        </p>
      )}

      <p className="mt-5 text-[14px] text-[#556070]">
        If anyone is in danger, or you see fire, sparks or a wire on the ground, call 911 first.
      </p>
      <p className="mt-1 text-[14px] text-[#556070]">Privacy: {doc.privacy}</p>
      <p className="mt-1 text-[14px] text-[#556070]">{doc.disclaimer}</p>
    </article>
  );
}

export default function ReportTab({
  result,
  live: _live,
  heatwave: _heatwave,
  target,
  onClearTarget,
  onFocus,
}: {
  result: ScanResult;
  live: LineRatingNow | null;
  heatwave: boolean;
  target: ReportTarget;
  onClearTarget: () => void;
  onFocus: (lat: number, lon: number) => void;
}) {
  const asset = useMemo(() => assetInfo(target, result), [target, result]);
  // The person's answer to "Who sends your electric bill?" (null = our guess). Kept on this device.
  const [bill, setBill] = useState<BillChoice | null>(null);
  const utility = useMemo(() => resolveUtility(target, result, bill), [target, result, bill]);
  const contacts = useMemo(() => emergencyContacts(target, result), [target, result]);

  const [situation, setSituation] = useState<SituationId | null>(null);
  const [details, setDetails] = useState<ReportDetails>(EMPTY_DETAILS);
  const [doc, setDoc] = useState<ComplianceDoc | null>(null);
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [status, setStatus] = useState<"idle" | "saved" | "memory">("idle");
  const [copied, setCopied] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [showSources, setShowSources] = useState(false);

  // Load saved reports after mount (never during render) to avoid hydration mismatches.
  useEffect(() => {
    setMounted(true);
    setReports(loadReports());
    setBill(loadBillChoice());
  }, []);

  // A new target starts fresh.
  useEffect(() => {
    setSituation(null);
    setDetails(EMPTY_DETAILS);
    setDoc(null);
    setStatus("idle");
  }, [target]);

  const sit = situation ? situationById(situation) : null;
  const emergency = sit?.emergency ? emergencyInfo(sit.id, target, result, bill) : null;
  const text = useMemo(() => (doc ? reportText(doc) : ""), [doc]);

  const pick = (id: SituationId) => {
    setSituation(id);
    setDoc(null);
    setStatus("idle");
  };

  const set = <K extends keyof ReportDetails>(k: K, v: ReportDetails[K]) => {
    setDetails((d) => ({ ...d, [k]: v }));
    setDoc(null);
  };

  const make = () => {
    if (!situation) return;
    setDoc(buildComplianceReport({ situationId: situation, target, result, details, bill }));
    setStatus("idle");
  };

  const save = () => {
    if (!doc) return;
    const r = toSaved(doc);
    const next = [r, ...reports];
    setReports(next);
    setStatus(saveReports(next) ? "saved" : "memory");
  };

  const pickBill = (v: string) => {
    if (!isBillChoice(v)) return;
    setBill(v);
    saveBillChoice(v);
    setDoc(null);
    setStatus("idle");
  };

  const remove = (id: string) => {
    const next = reports.filter((r) => r.id !== id);
    setReports(next);
    saveReports(next);
  };

  const copy = async (key: string, t: string) => {
    if (await copyText(t)) {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    }
  };

  const emergencyPhone = utility.known ? utility.utility.emergency : undefined;
  const emergencyCards = SITUATIONS.filter((s) => s.emergency);
  const problemCards = SITUATIONS.filter((s) => !s.emergency);

  return (
    <div className="text-[15px] leading-snug text-[#1d2733]">
      {/* Always visible. */}
      <div className="px-6 pt-5 pb-4">
        <div role="note" className="rounded-[6px] border-2 border-[#dc2626] bg-white px-4 py-3">
          <p className="text-[16px] font-semibold leading-snug">
            Emergency? Fire, sparks, a wire on the ground, someone hurt or shocked, or you smell gas: get away from it and
            call 911 now. Then call your utility&apos;s emergency line.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[15px]">
            <a href="tel:911" className={`font-semibold ${LINK}`}>
              Call 911
            </a>
            {emergencyPhone ? (
              <a href={`tel:${emergencyPhone.tel}`} className={`font-semibold ${LINK}`}>
                {utility.utility.short}: {emergencyPhone.display}
              </a>
            ) : (
              <span className="text-[#556070]">Your utility&apos;s emergency number is printed on your electric bill.</span>
            )}
          </div>
          {emergencyPhone?.note && <p className="mt-1 text-[13px] text-[#6b7583]">{emergencyPhone.note}</p>}
          {!utility.known && <EmergencyNumbers contacts={contacts} className="mt-2" />}
        </div>
      </div>

      {/* What is being reported. */}
      <div className="border-t border-[#e6e9ee] px-6 py-5">
        <p className="text-[13px] text-[#6b7583]">You are reporting</p>
        <p className="mt-1 text-[16px] font-semibold leading-snug">{asset.label}</p>
        <p className="mt-1 text-[15px] text-[#556070]">{asset.placeText}</p>
        <div className="mt-3">
          <label htmlFor="gs-bill-utility" className="block text-[15px] font-medium">
            Who sends your electric bill?
          </label>
          <select
            id="gs-bill-utility"
            value={bill ?? (utility.known ? utility.utility.key : "notsure")}
            onChange={(e) => pickBill(e.target.value)}
            aria-describedby="gs-bill-utility-note"
            className={`${INPUT} min-h-11 sm:max-w-[420px]`}
          >
            {BILL_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name}
              </option>
            ))}
            <option value="notsure">Not sure</option>
          </select>
          <div id="gs-bill-utility-note" className="mt-1.5 text-[14px] leading-snug text-[#556070]">
            {utility.source === "bill" && (
              <p>Phone numbers and where to send your report use {utility.utility.short}.</p>
            )}
            {utility.source === "likely" && (
              <p>{utility.basis} If your bill says a different company, pick it above.</p>
            )}
            {utility.source === "unsure" && (
              <>
                <p>
                  Not sure? Look at your electric bill: the company name is at the top, and its 24-hour emergency
                  number is on it too. Then pick it above.
                </p>
                {utility.hint && <p className="mt-1">{utility.hint}</p>}
              </>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-4">
          <button type="button" onClick={() => onFocus(asset.lat, asset.lon)} className={`text-[15px] ${LINK}`}>
            Show on map
          </button>
          {target.kind !== "area" && (
            <button type="button" onClick={onClearTarget} className={`text-[15px] ${LINK}`}>
              Report the whole area instead
            </button>
          )}
        </div>
        {target.kind === "area" && (
          <p className="mt-2 text-[14px] text-[#6b7583]">
            To report one power line, substation or plant, click it on the map, then press Report a problem.
          </p>
        )}
      </div>

      <Step n={1} title="What happened?">
        <p className="text-[14px] font-medium text-[#dc2626]">Danger right now</p>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {emergencyCards.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={situation === s.id}
              onClick={() => pick(s.id)}
              className={`min-h-14 rounded-[6px] border px-3 py-2 text-left transition-colors ${FOCUS} ${
                situation === s.id ? "border-[#dc2626] bg-white ring-1 ring-[#dc2626]" : "border-[#e6e9ee] bg-white hover:bg-[#f6f8fa]"
              }`}
            >
              <span className="block text-[15px] font-medium leading-tight">{s.label}</span>
              <span className="mt-0.5 block text-[13px] text-[#6b7583]">{s.hint}</span>
            </button>
          ))}
        </div>
        <p className="mt-5 text-[14px] font-medium text-[#556070]">Problems to report (no one in danger)</p>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {problemCards.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={situation === s.id}
              onClick={() => pick(s.id)}
              className={`min-h-14 rounded-[6px] border px-3 py-2 text-left transition-colors ${FOCUS} ${
                situation === s.id ? "border-[#0ea5e9] bg-[#e0f2fe]" : "border-[#e6e9ee] bg-white hover:bg-[#f6f8fa]"
              }`}
            >
              <span className="block text-[15px] font-medium leading-tight">{s.label}</span>
              <span className={`mt-0.5 block text-[13px] ${situation === s.id ? "text-[#556070]" : "text-[#6b7583]"}`}>{s.hint}</span>
            </button>
          ))}
        </div>
        <div className="mt-4 flex items-start justify-between gap-3">
          <p className="text-[13px] text-[#6b7583]">
            Rules and phone numbers here were checked on official pages on Nov 14, 2026. Not legal advice.
          </p>
          <SourcesButton open={showSources} onToggle={() => setShowSources((v) => !v)} controls="gs-report-sources" />
        </div>
        {showSources && <SourceNote sources={REPORT_SOURCES} id="gs-report-sources" />}
      </Step>

      {/* Emergency: full stop. No form. */}
      {sit && emergency && (
        <section aria-live="assertive" className="border-t border-[#e6e9ee] px-6 py-6">
          <div className="rounded-[6px] border-2 border-[#dc2626] px-4 py-4">
            <h3 className="text-[20px] font-semibold leading-snug text-[#dc2626]">Stop. Call 911 now.</h3>
            <p className="mt-1 text-[15px]">{sit.label}: this is an emergency. Do not fill out a report.</p>
            <a href="tel:911" className={`mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-[6px] bg-[#dc2626] px-5 text-[16px] font-semibold text-white transition-opacity hover:opacity-90 ${FOCUS}`}>
              Call 911
            </a>
            {emergency.gasPhone && (
              <a href={`tel:${emergency.gasPhone.tel}`} className={`${BTN} mt-2 w-full`}>
                Gas company: {emergency.gasPhone.display}
              </a>
            )}
            {!emergency.gasPhone && sit.id === "gas" && (
              <p className="mt-2 text-[15px] text-[#556070]">
                After 911, call your gas company. Its number is printed on your gas bill.
              </p>
            )}
            {!emergency.gasPhone &&
              sit.id !== "gas" &&
              (emergency.utility.known && emergency.utility.utility.emergency ? (
                <a href={`tel:${emergency.utility.utility.emergency.tel}`} className={`${BTN} mt-2 w-full`}>
                  {emergency.utility.utility.short} emergency: {emergency.utility.utility.emergency.display}
                </a>
              ) : (
                <>
                  <p className="mt-2 text-[15px] text-[#556070]">
                    After 911, call your utility&apos;s emergency number. It is printed on your electric bill.
                  </p>
                  {!emergency.utility.known && <EmergencyNumbers contacts={contacts} className="mt-1" />}
                </>
              ))}
            <ul className="mt-4 flex list-disc flex-col gap-1.5 pl-5 text-[15px]">
              {emergency.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <p className="mt-3 text-[13px] text-[#6b7583]">
              Safety advice from:{" "}
              {emergency.sources.map((s, i) => (
                <span key={s.url}>
                  {i > 0 && "; "}
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className={LINK}>
                    {s.label}
                  </a>
                </span>
              ))}
            </p>
          </div>
          <p className="mt-4 text-[14px] text-[#556070]">
            When everyone is safe and the emergency is over, you can come back and pick a problem above to write a report.
          </p>
        </section>
      )}

      {sit && !sit.emergency && (
        <Step n={2} title="Details">
          <p className="text-[14px] text-[#556070]">Filled in from public data:</p>
          <ul className="mt-2 flex flex-col gap-1 text-[15px]">
            {asset.facts.map((f) => (
              <li key={f.label} className="flex flex-wrap gap-x-2">
                <span className="text-[#556070]">{f.label}:</span>
                <span className="font-medium">{f.value}</span>
              </li>
            ))}
            <li className="flex flex-wrap gap-x-2">
              <span className="text-[#556070]">Utility:</span>
              <span className="font-medium">
                {utility.source === "likely" ? `Likely ${utility.utility.name}` : utility.known ? utility.utility.name : "Not sure (see your electric bill)"}
              </span>
            </li>
          </ul>
          <p className="mt-1 text-[13px] text-[#6b7583]">
            {utility.basis} Sources: OpenStreetMap and EIA-860.{" "}
            <a href={osmUrl(asset.lat, asset.lon)} target="_blank" rel="noopener noreferrer" className={LINK}>
              Open in OpenStreetMap
            </a>
          </p>

          <div className="mt-5 flex flex-col gap-4">
            <label className="block text-[15px] font-medium">
              When did it happen?
              <input
                type="datetime-local"
                value={details.when}
                onChange={(e) => set("when", e.target.value)}
                className={INPUT}
              />
            </label>
            <label className="block text-[15px] font-medium">
              What did you see?
              <textarea
                value={details.saw}
                onChange={(e) => set("saw", e.target.value)}
                rows={3}
                maxLength={800}
                placeholder="Example: Branches from the big tree are touching the top wire in front of 123 Main St."
                className={`${INPUT} resize-y`}
              />
            </label>
            <label className="block text-[15px] font-medium">
              Pole or equipment ID number (if you can see it)
              <input
                type="text"
                value={details.equipmentId}
                onChange={(e) => set("equipmentId", e.target.value)}
                maxLength={60}
                className={INPUT}
              />
              <span className="mt-1 block text-[13px] font-normal text-[#6b7583]">
                Many poles and ground boxes have a small metal tag with a number. Read it from the ground only. Never
                climb or touch the equipment.
              </span>
            </label>
            <label className="block text-[15px] font-medium">
              Utility ticket or reference number (if you already called)
              <input
                type="text"
                value={details.ticket}
                onChange={(e) => set("ticket", e.target.value)}
                maxLength={60}
                className={INPUT}
              />
            </label>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block text-[15px] font-medium">
                Your name (optional)
                <input
                  type="text"
                  autoComplete="name"
                  value={details.name}
                  onChange={(e) => set("name", e.target.value)}
                  maxLength={80}
                  className={INPUT}
                />
              </label>
              <label className="block text-[15px] font-medium">
                Phone or email (optional)
                <input
                  type="text"
                  autoComplete="email"
                  value={details.contact}
                  onChange={(e) => set("contact", e.target.value)}
                  maxLength={120}
                  className={INPUT}
                />
              </label>
            </div>
            <p className="-mt-2 text-[13px] text-[#6b7583]">
              Your name and contact stay on this device until you send the report yourself.
            </p>
            <label className="flex items-start gap-3 text-[15px]">
              <input
                type="checkbox"
                checked={details.certify}
                onChange={(e) => set("certify", e.target.checked)}
                className="mt-1 h-5 w-5 shrink-0 accent-[#0ea5e9]"
              />
              <span>Add a line saying the facts I wrote are true to the best of my knowledge (with a signature line).</span>
            </label>
          </div>

          <button type="button" onClick={make} className={`${PRIMARY} mt-5 w-full`}>
            {doc ? "Update my report" : "Make my report"}
          </button>
        </Step>
      )}

      {doc && sit && !sit.emergency && (
        <Step n={3} title="Your compliance report">
          <div className="rounded-[6px] border border-[#e6e9ee] bg-white px-4 py-4">
            <ReportDocument doc={doc} />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => window.print()} className={BTN}>
              Print / Save as PDF
            </button>
            <button type="button" onClick={() => downloadTxt(text, reportFileName(doc.title, new Date().toISOString()))} className={BTN}>
              Download .txt
            </button>
            <button type="button" onClick={() => copy("doc", text)} className={BTN} aria-live="polite">
              {copied === "doc" ? "Copied" : "Copy"}
            </button>
            <a href={mailtoHref(doc.subject, text)} className={BTN}>
              Email
            </a>
            <a href={doc.filingUrl} target="_blank" rel="noopener noreferrer" className={`${BTN} col-span-2`}>
              Open the official filing page
            </a>
          </div>
          <button type="button" onClick={save} className={`${PRIMARY} mt-3 w-full`}>
            Save to My reports
          </button>
          <div aria-live="polite">
            {status === "saved" && (
              <p className="mt-3 text-[15px] font-medium">
                Saved on this device. To reach the utility, send it with Email or the official filing page.
              </p>
            )}
            {status === "memory" && (
              <p className="mt-3 text-[15px] font-medium">
                This browser would not let us keep it, so it will be gone after a reload. Send it or download it now.
              </p>
            )}
          </div>
          <p className="mt-3 text-[13px] text-[#6b7583]">
            Email opens your own email app with no recipient filled in, so you choose who gets it. Long reports are
            shortened in the email; the download has the full report.
          </p>
        </Step>
      )}

      <section className="border-t border-[#e6e9ee] px-6 py-6">
        <h3 className="text-[17px] font-semibold leading-snug">My reports</h3>
        {reports.length === 0 ? (
          <p className="mt-2 text-[15px] text-[#556070]">No reports yet. Reports you save show up here.</p>
        ) : (
          <ul className="mt-3 flex flex-col">
            {reports.map((r) => (
              <li key={r.id} className="border-t border-[#e6e9ee] py-4 first:border-t-0 first:pt-1">
                <p className="text-[15px] font-semibold leading-snug">{r.title}</p>
                <p className="mt-0.5 text-[14px] text-[#6b7583]">
                  {fmtWhen(r.createdAt)}
                  {r.assetLabel ? ` · ${r.assetLabel}` : ""}
                  {r.contact.name ? ` · ${r.contact.name}` : ""}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a href={mailtoHref(r.subject, r.text)} className={BTN}>
                    Email
                  </a>
                  <button type="button" onClick={() => downloadTxt(r.text, reportFileName(r.title, r.createdAt))} className={BTN}>
                    Download
                  </button>
                  <button type="button" onClick={() => copy(r.id, r.text)} className={BTN}>
                    {copied === r.id ? "Copied" : "Copy"}
                  </button>
                  <a href={r.contact.url} target="_blank" rel="noopener noreferrer" className={BTN}>
                    Official page
                  </a>
                  <button type="button" onClick={() => remove(r.id)} className={BTN} aria-label={`Delete report: ${r.title}`}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[13px] leading-snug text-[#6b7583]">
          Reports are saved in this browser only. Nobody gets them until you send them.
        </p>
      </section>

      {/* Print copy: on paper only the document shows; every other part of the page is hidden. */}
      {mounted &&
        doc &&
        createPortal(
          <div className="hidden bg-white text-[#1d2733] print:block print:[body:has(>&)>:not(&)]:!hidden print:[body:has(>&)]:!h-auto print:[body:has(>&)]:!overflow-visible print:[html:has(&)]:!h-auto print:[html:has(&)]:!overflow-visible">
            <ReportDocument doc={doc} />
          </div>,
          document.body,
        )}
    </div>
  );
}
