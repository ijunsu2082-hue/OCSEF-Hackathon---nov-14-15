"use client";

import "leaflet/dist/leaflet.css";

import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { Circle, MapContainer, Marker, Pane, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { CENTER, COVERAGE_MI, haversineMi } from "@/lib/scan";
import type { NicheCase, ScanArea } from "@/lib/scan";
import { EventLayer, MAP_COLORS, PlantLayer, SubstationLayer, TransmissionLayer, esc } from "./layers";
import { LayerPicker, type LayerVisibility } from "./LayerPicker";
import { basemapById, loadBasemap, saveBasemap, type BasemapId } from "./basemaps";
import type { MapFocus, ScanMapProps } from "./types";

const COVERAGE_M = 160934;
const INITIAL_ZOOM = 10;

const MI_PER_DEG_LAT = 69.0;

const DEFAULT_LAYERS: LayerVisibility = {
  plants: true,
  transmission: true,
  substations: true,
  cases: true,
  events: false,
};

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

function caseIcon(selected: boolean) {
  const size = selected ? 14 : 12;
  return L.divIcon({
    className: "gs-icon",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div class="gs-case${selected ? " is-selected" : ""}"></div>`,
  });
}

function CaseMarkers({
  cases,
  selectedCaseId,
  onSelectCase,
}: {
  cases: NicheCase[];
  selectedCaseId: string | null;
  onSelectCase: (c: NicheCase) => void;
}) {
  const icons = useMemo(() => ({ base: caseIcon(false), sel: caseIcon(true) }), []);
  return (
    <>
      {cases.map((c) => {
        const selected = c.id === selectedCaseId;
        const icon = selected ? icons.sel : icons.base;
        return (
          <Marker
            key={c.id}
            position={[c.location.lat, c.location.lon]}
            icon={icon}
            zIndexOffset={selected ? 1000 : 0}
            eventHandlers={{ click: () => onSelectCase(c) }}
          >
            <Tooltip direction="top" offset={[0, -8]} className="gs-tip-wrap">
              <div className="gs-tip-title">{c.title}</div>
              <div className="gs-tip-row">{c.one_liner}</div>
              <div className="gs-tip-src">Niche case. {clip(c.location.name, 64)}</div>
            </Tooltip>
          </Marker>
        );
      })}
    </>
  );
}

/* ---- main ----------------------------------------------------------------- */

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
    if (haversineMi(lat, lon, CENTER.lat, CENTER.lon) > COVERAGE_MI) {
      setToast("This point is outside the 100-mile coverage area, so data may be incomplete.");
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 3500);
    } else {
      setToast(null);
    }
    onScan(lat, lon);
  };

  const scanArea = result?.area ?? area;
  const label = result
    ? `${formatRadius(scanArea.radius_mi)} mi · ${result.totals.plant_count.toLocaleString("en-US")} plant${
        result.totals.plant_count === 1 ? "" : "s"
      } · ${Math.round(result.totals.line_miles).toLocaleString("en-US")} mi of lines`
    : `${formatRadius(scanArea.radius_mi)} mi`;

  return (
    <div className="relative h-full w-full">
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
        <ClickToScan onClick={handleClick} />
        <FlyTo focus={focus} />

        {/* Coverage ring — 100 mi around Westminster HS */}
        <Circle
          center={[CENTER.lat, CENTER.lon]}
          radius={COVERAGE_M}
          interactive={false}
          pathOptions={{
            color: MAP_COLORS.accent,
            weight: 1,
            opacity: 0.8,
            dashArray: "4 6",
            fill: false,
          }}
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
        />
        <SubstationLayer substations={data.substations} result={result} visible={layers.substations} />
        <PlantLayer plants={data.plants} result={result} visible={layers.plants} onFocus={onFocus} />
        <EventLayer events={result?.events ?? EMPTY} visible={layers.events} />

        <Marker position={[CENTER.lat, CENTER.lon]} icon={homeIcon} interactive keyboard={false}>
          <Tooltip direction="top" offset={[0, -8]}>
            <div className="gs-tip-title">{CENTER.name}</div>
            <div className="gs-tip-row">Center of the 100-mile coverage area</div>
          </Tooltip>
        </Marker>

        {layers.cases && (
          <CaseMarkers cases={data.cases} selectedCaseId={selectedCaseId} onSelectCase={onSelectCase} />
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
            Click the map to scan an area
          </div>
        )}
      </div>

      <LayerPicker basemap={basemap.id} onBasemap={onBasemap} layers={layers} onLayers={setLayers} />
    </div>
  );
}

const EMPTY: never[] = [];

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

function formatRadius(r: number) {
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
