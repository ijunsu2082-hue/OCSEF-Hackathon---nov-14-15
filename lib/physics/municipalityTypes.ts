/**
 * Municipality + buildout contract.
 *
 * This is additive to the frozen `lib/types.ts`. It describes the physical
 * layer the UI can grow into: a substation, radial feeders, sector loads,
 * distributed resources, new buildout projects and the stats that fall out of
 * the power-flow / thermal / stability engine.
 */

import type { BranchSpec } from "./network";
import type { TransformerSpec } from "./thermal";
import type {
  BessSpec,
  LoadSpec,
  Sector,
  SolarSpec,
  WeatherScenario,
  WindSpec,
} from "./load";
import type { EconomicAssumptions } from "./economics";
import type { InertiaSource, StressBand } from "./dynamics";

export type BuildoutKind =
  | "data_center"
  | "housing"
  | "commercial"
  | "industrial"
  | "desalination"
  | "transit"
  | "ev_depot"
  | "solar_farm"
  | "battery"
  | "substation";

export const BUILDOUT_LABELS: Record<BuildoutKind, string> = {
  data_center: "Data center",
  housing: "Housing",
  commercial: "Commercial",
  industrial: "Industrial",
  desalination: "Desalination",
  transit: "Transit",
  ev_depot: "EV depot",
  solar_farm: "Solar farm",
  battery: "Battery",
  substation: "Substation",
};

export interface MunicipalBus {
  id: string;
  name: string;
  base_kv: number;
  /** Customers served from this bus, used for SAIDI/SAIFI. */
  customers: number;
  loads: LoadSpec[];
  solar?: SolarSpec[];
  wind?: WindSpec[];
  bess?: BessSpec[];
  /** Optional A/B/C phase split; defaults to a balanced bus. */
  phase_split?: [number, number, number];
}

export interface SlackBusSpec {
  id: string;
  name: string;
  base_kv: number;
  customers?: number;
}

export interface FeederScenario {
  id: string;
  name: string;
  voltage_kv: number;
  slack_bus: SlackBusSpec;
  buses: MunicipalBus[];
  branches: BranchSpec[];
}

export interface SubstationSpec {
  id: string;
  name: string;
  hv_kv: number;
  lv_kv: number;
  transformer: TransformerSpec;
  /** Short-circuit MVA available at the HV source. */
  source_sc_mva?: number;
}

export interface NewBusSpec {
  id: string;
  name: string;
  customers: number;
  connection_length_mi: number;
  conductor?: string;
  phase_spacing_ft?: number;
  circuits?: number;
}

export interface BuildoutProject {
  id: string;
  name: string;
  kind: BuildoutKind;
  feeder_id: string;
  /** Parent bus for the load; if `new_bus` is present this is the tap point. */
  bus_id: string;
  new_bus?: NewBusSpec;
  peak_mw: number;
  power_factor: number;
  sector: Sector;
  energize_year: number;
  hvac_share?: number;
  cooling_balance_c?: number;
  cooling_design_c?: number;
  heating_balance_c?: number;
  heating_design_c?: number;
  shape?: number[];
  capex_usd: number;
  annual_om_usd?: number;
  /** Share of the load that is flexible / curtailable. */
  flexible_fraction?: number;
  solar?: SolarSpec;
  wind?: WindSpec;
  bess?: BessSpec;
}

export interface BessDispatchSpec {
  /** Hours when the battery is asked to charge (0–23). */
  charge_hours?: number[];
  /** Hours when the battery is asked to discharge (0–23). */
  discharge_hours?: number[];
}

export interface SourceMix {
  natural_gas: number;
  solar: number;
  hydro: number;
  wind: number;
  other: number;
}

export interface MunicipalityScenario {
  id: string;
  name: string;
  state: string;
  population: number;
  base_year: number;
  latitude_deg: number;
  substation: SubstationSpec;
  feeders: FeederScenario[];
  buildouts: BuildoutProject[];
  weather: WeatherScenario;
  /** Grid carbon intensity for the energy the municipality imports. */
  grid_carbon_intensity_gco2_kwh: number;
  grid_energy_price_usd_per_mwh?: number;
  economics?: Partial<EconomicAssumptions>;
  reliability?: Partial<ReliabilityAssumptions>;
  /** Explicit online generation fleet for inertia. If absent, modeled. */
  generation?: InertiaSource[];
  source_mix?: SourceMix;
  /** Fast frequency response available from grid-scale batteries, MW. */
  ffr_mw?: number;
  growth_pct_per_year?: number;
  bess_dispatch?: BessDispatchSpec;
}

export interface ReliabilityAssumptions {
  failure_rate_per_mi_year: number;
  repair_hours: number;
  permanent_fault_fraction: number;
  target_saidi_min: number;
  target_saifi: number;
}

export const DEFAULT_RELIABILITY: ReliabilityAssumptions = {
  failure_rate_per_mi_year: 0.12,
  repair_hours: 4.5,
  permanent_fault_fraction: 0.7,
  target_saidi_min: 120,
  target_saifi: 1.5,
};

export interface SimulationOptions {
  /** 24 for a design day, 8760 for a weather year. */
  hours?: number;
  /** Hour offset into the weather series. */
  start_hour?: number;
  /** Buildout year used to filter projects. Defaults to `base_year`. */
  year?: number;
  /** Include active buildout projects. */
  include_buildouts?: boolean;
  /** Run the no-buildout case as well and report deltas. */
  compare_baseline?: boolean;
  voltage_min_pu?: number;
  voltage_max_pu?: number;
  record_hourly?: boolean;
  compute_hosting?: boolean;
}

export interface DemandStats {
  peak_mw: number;
  average_mw: number;
  min_mw: number;
  load_factor: number;
  annual_mwh: number;
  existing_peak_mw: number;
  buildout_peak_mw: number;
  growth_pct: number;
}

export interface VoltageStats {
  min_pu: number;
  max_pu: number;
  max_drop_pct: number;
  violation_hours: number;
  infeasible_hours: number;
  unbalance_pct: number;
}

export interface LossStats {
  annual_mwh: number;
  pct: number;
  peak_mw: number;
  cost_usd: number;
}

export interface ReliabilityStats {
  saidi_min: number;
  saifi: number;
  unserved_mwh: number;
  customer_hours: number;
  worst_bus: string | null;
}

export interface ThermalStats {
  transformer_peak_loading_pct: number;
  transformer_hotspot_max_c: number;
  transformer_top_oil_max_c: number;
  transformer_loss_of_life_pct: number;
  transformer_remaining_life_years: number;
  line_peak_temp_c: number;
  line_overload_hours: number;
}

export interface StabilityStats {
  basis: "provided" | "modeled";
  inertia_mws: number;
  h_sys_s: number;
  synchronous_share_pct: number;
  scr: number;
  fault_mva: number;
  contingency_mw: number;
  rocof_hz_s: number;
  nadir_hz: number;
  steady_state_hz: number;
  ufls_shed_mw: number;
  pv_margin_pct: number;
  critical_voltage_pu: number;
  score: number;
  band: StressBand;
  binding: string;
}

export interface EmissionStats {
  co2_tons: number;
  intensity_gco2_kwh: number;
}

export interface EconomicStats {
  annual_energy_cost_usd: number;
  annual_loss_cost_usd: number;
  lcoe_usd_mwh: number;
  buildout_capex_usd: number;
  annual_om_usd: number;
  cost_per_added_mw: number;
  annual_unserved_cost_usd: number;
}

export interface CapacityStats {
  substation_mva: number;
  peak_loading_pct: number;
  headroom_mw: number;
  hosting_capacity_mw: number;
}

export interface FeederStats {
  id: string;
  name: string;
  peak_load_mw: number;
  annual_mwh: number;
  losses_mwh: number;
  loss_pct: number;
  min_voltage_pu: number;
  max_voltage_pu: number;
  max_branch_loading_pct: number;
  violation_hours: number;
  hosting_capacity_mw: number;
  worst_bus: string | null;
}

export interface BuildoutStats {
  id: string;
  name: string;
  kind: BuildoutKind;
  feeder_id: string;
  bus_id: string;
  status: "active" | "planned";
  peak_mw: number;
  annual_mwh: number;
  capex_usd: number;
  annual_om_usd: number;
  cost_per_added_mw: number;
  connection_miles: number;
  voltage_impact_pu: number;
  feeder_loading_impact_pct: number;
}

export interface MunicipalityStats {
  id: string;
  name: string;
  state: string;
  population: number;
  year: number;
  hours: number;
  demand: DemandStats;
  voltage: VoltageStats;
  losses: LossStats;
  reliability: ReliabilityStats;
  thermal: ThermalStats;
  stability: StabilityStats;
  emissions: EmissionStats;
  economics: EconomicStats;
  capacity: CapacityStats;
  feeders: FeederStats[];
  buildouts: BuildoutStats[];
  baseline: {
    peak_mw: number;
    annual_mwh: number;
    losses_mwh: number;
    min_voltage_pu: number;
    max_branch_loading_pct: number;
  } | null;
}

export interface HourlyPoint {
  index: number;
  hour: number;
  ambient_c: number;
  load_mw: number;
  solar_mw: number;
  wind_mw: number;
  bess_mw: number;
  losses_mw: number;
  min_voltage_pu: number;
  max_branch_loading_pct: number;
  transformer_hotspot_c: number;
}

export interface PeakSnapshot {
  index: number;
  ambient_c: number;
  load_mw: number;
  min_voltage_pu: number;
  max_voltage_pu: number;
  max_branch_loading_pct: number;
  transformer_loading_pct: number;
  feeder_voltages: Record<string, { min_pu: number; max_pu: number }>;
  bus_voltages: Record<string, number>;
}

export interface MunicipalityResult {
  stats: MunicipalityStats;
  hourly?: HourlyPoint[];
  peak: PeakSnapshot;
}

export interface MunicipalityBuildResult {
  scenario: MunicipalityScenario;
  built: BuiltMunicipality;
  baseline: BuiltMunicipality | null;
}

export interface BuiltFeeder {
  scenario: FeederScenario;
  network: {
    id: string;
    slack_bus_id: string;
    buses: { id: string; base_kv: number; load_mw: number; load_mvar: number; der_mw: number; der_mvar: number }[];
    branches: BranchSpec[];
  };
  loadsByBus: Record<string, LoadSpec[]>;
  solarByBus: Record<string, SolarSpec[]>;
  windByBus: Record<string, WindSpec[]>;
  bessByBus: Record<string, BessSpec[]>;
  customersByBus: Record<string, number>;
  /** Total conductor miles from the slack to each bus, for reliability. */
  pathMilesByBus: Record<string, number>;
  targetBuses: string[];
}

export interface BuiltMunicipality {
  scenario: MunicipalityScenario;
  year: number;
  include_buildouts: boolean;
  feeders: BuiltFeeder[];
  activeBuildouts: BuildoutProject[];
  /** Buildout project id → target bus id. */
  buildoutBus: Record<string, string>;
}
