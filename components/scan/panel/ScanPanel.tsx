"use client";

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { RiskPill } from "@/components/primitives";
import { scanReportMarkdown } from "@/lib/scan";
import type { DailyRating, LineRatingNow, NicheCase, ScanResult } from "@/lib/scan";
import { HeroLive } from "./HeroLive";
import { CasesList, GenEvents, RiskBreakdown, TopPlants } from "./Lists";
import { WhatsHere } from "./WhatsHere";
import { fmtCoord, fmtNum, isNum } from "./format";
import { SectionHead, Shimmer } from "./ui";

export interface ScanPanelProps {
  result: ScanResult | null; // null = data still loading
  live: LineRatingNow | null; // null while fetching
  liveLoading: boolean;
  heatwave: boolean;
  daily: DailyRating[] | null; // for result.rating_site.key
  selectedCaseId: string | null;
  onSelectCase: (c: NicheCase) => void; // W2 flies map to it + highlights
  onFocus: (lat: number, lon: number) => void; // fly map to a plant/point
}

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4" aria-busy="true" aria-label="Loading scan">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Area scan</p>
        <Shimmer className="h-6 w-3/4" />
        <Shimmer className="h-3 w-1/2" />
      </div>
      <Shimmer className="h-[260px] w-full" />
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Shimmer key={i} className="h-[120px]" />
        ))}
      </div>
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Loading grid layers…</p>
    </div>
  );
}

function Header({ result, heatwave }: { result: ScanResult; heatwave: boolean }) {
  const { area, risk } = result;
  return (
    <header className="flex flex-col gap-2 border-b border-line px-4 pb-3 pt-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
            Area scan{heatwave && <span style={{ color: "var(--critical)" }}> · heatwave</span>}
          </p>
          <h2 className="mt-0.5 text-[18px] font-semibold leading-tight text-ink">{result.area_label || "Unnamed area"}</h2>
        </div>
        <RiskPill level={risk.level} score={isNum(risk.score) ? risk.score : undefined} className="mt-1 shrink-0" />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-muted">
        <span className="num text-ink-dim">{fmtCoord(area.lat, area.lon)}</span>
        <span className="num">r {fmtNum(area.radius_mi, area.radius_mi % 1 === 0 ? 0 : 1)} mi</span>
        <span className="num">
          scanned in {isNum(result.elapsed_ms) ? fmtNum(result.elapsed_ms, result.elapsed_ms < 10 ? 1 : 0) : "—"} ms
        </span>
      </div>
      {!result.inside_coverage && (
        <p
          className="rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[11px] leading-snug"
          style={{
            color: "var(--warn)",
            borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)",
            background: "color-mix(in srgb, var(--warn) 8%, transparent)",
          }}
        >
          Outside the 100-mile study area around Westminster High School — plant, line and case coverage thins out here.
        </p>
      )}
    </header>
  );
}

function CopyReport({ result, live }: { result: ScanResult; live: LineRatingNow | null }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(scanReportMarkdown(result, live));
      setState("copied");
    } catch {
      setState("error");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] border border-line-strong bg-panel-raised px-3 py-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink transition-colors hover:border-accent hover:text-accent"
      aria-live="polite"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
        {state === "copied" ? (
          <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <>
            <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </>
        )}
      </svg>
      {state === "copied" ? "Copied" : state === "error" ? "Copy failed" : "Copy scan report"}
    </button>
  );
}

export default function ScanPanel(p: ScanPanelProps): JSX.Element {
  const { result, live, liveLoading, heatwave, daily, selectedCaseId, onSelectCase, onFocus } = p;

  if (!result) {
    return (
      <div className="h-full overflow-y-auto bg-panel text-ink">
        <PanelSkeleton />
      </div>
    );
  }

  const retiredCount = result.events.filter((e) => e.kind === "retired").length;
  const proposedCount = result.events.length - retiredCount;

  return (
    <div className="h-full overflow-y-auto bg-panel text-ink">
      <Header result={result} heatwave={heatwave} />

      <div className="flex flex-col gap-6 px-4 py-4">
        <HeroLive result={result} live={live} liveLoading={liveLoading} daily={daily} />

        <section>
          <SectionHead index="01" title="What's here" aside={`${fmtNum(result.area.radius_mi, result.area.radius_mi % 1 === 0 ? 0 : 1)}-mile circle`} />
          <WhatsHere result={result} live={live} />
        </section>

        <section>
          <SectionHead
            index="02"
            title="Risk breakdown"
            aside={<RiskPill level={result.risk.level} score={isNum(result.risk.score) ? result.risk.score : undefined} />}
          />
          <RiskBreakdown factors={result.risk.factors} />
        </section>

        <section>
          <SectionHead index="03" title="Niche cases in this area" aside={<span className="num">{result.cases.length} found</span>} />
          <CasesList result={result} selectedCaseId={selectedCaseId} onSelectCase={onSelectCase} />
        </section>

        <section>
          <SectionHead
            index="04"
            title="Top plants"
            aside={<span className="num">{Math.min(8, result.plants.length)} of {fmtNum(result.plants.length)}</span>}
          />
          <TopPlants result={result} onFocus={onFocus} />
        </section>

        <section>
          <SectionHead
            index="05"
            title="Retired / proposed generators"
            aside={
              <span className="num">
                {retiredCount} retired · {proposedCount} proposed
              </span>
            }
          />
          <GenEvents result={result} />
        </section>
      </div>

      <footer className="flex flex-col gap-2 border-t border-line px-4 py-4">
        <div>
          <CopyReport result={result} live={live} />
        </div>
        <p className="font-mono text-[9.5px] uppercase leading-relaxed tracking-[0.1em] text-muted">
          Sources: EIA-860 2025 · OpenStreetMap ODbL · Open-Meteo · IEEE 738 model
        </p>
      </footer>
    </div>
  );
}
