"use client";

import { useEffect, useMemo, useState } from "react";
import nodesJson from "@/data/nodes.json";
import { gridChain, type PhaseState, type Severity } from "@/lib/grid";
import {
  buildAssetIndex,
  haversineMi,
  summarizeAssets,
  type AssetIndex,
} from "@/lib/gridAssets";
import { loadPlants, loadSubstations, loadTransmission } from "@/lib/gridLayers";
import { simulate } from "@/lib/simulation";
import type { FacilityFeature } from "@/lib/types";
import { UI } from "@/lib/scan/colors";
import { Caption, Row, Section } from "./ui";

/**
 * Six-phase chain for the circle: generation → transmission → substation →
 * distribution → behind-the-meter → market.
 *
 * The assets are read off the real layers inside this circle. The operating
 * point (draw, motor efficiency, carbon intensity) has to come from somewhere
 * real too, so it comes from the nearest load center in the frozen facility
 * contract rather than being invented for a circle with no meter on it. Each
 * phase states where its numbers came from.
 */

const NODES = nodesJson.features as unknown as FacilityFeature[];

const SEVERITY_COLOR: Record<Severity, string> = {
  ok: "#0ea5e9",
  watch: UI.warning,
  high: UI.danger,
  critical: UI.danger,
};

const SEVERITY_WORD: Record<Severity, string> = {
  ok: "OK",
  watch: "Watch",
  high: "High",
  critical: "Critical",
};

const num = (v: number, digits = 0) =>
  v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const money = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : `$${num(Math.round(v / 1_000))}k`;

function nearestNode(lat: number, lon: number) {
  let best: { node: FacilityFeature; distance_mi: number } | null = null;
  for (const node of NODES) {
    const [nLon, nLat] = node.geometry.coordinates;
    const distance = haversineMi([lon, lat], [nLon, nLat]);
    if (!best || distance < best.distance_mi) best = { node, distance_mi: distance };
  }
  return best;
}

function Phase({ state }: { state: PhaseState }) {
  const color = SEVERITY_COLOR[state.severity];
  return (
    <div className="border-t border-[#e6e9ee] pt-4 first:border-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="min-w-0 text-[14px] font-semibold leading-snug text-[#1d2733]">
          {state.phase}. {state.short}
        </h4>
        <span className="shrink-0 text-[12px] font-semibold" style={{ color }}>
          {SEVERITY_WORD[state.severity]}
        </span>
      </div>
      <p className="mt-0.5 text-[13px] leading-snug text-[#556070]">{state.headline}</p>

      {state.telemetry.length > 0 && (
        <div className="mt-2">
          {state.telemetry.map((item) => (
            <Row key={item.label} label={item.label} value={item.value} />
          ))}
        </div>
      )}

      {state.diagnostics.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {state.diagnostics.map((diagnostic) => (
            <li key={diagnostic.id} className="flex gap-2">
              <span
                className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: SEVERITY_COLOR[diagnostic.severity] }}
                aria-hidden
              />
              <span className="min-w-0 text-[13px] leading-snug text-[#556070]">
                <span className="font-medium text-[#1d2733]">{diagnostic.label}</span> —{" "}
                {diagnostic.detail}
              </span>
            </li>
          ))}
        </ul>
      )}

      {state.pathways.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6b7583]">
            What would fix it
          </p>
          {state.pathways.slice(0, 2).map((pathway) => (
            <div key={pathway.id} className="py-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-[13px] text-[#1d2733]">{pathway.label}</span>
                <span className="shrink-0 text-[13px] font-semibold tabular-nums text-[#1d2733]">
                  {pathway.payback_years === null
                    ? "—"
                    : `${pathway.payback_years.toFixed(1)} yr`}
                </span>
              </div>
              <p className="text-[12px] leading-snug text-[#6b7583]">
                {money(pathway.capex_usd)} capex · {money(pathway.annual_savings_usd)}/yr ·{" "}
                {num(pathway.co2_avoided_tons)} t CO₂ avoided
              </p>
            </div>
          ))}
        </div>
      )}

      <p className="mt-1 text-[11px] leading-snug text-[#6b7583]">{state.provenance}</p>
    </div>
  );
}

export function GridChain({
  lat,
  lon,
  heatwave,
}: {
  lat: number;
  lon: number;
  heatwave: boolean;
}) {
  const [index, setIndex] = useState<AssetIndex | null>(null);
  const [layersFailed, setLayersFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([loadPlants(), loadTransmission(), loadSubstations()])
      .then(([plants, transmission, substations]) => {
        if (alive) {
          setIndex(buildAssetIndex(plants.features, transmission.features, substations.features));
        }
      })
      .catch(() => {
        if (alive) setLayersFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const chain = useMemo(() => {
    const nearest = nearestNode(lat, lon);
    if (!nearest) return null;
    const sim = simulate(nearest.node.properties, {
      heatwave_active: heatwave,
      added_solar_mw: 0,
      vfd_retrofit: false,
    });
    const assets = index ? summarizeAssets(index, [lon, lat]) : null;
    return {
      name: nearest.node.properties.name,
      distance_mi: nearest.distance_mi,
      states: gridChain(nearest.node.properties, sim, { assets }),
    };
  }, [lat, lon, heatwave, index]);

  if (!chain) return null;

  return (
    <Section
      title="Grid chain"
      subtitle={`Six phases from the generator to the market, for ${chain.name} — the nearest load center, ${chain.distance_mi.toFixed(1)} mi from this circle.`}
    >
      {layersFailed && (
        <Caption className="mb-3">
          Plant and line layers did not load, so the asset-led phases report the gap instead of a
          number.
        </Caption>
      )}
      <div className="flex flex-col gap-5">
        {chain.states.map((state) => (
          <Phase key={state.id} state={state} />
        ))}
      </div>
      <Caption className="mt-4">
        Assets are read inside this circle. The operating point is the nearest load center&apos;s
        frozen contract values, not a meter reading at this spot. Pathways are screening economics.
      </Caption>
    </Section>
  );
}
