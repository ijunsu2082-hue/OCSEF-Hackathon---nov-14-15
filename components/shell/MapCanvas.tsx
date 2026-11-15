"use client";

import dynamic from "next/dynamic";
import type { CorridorSelection, MapController } from "./mapTypes";
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
import { loadSurfaceMode, saveSurfaceMode, type SurfaceMode } from "@/lib/basemaps";
import { scanArea, type ScanInput, type ScanResult } from "@/lib/scan/areaScan";
import { RATING_CSV_URL, RATING_FALLBACK_CSV_URL, summarizeWire } from "@/lib/scan/wire";
import { layerSourceLabel } from "@/lib/scan/sourceLabel";
import type { FacilityFeature, PowerFlow, SimResult } from "@/lib/types";
import AreaScanPanel from "@/components/scan/AreaScanPanel";
import LayerPicker from "./LayerPicker";
import CorridorWeatherCallout from "@/components/scan/CorridorWeatherCallout";

// No location report id reaches this map, so its loaders run without a selector
// and always draw the bundled layers.
const LAYER_SOURCE = layerSourceLabel({ source: "bundled" });

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
  onView3d: (value: boolean) => void;
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
  onView3d,
  nicheCases,
  selectedNicheId,
  onSelect,
  onSelectNiche,
}: Props) {
  const [map, setMap] = useState<MapController | null>(null);
  const [cameraPreset, setCameraPreset] = useState<"regional" | "facility" | "corridor">("regional");
  const [selectedCorridor, setSelectedCorridor] = useState<CorridorSelection | null>(null);
  const [layers, setLayers] = useState<LayerVisibility>(DEFAULT_LAYERS);
  const onMapReady = useCallback((instance: MapController) => setMap(instance), []);

  const [basemap, setBasemap] = useState<BasemapId>("dark");
  const [surface, setSurface] = useState<SurfaceMode>("flat");
  const [terrainStatus, setTerrainStatus] = useState<"loading" | "ready" | "unavailable">("ready");
  useEffect(() => setBasemap(loadBasemap()), []);
  useEffect(() => setSurface(loadSurfaceMode()), []);
  const chooseBasemap = useCallback((id: BasemapId) => {
    setBasemap(id);
    saveBasemap(id);
  }, []);
  const chooseSurface = useCallback((mode: SurfaceMode) => {
    setSurface(mode);
    saveSurfaceMode(mode);
  }, []);

  const [scanMode, setScanMode] = useState(false);
  const [scanPoint, setScanPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [scanRadius, setScanRadius] = useState(5);
  const [scanData, setScanData] = useState<ScanInput | null>(null);
  const [ratingCsv, setRatingCsv] = useState<string | null>(null);
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
    Promise.all([
      loadPlants(),
      loadSubstations(),
      loadTransmission(),
      // Optional: without the archive the scan reports the gap, it does not guess.
      fetch(RATING_CSV_URL)
        .then((response) => response.ok ? response.text() : fetch(RATING_FALLBACK_CSV_URL).then((fallback) => fallback.ok ? fallback.text() : ""))
        .catch(() => fetch(RATING_FALLBACK_CSV_URL).then((fallback) => fallback.ok ? fallback.text() : "").catch(() => "")),
    ]).then(([plants, substations, transmission, rating]) => {
      if (!alive) return;
      setScanData({
        plants: plants.features,
        substations: substations.features,
        transmission: transmission.features,
        loadCenters: [],
      });
      setRatingCsv(rating || null);
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
      {
        heatwave,
        regionCenter: { lat: center[0], lon: center[1] },
        coverageMi: radiusMiles,
        rateVoltage: ratingCsv
          ? (voltageKv) => summarizeWire(ratingCsv, voltageKv)
          : undefined,
      },
    );
  }, [scanPoint, scanInput, scanRadius, heatwave, ratingCsv, center, radiusMiles]);

  const scanOverlay = scanPoint
    ? { lat: scanPoint.lat, lon: scanPoint.lon, radius_mi: scanRadius }
    : null;

  const chooseCamera = useCallback((preset: "regional" | "facility" | "corridor") => {
    setCameraPreset(preset);
    if (preset === "regional") {
      map?.fitBounds(bounds, { padding: [46, 46], animate: true });
      return;
    }
    const selected = nodes.find((node) => node.properties.id === selectedId);
    const target = selected?.geometry.coordinates;
    if (preset === "facility" && target) {
      map?.flyTo([target[1], target[0]], 13, { duration: 0.8 });
      return;
    }
    if (!selectedCorridor) return;
    const latitudes = selectedCorridor.coordinates.map((point) => point[1]);
    const longitudes = selectedCorridor.coordinates.map((point) => point[0]);
    map?.fitBounds(
      [[Math.min(...latitudes), Math.min(...longitudes)], [Math.max(...latitudes), Math.max(...longitudes)]],
      { padding: [72, 72], animate: true },
    );
  }, [bounds, center, map, nodes, selectedId, selectedCorridor]);

  useEffect(() => {
    if (!map) return;
    if (!view3d) { map.setCamera(0, 0); return; }
    const pitch = cameraPreset === "regional" ? 45 : cameraPreset === "facility" ? 55 : 50;
    let bearing = 0;
    if (cameraPreset === "corridor" && selectedCorridor && selectedCorridor.coordinates.length > 1) {
      const first = selectedCorridor.coordinates[0];
      const last = selectedCorridor.coordinates[selectedCorridor.coordinates.length - 1];
      const [lon1, lat1] = first;
      const [lon2, lat2] = last;
      const toRad = Math.PI / 180;
      const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
      const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
      bearing = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
    }
    map.setCamera(pitch, bearing);
  }, [map, view3d, cameraPreset, selectedCorridor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (scanMode) { setScanMode(false); setScanPoint(null); }
      else if (selectedCorridor) { setSelectedCorridor(null); setCameraPreset("regional"); map?.fitBounds(bounds, { padding: [46, 46], animate: true }); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scanMode, selectedCorridor, map, bounds]);

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
          surface={surface}
          onTerrainStatus={setTerrainStatus}
          layers={layers}
          nicheCases={nicheCases}
          selectedNicheId={selectedNicheId}
          selectedCorridorId={selectedCorridor?.id ?? null}
          selectedCorridor={selectedCorridor}
          onSelect={onSelect}
          onSelectNiche={onSelectNiche}
          onSelectCorridor={setSelectedCorridor}
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
        <span className="map-mode">{surface === "elevation" ? `Elevation 1× · DEM ${terrainStatus}` : "Flat surface"} · {view3d ? `${cameraPreset} camera · pitch ${cameraPreset === "regional" ? 45 : cameraPreset === "facility" ? 55 : 50}°` : "top-down camera"}</span>
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
        <button type="button" onClick={() => map?.resetNorth()} aria-label="Reset north" title="Reset north">
          ↑
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
            map?.fitBounds(bounds, { padding: [46, 46], animate: true })
          }
          aria-label="Recenter on region"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3.4" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </svg>
        </button>
      </div>

      <div className="map-camera-presets" role="group" aria-label="Map camera preset">
        {(["regional", "facility", "corridor"] as const).map((preset) => (
          <button key={preset} type="button" data-active={cameraPreset === preset}
            disabled={preset === "corridor" && !selectedCorridor}
            aria-pressed={cameraPreset === preset} onClick={() => chooseCamera(preset)}>
            {preset}
          </button>
        ))}
        {selectedCorridor ? <button type="button" onClick={() => { setSelectedCorridor(null); setCameraPreset("regional"); map?.fitBounds(bounds, { padding: [46, 46], animate: true }); }}>Clear line</button> : null}
      </div>

      <LayerPicker
        basemap={basemap}
        onBasemap={chooseBasemap}
        layers={layers}
        onLayers={setLayers}
        surface={surface}
        onSurface={chooseSurface}
        layerSource={LAYER_SOURCE}
      />

      {selectedCorridor && !scanMode ? (
        <CorridorWeatherCallout
          coordinates={selectedCorridor.coordinates}
          voltage={selectedCorridor.voltage}
          heatwave={heatwave}
        />
      ) : null}

      {scanMode ? (
        <AreaScanPanel
          result={scanResult}
          radius={scanRadius}
          loading={scanLoading}
          error={scanError}
          heatwave={heatwave}
          nicheCases={nicheCases}
          corridor={selectedCorridor}
          onTopPlant={(lat, lon) => {
            setCameraPreset("facility");
            map?.flyTo([lat, lon], 13, { duration: 0.8 });
          }}
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
