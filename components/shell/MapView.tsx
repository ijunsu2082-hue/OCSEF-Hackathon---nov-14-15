"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  escapeHtml,
  loadPlants,
  loadSubstations,
  loadTransmission,
  plantRadius,
  sourceClass,
  sourceLabel,
  transmissionWeight,
  type LayerVisibility,
  type PlantFeature,
  type SubstationFeature,
  type TransmissionFeature,
} from "@/lib/gridLayers";
import type { CorridorLoading } from "@/lib/grid";
import type { NicheCase } from "@/lib/niche";
import type { RiskEntry } from "@/lib/risk";
import type { FacilityFeature, PowerFlow, SimResult } from "@/lib/types";

interface MapViewProps {
  nodes: FacilityFeature[];
  flows: PowerFlow[];
  risks: Record<string, RiskEntry>;
  sims: Record<string, SimResult>;
  selectedId: string | null;
  heatwave: boolean;
  view3d: boolean;
  bounds: [[number, number], [number, number]];
  center: [number, number];
  radiusMiles: number;
  layers: LayerVisibility;
  corridors: CorridorLoading[];
  nicheCases: NicheCase[];
  selectedNicheId: string | null;
  onSelect: (id: string) => void;
  onSelectNiche: (id: string) => void;
  onMapReady?: (map: L.Map) => void;
}

export function shortName(name: string): string {
  return name
    .replace(" Generating Station", "")
    .replace(" Power Plant", "")
    .replace(" Switching Station", "")
    .replace(" Substation", "")
    .replace(" Data Center", " DC")
    .replace(" Medical Center", " MC")
    .replace(" High School", " HS")
    .trim();
}

export default function MapView({
  nodes,
  flows,
  risks,
  sims,
  selectedId,
  heatwave,
  view3d,
  bounds,
  center,
  radiusMiles,
  layers,
  corridors,
  nicheCases,
  selectedNicheId,
  onSelect,
  onSelectNiche,
  onMapReady,
}: MapViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerGroupRef = useRef<L.LayerGroup | null>(null);
  const flowGroupRef = useRef<L.LayerGroup | null>(null);
  const contextGroupRef = useRef<L.LayerGroup | null>(null);
  const transmissionGroupRef = useRef<L.LayerGroup | null>(null);
  const substationGroupRef = useRef<L.LayerGroup | null>(null);
  const plantGroupRef = useRef<L.LayerGroup | null>(null);
  const nicheGroupRef = useRef<L.LayerGroup | null>(null);
  const darkLayerRef = useRef<L.TileLayer | null>(null);
  const satLayerRef = useRef<L.TileLayer | null>(null);
  const syncRef = useRef<() => void>(() => undefined);
  const markerElsRef = useRef<{ id: string; el: HTMLElement }[]>([]);
  const nodesRef = useRef(nodes);
  const simsRef = useRef(sims);
  simsRef.current = sims;
  const onSelectRef = useRef(onSelect);
  const onSelectNicheRef = useRef(onSelectNiche);
  const onReadyRef = useRef(onMapReady);
  const firstSelection = useRef(true);
  const [points, setPoints] = useState<Record<string, { x: number; y: number }>>({});

  // Real-grid layers fetch lazily: a layer loads the first time it is switched
  // on, and never again (lib/gridLayers caches the promise per file).
  const [plants, setPlants] = useState<PlantFeature[] | null>(null);
  const [transmission, setTransmission] = useState<TransmissionFeature[] | null>(null);
  const [substations, setSubstations] = useState<SubstationFeature[] | null>(null);

  nodesRef.current = nodes;
  onSelectRef.current = onSelect;
  onSelectNicheRef.current = onSelectNiche;
  onReadyRef.current = onMapReady;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || mapRef.current) return;

    const map = L.map(host, {
      center: [34.05, -118.25],
      zoom: 9,
      zoomControl: false,
      attributionControl: false,
      minZoom: 7,
      maxZoom: 16,
      zoomAnimation: false,
      fadeAnimation: false,
      markerZoomAnimation: false,
    });

    const darkTiles = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, className: "dark-tile" },
    ).addTo(map);

    const satelliteTiles = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, className: "sat-tile" },
    );

    darkLayerRef.current = darkTiles;
    satLayerRef.current = satelliteTiles;

    map.fitBounds(bounds as L.LatLngBoundsExpression, {
      padding: [46, 46],
      animate: false,
    });

    // Draw order (README §4.6): real grid under, load centers above, niche
    // markers on top. Panes make that independent of when each layer loads.
    map.createPane("gs-transmission").style.zIndex = "340";
    map.createPane("gs-substation").style.zIndex = "350";
    map.createPane("gs-plants").style.zIndex = "360";

    contextGroupRef.current = L.layerGroup().addTo(map);
    flowGroupRef.current = L.layerGroup().addTo(map);
    transmissionGroupRef.current = L.layerGroup().addTo(map);
    substationGroupRef.current = L.layerGroup().addTo(map);
    plantGroupRef.current = L.layerGroup().addTo(map);
    markerGroupRef.current = L.layerGroup().addTo(map);
    nicheGroupRef.current = L.layerGroup().addTo(map);

    const sync = () => {
      const next: Record<string, { x: number; y: number }> = {};
      for (const f of nodesRef.current) {
        const [lon, lat] = f.geometry.coordinates;
        const p = map.latLngToContainerPoint([lat, lon]);
        next[f.properties.id] = { x: p.x, y: p.y };
      }
      setPoints(next);
    };

    syncRef.current = sync;
    map.on("move zoom resize viewreset", sync);

    // Selection is resolved against rendered marker positions so it survives
    // the CSS 3D tilt, where Leaflet's own coordinate math no longer matches.
    map.on("click", (event: L.LeafletMouseEvent) => {
      const original = event.originalEvent as MouseEvent;
      if (typeof original.clientX !== "number") return;
      const cx = original.clientX;
      const cy = original.clientY;

      let bestId: string | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const { id, el } of markerElsRef.current) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dx = Math.abs(cx - centerX);
        const dy = cy - centerY;
        const sim = simsRef.current[id];
        const columnHeight = 34 + (sim ? sim.effective_draw_mw * 5.5 : 0);

        const overColumn = dx <= 20 && dy <= 22 && dy >= -(columnHeight + 26);
        const nearBase = Math.hypot(dx, dy) <= 30;
        if (!overColumn && !nearBase) continue;

        const distance = Math.abs(dx) + Math.max(0, Math.abs(dy) - 20);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestId = id;
        }
      }

      if (bestId) onSelectRef.current(bestId);
    });

    sync();

    mapRef.current = map;
    onReadyRef.current?.(map);

    return () => {
      map.off();
      map.remove();
      mapRef.current = null;
      markerGroupRef.current = null;
      flowGroupRef.current = null;
      contextGroupRef.current = null;
      transmissionGroupRef.current = null;
      substationGroupRef.current = null;
      plantGroupRef.current = null;
      nicheGroupRef.current = null;
      darkLayerRef.current = null;
      satLayerRef.current = null;
    };
  }, [bounds]);

  // ---- Real-grid layer fetches ---------------------------------------------

  useEffect(() => {
    if (!layers.transmission || transmission) return;
    let alive = true;
    loadTransmission()
      .then((data) => {
        if (alive) setTransmission(data.features as TransmissionFeature[]);
      })
      .catch(() => {
        if (alive) setTransmission([]);
      });
    return () => {
      alive = false;
    };
  }, [layers.transmission, transmission]);

  useEffect(() => {
    if (!layers.substations || substations) return;
    let alive = true;
    loadSubstations()
      .then((data) => {
        if (alive) setSubstations(data.features as SubstationFeature[]);
      })
      .catch(() => {
        if (alive) setSubstations([]);
      });
    return () => {
      alive = false;
    };
  }, [layers.substations, substations]);

  useEffect(() => {
    if (!layers.plants || plants) return;
    let alive = true;
    loadPlants()
      .then((data) => {
        if (alive) setPlants(data.features as PlantFeature[]);
      })
      .catch(() => {
        if (alive) setPlants([]);
      });
    return () => {
      alive = false;
    };
  }, [layers.plants, plants]);

  // ---- Real-grid layer rendering -------------------------------------------

  useEffect(() => {
    const group = transmissionGroupRef.current;
    if (!group) return;
    group.clearLayers();
    if (!layers.transmission || !transmission) return;

    const renderer = L.canvas({ pane: "gs-transmission", padding: 0.5 });
    for (const feature of transmission) {
      if (feature.geometry?.type !== "LineString") continue;
      const latlngs = feature.geometry.coordinates.map(
        ([lon, lat]) => [lat, lon] as [number, number],
      );
      L.polyline(latlngs, {
        pane: "gs-transmission",
        renderer,
        interactive: false,
        weight: transmissionWeight(feature.properties.voltage_kv),
        // Canvas-rendered paths ignore CSS classes, so the neutral haze is set
        // inline: --muted at 45 % (README §4.6).
        color: "#8fa0b8",
        opacity: 0.45,
        lineCap: "round",
      }).addTo(group);
    }
  }, [layers.transmission, transmission]);

  useEffect(() => {
    const group = substationGroupRef.current;
    if (!group) return;
    group.clearLayers();
    if (!layers.substations || !substations) return;

    const renderer = L.canvas({ pane: "gs-substation", padding: 0.5 });
    for (const feature of substations) {
      const [lon, lat] = feature.geometry.coordinates;
      const props = feature.properties;
      const marker = L.circleMarker([lat, lon], {
        pane: "gs-substation",
        renderer,
        radius: 2.4,
        weight: 0,
        color: "#8fa0b8",
        fillColor: "#8fa0b8",
        fillOpacity: 0.35,
        interactive: Boolean(props.name),
      });
      if (props.name) {
        const voltage = props.voltage_kv === null ? "voltage untagged" : `${props.voltage_kv} kV`;
        marker.bindTooltip(
          `<b>${escapeHtml(props.name)}</b><br/>${escapeHtml(props.operator ?? "operator untagged")} · ${voltage}<br/><span class="tt-src">OSM</span>`,
          { direction: "top", className: "grid-tooltip" },
        );
      }
      marker.addTo(group);
    }
  }, [layers.substations, substations]);

  useEffect(() => {
    const group = plantGroupRef.current;
    if (!group) return;
    group.clearLayers();
    if (!layers.plants || !plants) return;

    for (const feature of plants) {
      const [lon, lat] = feature.geometry.coordinates;
      const props = feature.properties;
      const years = props.oldest_year
        ? props.newest_year && props.newest_year !== props.oldest_year
          ? `${props.oldest_year}–${props.newest_year}`
          : `${props.oldest_year}`
        : "in-service year untagged";
      const retirement =
        props.planned_retirement_mw > 0
          ? `<br/>planned retirement ${props.planned_retirement_mw.toFixed(1)} MW`
          : "";

      L.circleMarker([lat, lon], {
        pane: "gs-plants",
        radius: plantRadius(props.nameplate_mw),
        weight: 1,
        color: "rgba(5,7,12,0.85)",
        fillOpacity: 0.85,
        className: `plant-dot ${sourceClass(props.primary_source)}`,
      })
        .bindTooltip(
          `<b>${escapeHtml(props.plant_name)}</b><br/>${props.nameplate_mw.toFixed(1)} MW · ${sourceLabel(props.primary_source)}<br/>in service ${years}${retirement}<br/><span class="tt-src">EIA-860 2025</span>`,
          { direction: "top", className: "grid-tooltip" },
        )
        .addTo(group);
    }
  }, [layers.plants, plants]);

  useEffect(() => {
    const cg = contextGroupRef.current;
    if (!cg) return;
    cg.clearLayers();

    L.circle(center as [number, number], {
      radius: radiusMiles * 1609.34,
      color: "#38D6C4",
      weight: 1,
      opacity: 0.55,
      dashArray: "5 7",
      fillColor: "#38D6C4",
      fillOpacity: 0.05,
      interactive: false,
      className: "radius-ring",
    }).addTo(cg);

    L.marker(center as [number, number], {
      icon: L.divIcon({
        className: "home-marker-host",
        html: `<span class="home-marker"><span class="home-marker-ring"></span><span class="home-marker-label">Westminster HS</span></span>`,
        iconSize: [10, 10],
        iconAnchor: [5, 5],
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: -200,
    }).addTo(cg);
  }, [center, radiusMiles]);

  useEffect(() => {
    const mg = markerGroupRef.current;
    const fg = flowGroupRef.current;
    if (!mg || !fg) return;

    mg.clearLayers();
    fg.clearLayers();

    const markers: { id: string; el: HTMLElement }[] = [];
    const coordById = new Map<string, [number, number]>();
    for (const f of nodes) {
      const [lon, lat] = f.geometry.coordinates;
      coordById.set(f.properties.id, [lat, lon]);
    }

    const corridorById = new Map(corridors.map((corridor) => [corridor.id, corridor]));
    const flowColor = heatwave ? "#FFB020" : "#38D6C4";
    for (const flow of flows) {
      const from = coordById.get(flow.from);
      const to = coordById.get(flow.to);
      if (!from || !to) continue;
      const corridor = corridorById.get(flow.id);
      const loadClass =
        corridor?.severity === "watch"
          ? " is-watch"
          : corridor?.severity === "high" || corridor?.severity === "critical"
            ? " is-congested"
            : "";
      const loading =
        corridor === undefined
          ? ""
          : `<br/>${corridor.loading_pct}% of ${corridor.capacity_mva} MVA derated rating`;
      // These ties are modeled, not published circuits (README §4.1): dashed,
      // and the tooltip says so plainly.
      L.polyline([from, to], {
        color: flowColor,
        weight: 1 + flow.mva / 90,
        opacity: 0.5,
        dashArray: "6 8",
        className: `flow-line${loadClass}`,
        interactive: true,
      })
        .bindTooltip(
          `${escapeHtml(flow.label)} · ${flow.mva} MVA${loading}<br/><span class="tt-src">modeled tie (illustrative)</span>`,
          { direction: "top", className: "grid-tooltip" },
        )
        .addTo(fg);
    }

    if (!layers.loadCenters) {
      markerElsRef.current = [];
      return;
    }

    for (const f of nodes) {
      const [lon, lat] = f.geometry.coordinates;
      const risk = risks[f.properties.id];
      const selected = f.properties.id === selectedId;
      const size = Math.round(10 + f.properties.infrastructure.nameplate_draw_mw / 8);
      const html = `<span class="risk-marker${selected ? " is-selected" : ""}" style="--size:${size}px;--color:${risk.color}"><span class="risk-marker-halo"></span><span class="risk-marker-dot"></span></span>`;

      const marker = L.marker([lat, lon], {
        icon: L.divIcon({
          className: "marker-host",
          html,
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
        title: f.properties.name,
        keyboard: false,
        riseOnHover: true,
        zIndexOffset: selected ? 600 : 0,
      })
        .on("click", () => onSelectRef.current(f.properties.id))
        .addTo(mg);

      const el = marker.getElement();
      if (el) markers.push({ id: f.properties.id, el });
    }

    markerElsRef.current = markers;
  }, [nodes, flows, risks, selectedId, heatwave, layers.loadCenters, corridors]);

  useEffect(() => {
    const group = nicheGroupRef.current;
    if (!group) return;
    group.clearLayers();
    if (!layers.nicheCases) return;

    for (const nicheCase of nicheCases) {
      const selected = nicheCase.id === selectedNicheId;
      L.marker([nicheCase.location.lat, nicheCase.location.lon], {
        icon: L.divIcon({
          className: "niche-marker-host",
          html: `<span class="niche-marker${selected ? " is-selected" : ""}"><span class="niche-marker-halo"></span><span class="niche-diamond"></span></span>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
        title: nicheCase.title,
        keyboard: false,
        riseOnHover: true,
        zIndexOffset: 900,
      })
        .on("click", () => onSelectNicheRef.current(nicheCase.id))
        .bindTooltip(
          `<b>${escapeHtml(nicheCase.title)}</b><br/><span class="tt-src">${nicheCase.category} · ${nicheCase.location.distance_mi} mi</span>`,
          { direction: "top", className: "grid-tooltip" },
        )
        .addTo(group);
    }
  }, [layers.nicheCases, nicheCases, selectedNicheId]);

  useEffect(() => {
    const map = mapRef.current;
    const dark = darkLayerRef.current;
    const satellite = satLayerRef.current;
    if (!map || !dark || !satellite) return;

    if (view3d) {
      if (map.hasLayer(dark)) map.removeLayer(dark);
      if (!map.hasLayer(satellite)) satellite.addTo(map);
    } else {
      if (map.hasLayer(satellite)) map.removeLayer(satellite);
      if (!map.hasLayer(dark)) dark.addTo(map);
    }

    const timer = window.setTimeout(() => {
      map.invalidateSize();
      syncRef.current();
    }, 340);
    return () => window.clearTimeout(timer);
  }, [view3d]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (firstSelection.current) {
      firstSelection.current = false;
      return;
    }
    const node = nodes.find((f) => f.properties.id === selectedId);
    if (!node) return;
    const [lon, lat] = node.geometry.coordinates;
    map.flyTo([lat, lon], Math.max(map.getZoom(), 10), { duration: 0.8 });
  }, [selectedId, nodes]);

  return (
    <div className="map-root">
      <div ref={hostRef} className="leaflet-host" />

      {view3d ? (
        <div className="pillar-layer">
          {nodes.map((f) => {
            const point = points[f.properties.id];
            if (!point) return null;
            const sim = sims[f.properties.id];
            const risk = risks[f.properties.id];
            const height = Math.round(34 + sim.effective_draw_mw * 5.5);
            const selected = f.properties.id === selectedId;
            const pillarStyle = {
              left: point.x,
              top: point.y,
              height,
              "--h": `${height}px`,
              "--c": risk.color,
            } as CSSProperties;

            return (
              <Fragment key={f.properties.id}>
                <span
                  className="pillar-ground"
                  aria-hidden
                  style={
                    {
                      left: point.x,
                      top: point.y,
                      width: 34 + sim.effective_draw_mw * 2,
                      height: 34 + sim.effective_draw_mw * 2,
                      "--c": risk.color,
                    } as CSSProperties
                  }
                />
                <div
                  className={`pillar${selected ? " is-selected" : ""}`}
                  style={pillarStyle}
                  aria-hidden
                >
                  <span className="pillar-stem" />
                  <span className="pillar-body" />
                  <span className="pillar-chip">
                    <b>{sim.effective_draw_mw.toFixed(1)} MW</b>
                    <span>{shortName(f.properties.name)}</span>
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
