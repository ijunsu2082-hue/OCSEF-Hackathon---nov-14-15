"use client";

import { useId, useMemo } from "react";
import { QUICK_SPOTS } from "@/lib/scan";
import type { GridData, ScanArea } from "@/lib/scan";
import { Stat, cx } from "@/components/primitives";

export interface TopBarProps {
  data: GridData | null;
  area: ScanArea;
  heatwave: boolean;
  onJump: (spot: { name: string; lat: number; lon: number }) => void;
  onRadius: (radiusMi: number) => void;
  onHeatwave: (on: boolean) => void;
}

function Mark() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="var(--panel-raised)" stroke="var(--border-strong)" />
      <circle cx="16" cy="16" r="10" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="2.5 2.5" />
      <circle cx="16" cy="16" r="5" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      <path d="M17.5 8.5 13 17h3.5l-1.5 6.5 5-9h-3.5z" fill="var(--accent)" />
    </svg>
  );
}

const SPOT_EPS = 1e-4;

export function TopBar({ data, area, heatwave, onJump, onRadius, onHeatwave }: TopBarProps) {
  const radiusId = useId();
  const spotId = useId();

  const region = useMemo(() => {
    if (!data) return null;
    const mw = data.plants.reduce((s, p) => s + (p.nameplate_mw || 0), 0);
    return {
      plants: data.plants.length,
      gw: mw / 1000,
      lines: data.lines.length,
      substations: data.substations.length,
    };
  }, [data]);

  const currentSpot =
    QUICK_SPOTS.find((s) => Math.abs(s.lat - area.lat) < SPOT_EPS && Math.abs(s.lon - area.lon) < SPOT_EPS)?.name ??
    "";

  return (
    <header
      className="relative flex h-[var(--bar-h)] shrink-0 items-center gap-4 border-b px-4"
      style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", zIndex: 40 }}
    >
      {/* Product mark */}
      <div className="flex min-w-0 items-center gap-2.5">
        <Mark />
        <div className="min-w-0 leading-tight">
          <p className="text-[15px] font-semibold tracking-tight text-ink">GridSentinel</p>
          <p className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            Area Scan · Westminster 100-mile radius
          </p>
        </div>
      </div>

      {/* Region-wide stats */}
      <div
        className="ml-2 hidden items-center gap-5 border-l pl-5 xl:flex"
        style={{ borderColor: "var(--border)" }}
        aria-label="Region totals"
      >
        {region ? (
          <>
            <Stat size="sm" label="Plants" value={region.plants.toLocaleString("en-US")} hint="EIA-860 2025" />
            <Stat size="sm" label="Nameplate" value={region.gw.toFixed(1)} unit="GW" hint="EIA-860 2025" />
            <div className="hidden items-center gap-5 2xl:flex">
              <Stat size="sm" label="Line segments" value={region.lines.toLocaleString("en-US")} hint="OSM" />
              <Stat size="sm" label="Substations" value={region.substations.toLocaleString("en-US")} hint="OSM" />
            </div>
          </>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Loading region…</span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        {/* Quick spots */}
        <label htmlFor={spotId} className="sr-only">
          Jump to a spot
        </label>
        <div className="relative hidden md:block">
          <select
            id={spotId}
            value={currentSpot}
            onChange={(e) => {
              const spot = QUICK_SPOTS.find((s) => s.name === e.target.value);
              if (spot) onJump(spot);
            }}
            className="h-8 appearance-none rounded-[var(--radius-sm)] border bg-panel py-0 pl-2.5 pr-7 text-[12px] text-ink outline-none focus-visible:border-[var(--accent)]"
            style={{ borderColor: "var(--border)" }}
          >
            <option value="" disabled>
              {currentSpot ? "Jump to…" : "Custom point · jump to…"}
            </option>
            {QUICK_SPOTS.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          <svg
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden
          >
            <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="var(--muted)" strokeWidth="1.4" />
          </svg>
        </div>

        {/* Radius */}
        <div
          className="flex h-8 items-center gap-2 rounded-[var(--radius-sm)] border bg-panel px-2.5"
          style={{ borderColor: "var(--border)" }}
        >
          <label htmlFor={radiusId} className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">
            Radius
          </label>
          <input
            id={radiusId}
            type="range"
            min={1}
            max={30}
            step={1}
            value={area.radius_mi}
            onChange={(e) => onRadius(Number(e.target.value))}
            className="gs-range w-24 lg:w-32"
          />
          <span className="num w-11 text-right text-[12px] font-semibold text-ink">{area.radius_mi} mi</span>
        </div>

        {/* Heatwave */}
        <button
          type="button"
          aria-pressed={heatwave}
          onClick={() => onHeatwave(!heatwave)}
          className={cx(
            "flex h-8 items-center gap-2 rounded-[var(--radius-sm)] border px-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] transition-colors",
          )}
          style={
            heatwave
              ? {
                  borderColor: "var(--critical)",
                  background: "color-mix(in srgb, var(--critical) 18%, transparent)",
                  color: "var(--text)",
                }
              : { borderColor: "var(--border-strong)", background: "var(--panel)", color: "var(--text-dim)" }
          }
          title="Replace live weather with a 105 °F, near-calm, full-sun afternoon (MODELED scenario)"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path
              d="M5 1.5h2v5.3a2.6 2.6 0 1 1-2 0z"
              fill="none"
              stroke={heatwave ? "var(--critical)" : "var(--warn)"}
              strokeWidth="1.2"
            />
            <circle cx="6" cy="9" r="1.2" fill={heatwave ? "var(--critical)" : "var(--warn)"} />
          </svg>
          <span className="hidden whitespace-nowrap lg:inline">
            {heatwave ? "Heatwave on · 105 °F" : "Simulate 105 °F heatwave"}
          </span>
          <span className="whitespace-nowrap lg:hidden">{heatwave ? "Heat on" : "105 °F"}</span>
        </button>
      </div>
    </header>
  );
}

export default TopBar;
