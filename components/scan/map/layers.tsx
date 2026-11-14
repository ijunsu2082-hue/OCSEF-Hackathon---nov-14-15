"use client";

/**
 * Imperative Leaflet layers for the big static datasets (5k+ lines, ~700 plants,
 * substations). Each layer is built ONCE on a dedicated canvas pane; a new scan
 * only re-styles the features whose inside/outside status actually changed.
 */

import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";
import { FUEL_COLORS, FUEL_LABELS, lineWeight } from "@/lib/scan";
import type { GenEvent, Line, Plant, ScanResult, Substation } from "@/lib/scan";

export interface MapPalette {
  accent: string;
  accent2: string;
  muted: string;
  bg: string;
  text: string;
  ok: string;
}

export const PALETTE: MapPalette = {
  accent: "#38d6c4",
  accent2: "#4c8dff",
  muted: "#8fa0b8",
  bg: "#080b12",
  text: "#edf2f8",
  ok: "#2dd4a7",
};

/** Mirrors the [data-stress="true"] token block — canvas can't read CSS vars. */
export const STRESS_PALETTE: MapPalette = {
  accent: "#ffb020",
  accent2: "#ff6b3d",
  muted: "#c4a79c",
  bg: "#0c0709",
  text: "#fdf3ec",
  ok: "#2dd4a7",
};

export const PANES = {
  lines: { name: "gs-lines", z: 410 },
  points: { name: "gs-points", z: 430 },
} as const;

function ensurePane(map: L.Map, name: string, z: number) {
  const pane = map.getPane(name) ?? map.createPane(name);
  pane.style.zIndex = String(z);
  return pane;
}

/*
 * All interactive point layers share ONE canvas. A canvas element swallows every
 * mouse event over its full extent, so separate per-layer canvases would block
 * hover/click on the layers beneath. Draw order inside the shared canvas is
 * restored with bringToFront: substations → plants → events.
 */
type PointKind = "substations" | "plants" | "events";
const POINT_ORDER: PointKind[] = ["substations", "plants", "events"];
const pointRenderers = new WeakMap<L.Map, L.Canvas>();
const pointGroups = new WeakMap<L.Map, Partial<Record<PointKind, L.FeatureGroup>>>();

function pointsRenderer(map: L.Map): L.Canvas {
  let r = pointRenderers.get(map);
  if (!r) {
    ensurePane(map, PANES.points.name, PANES.points.z);
    r = L.canvas({ pane: PANES.points.name, padding: 0.4 });
    pointRenderers.set(map, r);
  }
  return r;
}

function registerPointGroup(map: L.Map, kind: PointKind, group: L.FeatureGroup | null) {
  const groups = pointGroups.get(map) ?? {};
  if (group) groups[kind] = group;
  else delete groups[kind];
  pointGroups.set(map, groups);
}

function restackPoints(map: L.Map) {
  const groups = pointGroups.get(map);
  if (!groups) return;
  for (const k of POINT_ORDER) {
    const g = groups[k];
    if (g && map.hasLayer(g)) g.bringToFront();
  }
}

export function esc(s: string | number | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const fmtMw = (mw: number) =>
  mw >= 100 ? Math.round(mw).toLocaleString("en-US") : mw >= 10 ? mw.toFixed(0) : mw.toFixed(1);

export function plantRadius(mw: number) {
  return Math.min(22, 3 + Math.sqrt(Math.max(0, mw)) / 2.2);
}

function plantTooltip(p: Plant): string {
  const total = p.nameplate_mw || 0;
  const mix = Object.entries(p.mw_by_source)
    .filter(([, v]) => (v ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 3)
    .map(([k, v]) => {
      const pct = total > 0 ? Math.round(((v ?? 0) / total) * 100) : 0;
      return `${esc(FUEL_LABELS[k as keyof typeof FUEL_LABELS] ?? k)} ${pct}%`;
    })
    .join(" · ");
  const age =
    p.capacity_weighted_age_years != null
      ? `${Math.round(p.capacity_weighted_age_years)} yr cap-weighted age${
          p.capacity_weighted_year ? ` (${p.capacity_weighted_year})` : ""
        }`
      : "Age not reported";
  return `<div class="gs-tip-title">${esc(p.plant_name)}</div>
<div class="gs-tip-row">${fmtMw(total)} MW · ${mix || "—"}</div>
<div class="gs-tip-row">${age}</div>
<div class="gs-tip-src">EIA-860 2025${p.city ? ` · ${esc(p.city)}` : ""}</div>`;
}

function substationTooltip(s: Substation): string {
  return `<div class="gs-tip-title">${esc(s.name ?? "Unnamed substation")}</div>
<div class="gs-tip-row">${s.voltage_kv != null ? `${Math.round(s.voltage_kv)} kV` : "kV unknown"}${
    s.operator ? ` · ${esc(s.operator)}` : ""
  }</div>
<div class="gs-tip-src">OSM substation</div>`;
}

function eventTooltip(e: GenEvent): string {
  const label = e.kind === "retired" ? "Retired" : "Proposed";
  const yr = e.year != null ? (e.kind === "retired" ? ` ${e.year}` : ` · online ${e.year}`) : "";
  return `<div class="gs-tip-title">${esc(e.plant_name)}</div>
<div class="gs-tip-row">${label}${e.kind === "retired" ? yr : ""} · ${fmtMw(e.mw)} MW ${esc(
    FUEL_LABELS[e.fuel] ?? e.fuel,
  )}${e.kind === "proposed" ? yr : ""}</div>
<div class="gs-tip-row">${esc(e.technology)}</div>
<div class="gs-tip-src">EIA-860 2025 · ${e.kind === "retired" ? "retired generators" : "proposed generators"}</div>`;
}

/** Keep a ref pointing at the latest callback so layers built once never go stale. */
function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

/* ---------------------------------------------------------------------------- */

export function TransmissionLayer({
  lines,
  result,
  visible,
  palette,
}: {
  lines: Line[];
  result: ScanResult | null;
  visible: boolean;
  palette: MapPalette;
}) {
  const map = useMap();
  const groupRef = useRef<L.LayerGroup | null>(null);
  const entriesRef = useRef<{ line: Line; layer: L.Polyline; inside: boolean }[]>([]);
  const paletteRef = useRef<MapPalette | null>(null);

  const insideIds = useMemo(() => new Set((result?.lines ?? []).map((l) => l.osm_id)), [result]);

  // Build once per dataset.
  useEffect(() => {
    ensurePane(map, PANES.lines.name, PANES.lines.z);
    const renderer = L.canvas({ pane: PANES.lines.name, padding: 0.4 });
    const group = L.layerGroup();
    const entries = lines.map((line) => {
      const layer = L.polyline(line.coords, {
        renderer,
        pane: PANES.lines.name,
        interactive: false,
        color: PALETTE.muted,
        opacity: 0.35,
        weight: lineWeight(line.voltage_kv),
        lineCap: "round",
        lineJoin: "round",
        smoothFactor: 1.2,
      });
      group.addLayer(layer);
      return { line, layer, inside: false };
    });
    entriesRef.current = entries;
    groupRef.current = group;
    paletteRef.current = null; // force first full style pass
    return () => {
      group.remove();
      renderer.remove();
      groupRef.current = null;
      entriesRef.current = [];
    };
  }, [map, lines]);

  // Re-style only what changed (or everything when the palette flips).
  useEffect(() => {
    const full = paletteRef.current !== palette;
    paletteRef.current = palette;
    const newlyInside: L.Polyline[] = [];
    for (const e of entriesRef.current) {
      const inside = insideIds.has(e.line.osm_id);
      if (!full && inside === e.inside) continue;
      e.inside = inside;
      e.layer.setStyle(
        inside ? { color: palette.accent, opacity: 0.9 } : { color: palette.muted, opacity: 0.35 },
      );
      if (inside) newlyInside.push(e.layer);
    }
    if (groupRef.current && map.hasLayer(groupRef.current)) newlyInside.forEach((l) => l.bringToFront());
  }, [insideIds, palette, map, lines]);

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    if (visible && !map.hasLayer(g)) {
      g.addTo(map);
      for (const e of entriesRef.current) if (e.inside) e.layer.bringToFront();
    }
    if (!visible && map.hasLayer(g)) g.remove();
  }, [visible, map, lines]);

  return null;
}

/* ---------------------------------------------------------------------------- */

export function SubstationLayer({
  substations,
  result,
  visible,
  palette,
}: {
  substations: Substation[];
  result: ScanResult | null;
  visible: boolean;
  palette: MapPalette;
}) {
  const map = useMap();
  const groupRef = useRef<L.FeatureGroup | null>(null);
  const entriesRef = useRef<{ s: Substation; layer: L.CircleMarker; inside: boolean }[]>([]);
  const paletteRef = useRef<MapPalette | null>(null);
  const insideIds = useMemo(() => new Set((result?.substations ?? []).map((s) => s.osm_id)), [result]);

  useEffect(() => {
    const renderer = pointsRenderer(map);
    const group = L.featureGroup();
    entriesRef.current = substations.map((s) => {
      const layer = L.circleMarker([s.lat, s.lon], {
        renderer,
        pane: PANES.points.name,
        radius: 3,
        stroke: false,
        fillColor: PALETTE.muted,
        fillOpacity: 0.35,
      });
      layer.bindTooltip(() => substationTooltip(s), { direction: "top", offset: [0, -4] });
      group.addLayer(layer);
      return { s, layer, inside: false };
    });
    groupRef.current = group;
    registerPointGroup(map, "substations", group);
    paletteRef.current = null;
    return () => {
      group.remove();
      registerPointGroup(map, "substations", null);
      groupRef.current = null;
      entriesRef.current = [];
    };
  }, [map, substations]);

  useEffect(() => {
    const full = paletteRef.current !== palette;
    paletteRef.current = palette;
    for (const e of entriesRef.current) {
      const inside = insideIds.has(e.s.osm_id);
      if (!full && inside === e.inside) continue;
      e.inside = inside;
      e.layer.setStyle(
        inside ? { fillColor: palette.text, fillOpacity: 0.8 } : { fillColor: palette.muted, fillOpacity: 0.35 },
      );
    }
  }, [insideIds, palette, substations]);

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    if (visible && !map.hasLayer(g)) {
      g.addTo(map);
      restackPoints(map);
    }
    if (!visible && map.hasLayer(g)) g.remove();
  }, [visible, map, substations]);

  return null;
}

/* ---------------------------------------------------------------------------- */

export function PlantLayer({
  plants,
  result,
  visible,
  palette,
  onFocus,
}: {
  plants: Plant[];
  result: ScanResult | null;
  visible: boolean;
  palette: MapPalette;
  onFocus: (lat: number, lon: number) => void;
}) {
  const map = useMap();
  const groupRef = useRef<L.FeatureGroup | null>(null);
  const entriesRef = useRef<{ p: Plant; layer: L.CircleMarker; inside: boolean }[]>([]);
  const paletteRef = useRef<MapPalette | null>(null);
  const onFocusRef = useLatest(onFocus);
  const insideIds = useMemo(() => new Set((result?.plants ?? []).map((p) => p.plant_code)), [result]);

  useEffect(() => {
    const renderer = pointsRenderer(map);
    const group = L.featureGroup();
    // Biggest first so small plants stay clickable on top.
    const sorted = [...plants].sort((a, b) => b.nameplate_mw - a.nameplate_mw);
    entriesRef.current = sorted.map((p) => {
      const layer = L.circleMarker([p.lat, p.lon], {
        renderer,
        pane: PANES.points.name,
        radius: plantRadius(p.nameplate_mw),
        fillColor: FUEL_COLORS[p.primary_source] ?? FUEL_COLORS.other,
        fillOpacity: 0.25,
        color: PALETTE.bg,
        weight: 1,
        opacity: 0.25,
        bubblingMouseEvents: false,
      });
      layer.bindTooltip(() => plantTooltip(p), { direction: "top", offset: [0, -6] });
      layer.on("click", () => onFocusRef.current(p.lat, p.lon));
      group.addLayer(layer);
      return { p, layer, inside: false };
    });
    groupRef.current = group;
    registerPointGroup(map, "plants", group);
    paletteRef.current = null;
    return () => {
      group.remove();
      registerPointGroup(map, "plants", null);
      groupRef.current = null;
      entriesRef.current = [];
    };
  }, [map, plants, onFocusRef]);

  useEffect(() => {
    const full = paletteRef.current !== palette;
    paletteRef.current = palette;
    for (const e of entriesRef.current) {
      const inside = insideIds.has(e.p.plant_code);
      if (!full && inside === e.inside) continue;
      e.inside = inside;
      e.layer.setStyle(
        inside
          ? { fillOpacity: 0.95, opacity: 0.95, color: palette.bg, weight: 1 }
          : { fillOpacity: 0.25, opacity: 0.25, color: palette.bg, weight: 1 },
      );
    }
  }, [insideIds, palette, plants]);

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    if (visible && !map.hasLayer(g)) {
      g.addTo(map);
      restackPoints(map);
    }
    if (!visible && map.hasLayer(g)) g.remove();
  }, [visible, map, plants]);

  return null;
}

/* ---------------------------------------------------------------------------- */

/** Retired / proposed generators — drawn only for the current scan. */
export function EventLayer({
  events,
  visible,
  palette,
}: {
  events: GenEvent[];
  visible: boolean;
  palette: MapPalette;
}) {
  const map = useMap();

  useEffect(() => {
    if (!visible || events.length === 0) return;
    const renderer = pointsRenderer(map);
    const group = L.featureGroup();
    for (const e of events) {
      const r = Math.min(16, 3.5 + Math.sqrt(Math.max(0, e.mw)) / 2.5);
      const layer =
        e.kind === "retired"
          ? L.circleMarker([e.lat, e.lon], {
              renderer,
              pane: PANES.points.name,
              radius: r,
              color: palette.muted,
              weight: 1.5,
              opacity: 0.85,
              fill: false,
            })
          : L.circleMarker([e.lat, e.lon], {
              renderer,
              pane: PANES.points.name,
              radius: r,
              color: palette.ok,
              weight: 1.5,
              opacity: 0.95,
              dashArray: "3 3",
              fill: true,
              fillColor: palette.ok,
              fillOpacity: 0.06,
            });
      layer.bindTooltip(() => eventTooltip(e), { direction: "top", offset: [0, -4] });
      group.addLayer(layer);
    }
    group.addTo(map);
    registerPointGroup(map, "events", group);
    return () => {
      group.remove();
      registerPointGroup(map, "events", null);
    };
  }, [events, visible, palette, map]);

  return null;
}
