"use client";

import type { ReactNode } from "react";
import { Cite, ScenarioTag } from "@/components/evidence/Citations";
import { RiskPill } from "@/components/ui/kit";
import { facilitySubject } from "@/lib/evidence/citation";
import { compact, fmtNumber } from "@/lib/format";
import type { NicheCase } from "@/lib/niche";
import type { RiskEntry } from "@/lib/risk";
import type { FacilityProperties, SimResult } from "@/lib/types";

const TABS = [
  { id: "telemetry", label: "Telemetry" },
  { id: "grid", label: "Grid chain" },
  { id: "upgrade", label: "Upgrade plan" },
  { id: "action", label: "Provider memo" },
  { id: "process", label: "Process" },
  { id: "evidence", label: "Evidence" },
] as const;

export type DrawerTab = (typeof TABS)[number]["id"];

interface Props {
  properties: FacilityProperties;
  risk: RiskEntry;
  sim: SimResult;
  /** Non-null puts the drawer in niche-case mode: no tabs, a back link instead. */
  nicheCase: NicheCase | null;
  onCloseNiche: () => void;
  tab: DrawerTab;
  onTab: (tab: DrawerTab) => void;
  children: ReactNode;
}

export default function AnalyzerDrawer({
  properties,
  risk,
  sim,
  nicheCase,
  onCloseNiche,
  tab,
  onTab,
  children,
}: Props) {
  const subject = facilitySubject(properties.id);
  const cite = (predicate: string) =>
    sim.heatwave_active ? (
      <ScenarioTag />
    ) : (
      <Cite subject={subject} predicate={predicate} quiet />
    );

  return (
    <aside className="drawer" aria-label="Facility analysis">
      <header className="drawer-head">
        {nicheCase ? (
          <>
            <div className="drawer-kicker">
              <span className="drawer-id">{nicheCase.id}</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="pill pill-accent">{nicheCase.category}</span>
                <button type="button" className="drawer-back" onClick={onCloseNiche}>
                  ← Back
                </button>
              </span>
            </div>
            <h2>{nicheCase.title}</h2>
            <p className="drawer-sub">
              {nicheCase.location.name} · {nicheCase.location.distance_mi} mi from
              Westminster HS
            </p>
          </>
        ) : (
          <>
            <div className="drawer-kicker">
              <span className="drawer-id">{properties.id}</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {sim.overload ? <span className="pill pill-critical">overload</span> : null}
                <RiskPill bucket={risk.bucket} score={risk.score} large />
              </span>
            </div>
            <h2>{properties.name}</h2>
            <p className="drawer-sub">
              {properties.type} · {properties.provider.utility_name} ·{" "}
              {properties.infrastructure.age_years} yr ·{" "}
              {fmtNumber(properties.infrastructure.nameplate_draw_mw, 1)} MW nameplate
            </p>

            <div className="drawer-metrics">
              <div className="drawer-metric">
                <b>{fmtNumber(sim.effective_draw_mw, 1)}</b>
                <span>Grid draw MW {cite("facility.baseline_draw_mw")}</span>
              </div>
              <div className="drawer-metric">
                <b>{fmtNumber(sim.carbon_intensity, 0)}</b>
                <span>gCO₂ / kWh {cite("facility.carbon_intensity_gco2_kwh")}</span>
              </div>
              <div className="drawer-metric">
                <b>{compact(sim.annual_co2_tons)}</b>
                <span>t CO₂ / yr {cite("facility.annual_co2_tons")}</span>
              </div>
            </div>

            <div className="riskline" aria-label="Risk decomposition">
              <span>
                L <b>{risk.exposure.toFixed(1)}</b>
              </span>
              <span>
                C <b>{risk.criticality.toFixed(1)}</b>
                {risk.criticality_assumed ? <em>assumed</em> : null}
              </span>
              <span>
                R <b>{risk.score.toFixed(1)}</b>
              </span>
              <span className="riskline-note">{risk.confidence} confidence</span>
            </div>
          </>
        )}
      </header>

      {nicheCase ? null : (
        <nav className="tabs" aria-label="Analysis views">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              data-active={item.id === tab}
              aria-current={item.id === tab ? "page" : undefined}
              onClick={() => onTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      )}

      <div className="drawer-body">{children}</div>
    </aside>
  );
}
