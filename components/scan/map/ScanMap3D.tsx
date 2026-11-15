"use client";

/**
 * Google-Earth-style 3D view.
 *
 * MapLibre GL renders the same keyless Esri imagery the 2D map uses, draped
 * over real elevation (AWS Terrain Tiles, Terrarium encoding) with a tilted
 * camera. Every 2D layer has a 3D counterpart: transmission drawn on the
 * terrain, substations and plants as extruded blocks whose height is energy
 * (MW / kV), retired + proposed capacity blocks, the scan circle draped on the
 * terrain, and niche cases as HTML pins.
 */

import {
  AttributionControl,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  ScaleControl,
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type MapMouseEvent,
  type RasterTileSource,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { CENTER, COVERAGE_MI } from "@/lib/scan";
import type { GridData, Line, NicheCase, ScanArea, ScanResult, Substation } from "@/lib/scan";
import { kvLabel, lineName, substationName } from "@/lib/scan/labels";
import type { ReportTarget } from "@/lib/scan/target";
import { basemapById, type BasemapId } from "./basemaps";
import type { LayerVisibility } from "./LayerPicker";
import type { AssetClick } from "./layers";
import {
  EMPTY_COLLECTION,
  MI_PER_DEG_LAT,
  coverageGeoJSON,
  esc,
  eventsGeoJSON,
  fuelText,
  linesGeoJSON,
  plantDiscRadius,
  plantTip,
  plantsGeoJSON,
  scanCircleGeoJSON,
  scanLabelText,
  substationsGeoJSON,
  tipHtml,
} from "./shared";
import type { MapFocus } from "./types";

const INITIAL_ZOOM = 10;
const INITIAL_PITCH = 58;
const INITIAL_BEARING = -12;
/** Real relief, nudged just enough that the San Gabriels read at 100-mile scale. */
const TERRAIN_EXAGGERATION = 1.2;

const ACCENT = "#0ea5e9";
const ACCENT_STRONG = "#0284c7";

const DEM_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const DEM_ATTRIBUTION =
  'Terrain &copy; <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> (Mapzen)';

const PLANT_LAYERS = ["gs-plants-out", "gs-plants-in"];
/** Hover and click targets, topmost first: plants, then substations, then lines. */
const HOVER_LAYERS = ["gs-plants-in", "gs-plants-out", "gs-subs", "gs-lines"];
/** Hit slop around the pointer, in px, so thin lines and small dots are easy to hit (2D uses 6). */
const HIT_TOLERANCE = 6;

/** "230 kV · Operator" (either part omitted when missing); null when both are missing. */
function kvOperatorRow(kv: string | null, operator: string | null): string | null {
  const parts = [kv, operator].filter((x): x is string => !!x).map(esc);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function substationTip(s: Substation): string {
  const row = kvOperatorRow(kvLabel(s.voltage_kv, s.kv_inferred), s.operator);
  return tipHtml(substationName(s), row ? [row] : [], "Substation. Source: OpenStreetMap");
}

function lineTip(l: Line): string {
  const row = kvOperatorRow(kvLabel(l.voltage_kv, l.kv_inferred), l.operator);
  return tipHtml(lineName(l), row ? [row] : [], "Power line. Source: OpenStreetMap");
}

/** The selected asset as GeoJSON: a ring for a plant or substation, an overlay for a line. */
function selectedGeoJSON(selected: ReportTarget | null | undefined) {
  if (!selected || selected.kind === "area") return EMPTY_COLLECTION;
  const feature =
    selected.kind === "line"
      ? {
          type: "Feature" as const,
          geometry: {
            type: "LineString" as const,
            coordinates: selected.line.coords.map(([lat, lon]) => [lon, lat] as [number, number]),
          },
          properties: { radius: 0 },
        }
      : {
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates:
              selected.kind === "plant"
                ? ([selected.plant.lon, selected.plant.lat] as [number, number])
                : ([selected.substation.lon, selected.substation.lat] as [number, number]),
          },
          properties: {
            radius: selected.kind === "plant" ? plantDiscRadius(selected.plant.nameplate_mw) + 3 : 7,
          },
        };
  return { type: "FeatureCollection" as const, features: [feature] };
}

function buildStyle(basemap: BasemapId): StyleSpecification {
  const bm = basemapById(basemap);
  const sources: StyleSpecification["sources"] = {
    drape: {
      type: "raster",
      tiles: [bm.url],
      tileSize: 256,
      maxzoom: bm.maxNativeZoom,
      attribution: bm.attribution,
    },
    dem: {
      type: "raster-dem",
      tiles: [DEM_TILES],
      tileSize: 256,
      maxzoom: 15,
      encoding: "terrarium",
      attribution: DEM_ATTRIBUTION,
    },
    // MapLibre wants a separate DEM source for shading; sharing one with the
    // terrain drops detail, so the hillshade gets its own cache.
    demShade: {
      type: "raster-dem",
      tiles: [DEM_TILES],
      tileSize: 256,
      maxzoom: 15,
      encoding: "terrarium",
    },
  };

  const layers: StyleSpecification["layers"] = [
    // Above the horizon MapLibre shows this; it stands in for the sky haze the
    // tilted camera would otherwise cut to black.
    { id: "backdrop", type: "background", paint: { "background-color": "#dde8f1" } },
    { id: "drape", type: "raster", source: "drape" },
    {
      id: "relief",
      type: "hillshade",
      source: "demShade",
      paint: {
        "hillshade-exaggeration": 0.32,
        "hillshade-shadow-color": "#3c4b58",
        "hillshade-highlight-color": "#ffffff",
        "hillshade-accent-color": "#8fa3b5",
      },
    },
  ];

  if (bm.labelsUrl) {
    sources.labels = {
      type: "raster",
      tiles: [bm.labelsUrl],
      tileSize: 256,
      maxzoom: bm.maxNativeZoom,
    };
    layers.push({ id: "labels", type: "raster", source: "labels", paint: { "raster-opacity": 0.95 } });
  }

  return {
    version: 8,
    name: "GridSentinel 3D",
    sources,
    layers,
    terrain: { source: "dem", exaggeration: TERRAIN_EXAGGERATION },
  };
}

/** Sources and layers exist once; scans and toggles only push data and visibility. */
function installLayers(map: MapLibreMap) {
  map.addSource("gs-coverage", {
    type: "geojson",
    data: coverageGeoJSON(CENTER.lat, CENTER.lon, COVERAGE_MI),
  });
  map.addLayer({
    id: "gs-coverage-line",
    type: "line",
    source: "gs-coverage",
    paint: { "line-color": ACCENT, "line-width": 1.6, "line-opacity": 0.85, "line-dasharray": [3, 3] },
  });

  map.addSource("gs-scan", { type: "geojson", data: EMPTY_COLLECTION });
  map.addLayer({
    id: "gs-scan-fill",
    type: "fill",
    source: "gs-scan",
    paint: { "fill-color": ACCENT, "fill-opacity": 0.1 },
  });
  map.addLayer({
    id: "gs-scan-line",
    type: "line",
    source: "gs-scan",
    paint: { "line-color": ACCENT, "line-width": 2, "line-opacity": 1 },
  });

  map.addSource("gs-lines", { type: "geojson", data: EMPTY_COLLECTION });
  map.addLayer({
    id: "gs-lines-glow",
    type: "line",
    source: "gs-lines",
    filter: ["==", ["get", "inside"], true],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ACCENT,
      "line-opacity": 0.2,
      "line-blur": 2.5,
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 12, 8, 16, 15],
    },
  });
  map.addLayer({
    id: "gs-lines",
    type: "line",
    source: "gs-lines",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      // In-scan circuits take the accent; everything else stays contextual grey.
      "line-color": ["case", ["==", ["get", "inside"], true], ACCENT_STRONG, "#7c8794"],
      "line-opacity": ["case", ["==", ["get", "inside"], true], 0.95, 0.55],
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        8,
        ["*", 0.6, ["get", "weight"]],
        12,
        ["*", 1.8, ["get", "weight"]],
        16,
        ["*", 4, ["get", "weight"]],
      ],
    },
  });

  map.addSource("gs-subs", { type: "geojson", data: EMPTY_COLLECTION });
  map.addLayer({
    id: "gs-subs",
    type: "fill-extrusion",
    source: "gs-subs",
    paint: {
      "fill-extrusion-color": ["case", ["==", ["get", "inside"], true], ACCENT_STRONG, "#8b96a3"],
      "fill-extrusion-height": ["get", "height"],
      "fill-extrusion-opacity": 0.78,
      "fill-extrusion-vertical-gradient": true,
    },
  });

  // Plants are discs on their own coordinate, sized by nameplate MW, not
  // footprints: the public layer has no site boundary, and a rectangle at
  // 100-mile scale put a block somewhere the plant is not. Inside the scan the
  // disc gets an accent halo and ring, so it reads as part of the same scan as
  // the lines and the circle.
  map.addSource("gs-plants", { type: "geojson", data: EMPTY_COLLECTION });
  map.addLayer({
    id: "gs-plants-halo",
    type: "circle",
    source: "gs-plants",
    filter: ["==", ["get", "inside"], true],
    paint: {
      "circle-radius": ["+", ["get", "radius"], 5],
      "circle-color": ACCENT,
      "circle-opacity": 0.18,
      "circle-blur": 0.6,
    },
  });
  map.addLayer({
    id: "gs-plants-out",
    type: "circle",
    source: "gs-plants",
    filter: ["==", ["get", "inside"], false],
    paint: {
      "circle-radius": ["get", "radius"],
      "circle-color": ["get", "color"],
      "circle-opacity": 0.5,
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff",
    },
  });
  map.addLayer({
    id: "gs-plants-in",
    type: "circle",
    source: "gs-plants",
    filter: ["==", ["get", "inside"], true],
    paint: {
      "circle-radius": ["get", "radius"],
      "circle-color": ["get", "color"],
      "circle-opacity": 0.95,
      "circle-stroke-width": 2,
      "circle-stroke-color": ACCENT_STRONG,
    },
  });

  map.addSource("gs-events", { type: "geojson", data: EMPTY_COLLECTION });
  map.addLayer({
    id: "gs-events",
    type: "fill-extrusion",
    source: "gs-events",
    paint: {
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-height": ["get", "height"],
      "fill-extrusion-opacity": 0.6,
      "fill-extrusion-vertical-gradient": true,
    },
  });

  // Selected asset (clicked on the map or picked in Top plants): ring or line overlay, on top.
  map.addSource("gs-selected", { type: "geojson", data: EMPTY_COLLECTION });
  map.addLayer({
    id: "gs-selected-line",
    type: "line",
    source: "gs-selected",
    filter: ["==", ["geometry-type"], "LineString"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ACCENT_STRONG,
      "line-opacity": 1,
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 12, 7, 16, 12],
    },
  });
  map.addLayer({
    id: "gs-selected-ring",
    type: "circle",
    source: "gs-selected",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": ["get", "radius"],
      "circle-opacity": 0,
      "circle-stroke-width": 2,
      "circle-stroke-color": ACCENT_STRONG,
    },
  });
}

function markerHost(html: string, className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  el.innerHTML = html;
  return el;
}

interface ScanMap3DProps {
  data: GridData;
  area: ScanArea;
  result: ScanResult | null;
  selectedCaseId: string | null;
  focus: MapFocus | null;
  layers: LayerVisibility;
  basemap: BasemapId;
  /** The selected asset, ringed on the terrain. */
  selected?: ReportTarget | null;
  /** Plain terrain click: scan there. */
  onScan: (lat: number, lon: number) => void;
  /** Dot or line click: scan there and select it. Without it, a plant click only flies to it. */
  onAssetClick?: AssetClick;
  onFocus: (lat: number, lon: number) => void;
  onSelectCase: (c: NicheCase) => void;
}

export default function ScanMap3D({
  data,
  area,
  result,
  selectedCaseId,
  focus,
  layers,
  basemap,
  selected = null,
  onScan,
  onAssetClick,
  onFocus,
  onSelectCase,
}: ScanMap3DProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const hoverKeyRef = useRef<string>("");
  const caseMarkersRef = useRef<Marker[]>([]);
  const scanLabelRef = useRef<Marker | null>(null);
  const homeRef = useRef<Marker | null>(null);
  const [ready, setReady] = useState(false);

  const handlers = useRef({ onScan, onAssetClick, onFocus, onSelectCase });
  handlers.current = { onScan, onAssetClick, onFocus, onSelectCase };

  const plantsByCode = useMemo(
    () => new Map(data.plants.map((plant) => [plant.plant_code, plant])),
    [data.plants],
  );
  const plantsByCodeRef = useRef(plantsByCode);
  plantsByCodeRef.current = plantsByCode;
  const lookup = useMemo(
    () => ({
      subs: new Map(data.substations.map((s) => [s.osm_id, s])),
      lines: new Map(data.lines.map((l) => [l.osm_id, l])),
    }),
    [data.substations, data.lines],
  );
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;

  /* ---- map lifecycle ------------------------------------------------------ */

  useEffect(() => {
    const host = hostRef.current;
    if (!host || mapRef.current) return;

    const map = new MapLibreMap({
      container: host,
      style: buildStyle(basemap),
      center: [CENTER.lon, CENTER.lat],
      zoom: INITIAL_ZOOM,
      pitch: INITIAL_PITCH,
      bearing: INITIAL_BEARING,
      minZoom: 6,
      // Street level needs to overscale the imagery; terrain is fine to 20.
      maxZoom: 20,
      maxPitch: 85,
      attributionControl: false,
      fadeDuration: 0,
      dragRotate: true,
      pitchWithRotate: true,
    });
    mapRef.current = map;

    map.addControl(new AttributionControl({ compact: true }), "bottom-left");
    map.addControl(new NavigationControl({ visualizePitch: true, showCompass: true }), "top-right");
    map.addControl(new ScaleControl({ maxWidth: 120, unit: "imperial" }), "bottom-right");

    const popup = new Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 14,
      maxWidth: "300px",
      className: "gs-3d-popup",
    });
    popupRef.current = popup;

    const featureAt = (event: MapMouseEvent): MapGeoJSONFeature | undefined => {
      // Before the style's load event the data layers are not installed yet.
      if (!map.getLayer("gs-plants-in")) return undefined;
      const { x, y } = event.point;
      const hits = map.queryRenderedFeatures(
        [
          [x - HIT_TOLERANCE, y - HIT_TOLERANCE],
          [x + HIT_TOLERANCE, y + HIT_TOLERANCE],
        ],
        { layers: HOVER_LAYERS },
      );
      // Prefer a dot over a line under the same pointer.
      return hits.find((h) => h.layer?.id !== "gs-lines") ?? hits[0];
    };

    const onMove = (event: MapMouseEvent) => {
      const hit = featureAt(event);
      const canvas = map.getCanvas();
      if (!hit) {
        if (hoverKeyRef.current) {
          hoverKeyRef.current = "";
          popup.remove();
        }
        canvas.style.cursor = "crosshair";
        return;
      }
      canvas.style.cursor = "pointer";
      const props = hit.properties;
      const key = `${hit.layer?.id}:${props.code ?? props.id ?? props.name}`;
      if (key === hoverKeyRef.current) {
        popup.setLngLat(event.lngLat);
        return;
      }
      hoverKeyRef.current = key;
      const plant = plantsByCodeRef.current.get(Number(props.code));
      const sub = hit.layer?.id === "gs-subs" ? lookupRef.current.subs.get(String(props.id)) : undefined;
      const line = hit.layer?.id === "gs-lines" ? lookupRef.current.lines.get(Number(props.id)) : undefined;
      const html = sub
        ? substationTip(sub)
        : line
          ? lineTip(line)
          : plant
            ? plantTip(plant)
            : tipHtml(
                String(props.name),
                [`${props.mw} MW · ${esc(fuelText(String(props.fuel)))}`],
                "Source: EIA-860 2025",
              );
      popup.setLngLat(event.lngLat).setHTML(html).addTo(map);
    };

    const onLeave = () => {
      hoverKeyRef.current = "";
      popup.remove();
      map.getCanvas().style.cursor = "crosshair";
    };

    map.on("load", () => {
      installLayers(map);
      setReady(true);
    });

    map.on("click", (event: MapMouseEvent) => {
      const { onAssetClick: pick, onFocus: fly, onScan: scan } = handlers.current;
      const hit = featureAt(event);
      const id = hit?.layer?.id;
      const plant =
        id && PLANT_LAYERS.includes(id) ? plantsByCodeRef.current.get(Number(hit.properties.code)) : undefined;
      if (plant) {
        // Scan at the plant and select it, then fly there.
        pick?.({ kind: "plant", plant }, plant.lat, plant.lon);
        fly(plant.lat, plant.lon);
        return;
      }
      if (pick && id === "gs-subs") {
        const substation = lookupRef.current.subs.get(String(hit?.properties.id));
        if (substation) {
          pick({ kind: "substation", substation }, substation.lat, substation.lon);
          return;
        }
      }
      if (pick && id === "gs-lines") {
        const line = lookupRef.current.lines.get(Number(hit?.properties.id));
        if (line) {
          // Scan where the line was clicked (not its midpoint).
          pick({ kind: "line", line }, event.lngLat.lat, event.lngLat.lng);
          return;
        }
      }
      scan(event.lngLat.lat, event.lngLat.lng);
    });

    map.on("mousemove", onMove);
    map.on("mouseout", onLeave);

    // Terrain tiles have gaps below z6 and above z15; those are expected gaps,
    // not failures, so they stay out of the console.
    map.on("error", (event) => {
      const status = (event.error as { status?: number } | undefined)?.status;
      const message = (event.error as { message?: string } | undefined)?.message ?? String(event.error);
      if (status !== 404) console.warn("3D map error", message);
    });

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(host);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      popupRef.current = null;
      caseMarkersRef.current = [];
      scanLabelRef.current = null;
      homeRef.current = null;
      setReady(false);
    };
    // The map is created once; basemap changes swap tiles in their own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- data --------------------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const insidePlants = new Set((result?.plants ?? []).map((p) => p.plant_code));
    const insideLines = new Set((result?.lines ?? []).map((l) => l.osm_id));
    const insideSubs = new Set((result?.substations ?? []).map((s) => s.osm_id));

    (map.getSource("gs-plants") as GeoJSONSource | undefined)?.setData(
      plantsGeoJSON(data.plants, insidePlants),
    );
    (map.getSource("gs-lines") as GeoJSONSource | undefined)?.setData(
      linesGeoJSON(data.lines, insideLines),
    );
    (map.getSource("gs-subs") as GeoJSONSource | undefined)?.setData(
      substationsGeoJSON(data.substations, insideSubs),
    );
    // Same contract as the 2D event layer: retired and proposed capacity inside
    // the scan circle, nothing when no scan has run.
    (map.getSource("gs-events") as GeoJSONSource | undefined)?.setData(
      eventsGeoJSON(result?.events ?? []),
    );
  }, [ready, data, result]);

  /* ---- scan circle + label ------------------------------------------------ */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("gs-scan") as GeoJSONSource | undefined)?.setData(scanCircleGeoJSON(area));

    const text = scanLabelText(area, result);
    const lonOffset = area.radius_mi / (MI_PER_DEG_LAT * Math.cos((area.lat * Math.PI) / 180));
    if (!scanLabelRef.current) {
      scanLabelRef.current = new Marker({
        element: markerHost(`<span>${esc(text)}</span>`, "gs-3d-scan-label"),
        anchor: "left",
      })
        .setLngLat([area.lon + lonOffset, area.lat])
        .addTo(map);
    } else {
      const el = scanLabelRef.current.getElement();
      const span = el.querySelector("span");
      if (span) span.textContent = text;
      scanLabelRef.current.setLngLat([area.lon + lonOffset, area.lat]);
    }
  }, [ready, area, result]);

  /* ---- layer visibility --------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const set = (ids: string[], visible: boolean) => {
      for (const id of ids) {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
        }
      }
    };
    set(["gs-lines-glow", "gs-lines"], layers.transmission);
    set(["gs-subs"], layers.substations);
    set(PLANT_LAYERS, layers.plants);
    set(["gs-events"], layers.events);
  }, [ready, layers]);

  /* ---- selected asset ----------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("gs-selected") as GeoJSONSource | undefined)?.setData(selectedGeoJSON(selected));
  }, [ready, selected]);

  /* ---- basemap ------------------------------------------------------------ */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const bm = basemapById(basemap);
    (map.getSource("drape") as RasterTileSource | undefined)?.setTiles([bm.url]);

    const hasLabels = Boolean(bm.labelsUrl);
    const labelsLayer = map.getLayer("labels");
    if (!hasLabels) {
      if (labelsLayer) map.removeLayer("labels");
      if (map.getSource("labels")) map.removeSource("labels");
      return;
    }
    if (!map.getSource("labels")) {
      map.addSource("labels", {
        type: "raster",
        tiles: [bm.labelsUrl as string],
        tileSize: 256,
        maxzoom: bm.maxNativeZoom,
      });
    } else {
      (map.getSource("labels") as RasterTileSource).setTiles([bm.labelsUrl as string]);
    }
    if (!map.getLayer("labels")) {
      // Above the imagery, below the energy layers.
      map.addLayer(
        { id: "labels", type: "raster", source: "labels", paint: { "raster-opacity": 0.95 } },
        "gs-coverage-line",
      );
    }
  }, [ready, basemap]);

  /* ---- home pin ----------------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || homeRef.current) return;
    const el = markerHost(
      '<span class="gs-3d-home-dot"></span><span class="gs-3d-home-label"></span>',
      "gs-3d-home",
    );
    const label = el.querySelector(".gs-3d-home-label");
    if (label) label.textContent = CENTER.name;
    homeRef.current = new Marker({ element: el, anchor: "center" })
      .setLngLat([CENTER.lon, CENTER.lat])
      .addTo(map);
  }, [ready]);

  /* ---- niche case pins ---------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const marker of caseMarkersRef.current) marker.remove();
    caseMarkersRef.current = [];
    if (!layers.cases) return;

    for (const nicheCase of data.cases) {
      const selected = nicheCase.id === selectedCaseId;
      const el = markerHost("", `gs-3d-case${selected ? " is-selected" : ""}`);
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-label", nicheCase.title);
      el.title = nicheCase.title;
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        handlers.current.onSelectCase(nicheCase);
      });
      const marker = new Marker({ element: el, anchor: "center" })
        .setLngLat([nicheCase.location.lon, nicheCase.location.lat])
        .addTo(map);
      caseMarkersRef.current.push(marker);
    }
  }, [ready, data.cases, selectedCaseId, layers.cases]);

  /* ---- focuse / fly-to ---------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !focus) return;
    map.flyTo({
      center: [focus.lon, focus.lat],
      zoom: focus.zoom ?? Math.max(map.getZoom(), 11),
      pitch: INITIAL_PITCH,
      duration: 900,
      essential: true,
    });
    // nonce is the trigger: the same point can be requested twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, focus?.nonce]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="gs-3d-host h-full w-full" />

      <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2" style={{ zIndex: 25 }}>
        <div className="rounded-[6px] border border-[#e6e9ee] bg-white/95 px-2.5 py-1 text-[12px] text-[#556070]">
          Drag to orbit · right-drag or ctrl-drag to tilt
        </div>
      </div>

      <button
        type="button"
        onClick={() => {
          const map = mapRef.current;
          if (!map) return;
          map.flyTo({
            center: [area.lon, area.lat],
            zoom: 18.2,
            pitch: 84,
            bearing: map.getBearing(),
            duration: 1400,
            essential: true,
          });
        }}
        className="absolute bottom-28 right-3 rounded-[6px] border border-[#e6e9ee] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#1d2733]"
        style={{ zIndex: 25, boxShadow: "0 1px 3px rgba(16,24,40,.08)" }}
      >
        Street level
      </button>

      <button
        type="button"
        onClick={() => {
          const map = mapRef.current;
          if (!map) return;
          map.easeTo({
            center: [CENTER.lon, CENTER.lat],
            zoom: INITIAL_ZOOM,
            pitch: INITIAL_PITCH,
            bearing: INITIAL_BEARING,
            duration: 800,
          });
        }}
        className="absolute bottom-16 right-3 rounded-[6px] border border-[#e6e9ee] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#1d2733]"
        style={{ zIndex: 25, boxShadow: "0 1px 3px rgba(16,24,40,.08)" }}
      >
        Reset view
      </button>

      <div
        className="pointer-events-none absolute left-3 top-3 rounded-[6px] border border-[#e6e9ee] bg-white/95 px-2.5 py-1 text-[12px] text-[#556070]"
        style={{ zIndex: 25 }}
      >
        3D terrain · disc area = capacity · blue ring = inside this scan
      </div>
    </div>
  );
}
