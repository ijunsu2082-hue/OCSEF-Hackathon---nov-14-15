"use client";

import { Panel } from "@/components/ui/kit";
import { Cite, ScenarioTag } from "@/components/evidence/Citations";
import { facilitySubject } from "@/lib/evidence/citation";
import { compact, compactUSD, fmtNumber, fmtYears } from "@/lib/format";
import type { RiskEntry } from "@/lib/risk";
import type { FacilityProperties, SimResult } from "@/lib/types";

export interface ProcessEntry {
  properties: FacilityProperties;
  sim: SimResult;
  risk: RiskEntry;
}

interface Props {
  entries: ProcessEntry[];
  flowCount: number;
  heatwave: boolean;
}

export default function ProcessTab({ entries, flowCount, heatwave }: Props) {
  const sorted = [...entries].sort((a, b) => b.risk.score - a.risk.score);

  const capex = entries.reduce((sum, e) => sum + (e.sim.upgraded?.capex_usd ?? 0), 0);
  const savings = entries.reduce(
    (sum, e) => sum + (e.sim.upgraded?.annual_savings_usd ?? 0),
    0,
  );
  const avoided = entries.reduce(
    (sum, e) => sum + (e.sim.upgraded?.co2_avoided_tons ?? 0),
    0,
  );
  const payback = savings > 0 ? capex / savings : null;
  const high = entries.filter(
    (e) => e.risk.bucket === "HIGH" || e.risk.bucket === "CRITICAL",
  ).length;
  const overloads = entries.filter((e) => e.sim.overload).length;

  const stages = [
    {
      name: "Ingest",
      detail: "Metered draw, grid source mix, nameplate demand and motor efficiency per asset.",
      metric: `${entries.length} load centers`,
    },
    {
      name: "Georeference",
      detail: "Pin every load center and trace the distribution links that connect them.",
      metric: `${entries.length} pinned · ${flowCount} links`,
    },
    {
      name: "Score",
      detail: "Fossil exposure, carbon intensity, motor inefficiency and age, combined 0–100.",
      metric: `${high} high · ${entries.length - high} below`,
    },
    {
      name: "Stress test",
      detail: "105 °F scenario: demand +45%, grid carbon intensity +25%.",
      metric: heatwave ? `${overloads} overload` : "standby",
    },
    {
      name: "Intervene",
      detail: "Bundle solar and VFD retrofits, then price capex, savings and simple payback.",
      metric: `${compactUSD(capex)} capex`,
    },
    {
      name: "Dispatch",
      detail: "Draft the five-section memo and hand it to the provider's operations desk.",
      metric: payback !== null ? `${fmtYears(payback)} portfolio` : "—",
    },
  ];

  return (
    <>
      <Panel title="Analysis pipeline" hint="6 stages, one pass">
        <div className="stages">
          {stages.map((stage, index) => (
            <div className="stage-row" key={stage.name}>
              <span className="stage-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="stage-body">
                <b>{stage.name}</b>
                <span>{stage.detail}</span>
              </span>
              <span className="stage-metric">{stage.metric}</span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Portfolio outcome" hint="recommended bundles">
        <div className="readouts">
          <div className="readout">
            <b>{compactUSD(capex)}</b>
            <span>Total capex</span>
          </div>
          <div className="readout">
            <b className="is-good">{compactUSD(savings)}</b>
            <span>Savings / yr</span>
          </div>
          <div className="readout">
            <b className="is-accent">{compact(avoided)} t</b>
            <span>CO₂ avoided / yr</span>
          </div>
          <div className="readout">
            <b>{fmtYears(payback)}</b>
            <span>Portfolio payback</span>
          </div>
        </div>
        <p className="table-note">
          Screening arithmetic across all {entries.length} load centers with each recommended
          bundle applied. No incentives, escalation or financing costs included.
        </p>
      </Panel>

      <Panel title="Facility ranking" hint="highest risk first">
        <div className="table-wrap">
          <table className="ptable">
            <thead>
              <tr>
                <th>Facility</th>
                <th>Risk</th>
                <th>Solar</th>
                <th className="num-cell">Capex</th>
                <th className="num-cell">Payback</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <tr key={entry.properties.id}>
                  <td title={entry.properties.name}>{entry.properties.name}</td>
                  <td>
                    <span style={{ color: entry.risk.color, fontWeight: 600 }}>
                      {entry.risk.score.toFixed(1)}
                    </span>{" "}
                    {heatwave ? (
                      <ScenarioTag />
                    ) : (
                      <Cite
                        subject={facilitySubject(entry.properties.id)}
                        predicate="facility.risk_score"
                        quiet
                      />
                    )}
                  </td>
                  <td>
                    {fmtNumber(entry.properties.upgrade_potential.solar_capacity_add_mw, 1)} MW{" "}
                    <Cite
                      subject={facilitySubject(entry.properties.id)}
                      predicate="facility.upgrade.solar_capacity_add_mw"
                      quiet
                    />
                  </td>
                  <td className="num-cell">
                    {compactUSD(entry.sim.upgraded?.capex_usd ?? 0)}
                  </td>
                  <td className="num-cell">
                    {fmtYears(entry.sim.upgraded?.payback_years ?? null)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Close the loop">
        <p className="facility-note">
          Every recommendation carries its own evidence trail: the operating point it was scored
          on, the stress case that justified it, and the economics that price it. Dispatch the
          memo and the provider can verify the same numbers on site.
        </p>
      </Panel>
    </>
  );
}
