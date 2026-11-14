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
    key: "age", label: "Age of generation", weight: 0.25,
    score: age === null ? 0 : round(clamp(((age - 10) / 40) * 100), 0),
    detail: age === null
      ? "No power plants in this circle."
      : `Capacity-weighted age is ${fmt(age, 1)} years across ${t.plant_count} plant${t.plant_count === 1 ? "" : "s"}.`,
  });

  // 2. Fossil dependence
  const fossilPct = t.nameplate_mw > 0 ? (t.fossil_mw / t.nameplate_mw) * 100 : 0;
  factors.push({
    key: "fossil", label: "Fossil dependence", weight: 0.2,
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
    key: "turnover", label: "Retirement / turnover exposure", weight: 0.15,
    score: round(clamp((turnover / Math.max(t.nameplate_mw, 1)) * 200), 0),
    detail: `${fmt(t.planned_retirement_mw)} MW is planned to retire and ${fmt(retiredRecent)} MW retired since ${RETIRED_SINCE_YEAR}. ${fmt(t.nameplate_mw)} MW is operating.`,
  });

  // 4. Heat stress on wires (nearest rating site, MODELED)
  const heatwave = opts?.heatwave === true;
  const ratio = heatwave
    ? rateLine(heatwaveWeather()).ratio
    : Number.isFinite(site.hottest_hour_dlr_vs_static) ? site.hottest_hour_dlr_vs_static : 1.5;
  factors.push({
    key: "heat", label: "Heat stress on wires", weight: 0.15,
    score: round(clamp(((1.5 - ratio) / 0.6) * 100), 0),
    detail: heatwave
      ? `In a 105 °F heatwave the safe rating drops to ${ratio.toFixed(2)}× the fixed rating.`
      : `On the hottest 2025 hour at ${site.name} (${fmt(site.hottest_temp_c, 1)} °C) the safe rating was ${ratio.toFixed(2)}× the fixed rating.`,
  });

  // 5. Hazard history
  const hazards = cases.filter((c) => HAZARD_CATEGORIES.has(c.category));
  factors.push({
    key: "hazard", label: "Hazard history", weight: 0.15,
    score: Math.min(100, hazards.length * 35),
    detail: hazards.length
      ? `${hazards.length} wildfire, gas or heat case${hazards.length === 1 ? "" : "s"} here: ${hazards.map((c) => c.title).slice(0, 3).join("; ")}.`
      : "No wildfire, gas or heat cases in this circle.",
  });

  // 6. Grid thinness
  const hv = t.hv_substation_count;
  const empty = t.plant_count === 0 && lineCount === 0;
  factors.push({
    key: "thinness", label: "Grid thinness", weight: 0.1,
    score: empty ? 20 : hv === 0 ? 70 : hv === 1 ? 45 : hv === 2 ? 25 : 10,
    detail: empty
      ? "No plants or lines mapped here, so there is little grid to stress."
      : `${hv} substation${hv === 1 ? "" : "s"} at 200 kV or higher, ${t.substation_count} in total.`,
  });

  const score = round(factors.reduce((s, f) => s + f.score * f.weight, 0), 0);
  return { score, level: riskLevel(score), factors };
}
