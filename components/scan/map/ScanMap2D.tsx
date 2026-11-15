"use client";

/**
 * The 2D map: Leaflet with keyless Esri tiles (Esri street, imagery + labels,
 * topo, light canvas), canvas-drawn grid layers, and the scan circle.
 */

import "leaflet/dist/leaflet.css";

import L from "leaflet";
import { useEffect, useMemo } from "react";
import {
  AttributionControl,
  Circle,
  MapContainer,
  Marker,
  Pane,
  ScaleControl,
  TileLayer,
  Tooltip,
  ZoomControl,
  useMap,
  useMapEvents,
} from "react-leaflet";
import { CENTER, COVERAGE_MI } from "@/lib/scan";
import type { GridData, NicheCase, ScanArea, ScanResult } from "@/lib/scan";
import { EventLayer, MAP_COLORS, PlantLayer, SubstationLayer, TransmissionLayer, esc } from "./layers";
import { basemapById, type BasemapId } from "./basemaps";
import type { LayerVisibility } from "./LayerPicker";
import { MI_PER_DEG_LAT } from "./shared";
import type { NewsPin } from "@/lib/scan/target";
import type { MapFocus } from "./types";

const COVERAGE_M = 160934;
const INITIAL_ZOOM = 10;
/** Esri's street and imagery services are published through z19 in this area. */
const MAX_ZOOM = 19;

/* ---- small helpers ------------------------------------------------------- */

function ClickToScan({ onClick }: { onClick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

const newsPinIcon = L.divIcon({
  className: "gs-icon",
  iconSize: [14, 14],
  iconAnchor: [7, 7],
  html: '<div class="gs-news-pin"></div>',
});

/** Flies to a story's spot from the Local news tab (nonce re-triggers a repeat). */
function NewsPinFly({ pin }: { pin: NewsPin | null }) {
  const map = useMap();
  useEffect(() => {
    if (!pin) return;
    map.flyTo([pin.lat, pin.lon], 12, { duration: 0.8 });
    // nonce is the trigger; the same story clicked twice still flies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.nonce, map]);
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
    const markInteracted = () => {
      interacted = true;
    };
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

export interface ScanMap2DProps {
  data: GridData;
  area: ScanArea;
  result: ScanResult | null;
  selectedCaseId: string | null;
  focus: MapFocus | null;
  layers: LayerVisibility;
  basemap: BasemapId;
  label: string;
  newsPin?: NewsPin | null;
  onScan: (lat: number, lon: number) => void;
  onFocus: (lat: number, lon: number) => void;
  onSelectCase: (c: NicheCase) => void;
}

export default function ScanMap2D({
  data,
  area,
  result,
  selectedCaseId,
  focus,
  layers,
  basemap,
  label,
  newsPin,
  onScan,
  onFocus,
  onSelectCase,
}: ScanMap2DProps) {
  const base = basemapById(basemap);
  const scanArea = result?.area ?? area;

  return (
    <MapContainer
      center={[CENTER.lat, CENTER.lon]}
      zoom={INITIAL_ZOOM}
      minZoom={6}
      maxZoom={MAX_ZOOM}
      preferCanvas
      worldCopyJump={false}
      className="h-full w-full"
      style={{ zIndex: 0 }}
      attributionControl={false}
      zoomControl={false}
    >
      <TileLayer
        key={base.id}
        url={base.url}
        attribution={base.attribution}
        maxNativeZoom={base.maxNativeZoom}
        maxZoom={MAX_ZOOM}
      />
      <AutoResize />
      <ClickToScan onClick={onScan} />
      <FlyTo focus={focus} />
      <NewsPinFly pin={newsPin ?? null} />
      {newsPin && (
        <Marker
          key={newsPin.nonce}
          position={[newsPin.lat, newsPin.lon]}
          icon={newsPinIcon}
          interactive={false}
          keyboard={false}
        />
      )}

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
        onImagery={base.id === "satellite"}
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
        {base.labelsUrl && (
          <TileLayer
            key={base.id}
            url={base.labelsUrl}
            maxNativeZoom={base.maxNativeZoom}
            maxZoom={MAX_ZOOM}
          />
        )}
      </Pane>

      {/* Google Maps chrome: zoom and scale, with attribution along the bottom. */}
      <ZoomControl position="bottomright" />
      <ScaleControl position="bottomright" metric imperial={false} maxWidth={110} />
      <AttributionControl position="bottomleft" prefix={false} />
    </MapContainer>
  );
}

const EMPTY: never[] = [];

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}
