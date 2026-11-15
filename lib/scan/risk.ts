import type { GenEvent, NicheCase, RatingSiteSummary, RiskFactor, RiskLevel, ScanResult } from "./types";
import { clamp, round } from "./geo";
import { heatwaveWeather, rateLine } from "./rating";

type Totals = ScanResult["totals"];

export const HAZARD_CATEGORIES = new Set(["Wildfire", "Gas", "Heat"]);
export const RETIRED_SINCE_YEAR = 2015;

export function riskLevel(score: number): RiskLevel {
  if (score < 30) return "LOW";
  if (score < 50) return "WATCH";
  if (score < 70) return "HIGH";
  return "CRITICAL";
}

const fmt = (x: number, d = 0) => round(x, d).toLocaleString("en-US");

/**
 * Factor weights (sum to 1). These are our own judgment calls, not fitted to
 * outage data; riskRange() shows how much the score moves if they change.
 */
export const WEIGHTS = {
  age: { weight: 0.25, reason: "Older plants break down more and are the next to retire." },
  fossil: { weight: 0.2, reason: "Gas and oil plants face retirement rules and fuel price swings." },
  turnover: { weight: 0.15, reason: "Capacity that retires has to be replaced before it goes offline." },
  heat: { weight: 0.15, reason: "Hot, still air lowers how much power a wire can safely carry." },
  hazard: { weight: 0.15, reason: "Past fires, gas leaks or heat events show local exposure, but our story list is not complete." },
  thinness: { weight: 0.1, reason: "Few high-voltage substations means fewer backup paths if one fails." },
} as const satisfies Record<string, { weight: number; reason: string }>;

export type RiskWeightKey = keyof typeof WEIGHTS;

/** Hazard factor score by story count: capped so one story cannot push it to 100. */
export function hazardScore(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 25;
  if (count === 2) return 45;
  if (count === 3) return 60;
  return 70;
}

/**
 * Lowest and highest area score if every weight is moved by up to plus or minus
 * 50% (then rescaled so they sum to 1). The weighted average is a ratio of two
 * linear functions of the weights, so its extremes sit on the corners of that
 * box: we check all 2^n corners. Deterministic. Returns rounded whole numbers.
 */
export function riskRange(input: Pick<RiskFactor, "score" | "weight">[] | { factors: Pick<RiskFactor, "score" | "weight">[] }): { min: number; max: number } {
  const factors = Array.isArray(input) ? input : input.factors;
  const n = factors.length;
  if (n === 0) return { min: 0, max: 0 };
  let min = Infinity, max = -Infinity;
  for (let mask = 0; mask < 1 << n; mask++) {
    let ws = 0, s = 0;
    for (let i = 0; i < n; i++) {
      const w = factors[i].weight * ((mask >> i) & 1 ? 1.5 : 0.5);
      ws += w;
      s += w * factors[i].score;
    }
    const v = ws > 0 ? s / ws : 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min: round(min, 0), max: round(max, 0) };
}

export function computeRisk(
  t: Totals,
  site: RatingSiteSummary,
  cases: NicheCase[],
  events: GenEvent[],
  lineCount: number,
  opts?: { heatwave?: boolean },
): ScanResult["risk"] {
  const factors: RiskFactor[] = [];

  // 1. Age of generation
  const age = t.cap_weighted_age;
  factors.push({
    key: "age", label: "Age of generation", weight: WEIGHTS.age.weight,
    score: age === null ? 0 : round(clamp(((age - 10) / 40) * 100), 0),
    detail: age === null
      ? "No power plants in this circle."
      : `Capacity-weighted age is ${fmt(age, 1)} years across ${t.plant_count} plant${t.plant_count === 1 ? "" : "s"}.`,
  });

  // 2. Fossil dependence
  const fossilPct = t.nameplate_mw > 0 ? (t.fossil_mw / t.nameplate_mw) * 100 : 0;
  factors.push({
    key: "fossil", label: "Fossil dependence", weight: WEIGHTS.fossil.weight,
    score: round(clamp(fossilPct), 0),
    detail: t.nameplate_mw > 0
      ? `${fmt(t.fossil_mw)} of ${fmt(t.nameplate_mw)} MW is gas or oil (${fmt(fossilPct)}% of nameplate).`
      : "No nameplate capacity in this circle.",
  });

  // 3. Retirement / turnover exposure
  const retiredRecent = events
    .filter((e) => e.kind === "retired" && e.year !== null && e.year >= RETIRED_SINCE_YEAR)
    .reduce((s, e) => s + (Number.isFinite(e.mw) ? e.mw : 0), 0);
  const turnover = t.planned_retirement_mw + retiredRecent;
  factors.push({
    key: "turnover", label: "Retirement / turnover exposure", weight: WEIGHTS.turnover.weight,
    score: round(clamp((turnover / Math.max(t.nameplate_mw, 1)) * 200), 0),
    detail: `${fmt(t.planned_retirement_mw)} MW is planned to retire and ${fmt(retiredRecent)} MW retired since ${RETIRED_SINCE_YEAR}. ${fmt(t.nameplate_mw)} MW is operating.`,
  });

  // 4. Heat stress on wires (nearest rating site, MODELED)
  const heatwave = opts?.heatwave === true;
  const ratio = heatwave
    ? rateLine(heatwaveWeather()).ratio
    : Number.isFinite(site.hottest_hour_dlr_vs_static) ? site.hottest_hour_dlr_vs_static : 1.5;
  factors.push({
    key: "heat", label: "Heat stress on wires", weight: WEIGHTS.heat.weight,
    score: round(clamp(((1.5 - ratio) / 0.6) * 100), 0),
    detail: heatwave
      ? `In a 105 °F heatwave the safe rating drops to ${ratio.toFixed(2)}× the fixed rating.`
      : `On the hottest 2025 hour at ${site.name} (${fmt(site.hottest_temp_c, 1)} °C) the safe rating was ${ratio.toFixed(2)}× the fixed rating.`,
  });

  // 5. Past incidents nearby. Counts stories from our own sourced list, so it is
  // capped (1 = 25, 2 = 45, 3 = 60, 4+ = 70) and never reaches 100 on its own.
  const hazards = cases.filter((c) => HAZARD_CATEGORIES.has(c.category));
  const capNote = "We picked these stories ourselves, so this factor is capped at 70 and an empty list does not mean nothing happened.";
  factors.push({
    key: "hazard", label: "Past incidents nearby (from our sourced stories)", weight: WEIGHTS.hazard.weight,
    score: hazardScore(hazards.length),
    detail: hazards.length
      ? `${hazards.length} wildfire, gas or heat stor${hazards.length === 1 ? "y" : "ies"} in our list for this circle: ${hazards.map((c) => c.title).slice(0, 3).join("; ")}. ${capNote}`
      : `No wildfire, gas or heat stories in our list for this circle. ${capNote}`,
  });

  // 6. Grid thinness
  const hv = t.hv_substation_count;
  const empty = t.plant_count === 0 && lineCount === 0;
  factors.push({
    key: "thinness", label: "Grid thinness", weight: WEIGHTS.thinness.weight,
    score: empty ? 20 : hv === 0 ? 70 : hv === 1 ? 45 : hv === 2 ? 25 : 10,
    detail: empty
      ? "No plants or lines mapped here, so there is little grid to stress."
      : `${hv} substation${hv === 1 ? "" : "s"} at 200 kV or higher, ${t.substation_count} in total.`,
  });

  const score = round(factors.reduce((s, f) => s + f.score * f.weight, 0), 0);
  return { score, level: riskLevel(score), factors };
}
