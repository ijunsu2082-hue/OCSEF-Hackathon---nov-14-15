"use client";

import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import type { PanelTab } from "@/lib/scan/target";

const ORDER: PanelTab[] = ["area", "optimization", "upgrade", "news", "report", "owners"];

export const tabId = (t: PanelTab) => `gs-tab-${t}`;
export const tabPanelId = (t: PanelTab) => `gs-tabpanel-${t}`;

/** Text tabs under the panel header. Active tab gets a 2px sky underline. */
export function Tabs({
  tab,
  onTab,
  newsCount,
}: {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  newsCount: number;
}) {
  const refs = useRef<Record<PanelTab, HTMLButtonElement | null>>({
    area: null,
    optimization: null,
    upgrade: null,
    news: null,
    report: null,
    owners: null,
  });
  const labels: Record<PanelTab, string> = {
    area: "Area",
    optimization: "Optimize",
    upgrade: "Upgrades",
    news: `Local news (${newsCount})`,
    report: "Report a problem",
    owners: "Owners",
  };

  // Six tabs scroll sideways in the panel: keep the active one in view (e.g. after "Owner filings").
  useEffect(() => {
    const el = refs.current[tab];
    const list = el?.parentElement;
    if (!el || !list) return;
    const left = el.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
    const right = left + el.offsetWidth;
    const pad = 24; // the strip's px-6
    if (left - pad < list.scrollLeft) list.scrollLeft = Math.max(0, left - pad);
    else if (right + pad > list.scrollLeft + list.clientWidth) list.scrollLeft = right + pad - list.clientWidth;
  }, [tab]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = ORDER.indexOf(tab);
    let next: PanelTab | null = null;
    if (e.key === "ArrowRight") next = ORDER[(i + 1) % ORDER.length];
    else if (e.key === "ArrowLeft") next = ORDER[(i - 1 + ORDER.length) % ORDER.length];
    else if (e.key === "Home") next = ORDER[0];
    else if (e.key === "End") next = ORDER[ORDER.length - 1];
    if (!next) return;
    e.preventDefault();
    onTab(next);
    refs.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label="Scan panel" onKeyDown={onKey} className="flex gap-5 overflow-x-auto border-b border-[#e6e9ee] px-6">
      {ORDER.map((t) => {
        const active = t === tab;
        return (
          <button
            key={t}
            ref={(el) => {
              refs.current[t] = el;
            }}
            type="button"
            role="tab"
            id={tabId(t)}
            aria-selected={active}
            aria-controls={tabPanelId(t)}
            tabIndex={active ? 0 : -1}
            onClick={() => onTab(t)}
            className={`-mb-px shrink-0 border-b-2 py-3 text-[14px] tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9] ${
              active
                ? "border-[#0ea5e9] font-semibold text-[#1d2733]"
                : "border-transparent font-medium text-[#556070] hover:text-[#1d2733]"
            }`}
          >
            {labels[t]}
          </button>
        );
      })}
    </div>
  );
}
