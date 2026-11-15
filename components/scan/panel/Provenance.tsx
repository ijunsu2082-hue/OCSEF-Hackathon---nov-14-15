"use client";

import type { LineRatingNow, ScanResult } from "@/lib/scan";
import { provenanceFor } from "@/lib/scan/provenance";
import { MethodBadge } from "./MethodBadge";
import { Caption, Section } from "./ui";

/** "Where these numbers come from": each headline number in the Area tab with its method, source and formula. */
export function Provenance({
  result,
  live,
  heatwave,
}: {
  result: ScanResult;
  live: LineRatingNow | null;
  heatwave: boolean;
}) {
  const rows = provenanceFor(result, live, heatwave);

  return (
    <Section title="Where these numbers come from">
      <ul className="flex flex-col print:break-inside-avoid">
        {rows.map((r) => (
          <li key={r.label} className="flex flex-col gap-1 border-b border-[#e6e9ee] py-3 first:pt-0 last:border-b-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-[13px] leading-snug text-[#556070]">{r.label}</span>
              <span className="shrink-0 text-right text-[14px] font-semibold tabular-nums text-[#1d2733]">{r.value}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <MethodBadge method={r.method} />
              <a
                href={r.source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 text-[12px] leading-snug text-[#0369a1] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]"
              >
                {r.source.label}
              </a>
            </div>
            <p className="text-[13px] leading-snug text-[#556070]">{r.how}</p>
          </li>
        ))}
      </ul>
      <Caption className="mt-3">
        Measured: read from a dataset. Modeled: our own calculation. Scenario: a what-if, not a forecast. Estimate: a
        rough statewide figure.
      </Caption>
    </Section>
  );
}

export default Provenance;
