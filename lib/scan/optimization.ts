/**
 * Deterministic optimization workflow for one area scan.
 *
 * The workflow is a fixed sequence of steps a planner works through. Every
 * step reads named scan inputs, applies one written rule with fixed
 * thresholds, and returns a verdict plus the planner's next action. Nothing
 * is random, learned or weighted: the same scan always yields the same steps,
 * verdicts and shortlist. Pure — no I/O, no clock.
 *
 * The thresholds are screening rules for a hackathon tool, not engineering
 * criteria. Each one is exported in RULES so the UI and tests show the exact
 * number being applied.
 */
import type { DailyRating, LineRatingNow, ScanResult } from "./types";

export type Objective = "transfer" | "resilience" | "emissions" | "cost";

export const OBJECTIVES: Record<Objective, string> = {
  transfer: "Increase transfer capability",
  resilience: "Improve reliability and resilience",
  emissions: "Reduce operating emissions",
  cost: "Minimize lifecycle cost",
};

/** Every threshold the workflow uses, in one place. */
export const RULES = {
  /** S1: a scan needs at least this many mapped line miles to screen anything. */
  minLineMiles: 1,
  /** S2: transmission screen applies when HV (>= 200 kV) line miles reach this, or any HV substation exists. */
  minHvLineMiles: 1,
  /** S3: weather site farther than this is too far to stand in for the area. */
  maxWeatherSiteMi: 25,
  /** S3: strong weather-rating case — modeled rating above the fixed rating at least this share of hours (0–100)... */
  dlrStrongPctHours: 50,
  /** ...and a median modeled/fixed ratio of at least this. */
  dlrStrongMedianRatio: 1.1,
  /** S3: weak case — above the fixed rating at least this share of hours. */
  dlrWeakPctHours: 20,
  /** S4: a day is a "short day" when its worst-hour modeled rating is below this fraction of the fixed rating. */
  shortDayRatio: 1.0,
  /** S4: reconductoring is a candidate when short days reach this share of days with data (0–100). */
  reconductorShortDayPct: 10,
  /** S5: storage screen needs at least this much solar nameplate in the circle (MW). */
  minSolarMw: 50,
  /** S5: storage is a candidate when battery nameplate is below this share of solar nameplate (0–100). */
  storageCoverTargetPct: 50,
} as const;

export type Verdict = "pass" | "candidate" | "weak" | "not_supported" | "not_applicable" | "needs_data" | "stop";

export type OptionId = "weather_rating" | "storage" | "reconductor" | "new_line";

export interface StepInput { label: string; value: string }

export interface WorkflowStep {
  id: string;
  title: string;
  /** What the planner does in this step. */
  task: string;
  /** The rule, written out with its thresholds. */
  rule: string;
  inputs: StepInput[];
  verdict: Verdict;
  /** One sentence: why this verdict. */
  finding: string;
  /** What the planner does next because of this verdict. */
  next: string;
  /** Option this step screens, if any. */
  option?: OptionId;
}

export interface ShortlistItem {
  option: OptionId;
  title: string;
  verdict: Verdict;
  why: string;
  firstAction: string;
}

export interface Workflow {
  steps: WorkflowStep[];
  /** True when step 1 stopped the workflow; later steps are not evaluated. */
  stopped: boolean;
  shortlist: ShortlistItem[];
  objective: Objective;
}

export const OPTION_TITLES: Record<OptionId, string> = {
  weather_rating: "Weather-based line rating",
  storage: "Battery storage at the solar handoff",
  reconductor: "Reconductor with a high-temperature, low-sag wire",
  new_line: "New transmission line",
};

/**
 * Fixed option order per objective. Ties never happen: the shortlist keeps
 * this order and only drops options whose screen did not support them.
 * Default ("transfer", "cost") puts the least new construction first.
 */
export const OPTION_ORDER: Record<Objective, OptionId[]> = {
  transfer: ["weather_rating", "reconductor", "storage", "new_line"],
  cost: ["weather_rating", "storage", "reconductor", "new_line"],
  resilience: ["storage", "reconductor", "weather_rating", "new_line"],
  emissions: ["storage", "weather_rating", "reconductor", "new_line"],
};

const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d).replace(/\.0+$/, "") : "unknown");
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Share of days (0–100) whose worst-hour modeled rating falls below RULES.shortDayRatio × fixed rating. */
export function shortDayPct(daily: DailyRating[] | null | undefined): { pct: number; days: number } | null {
  const usable = (daily ?? []).filter((d) => isNum(d.worst_A) && isNum(d.static_A) && d.static_A > 0);
  if (!usable.length) return null;
  const short = usable.filter((d) => d.worst_A / d.static_A < RULES.shortDayRatio).length;
  return { pct: (short / usable.length) * 100, days: usable.length };
}

export function buildWorkflow(
  result: ScanResult,
  opts: { live?: LineRatingNow | null; daily?: DailyRating[] | null; objective?: Objective } = {},
): Workflow {
  const objective = opts.objective ?? "transfer";
  const t = result.totals;
  const site = result.rating_site;
  const steps: WorkflowStep[] = [];

  // S1 — scope
  const inScope = result.inside_coverage && t.line_miles >= RULES.minLineMiles;
  steps.push({
    id: "scope",
    title: "Confirm the area can be screened",
    task: "Check that the circle is inside the data coverage and contains mapped power lines.",
    rule: `Continue only if the center is inside coverage and the circle has at least ${RULES.minLineMiles} mi of mapped line.`,
    inputs: [
      { label: "Inside coverage", value: result.inside_coverage ? "yes" : "no" },
      { label: "Mapped line miles", value: `${fmt(t.line_miles)} mi` },
    ],
    verdict: inScope ? "pass" : "stop",
    finding: !result.inside_coverage
      ? "The center is outside the 100-mile data coverage."
      : inScope
        ? `${fmt(t.line_miles)} mi of mapped line is enough to screen.`
        : `Only ${fmt(t.line_miles)} mi of mapped line; too little to screen.`,
    next: inScope
      ? "Go to step 2."
      : result.inside_coverage
        ? "Widen the radius or move the circle onto mapped lines, then rescan."
        : "Move the circle inside the coverage area, then rescan.",
  });
  if (!inScope) return { steps, stopped: true, shortlist: [], objective };

  // S2 — transmission relevance
  const hvMiles = (t.line_miles_by_kv["200-499"] ?? 0) + (t.line_miles_by_kv["500+"] ?? 0);
  const isTransmission = hvMiles >= RULES.minHvLineMiles || t.hv_substation_count > 0;
  steps.push({
    id: "voltage",
    title: "Decide whether this is a transmission problem",
    task: "Check whether the circle holds high-voltage (200 kV and up) lines or substations, where curtailment bottlenecks sit.",
    rule: `Transmission screens (steps 3–4) apply if HV line miles are at least ${RULES.minHvLineMiles} mi or there is any HV substation.`,
    inputs: [
      { label: "HV line miles (≥ 200 kV)", value: `${fmt(hvMiles)} mi` },
      { label: "HV substations", value: String(t.hv_substation_count) },
    ],
    verdict: isTransmission ? "pass" : "not_applicable",
    finding: isTransmission
      ? `${fmt(hvMiles)} mi of HV line and ${t.hv_substation_count} HV substation${t.hv_substation_count === 1 ? "" : "s"} in the circle.`
      : "No high-voltage assets are mapped here; this is a local distribution area.",
    next: isTransmission
      ? "Go to step 3."
      : "Skip steps 3–4. Ask the local utility for its hosting-capacity map, then go to step 5.",
  });

  // S3 — weather-based rating
  const P = site.pct_hours_conservative_dlr_above_static;
  const M = site.median_conservative_dlr_vs_static;
  let s3: Verdict;
  let s3Finding: string;
  if (!isTransmission) {
    s3 = "not_applicable";
    s3Finding = "Skipped: no high-voltage lines to re-rate.";
  } else if (site.distance_mi > RULES.maxWeatherSiteMi) {
    s3 = "needs_data";
    s3Finding = `The nearest modeled weather site is ${fmt(site.distance_mi)} mi away, beyond ${RULES.maxWeatherSiteMi} mi.`;
  } else if (P >= RULES.dlrStrongPctHours && M >= RULES.dlrStrongMedianRatio) {
    s3 = "candidate";
    s3Finding = `The modeled rating beat the fixed rating in ${fmt(P)}% of 2025 hours, with a median of ${fmt(M, 2)}×.`;
  } else if (P >= RULES.dlrWeakPctHours) {
    s3 = "weak";
    s3Finding = `The modeled rating beat the fixed rating in ${fmt(P)}% of hours; the median is only ${fmt(M, 2)}×.`;
  } else {
    s3 = "not_supported";
    s3Finding = `The modeled rating beat the fixed rating in only ${fmt(P)}% of hours.`;
  }
  const liveInputs: StepInput[] = opts.live
    ? [{ label: "Right now (live weather)", value: `${fmt(opts.live.ratio, 2)}× the fixed rating` }]
    : [];
  steps.push({
    id: "weather_rating",
    option: "weather_rating",
    title: "Screen a weather-based line rating",
    task: "Check how often real weather lets the lines carry more than their fixed worst-day limit.",
    rule: `Candidate if the modeled rating beats the fixed rating in at least ${RULES.dlrStrongPctHours}% of hours and the median ratio is at least ${RULES.dlrStrongMedianRatio}×. Weak if at least ${RULES.dlrWeakPctHours}% of hours. Needs data if the weather site is over ${RULES.maxWeatherSiteMi} mi away.`,
    inputs: [
      { label: "Weather site", value: `${site.name}, ${fmt(site.distance_mi)} mi away` },
      { label: "Hours above fixed rating (2025)", value: `${fmt(P)}%` },
      { label: "Median modeled / fixed", value: `${fmt(M, 2)}×` },
      ...liveInputs,
    ],
    verdict: s3,
    finding: s3Finding,
    next: {
      candidate: "Ask the line owner for its ambient-adjusted ratings and whether it would pilot wind-based ratings on these lines.",
      weak: "Keep as a backup. Check whether the hours above the fixed rating line up with curtailment hours (spring middays).",
      not_supported: "Drop this option for this area.",
      needs_data: "Find a weather station within the circle before relying on this option.",
      not_applicable: "Go to step 5.",
    }[s3 as "candidate" | "weak" | "not_supported" | "needs_data" | "not_applicable"],
  });

  // S4 — reconductoring (hot-day shortfall)
  const sd = shortDayPct(opts.daily);
  const hottest = site.hottest_hour_dlr_vs_static;
  let s4: Verdict;
  let s4Finding: string;
  if (!isTransmission) {
    s4 = "not_applicable";
    s4Finding = "Skipped: no high-voltage lines to rebuild.";
  } else if (!sd) {
    s4 = "needs_data";
    s4Finding = "Daily 2025 ratings for this site did not load.";
  } else if (sd.pct >= RULES.reconductorShortDayPct || hottest < RULES.shortDayRatio) {
    s4 = "candidate";
    s4Finding = `On ${fmt(sd.pct)}% of ${sd.days} days the worst hour fell below the fixed rating (hottest hour ${fmt(hottest, 2)}×). Weather alone can't cover those days.`;
  } else {
    s4 = "not_supported";
    s4Finding = `Only ${fmt(sd.pct)}% of ${sd.days} days fell below the fixed rating, and the hottest hour still reached ${fmt(hottest, 2)}×. A weather-based rating covers the gap first.`;
  }
  steps.push({
    id: "reconductor",
    option: "reconductor",
    title: "Screen reconductoring for hot days",
    task: "Count the days when even real weather would push the line below its fixed limit — the days a better wire is needed.",
    rule: `Candidate if at least ${RULES.reconductorShortDayPct}% of days have a worst-hour rating below ${RULES.shortDayRatio}× the fixed rating, or the hottest hour of the year is below ${RULES.shortDayRatio}×.`,
    inputs: [
      { label: "Days below fixed rating", value: sd ? `${fmt(sd.pct)}% of ${sd.days}` : "unknown" },
      { label: "Hottest hour modeled / fixed", value: `${fmt(hottest, 2)}× (${site.hottest_hour})` },
    ],
    verdict: s4,
    finding: s4Finding,
    next: {
      candidate: "Ask the line owner for conductor type, age and tower limits, and whether the line is in its SB 1006 reconductoring study.",
      not_supported: "Drop for now; revisit if the weather-based rating is refused.",
      needs_data: "Reload the scan; if daily ratings stay missing, screen with the hottest-hour ratio alone.",
      not_applicable: "Go to step 5.",
    }[s4 as "candidate" | "not_supported" | "needs_data" | "not_applicable"],
  });

  // S5 — storage at the solar handoff
  const solar = t.mw_by_source.solar ?? 0;
  const cover = t.evening_cover_pct;
  const needMw = Math.max(0, (RULES.storageCoverTargetPct / 100) * solar - t.storage_mw);
  let s5: Verdict;
  let s5Finding: string;
  if (solar < RULES.minSolarMw) {
    s5 = "not_applicable";
    s5Finding = `Only ${fmt(solar)} MW of solar is mapped; below ${RULES.minSolarMw} MW.`;
  } else if ((cover ?? 0) < RULES.storageCoverTargetPct) {
    s5 = "candidate";
    s5Finding = `Battery nameplate is ${fmt(cover ?? 0)}% of ${fmt(solar, 0)} MW solar. Reaching ${RULES.storageCoverTargetPct}% needs about ${fmt(needMw, 0)} MW more.`;
  } else {
    s5 = "not_supported";
    s5Finding = `Battery nameplate is already ${fmt(cover ?? 0)}% of solar.`;
  }
  steps.push({
    id: "storage",
    option: "storage",
    title: "Screen battery storage",
    task: "Check whether there is enough battery capacity to soak up midday solar instead of throwing it away.",
    rule: `Candidate if solar is at least ${RULES.minSolarMw} MW and battery nameplate is below ${RULES.storageCoverTargetPct}% of solar. Size = ${RULES.storageCoverTargetPct}% of solar minus existing batteries (rule of thumb, not a study).`,
    inputs: [
      { label: "Solar nameplate", value: `${fmt(solar, 0)} MW` },
      { label: "Battery nameplate", value: `${fmt(t.storage_mw, 0)} MW` },
      { label: "Battery / solar", value: cover === null ? "no solar" : `${fmt(cover)}%` },
    ],
    verdict: s5,
    finding: s5Finding,
    next: {
      candidate: `Look for sites for about ${fmt(needMw, 0)} MW of 4-hour batteries next to the largest solar plants; get interval load and output data.`,
      not_supported: "Drop; storage already matches the solar here.",
      not_applicable: "Go to step 6.",
    }[s5 as "candidate" | "not_supported" | "not_applicable"],
  });

  // S6 — new line (last resort) + projects already in the queue
  const newLine: Verdict = isTransmission && s3 !== "candidate" && s4 === "candidate" ? "candidate" : "not_supported";
  steps.push({
    id: "new_line",
    option: "new_line",
    title: "Decide whether a new line is needed",
    task: "Only consider a new line when the cheaper fixes don't cover the gap, and count projects already proposed.",
    rule: "Candidate only if this is a transmission area, the weather-based rating is not a candidate, and reconductoring is a candidate.",
    inputs: [
      { label: "Weather-based rating", value: s3 },
      { label: "Reconductoring", value: s4 },
      { label: "Already proposed in the circle", value: `${fmt(t.proposed_mw, 0)} MW (${fmt(t.proposed_storage_mw, 0)} MW storage)` },
      { label: "Planned retirements", value: `${fmt(t.planned_retirement_mw, 0)} MW` },
    ],
    verdict: newLine,
    finding: newLine === "candidate"
      ? "Weather can't add enough headroom and the line is short on hot days."
      : "A cheaper option covers the gap, or no high-voltage bottleneck was found.",
    next: newLine === "candidate"
      ? "Ask CAISO whether a project here is in its transmission plan before proposing a new one."
      : t.proposed_mw > 0
        ? `Prioritize connecting the ${fmt(t.proposed_mw, 0)} MW already proposed here.`
        : "No new line needed at this screening stage.",
  });

  // Shortlist — fixed order per objective, only options that screened in.
  const byOption = new Map(steps.filter((s) => s.option).map((s) => [s.option as OptionId, s]));
  const keep: Verdict[] = ["candidate", "weak"];
  const shortlist = OPTION_ORDER[objective]
    .map((id) => byOption.get(id))
    .filter((s): s is WorkflowStep => !!s && keep.includes(s.verdict))
    .map((s) => ({ option: s.option as OptionId, title: OPTION_TITLES[s.option as OptionId], verdict: s.verdict, why: s.finding, firstAction: s.next }));

  return { steps, stopped: false, shortlist, objective };
}
