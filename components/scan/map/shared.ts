/**
 * Math and GeoJSON shared by the 2D and 3D maps.
 *
 * Everything here is metric-derived from the same numbers the 2D map draws
 * (MW, kV, miles), so the 3D blocks read as the same dataset seen in
 * perspective rather than as a second, unrelated visualisation.
 */

import { CATEGORY_COLORS, FUEL_CATEGORY, FUEL_LABELS } from "@/lib/scan/colors";
import { lineWeight } from "@/lib/scan";
import { substationName } from "@/lib/scan/labels";
import type {
  FuelKey,
  GenEvent,
  Line,
  Plant,
  ScanArea,
  ScanResult,
  Substation,
} from "@/lib/scan";

export const MI_PER_DEG_LAT = 69.04;

export type Ring = [number, number][];

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Ring[];
}

export interface LineStringGeometry {
  type: "LineString";
  coordinates: Ring;
}

export interface PointGeometry {
  type: "Point";
  coordinates: [number, number];
}

export interface Feature<G, P> {
  type: "Feature";
  geometry: G;
  properties: P;
}

export interface FeatureCollection<G, P> {
  type: "FeatureCollection";
  features: Feature<G, P>[];
}

export const EMPTY_COLLECTION: FeatureCollection<PolygonGeometry, Record<string, never>> = {
  type: "FeatureCollection",
  features: [],
};

/* ---- geometry ------------------------------------------------------------- */

/** A near-geodesic circle: constant miles, corrected for the latitude stretch. */
export function ringAround(lat: number, lon: number, radiusMi: number, segments = 160): Ring {
  const dLat = radiusMi / MI_PER_DEG_LAT;
  const dLon = radiusMi / (MI_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  const ring: Ring = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = (i / segments) * Math.PI * 2;
    ring.push([lon + Math.cos(t) * dLon, lat + Math.sin(t) * dLat]);
  }
  return ring;
}

/** A square footprint, in miles, before Mercator sees it. */
export function footprintRing(lat: number, lon: number, halfMi: number): Ring {
  const dLat = halfMi / MI_PER_DEG_LAT;
  const dLon = halfMi / (MI_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return [
    [lon - dLon, lat - dLat],
    [lon + dLon, lat - dLat],
    [lon + dLon, lat + dLat],
    [lon - dLon, lat + dLat],
    [lon - dLon, lat - dLat],
  ];
}

export function scanCircleGeoJSON(area: ScanArea): FeatureCollection<PolygonGeometry, { kind: string }> {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ringAround(area.lat, area.lon, area.radius_mi)] },
        properties: { kind: "scan" },
      },
    ],
  };
}

export function coverageGeoJSON(
  lat: number,
  lon: number,
  radiusMi: number,
): FeatureCollection<PolygonGeometry, { kind: string }> {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ringAround(lat, lon, radiusMi, 320)] },
        properties: { kind: "coverage" },
      },
    ],
  };
}

/* ---- 3D block sizing ------------------------------------------------------ */

/**
 * Height in metres. Square-root so a 4× bigger plant is 2× taller and small
 * plants stay visible; capped so one gigawatt plant cannot cover the range.
 */
/**
 * Screen-space disc radius for a plant, in pixels. Scaled by square root of
 * nameplate MW so a 20 MW site reads as a sixth of a 1,700 MW one instead of
 * vanishing. Nothing here claims to be a real footprint: a plant's actual site
 * boundary is not in the public layer, so a disc on its coordinate is honest
 * and a sized rectangle at 100-mile scale is not.
 */
export function plantDiscRadius(mw: number): number {
  return Math.min(15, 3.5 + Math.sqrt(Math.max(0, mw)) / 2.4);
}

export function substationBlockHeight(kv: number | null): number {
  if (kv === null || !Number.isFinite(kv)) return 45;
  if (kv >= 500) return 210;
  if (kv >= 220) return 150;
  if (kv >= 115) return 105;
  if (kv > 0) return 70;
  return 45;
}

export const SUBSTATION_HALF_MI = 0.075;

export function eventBlockHeight(mw: number): number {
  return Math.min(1800, Math.round(60 + Math.sqrt(Math.max(0, mw)) * 45));
}

export function eventBlockHalfMi(mw: number): number {
  return Math.min(0.9, 0.2 + Math.sqrt(Math.max(0, mw)) * 0.03);
}

export function fuelColor(fuel: FuelKey): string {
  return CATEGORY_COLORS[FUEL_CATEGORY[fuel]] ?? CATEGORY_COLORS.other;
}

/* ---- GeoJSON builders ----------------------------------------------------- */

export interface PlantProps extends Record<string, string | number | boolean> {
  code: number;
  name: string;
  mw: number;
  fuel: string;
  color: string;
  /** Screen-space disc radius in px, from nameplate MW. */
  radius: number;
  inside: boolean;
}

export function plantsGeoJSON(
  plants: Plant[],
  insideCodes: Set<number>,
): FeatureCollection<PointGeometry, PlantProps> {
  return {
    type: "FeatureCollection",
    features: plants.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: {
        code: p.plant_code,
        name: p.plant_name,
        mw: Math.round(p.nameplate_mw * 10) / 10,
        fuel: p.primary_source,
        color: fuelColor(p.primary_source),
        radius: Math.round(plantDiscRadius(p.nameplate_mw) * 10) / 10,
        inside: insideCodes.has(p.plant_code),
      },
    })),
  };
}

export interface LineProps extends Record<string, string | number | boolean> {
  id: number;
  kv: number;
  weight: number;
  inside: boolean;
}

export function linesGeoJSON(
  lines: Line[],
  insideIds: Set<number>,
): FeatureCollection<LineStringGeometry, LineProps> {
  return {
    type: "FeatureCollection",
    features: lines.map((l) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: l.coords.map(([lat, lon]) => [lon, lat] as [number, number]),
      },
      properties: {
        id: l.osm_id,
        kv: l.voltage_kv ?? 0,
        weight: lineWeight(l.voltage_kv),
        inside: insideIds.has(l.osm_id),
      },
    })),
  };
}

export interface SubstationProps extends Record<string, string | number | boolean> {
  /** osm_id, for looking the substation back up on hover/click. */
  id: string;
  name: string;
  kv: number;
  operator: string;
  height: number;
  inside: boolean;
}

export function substationsGeoJSON(
  substations: Substation[],
  insideIds: Set<string>,
): FeatureCollection<PolygonGeometry, SubstationProps> {
  return {
    type: "FeatureCollection",
    features: substations.map((s) => ({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [footprintRing(s.lat, s.lon, SUBSTATION_HALF_MI)],
      },
      properties: {
        id: s.osm_id,
        name: substationName(s),
        kv: s.voltage_kv ?? 0,
        operator: s.operator ?? "",
        height: substationBlockHeight(s.voltage_kv),
        inside: insideIds.has(s.osm_id),
      },
    })),
  };
}

export interface EventProps extends Record<string, string | number | boolean> {
  name: string;
  kind: string;
  mw: number;
  height: number;
  color: string;
}

export function eventsGeoJSON(events: GenEvent[]): FeatureCollection<PolygonGeometry, EventProps> {
  return {
    type: "FeatureCollection",
    features: events.map((e) => ({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [footprintRing(e.lat, e.lon, eventBlockHalfMi(e.mw))],
      },
      properties: {
        name: e.plant_name,
        kind: e.kind,
        mw: Math.round(e.mw * 10) / 10,
        height: eventBlockHeight(e.mw),
        color: e.kind === "retired" ? "#8b96a3" : "#d97706",
      },
    })),
  };
}

/* ---- tooltips ------------------------------------------------------------- */

export function esc(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const fmtMw = (mw: number) =>
  mw >= 100 ? Math.round(mw).toLocaleString("en-US") : mw >= 10 ? mw.toFixed(0) : mw.toFixed(1);

export function fuelText(fuel: string): string {
  const label = FUEL_LABELS[fuel as FuelKey] ?? fuel;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** Popup body, shaped like the 2D tooltips so the two views read the same. */
export function tipHtml(title: string, rows: string[], source: string): string {
  return `<div class="gs-tip-title">${esc(title)}</div>${rows
    .map((row) => `<div class="gs-tip-row">${row}</div>`)
    .join("")}<div class="gs-tip-src">${source}</div>`;
}

export function plantTip(p: Plant): string {
  return tipHtml(
    p.plant_name,
    [
      `${fmtMw(p.nameplate_mw)} MW · ${esc(fuelText(p.primary_source))}`,
      p.capacity_weighted_age_years != null
        ? `Capacity-weighted age ${Math.round(p.capacity_weighted_age_years)} yr`
        : "Age not reported",
    ],
    `${p.city ? `${esc(p.city)}. ` : ""}Source: EIA-860 2025`,
  );
}

/* ---- label --------------------------------------------------------------- */

export function formatRadius(radius: number): string {
  return Number.isInteger(radius) ? String(radius) : radius.toFixed(1);
}

/** The 2D map's scan chip, so 3D shows exactly the same sentence. */
export function scanLabelText(area: ScanArea, result: ScanResult | null): string {
  if (!result) return `${formatRadius(area.radius_mi)} mi`;
  const count = result.totals.plant_count;
  return `${formatRadius(area.radius_mi)} mi · ${count.toLocaleString("en-US")} plant${
    count === 1 ? "" : "s"
  } · ${Math.round(result.totals.line_miles).toLocaleString("en-US")} mi of lines`;
}
