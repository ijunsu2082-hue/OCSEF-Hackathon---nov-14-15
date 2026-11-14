"use client";

import type { ReactNode } from "react";
import { CATEGORY_COLORS, CATEGORY_LABELS, FUEL_CATEGORY, FUEL_LABELS, UI } from "@/lib/scan/colors";
import type { EnergyCategory } from "@/lib/scan/colors";
import type { FuelKey, KvBand, ScanResult } from "@/lib/scan";
import { fmtNum, fmtPct, fmtPowerText, isNum } from "./format";
import { Section, SourcedTitle } from "./ui";
import type { SourceId } from "@/lib/scan/sources";

/*
 * "At a glance": the clicked area's totals as small, directly labeled charts.
 * Every value comes from the ScanResult; nothing is hard-coded.
 */

const GRID = UI.border; // #e6e9ee

const KV_ORDER: KvBand[] = ["500+", "200-499", "100-199", "<100", "unknown"];
const KV_LABEL: Record<KvBand, string> = {
  "500+": "500 kV +",
  "200-499": "200–499 kV",
  "100-199": "100–199 kV",
  "<100": "Under 100 kV",
  unknown: "Unknown",
};
const KV_COLOR: Record<KvBand, string> = {
  "500+": UI.accentStrong, // #0284c7
  "200-499": UI.accent, // #0ea5e9
  "100-199": "#7dd3fc",
  "<100": "#94a3b8",
  unknown: "#cbd5e1",
};

const fuelLabel = (k: FuelKey) => FUEL_LABELS[k] ?? String(k).replace(/_/g, " ");
const num = (n: number | null | undefined) => (isNum(n) ? n : 0);
/** Share as a whole percent, but "<1%" for a real sliver instead of "0%". */
const share = (part: number, whole: number) => {
  if (!(whole > 0) || !(part > 0)) return fmtPct(0);
  const pct = (part / whole) * 100;
  return pct < 0.5 ? "<1%" : fmtPct(pct);
};

/* ---------- shared pieces ---------- */

function Block({
  title,
  caption,
  sources,
  children,
}: {
  title: string;
  caption: ReactNode;
  sources?: SourceId[];
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <SourcedTitle
        sources={sources}
        heading={<h4 className="min-w-0 text-[14px] font-semibold leading-snug text-[#1d2733]">{title}</h4>}
      />
      <p className="mb-2 text-[13px] leading-snug tabular-nums text-[#556070]">{caption}</p>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-[#556070]">{children}</p>;
}

interface BarItem { key: string; label: string; value: number; color: string; text: string }

/** Horizontal bars, labeled directly (label | bar | value). Width = value / max. */
function HBars({ items, max }: { items: BarItem[]; max: number }) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5">
      {items.map((it) => {
        const w = max > 0 ? Math.max(0, Math.min(100, (it.value / max) * 100)) : 0;
        return (
          <div key={it.key} className="contents">
            <span className="truncate text-[13px] leading-snug text-[#556070]" title={it.label}>
              {it.label}
            </span>
            <div className="h-2.5 w-full" aria-hidden>
              {it.value > 0 && (
                <div
                  className="h-full rounded-[2px]"
                  style={{ width: `${w}%`, minWidth: 2, background: it.color }}
                />
              )}
            </div>
            <span className="text-right text-[13px] font-semibold tabular-nums text-[#1d2733]">{it.text}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- 1. Energy mix ---------- */

function EnergyMix({ r }: { r: ScanResult }) {
  const t = r.totals;
  const total = num(t.nameplate_mw);
  if (total <= 0) {
    return (
      <Block title="Energy mix" sources={["eia860"]} caption="Plant capacity by type of source.">
        <Empty>No power plants in this area.</Empty>
      </Block>
    );
  }
  const other = Math.max(0, total - num(t.renewable_mw) - num(t.storage_mw) - num(t.fossil_mw));
  const parts: { cat: EnergyCategory; mw: number }[] = [
    { cat: "renewable", mw: num(t.renewable_mw) },
    { cat: "storage", mw: num(t.storage_mw) },
    { cat: "fossil", mw: num(t.fossil_mw) },
    ...(other > 0.5 ? [{ cat: "other" as EnergyCategory, mw: other }] : []),
  ];
  const items: BarItem[] = parts.map((p) => ({
    key: p.cat,
    label: CATEGORY_LABELS[p.cat],
    value: p.mw,
    color: CATEGORY_COLORS[p.cat],
    text: `${fmtPowerText(p.mw)} · ${share(p.mw, total)}`,
  }));
  return (
    <Block
      title="Energy mix"
      sources={["eia860"]}
      caption={`Renewables are ${fmtPct(t.renewable_pct)} of the ${fmtPowerText(total)} of plants here.`}
    >
      {/* bars are scaled to the area's total, so each bar is its share */}
      <HBars items={items} max={total} />
    </Block>
  );
}

/* ---------- 2. Capacity by fuel ---------- */

function FuelBars({ r }: { r: ScanResult }) {
  const fuels = (Object.entries(r.totals.mw_by_source ?? {}) as [FuelKey, number][])
    .filter(([, mw]) => isNum(mw) && mw > 0)
    .sort((a, b) => b[1] - a[1]);
  if (fuels.length === 0) {
    return (
      <Block title="Capacity by fuel" sources={["eia860"]} caption="Plant capacity by fuel.">
        <Empty>No power plants in this area.</Empty>
      </Block>
    );
  }
  const total = fuels.reduce((s, [, mw]) => s + mw, 0);
  const top = fuels.slice(0, 6);
  const [lead, leadMw] = top[0];
  const items: BarItem[] = top.map(([k, mw]) => ({
    key: k,
    label: fuelLabel(k),
    value: mw,
    color: CATEGORY_COLORS[FUEL_CATEGORY[k] ?? "other"],
    text: `${fmtPowerText(mw)} · ${share(mw, total)}`,
  }));
  return (
    <Block
      title="Capacity by fuel"
      sources={["eia860"]}
      caption={`${fuelLabel(lead)} is the largest source here, at ${fmtPowerText(leadMw)}.`}
    >
      <HBars items={items} max={leadMw} />
      {fuels.length > top.length && (
        <p className="mt-1.5 text-[12px] text-[#6b7583]">
          {fuels.length - top.length} smaller fuel{fuels.length - top.length === 1 ? "" : "s"} not shown.
        </p>
      )}
    </Block>
  );
}

/* ---------- 3. Age of plants ---------- */

export interface DecadeBin { decade: number; label: string; mw: number; count: number }

/** MW and plant count per decade online (capacity-weighted year, else oldest year). */
export function ageBins(r: ScanResult): { bins: DecadeBin[]; undated: number } {
  const byDecade = new Map<number, { mw: number; count: number }>();
  let undated = 0;
  for (const p of r.plants) {
    const y = isNum(p.capacity_weighted_year) ? p.capacity_weighted_year : p.oldest_year;
    if (!isNum(y)) {
      undated += 1;
      continue;
    }
    const d = Math.floor(y / 10) * 10;
    const cur = byDecade.get(d) ?? { mw: 0, count: 0 };
    cur.mw += num(p.nameplate_mw);
    cur.count += 1;
    byDecade.set(d, cur);
  }
  if (byDecade.size === 0) return { bins: [], undated };
  const decades = [...byDecade.keys()];
  const lo = Math.min(...decades);
  const hi = Math.max(...decades);
  const bins: DecadeBin[] = [];
  for (let d = lo; d <= hi; d += 10) {
    const b = byDecade.get(d) ?? { mw: 0, count: 0 };
    bins.push({ decade: d, label: `${d}s`, mw: b.mw, count: b.count });
  }
  return { bins, undated };
}

function AgeHistogram({ r }: { r: ScanResult }) {
  const { bins, undated } = ageBins(r);
  if (bins.length === 0) {
    return (
      <Block title="Age of plants" sources={["eia860"]} caption="Plant MW by the decade it came online.">
        <Empty>{r.plants.length === 0 ? "No power plants in this area." : "No start years recorded for these plants."}</Empty>
      </Block>
    );
  }
  const peak = bins.reduce((a, b) => (b.mw > a.mw ? b : a), bins[0]);
  // With many decades the columns get too narrow to label each one: label only the peak,
  // and every other decade on the axis.
  const many = bins.length > 10;
  const max = peak.mw;
  return (
    <Block
      title="Age of plants"
      sources={["eia860"]}
      caption={`MW by decade online. Biggest: the ${peak.label}, at ${fmtPowerText(peak.mw)}.`}
    >
      <div className="flex h-[132px] w-full items-end gap-1 border-b pt-4" style={{ borderColor: GRID }} role="img"
        aria-label={bins.map((b) => `${b.label}: ${fmtNum(b.mw, 0)} MW`).join(", ")}>
        {bins.map((b, i) => {
          const h = max > 0 ? (b.mw / max) * 100 : 0;
          const showValue = b.mw > 0 && (!many || b === peak);
          return (
            <div key={b.decade} className="relative h-full min-w-0 flex-1"
              title={`${b.label}: ${fmtPowerText(b.mw)}, ${fmtNum(b.count)} plant${b.count === 1 ? "" : "s"}`}>
              {b.mw > 0 && (
                <div className="absolute inset-x-0 bottom-0 rounded-t-[2px]" style={{ height: `${h}%`, minHeight: 2, background: UI.accent }} />
              )}
              {showValue && (
                <span className={`absolute whitespace-nowrap text-[11px] ${
                    i === bins.length - 1 && bins.length > 6 ? "right-0 text-right" : i === 0 && bins.length > 6 ? "left-0 text-left" : "inset-x-0 text-center"
                  } leading-none tabular-nums text-[#1d2733]`}
                  style={{ bottom: `calc(${h}% + 3px)` }}>
                  {fmtNum(b.mw, 0)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex w-full gap-1">
        {bins.map((b, i) => (
          <span key={b.decade} className="min-w-0 flex-1 text-center text-[11px] tabular-nums text-[#6b7583]">
            {many ? (i % 2 === 0 ? b.label : "") : bins.length <= 6 ? b.label : `'${String(b.decade).slice(2)}s`}
          </span>
        ))}
      </div>
      {undated > 0 && (
        <p className="mt-1 text-[12px] tabular-nums text-[#6b7583]">
          {fmtNum(undated)} plant{undated === 1 ? "" : "s"} with no start year not shown.
        </p>
      )}
    </Block>
  );
}

/* ---------- 4. Power lines by voltage ---------- */

function LinesByVoltage({ r }: { r: ScanResult }) {
  const t = r.totals;
  const byKv = t.line_miles_by_kv ?? ({} as Record<KvBand, number>);
  const bands = KV_ORDER.filter((k) => isNum(byKv[k]) && byKv[k] >= 0.05);
  if (bands.length === 0 || num(t.line_miles) <= 0) {
    return (
      <Block title="Power lines by voltage" sources={["osm"]} caption="Miles of transmission line inside the circle.">
        <Empty>No transmission lines in this area.</Empty>
      </Block>
    );
  }
  const miles = (m: number) => `${fmtNum(m, m > 0 && m < 10 ? 1 : 0)} mi`;
  const max = Math.max(...bands.map((k) => byKv[k]));
  const items: BarItem[] = bands.map((k) => ({
    key: k,
    label: KV_LABEL[k],
    value: byKv[k],
    color: KV_COLOR[k],
    text: miles(byKv[k]),
  }));
  return (
    <Block
      title="Power lines by voltage"
      sources={["osm"]}
      caption={`${miles(t.line_miles)} of transmission line here, by voltage.`}
    >
      <HBars items={items} max={max} />
    </Block>
  );
}

/* ---------- 5. Changes ---------- */

function Changes({ r }: { r: ScanResult }) {
  const t = r.totals;
  const rows = [
    { key: "retired", label: "Already retired", value: num(t.retired_mw), color: "#94a3b8" },
    { key: "proposed", label: "Proposed", value: num(t.proposed_mw), color: UI.accent },
    { key: "planned", label: "Planned to retire", value: num(t.planned_retirement_mw), color: "#cbd5e1" },
  ];
  const max = Math.max(...rows.map((x) => x.value));
  if (max <= 0) {
    return (
      <Block title="Changes" sources={["eia860_events"]} caption="Plant MW retired, proposed, and planned to retire.">
        <Empty>No retirements or proposed plants recorded in this area.</Empty>
      </Block>
    );
  }
  const items: BarItem[] = rows.map((x) => ({ ...x, text: fmtPowerText(x.value) }));
  return (
    <Block title="Changes" sources={["eia860_events"]} caption="Plant MW retired, proposed, and planned to retire.">
      <HBars items={items} max={max} />
    </Block>
  );
}

/* ---------- section ---------- */

export function AreaCharts({ result }: { result: ScanResult }) {
  return (
    <Section title="At a glance">
      <div className="flex flex-col gap-6">
        <EnergyMix r={result} />
        <FuelBars r={result} />
        <AgeHistogram r={result} />
        <LinesByVoltage r={result} />
        <Changes r={result} />
      </div>
    </Section>
  );
}
