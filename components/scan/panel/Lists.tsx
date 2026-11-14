"use client";

import { CATEGORY_COLORS, FUEL_CATEGORY, FUEL_LABELS, RISK_COLORS, UI } from "@/lib/scan/colors";
import type { FuelKey, GenEvent, Plant, RiskFactor, RiskLevel, ScanResult } from "@/lib/scan";
import { riskLevel, riskRange, WEIGHTS, type RiskWeightKey } from "@/lib/scan/risk";
import { DASH, fmtNum, fmtPowerText, isNum } from "./format";
import { Caption, Section } from "./ui";

const fuelLabel = (k: FuelKey) => FUEL_LABELS[k] ?? String(k).replace(/_/g, " ");
const fuelColor = (k: FuelKey) => CATEGORY_COLORS[FUEL_CATEGORY[k] ?? "other"] ?? CATEGORY_COLORS.other;

function fmtMw(mw: number | null | undefined): string {
  return isNum(mw) ? fmtNum(mw, Math.abs(mw) < 100 && mw !== 0 ? 1 : 0) : DASH;
}

/* ---------------------------------------------------------------- Risk */

const LEVEL_WORD: Record<RiskLevel, string> = { LOW: "Low", WATCH: "Watch", HIGH: "High", CRITICAL: "Critical" };

export function RiskBreakdown({
  factors,
  score: scoreIn,
  level: levelIn,
}: {
  factors: RiskFactor[];
  /** Area score; computed from factors when omitted. */
  score?: number;
  level?: RiskLevel;
}) {
  const total = isNum(scoreIn) ? scoreIn : Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0));
  const level = levelIn ?? riskLevel(total);
  const range = riskRange(factors);
  return (
    <Section title="Risk factors" sources={["risk", "eia860", "osm", "ieee738", "news"]}>
      {factors.length > 0 && (
        <p className="mb-4 text-[14px] text-[#1d2733]">
          Risk <span className="font-semibold tabular-nums">{fmtNum(total, 0)}</span> ·{" "}
          <span className="font-semibold" style={{ color: RISK_COLORS[level] }}>
            {LEVEL_WORD[level]}
          </span>{" "}
          <span className="tabular-nums text-[#556070]">
            (range {fmtNum(range.min, 0)}-{fmtNum(range.max, 0)} if the weights change)
          </span>
        </p>
      )}
      {factors.length === 0 ? (
        <p className="text-[14px] text-[#556070]">No risk factors computed.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {factors.map((f) => {
            const score = isNum(f.score) ? Math.max(0, Math.min(100, f.score)) : null;
            const color = score !== null && score >= 75 ? UI.danger : UI.accent;
            return (
              <li key={f.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-[14px] text-[#1d2733]">{f.label}</span>
                  <span className="shrink-0 text-[14px] font-semibold tabular-nums text-[#1d2733]">
                    {score === null ? DASH : fmtNum(score, 0)}
                  </span>
                </div>
                <div
                  className="mt-1.5 h-1 w-full overflow-hidden rounded-[2px] bg-[#e6e9ee]"
                  role="meter"
                  aria-label={f.label}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={score ?? 0}
                >
                  <div className="h-full" style={{ width: `${score ?? 0}%`, background: color }} />
                </div>
                <p className="mt-1.5 text-[12px] leading-snug text-[#6b7583]">{f.detail}</p>
              </li>
            );
          })}
        </ul>
      )}
      <Caption className="mt-4">
        Each factor is scored 0 to 100. The area score is their weighted average. This is GridSentinel's own index, not an official utility or regulator rating.
      </Caption>
      <details className="mt-3 text-[13px] text-[#556070]">
        <summary className="cursor-pointer text-[13px] font-medium text-[#0369a1]">How this score works</summary>
        <ul className="mt-2 flex flex-col gap-2">
          {factors.map((f) => {
            const w = WEIGHTS[f.key as RiskWeightKey];
            return (
              <li key={f.key} className="leading-snug">
                <span className="text-[#1d2733]">{f.label}</span>{" "}
                <span className="tabular-nums">({fmtNum(f.weight * 100, 0)}%)</span>
                {w ? `: ${w.reason}` : null}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 leading-snug">
          The range shows the lowest and highest score if each weight is moved up or down by half.
        </p>
        <p className="mt-2 leading-snug">
          This is our own index. It has not yet been checked against official outage records (SAIDI/SAIFI) or shutoff history.
        </p>
      </details>
    </Section>
  );
}

/* ---------------------------------------------------------------- Plants */

const PLANT_COLS = "grid grid-cols-[minmax(0,1fr)_96px_56px_44px] items-baseline gap-x-3";

export function TopPlants({
  result,
  onFocus,
  onSelect,
}: {
  result: ScanResult;
  onFocus: (lat: number, lon: number) => void;
  /** Row click also selects the plant (shows its card), without rescanning. */
  onSelect?: (p: Plant) => void;
}) {
  const top = result.plants.slice(0, 8);
  return (
    <Section title="Top plants" sources={["eia860"]}>
      {top.length === 0 ? (
        <p className="text-[14px] text-[#556070]">No EIA-860 plants in this area.</p>
      ) : (
        <div>
          <div aria-hidden className={`${PLANT_COLS} border-b border-[#e6e9ee] pb-2 text-[12px] text-[#6b7583]`}>
            <span>Plant</span>
            <span>Fuel</span>
            <span className="text-right">MW</span>
            <span className="text-right">Age</span>
          </div>
          {top.map((p) => (
            <button
              key={p.plant_code}
              type="button"
              onClick={() => {
                onFocus(p.lat, p.lon);
                onSelect?.(p);
              }}
              className={`${PLANT_COLS} -mx-2 w-[calc(100%+16px)] rounded-[6px] px-2 py-2 text-left transition-colors hover:bg-[#f6f8fa] focus-visible:bg-[#f6f8fa] focus-visible:outline-2 focus-visible:outline-[#0284c7]`}
              title={`Show ${p.plant_name} on the map`}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: fuelColor(p.primary_source) }}
                    aria-hidden
                  />
                  <span className="truncate text-[14px] text-[#1d2733]">{p.plant_name}</span>
                </span>
                <span className="block truncate pl-3.5 text-[12px] text-[#6b7583]">{p.city || DASH}</span>
              </span>
              <span className="truncate text-[13px] text-[#556070]">
                {fuelLabel(p.primary_source)}
              </span>
              <span className="text-right text-[14px] tabular-nums text-[#1d2733]">
                {fmtMw(p.nameplate_mw)}
              </span>
              <span className="text-right text-[13px] tabular-nums text-[#556070]">
                {isNum(p.capacity_weighted_age_years) ? `${fmtNum(p.capacity_weighted_age_years, 0)} yr` : DASH}
              </span>
            </button>
          ))}
        </div>
      )}
      {top.length > 0 && (
        <Caption className="mt-3">
          {`Largest ${top.length} of ${fmtNum(result.plants.length)} plants. Click a row to show it on the map.`}
        </Caption>
      )}
    </Section>
  );
}

/* ---------------------------------------------------------------- Events */

const EVENT_COLS = "grid grid-cols-[minmax(0,1fr)_56px_44px] items-baseline gap-x-3";

function EventTable({ title, events }: { title: string; events: GenEvent[] }) {
  const sorted = [...events].sort((a, b) => (b.mw || 0) - (a.mw || 0));
  const shown = sorted.slice(0, 6);
  const total = events.reduce((s, e) => s + (isNum(e.mw) ? e.mw : 0), 0);
  return (
    <div>
      <p className="mb-1 flex items-baseline justify-between gap-3 text-[14px] text-[#1d2733]">
        <span className="font-semibold">
          {title} <span className="font-normal tabular-nums text-[#6b7583]">({events.length})</span>
        </span>
        <span className="tabular-nums text-[#556070]">{fmtPowerText(total)}</span>
      </p>
      {shown.length === 0 ? (
        <p className="text-[13px] text-[#556070]">None in this area.</p>
      ) : (
        <div role="table" aria-label={`${title} generators`}>
          <div role="row" className={`${EVENT_COLS} border-b border-[#e6e9ee] py-1 text-[12px] text-[#6b7583]`}>
            <span role="columnheader">Plant</span>
            <span role="columnheader" className="text-right">MW</span>
            <span role="columnheader" className="text-right">Year</span>
          </div>
          {shown.map((e, i) => (
            <div key={`${e.plant_name}-${i}`} role="row" className={`${EVENT_COLS} py-1 text-[13px]`}>
              <span role="cell" className="truncate text-[#1d2733]" title={`${e.plant_name} · ${e.technology}`}>
                {e.plant_name}
              </span>
              <span role="cell" className="text-right tabular-nums text-[#1d2733]">
                {fmtMw(e.mw)}
              </span>
              <span role="cell" className="text-right tabular-nums text-[#556070]">
                {isNum(e.year) ? e.year : DASH}
              </span>
            </div>
          ))}
          {sorted.length > shown.length && (
            <p className="pt-1 text-[12px] text-[#6b7583]">{sorted.length - shown.length} more not shown</p>
          )}
        </div>
      )}
    </div>
  );
}

export function GenEvents({ result }: { result: ScanResult }) {
  const retired = result.events.filter((e) => e.kind === "retired");
  const proposed = result.events.filter((e) => e.kind === "proposed");
  return (
    <Section title="Retired and proposed generators" sources={["eia860_events"]}>
      <div className="flex flex-col gap-6">
        <EventTable title="Retired" events={retired} />
        <EventTable title="Proposed" events={proposed} />
      </div>
    </Section>
  );
}
