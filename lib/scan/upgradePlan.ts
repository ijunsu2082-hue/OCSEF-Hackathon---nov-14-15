/**
 * Area upgrade plan.
 *
 * One area scan in, a small set of levers out. The UI asks which lever to work
 * on, then shows only that lever's numbers, fix and steps. Every sentence is
 * built from this circle's inventory, rating site and documented cases, and the
 * steps differ per lever and per place: who is named, what is requested, and how
 * many steps there are all come from the data.
 *
 * Pure and deterministic: the same scan always yields the same plan.
 */
import { haversineMi } from "./geo";
import { grantFeed, matchGrants, stateForArea } from "./grants";
import type { GrantFeed, GrantMatch } from "./grants";
import type { DailyRating, LineRatingNow, ScanResult } from "./types";

export type ImprovementSeverity = "critical" | "high" | "medium" | "low";
export type StepKind = "ask" | "request" | "model" | "meet" | "file" | "test" | "build" | "fund";

export interface UpgradeStep {
  kind: StepKind;
  title: string;
  /** Named counterparty from the scan, or a role when the data has none. */
  who: string;
  when: string;
  detail: string;
  /** One short line: the artifact that exists at the end. */
  done: string;
}

export interface Improvement {
  id: string;
  /** Chooser label, two or three words. */
  label: string;
  /** Short imperative headline for this lever. */
  headline: string;
  severity: ImprovementSeverity;
  score: number;
  /** One sentence, with this circle's own figures. */
  finding: string;
  metrics: { label: string; value: string }[];
  /** Named assets in this circle that the claim rests on. */
  evidence: string[];
  /** What "improved" means, in one line. */
  target: string;
  /** One sentence on the intervention. */
  how: string;
  /** One sentence on what it costs you. */
  tradeoff: string;
  steps: UpgradeStep[];
  /** Watched sources that cover this lever and this circle's state. */
  funding: GrantMatch[];
}

/** A lever before its funding is matched against the watched artifact. */
type Lever = Omit<Improvement, "funding">;

export interface UpgradePlan {
  summary: string;
  facts: { label: string; value: string }[];
  operators: { name: string; basis: string }[];
  improvements: Improvement[];
  /** State the funding filter used; null when the circle is outside every region. */
  state: string | null;
  /** Provenance of the watched grant artifact. */
  grants: GrantFeed;
  /** Records the plan asks for, not things it assumes. */
  needData: string[];
  caveats: string[];
}

const WHEN = ["Week 1", "Weeks 2-4", "Months 2-3", "Months 3-6", "Months 6-12"] as const;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const n0 = (v: number) => Math.round(v).toLocaleString("en-US");
const n1 = (v: number) => v.toFixed(1);
const pct0 = (v: number) => `${Math.round(v)}%`;
const clip = (text: string, max: number) => {
  const first = text.split(/(?<=\.)\s/)[0] ?? text;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
};

function severityOf(score: number): ImprovementSeverity {
  if (score >= 80) return "critical";
  if (score >= 65) return "high";
  if (score >= 50) return "medium";
  return "low";
}

const SHORT_DAY_RATIO = 1;

function shortDays(daily: DailyRating[] | null): { pct: number; days: number } | null {
  const usable = (daily ?? []).filter((day) => isNum(day.worst_A) && isNum(day.static_A) && day.static_A > 0);
  if (!usable.length) return null;
  const short = usable.filter((day) => day.worst_A / day.static_A < SHORT_DAY_RATIO).length;
  return { pct: (short / usable.length) * 100, days: usable.length };
}

/* ------------------------------------------------------------ place context */

/** "Seal Beach · near X" -> "Seal Beach". */
function placeName(result: ScanResult): string {
  const label = result.area_label.split(" · ")[0].replace(/ area$/, "").trim();
  return label || "this circle";
}

function dominantVoltage(result: ScanResult): string {
  const totals = result.totals.line_miles_by_kv;
  return totals["500+"] > totals["200-499"] ? "500 kV and up" : "200-499 kV";
}

function gridOperator(result: ScanResult): string | null {
  const counts = new Map<string, number>();
  for (const line of result.lines) {
    const name = line.operator?.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const sub of result.substations) {
    const name = sub.operator?.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function generationOwner(result: ScanResult): string | null {
  const byUtility = new Map<string, number>();
  for (const plant of result.plants) {
    const name = plant.utility_name?.trim();
    if (!name) continue;
    byUtility.set(name, (byUtility.get(name) ?? 0) + plant.nameplate_mw);
  }
  return [...byUtility.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function areaOperators(result: ScanResult): { name: string; basis: string }[] {
  const records = new Map<string, number>();
  for (const line of result.lines) {
    const name = line.operator?.trim();
    if (name) records.set(name, (records.get(name) ?? 0) + 1);
  }
  for (const sub of result.substations) {
    const name = sub.operator?.trim();
    if (name) records.set(name, (records.get(name) ?? 0) + 1);
  }
  const mw = new Map<string, number>();
  for (const plant of result.plants) {
    const name = plant.utility_name?.trim();
    if (name) mw.set(name, (mw.get(name) ?? 0) + plant.nameplate_mw);
  }
  return [...new Set([...records.keys(), ...mw.keys()])]
    .map((name) => {
      const count = records.get(name) ?? 0;
      const megawatts = mw.get(name) ?? 0;
      const basis = [
        count ? `${count} line/substation record${count === 1 ? "" : "s"}` : "",
        megawatts ? `${n0(megawatts)} MW plant` : "",
      ].filter(Boolean).join("; ");
      return { name, basis, grid: count > 0, weight: count * 1000 + megawatts };
    })
    .sort((a, b) => Number(b.grid) - Number(a.grid) || b.weight - a.weight)
    .slice(0, 3)
    .map(({ name, basis }) => ({ name, basis }));
}

function namedCircuits(result: ScanResult, limit = 2): string[] {
  const named = result.lines
    .filter((line) => Boolean(line.name && line.name.trim()))
    .sort((a, b) => (b.voltage_kv ?? 0) - (a.voltage_kv ?? 0));
  const out: string[] = [];
  for (const line of named) {
    const name = line.name!.trim();
    if (out.includes(name)) continue;
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

function namedSolarPlants(result: ScanResult, limit = 2): string[] {
  return result.plants
    .filter((plant) => (plant.mw_by_source.solar ?? 0) > 0)
    .sort((a, b) => (b.mw_by_source.solar ?? 0) - (a.mw_by_source.solar ?? 0))
    .slice(0, limit)
    .map((plant) => plant.plant_name);
}

const GENERIC_SUB = /^(\d+\s*kv\s+)?substation$/i;

function substationLabel(name: string | null): string | null {
  const text = name?.trim();
  if (!text || GENERIC_SUB.test(text)) return null;
  return text;
}

/** Named, reasonably high-voltage substations closest to the biggest solar plants. */
function substationsNearSolar(result: ScanResult, limit = 2): string[] {
  const solar = result.plants
    .filter((plant) => (plant.mw_by_source.solar ?? 0) > 0)
    .sort((a, b) => (b.mw_by_source.solar ?? 0) - (a.mw_by_source.solar ?? 0))
    .slice(0, 3);
  const candidates = result.substations.filter((sub) => substationLabel(sub.name) && (sub.voltage_kv ?? 0) >= 66);
  if (!solar.length || !candidates.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { sub } of candidates
    .map((sub) => ({ sub, distance: Math.min(...solar.map((plant) => haversineMi(sub.lat, sub.lon, plant.lat, plant.lon))) }))
    .sort((a, b) => a.distance - b.distance)) {
    const name = substationLabel(sub.name)!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------ levers */

interface Ctx {
  result: ScanResult;
  live: LineRatingNow | null;
  daily: DailyRating[] | null;
  place: string;
  /** Grid counterparty from the mapped lines/substations. */
  utility: string;
  /** Largest mapped plant owner. */
  generator: string;
  circuits: string[];
}

function wildfireLever(ctx: Ctx): Lever | null {
  const { result } = ctx;
  const fire = result.cases.filter((item) => item.category === "Wildfire");
  if (!fire.length) return null;
  const nearest = fire[0];
  const hvMiles = result.totals.line_miles_by_kv["200-499"] + result.totals.line_miles_by_kv["500+"];
  const score = 68 + Math.min(24, fire.length * 8) + (hvMiles > 20 ? 4 : 0);
  return {
    id: "wildfire-hardening",
    label: "Wildfire hardening",
    headline: `Harden ${n1(result.totals.line_miles)} mi of line at ${nearest.location.name}`,
    severity: severityOf(score),
    score,
    finding: `${fire.length} wildfire case${fire.length === 1 ? "" : "s"} in this circle; nearest is ${nearest.title}. ${clip(nearest.shock_line, 110)}`,
    metrics: [
      { label: "Wildfire cases", value: n0(fire.length) },
      { label: "200 kV+ line", value: `${n1(hvMiles)} mi` },
      { label: "Substations", value: n0(result.totals.substation_count) },
    ],
    evidence: [
      `Nearest case: ${nearest.title} (${n1(nearest.location.distance_mi)} mi)`,
      `${n0(fire.length)} wildfire case${fire.length === 1 ? "" : "s"} inside ${n1(result.area.radius_mi)} mi`,
      `${n0(result.totals.substation_count)} substations, ${n0(result.totals.hv_substation_count)} at 200 kV+`,
    ],
    target: `Covered conductor on the exposed spans, starting near ${nearest.location.name}.`,
    how: "Covered conductor cuts the ignition path on overhead spans without new right-of-way.",
    tradeoff: "Heavier conductor loads existing poles; cable is the fallback where clearance fails.",
    steps: [
      {
        kind: "ask", title: "List the exposed spans", who: "Planning lead", when: WHEN[0],
        detail: `Overlay the CPUC fire-threat tiers on ${ctx.place} and list every Tier 2/3 segment with length and voltage.`,
        done: `A tiered span list for ${nearest.location.name}.`,
      },
      {
        kind: "request", title: "Ask for the hardening plan", who: ctx.utility, when: WHEN[1],
        detail: `Name ${namedCircuits(result).join(", ") || "the exposed circuits"} and ask which spans here are already scheduled.`,
        done: "A dated answer naming scheduled and unscheduled spans.",
      },
      {
        kind: "model", title: "Price the worst three spans", who: "Engineering", when: WHEN[2],
        detail: "Compare covered conductor with cable and with tree work on the spans with the least clearance.",
        done: "Three per-span estimates with their assumptions.",
      },
      {
        kind: "fund", title: "Fund the first phase", who: "Grants and finance", when: WHEN[3],
        detail: "Match the first phase to hardening money and book the match before any construction commitment.",
        done: "An application receipt and an approved first-phase scope.",
      },
    ],

  };
}

function storageLever(ctx: Ctx): Lever | null {
  const { result } = ctx;
  const totals = result.totals;
  const solar = totals.mw_by_source.solar ?? 0;
  if (solar < 50) return null;
  const cover = isNum(totals.evening_cover_pct) ? totals.evening_cover_pct : (totals.storage_mw / solar) * 100;
  if (cover >= 50) return null;
  const shortfall = Math.max(1, Math.round((0.5 * solar - totals.storage_mw) * 10) / 10);
  const score = 60 + Math.min(24, (50 - cover) * 0.6) + Math.min(16, solar / 40);
  const sites = substationsNearSolar(result);
  const site = sites[0] ?? "the substation nearest the solar";
  const plant = namedSolarPlants(result)[0] ?? "the solar plants here";
  return {
    id: "sunset-storage",
    label: "Evening storage",
    headline: `Add about ${n0(shortfall)} MW of 4-hour storage`,
    severity: severityOf(score),
    score,
    finding: `Solar drops ${n0(solar)} MW at sunset; batteries add up to ${pct0(cover)} of that.`,
    metrics: [
      { label: "Solar", value: `${n0(solar)} MW` },
      { label: "Batteries", value: `${n0(totals.storage_mw)} MW` },
      { label: "Gap to 50% cover", value: `~${n0(shortfall)} MW / 4 h` },
    ],
    evidence: [
      `Solar: ${namedSolarPlants(result).join(", ") || "none mapped"}`,
      `Battery: ${n0(totals.storage_mw)} MW here`,
      `Substation: ${sites.join(", ") || "not named in the map data"}`,
    ],
    target: `Cover half the sunset drop with ~${n0(shortfall)} MW at ${site}.`,
    how: `Batteries at ${site} absorb ${plant} locally instead of pushing it across distant lines.`,
    tradeoff: "Interconnection and fire code at the substation gate, before the battery price.",
    steps: [
      {
        kind: "request", title: "Measure the sunset ramp", who: ctx.generator, when: WHEN[0],
        detail: `Request 2025 hourly output for ${plant} and battery dispatch in ${ctx.place}.`,
        done: "An hourly 4-8 pm net-load curve for this circle.",
      },
      {
        kind: "model", title: "Size the block", who: "Owner engineer", when: WHEN[1],
        detail: `Run a 4-hour block at ${site} against the measured ramp and the substation limit.`,
        done: "A sized block with firm MW and modelled cycles.",
      },
      {
        kind: "meet", title: "Open interconnection", who: ctx.utility, when: WHEN[2],
        detail: `Ask for headroom and queued projects at ${sites.join(" and ") || site}, then file the request.`,
        done: "A dated queue position and a named contacts list.",
      },
      {
        kind: "fund", title: "Fund and procure", who: "Grants and procurement", when: WHEN[3],
        detail: "Match the block to storage money, confirm the match, then procure with an acceptance test.",
        done: "An award, an approved budget and a contract.",
      },
    ],

  };
}

function weatherRatingLever(ctx: Ctx): Lever | null {
  const { result, live } = ctx;
  const totals = result.totals;
  const site = result.rating_site;
  const hvMiles = totals.line_miles_by_kv["200-499"] + totals.line_miles_by_kv["500+"];
  if (hvMiles < 1 && totals.hv_substation_count === 0) return null;
  if (!isNum(site.distance_mi) || site.distance_mi > 25) return null;
  const aar = site.median_aar_vs_static;
  const pctHours = site.pct_hours_conservative_dlr_above_static;
  if (!isNum(pctHours)) return null;
  const gain = isNum(aar) ? Math.round((aar - 1) * 100) : null;
  if ((gain === null || gain < 2) && pctHours < 20) return null;
  const score = 42 + Math.min(38, pctHours * 0.4) + Math.min(10, hvMiles / 8);
  const liveLine = live ? ` Right now it is ${n1(live.ratio)}×.` : "";
  return {
    id: "weather-rating",
    label: "Line ratings",
    headline: `Use the line capacity the weather allows`,
    severity: severityOf(score),
    score,
    finding: `${site.name} (${site.distance_mi.toFixed(1)} mi) supports ${gain !== null && gain > 0 ? `${gain}% more` : "more"} headroom in a typical hour, and the weather-based rating beat the fixed one in ${pct0(pctHours)} of 2025 hours.${liveLine}`,
    metrics: [
      { label: "200 kV+ line", value: `${n1(hvMiles)} mi` },
      { label: "Hours above fixed", value: pct0(pctHours) },
      { label: "Typical gain", value: gain !== null ? `+${gain}%` : "n/a" },
    ],
    evidence: [
      `Rating site: ${site.name}, ${site.distance_mi.toFixed(1)} mi`,
      `Hottest 2025 hour: ${site.hottest_hour.slice(0, 10)}, ${n1(site.hottest_temp_c)} °C`,
      `Circuits: ${namedCircuits(result).join(", ") || "not named in the map data"}`,
    ],
    target: `Run ${n1(hvMiles)} mi of ${dominantVoltage(result)} line on weather-based ratings.`,
    how: "Order 881 ratings already exist here; the work is applying them circuit by circuit.",
    tradeoff: "Seasonal ratings or protection can bind before weather does.",
    steps: [
      {
        kind: "ask", title: "Pin the circuits", who: "Planning lead", when: WHEN[0],
        detail: `Match ${namedCircuits(result).join(", ") || `the ${dominantVoltage(result)} circuits in ${ctx.place}`} to the operator's circuit IDs.`,
        done: "A circuit list with owner ID and current rating.",
      },
      {
        kind: "request", title: "Get the filed ratings", who: ctx.utility, when: WHEN[1],
        detail: "Ask for the ambient-adjusted ratings and the binding constraint on each circuit.",
        done: "Current ratings plus the constraint in writing.",
      },
      {
        kind: "test", title: "Run a 90-day pilot", who: "Owner engineer", when: WHEN[2],
        detail: `Instrument the span nearest ${site.name}; the hottest 2025 hour was ${site.hottest_hour.slice(0, 10) || "not supplied"}.`,
        done: "Ninety days of span weather and current.",
      },
      {
        kind: "file", title: "Adopt the new limit", who: ctx.utility, when: WHEN[3],
        detail: "Update the operating limit and protection review only where the evidence supports it.",
        done: "An approved limit with a review date.",
      },
    ],

  };
}

function hotDayLever(ctx: Ctx): Lever | null {
  const { result, daily } = ctx;
  const totals = result.totals;
  const hvMiles = totals.line_miles_by_kv["200-499"] + totals.line_miles_by_kv["500+"];
  if (hvMiles < 1) return null;
  const short = shortDays(daily);
  if (!short || short.pct < 10) return null;
  const site = result.rating_site;
  const score = 44 + Math.min(34, short.pct * 0.5) + (hvMiles > 80 ? 6 : 0);
  return {
    id: "hot-day-capacity",
    label: "Hot-day capacity",
    headline: `Restore capacity on ${pct0(short.pct)} of days`,
    severity: severityOf(score),
    score,
    finding: `The worst hour on ${pct0(short.pct)} of ${n0(short.days)} days fell below the fixed rating, and the hottest hour reached only ${isNum(site.hottest_hour_dlr_vs_static) ? `${n1(site.hottest_hour_dlr_vs_static)}×` : "under 1×"}.`,
    metrics: [
      { label: "Days below fixed", value: `${pct0(short.pct)} of ${n0(short.days)}` },
      { label: "Hottest hour", value: isNum(site.hottest_hour_dlr_vs_static) ? `${n1(site.hottest_hour_dlr_vs_static)}×` : "n/a" },
      { label: "200 kV+ line", value: `${n1(hvMiles)} mi` },
    ],
    evidence: [
      `Flagged days: ${n0(short.days)} rated days reviewed`,
      `Worst day: ${pct0(short.pct)} below the fixed rating`,
      `Rating site: ${site.name}, ${site.distance_mi.toFixed(1)} mi`,
    ],
    target: `Lift the hot-day limit on ${n1(hvMiles)} mi of ${dominantVoltage(result)} line.`,
    how: "A high-temperature low-sag wire uses the existing towers and right-of-way.",
    tradeoff: "Towers may not carry the new wire, and the swap needs outages.",
    steps: [
      {
        kind: "request", title: "Confirm the binding limit", who: ctx.utility, when: WHEN[0],
        detail: "Ask for loading and any curtailment on the flagged days; equipment or stability may bind instead.",
        done: "A dated answer on what limited each flagged hour.",
      },
      {
        kind: "model", title: "Compare wire with new line", who: "Owner engineer", when: WHEN[1],
        detail: "Price the reconductor against new construction on capital, outage time and hottest-day MW.",
        done: "A dated comparison with the chosen option.",
      },
      {
        kind: "build", title: "Book outage and wire", who: "Operations", when: WHEN[2],
        detail: "Reserve outage windows, then order conductor after the sag study is accepted.",
        done: "An outage plan and a purchase order.",
      },
    ],

  };
}

function retirementLever(ctx: Ctx): Lever | null {
  const { result } = ctx;
  const totals = result.totals;
  // A few megawatts of retirement does not justify a lever; it stays in the Area tab numbers.
  if (totals.planned_retirement_mw < 25) return null;
  const units = result.plants
    .filter((plant) => plant.planned_retirement_mw > 0)
    .sort((a, b) => b.planned_retirement_mw - a.planned_retirement_mw)
    .slice(0, 2)
    .map((plant) => plant.plant_name);
  const score = 52 + Math.min(20, totals.planned_retirement_mw / 40) + (totals.proposed_mw > 0 ? 6 : 0);
  return {
    id: "retirement-gap",
    label: "Planned retirement",
    headline: `Replace ${n0(totals.planned_retirement_mw)} MW before it retires`,
    severity: severityOf(score),
    score,
    finding: `${n0(totals.planned_retirement_mw)} MW retires here${units.length ? `, led by ${units.join(" and ")}` : ""}; ${totals.proposed_mw > 0 ? `${n0(totals.proposed_mw)} MW is proposed` : "nothing is proposed"}.`,
    metrics: [
      { label: "Retiring", value: `${n0(totals.planned_retirement_mw)} MW` },
      { label: "Proposed", value: `${n0(totals.proposed_mw)} MW` },
      { label: "Nameplate", value: `${n0(totals.nameplate_mw)} MW` },
    ],
    evidence: [
      `Retiring units: ${units.join(", ") || "not named in the map data"}`,
      `Planned retirement: ${n0(totals.planned_retirement_mw)} MW of ${n0(totals.nameplate_mw)} MW`,
      `Proposed here: ${n0(totals.proposed_mw)} MW`,
    ],
    target: `Hold ${n0(totals.planned_retirement_mw)} MW of firm capacity through the retirement date.`,
    how: totals.proposed_mw > 0
      ? "Push the proposed projects through interconnection, then repower the retiring site."
      : "Size a replacement at the retiring site before opening a new location.",
    tradeoff: "Retiring units also provide voltage support and inertia, not just megawatts.",
    steps: [
      {
        kind: "ask", title: "Get unit dates", who: ctx.generator, when: WHEN[0],
        detail: "Ask for the retirement date and the reliability services each unit provides.",
        done: "A unit schedule with services named.",
      },
      {
        kind: "model", title: "Test the site", who: "Owner engineer", when: WHEN[1],
        detail: `Check space, interconnection and permits at the retiring site in ${ctx.place}.`,
        done: "A go/no-go note per site with the binding constraint.",
      },
      {
        kind: "fund", title: "Book replacement", who: "Finance and procurement", when: WHEN[2],
        detail: "Fund the replacement and contract with a delivery date before the retirement date.",
        done: "A funded scope and a contract with a margin.",
      },
    ],

  };
}

function agingLever(ctx: Ctx): Lever | null {
  const { result } = ctx;
  const totals = result.totals;
  const age = totals.cap_weighted_age;
  if (!isNum(age) || age <= 30 || totals.fossil_mw < 100) return null;
  const oldest = totals.oldest;
  const score = 34 + Math.min(26, (age - 30) * 1.6) + Math.min(14, totals.fossil_mw / 80);
  return {
    id: "aging-fossil",
    label: "Aging gas",
    headline: `Decide the future of ${n0(totals.fossil_mw)} MW of gas`,
    severity: severityOf(score),
    score,
    finding: `${n0(totals.fossil_mw)} MW of gas here averages ${n0(age)} years${oldest ? `; oldest is ${oldest.name} (${oldest.year})` : ""}.`,
    metrics: [
      { label: "Fossil", value: `${n0(totals.fossil_mw)} MW` },
      { label: "Weighted age", value: `${n0(age)} yr` },
      { label: "Oldest unit", value: oldest ? String(oldest.year) : "n/a" },
    ],
    evidence: [
      `Oldest unit: ${oldest ? `${oldest.name} (${oldest.year})` : "not in the plant data"}`,
      `Gas units: ${gasUnits(result).join(", ") || "not named in the plant data"}`,
      `Fossil share: ${pct0(totals.nameplate_mw > 0 ? (totals.fossil_mw / totals.nameplate_mw) * 100 : 0)} of nameplate`,
    ],
    target: `A per-unit decision: repower, replace with storage, or keep with a condition basis.`,
    how: "Start with the unit that sets local reliability, not the oldest nameplate.",
    tradeoff: "Repowering keeps the interconnection but locks in fossil operation.",
    steps: [
      {
        kind: "request", title: "Get condition records", who: ctx.generator, when: WHEN[0],
        detail: "Request the last condition assessment, outage history and heat rate for the gas units.",
        done: "A condition and performance record per unit.",
      },
      {
        kind: "meet", title: "Name the reliability role", who: "Planning lead", when: WHEN[1],
        detail: "Identify which units provide voltage support or peak capacity, and the load they protect.",
        done: "A keep, repower or replace call per unit.",
      },
      {
        kind: "model", title: "Compare the paths", who: "Owner engineer", when: WHEN[2],
        detail: "Price repower against storage replacement on capital, lead time and kept services.",
        done: "A dated comparison for the chosen path.",
      },
    ],

  };
}

function gasUnits(result: ScanResult): string[] {
  return result.plants
    .filter((plant) => (plant.mw_by_source.natural_gas ?? 0) + (plant.mw_by_source.oil ?? 0) > 0)
    .sort((a, b) => b.nameplate_mw - a.nameplate_mw)
    .slice(0, 2)
    .map((plant) => plant.plant_name);
}

/** Summer-evening wind cooling, when the rating site measured it. */
function windRatingLever(ctx: Ctx): Lever | null {
  const { result } = ctx;
  const totals = result.totals;
  const site = result.rating_site;
  const hvMiles = totals.line_miles_by_kv["200-499"] + totals.line_miles_by_kv["500+"];
  const wind = site.summer_4to8pm_median_wind_gain_over_aar;
  if (!isNum(wind) || !isNum(site.distance_mi) || site.distance_mi > 25 || hvMiles < 1) return null;
  const gain = Math.round((wind - 1) * 100);
  if (gain < 10) return null;
  const circuit = namedCircuits(result, 1)[0];
  const score = 40 + Math.min(30, gain * 0.9) + Math.min(8, hvMiles / 12);
  return {
    id: "wind-rating",
    label: "Evening wind ratings",
    headline: `Rate ${circuit ?? "the highest-voltage line"} for summer wind`,
    severity: severityOf(score),
    score,
    finding: `At ${site.name} (${site.distance_mi.toFixed(1)} mi), 4-8 pm wind lifts the weather-based rating by ${gain}% on the median summer evening.`,
    metrics: [
      { label: "Evening gain", value: `+${gain}%` },
      { label: "200 kV+ line", value: `${n1(hvMiles)} mi` },
      { label: "Season", value: "Jun-Sep" },
    ],
    evidence: [
      `Rating site: ${site.name}, ${site.distance_mi.toFixed(1)} mi`,
      `Median summer gain over the ambient-adjusted rating: +${gain}%`,
      `Circuits: ${namedCircuits(result).join(", ") || "not named in the map data"}`,
    ],
    target: "A filed summer-evening limit on the span with the most open exposure.",
    how: "Wind cooling is measured on the span, not modelled from a generic curve.",
    tradeoff: "The gain is seasonal and disappears on still evenings.",
    steps: [
      {
        kind: "ask", title: "Pick the span", who: "Planning lead", when: WHEN[0],
        detail: `Choose the span on ${circuit ?? "the highest-voltage line"} near ${site.name} with the most open exposure.`,
        done: "One span with bearing, clearance and span length.",
      },
      {
        kind: "model", title: "Check the wind model", who: "Owner engineer", when: WHEN[1],
        detail: `Test the ${gain}% evening gain against conductor temperature and the protection settings.`,
        done: "A validated model with error bounds.",
      },
      {
        kind: "test", title: "Instrument the span", who: "Field crew", when: WHEN[2],
        detail: "Install an anemometer and conductor temperature sensor for one summer.",
        done: "One summer of span weather and current.",
      },
      {
        kind: "file", title: "File the seasonal limit", who: ctx.utility, when: WHEN[3],
        detail: "File the summer-evening limit with an expiry date and a review trigger.",
        done: "A filed rating with an expiry date.",
      },
    ],
  };
}

/** Queued capacity that is already proposed but not yet delivering. */
function queueLever(ctx: Ctx): Lever | null {
  const { result } = ctx;
  const totals = result.totals;
  if (totals.proposed_mw < 50) return null;
  const storageShare = (totals.proposed_storage_mw / totals.proposed_mw) * 100;
  const names = result.events
    .filter((event) => event.kind === "proposed")
    .sort((a, b) => b.mw - a.mw)
    .slice(0, 2)
    .map((event) => event.plant_name);
  const score = 44 + Math.min(22, totals.proposed_mw / 20) + (totals.planned_retirement_mw > 0 ? 4 : 0);
  return {
    id: "queue-conversion",
    label: "Proposed capacity",
    headline: `Land ${n0(totals.proposed_mw)} MW already proposed`,
    severity: severityOf(score),
    score,
    finding: `${n0(totals.proposed_mw)} MW is proposed in this circle${names.length ? `, led by ${names.join(" and ")}` : ""}; ${pct0(storageShare)} of it is storage.`,
    metrics: [
      { label: "Proposed", value: `${n0(totals.proposed_mw)} MW` },
      { label: "Storage share", value: pct0(storageShare) },
      { label: "Retiring", value: `${n0(totals.planned_retirement_mw)} MW` },
    ],
    evidence: [
      `Proposed projects: ${names.join(", ") || "listed without names in the generator data"}`,
      `Proposed storage: ${n0(totals.proposed_storage_mw)} MW`,
      `${n0(result.totals.substation_count)} substations to connect through`,
    ],
    target: "A dated path from proposed to in service, or an explicit slip.",
    how: "The capacity is already chosen; the open question is interconnection and delivery date.",
    tradeoff: "Queue position is not a schedule, and late projects leave the gap open.",
    steps: [
      {
        kind: "ask", title: "Get the queue status", who: ctx.utility, when: WHEN[0],
        detail: `Ask which of the ${n0(totals.proposed_mw)} MW proposed here has an interconnection agreement and a milestone date.`,
        done: "A queue table with status per project.",
      },
      {
        kind: "meet", title: "Match the substations", who: "Planning lead", when: WHEN[1],
        detail: "Name the substations the queued projects connect through and the headroom at each.",
        done: "A project-to-substation map with headroom.",
      },
      {
        kind: "file", title: "Put dates in the plan", who: ctx.generator, when: WHEN[2],
        detail: "Add in-service dates to the area plan and flag any that land after the retirement date.",
        done: "A dated plan with slippage flags.",
      },
    ],
  };
}

function coverageLever(ctx: Ctx): Lever | null {
  const { result } = ctx;
  const totals = result.totals;
  if (totals.line_miles >= 1 || totals.plant_count > 0 || totals.substation_count > 0) return null;
  return {
    id: "no-assets",
    label: "Nothing mapped",
    headline: "Move the circle onto mapped grid",
    severity: "medium",
    score: 50,
    finding: `No mapped line, plant or substation in this ${n1(result.area.radius_mi)} mi circle${result.inside_coverage ? "" : ", and the centre is outside the data footprint"}.`,
    metrics: [
      { label: "Line", value: "0 mi" },
      { label: "Plants", value: "0" },
      { label: "Substations", value: "0" },
    ],
    evidence: [
      `Radius: ${n1(result.area.radius_mi)} mi around ${n1(result.area.lat)}, ${n1(result.area.lon)}`,
      result.inside_coverage ? "Centre is inside the data footprint" : "Centre is outside the data footprint",
    ],
    target: "A circle over the facility or corridor you actually care about.",
    how: "Widen the radius or re-centre, then reopen this tab.",
    tradeoff: "None: it costs one re-scan.",
    steps: [
      {
        kind: "meet", title: "Re-centre and rescan", who: "You", when: WHEN[0],
        detail: "Move the circle onto a mapped line or substation, or widen it until assets appear.",
        done: "A circle with mapped assets.",
      },
    ],

  };
}

/* ------------------------------------------------------------ plan */

export function buildUpgradePlan(
  result: ScanResult,
  live: LineRatingNow | null,
  daily: DailyRating[] | null,
): UpgradePlan {
  const totals = result.totals;
  const operators = areaOperators(result);
  const ctx: Ctx = {
    result,
    live,
    daily,
    place: placeName(result),
    utility: gridOperator(result) ?? generationOwner(result) ?? "the utility that owns these circuits",
    generator: generationOwner(result) ?? gridOperator(result) ?? "the owner of the mapped plants",
    circuits: namedCircuits(result),
  };

  const improvements = [
    wildfireLever(ctx),
    storageLever(ctx),
    weatherRatingLever(ctx),
    windRatingLever(ctx),
    hotDayLever(ctx),
    retirementLever(ctx),
    queueLever(ctx),
    agingLever(ctx),
    coverageLever(ctx),
  ]
    .filter((item): item is Lever => item !== null)
    .sort((a, b) => b.score - a.score);

  const hvMiles = totals.line_miles_by_kv["200-499"] + totals.line_miles_by_kv["500+"];
  const state = stateForArea(result.area.lat, result.area.lon);
  const levers: Improvement[] = improvements.map((item) => ({
    ...item,
    funding: matchGrants([item.id], state),
  }));

  const needData: string[] = [];
  if (!daily?.length) needData.push("2025 daily ratings for this weather site");
  if (!ctx.circuits.length) needData.push("owner circuit names for the mapped line");
  if (!gridOperator(result)) needData.push("the owner of the mapped lines and substations");
  needData.push("condition, conductor and loading records from the operator");

  return {
    summary: levers.length
      ? `${placeName(result)}: ${levers.length} lever${levers.length === 1 ? "" : "s"} from ${n0(totals.nameplate_mw)} MW of mapped generation and ${n1(totals.line_miles)} mi of line.`
      : `${placeName(result)} has no mapped assets to plan against.`,
    facts: [
      { label: "Generation", value: `${n0(totals.nameplate_mw)} MW` },
      { label: "200 kV+ line", value: `${n1(hvMiles)} mi` },
      { label: "Substations", value: n0(totals.substation_count) },
    ],
    operators,
    improvements: levers,
    state,
    grants: grantFeed(),
    needData: needData.slice(0, 3),
    caveats: [
      "Rankings are scan screening, not a study or an interconnection answer.",
      "Named operators come from map and EIA tags; they may not own every asset here.",
    ],
  };
}

/** Plain-text export of one lever (or the whole plan when no id is given). */
export function upgradePlanMarkdown(
  plan: UpgradePlan,
  areaLabel: string,
  radiusMi: number,
  improvementId?: string,
): string {
  const picked = improvementId
    ? plan.improvements.filter((item) => item.id === improvementId)
    : plan.improvements;
  const lines: string[] = [
    `# ${picked.length === 1 ? picked[0].label : "Upgrade plan"} — ${areaLabel}`,
    `${radiusMi} mi circle. Screening only, not engineering advice.`,
    "",
  ];
  for (const item of picked) {
    lines.push(
      `## ${item.headline} — ${item.severity} priority`,
      "",
      item.finding,
      "",
      item.metrics.map((metric) => `- ${metric.label}: ${metric.value}`).join("\n"),
      "",
      ...item.evidence.map((line) => `· ${line}`),
      "",
      `**Target.** ${item.target}`,
      `**How.** ${item.how}`,
      `**Tradeoff.** ${item.tradeoff}`,
      "",
      "**Steps**",
      ...item.steps.map(
        (entry, index) =>
          `${index + 1}. (${entry.kind}) ${entry.title} — ${entry.who}, ${entry.when}.\n   ${entry.detail}\n   Done: ${entry.done}`,
      ),
    );
    if (item.funding.length) {
      lines.push("", "**Funding**");
      for (const match of item.funding) {
        lines.push(`- ${match.title} — ${match.why} Next: ${match.next} ${match.url}`);
      }
      const checked = item.funding.map((match) => match.checkedAt).sort().at(-1)?.slice(0, 10);
      lines.push(`Checked against ${plan.grants.watched}/${plan.grants.total} watched programmes on ${checked ?? plan.grants.checkedAt.slice(0, 10)}.`);
    }
    lines.push("");
  }
  lines.push("**Before you rely on it**", ...plan.caveats.map((item) => `- ${item}`));
  return `${lines.join("\n")}\n`;
}
