"use client";

import "leaflet/dist/leaflet.css";

import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { Circle, MapContainer, Marker, Pane, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { CENTER, COVERAGE_MI, haversineMi } from "@/lib/scan";
import type { ScanArea } from "@/lib/scan";
import type { NewsPin, ReportTarget } from "@/lib/scan/target";
import {
  EventLayer,
  MAP_COLORS,
  PlantLayer,
  SelectionHighlight,
  SubstationLayer,
  TransmissionLayer,
  esc,
} from "./layers";
import { LayerPicker, type LayerVisibility } from "./LayerPicker";
import { MapKey } from "./MapKey";
import ScanMap3D from "./ScanMap3D";
import { basemapById, loadBasemap, saveBasemap, type BasemapId } from "./basemaps";
import type { MapFocus, ScanMapProps } from "./types";

const COVERAGE_M = 160934;
const INITIAL_ZOOM = 10;

const MI_PER_DEG_LAT = 69.0;
/** Same Earth radius Leaflet's Circle uses, so the ring label sits exactly on the ring. */
const COVERAGE_DLAT = (COVERAGE_M / 6371000) * (180 / Math.PI);
const NEWS_PIN_ZOOM = 12;

const DEFAULT_LAYERS: LayerVisibility = {
  plants: true,
  transmission: true,
  substations: true,
  /** Niche-case pins; only the optional 3D view draws them. */
  cases: true,
  events: false,
};

/** 2D (the Leaflet map, default) or the optional 3D terrain view. */
export type ViewMode = "2d" | "3d";

/* ---- small helpers ------------------------------------------------------- */

function ClickToScan({ onClick }: { onClick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function FlyTo({ focus }: { focus: MapFocus | null }) {
  const map = useMap();
  useEffect(() => {
    if (!focus) return;
    const zoom = focus.zoom ?? Math.max(map.getZoom(), 11);
    map.flyTo([focus.lat, focus.lon], zoom, { duration: 0.8 });
    // nonce is the trigger; lat/lon alone would ignore repeat clicks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, map]);
  return null;
}

/** Keeps Leaflet's size in sync with its container (window resize, drawer toggle). */
function AutoResize() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    let raf = 0;
    // Until the user touches the map, keep the initial view centered on CENTER: Leaflet may have
    // initialized while the container was 0-sized / still resizing (narrow window, drawer overlay).
    let interacted = false;
    const markInteracted = () => { interacted = true; };
    const events = ["pointerdown", "wheel", "touchstart", "keydown"] as const;
    for (const ev of events) el.addEventListener(ev, markInteracted, { passive: true });
    const recenter = () => {
      map.invalidateSize({ pan: false });
      if (!interacted) map.setView([CENTER.lat, CENTER.lon], INITIAL_ZOOM, { animate: false });
    };
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recenter);
    });
    ro.observe(el);
    raf = requestAnimationFrame(recenter);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      for (const ev of events) el.removeEventListener(ev, markInteracted);
    };
  }, [map]);
  return null;
}

function ScanLabel({ area, text }: { area: ScanArea; text: string }) {
  const icon = useMemo(
    () =>
      L.divIcon({
        className: "gs-icon",
        iconSize: [0, 0],
        iconAnchor: [0, 0],
        html: `<span class="gs-scan-label">${esc(text)}</span>`,
      }),
    [text],
  );
  const lonOffset = area.radius_mi / (MI_PER_DEG_LAT * Math.cos((area.lat * Math.PI) / 180));
  return (
    <Marker position={[area.lat, area.lon + lonOffset]} icon={icon} interactive={false} keyboard={false} />
  );
}

const homeIcon = L.divIcon({
  className: "gs-icon",
  iconSize: [10, 10],
  iconAnchor: [5, 5],
  html: '<div class="gs-home"></div>',
});

const ringLabelIcon = L.divIcon({
  className: "gs-icon",
  iconSize: [0, 0],
  iconAnchor: [0, 0],
  html: '<span class="gs-scan-label gs-ring-label">100-mile study area</span>',
});

const newsPinIcon = L.divIcon({
  className: "gs-icon",
  iconSize: [14, 14],
  iconAnchor: [7, 7],
  html: '<div class="gs-news-pin"></div>',
});

/** Flies to a story's spot from the Local news tab (nonce re-triggers the same story). */
function NewsPinFly({ pin }: { pin: NewsPin | null }) {
  const map = useMap();
  useEffect(() => {
    if (!pin) return;
    map.flyTo([pin.lat, pin.lon], NEWS_PIN_ZOOM, { duration: 0.8 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.nonce, map]);
  return null;
}

/* ---- main ----------------------------------------------------------------- */

export default function ScanMap({
  data,
  area,
  result,
  focus,
  newsPin,
  onScan,
  onFocus,
  onSelectAsset,
  selected,
  selectedCaseId = null,
  onSelectCase = noopCase,
}: ScanMapProps) {
  const [layers, setLayers] = useState<LayerVisibility>(DEFAULT_LAYERS);
  const [mode, setMode] = useState<ViewMode>("2d");
  // The 3D view drapes imagery by default; picking a drape there must not rewrite the 2D basemap.
  const [drape, setDrape] = useState<BasemapId>("satellite");
  // The news pin hides on the next map click; a new pin (new nonce) shows again.
  const [clearedPinNonce, setClearedPinNonce] = useState<number | null>(null);
  const shownPin = newsPin && newsPin.nonce !== clearedPinNonce ? newsPin : null;
  const [toast, setToast] = useState<string | null>(null);
  const [basemapId, setBasemapId] = useState<BasemapId>(loadBasemap);
  const basemap = basemapById(basemapId);
  const onBasemap = (id: BasemapId) => {
    setBasemapId(id);
    saveBasemap(id);
  };
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const handleClick = (lat: number, lon: number) => {
    if (newsPin) setClearedPinNonce(newsPin.nonce);
    if (haversineMi(lat, lon, CENTER.lat, CENTER.lon) > COVERAGE_MI) {
      setToast("This point is outside the 100-mile coverage area, so data may be incomplete.");
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 3500);
    } else {
      setToast(null);
    }
    onScan(lat, lon);
  };

  // Empty map: scan there and clear the selection.
  const handleMapClick = (lat: number, lon: number) => {
    handleClick(lat, lon);
    onSelectAsset(null);
  };

  /*
   * A dot or line: scan at that point and select it. The asset layers set
   * bubblingMouseEvents: false, so Leaflet never also fires the map click.
   */
  const handleAssetClick = (target: ReportTarget, lat: number, lon: number) => {
    handleClick(lat, lon);
    onSelectAsset(target);
  };

  const scanArea = result?.area ?? area;
  const label = result
    ? `${formatRadius(scanArea.radius_mi)} mi · ${result.totals.plant_count.toLocaleString("en-US")} plant${
        result.totals.plant_count === 1 ? "" : "s"
      } · ${Math.round(result.totals.line_miles).toLocaleString("en-US")} mi of lines`
    : `${formatRadius(scanArea.radius_mi)} mi`;

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
          selected={selected}
          onScan={handleMapClick}
          onAssetClick={handleAssetClick}
          onFocus={onFocus}
          onSelectCase={onSelectCase}
        />
      ) : (
        <MapContainer
          center={[CENTER.lat, CENTER.lon]}
          zoom={INITIAL_ZOOM}
          minZoom={6}
          maxZoom={17}
          preferCanvas
          worldCopyJump={false}
          className="h-full w-full"
          style={{ zIndex: 0 }}
          attributionControl
        >
          <TileLayer
            key={basemap.id}
            url={basemap.url}
            attribution={basemap.attribution}
            maxNativeZoom={basemap.maxNativeZoom}
            maxZoom={19}
          />
          <AutoResize />
          <ClickToScan onClick={handleMapClick} />
          <FlyTo focus={focus} />
          <NewsPinFly pin={newsPin ?? null} />

          {/* Coverage ring — 100 mi around Westminster HS */}
          <Circle
            center={[CENTER.lat, CENTER.lon]}
            radius={COVERAGE_M}
            interactive={false}
            pathOptions={{
              color: MAP_COLORS.accentStrong,
              weight: 2,
              opacity: 0.75,
              fill: false,
            }}
          />
          <Marker
            position={[CENTER.lat + COVERAGE_DLAT, CENTER.lon]}
            icon={ringLabelIcon}
            interactive={false}
            keyboard={false}
          />

          {/* Active scan circle (drawn under the data panes) */}
          <Circle
            center={[scanArea.lat, scanArea.lon]}
            radius={scanArea.radius_mi * 1609.344}
            interactive={false}
            pathOptions={{
              color: MAP_COLORS.accent,
              weight: 2,
              opacity: 1,
              fillColor: MAP_COLORS.accent,
              fillOpacity: 0.06,
            }}
          />

          <TransmissionLayer
            lines={data.lines}
            result={result}
            visible={layers.transmission}
            onImagery={basemap.id === "satellite"}
            onAssetClick={handleAssetClick}
          />
          <SubstationLayer
            substations={data.substations}
            result={result}
            visible={layers.substations}
            onAssetClick={handleAssetClick}
          />
          <PlantLayer plants={data.plants} result={result} visible={layers.plants} onAssetClick={handleAssetClick} />
          <EventLayer events={result?.events ?? EMPTY} visible={layers.events} />
          <SelectionHighlight selected={selected} />

          <Marker position={[CENTER.lat, CENTER.lon]} icon={homeIcon} interactive keyboard={false}>
            <Tooltip direction="top" offset={[0, -8]}>
              <div className="gs-tip-title">{CENTER.name}</div>
              <div className="gs-tip-row">Center of the 100-mile coverage area</div>
            </Tooltip>
          </Marker>

          {shownPin && (
            <Marker
              key={shownPin.nonce}
              position={[shownPin.lat, shownPin.lon]}
              icon={newsPinIcon}
              interactive={false}
              keyboard={false}
              zIndexOffset={1000}
            />
          )}

          <ScanLabel area={scanArea} text={label} />

          {/* Labels above the data layers so place names stay readable. */}
          <Pane name="gs-labels" style={{ zIndex: 450, pointerEvents: "none" }}>
            {basemap.labelsUrl && (
              <TileLayer
                key={basemap.id}
                url={basemap.labelsUrl}
                maxNativeZoom={basemap.maxNativeZoom}
                maxZoom={19}
              />
            )}
          </Pane>
        </MapContainer>
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
            style={{ boxShadow: "0 1px 3px rgba(16,24,40,.08)" }}
          >
            {toast}
          </div>
        ) : (
          <div className="whitespace-nowrap rounded-[6px] border border-[#e6e9ee] bg-white px-2.5 py-1 text-[13px] text-[#556070]">
            {mode === "3d" ? "Click the terrain to scan an area" : "Click the map to scan an area"}
          </div>
        )}
      </div>

      {/* Optional 3D terrain view; 2D is the default. In 3D it sits left of MapLibre's zoom/compass. */}
      <div className={mode === "3d" ? "absolute right-[52px] top-3" : "absolute right-3 top-3"} style={{ zIndex: 20 }}>
        <div
          role="group"
          aria-label="Map view"
          className="flex overflow-hidden rounded-[6px] border border-[#e6e9ee] bg-white"
          style={{ boxShadow: "0 1px 3px rgba(16,24,40,.08)" }}
        >
          {(["2d", "3d"] as const).map((id) => {
            const on = mode === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={on}
                onClick={() => setMode(id)}
                className={
                  on
                    ? "px-2.5 py-1 text-[12px] font-semibold text-[#0369a1]"
                    : "px-2.5 py-1 text-[12px] font-medium text-[#556070] hover:bg-[#f6f8fa]"
                }
                style={{ background: on ? "#e0f2fe" : undefined }}
              >
                {id === "2d" ? "2D" : "3D"}
              </button>
            );
          })}
        </div>
      </div>

      <LayerPicker
        mode={mode}
        basemap={mode === "3d" ? drape : basemap.id}
        onBasemap={mode === "3d" ? setDrape : onBasemap}
        layers={layers}
        onLayers={setLayers}
      />
      {mode === "2d" && <MapKey />}
    </div>
  );
}

const EMPTY: never[] = [];

/** The page selects stories through the Local news tab, not the map. */
const noopCase = () => {};

function formatRadius(r: number) {
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
