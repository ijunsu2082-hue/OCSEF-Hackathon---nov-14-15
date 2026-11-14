"use client";

import "leaflet/dist/leaflet.css";

import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { Circle, MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { CENTER, COVERAGE_MI, haversineMi } from "@/lib/scan";
import type { NicheCase, ScanArea } from "@/lib/scan";
import {
  EventLayer,
  PALETTE,
  PlantLayer,
  STRESS_PALETTE,
  SubstationLayer,
  TransmissionLayer,
  esc,
} from "./layers";
import { MapLegend, type LayerVisibility } from "./MapLegend";
import type { MapFocus, ScanMapProps } from "./types";

const COVERAGE_M = 160934;
const INITIAL_ZOOM = 10;

/**
 * CARTO `dark_all` now serves "API KEY REQUIRED" watermark tiles to keyless clients
 * (verified 2026-11-14), so the default basemap is Esri's keyless Dark Gray Canvas.
 * Set NEXT_PUBLIC_BASEMAP=carto to restore the CARTO layer.
 */
const BASEMAP = process.env.NEXT_PUBLIC_BASEMAP === "carto" ? "carto" : "esri-dark";
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

function useZoom() {
  const map = useMap();
  const [zoom, setZoom] = useState(() => map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  return zoom;
}

/** Radar sweep sized to the scan circle in screen pixels; remounted per scan to replay. */
function RadarPulse({ area }: { area: ScanArea }) {
  const map = useMap();
  const zoom = useZoom();
  const icon = useMemo(() => {
    const c = map.project([area.lat, area.lon], zoom);
    const n = map.project([area.lat + area.radius_mi / MI_PER_DEG_LAT, area.lon], zoom);
    const r = Math.max(8, Math.round(Math.abs(c.y - n.y)));
    return L.divIcon({
      className: "gs-icon",
      iconSize: [r * 2, r * 2],
      iconAnchor: [r, r],
      html: '<div class="gs-radar"><div class="gs-radar-sweep"></div><div class="gs-radar-ring"></div></div>',
    });
  }, [map, zoom, area.lat, area.lon, area.radius_mi]);
  return <Marker position={[area.lat, area.lon]} icon={icon} interactive={false} keyboard={false} />;
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
  iconSize: [14, 14],
  iconAnchor: [7, 7],
  html: '<div class="gs-home"></div>',
});

function caseIcon(selected: boolean, pulse: boolean) {
  const size = selected ? 22 : 14;
  return L.divIcon({
    className: "gs-icon",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div class="gs-case${selected ? " is-selected" : ""}">${
      pulse ? '<span class="gs-case-pulse"></span>' : ""
    }<span class="gs-case-diamond"></span></div>`,
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
  const icons = useMemo(
    () => ({
      base: caseIcon(false, false),
      basePulse: caseIcon(false, true),
      sel: caseIcon(true, false),
      selPulse: caseIcon(true, true),
    }),
    [],
  );
  return (
    <>
      {cases.map((c) => {
        const selected = c.id === selectedCaseId;
        const pulse = c.id === "wire-that-breathes";
        const icon = selected ? (pulse ? icons.selPulse : icons.sel) : pulse ? icons.basePulse : icons.base;
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
              <div className="gs-tip-src">Niche case · {clip(c.location.name, 64)}</div>
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
  heatwave,
  selectedCaseId,
  focus,
  onScan,
  onFocus,
  onSelectCase,
}: ScanMapProps) {
  const [layers, setLayers] = useState<LayerVisibility>(DEFAULT_LAYERS);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const palette = heatwave ? STRESS_PALETTE : PALETTE;

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const handleClick = (lat: number, lon: number) => {
    if (haversineMi(lat, lon, CENTER.lat, CENTER.lon) > COVERAGE_MI) {
      setToast("Outside the 100-mile coverage — data may be incomplete");
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 3500);
    } else {
      setToast(null);
    }
    onScan(lat, lon);
  };

  const scanArea = result?.area ?? area;
  const scanKey = `${scanArea.lat.toFixed(5)},${scanArea.lon.toFixed(5)},${scanArea.radius_mi}`;
  const label = result
    ? `${formatRadius(scanArea.radius_mi)} mi · ${result.totals.plant_count.toLocaleString("en-US")} plant${
        result.totals.plant_count === 1 ? "" : "s"
      } · ${Math.round(result.totals.line_miles).toLocaleString("en-US")} mi of lines`
    : `${formatRadius(scanArea.radius_mi)} mi · scanning…`;

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
        {BASEMAP === "carto" ? (
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution="&copy; OpenStreetMap contributors &copy; CARTO"
            subdomains="abcd"
            maxZoom={19}
          />
        ) : (
          <>
            <TileLayer
              url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
              attribution="Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors"
              maxNativeZoom={16}
              maxZoom={19}
            />
            <TileLayer
              url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}"
              maxNativeZoom={16}
              maxZoom={19}
              opacity={0.75}
            />
          </>
        )}
        <AutoResize />
        <ClickToScan onClick={handleClick} />
        <FlyTo focus={focus} />

        {/* Coverage ring — 100 mi around Westminster HS */}
        <Circle
          center={[CENTER.lat, CENTER.lon]}
          radius={COVERAGE_M}
          interactive={false}
          pathOptions={{
            color: palette.accent,
            weight: 1.25,
            opacity: 0.55,
            dashArray: "4 6",
            fillColor: palette.accent,
            fillOpacity: 0.04,
          }}
        />

        {/* Active scan circle (drawn under the data panes) */}
        <Circle
          center={[scanArea.lat, scanArea.lon]}
          radius={scanArea.radius_mi * 1609.344}
          interactive={false}
          pathOptions={{
            color: palette.accent,
            weight: 1.5,
            opacity: 0.95,
            fillColor: palette.accent,
            fillOpacity: 0.08,
          }}
        />

        <TransmissionLayer lines={data.lines} result={result} visible={layers.transmission} palette={palette} />
        <SubstationLayer
          substations={data.substations}
          result={result}
          visible={layers.substations}
          palette={palette}
        />
        <PlantLayer
          plants={data.plants}
          result={result}
          visible={layers.plants}
          palette={palette}
          onFocus={onFocus}
        />
        <EventLayer events={result?.events ?? EMPTY} visible={layers.events} palette={palette} />

        <Marker position={[CENTER.lat, CENTER.lon]} icon={homeIcon} interactive keyboard={false}>
          <Tooltip direction="top" offset={[0, -8]}>
            <div className="gs-tip-title">{CENTER.name}</div>
            <div className="gs-tip-row">Coverage center · 100-mile radius</div>
          </Tooltip>
        </Marker>

        {layers.cases && (
          <CaseMarkers cases={data.cases} selectedCaseId={selectedCaseId} onSelectCase={onSelectCase} />
        )}

        <RadarPulse key={scanKey} area={scanArea} />
        <ScanLabel area={scanArea} text={label} />
      </MapContainer>

      {/* Hint + toast: above map overlays (20), below the overlay drawer (30) */}
      <div
        className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2"
        style={{ zIndex: 25 }}
      >
        {toast ? (
          <div
            role="status"
            className="gs-toast rounded-[var(--radius-sm)] border px-3 py-1.5 text-[12px]"
            style={{
              background: "var(--panel-raised)",
              borderColor: "color-mix(in srgb, var(--warn) 45%, var(--border))",
              color: "var(--text)",
              boxShadow: "var(--shadow-pop)",
              whiteSpace: "nowrap",
            }}
          >
            <span className="mr-1.5 font-mono text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--warn)" }}>
              Notice
            </span>
            {toast}
          </div>
        ) : (
          <div
            className="rounded-full border px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.12em]"
            style={{
              background: "color-mix(in srgb, var(--bg) 80%, transparent)",
              borderColor: "var(--border)",
              color: "var(--muted)",
            }}
          >
            Click anywhere to scan
          </div>
        )}
      </div>

      <MapLegend layers={layers} onChange={setLayers} />
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
