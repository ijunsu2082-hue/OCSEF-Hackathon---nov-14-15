/*
 * Applicability: decide whether a filing applies to this asset, instead of leaving
 * "check if it applies" on the screen.
 *
 * Three kinds of decision:
 *   applies         the rule's own threshold is met by facts we hold
 *   does_not_apply  a fact we hold puts the asset outside the rule
 *   needs_fact      one fact settles it and that fact is not in any public source we
 *                   can read; the question is asked once, in place, and the answer is
 *                   kept so the item resolves
 *
 * Where the fact is an agency list, the ETL reads that list
 * (research/etl/compliance/programs.ts -> public/compliance/applicability.json):
 * EPA's GHGRP facility list settles the greenhouse-gas filings, and its reported
 * emissions settle the CARB thresholds in the same direction.
 */
import type { Line, Plant, Substation } from "../scan/types";
import type { Obligation, OwnedAsset } from "./types";
import { classifyOwner } from "./obligations";

/* ------------------------------------------------------------- contract */

export type Applicability = "applies" | "does_not_apply" | "needs_fact";

export interface ApplicabilityQuestion {
  /** Stable id: answers are kept under it. */
  id: string;
  question: string;
  /** Where the fact comes from when the owner has it (a bill, a permit, a registry). */
  detail: string;
}

export interface Determination {
  obligationId: string;
  applicability: Applicability;
  /** Why, in plain words. */
  basis: string;
  /** The record the decision rests on, or null when it rests on the owner's answer. */
  source: string | null;
  question?: ApplicabilityQuestion;
}

export interface GhgrpFacility {
  facility_id: string;
  facility_name: string;
  distance_mi: number;
  year: number | null;
  co2e_tons: number | null;
}

export interface ProgramIndex {
  schema: "compliance-applicability/1";
  generated_at: string;
  /** GHGRP facilities that match one of our plants, by EIA plant code. */
  ghgrp: Record<string, GhgrpFacility>;
  /** Program lists that could not be read in the last ETL run. */
  unavailable: string[];
}

export type FactAnswer = "yes" | "no";
export type FactAnswers = Record<string, { answer: FactAnswer; at: string }>;

export const APPLICABILITY_SCHEMA = "compliance-applicability/1";
export const ANSWERS_KEY = "gs-applicability-v1";
export const GHGRP_SOURCE = "EPA Greenhouse Gas Reporting Program facility list (Envirofacts)";
export const EIA_SOURCE = "EIA-860 2025 final data";

/* ------------------------------------------------------------- answers (this device) */

export function loadFactAnswers(): FactAnswers {
  try {
    const raw = window.localStorage.getItem(ANSWERS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: FactAnswers = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as { answer?: unknown; at?: unknown };
      if (v && (v.answer === "yes" || v.answer === "no")) {
        out[id] = { answer: v.answer, at: typeof v.at === "string" ? v.at : "" };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** false when the browser blocks storage. */
export function saveFactAnswers(answers: FactAnswers): boolean {
  try {
    window.localStorage.setItem(ANSWERS_KEY, JSON.stringify(answers));
    return true;
  } catch {
    return false;
  }
}

let indexPromise: Promise<ProgramIndex | null> | null = null;

/** The ETL snapshot of agency program lists, or null when it has not been generated. */
export function loadProgramIndex(): Promise<ProgramIndex | null> {
  if (!indexPromise) {
    indexPromise = fetch("/compliance/applicability.json")
      .then(async (res) => {
        if (!res.ok) return null;
        const data = (await res.json()) as ProgramIndex;
        return data && data.schema === APPLICABILITY_SCHEMA ? data : null;
      })
      .catch(() => null);
  }
  return indexPromise;
}

/* ------------------------------------------------------------- asset facts */

const SCAQMD_COUNTIES = ["Los Angeles", "Orange", "Riverside", "San Bernardino"];

/** Rough California test: the map data reaches into Nevada and Mexico. */
function inCalifornia(lat: number, lon: number): boolean {
  const tMx = (lon - -117.1241) / (-114.7195 - -117.1241);
  if (lat <= 32.5343 + tMx * (32.7184 - 32.5343)) return false;
  if (lat >= 35 && lat <= 39) {
    const nvLon = -120 + ((39 - lat) / (39 - 35)) * (-114.6333 - -120);
    return lon < nvLon;
  }
  return lat < 35 ? lon < -114.13 : lon < -120;
}

interface AssetFacts {
  kind: OwnedAsset["kind"];
  ownerKind: "iou" | "pou" | "other" | null;
  ownerName: string;
  inCalifornia: boolean;
  county: string | null;
  nameplateMw: number | null;
  fossilMw: number | null;
  renewableMw: number | null;
  plannedRetirementMw: number | null;
  lat: number;
  lon: number;
}

const FOSSIL = ["natural_gas", "oil", "other_gas"] as const;
const RENEWABLE = ["solar", "wind", "hydro", "biogas", "waste_heat"] as const;

function factsFor(asset: OwnedAsset): AssetFacts {
  if (asset.kind === "plant") {
    const p: Plant = asset.plant;
    const owner = classifyOwner(p.utility_name);
    const sum = (keys: readonly string[]) =>
      keys.reduce((s, k) => s + (p.mw_by_source[k as keyof typeof p.mw_by_source] ?? 0), 0);
    return {
      kind: "plant",
      ownerKind: owner?.kind ?? null,
      ownerName: p.utility_name,
      inCalifornia: inCalifornia(p.lat, p.lon),
      county: p.county || null,
      nameplateMw: p.nameplate_mw,
      fossilMw: sum(FOSSIL),
      renewableMw: sum(RENEWABLE),
      plannedRetirementMw: p.planned_retirement_mw,
      lat: p.lat,
      lon: p.lon,
    };
  }
  if (asset.kind === "substation") {
    const s: Substation = asset.substation;
    const owner = classifyOwner(s.operator);
    return {
      kind: "substation",
      ownerKind: owner?.kind ?? null,
      ownerName: s.operator ?? "",
      inCalifornia: inCalifornia(s.lat, s.lon),
      county: null,
      nameplateMw: null,
      fossilMw: null,
      renewableMw: null,
      plannedRetirementMw: null,
      lat: s.lat,
      lon: s.lon,
    };
  }
  const l: Line = asset.line;
  const mid = l.coords[Math.floor(l.coords.length / 2)] ?? [0, 0];
  const owner = classifyOwner(l.operator);
  return {
    kind: "line",
    ownerKind: owner?.kind ?? null,
    ownerName: l.operator ?? "",
    inCalifornia: l.coords.some(([la, lo]) => inCalifornia(la, lo)),
    county: null,
    nameplateMw: null,
    fossilMw: null,
    renewableMw: null,
    plannedRetirementMw: null,
    lat: mid[0],
    lon: mid[1],
  };
}

/** Small power production QF test (18 CFR 292.204): at most 80 MW, 75% renewable or waste. */
function qfEligible(f: AssetFacts): boolean {
  if (f.nameplateMw == null || f.renewableMw == null) return false;
  return f.nameplateMw > 1 && f.nameplateMw <= 80 && f.renewableMw >= 0.75 * f.nameplateMw;
}

/* ------------------------------------------------------------- decision helpers */

const applies = (basis: string, source: string | null): Determination => ({
  obligationId: "",
  applicability: "applies",
  basis,
  source,
});

const doesNotApply = (basis: string, source: string | null): Determination => ({
  obligationId: "",
  applicability: "does_not_apply",
  basis,
  source,
});

const needsFact = (question: ApplicabilityQuestion): Determination => ({
  obligationId: "",
  applicability: "needs_fact",
  basis: question.detail,
  source: null,
  question,
});

function tons(n: number): string {
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 0 })} t CO2e`;
}

/* ------------------------------------------------------------- the rules */

function decide(
  asset: OwnedAsset,
  f: AssetFacts,
  o: Obligation,
  index: ProgramIndex | null,
): Determination {
  const ghgrp = asset.kind === "plant" ? index?.ghgrp[String(asset.plant.plant_code)] ?? null : null;
  const ghgrpUnread =
    !index ||
    index.unavailable.includes("ghgrp") ||
    (asset.kind === "plant" && !!asset.plant.county && index.unavailable.includes(`ghgrp:${asset.plant.county}`));

  // The Advisory Board's schedule names the utilities it covers, one rule per utility.
  if (o.id.startsWith("wsab-wmp-")) {
    return applies(
      "The Wildfire Safety Advisory Board's 2026-2029 schedule lists this utility by name.",
      "California Wildfire Safety Advisory Board schedule",
    );
  }

  switch (o.id) {
    /* --- EIA: the plant is in EIA-860, so these are settled ------------------ */
    case "eia-860":
    case "eia-923":
      return applies(
        "EIA requires this from grid-connected plants of 1 MW or more, and this plant is in EIA-860 2025.",
        EIA_SOURCE,
      );

    case "eia-923-monthly":
      return needsFact({
        id: "eia-923-monthly:sample",
        question: "Is this plant in EIA's monthly Form EIA-923 sample?",
        detail:
          "EIA picks the monthly respondents and publishes the list with the monthly data; who is in the sample is not in the plant data we hold.",
      });

    case "eia-860m":
      if ((f.plannedRetirementMw ?? 0) > 0) {
        return needsFact({
          id: "eia-860m:retirement-within-12-months",
          question: "Is a generator here retiring within the next 12 months?",
          detail:
            "EIA-860 2025 lists planned retirements at this plant. EIA-860M starts 12 months before the retirement date; the month is not in our data.",
        });
      }
      return doesNotApply(
        "EIA-860 2025 lists no planned retirement here, so the monthly retirement update is not triggered.",
        EIA_SOURCE,
      );

    /* --- CEC: the size thresholds are in the data -------------------------- */
    case "cec-qfer-quarterly":
      return applies("California plants of 10 MW or more file CEC-1304 every quarter.", EIA_SOURCE);
    case "cec-qfer-annual":
      return applies("California plants from 1 MW to under 10 MW file CEC-1304 once a year.", EIA_SOURCE);
    case "cec-1304-environmental":
      return applies(
        "Natural gas and solar plants of 50 MW or more file CEC-1304 Schedule 3.",
        EIA_SOURCE,
      );

    /* --- Greenhouse gas: the agency's own facility list decides ------------ */
    case "epa-ghgrp":
      if (ghgrp) {
        return applies(
          `EPA's GHGRP facility list has this plant as facility ${ghgrp.facility_id} (${ghgrp.facility_name}), ${ghgrp.distance_mi} mi away` +
            (ghgrp.year && ghgrp.co2e_tons != null ? `, ${tons(ghgrp.co2e_tons)} reported for ${ghgrp.year}.` : "."),
          GHGRP_SOURCE,
        );
      }
      if (ghgrpUnread) {
        return needsFact({
          id: "epa-ghgrp:in-program",
          question: "Does this plant file the EPA greenhouse gas report (GHGRP) today?",
          detail:
            "EPA's GHGRP facility list could not be read in the last run, so the public record cannot settle it. The list covers facilities at 25,000 t CO2e or more.",
        });
      }
      return doesNotApply(
        "This plant is not in EPA's GHGRP facility list for the latest reporting year, so it does not report under 40 CFR part 98.",
        GHGRP_SOURCE,
      );

    case "carb-mrr-report":
      if (ghgrp && ghgrp.co2e_tons == null) {
        return applies(
          "EPA lists this plant as a GHGRP reporter, and that program starts at 25,000 t CO2e — above CARB's 10,000 t threshold.",
          GHGRP_SOURCE,
        );
      }
      if (ghgrp?.co2e_tons != null && ghgrp.co2e_tons >= 10_000) {
        return applies(
          `EPA records ${tons(ghgrp.co2e_tons)} at this plant for ${ghgrp.year}, above CARB's 10,000 t CO2e threshold.`,
          GHGRP_SOURCE,
        );
      }
      if (ghgrp?.co2e_tons != null) {
        return doesNotApply(
          `EPA records ${tons(ghgrp.co2e_tons)} for ${ghgrp.year}, below CARB's 10,000 t CO2e threshold.`,
          GHGRP_SOURCE,
        );
      }
      return needsFact({
        id: "carb-mrr-report:annual-co2e",
        question: "Does this plant emit 10,000 metric tons CO2e or more in a year?",
        detail:
          "CARB's threshold is annual emissions. No reported figure covers this plant in the GHGRP list, so the number has to come from the plant's own records.",
      });

    case "carb-mrr-verification":
      if (ghgrp && ghgrp.co2e_tons == null) {
        return applies(
          "EPA lists this plant as a GHGRP reporter, and that program starts at 25,000 t CO2e, the same threshold CARB uses for verification.",
          GHGRP_SOURCE,
        );
      }
      if (ghgrp?.co2e_tons != null && ghgrp.co2e_tons >= 25_000) {
        return applies(
          `Reported emissions of ${tons(ghgrp.co2e_tons)} reach CARB's 25,000 t verification threshold.`,
          GHGRP_SOURCE,
        );
      }
      return needsFact({
        id: "carb-mrr-verification:25k",
        question: "Does this plant report 25,000 metric tons CO2e or more in a year?",
        detail:
          "Verification applies at 25,000 t CO2e. No reported figure covers this plant, so the annual total decides it.",
      });

    /* --- Air district: location decides membership, emissions the threshold -- */
    case "scaqmd-aer": {
      const county = f.county ?? "";
      if (!SCAQMD_COUNTIES.includes(county)) {
        return doesNotApply(
          `${county || "This"} County is outside the South Coast AQMD's four-county district (Los Angeles, Orange, Riverside, San Bernardino).`,
          "South Coast AQMD jurisdiction (county membership)",
        );
      }
      return needsFact({
        id: "scaqmd-aer:annual-emissions",
        question: "Does the plant emit 4 tons a year or more of NOx, SOx, VOC or PM (or 100 tons of CO)?",
        detail:
          "The plant is in the South Coast AQMD, so Rule 301 turns on the annual emissions total, which no public source we hold reports.",
      });
    }

    /* --- Acid Rain: needs the unit sizes behind the plant ------------------ */
    case "epa-part75-quarterly":
      if ((f.fossilMw ?? 0) <= 25) {
        return doesNotApply(
          "This plant has no fossil capacity above 25 MW, and the Acid Rain Program attaches to units serving a generator over 25 MW.",
          EIA_SOURCE,
        );
      }
      return needsFact({
        id: "epa-part75-quarterly:unit-size",
        question: "Does any single fossil unit here serve a generator larger than 25 MW (and is it free of an Acid Rain exemption)?",
        detail:
          "EIA-860 2025 gives the plant's total fossil capacity, not the size of each unit, and the program applies unit by unit.",
      });

    /* --- CPUC GO 167-C: exemptions we can test, one we cannot -------------- */
    case "go167c-incident":
    case "go167c-outage":
    case "go167c-operation":
    case "go167c-maintenance-logbook": {
      if (f.ownerKind === "pou") {
        return doesNotApply(
          "GO 167-C does not cover plants owned by a public agency, and EIA-860 names a public owner here.",
          `${EIA_SOURCE} (utility name)`,
        );
      }
      if (qfEligible(f)) {
        return needsFact({
          id: "go167c:qf-status",
          question: "Is this plant a certified qualifying facility (QF)?",
          detail:
            "The plant meets the 80 MW / 75% renewable test for a small power production QF. GO 167-C exempts qualifying facilities, so certification decides it.",
        });
      }
      return applies(
        "GO 167-C covers power plants and storage of 1 MW or more in California that are not public-agency plants or qualifying facilities.",
        EIA_SOURCE,
      );
    }

    /* --- Reliability and market filings: registry and status are external -- */
    case "nerc-gads-conventional":
    case "nerc-gads-wind":
    case "nerc-gads-solar":
      return needsFact({
        id: "nerc-gads:registry",
        question: "Is the owner on the NERC Compliance Registry for this asset?",
        detail:
          "GADS follows NERC registration. NERC's registry is not in our data, and registration is the fact that turns this on.",
      });

    case "ferc-eqr":
      return needsFact({
        id: "ferc-eqr:wholesale-sales",
        question: "Does the owner sell power at wholesale as a FERC public utility (for example under market-based rate authority)?",
        detail:
          "The Electric Quarterly Report attaches to wholesale sales. Whether the owner makes them is not in the public data we read.",
      });

    case "ferc-556":
      if (!qfEligible(f)) {
        return doesNotApply(
          "The plant does not meet the 80 MW / 75% renewable test for a small power production qualifying facility.",
          EIA_SOURCE,
        );
      }
      return needsFact({
        id: "ferc-556:qf-filing",
        question: "Has the owner self-certified this plant as a qualifying facility?",
        detail:
          "Filing Form 556 is how a QF is established. The plant meets the size test, and the certification is the owner's own filing.",
      });

    case "ferc-form-1":
    case "ferc-form-3q":
      if (f.ownerKind === "pou") {
        return doesNotApply(
          "Publicly owned utilities file EIA-861; FERC Form 1 covers public utilities under the Federal Power Act.",
          `${EIA_SOURCE} (utility name)`,
        );
      }
      return needsFact({
        id: "ferc-form-1:major-status",
        question: "Is the utility a FERC \"Major\" utility (the size test for Form 1)?",
        detail:
          "Form 1 and Form 3-Q follow the Major/non-Major classification, which FERC sets from the utility's own sales, not from plant data.",
      });

    /* --- Energy Safety and wildfire plans ---------------------------------- */
    case "oeis-wmp":
      return f.ownerKind === "iou"
        ? applies(
            "Electrical corporations file wildfire mitigation plans with Energy Safety, and EIA-860 names an investor-owned utility here.",
            `${EIA_SOURCE} (utility name)`,
          )
        : doesNotApply(
            "Wildfire mitigation plans go to Energy Safety from electrical corporations; this owner is not one.",
            `${EIA_SOURCE} (utility name)`,
          );

    case "eia-861":
      return f.ownerKind === "iou" || f.ownerKind === "pou"
        ? applies("EIA-861 is filed once per operating company by utilities and transmission owners.", EIA_SOURCE)
        : needsFact({
            id: "eia-861:utility-status",
            question: "Is this asset's owner a utility or transmission owner?",
            detail:
              "EIA-861 follows utility status. The operator in OpenStreetMap does not say whether it is one.",
          });

    /* --- Overhead line and substation rules -------------------------------- */
    case "go95-rule18":
      return applies(
        "GO 95 Rule 18 applies to each company with overhead lines in California.",
        "CPUC General Order 95",
      );

    case "go165-transmission":
      return f.ownerKind === "pou"
        ? doesNotApply(
            "GO 165 covers CPUC-regulated utilities; this operator is publicly owned and answers to its city or board.",
            "CPUC General Order 165",
          )
        : applies(
            "GO 165 requires CPUC-regulated utilities to keep transmission inspection procedures and records.",
            "CPUC General Order 165",
          );

    case "go174-annual":
      return needsFact({
        id: "go174-annual:control",
        question: "Is this substation under CAISO operational control or FERC reliability standards?",
        detail:
          "GO 174 exempts substations under CAISO operational control or FERC reliability standards, and control is not in the map data.",
      });

    case "ferc-881-aar":
      return f.ownerKind === "pou"
        ? doesNotApply(
            "FERC Order 881 line ratings apply to transmission owners in the CAISO grid; this operator is publicly owned.",
            "FERC Order 881 / CAISO",
          )
        : applies(
            "FERC Order 881 ambient-adjusted ratings apply to transmission owners in the CAISO grid.",
            "FERC Order 881 / CAISO",
          );

    default:
      break;
  }

  return o.confidence === "verified"
    ? applies(o.appliesBecause, null)
    : needsFact({
        id: `${o.id}:condition`,
        question: "Does this filing apply to this asset?",
        detail: o.appliesBecause,
      });
}

/* ------------------------------------------------------------- public API */

/**
 * The decision for one filing, with the owner's saved answer applied when one exists.
 * An answer to a question turns the item into applies / does not apply for good.
 */
export function determine(
  asset: OwnedAsset,
  obligation: Obligation,
  index: ProgramIndex | null,
  answers: FactAnswers = {},
): Determination {
  const f = factsFor(asset);
  const base = decide(asset, f, obligation, index);
  const question = base.question;
  const answer = question ? answers[question.id] : undefined;
  const done: Determination = { ...base, obligationId: obligation.id };
  if (!question || !answer) return done;
  return {
    obligationId: obligation.id,
    applicability: answer.answer === "yes" ? "applies" : "does_not_apply",
    basis: `You answered "${answer.answer === "yes" ? "yes" : "no"}" to: ${question.question}`,
    source: "Your answer, saved on this device",
  };
}

export function determineAll(
  asset: OwnedAsset,
  obligations: Obligation[],
  index: ProgramIndex | null,
  answers: FactAnswers = {},
): Record<string, Determination> {
  const out: Record<string, Determination> = {};
  for (const o of obligations) out[o.id] = determine(asset, o, index, answers);
  return out;
}

/** Counting line for the section, e.g. "7 apply, 2 do not, 3 need one fact". */
export function summarize(determinations: Determination[]): {
  applies: number;
  doesNotApply: number;
  needsFact: number;
} {
  let a = 0;
  let n = 0;
  let q = 0;
  for (const d of determinations) {
    if (d.applicability === "applies") a += 1;
    else if (d.applicability === "does_not_apply") n += 1;
    else q += 1;
  }
  return { applies: a, doesNotApply: n, needsFact: q };
}

/** Keep only the filings that actually apply or still need one fact. */
export function applicableOnly(
  obligations: Obligation[],
  determinations: Record<string, Determination>,
): Obligation[] {
  return obligations.filter((o) => determinations[o.id]?.applicability !== "does_not_apply");
}
