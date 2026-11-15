"use client";

import { useId } from "react";
import { QUICK_SPOTS } from "@/lib/scan";
import type { GridData, ScanArea } from "@/lib/scan";

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
    <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="6" fill="#0ea5e9" />
      <circle cx="16" cy="16" r="7" fill="none" stroke="#ffffff" strokeWidth="3" />
    </svg>
  );
}

const SPOT_EPS = 1e-4;

export function TopBar({ area, heatwave, onJump, onRadius, onHeatwave }: TopBarProps) {
  const radiusId = useId();
  const spotId = useId();

  const currentSpot =
    QUICK_SPOTS.find((s) => Math.abs(s.lat - area.lat) < SPOT_EPS && Math.abs(s.lon - area.lon) < SPOT_EPS)?.name ??
    "";

  return (
    <header
      className="relative flex h-14 shrink-0 items-center gap-4 border-b bg-white px-4"
      style={{ borderColor: "#e6e9ee", zIndex: 40 }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Mark />
        <p className="text-[15px] font-semibold text-[#1d2733]">Mapergy</p>
        <p className="hidden truncate text-[13px] text-[#556070] sm:block">Westminster, CA · 100-mile radius</p>
      </div>

      <div className="ml-auto flex items-center gap-4">
        <label htmlFor={spotId} className="sr-only">
          Jump to a place
        </label>
        <div className="relative hidden md:block">
          <select
            id={spotId}
            value={currentSpot}
            onChange={(e) => {
              const spot = QUICK_SPOTS.find((s) => s.name === e.target.value);
              if (spot) onJump(spot);
            }}
            className="h-8 appearance-none rounded-[6px] border bg-white py-0 pl-2.5 pr-7 text-[13px] text-[#1d2733] outline-none focus-visible:border-[#0ea5e9]"
            style={{ borderColor: "#d5dae1" }}
          >
            <option value="" disabled>
              Jump to a place
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
            <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="#6b7583" strokeWidth="1.4" />
          </svg>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor={radiusId} className="text-[13px] font-medium text-[#556070]">
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
          <span className="num w-11 text-right text-[13px] font-semibold text-[#1d2733]">{area.radius_mi} mi</span>
        </div>

        <button
          type="button"
          aria-pressed={heatwave}
          onClick={() => onHeatwave(!heatwave)}
          className="h-8 whitespace-nowrap rounded-[6px] border px-3 text-[13px] font-medium transition-colors"
          style={
            heatwave
              ? { borderColor: "#0ea5e9", background: "#e0f2fe", color: "#0369a1" }
              : { borderColor: "#d5dae1", background: "#ffffff", color: "#1d2733" }
          }
          title="Replace live weather with a modeled 105 °F, near-calm, full-sun afternoon"
        >
          Heatwave 105 °F
        </button>
      </div>
    </header>
  );
}

export default TopBar;
