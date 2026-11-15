import rawRegions from "@/data/regions.json";
import rawData from "@/data/nodes.json";
import { simulate } from "./simulation";
import { getSupabase, selectAll } from "./supabase";
import type {
  FacilityFeature,
  FacilityProperties,
  PowerFlow,
  RegionPayload,
  SourceMix,
} from "./types";

/**
 * Region + load-center data.
 *
 * The sync exports (`getRegion`, `getFacility`, …) read the bundled JSON in
 * data/. The async `load*` variants read Supabase first (see
 * supabase/migrations/) and fall back to that same JSON when the client is not
 * configured, a query fails, or a table is empty. Server code uses the async
 * variants.
 */

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

/** Everything the region functions read, with derived ages already applied. */
interface Dataset {
  regions: RegionRecord[];
  features: FacilityFeature[];
  flows: PowerFlow[];
}

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

const regions = rawRegions as unknown as RegionRecord[];
const dataset = rawData as unknown as RawDataset;

const localDataset: Dataset = {
  regions,
  features: dataset.features.map(withAge),
  flows: dataset.flows,
};

// ---- Supabase ---------------------------------------------------------------

interface RegionRow {
  id: string;
  name: string;
  state: string;
  center_lat: number;
  center_lon: number;
  radius_miles: number;
  bounds: [[number, number], [number, number]];
  grid_zone: string;
}

interface NodeRow {
  id: string;
  name: string;
  type: FacilityProperties["type"];
  lon: number;
  lat: number;
  provider: FacilityProperties["provider"];
  infrastructure: FacilityProperties["infrastructure"];
  energy_profile: FacilityProperties["energy_profile"];
  upgrade_potential: FacilityProperties["upgrade_potential"];
}

interface FlowRow {
  id: string;
  from_node: string;
  to_node: string;
  label: string;
  mva: number;
}

async function fetchRemoteDataset(): Promise<Dataset | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const [regionRows, nodeRows, flowRows] = await Promise.all([
    selectAll<RegionRow>(
      supabase,
      "regions",
      "id,name,state,center_lat,center_lon,radius_miles,bounds,grid_zone",
      "id",
    ),
    selectAll<NodeRow>(
      supabase,
      "nodes",
      "id,name,type,lon,lat,provider,infrastructure,energy_profile,upgrade_potential",
      "sort_order",
    ),
    selectAll<FlowRow>(supabase, "node_flows", "id,from_node,to_node,label,mva", "sort_order"),
  ]);
  if (regionRows.length === 0 || nodeRows.length === 0) return null;

  // Regions have no sort_order column; keep the order of data/regions.json for
  // ids it knows, then any new ids alphabetically.
  const sourceOrder = new Map(regions.map((r, i) => [r.id, i]));
  const rank = (id: string) => sourceOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
  regionRows.sort((a, b) => rank(a.id) - rank(b.id));

  return {
    regions: regionRows.map((r) => ({
      id: r.id,
      name: r.name,
      state: r.state,
      center: [r.center_lat, r.center_lon],
      radius_miles: r.radius_miles,
      bounds: r.bounds,
      grid_zone: r.grid_zone,
    })),
    features: nodeRows.map((n) =>
      withAge({
        type: "Feature",
        geometry: { type: "Point", coordinates: [n.lon, n.lat] },
        properties: {
          id: n.id,
          name: n.name,
          type: n.type,
          provider: n.provider,
          infrastructure: n.infrastructure,
          energy_profile: n.energy_profile,
          upgrade_potential: n.upgrade_potential,
        },
      }),
    ),
    flows: flowRows.map((f) => ({
      id: f.id,
      from: f.from_node,
      to: f.to_node,
      label: f.label,
      mva: f.mva,
    })),
  };
}

/** Reference data changes only on a re-seed; re-read at most this often. */
const REMOTE_TTL_MS = 5 * 60 * 1000;
let remote: { at: number; promise: Promise<Dataset> } | null = null;

function loadDataset(): Promise<Dataset> {
  if (remote && Date.now() - remote.at < REMOTE_TTL_MS) return remote.promise;
  const promise = fetchRemoteDataset()
    .catch((err) => {
      console.warn("[region] Supabase failed, using data/*.json", err);
      remote = null; // do not pin a failure; retry on the next call
      return null;
    })
    .then((value) => value ?? localDataset);
  remote = { at: Date.now(), promise };
  return promise;
}

// ---- Sync API (bundled JSON) ------------------------------------------------

export const REGION_IDS = regions.map((region) => region.id);

export function listRegions(): RegionRecord[] {
  return localDataset.regions;
}

export function listFacilities(): FacilityFeature[] {
  return localDataset.features;
}

/** Grid ties between load centers — the topology the phase chain walks. */
export function listFlows(): PowerFlow[] {
  return localDataset.flows;
}

export function getFacility(nodeId: string): FacilityProperties | null {
  return facilityFrom(localDataset, nodeId);
}

export function getRegion(regionId: string): RegionPayload | null {
  return regionFrom(localDataset, regionId);
}

export function getRegionOrThrow(regionId: string): RegionPayload {
  const payload = getRegion(regionId);
  if (!payload) throw new Error(`Unknown region: ${regionId}`);
  return payload;
}

// ---- Async API (Supabase, falling back to bundled JSON) ---------------------

export async function loadRegions(): Promise<RegionRecord[]> {
  return (await loadDataset()).regions;
}

export async function loadFacilities(): Promise<FacilityFeature[]> {
  return (await loadDataset()).features;
}

export async function loadFlows(): Promise<PowerFlow[]> {
  return (await loadDataset()).flows;
}

export async function loadFacility(nodeId: string): Promise<FacilityProperties | null> {
  return facilityFrom(await loadDataset(), nodeId);
}

export async function loadRegion(regionId: string): Promise<RegionPayload | null> {
  return regionFrom(await loadDataset(), regionId);
}

export async function loadRegionOrThrow(regionId: string): Promise<RegionPayload> {
  const payload = await loadRegion(regionId);
  if (!payload) throw new Error(`Unknown region: ${regionId}`);
  return payload;
}

// ---- Shared computation -----------------------------------------------------

function facilityFrom({ features }: Dataset, nodeId: string): FacilityProperties | null {
  return features.find((f) => f.properties.id === nodeId)?.properties ?? null;
}

function regionFrom({ regions, features, flows }: Dataset, regionId: string): RegionPayload | null {

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
    flows,
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
