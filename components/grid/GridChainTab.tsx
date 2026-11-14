"use client";

import type { CSSProperties } from "react";
import { Panel } from "@/components/ui/kit";
import { compactUSD, fmtNumber, fmtYears } from "@/lib/format";
import {
  gridChain,
  SEVERITY_COLOR,
  type GridContext,
  type PhaseExposure,
} from "@/lib/grid";
import type { FacilityProperties, SimResult } from "@/lib/types";

interface Props {
  properties: FacilityProperties;
  sim: SimResult;
  ctx: GridContext;
  exposure: PhaseExposure[];
}

function SeverityPill({ severity }: { severity: keyof typeof SEVERITY_COLOR }) {
  return (
    <span className="riskpill" style={{ "--c": SEVERITY_COLOR[severity] } as CSSProperties}>
      {severity}
    </span>
  );
}

export default function GridChainTab({ properties, sim, ctx, exposure }: Props) {
  const chain = gridChain(properties, sim, ctx);

  return (
    <>
      <Panel title="Grid chain" hint={`6 phases · ${properties.id}`}>
        <div className="chain-grid">
          {chain.map((phase) => (
            <div
              className="chain-cell"
              key={phase.id}
              style={{ "--c": SEVERITY_COLOR[phase.severity] } as CSSProperties}
            >
              <span className="chain-idx">Phase {phase.phase}</span>
              <span className="chain-name">{phase.short}</span>
              <span className="chain-value">{phase.headline}</span>
              <span className="chain-state">{phase.severity}</span>
            </div>
          ))}
        </div>
        <p className="table-note">
          Every figure is derived from the modelled operating point, the serving corridor and the
          site&apos;s inspected age — screening estimates, not operator telemetry.
        </p>
      </Panel>

      <Panel title="Regional phase exposure" hint="portfolio">
        <div className="stages">
          {exposure.map((row) => (
            <div className="stage-row" key={row.id}>
              <span
                className="stage-index"
                style={
                  {
                    color: SEVERITY_COLOR[row.severity],
                    borderColor: `color-mix(in srgb, ${SEVERITY_COLOR[row.severity]} 34%, transparent)`,
                    background: `color-mix(in srgb, ${SEVERITY_COLOR[row.severity]} 12%, transparent)`,
                  } as CSSProperties
                }
              >
                {row.phase}
              </span>
              <span className="stage-body">
                <b>
                  {row.short}
                  <span className="exposure-bar">
                    <i
                      style={{
                        width: `${row.share_pct}%`,
                        background: SEVERITY_COLOR[row.severity],
                      }}
                    />
                  </span>
                </b>
                <span>
                  {row.alerts} high-impact signal{row.alerts === 1 ? "" : "s"} ·{" "}
                  {fmtNumber(row.at_risk_mw, 1)} MW exposed
                </span>
              </span>
              <span className="stage-metric">
                {row.capex_usd > 0 ? fmtYears(row.payback_years) : "—"}
              </span>
            </div>
          ))}
        </div>
        <p className="table-note">
          Primary pathway only, applied to the load centers that trip a high or critical signal in
          that phase. Bars are exposed MW.
        </p>
      </Panel>

      {chain.map((phase) => (
        <Panel
          key={phase.id}
          title={`${phase.phase} · ${phase.name}`}
          action={<SeverityPill severity={phase.severity} />}
        >
          <div className="chain-chips">
            {phase.telemetry.map((item) => (
              <span className="chain-chip" key={item.label}>
                {item.label} <b>{item.value}</b>
              </span>
            ))}
          </div>

          <ul className="diags">
            {phase.diagnostics.map((diag) => (
              <li key={diag.id}>
                <span
                  className="diag-dot"
                  style={{ background: SEVERITY_COLOR[diag.severity] }}
                  aria-hidden
                />
                <span>
                  <b>{diag.label}</b>
                  <em style={{ color: SEVERITY_COLOR[diag.severity] }}>{diag.severity}</em>
                  <span>{diag.detail}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="paths">
            {phase.pathways.map((path) => (
              <div className="path-row" key={path.id}>
                <div className="path-head">
                  <b>{path.label}</b>
                  <span>{fmtYears(path.payback_years)}</span>
                </div>
                <p>{path.detail}</p>
                <div className="path-meta">
                  <span>{compactUSD(path.capex_usd)} capex</span>
                  <span>{compactUSD(path.annual_savings_usd)}/yr</span>
                  <span>{fmtNumber(path.co2_avoided_tons, 0)} t CO₂</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ))}

      <Panel title="Why the chain matters">
        <p className="facility-note">
          A load center is only as reliable as its weakest phase. Solar and a drive retrofit fix the
          meter and the motor; the corridor, the transformer bank, the feeder and the nodal price
          decide whether the site can actually use them.
        </p>
      </Panel>
    </>
  );
}
