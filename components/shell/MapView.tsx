"use client";

import * as maplibregl from "maplibre-gl";
import { setWorkerUrl, type Map as GLMap, type GeoJSONSource, type MapOptions } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Feature, FeatureCollection, Geometry, Point } from "geojson";
import type { FacilityFeature, PowerFlow, SimResult } from "@/lib/types";
import type { RiskEntry } from "@/lib/risk";
import type { NicheCase } from "@/lib/niche";
import { basemapById, type BasemapId } from "@/lib/basemaps";
import { loadPlants, loadSubstations, loadTransmission, type LayerVisibility, type PlantFeature, type SubstationFeature, type TransmissionFeature } from "@/lib/gridLayers";
import type { CorridorSelection, MapController } from "./mapTypes";
import LeafletMapView from "./LeafletMapView";

setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString());

interface Props {
  nodes: FacilityFeature[]; flows: PowerFlow[]; risks: Record<string, RiskEntry>; sims: Record<string, SimResult>;
  selectedId: string | null; heatwave: boolean; view3d: boolean; bounds: [[number, number], [number, number]];
  center: [number, number]; radiusMiles: number; layers: LayerVisibility; nicheCases: NicheCase[];
  selectedNicheId: string | null; onSelect: (id: string) => void; onSelectNiche: (id: string) => void;
  selectedCorridorId: string | null; onSelectCorridor: (corridor: CorridorSelection) => void;
  onMapReady?: (map: MapController) => void; basemap: BasemapId; scanMode: boolean;
  scan: { lat: number; lon: number; radius_mi: number } | null; onScanPoint: (lat: number, lon: number) => void;
}

type PropsWithFallback = Props & { onFallback: () => void };
type PropsRecord = Record<string, string | number | boolean>;
type FC = FeatureCollection<Geometry, PropsRecord>;

const EMPTY: FC = { type: "FeatureCollection", features: [] };
const SOURCE_IDS = ["gs-context", "gs-transmission", "gs-substations", "gs-plants", "gs-flows", "gs-facilities", "gs-extrusions", "gs-niches", "gs-scan"] as const;

function circle(lon: number, lat: number, miles: number): Feature {
  const coords: [number, number][] = [];
  const radius = miles * 1609.344;
  for (let i = 0; i <= 96; i++) {
    const bearing = (i / 96) * Math.PI * 2;
    const angular = radius / 6371008.8;
    const lat1 = (lat * Math.PI) / 180;
    const lon1 = (lon * Math.PI) / 180;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
    const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
    coords.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } };
}

function fc(features: Feature[]): FC { return { type: "FeatureCollection", features: features as Feature<Geometry, PropsRecord>[] }; }
function point(lon: number, lat: number, properties: PropsRecord = {}): Feature<Point, PropsRecord> {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: [lon, lat] } };
}

function styleFor(basemap: BasemapId) {
  const definition = basemapById(basemap);
  return {
    version: 8 as const,
    sources: { base: { type: "raster" as const, tiles: [definition.url], tileSize: 256, maxzoom: definition.maxNativeZoom, attribution: "Tiles © Esri" } },
    layers: [{ id: "base-raster", type: "raster" as const, source: "base", paint: { "raster-opacity": basemap === "dark" ? 0.95 : 1, "raster-brightness-max": 0.95 } }],
  };
}

function addSource(map: GLMap, id: string) { if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: EMPTY }); }
function setData(map: GLMap, id: string, data: FC) { (map.getSource(id) as GeoJSONSource | undefined)?.setData(data); }

function NativeMap(props: PropsWithFallback) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GLMap | null>(null);
  const readyRef = useRef(props.onMapReady);
  const scanModeRef = useRef(props.scanMode);
  const scanPointRef = useRef(props.onScanPoint);
  const sourcesRef = useRef<{ context: FC; scan: FC; facilities: FC; extrusions: FC; flows: FC; plants: FC; substations: FC; transmission: FC; niches: FC } | null>(null);
  const [plants, setPlants] = useState<PlantFeature[]>([]);
  const [lines, setLines] = useState<TransmissionFeature[]>([]);
  const [substations, setSubstations] = useState<SubstationFeature[]>([]);
  readyRef.current = props.onMapReady;
  scanModeRef.current = props.scanMode;
  scanPointRef.current = props.onScanPoint;

  const sources = useMemo(() => {
    const features = props.nodes.map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      const risk = props.risks[f.properties.id];
      const sim = props.sims[f.properties.id];
      return point(lon, lat, { id: f.properties.id, name: f.properties.name, color: risk?.color ?? "#38d6c4", size: Math.min(20, 7 + f.properties.infrastructure.nameplate_draw_mw / 10), height: 25 + (sim?.effective_draw_mw ?? 0) * 4 });
    });
    const extrusionFeatures = props.nodes.map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      const polygon = circle(lon, lat, 0.025);
      const sim = props.sims[f.properties.id];
      polygon.properties = { id: f.properties.id, color: props.risks[f.properties.id]?.color ?? "#38d6c4", height: Math.min(220, 22 + (sim?.effective_draw_mw ?? 0) * 0.08) };
      return polygon;
    });
    const flowFeatures: Feature[] = props.flows.flatMap((flow) => {
      const from = props.nodes.find((f) => f.properties.id === flow.from)?.geometry.coordinates;
      const to = props.nodes.find((f) => f.properties.id === flow.to)?.geometry.coordinates;
      return from && to ? [{ type: "Feature", properties: { label: flow.label, mva: flow.mva }, geometry: { type: "LineString", coordinates: [from, to] } }] : [];
    });
    const context = circle(props.center[1], props.center[0], props.radiusMiles);
    const scanFeature = props.scan ? circle(props.scan.lon, props.scan.lat, props.scan.radius_mi) : null;
    const plantFeatures = plants.map((f) => point(f.geometry.coordinates[0], f.geometry.coordinates[1], { color: sourceColor(f.properties.primary_source), radius: Math.max(2.5, Math.min(14, Math.sqrt(f.properties.nameplate_mw) * 0.42)), name: f.properties.plant_name, mw: f.properties.nameplate_mw }));
    const subFeatures = substations.map((f) => point(f.geometry.coordinates[0], f.geometry.coordinates[1], { name: f.properties.name ?? "", voltage: f.properties.voltage_kv ?? 0 }));
    const lineFeatures: Feature[] = lines.map((f, index) => ({ type: "Feature", properties: { voltage: f.properties.voltage_kv ?? 0, corridorId: String(f.properties.osm_id ?? `${index}-${f.geometry.coordinates[0]?.join(",")}`) }, geometry: f.geometry }));
    const niches = props.nicheCases.map((f) => point(f.location.lon, f.location.lat, { id: f.id, title: f.title, category: f.category }));
    return { context: fc([context]), scan: fc(scanFeature ? [scanFeature] : []), facilities: fc(features), extrusions: fc(extrusionFeatures), flows: fc(flowFeatures), plants: fc(plantFeatures), substations: fc(subFeatures), transmission: fc(lineFeatures), niches: fc(niches) };
  }, [props.nodes, props.flows, props.risks, props.sims, props.center, props.radiusMiles, props.scan, props.nicheCases, plants, lines, substations]);
  sourcesRef.current = sources;

  useEffect(() => {
    let alive = true;
    if (props.layers.plants) loadPlants().then((v) => alive && setPlants(v.features)).catch(() => alive && setPlants([]));
    if (props.layers.transmission) loadTransmission().then((v) => alive && setLines(v.features)).catch(() => alive && setLines([]));
    if (props.layers.substations) loadSubstations().then((v) => alive && setSubstations(v.features)).catch(() => alive && setSubstations([]));
    return () => { alive = false; };
  }, [props.layers.plants, props.layers.transmission, props.layers.substations]);

  useEffect(() => {
    const container = host.current;
    if (!container || mapRef.current) return;
    let map: GLMap;
    try {
      const options: MapOptions = { container, style: styleFor(props.basemap), center: [props.center[1], props.center[0]], zoom: 9, pitch: props.view3d ? 50 : 0, bearing: props.view3d ? -10 : 0, maxPitch: 65, attributionControl: false, canvasContextAttributes: { antialias: true } };
      map = new maplibregl.Map(options);
    } catch {
      props.onFallback(); return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("load", () => {
      if (!aliveRef.current) return;
      for (const id of SOURCE_IDS) addSource(map, id);
      map.addLayer({ id: "gs-context-fill", type: "fill", source: "gs-context", paint: { "fill-color": "#38d6c4", "fill-opacity": 0.035 } });
      map.addLayer({ id: "gs-context-line", type: "line", source: "gs-context", paint: { "line-color": "#38d6c4", "line-width": 1, "line-opacity": 0.55, "line-dasharray": [2, 3] } });
      map.addLayer({ id: "gs-transmission-line", type: "line", source: "gs-transmission", layout: { visibility: props.layers.transmission ? "visible" : "none" }, paint: { "line-color": ["case", ["==", ["get", "corridorId"], props.selectedCorridorId ?? ""], "#f5c66b", "#9aa8bb"], "line-opacity": ["case", ["==", ["get", "corridorId"], props.selectedCorridorId ?? ""], 1, 0.48], "line-width": ["case", ["==", ["get", "corridorId"], props.selectedCorridorId ?? ""], 5, ["interpolate", ["linear"], ["get", "voltage"], 0, 0.7, 138, 1.25, 230, 2, 500, 3]] } });
      map.addLayer({ id: "gs-flow-lines", type: "line", source: "gs-flows", paint: { "line-color": props.heatwave ? "#ffb020" : "#38d6c4", "line-width": 1.5, "line-opacity": 0.65, "line-dasharray": [2, 2] } });
      map.addLayer({ id: "gs-facilities", type: "circle", source: "gs-facilities", layout: { visibility: props.layers.loadCenters ? "visible" : "none" }, paint: { "circle-radius": ["get", "size"], "circle-color": ["get", "color"], "circle-stroke-color": "#eef8ff", "circle-stroke-width": 1, "circle-opacity": 0.92, "circle-pitch-alignment": "map" } });
      map.addLayer({ id: "gs-facility-extrusions", type: "circle", source: "gs-facilities", layout: { visibility: props.view3d && props.layers.loadCenters ? "visible" : "none" }, paint: { "circle-radius": ["+", ["get", "size"], 3], "circle-color": ["get", "color"], "circle-opacity": 0.32, "circle-translate": [0, -18], "circle-pitch-alignment": "map" } });
      map.addLayer({ id: "gs-facility-columns", type: "fill-extrusion", source: "gs-extrusions", layout: { visibility: props.view3d && props.layers.loadCenters ? "visible" : "none" }, paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "height"], "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.82, "fill-extrusion-vertical-gradient": true } });
      map.addLayer({ id: "gs-plants", type: "circle", source: "gs-plants", layout: { visibility: props.layers.plants ? "visible" : "none" }, paint: { "circle-radius": ["get", "radius"], "circle-color": ["get", "color"], "circle-stroke-color": "#0b1015", "circle-stroke-width": 1, "circle-opacity": 0.9 } });
      map.addLayer({ id: "gs-substations", type: "circle", source: "gs-substations", layout: { visibility: props.layers.substations ? "visible" : "none" }, paint: { "circle-radius": 2.4, "circle-color": "#8fa0b8", "circle-opacity": 0.55 } });
      map.addLayer({ id: "gs-niches", type: "circle", source: "gs-niches", layout: { visibility: props.layers.nicheCases ? "visible" : "none" }, paint: { "circle-radius": 6, "circle-color": "#f4b957", "circle-stroke-color": "#10151d", "circle-stroke-width": 1.5 } });
      map.addLayer({ id: "gs-scan-fill", type: "fill", source: "gs-scan", paint: { "fill-color": "#f5c66b", "fill-opacity": 0.08 } });
      map.addLayer({ id: "gs-scan-line", type: "line", source: "gs-scan", paint: { "line-color": "#f5c66b", "line-width": 1.5, "line-dasharray": [2, 2] } });
      const current = sourcesRef.current;
      if (current) for (const [id, data] of Object.entries({ "gs-context": current.context, "gs-transmission": current.transmission, "gs-substations": current.substations, "gs-plants": current.plants, "gs-flows": current.flows, "gs-facilities": current.facilities, "gs-extrusions": current.extrusions, "gs-niches": current.niches, "gs-scan": current.scan })) setData(map, id, data);
      map.addSource("gs-terrain", { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], tileSize: 256, encoding: "terrarium", maxzoom: 15 });
      if (props.view3d) map.setTerrain({ source: "gs-terrain", exaggeration: 1.15 });
      map.fitBounds([[props.bounds[0][1], props.bounds[0][0]], [props.bounds[1][1], props.bounds[1][0]]], { padding: 46, duration: 0 });
      const controller: MapController = {
        zoomIn: () => map.zoomIn(), zoomOut: () => map.zoomOut(),
        // MapController accepts a scalar or [vertical, horizontal] padding; MapLibre
        // wants a scalar or an explicit PaddingOptions box.
        fitBounds: (b, options) => {
          const padding = Array.isArray(options?.padding)
            ? { top: options.padding[0], bottom: options.padding[0], left: options.padding[1], right: options.padding[1] }
            : options?.padding;
          map.fitBounds([[b[0][1], b[0][0]], [b[1][1], b[1][0]]], {
            padding,
            duration: options?.animate ? 700 : 0,
          });
        },
        flyTo: (center, zoom, options) => map.flyTo({ center: [center[1], center[0]], zoom, duration: options?.duration ? options.duration * 1000 : 800 }),
        setView: (center, zoom, options) => map.easeTo({ center: [center[1], center[0]], zoom, duration: options?.animate ? 700 : 0 }),
      };
      readyRef.current?.(controller);
    });
    map.on("click", (event) => {
      if (scanModeRef.current) { scanPointRef.current(event.lngLat.lat, event.lngLat.lng); return; }
      const features = map.queryRenderedFeatures(event.point, { layers: ["gs-niches", "gs-facilities", "gs-transmission-line"] });
      const hit = features[0];
      if (hit?.layer.id === "gs-niches" && typeof hit.properties?.id === "string") props.onSelectNiche(hit.properties.id);
      else if (hit?.layer.id === "gs-facilities" && typeof hit.properties?.id === "string") props.onSelect(hit.properties.id);
      else if (hit?.layer.id === "gs-transmission-line" && hit.geometry.type === "LineString") {
        const coordinates = hit.geometry.coordinates as [number, number][];
        props.onSelectCorridor({ id: String(hit.properties?.corridorId ?? ""), coordinates, voltage: Number(hit.properties?.voltage) || null });
      }
    });
    map.on("mouseenter", "gs-transmission-line", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "gs-transmission-line", () => { map.getCanvas().style.cursor = ""; });
    map.on("error", (event) => { if (event.error?.message?.toLowerCase().includes("webgl")) props.onFallback(); });
    return () => { map.remove(); mapRef.current = null; };
  // Initial map construction only. Runtime changes flow through the effects below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  useEffect(() => {
    const map = mapRef.current; if (!map?.isStyleLoaded()) return;
    for (const [id, data] of Object.entries({ "gs-context": sources.context, "gs-transmission": sources.transmission, "gs-substations": sources.substations, "gs-plants": sources.plants, "gs-flows": sources.flows, "gs-facilities": sources.facilities, "gs-extrusions": sources.extrusions, "gs-niches": sources.niches, "gs-scan": sources.scan })) setData(map, id, data);
  }, [sources]);
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    map.setPitch(props.view3d ? 50 : 0); map.setBearing(props.view3d ? -10 : 0);
    if (map.getSource("gs-terrain")) map.setTerrain(props.view3d ? { source: "gs-terrain", exaggeration: 1.15 } : null);
    for (const id of ["gs-facility-extrusions", "gs-facility-columns"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", props.view3d && props.layers.loadCenters ? "visible" : "none");
  }, [props.view3d, props.layers.loadCenters]);
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    for (const [id, visible] of [["gs-transmission-line", props.layers.transmission], ["gs-substations", props.layers.substations], ["gs-plants", props.layers.plants], ["gs-facilities", props.layers.loadCenters], ["gs-niches", props.layers.nicheCases]] as const) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    if (map.getLayer("gs-flow-lines")) map.setPaintProperty("gs-flow-lines", "line-color", props.heatwave ? "#ffb020" : "#38d6c4");
    if (map.getLayer("gs-facilities")) map.setPaintProperty("gs-facilities", "circle-stroke-width", ["case", ["==", ["get", "id"], props.selectedId ?? ""], 3, 1]);
    if (map.getLayer("gs-transmission-line")) {
      map.setPaintProperty("gs-transmission-line", "line-color", ["case", ["==", ["get", "corridorId"], props.selectedCorridorId ?? ""], "#f5c66b", "#9aa8bb"]);
      map.setPaintProperty("gs-transmission-line", "line-opacity", ["case", ["==", ["get", "corridorId"], props.selectedCorridorId ?? ""], 1, 0.48]);
      map.setPaintProperty("gs-transmission-line", "line-width", ["case", ["==", ["get", "corridorId"], props.selectedCorridorId ?? ""], 5, ["interpolate", ["linear"], ["get", "voltage"], 0, 0.7, 138, 1.25, 230, 2, 500, 3]]);
    }
  }, [props.layers, props.heatwave, props.selectedId, props.selectedCorridorId]);
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const base = map.getSource("base") as { setTiles?: (tiles: string[]) => void } | undefined;
    base?.setTiles?.([basemapById(props.basemap).url]);
  }, [props.basemap]);
  return <div ref={host} className="maplibre-host" aria-label="Interactive electrical grid map" />;
}

function sourceColor(source: string): string {
  return ({ natural_gas: "#f28c45", other_gas: "#f28c45", solar: "#f6ce55", battery: "#67dbbd", wind: "#67c6f0", hydro: "#6a9bf2" } as Record<string, string>)[source] ?? "#be8be8";
}

export default function MapView(props: Props) {
  const [fallback, setFallback] = useState(false);
  if (fallback) return <LeafletMapView {...props} />;
  return <NativeMap {...props} onFallback={() => setFallback(true)} />;
}
