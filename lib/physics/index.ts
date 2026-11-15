/**
 * Physical grid model — public surface.
 *
 * Import everything from `@/lib/physics`:
 *
 *   import { runMunicipality, radialPowerFlow, frequencyEvent } from "@/lib/physics";
 *
 * The modules are pure TypeScript with no runtime dependencies. `units`,
 * `network`, `thermal`, `dynamics`, `load` and `economics` are the reusable
 * physics primitives; `municipality` is the scenario engine that composes them
 * into annual and design-day statistics.
 */

export * from "./units";
export * from "./network";
export * from "./thermal";
export * from "./dynamics";
export * from "./load";
export * from "./economics";
export * from "./municipalityTypes";
export { buildMunicipality, buildWeather, runMunicipality } from "./municipality";
