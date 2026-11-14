export type FuelKey =
  | "solar" | "battery" | "natural_gas" | "wind" | "hydro"
  | "biogas" | "oil" | "other_gas" | "waste_heat" | "other";

export type RiskLevel = "LOW" | "WATCH" | "HIGH" | "CRITICAL";

export interface Plant {
  plant_code: number; plant_name: string; utility_name: string; city: string; county: string;
  nameplate_mw: number; mw_by_source: Partial<Record<FuelKey, number>>; primary_source: FuelKey;
  technologies: string[]; oldest_year: number | null; newest_year: number | null;
  capacity_weighted_year: number | null; capacity_weighted_age_years: number | null;
  planned_retirement_mw: number; generator_count: number; grid_voltage_kv: number | null;
  lat: number; lon: number;
}

export interface Line {
  osm_id: number; voltage_kv: number | null; operator: string | null; name: string | null;
  circuits: string | null;
  coords: [number, number][]; // [lat, lon] (Leaflet order)
  kv_inferred?: boolean;      // voltage_kv filled in from connected lines / substations (enrich.ts)
  near?: string | null;       // nearest plant city within 15 mi, set only when name is missing
}

export interface Substation {
  osm_id: string; name: string | null; operator: string | null; voltage_kv: number | null;
  substation: string | null; lat: number; lon: number;
  kv_inferred?: boolean;      // voltage_kv filled in from connected lines (enrich.ts)
  near?: string | null;       // nearest plant city within 15 mi, set only when name is missing
}

export interface NicheStat { label: string; value: string; kind: "measured" | "modeled"; source: string }

export interface NicheCase {
  id: string; title: string; category: string;
  location: { name: string; lat: number; lon: number; distance_mi: number };
  one_liner: string; problem: string; fix: string; shock_line: string;
  stats: NicheStat[]; team_bullets: string[];
  chart?: { kind: "line_rating"; data_url: string };
}

export interface GenEvent {
  kind: "retired" | "proposed"; plant_name: string; technology: string; fuel: FuelKey;
  mw: number; year: number | null; // retirement year or effective (online) year
  lat: number; lon: number;
}

export interface RatingSiteSummary {
  key: string; name: string; lat: number; lon: number;
  median_conservative_dlr_vs_static: number; pct_hours_conservative_dlr_above_static: number;
  summer_4to8pm_median_wind_gain_over_aar: number;
  hottest_hour: string; hottest_temp_c: number; hottest_hour_dlr_vs_static: number;
  /** 2025 median of temperature-adjusted rating (AAR) / static. Absent if not in summary.json. */
  median_aar_vs_static?: number;
  /** 2025 median of conservative DLR / AAR (what real wind adds over temperature alone). */
  median_wind_gain_over_aar?: number;
}

export interface GridData {
  plants: Plant[]; lines: Line[]; substations: Substation[]; cases: NicheCase[];
  events: GenEvent[]; ratingSites: RatingSiteSummary[];
}

export interface ScanArea { lat: number; lon: number; radius_mi: number }

export type KvBand = "500+" | "200-499" | "100-199" | "<100" | "unknown";

export interface RiskFactor {
  key: string; label: string; score: number; // 0..100
  weight: number; detail: string;            // weights sum to 1
}

export interface ScanResult {
  area: ScanArea;
  area_label: string;            // e.g. "Long Beach · near Haynes" (nearest plant city + name, else nearest rating site)
  inside_coverage: boolean;      // center within 100 mi of Westminster HS
  plants: Plant[];               // sorted by nameplate_mw desc
  lines: Line[];                 // any part inside the circle
  substations: Substation[];
  cases: NicheCase[];            // sorted by distance from center
  events: GenEvent[];            // retired + proposed inside circle
  totals: {
    plant_count: number; nameplate_mw: number; mw_by_source: Record<FuelKey, number>;
    renewable_mw: number; storage_mw: number; fossil_mw: number; renewable_pct: number; // renewable = solar+wind+hydro+biogas; storage = battery; fossil = natural_gas+oil+other_gas; pct of nameplate (0-100)
    cap_weighted_age: number | null; oldest: { name: string; year: number } | null;
    planned_retirement_mw: number; retired_mw: number; proposed_mw: number; proposed_storage_mw: number;
    line_miles: number; line_miles_by_kv: Record<KvBand, number>;
    substation_count: number; hv_substation_count: number; // hv = voltage_kv >= 200
    evening_cover_pct: number | null; // storage_mw / solar_mw * 100 (null if no solar) — "sunset handoff"
  };
  risk: { score: number; level: RiskLevel; factors: RiskFactor[] };
  rating_site: RatingSiteSummary & { distance_mi: number }; // nearest of the 7
  upgrade_ideas: string[];       // 2-5 rule-based, specific to this area's numbers
  elapsed_ms: number;            // time the scan took
}

export interface WeatherNow {
  temp_c: number; wind_ms: number; sun_wm2: number; time: string;
  source: "open-meteo-live" | "fallback-2025" | "heatwave-scenario";
}

export interface LineRatingNow {
  static_A: number; aar_A: number; dlr_A: number; dlr_conservative_A: number;
  ratio: number;        // dlr_conservative_A / static_A
  extra_pct: number;    // (ratio - 1) * 100, may be negative
  weather: WeatherNow;
}

export interface DailyRating { date: string; static_A: number; worst_A: number; median_A: number; max_temp_c: number }
