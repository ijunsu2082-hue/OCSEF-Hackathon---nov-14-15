/**
 * Shared domain contract — frozen. Owned by the G0 contract (see README §3).
 * Every layer imports from here; nobody redefines these shapes.
 *
 * ENERGY-ONLY MODEL: an asset is an electrical load center. There is no water
 * throughput anywhere in this contract — capacity, output and efficiency are
 * all electrical.
 */

// ---- Domain -----------------------------------------------------------------
export type FacilityType = "Process Load" | "Pumping Load" | "Reclamation Load" | "Desalination Load";

export interface SourceMix {
  natural_gas: number;
  solar: number;
  hydro: number;
  wind: number;
  other: number; // percent, sums to 100
}

export interface Infrastructure {
  year_built: number;
  age_years: number; // computed at load time from current year
  /** Electrical efficiency of the motor/process train, 0–1 (0.85 is the benchmark). */
  motor_efficiency_rating: number;
  /** Electrical demand at 100 % utilization, MW. The basis of every energy formula. */
  nameplate_draw_mw: number;
  /** Current share of nameplate in use, 0–100. Replaces the old output/capacity ratio. */
  utilization_pct: number;
}

export interface EnergyProfile {
  /** Average actual draw today (nameplate × utilization). Display value only — see README §4.2. */
  baseline_draw_mw: number;
  peak_draw_mw: number;
  grid_zone: string; // e.g. "US-CAL-LDWP"
  carbon_intensity_gco2_kwh: number;
  source_mix: SourceMix;
}

export interface UpgradePotential {
  recommended_intervention: string;
  solar_capacity_add_mw: number;
  efficiency_gain_pct: number; // percent, e.g. 18
  capex_estimate_usd: number;
  annual_savings_usd: number;
  // --- unit economics drive the sliders -----------------------------------
  solar_capex_per_mw_usd: number;
  solar_savings_per_mw_usd: number;
  vfd_capex_usd: number;
  vfd_savings_usd: number;
}

export interface FacilityProperties {
  id: string;
  name: string;
  type: FacilityType;
  provider: { utility_name: string; contact_email: string };
  infrastructure: Infrastructure;
  energy_profile: EnergyProfile;
  upgrade_potential: UpgradePotential;
}

export type FacilityFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] }; // [lon, lat]
  properties: FacilityProperties;
};

/** An electrical distribution segment between two load centers. */
export interface PowerFlow {
  id: string;
  from: string; // facility id
  to: string; // facility id
  label: string; // "East Branch 230 kV trunk"
  mva: number; // sizes the animated line
}

// ---- Simulation -------------------------------------------------------------
export interface SimInput {
  node_id: string;
  heatwave_active: boolean;
  added_solar_mw: number; // 0 … 2 × recommended
  vfd_retrofit: boolean;
}

export interface SimResult {
  node_id: string;
  heatwave_active: boolean;
  nameplate_mw: number;
  utilization_pct: number;
  /** effective utilization / 100, after the heatwave surge and its 105 % ceiling. */
  load_ratio: number;
  overload: boolean; // heatwave pushed demand past nameplate
  effective_draw_mw: number;
  daily_mwh: number;
  annual_mwh: number;
  carbon_intensity: number;
  annual_co2_tons: number;
  baseline_annual_co2_tons: number; // no heatwave, no upgrades
  co2_delta_tons: number; // result − baseline (negative = avoided)
  homes_equivalent: number;
  /** Post-upgrade state, only when solar/vfd requested (else === baseline values) */
  upgraded: {
    draw_mw: number;
    solar_mw: number;
    grid_offset_mw: number;
    annual_co2_tons: number;
    co2_avoided_tons: number;
    capex_usd: number;
    annual_savings_usd: number;
    payback_years: number | null; // null when savings <= 0
  } | null;
  risk_score: number; // 0–100, see README §4.3
}

// ---- Region payload (GET /api/region/[regionId]) ----------------------------
export interface RegionPayload {
  region: {
    id: string;
    name: string;
    state: string;
    /** [[south, west], [north, east]] for Leaflet fitBounds. */
    bounds: [[number, number], [number, number]];
    grid_zone: string;
    /** Map focal point — Westminster High School, Westminster CA. */
    center: [number, number];
    /** Coverage radius in miles around the focal point. */
    radius_miles: number;
  };
  nodes: { type: "FeatureCollection"; features: FacilityFeature[] };
  flows: PowerFlow[];
  grid: {
    carbon_intensity_gco2_kwh: number; // load-weighted regional mean
    source_mix: SourceMix; // MW-weighted mean
  };
  kpis: {
    total_draw_mw: number;
    total_annual_co2_tons: number;
    total_annual_mwh: number;
    total_nameplate_mw: number;
    facility_count: number;
  };
  generated_at: string; // ISO
}

// ---- AI + outreach ----------------------------------------------------------
export interface BriefRequest {
  node_id: string;
  simulation: SimResult;
  tone?: "technical" | "executive";
}
export interface BriefResponse {
  node_id: string;
  brief: string; // ~200 words, plain text with section labels
  source: "gemini" | "fallback";
  model: string | null;
  generated_at: string;
}
export interface AuditRequest {
  node_id: string;
  brief: string;
  to: string; // recipient email
  simulation?: SimResult;
}
export interface AuditResponse {
  delivered: boolean;
  mode: "live" | "simulated";
  provider_id: string | null; // Resend message id
  to: string;
  subject: string;
  detail: string; // human-readable reason / next step
  sent_at: string;
}
