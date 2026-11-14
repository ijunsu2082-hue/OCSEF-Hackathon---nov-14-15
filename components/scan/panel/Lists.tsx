"use client";

import type { KeyboardEvent } from "react";
import { cx } from "@/components/primitives";
import { FUEL_COLORS, FUEL_LABELS, RISK_COLORS, haversineMi } from "@/lib/scan";
import type { FuelKey, GenEvent, NicheCase, RiskFactor, RiskLevel, ScanResult } from "@/lib/scan";
import { DASH, fmtNum, fmtPowerText, isNum } from "./format";
import { SrcTag } from "./ui";

const fuelColor = (k: FuelKey) => FUEL_COLORS[k] ?? "#94a3b8";
const fuelLabel = (k: FuelKey) => FUEL_LABELS[k] ?? String(k).replace(/_/g, " ");

const BAND_FALLBACK: Record<RiskLevel, string> = {
  LOW: "var(--ok)",
  WATCH: "var(--warn)",
  HIGH: "var(--high)",
  CRITICAL: "var(--critical)",
};

/** Factor score -> band. Bands match the 0-100 risk scale quartiles. */
function band(score: number): RiskLevel {
  if (score >= 75) return "CRITICAL";
  if (score >= 50) return "HIGH";
  if (score >= 25) return "WATCH";
  return "LOW";
}

/* ---------------------------------------------------------------- Risk */

export function RiskBreakdown({ factors }: { factors: RiskFactor[] }) {
  if (factors.length === 0) return <p className="text-[11px] text-muted">No risk factors computed.</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {factors.map((f) => {
        const score = isNum(f.score) ? Math.max(0, Math.min(100, f.score)) : null;
        const lvl = band(score ?? 0);
        const color = RISK_COLORS[lvl] ?? BAND_FALLBACK[lvl];
        return (
          <li key={f.key} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
              <span className="truncate font-medium text-ink">{f.label}</span>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="num text-[10px] text-muted">
                  weight {isNum(f.weight) ? `${fmtNum(f.weight * 100, 0)}%` : DASH}
                </span>
                <span className="num w-7 text-right font-semibold" style={{ color }}>
                  {score === null ? DASH : fmtNum(score, 0)}
                </span>
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-bg-elevated"
              role="meter"
              aria-label={f.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={score ?? 0}
            >
              <div className="h-full rounded-full" style={{ width: `${score ?? 0}%`, background: color }} />
            </div>
            <p className="text-[10.5px] leading-snug text-muted">{f.detail}</p>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------------------------------------------------------- Cases */

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function CaseCard({
  c,
  distanceMi,
  selected,
  onSelect,
}: {
  c: NicheCase;
  distanceMi: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={onKey}
      className={cx(
        "flex cursor-pointer flex-col gap-2 rounded-[var(--radius-sm)] border p-3 text-left transition-colors outline-none focus-visible:border-accent",
        selected ? "border-accent bg-panel-raised" : "border-line bg-panel hover:border-line-strong hover:bg-panel-raised",
      )}
      style={selected ? { boxShadow: "inset 3px 0 0 var(--accent)" } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="pill pill-neutral">{c.category}</span>
        <span className="num text-[10.5px] text-muted">{isNum(distanceMi) ? `${fmtNum(distanceMi, 1)} mi` : DASH} from center</span>
      </div>
      <h4 className="text-[13px] font-semibold leading-snug text-ink">{c.title}</h4>
      {c.shock_line && (
        <p className="border-l-2 border-line-strong pl-2 text-[11.5px] italic leading-snug text-ink-dim">
          “{c.shock_line}”
        </p>
      )}
      {c.stats.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {c.stats.slice(0, 3).map((s, i) => (
            <li key={i} className="flex flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className={cx("min-w-0 text-[10.5px] leading-snug", s.value ? "text-muted" : "text-ink-dim")}>{s.label}</span>
                {s.value && <span className="num shrink-0 text-[12px] font-semibold text-ink">{s.value}</span>}
              </div>
              <div className="flex items-center gap-2">
                <SrcTag kind={s.kind === "measured" ? "MEASURED" : "MODELED"} />
                {isUrl(s.source) ? (
                  <a
                    href={s.source}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="truncate text-[10px] text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
                    title={s.source}
                  >
                    source
                  </a>
                ) : (
                  <span className="truncate text-[10px] text-muted" title={s.source}>
                    source: {s.source}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CasesList({
  result,
  selectedCaseId,
  onSelectCase,
}: {
  result: ScanResult;
  selectedCaseId: string | null;
  onSelectCase: (c: NicheCase) => void;
}) {
  const { lat, lon } = result.area;
  if (result.cases.length === 0) {
    return (
      <p className="rounded-[var(--radius-sm)] border border-dashed border-line px-3 py-4 text-center text-[11.5px] text-muted">
        No documented niche cases in this circle — try Downtown LA or San Onofre
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {result.cases.map((c) => (
        <CaseCard
          key={c.id}
          c={c}
          distanceMi={haversineMi(lat, lon, c.location.lat, c.location.lon)}
          selected={c.id === selectedCaseId}
          onSelect={() => onSelectCase(c)}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Plants */

export function TopPlants({ result, onFocus }: { result: ScanResult; onFocus: (lat: number, lon: number) => void }) {
  const top = result.plants.slice(0, 8);
  if (top.length === 0) return <p className="text-[11px] text-muted">No EIA-860 plants inside this circle.</p>;
  return (
    <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-[var(--radius-sm)] border border-line">
      {top.map((p) => (
        <li key={p.plant_code}>
          <button
            type="button"
            onClick={() => onFocus(p.lat, p.lon)}
            className="grid w-full grid-cols-[10px_minmax(0,1fr)_auto_auto] items-center gap-x-2.5 bg-panel px-3 py-2 text-left transition-colors hover:bg-panel-raised focus-visible:bg-panel-raised focus-visible:outline-none"
            title={`${p.plant_name} · ${fuelLabel(p.primary_source)} — fly map here`}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: fuelColor(p.primary_source) }} />
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-medium text-ink">{p.plant_name}</span>
              <span className="block truncate text-[10px] text-muted">
                {p.city || DASH} · {fuelLabel(p.primary_source)}
              </span>
            </span>
            <span className="num text-right text-[12px] font-semibold text-ink">{fmtPowerText(p.nameplate_mw)}</span>
            <span className="num w-10 text-right text-[10.5px] text-muted">
              {isNum(p.capacity_weighted_age_years) ? `${fmtNum(p.capacity_weighted_age_years, 0)} yr` : DASH}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------- Events */

function EventList({ title, events, kind }: { title: string; events: GenEvent[]; kind: GenEvent["kind"] }) {
  const sorted = [...events].sort((a, b) => (b.mw || 0) - (a.mw || 0));
  const shown = sorted.slice(0, 6);
  const total = events.reduce((s, e) => s + (isNum(e.mw) ? e.mw : 0), 0);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em]"
          style={{ color: kind === "retired" ? "var(--muted)" : "var(--ok)" }}
        >
          {title} <span className="num">({events.length})</span>
        </span>
        <span className="num text-[10px] text-ink-dim">{fmtPowerText(total)}</span>
      </div>
      {shown.length === 0 ? (
        <p className="text-[10.5px] text-muted">None in this circle.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((e, i) => (
            <li key={`${e.plant_name}-${i}`} className="flex items-center gap-2 text-[10.5px]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: fuelColor(e.fuel) }} />
              <span className="min-w-0 flex-1 truncate text-ink-dim" title={`${e.plant_name} · ${e.technology}`}>
                {e.plant_name}
              </span>
              <span className="num shrink-0 text-ink">{fmtPowerText(e.mw)}</span>
              <span className="num w-9 shrink-0 text-right text-muted">{isNum(e.year) ? e.year : DASH}</span>
            </li>
          ))}
          {sorted.length > shown.length && (
            <li className="text-[10px] text-muted">+{sorted.length - shown.length} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

export function GenEvents({ result }: { result: ScanResult }) {
  const retired = result.events.filter((e) => e.kind === "retired");
  const proposed = result.events.filter((e) => e.kind === "proposed");
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <EventList title="Retired" events={retired} kind="retired" />
        <EventList title="Proposed" events={proposed} kind="proposed" />
      </div>
      <SrcTag kind="EIA-860" className="self-start" />
    </div>
  );
}
