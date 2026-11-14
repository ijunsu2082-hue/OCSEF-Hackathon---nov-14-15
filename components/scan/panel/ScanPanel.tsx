"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { scanReportMarkdown } from "@/lib/scan";
import { RISK_COLORS } from "@/lib/scan/colors";
import type { DailyRating, LineRatingNow, NicheCase, RiskLevel, ScanResult } from "@/lib/scan";
import type { PanelTab, ReportTarget } from "@/lib/scan/target";
import { AreaCharts } from "./AreaCharts";
import { HeroLive } from "./HeroLive";
import { GenEvents, RiskBreakdown, TopPlants } from "./Lists";
import { LocalNews, groupLocalNews } from "./LocalNews";
import ReportTab from "./ReportTab";
import { OptimizationTab, UpgradePlanTab } from "./OptimizationTab";
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
}

const LEVEL_WORD: Record<RiskLevel, string> = { LOW: "Low", WATCH: "Watch", HIGH: "High", CRITICAL: "Critical" };

function Header({ result }: { result: ScanResult }) {
  const { area, risk } = result;
  const r = area.radius_mi;
  return (
    <header className="px-6 py-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="min-w-0 text-[18px] font-semibold leading-snug text-[#1d2733]">
          {result.area_label || "Unnamed area"}
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

export default function ScanPanel(p: ScanPanelProps): JSX.Element {
  const { result, live, liveLoading, heatwave, daily, onFocus, tab, onTab, cases } = p;
  const { reportTarget, onClearTarget, onShowOnMap, onReportArea } = p;
  const areaKey = result ? `${result.area.lat}:${result.area.lon}:${result.area.radius_mi}` : "loading";
  const previousArea = useRef(areaKey);
  useEffect(() => {
    if (previousArea.current === areaKey) return;
    previousArea.current = areaKey;
    onTab("area");
  }, [areaKey, onTab]);
  const news = useMemo(() => (result ? groupLocalNews(result, cases) : null), [result, cases]);

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
            <HeroLive result={result} live={live} liveLoading={liveLoading} daily={daily} />
            <AreaCharts result={result} />
            <WhatsHere result={result} live={live} />
            <RiskBreakdown factors={result.risk.factors} />
            <TopPlants result={result} onFocus={onFocus} />
            <GenEvents result={result} />

            <footer className="border-t border-[#e6e9ee] px-6 py-6">
              <div className="flex flex-wrap gap-2">
                <CopyReport result={result} live={live} />
                <button
                  type="button"
                  onClick={onReportArea}
                  className="h-8 rounded-[6px] border border-[#e6e9ee] bg-white px-3 text-[14px] font-medium text-[#0284c7] transition-colors hover:bg-[#f6f8fa] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]"
                >
                  Report a problem with this area
                </button>
              </div>
              <p className="mt-3 text-[12px] leading-snug text-[#6b7583]">
                Sources: EIA-860 2025, OpenStreetMap (ODbL), Open-Meteo. Line ratings modeled with IEEE 738.
              </p>
            </footer>
          </>
        )}

        {tab === "news" && <LocalNews result={result} groups={news} onShowOnMap={onShowOnMap} />}

        {tab === "optimization" && <OptimizationTab key={areaKey} result={result} live={live} daily={daily} />}

        {tab === "upgrade" && <UpgradePlanTab key={areaKey} result={result} />}

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
      </div>
    </div>
  );
}
