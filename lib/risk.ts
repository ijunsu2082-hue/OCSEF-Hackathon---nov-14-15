import type { FacilityProperties } from "./types";

export type RiskBucket = "LOW" | "WATCH" | "HIGH" | "CRITICAL";

export interface RiskEntry {
  score: number;
  bucket: RiskBucket;
  color: string;
}

export const RISK_COLORS: Record<RiskBucket, string> = {
  LOW: "#2DD4A7",
  WATCH: "#E8A33D",
  HIGH: "#F97316",
  CRITICAL: "#F04D5E",
};

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function riskBucket(score: number): RiskBucket {
  if (score < 35) return "LOW";
  if (score < 60) return "WATCH";
  if (score < 80) return "HIGH";
  return "CRITICAL";
}

/**
 * Energy Risk Score — 0–100, higher is worse.
 * 40% fossil exposure · 25% carbon intensity · 20% motor inefficiency · 15% age.
 * Heatwave mode recomputes against the stressed carbon intensity and adds a
 * flat +8 stress penalty. Display-only: never mutates stored properties.
 */
export function energyRisk(
  properties: FacilityProperties,
  options: { heatwave?: boolean } = {},
): number {
  const heatwave = options.heatwave ?? false;
  const mix = properties.energy_profile.source_mix;
  const fossilShare = (100 - mix.solar - mix.hydro - mix.wind) / 100;
  const ci =
    properties.energy_profile.carbon_intensity_gco2_kwh * (heatwave ? 1.25 : 1);
  const motorEff = properties.infrastructure.motor_efficiency_rating;
  const age = properties.infrastructure.age_years;

  let score =
    40 * fossilShare +
    25 * clamp((ci - 200) / 200, 0, 1) +
    20 * clamp((0.85 - motorEff) / 0.35, 0, 1) +
    15 * clamp((age - 20) / 60, 0, 1);

  if (heatwave) score += 8;
  return Math.round(score * 10) / 10;
}
