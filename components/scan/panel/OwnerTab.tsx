"use client";

import { useMemo } from "react";
import type { ReportTarget } from "@/lib/scan/target";
import { KIND_WORD, assetName, claimHref, fromTarget } from "@/components/owner/assets";
import { fmtDate, todayIso } from "@/components/owner/calendar";
import { nextDeadline, previewFor } from "@/components/owner/engine";
import { ConfidenceText, FREQUENCY_WORD } from "@/components/owner/ui";
import { Caption } from "./ui";

/*
 * "For owners": a public preview of the filings that typically apply to the selected
 * plant, substation or line, from public data only. Owners sign in and verify to get
 * the full calendar with prefilled fields (/owner).
 */

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";
const LINK = `text-[#0369a1] underline-offset-2 hover:underline ${FOCUS}`;

export default function OwnerTab({ target }: { target: ReportTarget | null }) {
  const asset = fromTarget(target);
  const rows = useMemo(() => {
    if (!asset) return [];
    const today = todayIso();
    return previewFor(asset).map((o) => ({ o, next: nextDeadline(o, today) }));
  }, [asset]);

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
          <h3 className="text-[15px] font-semibold leading-snug">Filings for owners</h3>
          <p className="mt-2 text-[14px] leading-relaxed text-[#556070]">
            Click a power plant, substation or power line on the map to see the filings its owner typically makes, with
            the next due dates.
          </p>
        </section>
      ) : (
        <section className="border-t border-[#e6e9ee] px-6 py-6" aria-labelledby="owner-tab-title">
          <p className="text-[13px] text-[#6b7583]">{KIND_WORD[asset.kind]}</p>
          <h3 id="owner-tab-title" className="mt-0.5 text-[16px] font-semibold leading-snug">
            {assetName(asset)}
          </h3>
          <p className="mt-3 text-[14px] font-semibold">Filings that typically apply</p>
          <Caption className="mt-1">
            Preview from public data. Owners get the full calendar with prefilled fields after verification.
          </Caption>

          {rows.length === 0 ? (
            <p className="mt-3 text-[14px] leading-relaxed text-[#556070]">
              No filings in our list match what public data shows about this asset. An owner can still sign in to check.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col divide-y divide-[#e6e9ee] border-y border-[#e6e9ee]">
              {rows.map(({ o, next }) => (
                <li key={o.id} className="py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 text-[14px] font-semibold leading-snug">{o.title}</p>
                    <span className="shrink-0">
                      <ConfidenceText c={o.confidence} />
                    </span>
                  </div>
                  <p className="mt-0.5 text-[13px] leading-snug text-[#556070]">
                    {o.form} · {o.agency}
                  </p>
                  <p className="mt-0.5 text-[13px] leading-snug tabular-nums text-[#556070]">
                    {FREQUENCY_WORD[o.frequency]} ·{" "}
                    {next ? (
                      <>
                        Next due <span className="font-semibold text-[#1d2733]">{fmtDate(next.due)}</span> ({next.periodLabel})
                      </>
                    ) : (
                      o.dueRule
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <a
            href={claimHref(asset)}
            className={`mt-5 inline-flex min-h-10 items-center justify-center rounded-[6px] bg-[#0ea5e9] px-4 text-[14px] font-semibold text-[#1d2733] transition-colors hover:bg-[#38bdf8] ${FOCUS}`}
          >
            I own this — sign in to manage filings
          </a>
        </section>
      )}
    </div>
  );
}
