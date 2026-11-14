/**
 * Real-grid asset summaries — the bridge between the static layers in
 * `lib/gridLayers.ts` (EIA-860 plants, OSM transmission and substations) and
 * the derived grid chain in `lib/grid.ts`.
 *
 * Everything here is a fact read off a real layer or a physics result computed
 * from one. Nothing is invented: if a layer is missing, the summary is `null`
 * and the chain says so instead of making a number up.
 */

import { systemInertia, type GeneratorType } from "./physics/dynamics";
import { CONDUCTORS, type ConductorSpec } from "./physics/network";
import { conductorHeatBalance, conductorSagRisk, lineRatingMva } from "./physics/thermal";
import type { PlantFeature, SubstationFeature, TransmissionFeature } from "./gridLayers";

/** Longitude/latitude pair, GeoJSON order. */
export type LonLat = [number, number];

const MI_PER_DEG_LAT = 69.0;
const EARTH_R_MI = 3958.8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in miles. */
export function haversineMi(a: LonLat, b: LonLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance from a point to a segment, in miles, on a local flat projection. */
function segmentDistanceMi(point: LonLat, a: LonLat, b: LonLat): number {
  const lonScale = MI_PER_DEG_LAT * Math.cos(toRad(point[1]));
  const ax = (a[0] - point[0]) * lonScale;
  const ay = (a[1] - point[1]) * MI_PER_DEG_LAT;
  const bx = (b[0] - point[0]) * lonScale;
  const by = (b[1] - point[1]) * MI_PER_DEG_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function lineDistanceMi(point: LonLat, coords: LonLat[]): number {
  if (coords.length === 0) return Number.POSITIVE_INFINITY;
  if (coords.length === 1) return haversineMi(point, coords[0]);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < coords.length; i += 1) {
    const d = segmentDistanceMi(point, coords[i - 1], coords[i]);
    if (d < best) best = d;
  }
  return best;
}

function bboxOf(coords: LonLat[]): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

/** Cheap lower bound: distance from the point to the feature's bbox, miles. */
function bboxDistanceMi(point: LonLat, bbox: [number, number, number, number]): number {
  const lonScale = MI_PER_DEG_LAT * Math.cos(toRad(point[1]));
  const dx =
    point[0] < bbox[0]
      ? (bbox[0] - point[0]) * lonScale
      : point[0] > bbox[2]
        ? (point[0] - bbox[2]) * lonScale
        : 0;
  const dy =
    point[1] < bbox[1]
      ? (bbox[1] - point[1]) * MI_PER_DEG_LAT
      : point[1] > bbox[3]
        ? (point[1] - bbox[3]) * MI_PER_DEG_LAT
        : 0;
  return Math.hypot(dx, dy);
}

// ---- Index ------------------------------------------------------------------

export interface IndexedLine {
  feature: TransmissionFeature;
  bbox: [number, number, number, number];
}

/** Layer arrays prepared once and reused for every load center. */
export interface AssetIndex {
  plants: PlantFeature[];
  lines: IndexedLine[];
  substations: SubstationFeature[];
}

export function buildAssetIndex(
  plants: PlantFeature[],
  transmission: TransmissionFeature[],
  substations: SubstationFeature[],
): AssetIndex {
  return {
    plants,
    lines: transmission.map((feature) => ({
      feature,
      bbox: bboxOf(feature.geometry.coordinates),
    })),
    substations,
  };
}

// ---- Generation -------------------------------------------------------------

const FOSSIL_SOURCES = new Set(["natural_gas", "other_gas", "oil"]);
const RENEWABLE_SOURCES = new Set(["solar", "wind", "hydro"]);

function generatorType(source: string): GeneratorType {
  switch (source) {
    case "natural_gas":
      return "gas_cc";
    case "hydro":
      return "hydro";
    case "wind":
      return "wind";
    case "solar":
      return "solar";
    case "battery":
      return "battery";
    default:
      return "other";
  }
}

export interface PlantDigest {
  name: string;
  mw: number;
  source: string;
  distance_mi: number;
  planned_retirement_mw: number;
  age_years: number | null;
}

export interface GenerationAssets {
  radius_mi: number;
  plant_count: number;
  total_mw: number;
  fossil_mw: number;
  renewable_mw: number;
  storage_mw: number;
  by_source: Record<string, number>;
  retiring_mw: number;
  retiring: PlantDigest[];
  fleet_age_years: number | null;
  largest: PlantDigest | null;
  nearest: PlantDigest[];
  inertia_mws: number;
  synchronous_share_pct: number;
}

function plantDigest(feature: PlantFeature, distanceMi: number): PlantDigest {
  const p = feature.properties;
  return {
    name: p.plant_name,
    mw: p.nameplate_mw,
    source: p.primary_source,
    distance_mi: Math.round(distanceMi * 10) / 10,
    planned_retirement_mw: p.planned_retirement_mw,
    age_years: p.capacity_weighted_age_years,
  };
}

function summarizeGeneration(index: AssetIndex, point: LonLat, radiusMi: number): GenerationAssets {
  const inRing: { digest: PlantDigest; feature: PlantFeature }[] = [];
  for (const feature of index.plants) {
    const [lon, lat] = feature.geometry.coordinates;
    const distance = haversineMi(point, [lon, lat]);
    if (distance <= radiusMi) {
      inRing.push({ digest: plantDigest(feature, distance), feature });
    }
  }

  const bySource: Record<string, number> = {};
  let total = 0;
  let fossil = 0;
  let renewable = 0;
  let storage = 0;
  let retiring = 0;
  let ageWeighted = 0;
  let ageWeight = 0;
  const retiringPlants: PlantDigest[] = [];

  for (const { digest, feature } of inRing) {
    total += digest.mw;
    for (const [source, mw] of Object.entries(feature.properties.mw_by_source)) {
      bySource[source] = (bySource[source] ?? 0) + mw;
      if (FOSSIL_SOURCES.has(source)) fossil += mw;
      else if (RENEWABLE_SOURCES.has(source)) renewable += mw;
      else if (source === "battery") storage += mw;
    }
    retiring += digest.planned_retirement_mw;
    if (digest.planned_retirement_mw > 0) retiringPlants.push(digest);
    if (digest.age_years !== null) {
      ageWeighted += digest.age_years * digest.mw;
      ageWeight += digest.mw;
    }
  }

  const inertia = systemInertia(
    inRing.flatMap(({ feature }) =>
      Object.entries(feature.properties.mw_by_source).map(([source, mw]) => ({
        id: `${feature.properties.plant_code}-${source}`,
        type: generatorType(source),
        mva: mw,
      })),
    ),
  );

  const sortedBySize = [...inRing].sort((a, b) => b.digest.mw - a.digest.mw);
  const sortedByDistance = [...inRing].sort((a, b) => a.digest.distance_mi - b.digest.distance_mi);

  return {
    radius_mi: radiusMi,
    plant_count: inRing.length,
    total_mw: Math.round(total),
    fossil_mw: Math.round(fossil),
    renewable_mw: Math.round(renewable),
    storage_mw: Math.round(storage),
    by_source: Object.fromEntries(
      Object.entries(bySource)
        .filter(([, mw]) => mw >= 1)
        .sort((a, b) => b[1] - a[1])
        .map(([source, mw]) => [source, Math.round(mw)]),
    ),
    retiring_mw: Math.round(retiring),
    retiring: retiringPlants
      // Sub-25 MW units are noise in a regional rollup; they stay in the total.
      .filter((plant) => plant.planned_retirement_mw >= 25)
      .sort((a, b) => b.planned_retirement_mw - a.planned_retirement_mw)
      .slice(0, 3),
    fleet_age_years: ageWeight > 0 ? Math.round((ageWeighted / ageWeight) * 10) / 10 : null,
    largest: sortedBySize[0]?.digest ?? null,
    nearest: sortedByDistance.slice(0, 3).map((entry) => entry.digest),
    inertia_mws: inertia.inertia_mws,
    synchronous_share_pct: inertia.synchronous_share_pct,
  };
}

// ---- Transmission -----------------------------------------------------------

const CONDUCTOR_FOR_KV: { min_kv: number; id: keyof typeof CONDUCTORS }[] = [
  { min_kv: 500, id: "acsr-1590-falcon" },
  { min_kv: 220, id: "acsr-795-drake" },
  { min_kv: 115, id: "acsr-477-hawk" },
  { min_kv: 69, id: "acsr-336-linnet" },
];

function conductorForKv(voltageKv: number): ConductorSpec {
  const match = CONDUCTOR_FOR_KV.find((entry) => voltageKv >= entry.min_kv);
  return CONDUCTORS[match?.id ?? "acsr-4-0-penguin"];
}

/**
 * Screen the conductor at the static rating and at a 105 °F (40.6 °C) ambient.
 * The 25 °C case is the planning rating; the 40.6 °C case is the IEEE 738 heat
 * balance in a heatwave, and DLR uses the same balance with a 3 m/s breeze.
 */
export interface ThermalScreen {
  voltage_kv: number;
  conductor: string;
  max_temp_c: number;
  rating_mva_25c: number;
  rating_mva_105f: number;
  derate_pct: number;
  dlr_rating_mva: number;
  dlr_uplift_mva: number;
  conductor_temp_c_at_rating: number;
  sag_risk: "ok" | "watch" | "high" | "critical";
}

const WEATHER_STANDARD = { ambient_c: 25, wind_mps: 0.61, solar_w_m2: 900 };
const WEATHER_HEATWAVE = { ambient_c: 40.6, wind_mps: 0.61, solar_w_m2: 1000 };
const WEATHER_DLR = { ambient_c: 40.6, wind_mps: 3.0, solar_w_m2: 1000 };

export function thermalScreen(voltageKv: number): ThermalScreen {
  const conductor = conductorForKv(voltageKv);
  const rating25 = lineRatingMva(conductor, voltageKv, WEATHER_STANDARD);
  const rating105 = lineRatingMva(conductor, voltageKv, WEATHER_HEATWAVE);
  const dlr = lineRatingMva(conductor, voltageKv, WEATHER_DLR);
  const currentA = (rating25 * 1000) / (Math.sqrt(3) * voltageKv);
  const balance = conductorHeatBalance(conductor, currentA, WEATHER_HEATWAVE);
  return {
    voltage_kv: voltageKv,
    conductor: conductor.label,
    max_temp_c: conductor.max_temp_c,
    rating_mva_25c: Math.round(rating25),
    rating_mva_105f: Math.round(rating105),
    derate_pct: rating25 > 0 ? Math.round(((rating25 - rating105) / rating25) * 1000) / 10 : 0,
    dlr_rating_mva: Math.round(dlr),
    dlr_uplift_mva: Math.max(0, Math.round(dlr - rating105)),
    conductor_temp_c_at_rating: balance.temperature_c,
    sag_risk: conductorSagRisk(balance.temperature_c, conductor.max_temp_c),
  };
}

const CONDUCTOR_LADDER: (keyof typeof CONDUCTORS)[] = [
  "acsr-4-0-penguin",
  "acsr-336-linnet",
  "acsr-477-hawk",
  "acsr-795-drake",
  "acsr-1590-falcon",
];

export interface ReconductorScreen {
  from: string;
  to: string;
  rating_mva_105f: number;
  uplift_mva: number;
}

/**
 * Rate one conductor size up at 105 °F and report the honest uplift over the
 * present one. Reconductoring is a bigger conductor, not a dynamic rating.
 */
export function reconductorScreen(voltageKv: number): ReconductorScreen {
  const current = conductorForKv(voltageKv);
  const index = CONDUCTOR_LADDER.findIndex((id) => CONDUCTORS[id].id === current.id);
  const nextId = CONDUCTOR_LADDER[Math.min(CONDUCTOR_LADDER.length - 1, Math.max(0, index + 1))];
  const next = CONDUCTORS[nextId];
  const presentRating = lineRatingMva(current, voltageKv, WEATHER_HEATWAVE);
  const nextRating = lineRatingMva(next, voltageKv, WEATHER_HEATWAVE);
  return {
    from: current.label,
    to: next.label,
    rating_mva_105f: Math.round(nextRating),
    uplift_mva: Math.max(0, Math.round(nextRating - presentRating)),
  };
}

export interface LineDigest {
  name: string;
  operator: string | null;
  voltage_kv: number;
  distance_mi: number;
}

export interface TransmissionAssets {
  radius_mi: number;
  line_count: number;
  max_kv: number | null;
  /** Circuits at the highest voltage found — the real redundancy screen. */
  top_voltage_count: number;
  by_voltage: { voltage_kv: number; count: number }[];
  nearest: LineDigest[];
  operators: { operator: string; count: number }[];
  thermal: ThermalScreen | null;
}

function summarizeTransmission(
  index: AssetIndex,
  point: LonLat,
  radiusMi: number,
): TransmissionAssets {
  const near: { digest: LineDigest; kv: number }[] = [];
  const voltageCounts = new Map<number, number>();
  const operatorCounts = new Map<string, number>();

  for (const line of index.lines) {
    if (bboxDistanceMi(point, line.bbox) > radiusMi) continue;
    const distance = lineDistanceMi(point, line.feature.geometry.coordinates);
    if (distance > radiusMi) continue;
    const kv = line.feature.properties.voltage_kv;
    if (kv === null) continue;
    voltageCounts.set(kv, (voltageCounts.get(kv) ?? 0) + 1);
    const operator = line.feature.properties.operator;
    if (operator) operatorCounts.set(operator, (operatorCounts.get(operator) ?? 0) + 1);
    near.push({
      kv,
      digest: {
        name:
          line.feature.properties.name?.trim() ||
          `${kv} kV circuit (OSM ${line.feature.properties.osm_id ?? "way"})`,
        operator,
        voltage_kv: kv,
        distance_mi: Math.round(distance * 10) / 10,
      },
    });
  }

  const maxKv = near.reduce<number | null>((best, line) => (best === null || line.kv > best ? line.kv : best), null);

  return {
    radius_mi: radiusMi,
    line_count: near.length,
    max_kv: maxKv,
    top_voltage_count: maxKv === null ? 0 : near.filter((line) => line.kv === maxKv).length,
    by_voltage: [...voltageCounts.entries()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, 4)
      .map(([voltage_kv, count]) => ({ voltage_kv, count })),
    nearest: near
      .sort((a, b) => a.digest.distance_mi - b.digest.distance_mi)
      .slice(0, 3)
      .map((entry) => entry.digest),
    operators: [...operatorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([operator, count]) => ({ operator, count })),
    thermal: maxKv === null ? null : thermalScreen(maxKv),
  };
}

// ---- Substations ------------------------------------------------------------

export interface SubstationDigest {
  name: string;
  operator: string | null;
  voltage_kv: number | null;
  distance_mi: number;
  kind: string | null;
}

export interface SubstationAssets {
  radius_mi: number;
  count: number;
  named_count: number;
  distribution_count: number;
  transmission_count: number;
  max_kv: number | null;
  nearest_named: SubstationDigest[];
  nearest_distribution_mi: number | null;
}

function substationKind(feature: SubstationFeature): { kind: string | null; isDistribution: boolean; isTransmission: boolean } {
  const tag = feature.properties.substation;
  const kv = feature.properties.voltage_kv;
  const isDistribution = tag === "distribution" || tag === "minor_distribution";
  const isTransmission =
    tag === "transmission" || tag === "subtransmission" || (kv !== null && kv >= 115);
  return { kind: tag ?? null, isDistribution, isTransmission };
}

/**
 * Named, high-voltage outlines first, because an unnamed `transition` way is
 * not a useful answer to "what substation serves this site". Falls back to any
 * voltage-tagged outline, then to nothing.
 */
function pickNearestNamed(
  near: { digest: SubstationDigest; isDistribution: boolean; isTransmission: boolean }[],
): SubstationDigest[] {
  const byDistance = [...near].sort((a, b) => a.digest.distance_mi - b.digest.distance_mi);
  const named = byDistance.filter(
    (entry) => entry.digest.name && !entry.digest.name.includes("(OSM") && (entry.digest.voltage_kv ?? 0) >= 115,
  );
  const tagged = byDistance.filter((entry) => entry.digest.voltage_kv !== null);
  return (named.length > 0 ? named : tagged).slice(0, 3).map((entry) => entry.digest);
}

function summarizeSubstations(
  index: AssetIndex,
  point: LonLat,
  radiusMi: number,
): SubstationAssets {
  const near: { digest: SubstationDigest; isDistribution: boolean; isTransmission: boolean }[] = [];
  let named = 0;
  let maxKv: number | null = null;
  let nearestDistribution: number | null = null;

  for (const feature of index.substations) {
    const [lon, lat] = feature.geometry.coordinates;
    const distance = haversineMi(point, [lon, lat]);
    if (distance > radiusMi) continue;
    const { kind, isDistribution, isTransmission } = substationKind(feature);
    if (feature.properties.name) named += 1;
    const kv = feature.properties.voltage_kv;
    if (kv !== null && (maxKv === null || kv > maxKv)) maxKv = kv;
    if (isDistribution && (nearestDistribution === null || distance < nearestDistribution)) {
      nearestDistribution = distance;
    }
    near.push({
      isDistribution,
      isTransmission,
      digest: {
        name:
          feature.properties.name?.trim() ||
          `${kind ?? "substation"} (OSM ${feature.properties.osm_id})`,
        operator: feature.properties.operator,
        voltage_kv: kv,
        distance_mi: Math.round(distance * 10) / 10,
        kind,
      },
    });
  }

  return {
    radius_mi: radiusMi,
    count: near.length,
    named_count: named,
    distribution_count: near.filter((entry) => entry.isDistribution).length,
    transmission_count: near.filter((entry) => entry.isTransmission).length,
    max_kv: maxKv,
    nearest_named: pickNearestNamed(near),
    nearest_distribution_mi:
      nearestDistribution === null ? null : Math.round(nearestDistribution * 10) / 10,
  };
}

// ---- Public API -------------------------------------------------------------

export interface RealGridAssets {
  generation: GenerationAssets | null;
  transmission: TransmissionAssets | null;
  substations: SubstationAssets | null;
}

export interface AssetRadii {
  plants_mi?: number;
  transmission_mi?: number;
  substations_mi?: number;
}

/**
 * One pass over the real layers around a single load center. Each summary is
 * `null` only when its layer is empty, never when a value is merely missing.
 */
export function summarizeAssets(
  index: AssetIndex,
  point: LonLat,
  radii: AssetRadii = {},
): RealGridAssets {
  const plantsMi = radii.plants_mi ?? 25;
  const transmissionMi = radii.transmission_mi ?? 8;
  const substationsMi = radii.substations_mi ?? 10;

  const generation = index.plants.length > 0 ? summarizeGeneration(index, point, plantsMi) : null;
  const transmission =
    index.lines.length > 0 ? summarizeTransmission(index, point, transmissionMi) : null;
  const substations =
    index.substations.length > 0 ? summarizeSubstations(index, point, substationsMi) : null;

  return { generation, transmission, substations };
}
