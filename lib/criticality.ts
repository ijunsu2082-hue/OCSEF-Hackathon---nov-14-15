import type { FacilityProperties } from "./types";

/**
 * Criticality (consequence) input for the Risk Index.
 *
 * The app has no customer, medical-baseline or critical-facility layer yet, so
 * the honest default is C = 3 and `assumed = true`. The interface is here so a
 * future census/OSM layer can supply the four documented inputs without
 * changing `lib/types.ts` or the risk contract.
 */
export interface CriticalityContext {
  downstreamPopulation?: number;
  criticalFacilities?: number;
  /** 0–1; 1 means the asset is a direct potable-water dependency. */
  waterServiceDependency?: number;
  /** 0–1 share of regional load. */
  mwShare?: number;
  /** Explicit override for a scenario or a test. */
  value?: number;
  assumed?: boolean;
  basis?: string;
}

export interface CriticalityComponent {
  label: string;
  value: number;
  weight: number;
}

export interface CriticalityResult {
  value: number; // 1–5
  assumed: boolean;
  basis: string;
  components: CriticalityComponent[];
  inputs: {
    downstream_population: number | null;
    critical_facilities: number | null;
    water_service_dependency: number | null;
    mw_share: number | null;
  };
}

export const DEFAULT_CRITICALITY = 3;
export const MAX_CRITICALITY = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Screening criticality. Without both population and critical-facility counts
 * this returns the default 3 and says so; it never invents a consequence.
 */
export function criticalityFor(
  properties: FacilityProperties,
  context: CriticalityContext = {},
): CriticalityResult {
  const population = finite(context.downstreamPopulation);
  const facilities = finite(context.criticalFacilities);
  const water = finite(context.waterServiceDependency);
  const mwShare = finite(context.mwShare);
  const override = finite(context.value);

  const inputs = {
    downstream_population: population,
    critical_facilities: facilities,
    water_service_dependency: water,
    mw_share: mwShare,
  };

  if (override !== null) {
    return {
      value: round1(clamp(override, 1, MAX_CRITICALITY)),
      assumed: context.assumed ?? false,
      basis: context.basis ?? "Explicit criticality input.",
      components: [],
      inputs,
    };
  }

  if (population !== null && facilities !== null) {
    const populationScore = clamp(Math.log10(Math.max(1, population)) / 6, 0, 1);
    const facilityScore = clamp(facilities / 20, 0, 1);
    const waterScore = water ?? 0.5;
    const mwScore = mwShare ?? 0;
    const raw =
      0.5 * populationScore +
      0.25 * facilityScore +
      0.15 * waterScore +
      0.1 * mwScore;

    return {
      value: round1(clamp(1 + 4 * raw, 1, MAX_CRITICALITY)),
      assumed: false,
      basis:
        "Computed from downstream population, critical facilities, water-service dependency and MW share.",
      components: [
        { label: "Population", value: population, weight: 0.5 },
        { label: "Critical facilities", value: facilities, weight: 0.25 },
        { label: "Water dependency", value: waterScore, weight: 0.15 },
        { label: "MW share", value: mwScore, weight: 0.1 },
      ],
      inputs,
    };
  }

  return {
    value: DEFAULT_CRITICALITY,
    assumed: true,
    basis: `No customer or critical-facility layer loaded for ${properties.name}; screening default C = 3.`,
    components: [],
    inputs,
  };
}
