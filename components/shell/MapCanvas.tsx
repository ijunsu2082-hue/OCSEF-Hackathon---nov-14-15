"use client";

import dynamic from "next/dynamic";
import type { LatLngBoundsExpression, Map as LeafletMap } from "leaflet";
import { useCallback, useState } from "react";
import {
  DEFAULT_LAYERS,
  LAYER_OPTIONS,
  type LayerVisibility,
} from "@/lib/gridLayers";
import type { CorridorLoading } from "@/lib/grid";
import type { NicheCase } from "@/lib/niche";
import { RISK_COLORS, type RiskEntry, type RiskBucket } from "@/lib/risk";
import type { FacilityFeature, PowerFlow, SimResult } from "@/lib/types";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => (
    <div className="map-loading">
      <span className="spinner" aria-hidden />
      Loading basemap
    </div>
  ),
});

const RAMP: RiskBucket[] = ["LOW", "WATCH", "HIGH", "CRITICAL"];

interface Props {
  nodes: FacilityFeature[];
  flows: PowerFlow[];
  risks: Record<string, RiskEntry>;
  sims: Record<string, SimResult>;
  bounds: [[number, number], [number, number]];
  center: [number, number];
  radiusMiles: number;
  selectedId: string;
  heatwave: boolean;
  view3d: boolean;
  corridors: CorridorLoading[];
  nicheCases: NicheCase[];
  selectedNicheId: string | null;
  onSelect: (id: string) => void;
  onSelectNiche: (id: string) => void;
}

export default function MapCanvas({
  nodes,
  flows,
  risks,
  sims,
  bounds,
  center,
  radiusMiles,
  selectedId,
  heatwave,
  view3d,
  corridors,
  nicheCases,
  selectedNicheId,
  onSelect,
  onSelectNiche,
}: Props) {
  const [map, setMap] = useState<LeafletMap | null>(null);
  const [layers, setLayers] = useState<LayerVisibility>(DEFAULT_LAYERS);
  const onMapReady = useCallback((instance: LeafletMap) => setMap(instance), []);

  const toggleLayer = (id: keyof LayerVisibility) =>
    setLayers((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className={`map-stage${view3d ? " is-3d" : ""}`}>
      <div className="map-glow" aria-hidden />
      <div className={`map-plane${view3d ? " is-3d" : ""}`}>
        <MapView
          nodes={nodes}
          flows={flows}
          risks={risks}
          sims={sims}
          bounds={bounds}
          center={center}
          radiusMiles={radiusMiles}
          selectedId={selectedId}
          heatwave={heatwave}
          view3d={view3d}
          layers={layers}
          corridors={corridors}
          nicheCases={nicheCases}
          selectedNicheId={selectedNicheId}
          onSelect={onSelect}
          onSelectNiche={onSelectNiche}
          onMapReady={onMapReady}
        />
      </div>

      <div className="map-vignette" aria-hidden />
      <div className="map-horizon" aria-hidden />

      <div className="map-topline">
        <span className="map-mode">{view3d ? "3D terrain · tilt 56°" : "2D top-down"}</span>
        {heatwave ? <span className="map-mode">Heatwave · 105 °F</span> : null}
      </div>

      <div className="map-controls">
        <button type="button" onClick={() => map?.zoomIn()} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => map?.zoomOut()} aria-label="Zoom out">
          −
        </button>
        <button
          type="button"
          onClick={() =>
            map?.fitBounds(bounds as unknown as LatLngBoundsExpression, {
              padding: [46, 46],
            })
          }
          aria-label="Recenter on region"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3.4" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </svg>
        </button>
      </div>

      <div className="legend">
        <div className="legend-title">Energy risk score</div>
        <div className="legend-ramp">
          {RAMP.map((bucket) => (
            <div className="legend-step" key={bucket}>
              <span
                className="legend-swatch"
                style={{ background: RISK_COLORS[bucket] }}
                aria-hidden
              />
              <span>{bucket}</span>
            </div>
          ))}
        </div>

        <div className="legend-layers" role="group" aria-label="Map layers">
          {LAYER_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className="layer-toggle"
              data-active={layers[option.id]}
              aria-pressed={layers[option.id]}
              onClick={() => toggleLayer(option.id)}
            >
              <i aria-hidden />
              {option.label}
            </button>
          ))}
        </div>

        <div className="legend-foot">
          <span className="legend-dash" aria-hidden />
          Modeled tie (illustrative) · {radiusMiles} mi radius
        </div>
      </div>

      <div className="map-attrib">
        Tiles © Esri · Plants EIA-860 2025 · Grid © OpenStreetMap contributors
      </div>
    </div>
  );
}
