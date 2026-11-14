"use client";

/**
 * Imperative Leaflet layers for the big static datasets (5k+ lines, ~700 plants,
 * substations). Each layer is built ONCE on a shared canvas; a new scan only
 * re-styles the features whose inside/outside status actually changed.
 */

import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";
import { FUEL_COLORS, FUEL_LABELS, haversineMi, lineWeight } from "@/lib/scan";
import type { GenEvent, Line, Plant, ScanResult, Substation } from "@/lib/scan";
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
  points: { name: "gs-points", z: 430 },
} as const;

function ensurePane(map: L.Map, name: string, z: number) {
  const pane = map.getPane(name) ?? map.createPane(name);
  pane.style.zIndex = String(z);
  return pane;
}

/*
 * All interactive layers (lines AND points) share ONE canvas. A canvas element
 * swallows every mouse event over its full extent and only hit-tests its own
 * layers, so a separate line canvas under the points canvas could never be
 * clicked. Draw order inside the shared canvas: lines first (in-scan lines on
 * top of the rest), then bringToFront restores substations → plants → events.
 * `tolerance` widens the hit area around every feature so thin lines are clickable.
 */
type PointKind = "substations" | "plants" | "events";
const POINT_ORDER: PointKind[] = ["substations", "plants", "events"];
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

export function plantRadius(mw: number) {
  return Math.min(16, 3 + Math.sqrt(Math.max(0, mw)) / 2.2);
}

/** Fuel name for use mid-sentence ("natural gas", not "Natural gas"). */
function fuelText(k: string): string {
  const label = FUEL_LABELS[k as keyof typeof FUEL_LABELS] ?? k;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** Escaped " solar" / ": solar 60%, battery 40%" suffix for "N MW". */
function plantFuels(p: Plant): string {
  const total = p.nameplate_mw || 0;
  const mix = Object.entries(p.mw_by_source)
    .filter(([, v]) => (v ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 3)
    .map(([k, v]) => {
      const pct = total > 0 ? Math.round(((v ?? 0) / total) * 100) : 0;
      return { label: fuelText(k), pct };
    });
  return mix.length === 0
    ? ""
    : mix.length === 1
      ? ` ${esc(mix[0].label)}`
      : `: ${mix.map((m) => `${esc(m.label)} ${m.pct}%`).join(", ")}`;
}

function plantAge(p: Plant): string {
  return p.capacity_weighted_age_years != null
    ? `Capacity-weighted age ${Math.round(p.capacity_weighted_age_years)} yr`
    : "Age not reported";
}

function plantTooltip(p: Plant): string {
  const total = p.nameplate_mw || 0;
  const fuels = plantFuels(p);
  const age = plantAge(p);
  return `<div class="gs-tip-title">${esc(p.plant_name)}</div>
<div class="gs-tip-row">${fmtMw(total)} MW${fuels}</div>
<div class="gs-tip-row">${age}</div>
<div class="gs-tip-src">${p.city ? `${esc(p.city)}. ` : ""}Source: EIA-860 2025</div>`;
}

function substationTooltip(s: Substation): string {
  return `<div class="gs-tip-title">${esc(s.name ?? "Unnamed substation")}</div>
<div class="gs-tip-row">${s.voltage_kv != null ? `${Math.round(s.voltage_kv)} kV` : "kV unknown"}${
    s.operator ? ` · ${esc(s.operator)}` : ""
  }</div>
<div class="gs-tip-src">Substation. Source: OpenStreetMap</div>`;
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

/* ---- click popups ------------------------------------------------------------ */

const REPORT_BUTTON = '<button type="button" class="gs-pop-btn" data-gs-report>Report a problem</button>';

function popupHtml(title: string, rows: string[], src: string): string {
  return `<div class="gs-pop"><div class="gs-pop-title">${title}</div>${rows
    .map((r) => `<div class="gs-pop-row">${r}</div>`)
    .join("")}<div class="gs-pop-src">${src}</div>${REPORT_BUTTON}</div>`;
}

function plantPopup(p: Plant): string {
  const place = [p.city, p.utility_name].filter(Boolean).map(esc).join(" · ");
  return popupHtml(
    esc(p.plant_name),
    [`${fmtMw(p.nameplate_mw || 0)} MW${plantFuels(p)}`, plantAge(p), ...(place ? [place] : [])],
    "Power plant. Source: EIA-860 2025",
  );
}

function kvText(kv: number | null): string {
  return kv != null ? `${Math.round(kv)} kV` : "kV unknown";
}

function substationPopup(s: Substation): string {
  return popupHtml(
    esc(s.name ?? "Unnamed substation"),
    [kvText(s.voltage_kv), s.operator ? `Operator: ${esc(s.operator)}` : "Operator not listed"],
    "Substation. Source: OpenStreetMap",
  );
}

function lineMiles(line: Line): number {
  let mi = 0;
  for (let i = 1; i < line.coords.length; i++) {
    const [aLat, aLon] = line.coords[i - 1];
    const [bLat, bLon] = line.coords[i];
    mi += haversineMi(aLat, aLon, bLat, bLon);
  }
  return mi;
}

function linePopup(line: Line, inside: boolean): string {
  const mi = lineMiles(line);
  return popupHtml(
    esc(line.name ?? "Transmission line"),
    [
      kvText(line.voltage_kv),
      line.operator ? `Operator: ${esc(line.operator)}` : "Operator not listed",
      `${mi >= 10 ? Math.round(mi).toLocaleString("en-US") : mi.toFixed(1)} mi long`,
      inside ? "Inside your scan area" : "Outside your scan area",
    ],
    "Power line. Source: OpenStreetMap",
  );
}

const POPUP_OPTIONS: L.PopupOptions = {
  className: "gs-pop-wrap",
  minWidth: 220,
  maxWidth: 280,
  autoPanPadding: [16, 16],
};

/** Which asset each popup belongs to; read by <ReportPopups> when a popup opens. */
const popupTargets = new WeakMap<L.Popup, { target: ReportTarget; layer: L.Layer }>();

function bindReportPopup(layer: L.Layer, html: () => string, target: ReportTarget) {
  layer.bindPopup(() => html(), POPUP_OPTIONS);
  const popup = layer.getPopup();
  if (popup) popupTargets.set(popup, { target, layer });
}

/** Wires the "Report a problem" button inside every asset popup to `onReport`. */
export function ReportPopups({ onReport }: { onReport: (t: ReportTarget) => void }) {
  const map = useMap();
  const onReportRef = useLatest(onReport);

  useEffect(() => {
    const onOpen = (e: L.PopupEvent) => {
      const entry = popupTargets.get(e.popup);
      if (!entry) return;
      // The popup repeats the hover tooltip, so hide the tooltip under it.
      entry.layer.closeTooltip();
      const btn = e.popup.getElement()?.querySelector<HTMLButtonElement>("[data-gs-report]");
      btn?.addEventListener("click", () => {
        onReportRef.current(entry.target);
        map.closePopup();
      });
    };
    map.on("popupopen", onOpen);
    return () => {
      map.off("popupopen", onOpen);
    };
  }, [map, onReportRef]);

  return null;
}

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
}: {
  lines: Line[];
  result: ScanResult | null;
  visible: boolean;
  /** True on the satellite basemap: lighter outside lines and a white casing under in-scan lines. */
  onImagery: boolean;
}) {
  const map = useMap();
  const groupRef = useRef<L.LayerGroup | null>(null);
  const entriesRef = useRef<{ line: Line; layer: L.Polyline; inside: boolean }[]>([]);
  const imageryRef = useRef(false);

  const insideIds = useMemo(() => new Set((result?.lines ?? []).map((l) => l.osm_id)), [result]);

  // Build once per dataset, on the shared canvas (see pointsRenderer).
  useEffect(() => {
    const renderer = pointsRenderer(map);
    const group = L.layerGroup();
    const entries = lines.map((line) => {
      const layer = L.polyline(line.coords, {
        renderer,
        pane: PANES.points.name,
        interactive: true,
        bubblingMouseEvents: false,
        ...lineStyle(line.voltage_kv, false, false),
        lineCap: "round",
        lineJoin: "round",
        smoothFactor: 1.2,
      });
      const entry = { line, layer, inside: false };
      bindReportPopup(layer, () => linePopup(line, entry.inside), { kind: "line", line });
      group.addLayer(layer);
      return entry;
    });
    entriesRef.current = entries;
    groupRef.current = group;
    imageryRef.current = false;
    return () => {
      group.remove();
      groupRef.current = null;
      entriesRef.current = [];
    };
  }, [map, lines]);

  // Re-style only what changed (or every line when the basemap kind flips).
  useEffect(() => {
    const full = imageryRef.current !== onImagery;
    imageryRef.current = onImagery;
    const newlyInside: L.Polyline[] = [];
    for (const e of entriesRef.current) {
      const inside = insideIds.has(e.line.osm_id);
      if (inside === e.inside && !full) continue;
      e.inside = inside;
      e.layer.setStyle(lineStyle(e.line.voltage_kv, inside, onImagery));
      if (inside) newlyInside.push(e.layer);
    }
    if (groupRef.current && map.hasLayer(groupRef.current) && newlyInside.length > 0) {
      newlyInside.forEach((l) => l.bringToFront());
      // Lines share the points canvas: keep every point above every line.
      restackPoints(map);
    }
  }, [insideIds, onImagery, map, lines]);

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

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    if (visible && !map.hasLayer(g)) {
      g.addTo(map);
      for (const e of entriesRef.current) if (e.inside) e.layer.bringToFront();
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
}: {
  substations: Substation[];
  result: ScanResult | null;
  visible: boolean;
}) {
  const map = useMap();
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
        radius: 2,
        stroke: false,
        fillColor: MAP_COLORS.gray,
        fillOpacity: 0.6,
        bubblingMouseEvents: false,
      });
      layer.bindTooltip(() => substationTooltip(s), { direction: "top", offset: [0, -4] });
      bindReportPopup(layer, () => substationPopup(s), { kind: "substation", substation: s });
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
  }, [map, substations]);

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
}: {
  plants: Plant[];
  result: ScanResult | null;
  visible: boolean;
}) {
  const map = useMap();
  const groupRef = useRef<L.FeatureGroup | null>(null);
  const entriesRef = useRef<{ p: Plant; layer: L.CircleMarker; inside: boolean }[]>([]);
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
      bindReportPopup(layer, () => plantPopup(p), { kind: "plant", plant: p });
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
  }, [map, plants]);

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
