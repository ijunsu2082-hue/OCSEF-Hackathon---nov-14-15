"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ActionTab from "@/components/outreach/ActionTab";
import EvidenceProvider from "@/components/evidence/EvidenceProvider";
import EvidenceTab from "@/components/evidence/EvidenceTab";
import GridChainTab from "@/components/grid/GridChainTab";
import NicheCaseTab from "@/components/energy/NicheCaseTab";
import ProcessTab from "@/components/method/ProcessTab";
import TelemetryTab from "@/components/energy/TelemetryTab";
import UpgradeSimulatorTab from "@/components/energy/UpgradeSimulatorTab";
import { corridorLoadings, gridChain, phaseExposure } from "@/lib/grid";
import { loadNicheCases } from "@/lib/gridLayers";
import type { NicheCase } from "@/lib/niche";
import { energyRisk, RISK_COLORS, riskBucket, type RiskEntry } from "@/lib/risk";
import { simulate } from "@/lib/simulation";
import { facilitySubject } from "@/lib/evidence/citation";
import type { EvidenceBundle } from "@/lib/evidence/schema";
import type { RegionPayload, SimResult } from "@/lib/types";
import AnalyzerDrawer, { type DrawerTab } from "./AnalyzerDrawer";
import ControlBar from "./ControlBar";
import FacilityRail from "./FacilityRail";
import MapCanvas from "./MapCanvas";

export type Plan = { solar: number; vfd: boolean };

const DEFAULT_NODE = "node-la-05";

function seedPlans(region: RegionPayload): Record<string, Plan> {
  const out: Record<string, Plan> = {};
  for (const f of region.nodes.features) {
    out[f.properties.id] = {
      solar: f.properties.upgrade_potential.solar_capacity_add_mw,
      vfd: true,
    };
  }
  return out;
}

export default function Workspace({
  region,
  evidence,
}: {
  region: RegionPayload;
  evidence: EvidenceBundle | null;
}) {
  const [heatwave, setHeatwave] = useState(false);
  const [view3d, setView3d] = useState(false);
  const [selectedId, setSelectedId] = useState(DEFAULT_NODE);
  const [tab, setTab] = useState<DrawerTab>("telemetry");
  const [plans, setPlans] = useState<Record<string, Plan>>(() => seedPlans(region));
  const [nicheCases, setNicheCases] = useState<NicheCase[]>([]);
  // A niche case takes over the drawer while it is open; null means the asset view.
  const [nicheCaseId, setNicheCaseId] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.stress = heatwave ? "true" : "false";
  }, [heatwave]);

  useEffect(() => {
    let alive = true;
    loadNicheCases()
      .then((cases) => {
        if (alive) setNicheCases(cases);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const nodes = region.nodes.features;

  const risks = useMemo<Record<string, RiskEntry>>(() => {
    const out: Record<string, RiskEntry> = {};
    for (const f of nodes) {
      const score = energyRisk(f.properties, { heatwave });
      const bucket = riskBucket(score);
      out[f.properties.id] = { score, bucket, color: RISK_COLORS[bucket] };
    }
    return out;
  }, [nodes, heatwave]);

  const sims = useMemo<Record<string, SimResult>>(() => {
    const out: Record<string, SimResult> = {};
    for (const f of nodes) {
      const plan = plans[f.properties.id] ?? { solar: 0, vfd: false };
      out[f.properties.id] = simulate(f.properties, {
        heatwave_active: heatwave,
        added_solar_mw: plan.solar,
        vfd_retrofit: plan.vfd,
      });
    }
    return out;
  }, [nodes, plans, heatwave]);

  const exposure = useMemo(() => {
    const ctx = { flows: region.flows, sims };
    return phaseExposure(
      nodes.map((f) => ({
        draw_mw: sims[f.properties.id].effective_draw_mw,
        states: gridChain(f.properties, sims[f.properties.id], ctx),
      })),
    );
  }, [nodes, sims, region.flows]);

  const corridors = useMemo(
    () => corridorLoadings(region.flows, sims, heatwave),
    [region.flows, sims, heatwave],
  );

  const kpis = useMemo(() => {
    let draw = 0;
    let co2 = 0;
    let weightedCI = 0;
    let overloads = 0;
    for (const f of nodes) {
      const sim = sims[f.properties.id];
      draw += sim.effective_draw_mw;
      co2 += sim.annual_co2_tons;
      weightedCI += sim.carbon_intensity * sim.effective_draw_mw;
      if (sim.overload) overloads += 1;
    }
    return {
      draw: Math.round(draw * 10) / 10,
      ci: draw > 0 ? Math.round(weightedCI / draw) : 0,
      co2: Math.round(co2),
      overloads,
    };
  }, [nodes, sims]);

  const selected = nodes.find((f) => f.properties.id === selectedId) ?? nodes[0];
  const selectedRisk = risks[selected.properties.id];
  const selectedSim = sims[selected.properties.id];
  const plan = plans[selected.properties.id] ?? { solar: 0, vfd: false };
  const selectedNiche =
    nicheCases.find((entry) => entry.id === nicheCaseId) ?? null;

  const selectTab = useCallback((next: DrawerTab) => {
    setNicheCaseId(null);
    setTab(next);
  }, []);

  const setPlan = useCallback((id: string, next: Plan) => {
    setPlans((prev) => ({ ...prev, [id]: next }));
  }, []);

  const entries = useMemo(
    () =>
      nodes.map((f) => ({
        properties: f.properties,
        sim: sims[f.properties.id],
        risk: risks[f.properties.id],
      })),
    [nodes, sims, risks],
  );

  return (
    <EvidenceProvider bundle={evidence}>
      <div className="app">
      <ControlBar
        regionName={region.region.name}
        regionId={region.region.id}
        kpis={kpis}
        heatwave={heatwave}
        onHeatwave={setHeatwave}
        view3d={view3d}
        onView3d={setView3d}
      />

      <main className="stage">
        <section className="mapwrap" aria-label="Facility map">
          <MapCanvas
            nodes={nodes}
            flows={region.flows}
            risks={risks}
            sims={sims}
            bounds={region.region.bounds}
            center={region.region.center}
            radiusMiles={region.region.radius_miles}
            selectedId={selected.properties.id}
            heatwave={heatwave}
            view3d={view3d}
            corridors={corridors}
            nicheCases={nicheCases}
            selectedNicheId={selectedNiche?.id ?? null}
            onSelect={setSelectedId}
            onSelectNiche={setNicheCaseId}
          />
          <FacilityRail
            regionName={region.region.name}
            nodes={nodes}
            risks={risks}
            sims={sims}
            selectedId={selected.properties.id}
            heatwave={heatwave}
            onSelect={setSelectedId}
          />
        </section>

        <AnalyzerDrawer
          properties={selected.properties}
          risk={selectedRisk}
          sim={selectedSim}
          nicheCase={selectedNiche}
          onCloseNiche={() => setNicheCaseId(null)}
          tab={tab}
          onTab={selectTab}
        >
          {selectedNiche ? <NicheCaseTab nicheCase={selectedNiche} /> : null}
          {!selectedNiche && tab === "telemetry" ? (
            <TelemetryTab
              properties={selected.properties}
              sim={selectedSim}
              regionalCI={region.grid.carbon_intensity_gco2_kwh}
              heatwave={heatwave}
              onNavigate={selectTab}
            />
          ) : null}
          {!selectedNiche && tab === "grid" ? (
            <GridChainTab
              properties={selected.properties}
              sim={selectedSim}
              ctx={{ flows: region.flows, sims }}
              exposure={exposure}
            />
          ) : null}
          {!selectedNiche && tab === "upgrade" ? (
            <UpgradeSimulatorTab
              properties={selected.properties}
              sim={selectedSim}
              plan={plan}
              onPlan={(next) => setPlan(selected.properties.id, next)}
              onNavigate={selectTab}
            />
          ) : null}
          {!selectedNiche && tab === "action" ? (
            <ActionTab properties={selected.properties} sim={selectedSim} />
          ) : null}
          {!selectedNiche && tab === "process" ? (
            <ProcessTab
              entries={entries}
              flowCount={region.flows.length}
              heatwave={heatwave}
            />
          ) : null}
          {!selectedNiche && tab === "evidence" ? (
            <EvidenceTab
              subject={facilitySubject(selected.properties.id)}
              regionId={region.region.id}
              title={selected.properties.name}
            />
          ) : null}
        </AnalyzerDrawer>
      </main>
      </div>
    </EvidenceProvider>
  );
}
