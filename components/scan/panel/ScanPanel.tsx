"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { scanReportMarkdown } from "@/lib/scan";
import { RISK_COLORS } from "@/lib/scan/colors";
import { reportUrl } from "@/lib/scan/reportLink";
import type { DailyRating, LineRatingNow, NicheCase, RiskLevel, ScanResult } from "@/lib/scan";
import type { PanelTab, ReportTarget } from "@/lib/scan/target";
import { AreaBrief, areaTakeaway } from "./AreaBrief";
import { AreaCharts } from "./AreaCharts";
import { Explainer } from "./Explainer";
import { GridChain } from "./GridChain";
import { GridImpact } from "./GridImpact";
import { HeatStress } from "./HeatStress";
import { HeroLive } from "./HeroLive";
import { GenEvents, RiskBreakdown, TopPlants } from "./Lists";
import { LiveNow } from "./LiveNow";
import type { HazardsPoll } from "./LiveHazards";
import { LocalNews, groupLocalNews } from "./LocalNews";
import { OptimizationTab } from "./OptimizationTab";
import OwnerTab from "./OwnerTab";
import { Provenance } from "./Provenance";
import ReportTab from "./ReportTab";
import { SelectedAsset } from "./SelectedAsset";
import { Tabs, tabId, tabPanelId } from "./Tabs";
import { WhatsHere } from "./WhatsHere";
import { fmtCoord, fmtNum, isNum } from "./format";

export interface ScanPanelProps {
  result: ScanResult | null; // null = data still loading
  live: LineRatingNow | null; // null while fetching
  liveLoading: boolean;
  heatwave: boolean;
  daily: DailyRating[] | null; // for result.rating_site.key
  onFocus: (lat: number, lon: number) => void; // fly map to a plant/point
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  cases: NicheCase[]; // all stories (data.cases), not just the ones in the circle
  reportTarget: ReportTarget;
  onClearTarget: () => void;
  onShowOnMap: (c: NicheCase) => void; // drop a plain pin on the map and fly there
  onReportArea: () => void; // target = this area, switch to the report tab
  selected: ReportTarget | null; // asset clicked on the map / picked in Top plants
  onSelectAsset: (t: ReportTarget | null) => void;
  onReport: (t: ReportTarget) => void; // "Report a problem" on the selected asset: target = it, switch to the report tab
  hazards?: HazardsPoll; // live hazards poll owned by the page (shared with the map)
}

const LEVEL_WORD: Record<RiskLevel, string> = { LOW: "Low", WATCH: "Watch", HIGH: "High", CRITICAL: "Critical" };

function Header({ result }: { result: ScanResult }) {
  const { area, risk } = result;
  const r = area.radius_mi;
  return (
    <header className="px-6 py-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="min-w-0 text-[18px] font-semibold leading-snug text-[#1d2733]">
          {result.area_label || "This area"}
        </h2>
        <p className="shrink-0 text-[14px] tabular-nums text-[#1d2733]">
          Risk <span className="font-semibold">{isNum(risk.score) ? fmtNum(risk.score, 0) : "—"}</span> ·{" "}
          <span className="font-semibold" style={{ color: RISK_COLORS[risk.level] }}>
            {LEVEL_WORD[risk.level] ?? risk.level}
          </span>
        </p>
      </div>
      <p className="mt-1 text-[13px] tabular-nums text-[#556070]">
        {fmtCoord(area.lat, area.lon)} · {fmtNum(r, isNum(r) && r % 1 !== 0 ? 1 : 0)} mi radius
      </p>
      {!result.inside_coverage && (
        <p className="mt-2 text-[13px] leading-snug text-[#556070]">
          This spot is outside the 100-mile study area around Westminster High School, so coverage is thinner here.
        </p>
      )}
    </header>
  );
}

/** One-sentence takeaway plus the one main action: a printable brief for the city council. */
function Takeaway({ result, live, onBrief }: { result: ScanResult; live: LineRatingNow | null; onBrief: () => void }) {
  return (
    <section className="border-t border-[#e6e9ee] px-6 py-6">
      <p className="text-[15px] leading-snug text-[#1d2733]">{areaTakeaway(result, live)}</p>
      <button
        type="button"
        onClick={onBrief}
        className="mt-4 h-10 rounded-[6px] bg-[#0ea5e9] px-4 text-[14px] font-semibold text-[#1d2733] transition-colors hover:bg-[#38bdf8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]"
      >
        Make a one-page brief for your city council
      </button>
      <p className="mt-2 text-[12px] leading-snug text-[#6b7583]">
        For city council members, city sustainability staff, and residents who want a cleaner, safer grid near them.
      </p>
    </section>
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
      className="h-8 rounded-[6px] border border-[#e6e9ee] bg-white px-3 text-[14px] font-medium text-[#1d2733] transition-colors hover:bg-[#f6f8fa] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]"
      aria-live="polite"
    >
      {state === "copied" ? "Copied" : state === "error" ? "Copy failed" : "Copy report"}
    </button>
  );
}

/** Text-link buttons next to Copy report: copy the shareable report URL, or open it in a new tab. */
function ShareReport({ result }: { result: ScanResult }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const { lat, lon, radius_mi } = result.area;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportUrl(lat, lon, radius_mi, window.location.origin));
      setState("copied");
    } catch {
      setState("error");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  };

  const LINK =
    "rounded-[6px] text-[13px] font-medium text-[#0369a1] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";
  return (
    <span className="flex items-center gap-3 px-1">
      <button type="button" onClick={copy} className={LINK} aria-live="polite">
        {state === "copied" ? "Link copied" : state === "error" ? "Copy failed" : "Share report link"}
      </button>
      <a href={reportUrl(lat, lon, radius_mi)} target="_blank" rel="noopener noreferrer" className={LINK}>
        Open printable report
      </a>
    </span>
  );
}

export default function ScanPanel(p: ScanPanelProps): JSX.Element {
  const { result, live, liveLoading, heatwave, daily, onFocus, tab, onTab, cases } = p;
  const { reportTarget, onClearTarget, onShowOnMap, onReportArea, selected, onSelectAsset, onReport } = p;
  const areaKey = result ? `${result.area.lat}:${result.area.lon}:${result.area.radius_mi}` : "loading";
  const previousArea = useRef(areaKey);
  useEffect(() => {
    if (previousArea.current === areaKey) return;
    previousArea.current = areaKey;
    onTab("area");
  }, [areaKey, onTab]);
  const news = useMemo(() => (result ? groupLocalNews(result, cases) : null), [result, cases]);
  const [briefOpen, setBriefOpen] = useState(false);

  if (!result || !news) {
    return (
      <div className="h-full overflow-y-auto bg-white text-[#1d2733]">
        <p className="px-6 py-6 text-[14px] text-[#556070]" aria-busy="true">
          Loading…
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-white text-[#1d2733]">
      <Header result={result} />
      <Tabs tab={tab} onTab={onTab} newsCount={news.within.length} />

      <div role="tabpanel" id={tabPanelId(tab)} aria-labelledby={tabId(tab)}>
        {tab === "area" && (
          <>
            {selected && (
              <SelectedAsset
                target={selected}
                result={result}
                onReport={onReport}
                onOwners={() => onTab("owners")}
                onClear={() => onSelectAsset(null)}
              />
            )}
            <HeroLive result={result} live={live} liveLoading={liveLoading} daily={daily} />
            <LiveNow
              lat={result.area.lat}
              lon={result.area.lon}
              radiusMi={result.area.radius_mi}
              hazardsFeed={p.hazards}
            />
            <AreaCharts result={result} />
            <WhatsHere result={result} live={live} />
            <RiskBreakdown factors={result.risk.factors} />
            <GridChain lat={result.area.lat} lon={result.area.lon} heatwave={heatwave} />
            <HeatStress result={result} heatwave={heatwave} />
            <TopPlants
              result={result}
              onFocus={onFocus}
              onSelect={(plant) => onSelectAsset({ kind: "plant", plant })}
            />
            <GenEvents result={result} />
            <GridImpact result={result} live={live} />
            <Takeaway result={result} live={live} onBrief={() => setBriefOpen(true)} />
            <Provenance result={result} live={live} heatwave={heatwave} />
            <Explainer />

            <footer className="border-t border-[#e6e9ee] px-6 py-6">
              <div className="flex flex-wrap items-center gap-2">
                <CopyReport result={result} live={live} />
                <ShareReport result={result} />
                <button
                  type="button"
                  onClick={onReportArea}
                  className="h-8 rounded-[6px] border border-[#e6e9ee] bg-white px-3 text-[14px] font-medium text-[#0369a1] transition-colors hover:bg-[#f6f8fa] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]"
                >
                  Report a problem with this area
                </button>
              </div>
              <p className="mt-3 text-[12px] leading-snug text-[#6b7583]">
                Sources: EIA-860 2025, OpenStreetMap (ODbL), Open-Meteo. Line ratings modeled with IEEE 738.
              </p>
            </footer>
            {briefOpen && <AreaBrief result={result} live={live} onClose={() => setBriefOpen(false)} />}
          </>
        )}

        {tab === "news" && <LocalNews result={result} groups={news} onShowOnMap={onShowOnMap} />}

        {tab === "optimization" && <OptimizationTab key={areaKey} result={result} live={live} daily={daily} />}


        {tab === "report" && (
          <ReportTab
            result={result}
            live={live}
            heatwave={heatwave}
            target={reportTarget}
            onClearTarget={onClearTarget}
            onFocus={onFocus}
          />
        )}

        {tab === "owners" && <OwnerTab target={selected ?? (reportTarget.kind !== "area" ? reportTarget : null)} />}
      </div>
    </div>
  );
}
