"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DrawerTab } from "@/components/shell/AnalyzerDrawer";
import { Panel } from "@/components/ui/kit";
import { compact, compactUSD, fmtNumber, fmtPercent, fmtYears } from "@/lib/format";
import {
  assessRisk,
  riskRemovedPerMillion,
  type RiskEntry,
} from "@/lib/risk";
import { paybackCurve } from "@/lib/simulation";
import type { FacilityProperties, SimResult } from "@/lib/types";
import type { Plan } from "@/components/shell/Workspace";

interface Props {
  properties: FacilityProperties;
  sim: SimResult;
  risk: RiskEntry;
  plan: Plan;
  onPlan: (plan: Plan) => void;
  onNavigate: (tab: DrawerTab) => void;
}

export default function UpgradeSimulatorTab({
  properties,
  sim,
  risk,
  plan,
  onPlan,
  onNavigate,
}: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const upgrade = properties.upgrade_potential;
  const recommendedSolar = upgrade.solar_capacity_add_mw;
  const maxSolar = Math.max(1, Math.round(recommendedSolar * 2 * 4) / 4);
  const solarPct = (plan.solar / maxSolar) * 100;

  const curve = useMemo(() => paybackCurve(sim), [sim]);
  const up = sim.upgraded;

  const afterRisk = useMemo(() => {
    const afterEfficiency = plan.vfd
      ? Math.min(
          0.95,
          properties.infrastructure.motor_efficiency_rating +
            upgrade.efficiency_gain_pct / 100,
        )
      : properties.infrastructure.motor_efficiency_rating;
    const afterProperties = plan.vfd
      ? {
          ...properties,
          infrastructure: {
            ...properties.infrastructure,
            motor_efficiency_rating: afterEfficiency,
          },
        }
      : properties;
    return assessRisk(afterProperties, {
      heatwave: sim.heatwave_active,
      overload: false,
      criticality: {
        value: risk.criticality,
        assumed: risk.criticality_assumed,
        basis: risk.criticality_basis,
      },
    });
  }, [
    plan.vfd,
    properties,
    upgrade.efficiency_gain_pct,
    sim.heatwave_active,
    risk.criticality,
    risk.criticality_assumed,
    risk.criticality_basis,
  ]);

  const isRecommended =
    Math.abs(plan.solar - recommendedSolar) < 0.001 && plan.vfd === true;

  return (
    <>
      <Panel title="Recommended intervention">
        <div className="reco">
          <span className="reco-tag">Screening bundle</span>
          <p>{upgrade.recommended_intervention}.</p>
          <div className="reco-chips">
            <span className="chip">
              Solar <b>{fmtNumber(upgrade.solar_capacity_add_mw, 1)} MW</b>
            </span>
            <span className="chip">
              Efficiency gain <b>{fmtPercent(upgrade.efficiency_gain_pct)}</b>
            </span>
            <span className="chip">
              Payback <b>{fmtYears(upgrade.capex_estimate_usd / upgrade.annual_savings_usd)}</b>
            </span>
          </div>
        </div>
      </Panel>

      <Panel
        title="Configure bundle"
        action={
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: "auto", padding: "4px 8px", fontSize: 9.5 }}
            onClick={() => onPlan({ solar: recommendedSolar, vfd: true })}
            disabled={isRecommended}
          >
            Reset
          </button>
        }
      >
        <div className="control">
          <div className="control-head">
            <span className="control-label">Solar array</span>
            <span className="control-value">{fmtNumber(plan.solar, 2)} MW</span>
          </div>
          <input
            type="range"
            min={0}
            max={maxSolar}
            step={0.25}
            value={plan.solar}
            style={{ "--pct": `${solarPct}%` } as CSSProperties}
            onChange={(event) => onPlan({ ...plan, solar: Number(event.target.value) })}
            aria-label="Solar capacity in megawatts"
          />
          <div className="control-sub">
            <span>0 MW</span>
            <span>2× recommended ({fmtNumber(maxSolar, 2)} MW)</span>
          </div>
        </div>

        <div className="toggle-row">
          <span className="control-label">
            VFD retrofit
            <span>
              {fmtPercent(upgrade.efficiency_gain_pct)} drive-side saving ·{" "}
              {compactUSD(upgrade.vfd_capex_usd)} capex
            </span>
          </span>
          <button
            type="button"
            className="switch"
            data-on={plan.vfd}
            aria-pressed={plan.vfd}
            style={{ padding: "4px 7px 4px 5px" }}
            onClick={() => onPlan({ ...plan, vfd: !plan.vfd })}
          >
            <span className="switch-track" aria-hidden>
              <span className="switch-thumb" />
            </span>
            <span>{plan.vfd ? "On" : "Off"}</span>
          </button>
        </div>
      </Panel>

      {up ? (
        <>
          <Panel title="Outcome" hint={sim.heatwave_active ? "105 °F scenario" : "baseline"}>
            <div className="readouts">
              <div className="readout">
                <b className="is-accent">{fmtNumber(up.draw_mw, 1)} MW</b>
                <span>Post-upgrade draw</span>
              </div>
              <div className="readout">
                <b>{fmtNumber(up.grid_offset_mw, 2)} MW</b>
                <span>Solar offset</span>
              </div>
              <div className="readout">
                <b className="is-good">{compact(up.co2_avoided_tons)} t</b>
                <span>CO₂ avoided / yr</span>
              </div>
              <div className="readout">
                <b>{compactUSD(up.capex_usd)}</b>
                <span>Capex</span>
              </div>
              <div className="readout">
                <b>{compactUSD(up.annual_savings_usd)}</b>
                <span>Annual savings</span>
              </div>
              <div className="readout">
                <b className="is-accent">{fmtYears(up.payback_years)}</b>
                <span>Simple payback</span>
              </div>
              <div className="readout">
                <b className={risk.score > afterRisk.score ? "is-good" : undefined}>
                  {fmtNumber(Math.max(0, risk.score - afterRisk.score), 1)}
                </b>
                <span>Risk points removed*</span>
              </div>
              <div className="readout">
                <b>
                  {riskRemovedPerMillion(risk.score, afterRisk.score, up.capex_usd) === null
                    ? "n/a"
                    : fmtNumber(
                        riskRemovedPerMillion(risk.score, afterRisk.score, up.capex_usd) ?? 0,
                        1,
                      )}
                </b>
                <span>ΔR per $M capex*</span>
              </div>
            </div>
            <p className="risk-note">
              *Motor-efficiency and overload effects only; solar carbon reduction is not scored yet.
            </p>
          </Panel>

          <Panel title="Payback curve" hint="cumulative cash">
            <div className="chartcard">
              <div className="chart-head">
                <span>Net position over 15 years</span>
                <b>
                  {up.payback_years !== null
                    ? `breaks even ${fmtYears(up.payback_years)}`
                    : "no payback"}
                </b>
              </div>
              {mounted ? (
                <ResponsiveContainer width="100%" height={168}>
                  <AreaChart data={curve} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="paybackFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#38D6C4" stopOpacity={0.34} />
                        <stop offset="100%" stopColor="#38D6C4" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#22304A" strokeDasharray="2 4" vertical={false} />
                    <XAxis
                      dataKey="year"
                      tick={{ fontSize: 9, fill: "#8FA0B8" }}
                      tickLine={false}
                      axisLine={false}
                      interval={2}
                    />
                    <YAxis
                      tick={{ fontSize: 9, fill: "#8FA0B8" }}
                      tickLine={false}
                      axisLine={false}
                      width={44}
                      tickFormatter={(value: number) => compactUSD(value)}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#0E1420",
                        border: "1px solid #22304A",
                        borderRadius: 8,
                        fontSize: 10,
                        color: "#EDF2F8",
                      }}
                      labelStyle={{ color: "#8FA0B8", fontSize: 9 }}
                      labelFormatter={(label) => `Year ${label}`}
                      formatter={(value) => [compactUSD(Number(value)), "Net"]}
                    />
                    <ReferenceLine y={0} stroke="#8FA0B8" strokeDasharray="3 3" />
                    <Area
                      type="monotone"
                      dataKey="net"
                      stroke="#38D6C4"
                      strokeWidth={2}
                      fill="url(#paybackFill)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ height: 168 }} />
              )}
            </div>
          </Panel>
        </>
      ) : (
        <Panel title="Outcome">
          <div className="empty">
            <b>No intervention selected</b>
            Add solar capacity or switch on the VFD retrofit to see draw, carbon and payback
            move.
          </div>
        </Panel>
      )}

      <Panel title="Hand off">
        <p className="facility-note">
          This bundle is a screening estimate, not a bid. Hand it to the provider with the
          operating context attached.
        </p>
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={() => onNavigate("action")}>
            Draft provider memo
          </button>
        </div>
      </Panel>
    </>
  );
}
