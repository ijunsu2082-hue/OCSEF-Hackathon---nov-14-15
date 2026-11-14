"use client";

import dynamic from "next/dynamic";
import type { LatLngBoundsExpression, Map as LeafletMap } from "leaflet";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_LAYERS,
  loadPlants,
  loadSubstations,
  loadTransmission,
  type LayerVisibility,
} from "@/lib/gridLayers";
import type { NicheCase } from "@/lib/niche";
import type { RiskEntry } from "@/lib/risk";
import {
  loadBasemap,
  saveBasemap,
  type BasemapId,
} from "@/lib/basemaps";
import { scanArea, type ScanInput, type ScanResult } from "@/lib/scan/areaScan";
import type { FacilityFeature, PowerFlow, SimResult } from "@/lib/types";
import AreaScanPanel from "@/components/scan/AreaScanPanel";
import LayerPicker from "./LayerPicker";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => (
    <div className="map-loading">
      <span className="spinner" aria-hidden />
      Loading basemap
    </div>
  ),
});

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
  nicheCases,
  selectedNicheId,
  onSelect,
  onSelectNiche,
}: Props) {
  const [map, setMap] = useState<LeafletMap | null>(null);
  const [layers, setLayers] = useState<LayerVisibility>(DEFAULT_LAYERS);
  const onMapReady = useCallback((instance: LeafletMap) => setMap(instance), []);

  const [basemap, setBasemap] = useState<BasemapId>("dark");
  useEffect(() => setBasemap(loadBasemap()), []);
  const chooseBasemap = useCallback((id: BasemapId) => {
    setBasemap(id);
    saveBasemap(id);
  }, []);

  const [scanMode, setScanMode] = useState(false);
  const [scanPoint, setScanPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [scanRadius, setScanRadius] = useState(5);
  const [scanData, setScanData] = useState<ScanInput | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const toggleLayer = (id: keyof LayerVisibility) =>
    setLayers((prev) => ({ ...prev, [id]: !prev[id] }));

  // Layers load the first time scan mode opens, never again (gridLayers caches).
  useEffect(() => {
    if (!scanMode || scanData) return;
    let alive = true;
    setScanLoading(true);
    setScanError(null);
    Promise.all([loadPlants(), loadSubstations(), loadTransmission()])
      .then(([plants, substations, transmission]) => {
        if (!alive) return;
        setScanData({
          plants: plants.features,
          substations: substations.features,
          transmission: transmission.features,
          loadCenters: [],
        });
        setScanLoading(false);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setScanError(error instanceof Error ? error.message : "Grid layers failed to load");
        setScanLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [scanMode, scanData]);

  const scanInput = useMemo<ScanInput | null>(() => {
    if (!scanData) return null;
    return {
      ...scanData,
      loadCenters: nodes.map((feature) => {
        const [lon, lat] = feature.geometry.coordinates;
        return {
          name: feature.properties.name,
          lat,
          lon,
          draw_mw: sims[feature.properties.id]?.effective_draw_mw ?? 0,
        };
      }),
    };
  }, [scanData, nodes, sims]);

  const scanResult = useMemo<ScanResult | null>(() => {
    if (!scanPoint || !scanInput) return null;
    return scanArea(
      { lat: scanPoint.lat, lon: scanPoint.lon, radius_mi: scanRadius },
      scanInput,
      { heatwave },
    );
  }, [scanPoint, scanInput, scanRadius, heatwave]);

  const scanOverlay = scanPoint
    ? { lat: scanPoint.lat, lon: scanPoint.lon, radius_mi: scanRadius }
    : null;

  const handleScanPoint = useCallback((lat: number, lon: number) => {
    setScanPoint({ lat, lon });
  }, []);

  const closeScan = useCallback(() => {
    setScanMode(false);
    setScanPoint(null);
  }, []);

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
          nicheCases={nicheCases}
          selectedNicheId={selectedNicheId}
          onSelect={onSelect}
          onSelectNiche={onSelectNiche}
          onMapReady={onMapReady}
          basemap={basemap}
          scanMode={scanMode}
          scan={scanOverlay}
          onScanPoint={handleScanPoint}
        />
      </div>

      <div className="map-vignette" aria-hidden />
      <div className="map-horizon" aria-hidden />

      <div className="map-topline">
        <span className="map-mode">{view3d ? "3D terrain · tilt 56°" : "2D top-down"}</span>
        {heatwave ? <span className="map-mode">Heatwave · 105 °F</span> : null}
        {scanMode ? (
          <span className="map-mode is-scan">Scan mode · click to query</span>
        ) : null}
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
          data-active={scanMode}
          aria-pressed={scanMode}
          onClick={() => {
            setScanMode((value) => !value);
            setScanPoint(null);
          }}
          aria-label={scanMode ? "Exit area scan" : "Scan an area"}
          title="Scan an area"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 4v3M12 17v3M4 12h3M17 12h3" />
            <circle cx="12" cy="12" r="8.4" strokeDasharray="3 3" />
          </svg>
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

      <LayerPicker
        basemap={basemap}
        onBasemap={chooseBasemap}
        layers={layers}
        onLayers={setLayers}
      />

      {scanMode ? (
        <AreaScanPanel
          result={scanResult}
          radius={scanRadius}
          loading={scanLoading}
          error={scanError}
          heatwave={heatwave}
          nicheCases={nicheCases}
          onRadius={setScanRadius}
          onClose={closeScan}
        />
      ) : null}

      <div className="map-attrib">
        Tiles © Esri · Plants EIA-860 2025 · Grid © OpenStreetMap contributors
      </div>
    </div>
  );
}
