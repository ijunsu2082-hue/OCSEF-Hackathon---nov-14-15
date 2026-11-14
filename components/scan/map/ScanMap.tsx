"use client";

/**
 * Map shell: owns the layers/basemap state and the 2D ↔ 3D switch so the
 * Google-Maps-style 2D map and the Google-Earth-style 3D terrain view share
 * one set of toggles, one basemap choice and one click-to-scan contract.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CENTER, COVERAGE_MI, haversineMi } from "@/lib/scan";
import { LayerPicker, type LayerVisibility } from "./LayerPicker";
import ScanMap2D from "./ScanMap2D";
import ScanMap3D from "./ScanMap3D";
import { loadBasemap, saveBasemap, type BasemapId } from "./basemaps";
import { scanLabelText } from "./shared";
import type { ScanMapProps } from "./types";

const DEFAULT_LAYERS: LayerVisibility = {
  plants: true,
  transmission: true,
  substations: true,
  cases: true,
  events: false,
};

export type ViewMode = "2d" | "3d";

const SHADOW = "0 1px 3px rgba(16,24,40,.08)";

export default function ScanMap({
  data,
  area,
  result,
  selectedCaseId,
  focus,
  onScan,
  onFocus,
  onSelectCase,
}: ScanMapProps) {
  const [layers, setLayers] = useState<LayerVisibility>(DEFAULT_LAYERS);
  const [mode, setMode] = useState<ViewMode>("2d");
  const [toast, setToast] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>(loadBasemap);
  // Earth views read as imagery over elevation; Google-Earth-style default, and
  // picking a basemap in 3D must not rewrite the 2D map's choice.
  const [drape, setDrape] = useState<BasemapId>("satellite");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const onBasemap = useCallback((id: BasemapId) => {
    setBasemap(id);
    saveBasemap(id);
  }, []);

  const handleScan = useCallback(
    (lat: number, lon: number) => {
      if (haversineMi(lat, lon, CENTER.lat, CENTER.lon) > COVERAGE_MI) {
        setToast("This point is outside the 100-mile coverage area, so data may be incomplete.");
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 3500);
      } else {
        setToast(null);
      }
      onScan(lat, lon);
    },
    [onScan],
  );

  const label = scanLabelText(area, result);

  return (
    <div className="relative h-full w-full">
      {mode === "3d" ? (
        <ScanMap3D
          data={data}
          area={area}
          result={result}
          selectedCaseId={selectedCaseId}
          focus={focus}
          layers={layers}
          basemap={drape}
          onScan={handleScan}
          onFocus={onFocus}
          onSelectCase={onSelectCase}
        />
      ) : (
        <ScanMap2D
          data={data}
          area={area}
          result={result}
          selectedCaseId={selectedCaseId}
          focus={focus}
          layers={layers}
          basemap={basemap}
          label={label}
          onScan={handleScan}
          onFocus={onFocus}
          onSelectCase={onSelectCase}
        />
      )}

      {/* Hint + toast: above map overlays (20), below the overlay drawer (30) */}
      <div
        className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2"
        style={{ zIndex: 25 }}
      >
        {toast ? (
          <div
            role="status"
            className="whitespace-nowrap rounded-[6px] border border-[#e6e9ee] bg-white px-3 py-1.5 text-[13px] text-[#1d2733]"
            style={{ boxShadow: SHADOW }}
          >
            {toast}
          </div>
        ) : (
          <div className="whitespace-nowrap rounded-[6px] border border-[#e6e9ee] bg-white px-2.5 py-1 text-[13px] text-[#556070]">
            {mode === "3d" ? "Click the terrain to scan an area" : "Click the map to scan an area"}
          </div>
        )}
      </div>

      {/* Google's 2D / 3D switch, in the same corner. */}
      <div className="absolute right-3 top-3" style={{ zIndex: 30 }}>
        <div
          role="group"
          aria-label="Map view"
          className="flex overflow-hidden rounded-[6px] border border-[#e6e9ee] bg-white"
          style={{ boxShadow: SHADOW }}
        >
          {(["2d", "3d"] as const).map((id) => {
            const selected = mode === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                onClick={() => setMode(id)}
                className={
                  selected
                    ? "px-3 py-1.5 text-[12px] font-semibold uppercase tracking-wide text-[#0284c7]"
                    : "px-3 py-1.5 text-[12px] font-medium uppercase tracking-wide text-[#556070] hover:bg-[#f6f8fa]"
                }
                style={{ background: selected ? "#e0f2fe" : undefined }}
              >
                {id === "2d" ? "2D" : "3D"}
              </button>
            );
          })}
        </div>
      </div>

      <LayerPicker
        mode={mode}
        basemap={mode === "3d" ? drape : basemap}
        onBasemap={mode === "3d" ? setDrape : onBasemap}
        layers={layers}
        onLayers={setLayers}
      />
    </div>
  );
}
