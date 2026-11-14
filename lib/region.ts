import rawRegions from "@/data/regions.json";
import rawData from "@/data/nodes.json";
import { simulate } from "./simulation";
import type {
  FacilityFeature,
  FacilityProperties,
  PowerFlow,
  RegionPayload,
  SourceMix,
} from "./types";

interface RegionRecord {
  id: string;
  name: string;
  state: string;
  center: [number, number];
  radius_miles: number;
  bounds: [[number, number], [number, number]];
  grid_zone: string;
}

interface RawDataset {
  region_id: string;
  type: "FeatureCollection";
  features: FacilityFeature[];
  flows: PowerFlow[];
}

const regions = rawRegions as unknown as RegionRecord[];
const dataset = rawData as unknown as RawDataset;
const CURRENT_YEAR = 2026;

function withAge(feature: FacilityFeature): FacilityFeature {
  const yearBuilt = feature.properties.infrastructure.year_built;
  return {
    ...feature,
    properties: {
      ...feature.properties,
      infrastructure: {
        ...feature.properties.infrastructure,
        age_years: CURRENT_YEAR - yearBuilt,
      },
    },
  };
}

const features: FacilityFeature[] = dataset.features.map(withAge);

export const REGION_IDS = regions.map((region) => region.id);

export function listRegions(): RegionRecord[] {
  return regions;
}

export function listFacilities(): FacilityFeature[] {
  return features;
}

/** Grid ties between load centers — the topology the phase chain walks. */
export function listFlows(): PowerFlow[] {
  return dataset.flows;
}

export function getFacility(nodeId: string): FacilityProperties | null {
  return features.find((f) => f.properties.id === nodeId)?.properties ?? null;
}

export function getRegion(regionId: string): RegionPayload | null {
  const region = regions.find((r) => r.id === regionId);
  if (!region) return null;

  const sims = features.map((f) => ({ feature: f, sim: simulate(f.properties) }));

  const totalNameplate = features.reduce(
    (sum, f) => sum + f.properties.infrastructure.nameplate_draw_mw,
    0,
  );
  const totalDraw = features.reduce(
    (sum, f) => sum + f.properties.energy_profile.baseline_draw_mw,
    0,
  );
  const totalAnnualCO2 = sims.reduce((sum, s) => sum + s.sim.annual_co2_tons, 0);
  const totalAnnualMWh = sims.reduce((sum, s) => sum + s.sim.annual_mwh, 0);

  const weightedCI =
    features.reduce(
      (sum, f) =>
        sum +
        f.properties.energy_profile.carbon_intensity_gco2_kwh *
          f.properties.energy_profile.baseline_draw_mw,
      0,
    ) / (totalDraw || 1);

  const sources: (keyof SourceMix)[] = [
    "natural_gas",
    "solar",
    "hydro",
    "wind",
    "other",
  ];
  const mix = sources.reduce((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {} as SourceMix);

  for (const f of features) {
    const draw = f.properties.energy_profile.baseline_draw_mw;
    for (const key of sources) {
      mix[key] += (f.properties.energy_profile.source_mix[key] * draw) / (totalDraw || 1);
    }
  }
  for (const key of sources) mix[key] = Math.round(mix[key] * 10) / 10;

  return {
    region: {
      id: region.id,
      name: region.name,
      state: region.state,
      bounds: region.bounds,
      grid_zone: region.grid_zone,
      center: region.center,
      radius_miles: region.radius_miles,
    },
    nodes: { type: "FeatureCollection", features },
    flows: dataset.flows,
    grid: {
      carbon_intensity_gco2_kwh: Math.round(weightedCI * 10) / 10,
      source_mix: mix,
    },
    kpis: {
      total_draw_mw: Math.round(totalDraw * 100) / 100,
      total_annual_co2_tons: Math.round(totalAnnualCO2),
      total_annual_mwh: Math.round(totalAnnualMWh),
      total_nameplate_mw: Math.round(totalNameplate * 10) / 10,
      facility_count: features.length,
    },
    generated_at: new Date().toISOString(),
  };
}

export function getRegionOrThrow(regionId: string): RegionPayload {
  const payload = getRegion(regionId);
  if (!payload) throw new Error(`Unknown region: ${regionId}`);
  return payload;
}
