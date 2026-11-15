"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { LineRatingNow, ScanResult } from "@/lib/scan";
import type { ReportTarget } from "@/lib/scan/target";
import {
  HAZARDS,
  SAFETY_LINE,
  EMPTY_SENDER,
  buildDraft,
  detectUtility,
  emergencyContacts,
  emergencyInfo,
  fileQuickReport,
  hazardEmergency,
  isBillChoice,
  loadReports,
  mailtoHref,
  quickRouting,
  reportFileName,
  resolveUtility,
  saveReports,
  severityWord,
  type BillChoice,
  type EmergencyContact,
  type HazardId,
  type ReportSender,
  type ReportEmail,
  type SavedReport,
  type Severity,
} from "@/lib/scan/compliance";
import { UTILITIES, type UtilityInfo, type UtilityKey } from "@/lib/scan/legal";

/*
 * "Report a problem" tab. Written for a 10-year-old: three numbered steps, big text,
 * short sentences. No AI, no network. Picking "Wire on the ground" or "Sparks or fire" stops
 * at a "call 911" screen. Who the report goes to is the utility that serves the reported spot (our guess from
 * nearby substations, or the person's pick), then CPUC for SCE / SDG&E / PG&E, the city, or a co-op's board.
 * The letter goes to the utility's published email (its tree team for "Tree touching a wire" when it has one).
 * When a utility takes reports only by phone or web form, the send button copies the letter and opens that form
 * instead: it never opens an email with no recipient. Filing only saves on this device (localStorage).
 */

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";
const LINK = `text-[#0369a1] hover:underline ${FOCUS}`;
const SMALL_BTN =
  `inline-flex min-h-9 items-center rounded-[6px] border border-[#e6e9ee] bg-white px-3 py-1.5 text-left text-[14px] font-medium leading-tight text-[#1d2733] transition-colors hover:bg-[#f6f8fa] ${FOCUS}`;

const PRIMARY_BTN =
  `inline-flex min-h-11 w-full items-center justify-center rounded-[6px] bg-[#0ea5e9] px-4 py-2 text-center text-[16px] leading-tight font-semibold text-white transition-colors hover:bg-[#0284c7] ${FOCUS}`;

const SEVERITY_COLOR: Record<Severity, string> = { info: "#556070", warn: "#b45309", danger: "#dc2626" };

const BILL_OPTIONS = (Object.keys(UTILITIES) as UtilityKey[]).map((k) => {
  const u: UtilityInfo = UTILITIES[k];
  return { key: k, name: u.name };
});

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

/** Copy inside the click handler itself: execCommand runs synchronously (keeps the click's permission), then the clipboard API. */
function copyNow(text: string): boolean {
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

async function copyText(text: string): Promise<boolean> {
  if (copyNow(text)) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const letterText = (e: ReportEmail) => `Subject: ${e.subject}\n\n${e.body}`;

/**
 * How a filed letter is sent: an email addressed to the utility, or (when it publishes no email) copy the letter
 * and open its report page. Old reports saved before letters existed have no send button.
 */
function SendLetter({ r, primary = false }: { r: SavedReport; primary?: boolean }) {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  useEffect(() => {
    if (copied === "idle") return;
    const t = setTimeout(() => setCopied("idle"), 6000);
    return () => clearTimeout(t);
  }, [copied]);
  const e = r.email;
  if (!e) return null;
  const who = e.recipient ?? "the utility";
  const cls = primary ? PRIMARY_BTN : SMALL_BTN;
  if (e.to) {
    return (
      <a href={mailtoHref(e.subject, e.body, e.to)} className={cls}>
        Email {who}
      </a>
    );
  }
  const url = e.formUrl ?? r.contact.url;
  // A real link (not window.open) so pop-up blockers never stop the report page; the click also copies the letter.
  const copy = () => void copyText(letterText(e)).then((ok) => setCopied(ok ? "ok" : "fail"));
  const cut = /\bthe utility\b/.test(who) ? who : `${who}'s`;
  return (
    <>
      <a href={url} target="_blank" rel="noopener noreferrer" onClick={copy} className={cls}>
        Copy letter and open {cut} report page
      </a>
      <span aria-live="polite" className={primary ? "mt-2 block text-[14px] text-[#556070]" : "sr-only"}>
        {copied === "ok" && "Letter copied. Paste it into the report page in the new tab."}
        {copied === "fail" && "Could not copy. Use Download, then paste the letter into the report page."}
      </span>
    </>
  );
}

export default function ReportTab({
  result,
  live,
  heatwave,
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
  const draft = useMemo(() => buildDraft(target, result, live, heatwave), [target, result, live, heatwave]);

  // The person's answer to "Which utility serves this spot?" (null = our guess). Reset for every new spot,
  // so a pick made for one place never routes a report about another place.
  const [bill, setBill] = useState<BillChoice | null>(null);
  const utility = useMemo(() => resolveUtility(target, result, bill), [target, result, bill]);
  const detected = useMemo(() => detectUtility(target, result), [target, result]);
  const mismatch = utility.source === "bill" && detected.known && detected.utility.key !== utility.utility.key;
  const contacts = useMemo(() => emergencyContacts(target, result), [target, result]);

  const [hazards, setHazards] = useState<HazardId[]>([]);
  const [note, setNote] = useState("");
  const [sender, setSender] = useState<ReportSender>(EMPTY_SENDER);
  const [status, setStatus] = useState<"idle" | "saved" | "memory">("idle");
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);

  const routing = useMemo(() => quickRouting(hazards, utility), [hazards, utility]);
  const emergencyId = hazardEmergency(hazards);
  const emergency = emergencyId ? emergencyInfo(emergencyId, target, result, bill) : null;

  // Load saved reports after mount (never during render) to avoid hydration mismatches.
  useEffect(() => {
    setReports(loadReports());
  }, []);

  // A new target starts a fresh report, with the utility guessed for that spot.
  useEffect(() => {
    setHazards([]);
    setNote("");
    setBill(null);
    setStatus("idle");
    setLastId(null);
  }, [target]);

  const toggle = (id: HazardId) =>
    setHazards((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]));

  const pickBill = (v: string) => {
    if (!isBillChoice(v)) return;
    setBill(v);
  };

  const file = () => {
    const r = fileQuickReport(draft, hazards, note, routing, new Date(), sender);
    const next = [r, ...reports];
    setReports(next);
    setStatus(saveReports(next) ? "saved" : "memory");
    setLastId(r.id);
    setHazards([]);
    setNote("");
  };

  const remove = (id: string) => {
    const next = reports.filter((r) => r.id !== id);
    setReports(next);
    saveReports(next);
  };

  const copy = async (r: SavedReport) => {
    if (await copyText(r.email ? letterText(r.email) : r.text)) {
      setCopiedId(r.id);
      setTimeout(() => setCopiedId((c) => (c === r.id ? null : c)), 1500);
    }
  };

  // "Not sure" has no address yet: send the person to the utility picker (focus moves there for screen readers too).
  const pickFirst = () => {
    const el = document.getElementById("gs-bill-utility");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.focus();
  };
  const lastReport = lastId ? reports.find((r) => r.id === lastId) ?? null : null;
  const picked = HAZARDS.filter((h) => hazards.includes(h.id) && h.emergency).map((h) => h.label);

  return (
    <div className="text-[15px] leading-snug text-[#1d2733]">
      {/* Safety line: always visible. */}
      <div className="px-6 pt-5 pb-4">
        <p className="text-[16px] font-semibold leading-snug text-[#1d2733]">{SAFETY_LINE}</p>
      </div>

      {/* What is being reported. */}
      <div className="border-t border-[#e6e9ee] px-6 py-5">
        <p className="text-[13px] text-[#6b7583]">You are reporting</p>
        <p className="mt-1 text-[16px] font-semibold leading-snug text-[#1d2733]">{draft.assetLabel}</p>
        <p className="mt-1 text-[15px] text-[#556070]">{draft.location.text}</p>
        <div className="mt-2 flex flex-wrap gap-4">
          <button
            type="button"
            onClick={() => onFocus(draft.location.lat, draft.location.lon)}
            className={`text-[15px] ${LINK}`}
          >
            Show on map
          </button>
          {target.kind !== "area" && (
            <button type="button" onClick={onClearTarget} className={`text-[15px] ${LINK}`}>
              Change (report the whole area instead)
            </button>
          )}
        </div>
        {target.kind === "area" && (
          <p className="mt-2 text-[14px] text-[#6b7583]">
            Want to report one plant, substation or line? Click it on the map, then press Report a problem.
          </p>
        )}

        <div className="mt-4">
          <label htmlFor="gs-bill-utility" className="block text-[15px] font-medium text-[#1d2733]">
            Which utility serves this spot?
          </label>
          <select
            id="gs-bill-utility"
            value={bill ?? (utility.known ? utility.utility.key : "notsure")}
            onChange={(e) => pickBill(e.target.value)}
            aria-describedby="gs-bill-utility-note"
            className="mt-1.5 min-h-11 w-full rounded-[6px] border border-[#e6e9ee] bg-white px-3 py-2.5 text-[15px] text-[#1d2733] focus-visible:border-[#0ea5e9] focus-visible:outline-none sm:max-w-[420px]"
          >
            {BILL_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name}
              </option>
            ))}
            <option value="notsure">Not sure</option>
          </select>
          <div id="gs-bill-utility-note" className="mt-1.5 text-[14px] leading-snug text-[#556070]">
            {utility.source === "bill" && !mismatch && <p>Who to contact uses {utility.utility.short}.</p>}
            {mismatch && (
              <p className="text-[#b45309]">
                Check this: {detected.basis.replace(/ Check your electric bill to be sure\.$/, "")}. You picked{" "}
                {utility.utility.short}. Pick the company that serves this spot, not the one that bills you somewhere else.
              </p>
            )}
            {utility.source === "likely" && <p>{utility.basis} If your bill says a different company, pick it above.</p>}
            {utility.source === "unsure" && (
              <>
                <p>
                  Not sure? Look at your electric bill: the company name is at the top, and its 24-hour emergency number
                  is on it too. Then pick it above.
                </p>
                {utility.hint && <p className="mt-1">{utility.hint}</p>}
              </>
            )}
          </div>
        </div>
      </div>

      <Step n={1} title="What's wrong?">
        <p className="mb-3 text-[15px] text-[#556070]">Pick any that fit. You can skip this step.</p>
        <div className="grid grid-cols-2 gap-2">
          {HAZARDS.map((h) => {
            const on = hazards.includes(h.id);
            return (
              <button
                key={h.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(h.id)}
                className={`h-14 rounded-[6px] border px-3 text-left text-[15px] font-medium leading-tight text-[#1d2733] transition-colors ${FOCUS} ${
                  on ? "border-[#0ea5e9] bg-[#e0f2fe]" : "border-[#e6e9ee] bg-white hover:bg-[#f6f8fa]"
                }`}
              >
                {h.label}
              </button>
            );
          })}
        </div>
      </Step>

      {/* Emergency: full stop. No form. */}
      {emergency && (
        <section aria-live="assertive" className="border-t border-[#e6e9ee] px-6 py-6">
          <div className="rounded-[6px] border-2 border-[#dc2626] px-4 py-4">
            <h3 className="text-[20px] font-semibold leading-snug text-[#dc2626]">Stop. Call 911 now.</h3>
            <p className="mt-1 text-[15px]">{picked.join(" and ")}: this is an emergency. Do not fill out a report.</p>
            <a
              href="tel:911"
              className={`mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-[6px] bg-[#dc2626] px-5 text-[16px] font-semibold text-white transition-opacity hover:opacity-90 ${FOCUS}`}
            >
              Call 911
            </a>
            {emergency.utility.known && emergency.utility.utility.emergency ? (
              <a href={`tel:${emergency.utility.utility.emergency.tel}`} className={`${SMALL_BTN} mt-2 w-full justify-center`}>
                {emergency.utility.utility.short} emergency: {emergency.utility.utility.emergency.display}
              </a>
            ) : (
              <>
                <p className="mt-2 text-[15px] text-[#556070]">
                  After 911, call your utility&apos;s emergency number. It is printed on your electric bill.
                </p>
                {!emergency.utility.known && <EmergencyNumbers contacts={contacts} className="mt-1" />}
              </>
            )}
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
            When everyone is safe and the emergency is over, unpick it above to file a report.
          </p>
        </section>
      )}

      {!emergency && (
        <>
          <Step n={2} title="We checked it for you">
            <p className="mb-3 text-[15px] text-[#556070]">We looked at public data about this spot. Here is what we found.</p>
            <ul className="flex flex-col gap-3">
              {draft.issues.map((i, k) => (
                <li key={k} className="flex gap-3">
                  <span className="w-[58px] shrink-0 text-[14px] font-semibold" style={{ color: SEVERITY_COLOR[i.severity] }}>
                    {severityWord(i.severity)}
                  </span>
                  <span className="min-w-0 text-[15px] leading-snug text-[#1d2733]">{i.text}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[14px] text-[#556070]">
              It goes to: <span className="font-semibold text-[#1d2733]">{routing.contactName}</span>
            </p>
            {routing.delivery === "email" && (
              <p className="mt-1 text-[14px] text-[#556070]">
                By email to <span className="font-medium text-[#1d2733]">{routing.email}</span>
                {routing.team !== "Customer Service" && ` (${routing.utility?.short}'s ${routing.team.toLowerCase()} team)`}
              </p>
            )}
            {routing.delivery === "form" && routing.note && <p className="mt-1 text-[14px] text-[#556070]">{routing.note}</p>}
            {routing.delivery === "pick" && (
              <p className="mt-1 text-[14px] font-medium text-[#b45309]">{routing.note}</p>
            )}
            {routing.steps[1] && /^If it is not fixed/i.test(routing.steps[1].title) && (
              <p className="mt-1 text-[14px] text-[#556070]">{routing.steps[1].title}</p>
            )}
            <details className="mt-2">
              <summary className={`cursor-pointer text-[14px] font-medium ${LINK}`}>Where to send it, in order</summary>
              <ol className="mt-2 flex flex-col gap-2">
                {routing.steps.map((s, i) => (
                  <li key={s.title} className="text-[14px] leading-snug">
                    <p className="font-medium text-[#1d2733]">
                      {i + 1}. {s.title}
                    </p>
                    <p className="text-[#556070]">{s.detail}</p>
                    {(s.phone || s.url) && (
                      <p className="flex flex-wrap gap-x-4">
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
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </details>
            <label htmlFor="gs-report-note" className="mt-4 block text-[15px] font-medium text-[#1d2733]">
              Anything else to add? (optional)
            </label>
            <textarea
              id="gs-report-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={600}
              placeholder="Example: The wire is hanging low over the sidewalk."
              className="mt-2 w-full resize-y rounded-[6px] border border-[#e6e9ee] bg-white px-3 py-2 text-[15px] text-[#1d2733] placeholder:text-[#6b7583] focus-visible:border-[#0ea5e9] focus-visible:outline-none"
            />
            <p className="mt-4 text-[15px] font-medium text-[#1d2733]">Sign the letter (optional)</p>
            <p className="mt-0.5 text-[14px] text-[#556070]">So the utility can reply. Stays on this device.</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <input
                aria-label="Your name"
                value={sender.name}
                onChange={(e) => setSender((v) => ({ ...v, name: e.target.value }))}
                maxLength={80}
                placeholder="Your name"
                autoComplete="name"
                className="h-11 rounded-[6px] border border-[#e6e9ee] bg-white px-3 text-[15px] text-[#1d2733] placeholder:text-[#6b7583] focus-visible:border-[#0ea5e9] focus-visible:outline-none"
              />
              <input
                aria-label="Your phone or email"
                value={sender.contact}
                onChange={(e) => setSender((v) => ({ ...v, contact: e.target.value }))}
                maxLength={120}
                placeholder="Your phone or email"
                className="h-11 rounded-[6px] border border-[#e6e9ee] bg-white px-3 text-[15px] text-[#1d2733] placeholder:text-[#6b7583] focus-visible:border-[#0ea5e9] focus-visible:outline-none"
              />
            </div>
          </Step>

          <Step n={3} title="File it">
            <button
              type="button"
              onClick={routing.delivery === "pick" ? pickFirst : file}
              className={`min-h-11 w-full rounded-[6px] px-4 py-2 text-[16px] font-semibold leading-tight text-white transition-colors ${
                routing.delivery === "pick" ? "bg-[#64748b] hover:bg-[#475569]" : "bg-[#0ea5e9] hover:bg-[#0284c7]"
              } ${FOCUS}`}
            >
              {routing.delivery === "pick" ? "Pick the utility first" : "File report"}
            </button>
            {routing.delivery === "pick" && (
              <>
                <p className="mt-2 text-[14px] text-[#556070]">
                  The letter needs to be addressed to the company that serves this spot. Its name is at the top of your
                  electric bill. If you still can&apos;t tell, call one of these:
                </p>
                <EmergencyNumbers contacts={contacts} className="mt-1" />
              </>
            )}
            <div>
              {status !== "idle" && lastReport && (
                <div className="mt-3">
                  <p aria-live="polite" className="text-[15px] font-medium text-[#1d2733]">
                    {status === "saved"
                      ? "Report filed and saved on this device. Now send it:"
                      : "Report filed, but this browser would not let us save it. Send it now:"}
                  </p>
                  <div className="mt-2">
                    <SendLetter key={lastReport.id} r={lastReport} primary />
                  </div>
                </div>
              )}
            </div>
            {status === "idle" && routing.delivery !== "pick" && (
              <p className="mt-3 text-[14px] text-[#6b7583]">
                {routing.delivery === "email"
                  ? `Filing saves the report on this device. Then press Email to open the finished letter, addressed to ${routing.email}.`
                  : `Filing saves the report on this device. Then press the button to copy the letter and open ${routing.utility?.short}'s report page.`}
              </p>
            )}
          </Step>
        </>
      )}

      <section className="border-t border-[#e6e9ee] px-6 py-6">
        <h3 className="text-[17px] font-semibold leading-snug text-[#1d2733]">My reports</h3>
        {reports.length === 0 ? (
          <p className="mt-2 text-[15px] text-[#556070]">No reports yet. Reports you file show up here.</p>
        ) : (
          <ul className="mt-3 flex flex-col">
            {reports.map((r) => (
              <li key={r.id} className="border-t border-[#e6e9ee] py-4 first:border-t-0 first:pt-1">
                <p className="text-[15px] font-semibold leading-snug text-[#1d2733]">{r.title}</p>
                <p className="mt-0.5 text-[14px] text-[#6b7583]">
                  {fmtWhen(r.createdAt)}
                  {r.contact.name ? ` · goes to ${r.contact.name}` : ""}
                  {r.email?.to ? ` (${r.email.to})` : r.email ? " (report page)" : ""}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <SendLetter r={r} />
                  <button
                    type="button"
                    onClick={() => downloadTxt(r.text, reportFileName(r.title, r.createdAt))}
                    className={SMALL_BTN}
                  >
                    Download
                  </button>
                  <button type="button" onClick={() => copy(r)} className={SMALL_BTN}>
                    {copiedId === r.id ? "Copied" : r.email ? "Copy letter" : "Copy"}
                  </button>
                  {!(r.email && !r.email.to) && (
                    <a href={r.contact.url} target="_blank" rel="noopener noreferrer" className={SMALL_BTN}>
                      Official site
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(r.id)}
                    className={SMALL_BTN}
                    aria-label={`Delete report: ${r.title}`}
                  >
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
    </div>
  );
}
