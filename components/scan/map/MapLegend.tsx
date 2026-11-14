"use client";

import { useState, type ReactNode } from "react";
import { FUEL_COLORS, FUEL_LABELS } from "@/lib/scan";
import type { FuelKey } from "@/lib/scan";
import { cx } from "@/components/primitives";

export interface LayerVisibility {
  plants: boolean;
  transmission: boolean;
  substations: boolean;
  cases: boolean;
  events: boolean;
}

const FUEL_ORDER: FuelKey[] = [
  "solar",
  "battery",
  "natural_gas",
  "wind",
  "hydro",
  "biogas",
  "oil",
  "other_gas",
  "waste_heat",
  "other",
];

const LINE_BANDS: { label: string; weight: number }[] = [
  { label: "500+ kV", weight: 3 },
  { label: "200–499 kV", weight: 2 },
  { label: "100–199 kV", weight: 1.25 },
  { label: "<100 kV / unknown", weight: 0.75 },
];

function Toggle({
  on,
  label,
  swatch,
  onClick,
}: {
  on: boolean;
  label: string;
  swatch: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cx(
        "flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 text-left text-[11.5px] transition-colors",
        on ? "text-ink" : "text-muted",
        "hover:bg-panel-raised",
      )}
    >
      <span
        aria-hidden
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border"
        style={{
          borderColor: on ? "var(--accent)" : "var(--border-strong)",
          background: on ? "var(--accent-soft)" : "transparent",
        }}
      >
        {on && (
          <svg width="9" height="9" viewBox="0 0 10 10">
            <path d="M1.5 5.2 4 7.5 8.5 2.5" fill="none" stroke="var(--accent)" strokeWidth="1.6" />
          </svg>
        )}
      </span>
      <span className="flex w-4 shrink-0 justify-center">{swatch}</span>
      <span className={cx("truncate", !on && "line-through decoration-[var(--border-strong)]")}>{label}</span>
    </button>
  );
}

export function MapLegend({
  layers,
  onChange,
}: {
  layers: LayerVisibility;
  onChange: (next: LayerVisibility) => void;
}) {
  // Toggles always visible; the full key starts collapsed on short viewports.
  const [open, setOpen] = useState(() => typeof window === "undefined" || window.innerHeight >= 980);
  const flip = (k: keyof LayerVisibility) => onChange({ ...layers, [k]: !layers[k] });

  return (
    <div
      className="absolute bottom-14 left-3 w-[236px] overflow-hidden rounded-[var(--radius-md)] border"
      style={{
        zIndex: 20,
        background: "color-mix(in srgb, var(--panel) 94%, transparent)",
        borderColor: "var(--border)",
        boxShadow: "var(--shadow-pop)",
      }}
    >
      <p
        className="border-b px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted"
        style={{ borderColor: "var(--border)" }}
      >
        Layers
      </p>
      <div className="px-2 py-2">
        <div className="space-y-0.5">
          <Toggle
            on={layers.plants}
            label="Power plants (EIA-860)"
            onClick={() => flip("plants")}
            swatch={<span className="block h-2.5 w-2.5 rounded-full" style={{ background: FUEL_COLORS.solar }} />}
          />
          <Toggle
            on={layers.transmission}
            label="Transmission (OSM)"
            onClick={() => flip("transmission")}
            swatch={<span className="block h-[2px] w-4" style={{ background: "var(--accent)" }} />}
          />
          <Toggle
            on={layers.substations}
            label="Substations (OSM)"
            onClick={() => flip("substations")}
            swatch={<span className="block h-1.5 w-1.5 rounded-full" style={{ background: "var(--text)" }} />}
          />
          <Toggle
            on={layers.cases}
            label="Niche cases"
            onClick={() => flip("cases")}
            swatch={
              <span className="block h-2 w-2 rotate-45 rounded-[1px]" style={{ background: "var(--accent-2)" }} />
            }
          />
          <Toggle
            on={layers.events}
            label="Retired / proposed (in scan)"
            onClick={() => flip("events")}
            swatch={
              <span
                className="block h-2.5 w-2.5 rounded-full border border-dashed"
                style={{ borderColor: "var(--ok)" }}
              />
            }
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between border-t px-3 py-2 text-left hover:bg-panel-raised"
        style={{ borderColor: "var(--border)" }}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Legend</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 150ms" }}
        >
          <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="var(--muted)" strokeWidth="1.4" />
        </svg>
      </button>

      {open && (
        <div className="px-2 pb-2">
          <p className="px-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">
            Plant primary fuel · size = MW
          </p>
          <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1 px-1.5">
            {FUEL_ORDER.map((k) => (
              <span key={k} className="flex items-center gap-1.5 text-[11px] text-ink-dim">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: FUEL_COLORS[k] }} />
                <span className="truncate">{FUEL_LABELS[k] ?? k}</span>
              </span>
            ))}
          </div>

          <p className="mt-3 px-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">
            Line voltage
          </p>
          <div className="mt-1 space-y-1 px-1.5">
            {LINE_BANDS.map((b) => (
              <span key={b.label} className="flex items-center gap-2 text-[11px] text-ink-dim">
                <span className="w-6 shrink-0 rounded-full" style={{ height: b.weight, background: "var(--muted)" }} />
                {b.label}
              </span>
            ))}
            <span className="flex items-center gap-2 text-[11px] text-ink-dim">
              <span className="h-[2px] w-6 shrink-0 rounded-full" style={{ background: "var(--accent)" }} />
              Inside current scan
            </span>
          </div>

          <p className="mt-3 px-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">Markers</p>
          <div className="mt-1 space-y-1 px-1.5 pb-1 text-[11px] text-ink-dim">
            <span className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--text)" }} /> Substation
            </span>
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rotate-45 rounded-[1px]" style={{ background: "var(--accent-2)" }} /> Niche case
            </span>
            <span className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full border-[1.5px]" style={{ borderColor: "var(--muted)" }} />{" "}
              Retired generator
            </span>
            <span className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full border-[1.5px] border-dashed"
                style={{ borderColor: "var(--ok)" }}
              />{" "}
              Proposed generator
            </span>
            <span className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full border-[1.5px]" style={{ borderColor: "var(--accent)" }} />{" "}
              Westminster HS · 100-mi coverage
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
