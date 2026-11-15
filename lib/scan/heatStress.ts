import nodesJson from "@/data/nodes.json";
import { simulate } from "@/lib/simulation";
import type { FacilityFeature } from "@/lib/types";
import {
  TRANSFORMER_DEFAULTS,
  initTransformerState,
  stepTransformer,
  transformerLossOfLifePct,
  type TransformerSpec,
} from "@/lib/physics/thermal";
import { haversineMi } from "./geo";
import type { ScanResult } from "./types";

/**
 * Heatwave stress for a scan circle.
 *
 * (a) Load centers: the seeded facilities in data/nodes.json run through
 *     lib/simulation.ts at baseline and with the 105 °F heatwave stress.
 * (b) Transformer aging: one generic substation transformer (assumptions
 *     below) run through the IEEE C57.91 model in lib/physics/thermal.ts on a
 *     normal day and on a 105 °F day.
 *
 * Both halves are modeled. Nothing here is measured at these assets.
 */

const NODES = nodesJson.features as unknown as FacilityFeature[];

/** Generic distribution-substation bank. Stated assumptions, not a real nameplate. */
export const GENERIC_TRANSFORMER: TransformerSpec = {
  id: "generic-substation",
  rating_mva: 28,
  hv_kv: 66,
  lv_kv: 12,
  ...TRANSFORMER_DEFAULTS, // ONAN, 55 K top-oil rise, 23 K hot-spot rise, 180 min oil tau, 35-yr design life
};

/** Day assumptions for the transformer run. */
export const DAY_ASSUMPTIONS = {
  normal: { peak_ambient_c: 24, peak_loading_pct: 75 }, // ~75 °F coastal summer day
  heatwave: { peak_ambient_c: 40.6, peak_loading_pct: 95 }, // 105 °F; air conditioning lifts the peak
  /** Overnight ambient is this many °C below the afternoon peak. */
  diurnal_swing_c: 11,
  /** Days simulated back to back; the last one is reported (thermal warm-up). */
  warmup_days: 3,
  step_hours: 0.25,
} as const;

export interface LoadCenterStress {
  /** Load centers summed. If none sit inside the circle this is the single nearest one. */
  nodes: { id: string; name: string; distance_mi: number }[];
  inside_circle: boolean;
  baseline_mw: number;
  heatwave_mw: number;
  baseline_co2_t_yr: number;
  heatwave_co2_t_yr: number;
  overloads: number;
}

export interface DayAging {
  peak_ambient_c: number;
  peak_loading_pct: number;
  peak_hotspot_c: number;
  /** Hours of rated (110 °C) insulation aging consumed in the day. */
  aging_hours: number;
  /** Percent of the design insulation life used in the day. */
  life_used_pct: number;
}

export interface TransformerStress {
  substations: number;
  spec: TransformerSpec;
  normal: DayAging;
  heatwave: DayAging;
  /** heatwave aging_hours / normal aging_hours. */
  aging_multiple: number;
}

export interface HeatStressResult {
  heatwave: boolean;
  loads: LoadCenterStress;
  transformer: TransformerStress;
}

function round(v: number, digits = 1): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

/** Load shape, 0..1 of peak: overnight trough, morning shoulder, 4 pm peak (same shape as dailyProfile). */
function loadShape(hour: number): number {
  const evening = Math.exp(-Math.pow((hour - 16) / 4.2, 2));
  const morning = 0.5 * Math.exp(-Math.pow((hour - 8) / 3, 2));
  return 0.72 + 0.28 * evening + 0.16 * morning;
}

/** Ambient: cosine with the minimum at 5 am and the peak at 3 pm-ish. */
function ambientAt(hour: number, peakC: number): number {
  const swing = DAY_ASSUMPTIONS.diurnal_swing_c;
  const phase = Math.cos(((hour - 15) / 24) * 2 * Math.PI);
  return peakC - swing / 2 + (swing / 2) * phase;
}

function runDay(spec: TransformerSpec, day: { peak_ambient_c: number; peak_loading_pct: number }): DayAging {
  const dt = DAY_ASSUMPTIONS.step_hours;
  const stepsPerDay = Math.round(24 / dt);
  let peakShape = 0;
  for (let i = 0; i < stepsPerDay; i += 1) peakShape = Math.max(peakShape, loadShape(i * dt));
  const peakMva = (spec.rating_mva * day.peak_loading_pct) / 100;

  let state = initTransformerState(ambientAt(0, day.peak_ambient_c));
  let peakHotspot = -Infinity;
  let agingHours = 0;
  for (let d = 0; d < DAY_ASSUMPTIONS.warmup_days; d += 1) {
    const last = d === DAY_ASSUMPTIONS.warmup_days - 1;
    for (let i = 0; i < stepsPerDay; i += 1) {
      const hour = i * dt;
      const load = (peakMva * loadShape(hour)) / peakShape;
      state = stepTransformer(spec, state, load, ambientAt(hour, day.peak_ambient_c), dt);
      if (last) {
        peakHotspot = Math.max(peakHotspot, state.hotspot_c);
        // Accumulate from the per-step aging factor: stepTransformer rounds the
        // running equivalent_aging_years to 5 decimals, which swallows a cool day.
        agingHours += state.aging_factor * dt;
      }
    }
  }
  return {
    peak_ambient_c: day.peak_ambient_c,
    peak_loading_pct: day.peak_loading_pct,
    peak_hotspot_c: round(peakHotspot, 1),
    aging_hours: round(agingHours, 3),
    life_used_pct: transformerLossOfLifePct(spec, agingHours / 8760),
  };
}

function loadCenters(result: ScanResult): LoadCenterStress {
  const { lat, lon, radius_mi } = result.area;
  const withDist = NODES.map((f) => ({
    f,
    d: haversineMi(lat, lon, f.geometry.coordinates[1], f.geometry.coordinates[0]),
  })).sort((a, b) => a.d - b.d);
  const inside = withDist.filter((x) => x.d <= radius_mi);
  const used = inside.length > 0 ? inside : withDist.slice(0, 1);

  let baseMw = 0, hwMw = 0, baseCo2 = 0, hwCo2 = 0, overloads = 0;
  for (const { f } of used) {
    const base = simulate(f.properties, { heatwave_active: false });
    const hw = simulate(f.properties, { heatwave_active: true });
    baseMw += base.effective_draw_mw;
    hwMw += hw.effective_draw_mw;
    baseCo2 += base.annual_co2_tons;
    hwCo2 += hw.annual_co2_tons;
    if (hw.overload) overloads += 1;
  }
  return {
    nodes: used.map(({ f, d }) => ({ id: f.properties.id, name: f.properties.name, distance_mi: round(d, 1) })),
    inside_circle: inside.length > 0,
    baseline_mw: round(baseMw, 1),
    heatwave_mw: round(hwMw, 1),
    baseline_co2_t_yr: Math.round(baseCo2),
    heatwave_co2_t_yr: Math.round(hwCo2),
    overloads,
  };
}

/** Pure: the same numbers come back for either toggle; `heatwave` only tells the UI how to frame them. */
export function heatStress(result: ScanResult, heatwave: boolean): HeatStressResult {
  const spec = GENERIC_TRANSFORMER;
  const normal = runDay(spec, DAY_ASSUMPTIONS.normal);
  const hot = runDay(spec, DAY_ASSUMPTIONS.heatwave);
  return {
    heatwave,
    loads: loadCenters(result),
    transformer: {
      substations: result.totals.substation_count,
      spec,
      normal,
      heatwave: hot,
      aging_multiple: normal.aging_hours > 0 ? round(hot.aging_hours / normal.aging_hours, 1) : 0,
    },
  };
}
