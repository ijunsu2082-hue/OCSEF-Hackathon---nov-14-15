// Compliance report generator. Pure functions, no AI, no network.
// A person picks what happened, adds details, and gets a formal report built from a fixed
// template per situation, with verified rules from ./legal and facts from public data.
import type { LineRatingNow, ScanResult } from "./types";
import type { ReportTarget } from "./target";
import { FUEL_CATEGORY, FUEL_LABELS } from "./colors";
import { haversineMi } from "./geo";
import { heatwaveWeather, rateLine } from "./rating";
import { kvLabel, lineMiles, lineName, substationName } from "./labels";
import {
  CPUC,
  LAWS,
  LOCAL_UTILITY,
  SAFETY,
  UTILITIES,
  matchUtility,
  type LawId,
  type LegalRule,
  type Phone,
  type UtilityInfo,
  type UtilityKey,
} from "./legal";
import { cToF, fmtCoord, fmtNum, fmtPowerText, isNum } from "@/components/scan/panel/format";

/* ------------------------------------------------------------- situations */

export type SituationId =
  | "fire" | "wire_down" | "sparks" | "shock" | "gas"
  | "tree" | "sagging" | "pole" | "padmount" | "repeat_outages" | "outage_claim" | "voltage" | "psps" | "noise";

/** How the report is routed: a safety problem, a service problem, a money claim, or a power shutoff. */
type Route = "safety" | "service" | "claim" | "psps";

export interface Situation {
  id: SituationId;
  label: string;
  hint: string;
  emergency: boolean;
  route: Route;
  laws: LawId[];
  /** One sentence for "What happened", first person. */
  happened: string;
  asks: string[];
  evidence: string[];
}

const BASE_EVIDENCE = [
  "Photos taken from a safe distance, with the date and time",
  "The pole or equipment ID number, if you can read it safely from the ground",
  "The ticket or reference number from your call to the utility",
];

export const SITUATIONS: Situation[] = [
  /* Emergencies: no form, just 911. */
  { id: "fire", label: "Fire or smoke from equipment", hint: "Flames or smoke from a pole, wire or box", emergency: true, route: "safety", laws: [], happened: "", asks: [], evidence: [] },
  { id: "wire_down", label: "Wire down or hanging low enough to touch", hint: "On the ground, on a car, or within reach", emergency: true, route: "safety", laws: [], happened: "", asks: [], evidence: [] },
  { id: "sparks", label: "Sparks or arcing", hint: "Flashes, sparks or popping from wires or equipment", emergency: true, route: "safety", laws: [], happened: "", asks: [], evidence: [] },
  { id: "shock", label: "Someone was shocked", hint: "A person or pet got an electric shock", emergency: true, route: "safety", laws: [], happened: "", asks: [], evidence: [] },
  { id: "gas", label: "Gas smell or explosion", hint: "Rotten-egg smell, hissing, or a blast", emergency: true, route: "safety", laws: [], happened: "", asks: [], evidence: [] },

  /* Non-emergencies: each builds a report. */
  {
    id: "tree",
    label: "Tree or branches growing into a power line",
    hint: "Branches touching or very close to wires",
    emergency: false,
    route: "safety",
    laws: ["go95_35", "prc_4293", "prc_4292", "go95_31_2", "go165", "puc_451"],
    happened: "Tree branches are growing into, or very close to, the overhead power line at the location below.",
    asks: [
      "Inspect the line at this location.",
      "Trim the vegetation to at least the minimum clearance required by GO 95 Rule 35 (and Public Resources Code 4293 if this is a wildland area).",
      "Remove any dead, rotten or leaning tree that could fall into the line.",
      "Send me a written response with the inspection date and what was done.",
    ],
    evidence: ["A photo that shows the branches and the wire together"],
  },
  {
    id: "sagging",
    label: "Power line sagging lower than normal",
    hint: "Lower than usual, but not low enough to touch",
    emergency: false,
    route: "safety",
    laws: ["go95_37", "go95_31_1", "go95_31_2", "go165", "puc_451"],
    happened: "An overhead power line at the location below is sagging lower than normal. It is not low enough to touch.",
    asks: [
      "Inspect the line and measure its height above the ground, road and buildings.",
      "Repair it so it meets the minimum clearances in GO 95 Rule 37 and Table 1.",
      "Send me a written response with the inspection date and what was done.",
    ],
    evidence: ["A photo that shows the low wire next to something for scale (a car, a fence or a street sign)"],
  },
  {
    id: "pole",
    label: "Leaning or damaged pole, or broken crossarm",
    hint: "Tilted pole, cracked wood, broken arm at the top",
    emergency: false,
    route: "safety",
    laws: ["go95_44_3", "go95_31_1", "go95_31_2", "go165", "puc_451"],
    happened: "A utility pole at the location below is leaning or damaged (for example a crack, rot, or a broken crossarm).",
    asks: [
      "Inspect the pole and its hardware.",
      "Replace or reinforce it as required by GO 95 Rule 44.3.",
      "Send me a written response with the inspection date and what was done.",
    ],
    evidence: ["Photos of the whole pole and a close-up of the damage"],
  },
  {
    id: "padmount",
    label: "Equipment box on the ground left open, unlocked or damaged",
    hint: "Green metal box (pad-mounted transformer)",
    emergency: false,
    route: "safety",
    laws: ["go128_34_3", "go165", "puc_451"],
    happened:
      "A ground-level utility equipment box (pad-mounted transformer or switch) at the location below is open, unlocked or damaged.",
    asks: [
      "Close, lock and secure the equipment right away so no one can get in.",
      "Repair any damage to the box.",
      "Send me a written response with the date it was secured.",
    ],
    evidence: ["A photo of the box from a safe distance (do not touch it or look inside)"],
  },
  {
    id: "repeat_outages",
    label: "Power keeps going out",
    hint: "Repeated outages over the past months",
    emergency: false,
    route: "service",
    laws: ["puc_451", "go95_31_1", "go95_31_2", "go165"],
    happened: "My power has gone out again and again over the past months at the location below.",
    asks: [
      "Tell me in writing what caused these outages.",
      "Inspect the equipment that serves this location.",
      "Tell me what repairs are planned and when.",
    ],
    evidence: ["A list of each outage: date, start time and how long it lasted", "Any outage alert texts or emails from the utility"],
  },
  {
    id: "outage_claim",
    label: "Long outage: food or appliances damaged",
    hint: "Ask the utility to pay for the loss (a claim)",
    emergency: false,
    route: "claim",
    laws: ["go166_8", "puc_451", "gov_911_2"],
    happened: "A power outage at the location below damaged my food, appliances or other property.",
    asks: [
      "Treat this as a claim for damages and pay for the loss listed below.",
      "Tell me in writing what caused the outage.",
      "Send me a claim number and a written decision.",
    ],
    evidence: [
      "Receipts, repair estimates or invoices",
      "An itemized list of spoiled food or damaged items with their cost",
      "Photos of the damage",
    ],
  },
  {
    id: "voltage",
    label: "Flickering power or voltage problems damaging appliances",
    hint: "Lights dim or flicker, devices break",
    emergency: false,
    route: "claim",
    laws: ["sdge_rule2", "sce_rule2", "pge_rule2", "puc_451", "gov_911_2"],
    happened:
      "The power at the location below keeps flickering or changing voltage, and it has damaged (or may damage) my appliances.",
    asks: [
      "Check the voltage at my meter and on the equipment that serves this location.",
      "Fix the cause so the voltage stays in the range your tariff requires.",
      "If my appliances were damaged, treat this as a claim and pay for the loss.",
    ],
    evidence: ["The dates and times of the flickering", "Receipts or repair estimates for damaged devices"],
  },
  {
    id: "psps",
    label: "Power shutoff without proper notice",
    hint: "Public Safety Power Shutoff (PSPS) with no warning",
    emergency: false,
    route: "psps",
    laws: ["psps_esrb8", "psps_d1905042", "psps_d2106034"],
    happened:
      "My power was shut off for wildfire safety (a Public Safety Power Shutoff, PSPS) at the location below, and I did not get proper advance notice.",
    asks: [
      "Tell me in writing which notices were sent to my address or account, and when.",
      "Explain why I did not get notice 24 to 48 hours before the shutoff.",
      "Correct my contact information and notification settings.",
    ],
    evidence: ["The date and time the power went off and came back", "Screenshots of any texts, calls or emails you did get"],
  },
  {
    id: "noise",
    label: "Buzzing or noise from equipment",
    hint: "New humming, crackling or buzzing from a pole or box",
    emergency: false,
    route: "safety",
    laws: ["go95_31_1", "go95_31_2", "go165"],
    happened: "Utility equipment at the location below is making a buzzing, humming or crackling noise.",
    asks: ["Inspect the equipment at this location.", "Repair anything that is not in good condition.", "Send me a written response with what you found."],
    evidence: ["A short video or audio recording from a safe distance, with the date"],
  },
];

export const situationById = (id: SituationId) => SITUATIONS.find((s) => s.id === id)!;

/* ------------------------------------------------------------- utility routing */

/** What the person picked under "Who sends your electric bill?". */
export type BillChoice = UtilityKey | "notsure";

export interface UtilityMatch {
  utility: UtilityInfo;
  /** Plain words: how we know. */
  basis: string;
  /** false = not sure which company serves this address (send the person to their bill). */
  known: boolean;
  /** bill = the person picked it; likely = our guess from map data; unsure = not sure. */
  source: "bill" | "likely" | "unsure";
  /** When not sure: what the map data does say (for example who owns a nearby big power line). */
  hint?: string;
}

/** A substation farther than this from the spot is too far away to guess the local utility. */
const LIKELY_MAX_MI = 3;

const BILL_CHECK = "Check your electric bill to be sure.";
const LINE_CAVEAT = "The company that owns the big power lines is not always the one that sends your bill.";

function likely(k: UtilityKey, why: string): UtilityMatch {
  const u = UTILITIES[k];
  return { utility: u, basis: `Likely ${u.short}, based on ${why}. ${BILL_CHECK}`, known: true, source: "likely" };
}

function unsure(hint?: string): UtilityMatch {
  return {
    utility: LOCAL_UTILITY,
    basis: "Not sure which company serves this address. Its name and emergency number are printed on your electric bill.",
    known: false,
    source: "unsure",
    ...(hint ? { hint } : {}),
  };
}

/** Nearest substation in the scan (within LIKELY_MAX_MI) whose operator names a utility we know. */
function nearestSubstation(result: ScanResult, lat: number, lon: number): UtilityMatch | null {
  let best: { k: UtilityKey; d: number } | null = null;
  for (const s of result.substations) {
    const k = matchUtility(s.operator);
    if (!k) continue;
    const d = haversineMi(lat, lon, s.lat, s.lon);
    if (!best || d < best.d) best = { k, d };
  }
  if (!best || best.d > LIKELY_MAX_MI) return null;
  return likely(best.k, `who runs the nearest substation (${fmtNum(best.d, 1)} mi away, OpenStreetMap)`);
}

/** Owner of the nearest big power line in the scan. Only used as a hint: line owners often do not serve the homes nearby. */
function nearestLineOwner(result: ScanResult, lat: number, lon: number): UtilityKey | null {
  let best: { k: UtilityKey; d: number } | null = null;
  for (const l of result.lines) {
    const k = matchUtility(l.operator);
    if (!k) continue;
    for (const c of l.coords) {
      const d = haversineMi(lat, lon, c[0], c[1]);
      if (!best || d < best.d) best = { k, d };
    }
  }
  return best?.k ?? null;
}

function lineHint(k: UtilityKey | null, thisLine: boolean): string | undefined {
  if (!k) return undefined;
  const who = UTILITIES[k].short;
  return thisLine
    ? `Map data says ${who} owns this power line. ${LINE_CAVEAT}`
    : `Map data says ${who} owns the big power lines nearby. ${LINE_CAVEAT}`;
}

/** Our best guess from public data, before the person picks their bill company. */
export function detectUtility(target: ReportTarget, result: ScanResult): UtilityMatch {
  if (target.kind === "substation") {
    const s = target.substation;
    const k = matchUtility(s.operator);
    if (k) return likely(k, "who runs this substation (OpenStreetMap)");
    return nearestSubstation(result, s.lat, s.lon) ?? unsure(lineHint(nearestLineOwner(result, s.lat, s.lon), false));
  }
  if (target.kind === "line") {
    const l = target.line;
    const mid = l.coords[Math.floor(l.coords.length / 2)] ?? [result.area.lat, result.area.lon];
    const own = matchUtility(l.operator);
    return nearestSubstation(result, mid[0], mid[1]) ?? unsure(own ? lineHint(own, true) : lineHint(nearestLineOwner(result, mid[0], mid[1]), false));
  }
  if (target.kind === "plant") {
    const p = target.plant;
    const k = matchUtility(p.utility_name);
    if (k) return likely(k, "who owns this power plant (EIA-860)");
    return nearestSubstation(result, p.lat, p.lon) ?? unsure(lineHint(nearestLineOwner(result, p.lat, p.lon), false));
  }
  const a = result.area;
  return nearestSubstation(result, a.lat, a.lon) ?? unsure(lineHint(nearestLineOwner(result, a.lat, a.lon), false));
}

export function isBillChoice(v: unknown): v is BillChoice {
  return v === "notsure" || (typeof v === "string" && Object.prototype.hasOwnProperty.call(UTILITIES, v));
}

/** The utility used everywhere in the report: the person's pick if they made one, else our guess. */
export function resolveUtility(target: ReportTarget, result: ScanResult, choice: BillChoice | null = null): UtilityMatch {
  if (choice && choice !== "notsure") {
    return { utility: UTILITIES[choice], basis: "From the customer's electric bill.", known: true, source: "bill" };
  }
  const detected = detectUtility(target, result);
  if (choice === "notsure") return detected.known ? unsure() : detected;
  return detected;
}

export interface EmergencyContact { key: UtilityKey; short: string; phone: Phone }

/**
 * Emergency lines to show when the person is not sure who their utility is: every utility named by
 * the lines, substations and plants in this scan (nearest first). If none is named, every verified line.
 */
export function emergencyContacts(target: ReportTarget, result: ScanResult): EmergencyContact[] {
  const { lat, lon } = assetInfo(target, result);
  const near = new Map<UtilityKey, number>();
  const note = (k: UtilityKey | null, d: number) => {
    if (k && (near.get(k) ?? Infinity) > d) near.set(k, d);
  };
  for (const s of result.substations) note(matchUtility(s.operator), haversineMi(lat, lon, s.lat, s.lon));
  for (const p of result.plants) note(matchUtility(p.utility_name), haversineMi(lat, lon, p.lat, p.lon));
  for (const l of result.lines) {
    const k = matchUtility(l.operator);
    if (k) for (const c of l.coords) note(k, haversineMi(lat, lon, c[0], c[1]));
  }
  const all = Object.keys(UTILITIES) as UtilityKey[];
  const keys = [...near.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
  const withPhone = (ks: UtilityKey[]) =>
    ks.flatMap((k) => {
      const u: UtilityInfo = UTILITIES[k];
      return u.emergency ? [{ key: k, short: u.short, phone: u.emergency }] : [];
    });
  const found = withPhone(keys);
  return found.length ? found : withPhone(all);
}

/** The person's bill-company pick, kept on this device. */
export const BILL_KEY = "gs-bill-utility-v1";

export function loadBillChoice(): BillChoice | null {
  try {
    const v = window.localStorage.getItem(BILL_KEY);
    return isBillChoice(v) ? v : null;
  } catch {
    return null;
  }
}

/** false when the browser blocks storage. */
export function saveBillChoice(choice: BillChoice): boolean {
  try {
    window.localStorage.setItem(BILL_KEY, choice);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- asset facts */

export interface Fact { label: string; value: string; source: string }

export interface AssetInfo {
  label: string;
  kind: string;
  lat: number;
  lon: number;
  placeText: string;
  facts: Fact[];
}

const OSM = "OpenStreetMap";
const EIA = "EIA-860 (2025)";

export function osmUrl(lat: number, lon: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=17/${lat.toFixed(5)}/${lon.toFixed(5)}`;
}

/** Nearest power-plant city inside the scan (EIA-860 lists a city for each plant). */
function nearestCity(result: ScanResult, lat: number, lon: number): string | null {
  let best: { city: string; d: number } | null = null;
  for (const p of result.plants) {
    if (!p.city?.trim()) continue;
    const d = haversineMi(lat, lon, p.lat, p.lon);
    if (!best || d < best.d) best = { city: p.city.trim(), d };
  }
  return best && best.d <= 15 ? best.city : null;
}

export function assetInfo(target: ReportTarget, result: ScanResult): AssetInfo {
  const facts: Fact[] = [];
  const add = (label: string, value: string | null | undefined, source: string) => {
    if (value && value.trim()) facts.push({ label, value: value.trim(), source });
  };

  if (target.kind === "plant") {
    const p = target.plant;
    const fuel = FUEL_LABELS[p.primary_source] ?? "Other";
    const place = [p.city, p.county ? `${p.county} County` : ""].filter(Boolean).join(", ");
    const name = p.plant_name.trim() || `${fuel} power plant${p.city ? ` in ${p.city}` : ""}`;
    add("Name", name, EIA);
    add("Kind", `Power plant (${fuel.toLowerCase()})`, EIA);
    add("Size", isNum(p.nameplate_mw) ? fmtPowerText(p.nameplate_mw) : null, EIA);
    add("Owner or operator", p.utility_name, EIA);
    add("Grid connection", kvLabel(p.grid_voltage_kv), EIA);
    add("City", place, EIA);
    if (isNum(p.capacity_weighted_age_years)) {
      add(
        "Age",
        `About ${fmtNum(p.capacity_weighted_age_years, 0)} years (average, weighted by size)` +
          (isNum(p.oldest_year) ? `; oldest unit from ${p.oldest_year}` : ""),
        EIA,
      );
    }
    add("Coordinates", fmtCoord(p.lat, p.lon), EIA);
    return { label: name, kind: "power plant", lat: p.lat, lon: p.lon, placeText: place || fmtCoord(p.lat, p.lon), facts };
  }

  if (target.kind === "substation") {
    const s = target.substation;
    const name = substationName(s);
    const city = s.near ?? nearestCity(result, s.lat, s.lon);
    add("Name", name, OSM);
    add("Kind", "Substation", OSM);
    add("Voltage", kvLabel(s.voltage_kv, s.kv_inferred), OSM);
    add("Operator", s.operator, OSM);
    add("Nearby city", city, `${EIA} plant cities`);
    add("Coordinates", fmtCoord(s.lat, s.lon), OSM);
    return { label: name, kind: "substation", lat: s.lat, lon: s.lon, placeText: city ? `Near ${city}` : fmtCoord(s.lat, s.lon), facts };
  }

  if (target.kind === "line") {
    const l = target.line;
    const name = lineName(l);
    const mid = l.coords[Math.floor(l.coords.length / 2)] ?? [result.area.lat, result.area.lon];
    const city = l.near ?? nearestCity(result, mid[0], mid[1]);
    add("Name", name, OSM);
    add("Kind", "Transmission power line", OSM);
    add("Voltage", kvLabel(l.voltage_kv, l.kv_inferred), OSM);
    add("Operator", l.operator, OSM);
    add("Length", `${fmtNum(lineMiles(l), 1)} mi`, OSM);
    add("Nearby city", city, `${EIA} plant cities`);
    add("Middle of the line", fmtCoord(mid[0], mid[1]), OSM);
    return { label: name, kind: "power line", lat: mid[0], lon: mid[1], placeText: city ? `Near ${city}` : fmtCoord(mid[0], mid[1]), facts };
  }

  const a = result.area;
  const label = `Area within ${fmtNum(a.radius_mi, 0)} mi of ${result.area_label}`;
  add("Area", label, "GridSentinel scan");
  add("Center", fmtCoord(a.lat, a.lon), "GridSentinel scan");
  add("Power lines (69 kV and up)", fmtNum(result.lines.length, 0), OSM);
  add("Substations", fmtNum(result.substations.length, 0), OSM);
  add("Power plants", fmtNum(result.totals.plant_count, 0), EIA);
  return { label, kind: "area", lat: a.lat, lon: a.lon, placeText: result.area_label, facts };
}

/* ------------------------------------------------------------- the document */

export interface ReportDetails {
  /** "YYYY-MM-DDTHH:mm" from a datetime-local input, or "". */
  when: string;
  saw: string;
  equipmentId: string;
  name: string;
  contact: string;
  ticket: string;
  certify: boolean;
}

export const EMPTY_DETAILS: ReportDetails = { when: "", saw: "", equipmentId: "", name: "", contact: "", ticket: "", certify: false };

export interface ReportInput {
  situationId: SituationId;
  target: ReportTarget;
  result: ScanResult;
  details: ReportDetails;
  /** The person's answer to "Who sends your electric bill?" (null = use our guess). */
  bill?: BillChoice | null;
  now?: Date;
}

export interface SendStep { title: string; detail: string; url?: string; phone?: Phone }

export interface ComplianceDoc {
  situationId: SituationId;
  title: string;
  subject: string;
  date: string;
  to: string[];
  from: string;
  asset: AssetInfo;
  mapUrl: string;
  utility: UtilityMatch;
  happened: string[];
  rules: LegalRule[];
  asks: string[];
  evidence: string[];
  steps: SendStep[];
  deadlines: string[];
  certification: string | null;
  privacy: string;
  disclaimer: string;
  /** Best page to open first (the utility's claims or report page, else the CPUC/city route). */
  filingUrl: string;
}

export const DISCLAIMER = "This is a student-built tool, not legal advice, and not affiliated with the CPUC or any utility.";
export const CERTIFICATION = "I certify that the facts I wrote in this report are true and correct to the best of my knowledge.";
export const PRIVACY =
  "This report was made on this device. Nothing is sent to anyone until you send it yourself. If you later file a formal complaint with the CPUC, it becomes a public record.";

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/** "2026-11-14T15:30" -> "November 14, 2026 at 3:30 PM" (no timezone shift). */
export function fmtLocalWhen(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  if (Number.isNaN(d.getTime())) return null;
  const day = d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return m[4] ? `${day} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : day;
}

function rulesFor(s: Situation, u: UtilityMatch): LegalRule[] {
  const kind = u.known ? u.utility.kind : null;
  const ids = s.laws.filter((id) => {
    const law: LegalRule = LAWS[id];
    if (id === "sdge_rule2") return u.utility.key === "sdge";
    if (id === "sce_rule2") return u.utility.key === "sce";
    if (id === "pge_rule2") return u.utility.key === "pge";
    if (law.applies_to === "all") return true;
    if (law.applies_to === "iou") return kind === "iou";
    return kind === "public";
  });
  if (kind === "public" && ids.some((id) => id.startsWith("go95"))) ids.push("pou_jurisdiction");
  return ids.map((id) => LAWS[id]);
}

function stepsFor(s: Pick<Situation, "route">, u: UtilityMatch): { steps: SendStep[]; deadlines: string[]; filingUrl: string } {
  const util = u.utility;
  const steps: SendStep[] = [];
  const deadlines: string[] = [];
  const claim = s.route === "claim";

  if (!u.known) {
    steps.push({
      title: "Find your utility",
      detail:
        "Its name, customer service number and 24-hour emergency number are printed on your electric bill. Send this report to its customer service or claims department.",
      url: CPUC.municipalUrl,
    });
    steps.push({
      title: "If it is not resolved",
      detail:
        "If your utility is SCE, SDG&E, PG&E or Bear Valley Electric (owned by investors), file an informal complaint with the CPUC Consumer Affairs Branch. If it is run by a city or district, contact its city council or board instead: the CPUC does not handle those complaints. If it is a member-owned cooperative (such as Anza Electric), contact its board of directors.",
      url: CPUC.complaintInfoUrl,
    });
    return { steps, deadlines, filingUrl: CPUC.municipalUrl };
  }

  const first = claim && util.claimsUrl ? util.claimsUrl : util.reportUrl;
  steps.push({
    title: claim ? `File a claim with ${util.short}` : `Send it to ${util.short}`,
    detail: claim
      ? util.claimsUrl
        ? `Use ${util.short}'s claims page and attach this report and your receipts.${util.claimsTiming ? ` ${util.claimsTiming}` : ""}`
        : `Call ${util.short}'s customer service (the number is on your electric bill) and ask how to file a claim. Send this report and your receipts.`
      : `Report it to ${util.short}'s customer service (not 911, since no one is in danger now) and ask for a ticket number. Attach or paste this report.`,
    url: first,
    phone: !claim && s.route === "safety" ? util.emergency : undefined,
  });

  if (util.kind === "iou") {
    steps.push({
      title: "If it is not fixed: CPUC informal complaint",
      detail:
        `File an informal complaint with the CPUC Consumer Affairs Branch online, or call ${CPUC.cabPhone.display} (${CPUC.cabPhone.hours}). ` +
        `Include ${util.short}'s ticket number and this report.`,
      url: CPUC.complaintUrl,
      phone: { display: CPUC.cabPhone.display, tel: CPUC.cabPhone.tel },
    });
    if (s.route === "safety") {
      steps.push({
        title: "Safety problems can also go to the CPUC safety team",
        detail: "The CPUC takes public safety complaints (like a dangling wire) online, after any emergency is handled.",
        url: CPUC.safetyComplaintUrl,
      });
    }
    steps.push({
      title: "Advanced: formal complaint",
      detail:
        "If the informal complaint does not solve it, you can file a formal complaint under Article 4 of the CPUC Rules of Practice and Procedure. The CPUC may send a case back to the Consumer Affairs Branch if you skipped the informal step (Rule 4.2(c)). Formal complaints are public records." +
        (claim ? " The CPUC cannot award money for property damage; for that, a denied claim goes to civil court (for example small claims)." : ""),
      url: CPUC.formalUrl,
    });
    deadlines.push(`When the CPUC forwards an informal complaint, the utility is expected to respond within ${CPUC.responseDays} business days.`);
  } else if (util.kind === "coop") {
    steps.push({
      title: `If it is not fixed: ${util.short}'s board of directors`,
      detail: `${util.oversight ?? ""} Send this report to its board of directors. Check your electric bill for how to reach the board and for any other place to complain.`.trim(),
      url: util.reportUrl,
    });
  } else {
    steps.push({
      title: "If it is not fixed: your city council or the utility's board",
      detail: `${util.oversight ?? ""} The CPUC Consumer Affairs Branch does not handle complaints about city-owned utilities. Send this report to your city council member and the utility's board.`.trim(),
      url: CPUC.municipalUrl,
    });
    if (s.route === "safety") {
      steps.push({
        title: "State safety rules still apply",
        detail: "CPUC General Order 95 safety rules for overhead lines also cover city-owned utilities (CPUC Decision D.10-02-034). Mention them in your letter.",
        url: LAWS.pou_jurisdiction.url,
      });
    }
    if (claim) {
      deadlines.push(
        "Claims against a city-owned utility for damaged belongings must be filed within 6 months; most other claims within 1 year (Government Code 911.2).",
      );
    }
  }
  if (claim && util.claimsTiming && util.kind === "iou") deadlines.push(util.claimsTiming);
  if (claim && util.claimsTiming && util.kind === "public") deadlines.push(util.claimsTiming);

  return { steps, deadlines, filingUrl: first ?? (util.kind === "iou" ? CPUC.complaintInfoUrl : CPUC.municipalUrl) };
}

export function buildComplianceReport(input: ReportInput): ComplianceDoc {
  const s = situationById(input.situationId);
  const now = input.now ?? new Date();
  const d = input.details;
  const asset = assetInfo(input.target, input.result);
  const u = resolveUtility(input.target, input.result, input.bill ?? null);
  const util = u.utility;

  const happened: string[] = [s.happened];
  const when = fmtLocalWhen(d.when);
  if (when) happened.push(`I noticed it on ${when}.`);
  if (d.saw.trim()) happened.push(`What I saw: ${d.saw.trim()}`);
  if (d.equipmentId.trim()) happened.push(`Pole or equipment ID number: ${d.equipmentId.trim()}.`);
  if (d.ticket.trim()) happened.push(`I already reported this to ${util.short}. Reference number: ${d.ticket.trim()}.`);

  const to = [u.known ? `${util.name}, ${s.route === "claim" ? "Claims Department" : "Customer Service"}` : "Your local electric utility (name on your electric bill)"];
  if (u.known && util.kind === "iou") to.push("If not resolved: California Public Utilities Commission, Consumer Affairs Branch");
  else if (u.known && util.kind === "coop") to.push(`If not resolved: ${util.name}, Board of Directors`);
  else if (u.known) to.push("If not resolved: the city council or board that oversees the utility");

  const fromParts = [d.name.trim(), d.contact.trim()].filter(Boolean);
  const { steps, deadlines, filingUrl } = stepsFor(s, u);
  const where = asset.kind === "area" ? asset.label : `${asset.label} (${asset.kind})`;

  return {
    situationId: s.id,
    title: `Compliance report: ${s.label}`,
    subject: `${s.label}: ${asset.label}`,
    date: fmtDate(now),
    to,
    from: fromParts.length ? fromParts.join(", ") : "A customer or resident (name withheld)",
    asset: { ...asset, label: where },
    mapUrl: osmUrl(asset.lat, asset.lon),
    utility: u,
    happened,
    rules: rulesFor(s, u),
    asks: s.asks,
    evidence: [...s.evidence, ...BASE_EVIDENCE],
    steps,
    deadlines,
    certification: d.certify ? CERTIFICATION : null,
    privacy: PRIVACY,
    disclaimer: DISCLAIMER,
    filingUrl,
  };
}

/* ------------------------------------------------------------- emergency */

export interface EmergencyInfo {
  utility: UtilityMatch;
  steps: string[];
  sources: { label: string; url: string }[];
  gasPhone: Phone | null;
}

export function emergencyInfo(id: SituationId, target: ReportTarget, result: ScanResult, bill: BillChoice | null = null): EmergencyInfo {
  const u = resolveUtility(target, result, bill);
  const key = u.known ? u.utility.key : null;
  if (id === "gas") {
    // Gas company by electric utility: SDG&E and PG&E sell both; Bear Valley's area has Southwest Gas;
    // when we are not sure, the person's gas bill has the number. Elsewhere in our area: SoCalGas.
    const own = key === "sdge" || key === "pge" ? UTILITIES[key] : null;
    const generic = key === null || key === "bves" || key === "vernon" || key === "iid" || key === "anza" || key === "local";
    return {
      utility: u,
      steps: [
        "Leave the area right away.",
        "Do not light a flame, smoke, or flip light switches or other electric switches.",
        own
          ? `From a safe place, call 911 and ${own.short} (your gas company).`
          : generic
            ? "From a safe place, call 911 and your gas company. Its number is on your gas bill."
            : "From a safe place, call 911 and your gas company (SoCalGas in most of Southern California).",
      ],
      sources: [
        { label: SAFETY.gasSource, url: SAFETY.gasUrl },
        ...(key === "pge" ? [{ label: SAFETY.carSource, url: SAFETY.carUrl }] : []),
      ],
      gasPhone: own ? own.emergency : generic ? null : SAFETY.gasPhone,
    };
  }
  return {
    utility: u,
    steps: [
      "Call 911 now.",
      SAFETY.distance,
      "Treat every fallen or low wire as live. Do not touch it, or anything or anyone touching it.",
      SAFETY.car,
      id === "shock" ? "Do not touch a person who may still be touching the electricity. Tell 911 someone was shocked." : null,
      `Then call ${u.known ? u.utility.short : "your utility"}'s emergency line.`,
    ].filter((x): x is string => !!x),
    sources: [
      { label: SAFETY.distanceSource, url: SAFETY.distanceUrl },
      { label: SAFETY.carSource, url: SAFETY.carUrl },
    ],
    gasPhone: null,
  };
}

/* ------------------------------------------------------------- plain text */

const RULE = "----------------------------------------";

export function reportText(doc: ComplianceDoc): string {
  const L: string[] = [];
  L.push(doc.title.toUpperCase(), "");
  L.push(`Date: ${doc.date}`);
  L.push(`To: ${doc.to.join("\n    ")}`);
  L.push(`From: ${doc.from}`);
  L.push(`Subject: ${doc.subject}`);
  L.push("", RULE, "LOCATION AND ASSET", `${doc.asset.label}`, `Place: ${doc.asset.placeText}`, `Coordinates: ${fmtCoord(doc.asset.lat, doc.asset.lon)}`, `Map: ${doc.mapUrl}`);
  L.push(`Utility: ${doc.utility.utility.name} (${doc.utility.basis})`);
  if (doc.utility.hint) L.push(doc.utility.hint);
  L.push("", RULE, "WHAT HAPPENED", ...doc.happened);
  L.push("", RULE, "RULES THAT APPLY");
  if (doc.rules.length === 0) L.push("- Your utility's own service rules (ask it for them in writing).");
  for (const r of doc.rules) L.push(`- ${r.citation}: ${r.title}`, `  Meaning: ${r.plain}`, `  Official text: ${r.url}`);
  L.push("", RULE, "FACTS FROM PUBLIC DATA");
  for (const f of doc.asset.facts) L.push(`- ${f.label}: ${f.value} (source: ${f.source})`);
  L.push("", RULE, "WHAT I AM ASKING FOR", ...doc.asks.map((a, i) => `${i + 1}. ${a}`));
  L.push("", RULE, "EVIDENCE CHECKLIST", ...doc.evidence.map((e) => `[ ] ${e}`));
  L.push("", RULE, "WHERE TO SEND IT, IN ORDER");
  doc.steps.forEach((st, i) => {
    L.push(`${i + 1}. ${st.title}`, `   ${st.detail}`);
    if (st.phone) L.push(`   Phone: ${st.phone.display}`);
    if (st.url) L.push(`   ${st.url}`);
  });
  if (doc.deadlines.length) L.push("", RULE, "DEADLINES AND RESPONSE TIMES", ...doc.deadlines.map((x) => `- ${x}`));
  L.push("", RULE);
  if (doc.certification) L.push(doc.certification, "", "Signature: ______________________", "");
  L.push("If anyone is in danger, or you see fire, sparks or a wire on the ground, call 911 first.");
  L.push(`Privacy: ${doc.privacy}`);
  L.push(doc.disclaimer);
  return L.join("\n");
}

/** Longest encoded body we put in a mailto: link (some mail apps stop near 2,000 characters in all). */
export const MAIL_BODY_MAX = 1800;
const MAIL_TAIL = "\n... (full report in the download)";

/** Replace lone surrogate halves, which make encodeURIComponent throw. */
function wellFormed(t: string): string {
  return t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/** Body text whose encoded form fits in MAIL_BODY_MAX, cut on whole characters (never inside an emoji). */
export function mailBody(text: string): string {
  const full = wellFormed(text);
  if (encodeURIComponent(full).length <= MAIL_BODY_MAX) return full;
  const chars = Array.from(full);
  const fits = (n: number) => encodeURIComponent(chars.slice(0, n).join("") + MAIL_TAIL).length <= MAIL_BODY_MAX;
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("") + MAIL_TAIL;
}

/** mailto: with an empty recipient so the person's own email app opens and they choose who gets it. */
export function mailtoHref(subject: string, text: string): string {
  return `mailto:?subject=${encodeURIComponent(wellFormed(subject))}&body=${encodeURIComponent(mailBody(text))}`;
}

export function reportFileName(title: string, createdAt: string): string {
  const slug = title
    .replace(/^(compliance|problem) report:\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `gridsentinel-report-${slug || "report"}-${createdAt.slice(0, 10)}.txt`;
}

/* ------------------------------------------------------------- saved reports */

export const REPORTS_KEY = "gs-reports-v1";

export interface SavedReport {
  id: string;
  createdAt: string; // ISO
  title: string;
  subject: string;
  assetLabel: string;
  location: { lat: number; lon: number; text: string };
  contact: { name: string; url: string };
  text: string;
  situationId?: SituationId;
}

export function toSaved(doc: ComplianceDoc, now = new Date()): SavedReport {
  const createdAt = now.toISOString();
  return {
    id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt,
    title: doc.title,
    subject: doc.subject,
    assetLabel: doc.asset.label,
    location: { lat: doc.asset.lat, lon: doc.asset.lon, text: doc.asset.placeText },
    contact: { name: doc.utility.utility.name, url: doc.filingUrl },
    text: reportText(doc),
    situationId: doc.situationId,
  };
}

/* Older saved reports (before Nov 2026) had hazards, issues, note and sometimes aiText.
   They are kept and shown with their rule-based text; aiText is ignored. */
interface LegacyReport {
  id: string;
  createdAt: string;
  title: string;
  assetLabel: string;
  location: { lat: number; lon: number; text: string };
  issues: { text: string; severity?: string }[];
  hazards: string[];
  contact: { name: string; url: string };
  note?: string;
}

const LEGACY_HAZARDS: Record<string, string> = {
  tree: "Tree touching a wire",
  wire_down: "Wire on the ground",
  sparks: "Sparks or fire",
  outage: "Power is out",
  old_broken: "Looks old or broken",
  other: "Something else",
};
const LEGACY_SEVERITY: Record<string, string> = { info: "Note", warn: "Watch", danger: "Serious" };

function isLegacy(x: Record<string, unknown>): x is Record<string, unknown> & LegacyReport {
  const loc = x.location as LegacyReport["location"] | undefined;
  const contact = x.contact as LegacyReport["contact"] | undefined;
  return (
    typeof x.id === "string" && typeof x.title === "string" && typeof x.createdAt === "string" &&
    typeof x.assetLabel === "string" && !!loc && typeof loc.lat === "number" && typeof loc.lon === "number" &&
    Array.isArray(x.issues) && Array.isArray(x.hazards) && !!contact && typeof contact.url === "string"
  );
}

function legacyText(r: LegacyReport): string {
  const when = new Date(r.createdAt);
  const filed = Number.isNaN(when.getTime()) ? r.createdAt : when.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const hazards = r.hazards.map((h) => LEGACY_HAZARDS[h]).filter((x): x is string => !!x);
  const L = [
    r.title,
    `Filed: ${filed}`,
    "",
    `What: ${r.assetLabel}`,
    `Where: ${r.location.text}`,
    `Map: ${osmUrl(r.location.lat, r.location.lon)}`,
    "",
    "What's wrong:",
    ...(hazards.length ? hazards.map((h) => `- ${h}`) : ["- (nothing picked)"]),
  ];
  if (typeof r.note === "string" && r.note.trim()) L.push("", `Note: ${r.note.trim()}`);
  L.push(
    "",
    "What we checked (from public data):",
    ...r.issues.filter((i) => typeof i?.text === "string").map((i) => `- [${LEGACY_SEVERITY[i.severity ?? "info"] ?? "Note"}] ${i.text}`),
    "",
    `Who to contact: ${r.contact.name} - ${r.contact.url}`,
    "",
    "If a wire is down or anyone is in danger, call 911 first.",
    "Made with GridSentinel.",
  );
  return L.join("\n");
}

function normalize(x: unknown): SavedReport | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const loc = r.location as SavedReport["location"] | undefined;
  const contact = r.contact as SavedReport["contact"] | undefined;
  if (
    typeof r.text === "string" && typeof r.id === "string" && typeof r.title === "string" &&
    typeof r.createdAt === "string" && !!loc && typeof loc.lat === "number" && !!contact && typeof contact.url === "string"
  ) {
    return {
      id: r.id,
      createdAt: r.createdAt,
      title: r.title,
      subject: typeof r.subject === "string" ? r.subject : r.title,
      assetLabel: typeof r.assetLabel === "string" ? r.assetLabel : "",
      location: { lat: loc.lat, lon: loc.lon, text: typeof loc.text === "string" ? loc.text : "" },
      contact: { name: typeof contact.name === "string" ? contact.name : "", url: contact.url },
      text: r.text,
      ...(typeof r.situationId === "string" ? { situationId: r.situationId as SituationId } : {}),
    };
  }
  if (isLegacy(r)) {
    return {
      id: r.id,
      createdAt: r.createdAt,
      title: r.title,
      subject: r.title,
      assetLabel: r.assetLabel,
      location: { lat: r.location.lat, lon: r.location.lon, text: r.location.text ?? "" },
      contact: { name: r.contact.name ?? "", url: r.contact.url },
      text: legacyText(r),
    };
  }
  return null;
}

/** Reports saved on this device, newest first. [] when storage is unavailable or broken. */
export function loadReports(): SavedReport[] {
  try {
    const raw = window.localStorage.getItem(REPORTS_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map(normalize)
      .filter((r): r is SavedReport => r !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

/** false when the browser blocks storage (private mode, full, etc.). */
export function saveReports(reports: SavedReport[]): boolean {
  try {
    window.localStorage.setItem(REPORTS_KEY, JSON.stringify(reports));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- quick report ("Report a problem" tab) */
/*
 * The simple three-step report from the Report a problem tab: pick what's wrong, see what public data
 * says about the spot, file it. Every auto-issue is built only from real fields on the asset or the scan.
 * Who it goes to comes from the utility routing above (bill picker, CPUC / city / co-op board).
 */

export type Severity = "info" | "warn" | "danger";

export interface ReportIssue { text: string; severity: Severity }

export type HazardId = "tree" | "wire_down" | "sparks" | "outage" | "old_broken" | "other";

/** emergency: picking it shows the "call 911" stop screen instead of the report form. */
export const HAZARDS: { id: HazardId; label: string; emergency?: SituationId }[] = [
  { id: "tree", label: "Tree touching a wire" },
  { id: "wire_down", label: "Wire on the ground", emergency: "wire_down" },
  { id: "sparks", label: "Sparks or fire", emergency: "sparks" },
  { id: "outage", label: "Power is out" },
  { id: "old_broken", label: "Looks old or broken" },
  { id: "other", label: "Something else" },
];

export const SAFETY_LINE = "If a wire is down or anyone is in danger, call 911 first.";

/** The emergency situation for the picked hazards (wire down first), or null when none is an emergency. */
export function hazardEmergency(hazards: HazardId[]): SituationId | null {
  for (const h of HAZARDS) if (h.emergency && hazards.includes(h.id)) return h.emergency;
  return null;
}

export interface ReportDraft {
  title: string;
  assetLabel: string;
  location: { lat: number; lon: number; text: string };
  issues: ReportIssue[];
}

const pctOf = (ratio: number) => fmtNum(ratio * 100, 0);

/** Heat-wave screening check (105 °F, almost no wind, full sun; typical ACSR "Drake" wire). */
function heatwaveIssue(heatwave: boolean, subject: string, plural = false): ReportIssue | null {
  const hw = rateLine(heatwaveWeather());
  if (!isNum(hw.ratio) || hw.ratio >= 1) return null;
  const tempF = fmtNum(cToF(hw.weather.temp_c), 0);
  return {
    severity: heatwave ? "warn" : "info",
    text:
      `${subject} would overheat on a ${tempF} °F day with almost no wind if ${plural ? "they" : "it"} carried ` +
      `${plural ? "their" : "its"} normal load. ${plural ? "They" : "It"} could safely carry only about ` +
      `${pctOf(hw.ratio)}% of normal. (Computer estimate for a typical wire.)`,
  };
}

/** Live weather check, only when the weather really is live (not the 2025 fallback or the heat-wave scenario). */
function liveIssue(live: LineRatingNow | null, heatwave: boolean, subject: string): ReportIssue | null {
  if (heatwave || !live || live.weather.source !== "open-meteo-live") return null;
  if (!isNum(live.ratio) || live.ratio >= 1) return null;
  return {
    severity: "warn",
    text:
      `Right now it is ${fmtNum(cToF(live.weather.temp_c), 0)} °F here. ${subject} can safely carry only about ` +
      `${pctOf(live.ratio)}% of normal in this weather. (Computer estimate for a typical wire.)`,
  };
}

function missingIssue(kind: string, missing: string[]): ReportIssue | null {
  if (missing.length === 0) return null;
  const what = missing.join(" and ");
  return { severity: "info", text: `This ${kind}'s ${what} ${missing.length > 1 ? "are" : "is"} missing from public records.` };
}

function finish(issues: (ReportIssue | null)[]): ReportIssue[] {
  const out = issues.filter((x): x is ReportIssue => x !== null);
  if (!out.some((i) => i.severity !== "info")) {
    out.push({ severity: "info", text: "Nothing serious found in the public data we checked." });
  }
  return out;
}

export function buildDraft(
  target: ReportTarget,
  result: ScanResult,
  live: LineRatingNow | null,
  heatwave: boolean,
): ReportDraft {
  if (target.kind === "plant") {
    const p = target.plant;
    const fuel = FUEL_LABELS[p.primary_source] ?? "Other";
    const name = p.plant_name.trim() || `${fuel} power plant${p.city ? ` in ${p.city}` : ""}`;
    const age = p.capacity_weighted_age_years;
    const issues: (ReportIssue | null)[] = [];
    if (isNum(age) && age >= 40) {
      issues.push({
        severity: age >= 60 ? "danger" : "warn",
        text: `Most of this plant's machines are about ${fmtNum(age, 0)} years old. That is ${age >= 60 ? "very old" : "old"} for a power plant.`,
      });
    }
    if (isNum(p.planned_retirement_mw) && p.planned_retirement_mw > 0) {
      issues.push({ severity: "info", text: `The owner plans to shut down ${fmtPowerText(p.planned_retirement_mw)} here.` });
    }
    if (FUEL_CATEGORY[p.primary_source] === "fossil") {
      issues.push({ severity: "info", text: `It mostly burns ${fuel.toLowerCase()}, which puts pollution and CO2 into the air.` });
    }
    const missing: string[] = [];
    if (!p.plant_name.trim()) missing.push("name");
    if (p.grid_voltage_kv === null) missing.push("grid voltage");
    issues.push(missingIssue("plant", missing));
    const place = [p.city, p.county ? `${p.county} County` : ""].filter(Boolean).join(", ");
    const owner = p.utility_name?.trim() ? `, owner: ${p.utility_name.trim()}` : "";
    return {
      title: `Problem report: ${name}`,
      assetLabel: `${name} (${fmtPowerText(p.nameplate_mw)} ${fuel.toLowerCase()} power plant${owner})`,
      location: { lat: p.lat, lon: p.lon, text: place ? `${place} (${fmtCoord(p.lat, p.lon)})` : fmtCoord(p.lat, p.lon) },
      issues: finish(issues),
    };
  }

  if (target.kind === "substation") {
    const s = target.substation;
    const name = substationName(s);
    const missing: string[] = [];
    if (!s.name) missing.push("name");
    if (s.voltage_kv === null) missing.push("voltage");
    const kv = kvLabel(s.voltage_kv, s.kv_inferred);
    const op = s.operator ? `, operator: ${s.operator}` : "";
    return {
      title: `Problem report: ${name}`,
      assetLabel: `${name} (${kv ? `${kv} ` : ""}substation${op})`,
      location: { lat: s.lat, lon: s.lon, text: fmtCoord(s.lat, s.lon) },
      issues: finish([missingIssue("substation", missing)]),
    };
  }

  if (target.kind === "line") {
    const l = target.line;
    const name = lineName(l);
    const mid = l.coords[Math.floor(l.coords.length / 2)] ?? [result.area.lat, result.area.lon];
    const missing: string[] = [];
    if (!l.name) missing.push("name");
    if (l.voltage_kv === null) missing.push("voltage");
    const kv = kvLabel(l.voltage_kv, l.kv_inferred);
    const op = l.operator ? `, operator: ${l.operator}` : "";
    return {
      title: `Problem report: ${name}`,
      assetLabel: `${name} (${kv ? `${kv} ` : ""}power line, ${fmtNum(lineMiles(l), 1)} mi long${op})`,
      location: { lat: mid[0], lon: mid[1], text: `Middle of the line: ${fmtCoord(mid[0], mid[1])}` },
      issues: finish([
        heatwaveIssue(heatwave, "This power line"),
        liveIssue(live, heatwave, "This power line"),
        missingIssue("power line", missing),
      ]),
    };
  }

  // area
  const a = result.area;
  const issues: (ReportIssue | null)[] = [];
  const lvl = result.risk.level;
  if (lvl === "HIGH" || lvl === "CRITICAL") {
    const top = [...result.risk.factors].sort((x, y) => y.score * y.weight - x.score * x.weight)[0];
    issues.push({
      severity: lvl === "CRITICAL" ? "danger" : "warn",
      text:
        `GridSentinel's own risk index rated this area ${lvl === "CRITICAL" ? "critical" : "high"}: ${fmtNum(result.risk.score, 0)} out of 100.` +
        (top ? ` The biggest reason: ${top.label.toLowerCase()}.` : ""),
    });
  }
  if (result.lines.length > 0) {
    const n = result.lines.length;
    issues.push(n === 1 ? heatwaveIssue(heatwave, "The power line here") : heatwaveIssue(heatwave, `The ${fmtNum(n, 0)} power lines here`, true));
    issues.push(liveIssue(live, heatwave, "Power lines here"));
  }
  if (isNum(result.totals.planned_retirement_mw) && result.totals.planned_retirement_mw > 0) {
    issues.push({
      severity: "info",
      text: `Power plant owners here plan to shut down ${fmtPowerText(result.totals.planned_retirement_mw)} of power.`,
    });
  }
  return {
    title: `Problem report: ${result.area_label} (area)`,
    assetLabel: `The area within ${fmtNum(a.radius_mi, 0)} mi of ${result.area_label}`,
    location: { lat: a.lat, lon: a.lon, text: `Center: ${fmtCoord(a.lat, a.lon)}` },
    issues: finish(issues),
  };
}

const SEVERITY_WORD: Record<Severity, string> = { info: "Note", warn: "Watch", danger: "Serious" };
export const severityWord = (s: Severity) => SEVERITY_WORD[s];

export interface QuickRouting {
  /** Who gets the report first. */
  contactName: string;
  /** Best page to open first (the utility's report page, else the CPUC / city route). */
  url: string;
  /** Where to send it, in order: the utility, then the CPUC (SCE, SDG&E, PG&E...), the city, or the co-op board. */
  steps: SendStep[];
}

/** Picked hazards that are only about service (outage, something else) go the service route; the rest are safety. */
function hazardRoute(hazards: HazardId[]): Route {
  return hazards.length > 0 && hazards.every((h) => h === "outage" || h === "other") ? "service" : "safety";
}

export function quickRouting(hazards: HazardId[], u: UtilityMatch): QuickRouting {
  const { steps, filingUrl } = stepsFor({ route: hazardRoute(hazards) }, u);
  return {
    contactName: u.known ? u.utility.name : "Your local electric utility (its name is on your electric bill)",
    url: filingUrl,
    steps,
  };
}

function fmtFiled(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function quickReportText(
  draft: ReportDraft,
  hazards: HazardId[],
  note: string,
  routing: QuickRouting,
  createdAt: string,
): string {
  const picked = hazards.map((id) => HAZARDS.find((h) => h.id === id)?.label).filter((x): x is string => !!x);
  const L: string[] = [
    draft.title,
    `Filed: ${fmtFiled(createdAt)}`,
    "",
    `What: ${draft.assetLabel}`,
    `Where: ${draft.location.text}`,
    `Map: ${osmUrl(draft.location.lat, draft.location.lon)}`,
    "",
    "What's wrong:",
    ...(picked.length ? picked.map((h) => `- ${h}`) : ["- (nothing picked)"]),
  ];
  if (note.trim()) L.push("", `Note: ${note.trim()}`);
  L.push(
    "",
    "What we checked (from public data):",
    ...draft.issues.map((i) => `- [${SEVERITY_WORD[i.severity]}] ${i.text}`),
    "",
    `Who to contact: ${routing.contactName} - ${routing.url}`,
    "Where to send it, in order:",
  );
  routing.steps.forEach((st, i) => {
    L.push(`${i + 1}. ${st.title}`, `   ${st.detail}`);
    if (st.phone) L.push(`   Phone: ${st.phone.display}`);
    if (st.url) L.push(`   ${st.url}`);
  });
  L.push("", SAFETY_LINE, DISCLAIMER, "Made with GridSentinel.");
  return L.join("\n");
}

/** A filed quick report, saved in the same list (gs-reports-v1) as every other report. */
export function fileQuickReport(
  draft: ReportDraft,
  hazards: HazardId[],
  note: string,
  routing: QuickRouting,
  now = new Date(),
): SavedReport {
  const createdAt = now.toISOString();
  return {
    id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt,
    title: draft.title,
    subject: draft.title,
    assetLabel: draft.assetLabel,
    location: { ...draft.location },
    contact: { name: routing.contactName, url: routing.url },
    text: quickReportText(draft, hazards, note, routing, createdAt),
  };
}
