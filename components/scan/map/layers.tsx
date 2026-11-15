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
import { kvLabel, lineName, substationName } from "@/lib/scan/labels";
import type { ReportTarget } from "@/lib/scan/target";

/** Canvas layers can't read CSS vars, so the map colors live here. */
export const MAP_COLORS = {
  accent: "#0ea5e9",
  accentStrong: "#0284c7",
  gray: "#94a3b8",
  white: "#ffffff",
} as const;

export const PANES = {
  casing: { name: "gs-line-casing", z: 405 },
  lines: { name: "gs-lines", z: 410 },
  /** In-scan circuits: own pane so they always paint over the base network canvas. */
  scanLines: { name: "gs-lines-scan", z: 412 },
  points: { name: "gs-points", z: 430 },
  /** Selected-asset highlight: above the points, below the label tiles; never takes clicks. */
  highlight: { name: "gs-highlight", z: 440 },
} as const;

function ensurePane(map: L.Map, name: string, z: number) {
  const pane = map.getPane(name) ?? map.createPane(name);
  pane.style.zIndex = String(z);
  return pane;
}

/*
 * All interactive layers share ONE canvas. A canvas element swallows every
 * mouse event over its full extent, so separate per-layer canvases would block
 * hover/click on the layers beneath. The visible lines are drawn on their own
 * non-interactive canvases (see TransmissionLayer); their hover/click targets
 * are invisible paths on this shared canvas. Draw order inside the shared
 * canvas is restored with bringToFront: line targets → substations → plants →
 * events. `tolerance` widens the hit area around every feature so thin lines
 * are clickable.
 */
type PointKind = "lines" | "substations" | "plants" | "events";
const POINT_ORDER: PointKind[] = ["lines", "substations", "plants", "events"];
const pointRenderers = new WeakMap<L.Map, L.Canvas>();
const pointGroups = new WeakMap<L.Map, Partial<Record<PointKind, L.FeatureGroup>>>();

function pointsRenderer(map: L.Map): L.Canvas {
  let r = pointRenderers.get(map);
  if (!r) {
    ensurePane(map, PANES.points.name, PANES.points.z);
    r = L.canvas({ pane: PANES.points.name, padding: 0.4, tolerance: 6 });
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

const SUBSTATION_RADIUS = 2;

export function plantRadius(mw: number) {
  return Math.min(16, 3 + Math.sqrt(Math.max(0, mw)) / 2.2);
}

/** Fuel name for use mid-sentence ("natural gas", not "Natural gas"). */
function fuelText(k: string): string {
  const label = FUEL_LABELS[k as keyof typeof FUEL_LABELS] ?? k;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function plantTooltip(p: Plant): string {
  const total = p.nameplate_mw || 0;
  const mix = Object.entries(p.mw_by_source)
    .filter(([, v]) => (v ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 3)
    .map(([k, v]) => {
      const pct = total > 0 ? Math.round(((v ?? 0) / total) * 100) : 0;
      return { label: fuelText(k), pct };
    });
  const fuels =
    mix.length === 0
      ? ""
      : mix.length === 1
        ? ` ${esc(mix[0].label)}`
        : `: ${mix.map((m) => `${esc(m.label)} ${m.pct}%`).join(", ")}`;
  const age =
    p.capacity_weighted_age_years != null
      ? `Capacity-weighted age ${Math.round(p.capacity_weighted_age_years)} yr`
      : "Age not reported";
  return `<div class="gs-tip-title">${esc(p.plant_name)}</div>
<div class="gs-tip-row">${fmtMw(total)} MW${fuels}</div>
<div class="gs-tip-row">${age}</div>
<div class="gs-tip-src">${p.city ? `${esc(p.city)}. ` : ""}Source: EIA-860 2025</div>`;
}

/** "230 kV · Operator" (either part omitted when missing); null when both are missing. */
function kvOperatorRow(kv: string | null, operator: string | null): string | null {
  const parts = [kv, operator].filter((x): x is string => !!x).map(esc);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function substationTooltip(s: Substation): string {
  const row = kvOperatorRow(kvLabel(s.voltage_kv, s.kv_inferred), s.operator);
  return `<div class="gs-tip-title">${esc(substationName(s))}</div>
${row ? `<div class="gs-tip-row">${row}</div>\n` : ""}<div class="gs-tip-src">Substation. Source: OpenStreetMap</div>`;
}

function lineTooltip(l: Line): string {
  const row = kvOperatorRow(kvLabel(l.voltage_kv, l.kv_inferred), l.operator);
  return `<div class="gs-tip-title">${esc(lineName(l))}</div>
${row ? `<div class="gs-tip-row">${row}</div>\n` : ""}<div class="gs-tip-src">Power line. Source: OpenStreetMap</div>`;
}

function eventTooltip(e: GenEvent): string {
  const label = e.kind === "retired" ? "Retired" : "Proposed";
  const yr = e.year != null ? (e.kind === "retired" ? ` ${e.year}` : `, online ${e.year}`) : "";
  return `<div class="gs-tip-title">${esc(e.plant_name)}</div>
<div class="gs-tip-row">${label}${e.kind === "retired" ? yr : ""}: ${fmtMw(e.mw)} MW ${esc(
    fuelText(e.fuel),
  )}${e.kind === "proposed" ? yr : ""}</div>
<div class="gs-tip-row">${esc(e.technology)}</div>
<div class="gs-tip-src">Source: EIA-860 2025</div>`;
}

/** Keep a ref pointing at the latest callback so layers built once never go stale. */
function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

/** An asset was clicked: scan at (lat, lon) and select `target`. */
export type AssetClick = (target: ReportTarget, lat: number, lon: number) => void;

/* ---------------------------------------------------------------------------- */

/**
 * Line style by scan status. On satellite imagery slate gray disappears, so outside
 * lines are white there (and in-scan lines get a white casing underneath).
 */
function lineStyle(kv: number | null, inside: boolean, onImagery: boolean): L.PathOptions {
  const w = lineWeight(kv);
  if (onImagery) {
    return inside
      ? { color: MAP_COLORS.accent, opacity: 0.9, weight: w }
      : { color: MAP_COLORS.white, opacity: 0.6, weight: w };
  }
  return inside
    ? { color: MAP_COLORS.accent, opacity: 1, weight: w + 1 }
    : { color: MAP_COLORS.gray, opacity: 0.9, weight: w + 0.5 };
}

export function TransmissionLayer({
  lines,
  result,
  visible,
  onImagery,
  onAssetClick,
}: {
  lines: Line[];
  result: ScanResult | null;
  visible: boolean;
  /** True on the satellite basemap: lighter outside lines and a white casing under in-scan lines. */
  onImagery: boolean;
  onAssetClick: AssetClick;
}) {
  const map = useMap();
  const onClickRef = useLatest(onAssetClick);
  const baseRef = useRef<L.LayerGroup | null>(null);
  const hitRef = useRef<L.FeatureGroup | null>(null);
  const accentRef = useRef<{ group: L.LayerGroup; renderer: L.Canvas } | null>(null);

  const insideIds = useMemo(() => new Set((result?.lines ?? []).map((l) => l.osm_id)), [result]);

  // The whole network is drawn once and never restyled by a scan. Rebuilt only
  // when the dataset or the basemap kind changes, because the outside style is
  // basemap-dependent.
  useEffect(() => {
    ensurePane(map, PANES.lines.name, PANES.lines.z);
    const renderer = L.canvas({ pane: PANES.lines.name, padding: 0.4 });
    const group = L.layerGroup();
    for (const line of lines) {
      group.addLayer(
        L.polyline(line.coords, {
          renderer,
          pane: PANES.lines.name,
          interactive: false,
          lineCap: "round",
          lineJoin: "round",
          smoothFactor: 1.2,
          ...lineStyle(line.voltage_kv, false, onImagery),
        }),
      );
    }
    baseRef.current = group;
    return () => {
      group.remove();
      renderer.remove();
      baseRef.current = null;
    };
  }, [map, lines, onImagery]);

  // In-scan circuits live on their own canvas, rebuilt from only the lines that
  // are inside the circle. A radius change therefore costs O(inside) instead of
  // restyling every feature and asking Leaflet to redraw 5k paths per frame.
  useEffect(() => {
    const previous = accentRef.current;
    if (previous) {
      previous.group.remove();
      previous.renderer.remove();
      accentRef.current = null;
    }
    if (!visible || insideIds.size === 0) return;

    ensurePane(map, PANES.scanLines.name, PANES.scanLines.z);
    const renderer = L.canvas({ pane: PANES.scanLines.name, padding: 0.4 });
    const group = L.layerGroup();
    for (const line of lines) {
      if (!insideIds.has(line.osm_id)) continue;
      group.addLayer(
        L.polyline(line.coords, {
          renderer,
          pane: PANES.scanLines.name,
          interactive: false,
          ...lineStyle(line.voltage_kv, true, onImagery),
          lineCap: "round",
          lineJoin: "round",
          smoothFactor: 1.2,
        }),
      );
    }
    group.addTo(map);
    accentRef.current = { group, renderer };
    return () => {
      group.remove();
      renderer.remove();
      if (accentRef.current?.group === group) accentRef.current = null;
    };
  }, [insideIds, visible, onImagery, map, lines]);

  // White casing under in-scan lines, satellite only (drawn on a pane just below the lines).
  useEffect(() => {
    if (!onImagery || !visible || insideIds.size === 0) return;
    ensurePane(map, PANES.casing.name, PANES.casing.z);
    const renderer = L.canvas({ pane: PANES.casing.name, padding: 0.4 });
    const group = L.layerGroup();
    for (const line of lines) {
      if (!insideIds.has(line.osm_id)) continue;
      group.addLayer(
        L.polyline(line.coords, {
          renderer,
          pane: PANES.casing.name,
          interactive: false,
          color: MAP_COLORS.white,
          opacity: 1,
          weight: lineWeight(line.voltage_kv) + 2,
          lineCap: "round",
          lineJoin: "round",
          smoothFactor: 1.2,
        }),
      );
    }
    group.addTo(map);
    return () => {
      group.remove();
      renderer.remove();
    };
  }, [onImagery, visible, insideIds, lines, map]);

  // Hover/click targets: one invisible path per line on the shared canvas
  // (nothing is stroked or filled, so it never repaints the visible lines).
  // Built once per dataset; the visible lines above stay non-interactive.
  useEffect(() => {
    const renderer = pointsRenderer(map);
    const group = L.featureGroup();
    for (const line of lines) {
      const layer = L.polyline(line.coords, {
        renderer,
        pane: PANES.points.name,
        interactive: true,
        bubblingMouseEvents: false,
        stroke: false,
        fill: false,
        smoothFactor: 1.2,
      });
      layer.bindTooltip(() => lineTooltip(line), { direction: "top", offset: [0, -6], sticky: true });
      // Scan where the line was clicked (not its midpoint).
      layer.on("click", (ev: L.LeafletMouseEvent) =>
        onClickRef.current({ kind: "line", line }, ev.latlng.lat, ev.latlng.lng),
      );
      group.addLayer(layer);
    }
    hitRef.current = group;
    registerPointGroup(map, "lines", group);
    return () => {
      group.remove();
      registerPointGroup(map, "lines", null);
      hitRef.current = null;
    };
  }, [map, lines, onClickRef]);

  useEffect(() => {
    const g = baseRef.current;
    if (!g) return;
    if (visible && !map.hasLayer(g)) g.addTo(map);
    if (!visible && map.hasLayer(g)) g.remove();
  }, [visible, map, lines, onImagery]);

  useEffect(() => {
    const g = hitRef.current;
    if (!g) return;
    if (visible && !map.hasLayer(g)) {
      g.addTo(map);
      // Line targets go under every point so dots win the hit test.
      restackPoints(map);
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
  onAssetClick,
}: {
  substations: Substation[];
  result: ScanResult | null;
  visible: boolean;
  onAssetClick: AssetClick;
}) {
  const map = useMap();
  const onClickRef = useLatest(onAssetClick);
  const groupRef = useRef<L.FeatureGroup | null>(null);
  const entriesRef = useRef<{ s: Substation; layer: L.CircleMarker; inside: boolean }[]>([]);
  const insideIds = useMemo(() => new Set((result?.substations ?? []).map((s) => s.osm_id)), [result]);

  useEffect(() => {
    const renderer = pointsRenderer(map);
    const group = L.featureGroup();
    entriesRef.current = substations.map((s) => {
      const layer = L.circleMarker([s.lat, s.lon], {
        renderer,
        pane: PANES.points.name,
        radius: SUBSTATION_RADIUS,
        stroke: false,
        fillColor: MAP_COLORS.gray,
        fillOpacity: 0.6,
        bubblingMouseEvents: false,
      });
      layer.bindTooltip(() => substationTooltip(s), { direction: "top", offset: [0, -4] });
      layer.on("click", () => onClickRef.current({ kind: "substation", substation: s }, s.lat, s.lon));
      group.addLayer(layer);
      return { s, layer, inside: false };
    });
    groupRef.current = group;
    registerPointGroup(map, "substations", group);
    return () => {
      group.remove();
      registerPointGroup(map, "substations", null);
      groupRef.current = null;
      entriesRef.current = [];
    };
  }, [map, substations, onClickRef]);

  useEffect(() => {
    for (const e of entriesRef.current) {
      const inside = insideIds.has(e.s.osm_id);
      if (inside === e.inside) continue;
      e.inside = inside;
      e.layer.setStyle(
        inside
          ? { fillColor: MAP_COLORS.accentStrong, fillOpacity: 0.9 }
          : { fillColor: MAP_COLORS.gray, fillOpacity: 0.6 },
      );
    }
  }, [insideIds, substations]);

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
  onFocus,
  onAssetClick,
}: {
  plants: Plant[];
  result: ScanResult | null;
  visible: boolean;
  /** Optional: also fly the map to a clicked plant. */
  onFocus?: (lat: number, lon: number) => void;
  onAssetClick: AssetClick;
}) {
  const map = useMap();
  const groupRef = useRef<L.FeatureGroup | null>(null);
  const entriesRef = useRef<{ p: Plant; layer: L.CircleMarker; inside: boolean }[]>([]);
  const onFocusRef = useLatest(onFocus);
  const onClickRef = useLatest(onAssetClick);
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
        fillOpacity: 0.35,
        color: MAP_COLORS.white,
        weight: 1,
        opacity: 0.35,
        bubblingMouseEvents: false,
      });
      layer.bindTooltip(() => plantTooltip(p), { direction: "top", offset: [0, -6] });
      // Scan at the plant and select it (and fly there when onFocus is given).
      layer.on("click", () => {
        onClickRef.current({ kind: "plant", plant: p }, p.lat, p.lon);
        onFocusRef.current?.(p.lat, p.lon);
      });
      group.addLayer(layer);
      return { p, layer, inside: false };
    });
    groupRef.current = group;
    registerPointGroup(map, "plants", group);
    return () => {
      group.remove();
      registerPointGroup(map, "plants", null);
      groupRef.current = null;
      entriesRef.current = [];
    };
  }, [map, plants, onFocusRef, onClickRef]);

  useEffect(() => {
    for (const e of entriesRef.current) {
      const inside = insideIds.has(e.p.plant_code);
      if (inside === e.inside) continue;
      e.inside = inside;
      e.layer.setStyle(inside ? { fillOpacity: 0.95, opacity: 1 } : { fillOpacity: 0.35, opacity: 0.35 });
    }
  }, [insideIds, plants]);

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

/** Ring (plant / substation) or overlay (line) for the selected asset. Non-interactive. */
export function SelectionHighlight({ selected }: { selected: ReportTarget | null }) {
  const map = useMap();

  useEffect(() => {
    if (!selected || selected.kind === "area") return;
    // Own canvas on a pointer-events:none pane, so clicks fall through to the shared points canvas.
    ensurePane(map, PANES.highlight.name, PANES.highlight.z).style.pointerEvents = "none";
    const renderer = L.canvas({ pane: PANES.highlight.name, padding: 0.4 });
    const base = { renderer, pane: PANES.highlight.name, interactive: false, color: MAP_COLORS.accentStrong, opacity: 1 };
    const layer =
      selected.kind === "line"
        ? L.polyline(selected.line.coords, {
            ...base,
            // In-scan line weight (lineWeight + 1) plus 2.
            weight: lineWeight(selected.line.voltage_kv) + 3,
            lineCap: "round",
            lineJoin: "round",
            smoothFactor: 1.2,
          })
        : selected.kind === "plant"
          ? L.circleMarker([selected.plant.lat, selected.plant.lon], {
              ...base,
              radius: plantRadius(selected.plant.nameplate_mw) + 2,
              weight: 2,
              fill: false,
            })
          : L.circleMarker([selected.substation.lat, selected.substation.lon], {
              ...base,
              radius: SUBSTATION_RADIUS + 2,
              weight: 2,
              fill: false,
            });
    layer.addTo(map);
    return () => {
      layer.remove();
      renderer.remove();
    };
  }, [selected, map]);

  return null;
}

/* ---------------------------------------------------------------------------- */

/** Retired / proposed generators — drawn only for the current scan. */
export function EventLayer({
  events,
  visible,
}: {
  events: GenEvent[];
  visible: boolean;
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
              color: MAP_COLORS.gray,
              weight: 1.25,
              opacity: 0.9,
              fill: false,
            })
          : L.circleMarker([e.lat, e.lon], {
              renderer,
              pane: PANES.points.name,
              radius: r,
              color: MAP_COLORS.accent,
              weight: 1.25,
              opacity: 0.9,
              dashArray: "3 3",
              fill: false,
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
  }, [events, visible, map]);

  return null;
}
