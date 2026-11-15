"use client";

/*
 * Live hazard overlays (NIFC fires + perimeters, USGS quakes) for a react-leaflet map.
 * Render inside an existing <MapContainer>; this creates no map.
 *
 * The scan map uses preferCanvas and a shared points canvas that swallows mouse events.
 * These overlays use their own SVG pane above the points pane with pointer-events off on
 * the pane, so only the fire/quake circles themselves take hover; everything else passes
 * through to the layers below.
 */

import { useEffect } from "react";
import L from "leaflet";
import type { FeatureCollection } from "geojson";
import { useMap } from "react-leaflet";
import type { HazardFire, HazardQuake } from "@/lib/live/hazards";

const PANE = { name: "gs-hazards", z: 435 } as const; // above gs-points (430), below gs-highlight (440)

const COLORS = {
  fireActive: "#dc2626", // red: not fully contained (or containment not reported)
  fireContained: "#d97706", // amber: 100% contained
  perimeter: "#d97706",
  quake: "#5b7a99", // grey-blue
} as const;

const renderers = new WeakMap<L.Map, L.SVG>();

function hazardRenderer(map: L.Map): L.SVG {
  let r = renderers.get(map);
  if (!r) {
    const pane = map.getPane(PANE.name) ?? map.createPane(PANE.name);
    pane.style.zIndex = String(PANE.z);
    pane.style.pointerEvents = "none";
    r = L.svg({ pane: PANE.name, padding: 0.4 });
    renderers.set(map, r);
  }
  return r;
}

function esc(s: string | number | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fireTooltip(f: HazardFire): string {
  const acres =
    f.acres == null ? "size not reported" : `${f.acres.toLocaleString("en-US", { maximumFractionDigits: f.acres < 10 ? 1 : 0 })} acres`;
  const contained = f.containedPct == null ? "" : ` · ${Math.round(f.containedPct)}% contained`;
  return `<strong>${esc(f.name)}</strong><br/>${esc(acres)}${esc(contained)}`;
}

function quakeTooltip(q: HazardQuake): string {
  return `<strong>M${esc(q.mag.toFixed(1))}</strong> ${esc(q.place)}`;
}

function quakeRadius(mag: number): number {
  return Math.max(2.5, Math.min(12, 2.5 + (mag - 2) * 2));
}

export function LiveHazardLayers({
  fires,
  perimeters,
  quakes,
}: {
  fires: HazardFire[];
  perimeters?: FeatureCollection | null;
  quakes: HazardQuake[];
}) {
  const map = useMap();

  useEffect(() => {
    const renderer = hazardRenderer(map);
    const group = L.featureGroup();

    if (perimeters && perimeters.features.length > 0) {
      group.addLayer(
        L.geoJSON(perimeters, {
          style: () => ({
            renderer,
            pane: PANE.name,
            color: COLORS.perimeter,
            weight: 1.5,
            opacity: 0.9,
            fill: true,
            fillColor: COLORS.perimeter,
            fillOpacity: 0.08,
            interactive: false,
          }),
          interactive: false,
        }),
      );
    }

    for (const q of quakes) {
      const m = L.circleMarker([q.lat, q.lon], {
        renderer,
        pane: PANE.name,
        radius: quakeRadius(q.mag),
        color: COLORS.quake,
        weight: 1,
        opacity: 0.9,
        fillColor: COLORS.quake,
        fillOpacity: 0.35,
        bubblingMouseEvents: false,
      });
      m.bindTooltip(() => quakeTooltip(q), { direction: "top", offset: [0, -4] });
      group.addLayer(m);
    }

    for (const f of fires) {
      const color = f.containedPct != null && f.containedPct >= 100 ? COLORS.fireContained : COLORS.fireActive;
      const m = L.circleMarker([f.lat, f.lon], {
        renderer,
        pane: PANE.name,
        radius: 5,
        color: "#ffffff",
        weight: 1.25,
        opacity: 1,
        fillColor: color,
        fillOpacity: 0.95,
        bubblingMouseEvents: false,
      });
      m.bindTooltip(() => fireTooltip(f), { direction: "top", offset: [0, -6] });
      group.addLayer(m);
    }

    group.addTo(map);
    return () => {
      group.remove();
    };
  }, [map, fires, perimeters, quakes]);

  return null;
}

export default LiveHazardLayers;
