"use client";

import { useMemo, type CSSProperties } from "react";
import type { DrawerTab } from "@/components/shell/AnalyzerDrawer";
import { Cite, ScenarioTag } from "@/components/evidence/Citations";
import { Panel, RiskPill, Sparkline } from "@/components/ui/kit";
import { facilitySubject } from "@/lib/evidence/citation";
import { compact, fmtNumber, fmtPercent } from "@/lib/format";
import type { RiskEntry } from "@/lib/risk";
import { dailyProfile } from "@/lib/simulation";
import type { FacilityProperties, SimResult, SourceMix } from "@/lib/types";

const MIX: { key: keyof SourceMix; label: string; color: string }[] = [
  { key: "natural_gas", label: "Natural gas", color: "#F97316" },
  { key: "solar", label: "Solar", color: "#F5C542" },
  { key: "hydro", label: "Hydro", color: "#4C8DFF" },
  { key: "wind", label: "Wind", color: "#38D6C4" },
  { key: "other", label: "Other", color: "#6B7FA8" },
];

interface Props {
  properties: FacilityProperties;
  sim: SimResult;
  risk: RiskEntry;
  regionalCI: number;
  heatwave: boolean;
  onNavigate: (tab: DrawerTab) => void;
}

export default function TelemetryTab({
  properties,
  sim,
  risk,
  regionalCI,
  heatwave,
  onNavigate,
}: Props) {
  const infra = properties.infrastructure;
  const energy = properties.energy_profile;
  const mix = energy.source_mix;

  const subject = facilitySubject(properties.id);
  const cite = (predicate: string) =>
    heatwave ? <ScenarioTag /> : <Cite subject={subject} predicate={predicate} quiet />;
  const citeStatic = (predicate: string) => (
    <Cite subject={subject} predicate={predicate} quiet />
  );

  const profile = useMemo(() => dailyProfile(sim), [sim]);

  const loadShare = Math.min(sim.load_ratio, 1);
  const overShare = Math.min(Math.max(sim.load_ratio - 1, 0), 0.1);
  const ciDelta = ((sim.carbon_intensity - regionalCI) / regionalCI) * 100;
  const effGap = 0.85 - infra.motor_efficiency_rating;
  const liveMW = sim.effective_draw_mw;

  const signals: { tone: string; title: string; detail: string }[] = [
    {
      tone:
        infra.motor_efficiency_rating >= 0.8
          ? "#2DD4A7"
          : infra.motor_efficiency_rating >= 0.68
            ? "#E8A33D"
            : "#F04D5E",
      title: `Motor efficiency ${fmtPercent(infra.motor_efficiency_rating * 100)}`,
      detail:
        effGap > 0
          ? `${fmtPercent(effGap * 100, 0)} below the 0.85 benchmark — the largest recoverable electrical loss at this asset.`
          : "At or above the 0.85 benchmark; no drive-side action needed.",
    },
    {
      tone: Math.abs(ciDelta) > 6 ? "#F97316" : "#2DD4A7",
      title: `Grid carbon ${fmtNumber(sim.carbon_intensity, 0)} gCO₂/kWh`,
      detail: `${ciDelta >= 0 ? "+" : ""}${fmtNumber(ciDelta, 1)}% versus the ${fmtNumber(regionalCI, 0)} gCO₂/kWh regional mean.`,
    },
    {
      tone: infra.utilization_pct >= 80 ? "#F97316" : "#E8A33D",
      title: `${fmtPercent(infra.utilization_pct, 1)} utilization`,
      detail:
        infra.utilization_pct >= 80
          ? `Running close to the ${fmtNumber(sim.nameplate_mw, 1)} MW nameplate; heatwave surge pushes it into overload.`
          : `Headroom of ${fmtNumber(sim.nameplate_mw - liveMW, 1)} MW before nameplate at current demand.`,
    },
    {
      tone: infra.age_years > 50 ? "#F97316" : "#E8A33D",
      title: `${infra.age_years} years in service`,
      detail:
        infra.age_years > 50
          ? `In service since ${infra.year_built}; drive assets are past typical refurbishment windows.`
          : `In service since ${infra.year_built}; within the standard refurbishment window.`,
    },
  ];

  if (heatwave && sim.overload) {
    signals.unshift({
      tone: "#F04D5E",
      title: `Projected overload at 105 °F`,
      detail: `Demand rises to ${fmtNumber(sim.effective_draw_mw, 1)} MW against ${fmtNumber(sim.nameplate_mw, 1)} MW nameplate; utilization pins at the 105% ceiling.`,
    });
  }

  return (
    <>
      <Panel title="Risk index" hint="screening">
        <div className="risk-hero">
          <svg
            className="risk-gauge"
            viewBox="0 0 80 80"
            role="img"
            aria-label={`Risk index ${fmtNumber(risk.score, 0)} of 100`}
          >
            <circle className="risk-gauge-track" cx="40" cy="40" r="32" />
            <circle
              className="risk-gauge-fill"
              cx="40"
              cy="40"
              r="32"
              pathLength={100}
              strokeDasharray="100"
              strokeDashoffset={100 - risk.score}
              style={{ stroke: risk.color }}
              transform="rotate(-90 40 40)"
            />
            <text className="risk-gauge-value" x="40" y="39" textAnchor="middle">
              {fmtNumber(risk.score, 0)}
            </text>
            <text className="risk-gauge-unit" x="40" y="51" textAnchor="middle">
              /100
            </text>
          </svg>

          <div className="risk-hero-copy">
            <div className="risk-hero-top">
              <RiskPill bucket={risk.bucket} />
              <span className="pill pill-accent">{risk.confidence} confidence</span>
            </div>
            <div className="risk-axis">
              <span>
                L <b>{fmtNumber(risk.exposure, 1)}</b>
              </span>
              <span>
                C <b>{fmtNumber(risk.criticality, 1)}</b>
                {risk.criticality_assumed ? <em>assumed</em> : null}
              </span>
              <span>
                R <b>{fmtNumber(risk.score, 1)}</b>
              </span>
            </div>
            <p className="risk-note">
              {risk.worse_than === null || risk.total === null
                ? "Regional percentile unavailable."
                : risk.worse_than === 0
                  ? "Lowest composite risk in this region."
                  : `Worse than ${risk.worse_than} of ${risk.total} load centers in this region.`}
            </p>
          </div>
        </div>

        <ul className="risk-factors" aria-label="Risk factor contributions">
          {risk.factors.map((factor) => (
            <li key={factor.id} title={factor.detail}>
              <span className="risk-factor-label">{factor.label}</span>
              <span className="risk-factor-bar">
                <i
                  style={{
                    width: `${(factor.points / factor.max) * 100}%`,
                    background: risk.color,
                  }}
                />
              </span>
              <span className="risk-factor-points">{fmtNumber(factor.points, 1)}</span>
            </li>
          ))}
        </ul>

        <p className="risk-note">
          Screening index, not a failure probability.{" "}
          {risk.criticality_assumed
            ? risk.criticality_basis
            : `Criticality ${fmtNumber(risk.criticality, 1)} from the loaded consequence layer.`}
        </p>
      </Panel>

      <Panel title="Operating point" hint={heatwave ? "105 °F scenario" : "Baseline"}>
        <div className="capacity">
          <div className="capacity-track">
            <span className="capacity-fill" style={{ width: `${loadShare * 100}%` }} />
            {overShare > 0 ? (
              <span className="capacity-over" style={{ width: `${overShare * 100}%` }} />
            ) : null}
          </div>
          <div className="capacity-legend">
            <span>
              {fmtNumber(liveMW, 1)} / {fmtNumber(sim.nameplate_mw, 1)} MW {citeStatic("facility.nameplate_draw_mw")}
            </span>
            <span>{fmtPercent(sim.load_ratio * 100, 1)} of nameplate</span>
          </div>
        </div>

        <div className="metric-grid" style={{ marginTop: 12 }}>
          <div className="metric">
            <b>
              {compact(sim.annual_mwh)}
              <em>MWh</em>
            </b>
            <span>
              Annual energy {cite("facility.annual_mwh")}
            </span>
          </div>
          <div className="metric">
            <b>
              {compact(sim.annual_co2_tons)}
              <em>t</em>
            </b>
            <span>
              CO₂ per year {cite("facility.annual_co2_tons")}
            </span>
          </div>
          <div className="metric">
            <b>
              {compact(sim.homes_equivalent)}
              <em>homes</em>
            </b>
            <span>
              Homes equivalent {cite("facility.homes_equivalent")}
            </span>
          </div>
          <div className="metric">
            <b>
              {fmtPercent(infra.motor_efficiency_rating * 100)}
              <em>eff</em>
            </b>
            <span>
              Motor efficiency {citeStatic("facility.motor_efficiency_rating")}
            </span>
          </div>
        </div>
      </Panel>

      <Panel title="24 hour demand profile" hint="modeled">
        <div className="sparkcard">
          <div className="sparkcard-head">
            <span>MW through the day</span>
            <span className="num">peak {fmtNumber(Math.max(...profile), 1)} MW</span>
          </div>
          <Sparkline values={profile} color={heatwave ? "#FFB020" : "#38D6C4"} height={52} />
        </div>
      </Panel>

      <Panel title="Grid source mix" hint={energy.grid_zone}>
        <div className="mixbar">
          {MIX.map((source) => (
            <span
              key={source.key}
              style={{ width: `${mix[source.key]}%`, background: source.color }}
              title={`${source.label} ${mix[source.key]}%`}
            />
          ))}
        </div>
        <ul className="mix-legend">
          {MIX.map((source) => (
            <li key={source.key}>
              <i style={{ background: source.color }} aria-hidden />
              {source.label}
              <b>
                {mix[source.key]}% {citeStatic(`facility.source_mix.${source.key}`)}
              </b>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Signals">
        <ul className="signals">
          {signals.map((signal) => (
            <li key={signal.title}>
              <span
                className="signal-dot"
                style={{ "--c": signal.tone } as CSSProperties}
                aria-hidden
              />
              <span>
                <b>{signal.title}</b>
                <br />
                <span>{signal.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="What’s next">
        <p className="facility-note">
          {properties.upgrade_potential.recommended_intervention}. Model the bundle against this
          load center to see demand, carbon and payback move before anything is committed.
        </p>
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={() => onNavigate("upgrade")}>
            Model the upgrade
          </button>
        </div>
      </Panel>
    </>
  );
}
