"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LineRatingNow, ScanResult } from "@/lib/scan";
import type { ReportTarget } from "@/lib/scan/target";
import {
  HAZARDS,
  SAFETY_LINE,
  buildDraft,
  fileReport,
  loadReports,
  mailtoHref,
  reportFileName,
  reportText,
  saveReports,
  severityWord,
  type FiledReport,
  type HazardId,
  type Severity,
} from "@/lib/scan/compliance";
import { buildFacts, streamAiReport } from "@/lib/scan/aiReport";

/*
 * "Report a problem" tab. Written for a 10-year-old: three numbered steps, big text,
 * short sentences. Step 3 asks Claude (via /api/ai-report) to write the report from the scan
 * numbers; if that is unavailable it shows the standard rule-based report instead.
 * Saving only stores it on this device (localStorage); Email / Official site are how a report
 * actually reaches the utility.
 */

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";
const SMALL_BTN =
  `inline-flex h-9 items-center rounded-[6px] border border-[#e6e9ee] bg-white px-3 text-[14px] font-medium text-[#1d2733] transition-colors hover:bg-[#f6f8fa] ${FOCUS}`;

const SEVERITY_COLOR: Record<Severity, string> = { info: "#556070", warn: "#d97706", danger: "#dc2626" };

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="border-t border-[#e6e9ee] px-6 py-6">
      <h3 className="flex items-center gap-3 text-[17px] font-semibold leading-snug text-[#1d2733]">
        <span
          aria-hidden
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[#0ea5e9] text-[14px] font-semibold text-[#0284c7]"
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

const AI_HEADINGS = new Set([
  "Summary",
  "The bottleneck",
  "What this area is missing out on",
  "Proposed fix",
  "Who to contact",
]);

/** Plain-text report → headings (bold), "- " bullets, and paragraphs. */
function ReportPreview({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      blocks.push(
        <ul key={`u${blocks.length}`} className="mt-1 flex list-disc flex-col gap-1 pl-5">
          {bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2));
      continue;
    }
    flush();
    if (!line) continue;
    const heading = AI_HEADINGS.has(line.replace(/:$/, "")) || /^[A-Z][^.]{0,40}:$/.test(line);
    blocks.push(
      heading ? (
        <p key={`h${blocks.length}`} className="mt-3 font-semibold text-[#1d2733] first:mt-0">
          {line.replace(/:$/, "")}
        </p>
      ) : (
        <p key={`p${blocks.length}`} className="mt-1 first:mt-0">
          {line}
        </p>
      ),
    );
  }
  flush();
  return <div className="text-[15px] leading-relaxed text-[#1d2733]">{blocks}</div>;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function downloadTxt(r: FiledReport) {
  const blob = new Blob([reportText(r)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = reportFileName(r);
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

  const [hazards, setHazards] = useState<HazardId[]>([]);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "saved" | "memory">("idle");
  const [reports, setReports] = useState<FiledReport[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Step 3: "idle" -> "writing" (streaming) -> "done" (preview ready to save).
  const [phase, setPhase] = useState<"idle" | "writing" | "done">("idle");
  const [preview, setPreview] = useState("");
  const [source, setSource] = useState<"ai" | "standard">("ai");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Load saved reports after mount (never during render) to avoid hydration mismatches.
  useEffect(() => {
    setReports(loadReports());
  }, []);

  // A new target starts a fresh report.
  useEffect(() => {
    abortRef.current?.abort();
    setHazards([]);
    setNote("");
    setStatus("idle");
    setPhase("idle");
    setPreview("");
  }, [target]);

  const toggle = (id: HazardId) =>
    setHazards((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]));

  const write = async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStatus("idle");
    setPhase("writing");
    setPreview("");
    setSource("ai");
    const facts = buildFacts(target, result, live, heatwave, draft, hazards, note);
    const res = await streamAiReport(
      facts,
      (t) => {
        if (abortRef.current === ctrl) setPreview(t);
      },
      ctrl.signal,
    );
    if (abortRef.current !== ctrl) return; // a newer request or a target change took over
    abortRef.current = null;
    if (res.ok) {
      setPreview(res.text);
      setPhase("done");
    } else if (res.reason === "aborted") {
      setPreview("");
      setPhase("idle");
    } else {
      setSource("standard");
      setPreview(reportText(fileReport(draft, hazards, note)));
      setPhase("done");
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const file = () => {
    const r = fileReport(draft, hazards, note, new Date(), source === "ai" ? preview : undefined);
    const next = [r, ...reports];
    setReports(next);
    setStatus(saveReports(next) ? "saved" : "memory");
    setHazards([]);
    setNote("");
    setPhase("idle");
    setPreview("");
  };

  const remove = (id: string) => {
    const next = reports.filter((r) => r.id !== id);
    setReports(next);
    saveReports(next);
  };

  const copy = async (r: FiledReport) => {
    if (await copyText(reportText(r))) {
      setCopiedId(r.id);
      setTimeout(() => setCopiedId((c) => (c === r.id ? null : c)), 1500);
    }
  };

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
            className={`text-[15px] text-[#0284c7] hover:underline ${FOCUS}`}
          >
            Show on map
          </button>
          {target.kind !== "area" && (
            <button
              type="button"
              onClick={onClearTarget}
              className={`text-[15px] text-[#0284c7] hover:underline ${FOCUS}`}
            >
              Change (report the whole area instead)
            </button>
          )}
        </div>
        {target.kind === "area" && (
          <p className="mt-2 text-[14px] text-[#6b7583]">
            Want to report one plant, substation or line? Click it on the map, then press Report a problem.
          </p>
        )}
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

      <Step n={2} title="We checked it for you">
        <p className="mb-3 text-[15px] text-[#556070]">From public data about this spot:</p>
        <ul className="flex flex-col gap-3">
          {draft.issues.map((i, k) => (
            <li key={k} className="flex gap-3">
              <span
                className="w-[58px] shrink-0 text-[14px] font-semibold"
                style={{ color: SEVERITY_COLOR[i.severity] }}
              >
                {severityWord(i.severity)}
              </span>
              <span className="min-w-0 text-[15px] leading-snug text-[#1d2733]">{i.text}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[14px] text-[#556070]">
          It goes to: <span className="font-semibold text-[#1d2733]">{draft.contact.name}</span>
        </p>
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
      </Step>

      <Step n={3} title="Write it up">
        {phase === "idle" && (
          <>
            <button
              type="button"
              onClick={write}
              className={`h-12 w-full rounded-[6px] bg-[#0ea5e9] text-[16px] font-semibold text-white transition-colors hover:bg-[#0284c7] ${FOCUS}`}
            >
              Write my report
            </button>
            <p className="mt-3 text-[14px] text-[#6b7583]">
              We turn the numbers above into a short report: what is wrong, what the area is missing out on, and a fix.
            </p>
          </>
        )}

        {phase !== "idle" && (
          <div>
            {source === "standard" && (
              <p className="mb-2 text-[14px] text-[#556070]">AI writer is offline, so this is the standard report.</p>
            )}
            <div
              aria-busy={phase === "writing"}
              className="rounded-[6px] border border-[#e6e9ee] bg-white px-4 py-4 [overflow-wrap:anywhere]"
            >
              {preview ? (
                <ReportPreview text={preview} />
              ) : (
                <p className="text-[15px] text-[#556070]">Writing…</p>
              )}
            </div>
            {source === "ai" && (
              <p className="mt-2 text-[13px] text-[#6b7583]">
                Written by Claude from the numbers above. Check before sending.
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {phase === "writing" ? (
                <button type="button" onClick={stop} className={SMALL_BTN}>
                  Stop
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={file}
                    className={`inline-flex h-11 items-center rounded-[6px] bg-[#0ea5e9] px-5 text-[16px] font-semibold text-white transition-colors hover:bg-[#0284c7] ${FOCUS}`}
                  >
                    Save to My reports
                  </button>
                  <button type="button" onClick={write} className={`${SMALL_BTN} h-11`}>
                    Write it again
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        <div aria-live="polite">
          {status === "saved" && (
            <p className="mt-3 text-[15px] font-medium text-[#1d2733]">
              Saved on this device. Send it with Email or the official site to reach the utility.
            </p>
          )}
          {status === "memory" && (
            <p className="mt-3 text-[15px] font-medium text-[#1d2733]">
              Saved for now, but this browser would not let us keep it. It will be gone after a reload, so send it with
              Email, Download or the official site now.
            </p>
          )}
        </div>
        {status === "idle" && phase === "done" && (
          <p className="mt-3 text-[14px] text-[#6b7583]">
            Saving keeps the report on this device only. To reach the utility, send it with Email or the official site.
          </p>
        )}
      </Step>

      <section className="border-t border-[#e6e9ee] px-6 py-6">
        <h3 className="text-[17px] font-semibold leading-snug text-[#1d2733]">My reports</h3>
        {reports.length === 0 ? (
          <p className="mt-2 text-[15px] text-[#556070]">No reports yet. Reports you save show up here.</p>
        ) : (
          <ul className="mt-3 flex flex-col">
            {reports.map((r) => (
              <li key={r.id} className="border-t border-[#e6e9ee] py-4 first:border-t-0 first:pt-1">
                <p className="text-[15px] font-semibold leading-snug text-[#1d2733]">{r.title}</p>
                <p className="mt-0.5 text-[14px] text-[#6b7583]">
                  {fmtWhen(r.createdAt)} · goes to {r.contact.name}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a href={mailtoHref(r)} className={SMALL_BTN}>
                    Email
                  </a>
                  <button type="button" onClick={() => downloadTxt(r)} className={SMALL_BTN}>
                    Download
                  </button>
                  <button type="button" onClick={() => copy(r)} className={SMALL_BTN} aria-live="polite">
                    {copiedId === r.id ? "Copied" : "Copy"}
                  </button>
                  <a href={r.contact.url} target="_blank" rel="noopener noreferrer" className={SMALL_BTN}>
                    Official site
                  </a>
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
