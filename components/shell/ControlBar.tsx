"use client";

import { Segmented, Stat } from "@/components/ui/kit";
import { compact, fmtNumber } from "@/lib/format";

type Props = {
  regionName: string;
  kpis: { draw: number; ci: number; co2: number; overloads: number };
  heatwave: boolean;
  onHeatwave: (next: boolean) => void;
  view3d: boolean;
  onView3d: (next: boolean) => void;
};

export default function ControlBar({
  regionName,
  kpis,
  heatwave,
  onHeatwave,
  view3d,
  onView3d,
}: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 20V10l9-6 9 6v10" />
            <path d="M3 14h18M9 20v-6M15 20v-6" />
          </svg>
        </span>
        <div className="brand-text">
          <strong>GridSentinel</strong>
          <span>Infrastructure energy intelligence</span>
        </div>
      </div>

      <label className="region-select">
        <span className="sr-only">Region</span>
        <select value={regionName} onChange={() => undefined}>
          <option>{regionName}</option>
        </select>
      </label>

      <div className="kpis">
        <Stat
          label="Total grid draw"
          value={fmtNumber(kpis.draw, 1)}
          unit="MW"
        />
        <Stat
          label="Grid carbon intensity"
          value={fmtNumber(kpis.ci, 0)}
          unit="gCO₂/kWh"
        />
        <Stat label="Annual CO₂" value={compact(kpis.co2)} unit="t" />
      </div>

      <div className="topbar-actions">
        {kpis.overloads > 0 ? (
          <span className="pill pill-critical">{kpis.overloads} overload</span>
        ) : null}

        <Segmented
          label="Map view"
          value={view3d ? "3d" : "2d"}
          onChange={(next) => onView3d(next === "3d")}
          options={[
            { id: "2d", label: "2D" },
            { id: "3d", label: "3D" },
          ]}
        />

        <button
          type="button"
          className="switch"
          data-on={heatwave}
          aria-pressed={heatwave}
          onClick={() => onHeatwave(!heatwave)}
        >
          <span className="switch-track" aria-hidden>
            <span className="switch-thumb" />
          </span>
          <span>105 °F heatwave</span>
        </button>
      </div>
    </header>
  );
}
