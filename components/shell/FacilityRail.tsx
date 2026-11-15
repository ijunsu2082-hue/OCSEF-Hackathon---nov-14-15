"use client";

import { useMemo, useState, type CSSProperties } from "react";
import type { RiskEntry } from "@/lib/risk";
import type { FacilityFeature, SimResult } from "@/lib/types";

interface Props {
  regionName: string;
  nodes: FacilityFeature[];
  risks: Record<string, RiskEntry>;
  sims: Record<string, SimResult>;
  selectedId: string;
  heatwave: boolean;
  onSelect: (id: string) => void;
}

export default function FacilityRail({
  regionName,
  nodes,
  risks,
  sims,
  selectedId,
  heatwave,
  onSelect,
}: Props) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter(
      (f) =>
        f.properties.name.toLowerCase().includes(q) ||
        f.properties.type.toLowerCase().includes(q) ||
        f.properties.provider.utility_name.toLowerCase().includes(q),
    );
  }, [nodes, query]);

  const nameplate = nodes.reduce(
    (sum, f) => sum + f.properties.infrastructure.nameplate_draw_mw,
    0,
  );

  return (
    <aside className="rail" aria-label="Facilities">
      <div className="rail-head">
        <div>
          <h2>{regionName}</h2>
          <p>
            {nodes.length} load centers · {nameplate.toLocaleString("en-US", { maximumFractionDigits: 0 })} MW
          </p>
        </div>
        <span className={`pill ${heatwave ? "pill-critical" : "pill-accent"}`}>
          {heatwave ? "Stress" : "Live"}
        </span>
      </div>

      <div className="rail-search">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.6-3.6" />
        </svg>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search facilities"
          aria-label="Search facilities"
        />
      </div>

      <ul className="rail-list">
        {visible.map((f) => {
          const risk = risks[f.properties.id];
          const sim = sims[f.properties.id];
          return (
            <li key={f.properties.id}>
              <button
                type="button"
                className={`rail-row${f.properties.id === selectedId ? " is-selected" : ""}`}
                onClick={() => onSelect(f.properties.id)}
              >
                <span
                  className="rail-dot"
                  style={{ "--c": risk.color } as CSSProperties}
                  aria-hidden
                />
                <span className="rail-main">
                  <span className="rail-name">{f.properties.name}</span>
                  <span className="rail-meta">
                    {f.properties.type} · {f.properties.infrastructure.age_years} yr ·{" "}
                    {risk.bucket} · L {risk.exposure.toFixed(0)}
                  </span>
                </span>
                <span className="rail-right">
                  <b>{sim.effective_draw_mw.toFixed(1)}</b>
                  <span>MW</span>
                </span>
              </button>
            </li>
          );
        })}
        {visible.length === 0 ? (
          <li className="rail-foot">No facility matches “{query}”.</li>
        ) : null}
      </ul>

      <div className="rail-foot">
        {heatwave
          ? "Heatwave scenario · demand +45%, grid carbon +25%."
          : "Seeded demo telemetry — facilities real, numbers modeled."}
      </div>
    </aside>
  );
}
