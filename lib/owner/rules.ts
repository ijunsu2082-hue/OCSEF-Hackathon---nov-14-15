/*
 * Owner filing rules: what each agency requires, when, and where the rule is written.
 * Every entry was read on the official page or PDF in its citations (checked Nov 14, 2026).
 * Research notes with quotes: scratchpad/owner/obligations-notes.md.
 *
 * Who a rule applies to is decided in obligations.ts from the asset's data; this file only
 * holds the rule text, the citations and the due-date schedule.
 */
import type { Citation, Frequency } from "./types";

/* ---------------------------------------------------------------- schedules */

/**
 * How to move a due date that lands on a day off. Only used when the rule itself says so.
 * "weekend": Saturday/Sunday move to Monday. "federal": also skips U.S. legal public holidays.
 */
export type Roll = "weekend" | "federal";

/** [monthOffsetFromQuarterYear... ] a due date for quarter q: year offset, month (1-12), day. */
export type QuarterDue = { yearOffset: 0 | 1; month: number; day: number };

export type Schedule =
  /** Event-driven or no fixed date we can compute. */
  | { kind: "none" }
  /** For calendar year Y, due on month/day of year Y+1. `overrides` replaces the date for a given Y. */
  | { kind: "annual"; month: number; day: number; roll?: Roll; overrides?: Record<number, string> }
  /** For calendar year Y, due on the last business day of `month` in Y+1 (federal holidays skipped). */
  | { kind: "annual-last-business-day"; month: number }
  /** For calendar year Y, `days` after the first business day of January of Y+1 (approximate rule). */
  | { kind: "annual-after-january-open"; days: number }
  /** For each calendar quarter (or only `quarters`, 1-4), `days` after the last day of the quarter. */
  | { kind: "quarterly-after"; days: number; roll?: Roll; quarters?: (1 | 2 | 3 | 4)[] }
  /** For each calendar quarter Q1..Q4, a fixed calendar date. */
  | { kind: "quarterly-dates"; due: [QuarterDue, QuarterDue, QuarterDue, QuarterDue]; roll?: Roll }
  /** For each month, due on `day` (or the last day) of the following month. */
  | { kind: "monthly"; day: number | "last" }
  /** Fixed dates set by the agency. */
  | { kind: "dates"; dates: { due: string; label: string }[] };

export interface RuleDef {
  id: string;
  title: string;
  agency: string;
  form: string;
  formUrl: string;
  frequency: Frequency;
  dueRule: string;
  citations: Citation[];
  notes?: string;
  schedule: Schedule;
}

/* ---------------------------------------------------------------- agencies */

export const AGENCY = {
  eia: "U.S. Energy Information Administration (EIA)",
  epa: "U.S. Environmental Protection Agency (EPA)",
  carb: "California Air Resources Board (CARB)",
  scaqmd: "South Coast Air Quality Management District (South Coast AQMD)",
  cec: "California Energy Commission (CEC)",
  cpuc: "California Public Utilities Commission (CPUC)",
  ferc: "Federal Energy Regulatory Commission (FERC)",
  nerc: "North American Electric Reliability Corporation (NERC)",
  oeis: "Office of Energy Infrastructure Safety (Energy Safety)",
  wsab: "California Wildfire Safety Advisory Board, Office of Energy Infrastructure Safety",
} as const;

/* ---------------------------------------------------------------- citations */

const C = {
  eia860: { label: "Form EIA-860 instructions (OMB 1905-0129, expires 07/31/2029)", url: "https://www.eia.gov/survey/form/eia_860/instructions.pdf" },
  eia860m: { label: "Form EIA-860M instructions", url: "https://www.eia.gov/survey/form/eia_860m/instructions.pdf" },
  eia923: { label: "Form EIA-923 instructions", url: "https://www.eia.gov/survey/form/eia_923/instructions.pdf" },
  eia861: { label: "Form EIA-861 instructions", url: "https://www.eia.gov/survey/form/eia_861/instructions.pdf" },
  cfr98_2: { label: "40 CFR 98.2, who must report", url: "https://www.ecfr.gov/current/title-40/section-98.2" },
  cfr98_3: { label: "40 CFR 98.3(b), report schedule", url: "https://www.ecfr.gov/current/title-40/section-98.3" },
  cfr98_40: { label: "40 CFR 98.40, electricity generation source category", url: "https://www.ecfr.gov/current/title-40/section-98.40" },
  fr2026_20982: {
    label: "EPA interim final rule extending the reporting year 2025 deadline to March 10, 2027 (FR Doc. 2026-20982)",
    url: "https://www.federalregister.gov/d/2026-20982",
  },
  cfr72_6: { label: "40 CFR 72.6, Acid Rain Program applicability", url: "https://www.ecfr.gov/current/title-40/section-72.6" },
  cfr75_64: { label: "40 CFR 75.64(a), quarterly reports", url: "https://www.ecfr.gov/current/title-40/section-75.64" },
  mrrReg: {
    label: "CARB Regulation for the Mandatory Reporting of GHG Emissions, 17 CCR 95101 and 95103 (unofficial 2026 text)",
    url: "https://ww2.arb.ca.gov/sites/default/files/classic/cc/reporting/ghg-rep/regulation/mrr_2026_unofficial_2026-10-14.pdf",
  },
  mrrDates: { label: "CARB Mandatory GHG Reporting key dates", url: "https://ww2.arb.ca.gov/mrr-key-dates" },
  aer: { label: "South Coast AQMD Annual Emissions Reporting", url: "https://www.aqmd.gov/home/rules-compliance/compliance/annual-emission-reporting" },
  rule301: { label: "South Coast AQMD Rule 301(e) (amended May 1, 2026)", url: "https://www.aqmd.gov/docs/default-source/rule-book/reg-iii/rule-301.pdf" },
  aqmdAbout: { label: "About South Coast AQMD", url: "https://www.aqmd.gov/nav/about" },
  qfer: { label: "Form CEC-1304 instructions (20 CCR 1304)", url: "https://www.energy.ca.gov/sites/default/files/2022-02/1304_Instructions_ADA.pdf" },
  go167c: { label: "CPUC General Order 167-C", url: "https://docs.cpuc.ca.gov/PublishedDocs/Published/G000/M567/K474/567474805.pdf" },
  gess: {
    label: "CPUC Generation and Energy Storage Section (filing dates)",
    url: "https://www.cpuc.ca.gov/about-cpuc/divisions/safety-and-enforcement-division/electric-safety-and-reliability-branch/generation-and-energy-storage-section",
  },
  go95: { label: "CPUC General Order 95, Rule 18 (December 2024 edition)", url: "https://docs.cpuc.ca.gov/PublishedDocs/Published/G000/M550/K438/550438485.pdf" },
  go165: { label: "CPUC General Order 165 (December 2017)", url: "https://docs.cpuc.ca.gov/PublishedDocs/Published/G000/M209/K552/209552704.pdf" },
  go174: { label: "CPUC General Order 174, Rules for Electric Utility Substations", url: "https://docs.cpuc.ca.gov/PublishedDocs/Published/G000/M031/K879/31879476.PDF" },
  d1002034: {
    label: "CPUC D.10-02-034: safety rules for publicly owned utilities' lines",
    url: "https://docs.cpuc.ca.gov/PUBLISHED/FINAL_DECISION/114225-01.htm",
  },
  cfr35_10b: { label: "18 CFR 35.10b, Electric Quarterly Reports", url: "https://www.ecfr.gov/current/title-18/section-35.10b" },
  order917: { label: "FERC Order No. 917, 91 FR 14347 (Mar 24, 2026)", url: "https://www.govinfo.gov/content/pkg/FR-2026-03-24/pdf/2026-05709.pdf" },
  cfr385_2007: { label: "18 CFR 385.2007, computing FERC deadlines", url: "https://www.ecfr.gov/current/title-18/section-385.2007" },
  cfr141_1: { label: "18 CFR 141.1, FERC Form No. 1", url: "https://www.ecfr.gov/current/title-18/section-141.1" },
  cfr141_400: { label: "18 CFR 141.400, FERC Form No. 3-Q", url: "https://www.ecfr.gov/current/title-18/section-141.400" },
  cfr292_203: { label: "18 CFR 292.203, qualifying facility requirements", url: "https://www.ecfr.gov/current/title-18/section-292.203" },
  cfr292_204: { label: "18 CFR 292.204, small power production size limit", url: "https://www.ecfr.gov/current/title-18/section-292.204" },
  cfr292_205: { label: "18 CFR 292.205, qualifying cogeneration facilities", url: "https://www.ecfr.gov/current/title-18/section-292.205" },
  cfr292_207: { label: "18 CFR 292.207, self-certification", url: "https://www.ecfr.gov/current/title-18/section-292.207" },
  caiso881: {
    label: "FERC order granting CAISO an Order No. 881 extension (ER22-2362-002, Apr 30, 2025)",
    url: "https://www.caiso.com/documents/apr-30-2025-order-accepting-motion-for-extension-order-no-881-er22-2362.pdf",
  },
  order881: {
    label: "FERC Order No. 881, Managing Transmission Line Ratings (87 FR 2244)",
    url: "https://www.federalregister.gov/documents/2022/01/13/2021-27735/managing-transmission-line-ratings",
  },
  gadsConv: { label: "NERC GADS Data Reporting Instructions, 2026", url: "https://www.nerc.com/globalassets/programs/rapa/gads/conventional/2026-gads-dri.pdf" },
  gadsWind: {
    label: "NERC GADS Wind Data Reporting Instructions, 2026",
    url: "https://www.nerc.com/globalassets/programs/rapa/gads/wind/2026-gads-wind-data-reporting-instructions.pdf",
  },
  gadsSolar: {
    label: "NERC GADS Solar Data Reporting Instructions, effective Jan 1, 2026",
    url: "https://www.nerc.com/globalassets/programs/rapa/gads/solar/2026-gads-solar-data-reporting-instructions.pdf",
  },
  wmpIou: {
    label: "Energy Safety, Revised WMP Submission Schedules (Apr 9, 2026)",
    url: "https://efiling.energysafety.ca.gov/eFiling/Getfile.aspx?fileid=60550&docket=2026-2028-Base-WMPs&shareable=true",
  },
  wmpPou: {
    label: "WSAB 2026-2029 WMP schedule for publicly owned utilities and cooperatives (adopted Mar 4, 2026)",
    url: "https://energysafety.ca.gov/wp-content/uploads/sites/171/2026/01//adopted-revised-2026-2029-pou-and-co-op-wmp-submission-schedule-2026-03-04.pdf",
  },
} satisfies Record<string, Citation>;

const URL = {
  eiaSurvey860: "https://www.eia.gov/survey/#eia-860",
  eiaSurvey860m: "https://www.eia.gov/survey/#eia-860m",
  eiaSurvey923: "https://www.eia.gov/survey/#eia-923",
  eiaSurvey861: "https://www.eia.gov/survey/#eia-861",
  ghgrp: "https://www.epa.gov/ghgreporting",
  part75: "https://www.epa.gov/power-sector/emissions-monitoring-and-reporting",
  cecForms: "https://www.energy.ca.gov/resources/forms/forms-instructions-reporting-electric-and-natural-gas-sales-and-electric",
  cpucEmergency: "https://www.cpuc.ca.gov/regulatory-services/safety/emergency-reporting",
  eqr: "https://www.ferc.gov/industries-data/electric/power-sales-and-markets/electric-quarterly-reports-eqr",
  fercForms: "https://www.ferc.gov/general-information-0/electric-industry-forms",
  fercQf: "https://www.ferc.gov/qf",
  gads: "https://www.nerc.com/programs/reliability-assessment--performance-analysis/generating-availability-data-system",
  wmp: "https://energysafety.ca.gov/what-we-do/electrical-infrastructure-safety/wildfire-mitigation-and-safety/wildfire-mitigation-plans/",
  wsab: "https://energysafety.ca.gov/what-we-do/wildfire-safety-advisory-board/publications/",
} as const;

/* ---------------------------------------------------------------- rules */

const LIST: RuleDef[] = [
  /* ---- EIA: power plants ---- */
  {
    id: "eia-860",
    title: "Annual electric generator report",
    agency: AGENCY.eia,
    form: "Form EIA-860",
    formUrl: URL.eiaSurvey860,
    frequency: "annual",
    dueRule:
      "Each year between the first business day of January and the last business day of February, showing equipment status as of December 31 of the prior year.",
    citations: [C.eia860],
    notes:
      "Only the plant's operator files for a jointly owned plant. If EIA opens its online system late, the deadline moves day for day. New additions, retirements or uprates decided after filing go to EIA-860@eia.gov.",
    schedule: { kind: "annual-last-business-day", month: 2 },
  },
  {
    id: "eia-860m",
    title: "Monthly update on planned additions and retirements",
    agency: AGENCY.eia,
    form: "Form EIA-860M",
    formUrl: URL.eiaSurvey860m,
    frequency: "monthly",
    dueRule:
      "About the 15th of the month after each month, starting when a generator is within 12 months of retiring or of starting operation, or a modification is within one month of completion.",
    citations: [C.eia860m],
    schedule: { kind: "monthly", day: 15 },
  },
  {
    id: "eia-923",
    title: "Annual power plant operations report",
    agency: AGENCY.eia,
    form: "Form EIA-923",
    formUrl: URL.eiaSurvey923,
    frequency: "annual",
    dueRule:
      "Plants not in EIA's monthly sample file once a year, about 45 days after the online form opens (EIA aims to open it on the first business day of January).",
    citations: [C.eia923],
    notes: "Plants in the monthly sample file monthly instead and add the annual schedules 6 to 8 where they apply.",
    schedule: { kind: "annual-after-january-open", days: 45 },
  },
  {
    id: "eia-923-monthly",
    title: "Monthly power plant operations report (if in EIA's sample)",
    agency: AGENCY.eia,
    form: "Form EIA-923",
    formUrl: URL.eiaSurvey923,
    frequency: "monthly",
    dueRule: "By the last day of the month after each reporting month (July data are due August 31).",
    citations: [C.eia923],
    notes: "Applies only if EIA selected the plant for the monthly sample; EIA tells selected plants.",
    schedule: { kind: "monthly", day: "last" },
  },

  /* ---- EPA ---- */
  {
    id: "epa-ghgrp",
    title: "Annual greenhouse gas report",
    agency: AGENCY.epa,
    form: "EPA Greenhouse Gas Reporting Program (40 CFR part 98, subparts C and D)",
    formUrl: URL.ghgrp,
    frequency: "annual",
    dueRule:
      "By March 31 for the prior year's emissions (next business day if a weekend or federal holiday). The 2025 report is due March 10, 2027 (EPA extension).",
    citations: [C.cfr98_2, C.cfr98_40, C.cfr98_3, C.fr2026_20982],
    notes:
      "Units that report CO2 year-round under 40 CFR part 75 report regardless of emissions (subpart D). Other combustion sources report when the facility has at least 30 mmBtu/hr of combustion capacity and emits 25,000 metric tons CO2e or more. EPA's proposal to end most reporting is still pending.",
    schedule: { kind: "annual", month: 3, day: 31, roll: "federal", overrides: { 2024: "2025-05-30", 2025: "2027-03-10" } },
  },
  {
    id: "epa-part75-quarterly",
    title: "Quarterly emissions monitoring report (Acid Rain Program)",
    agency: AGENCY.epa,
    form: "40 CFR part 75 quarterly electronic data report",
    formUrl: URL.part75,
    frequency: "quarterly",
    dueRule: "Within 30 days after the end of each calendar quarter.",
    citations: [C.cfr72_6, C.cfr75_64],
    notes:
      "Applies to Acid Rain units: fossil fuel units serving a generator larger than 25 MW that sells power, unless exempt (for example simple combustion turbines in service before Nov 15, 1990, some cogeneration plants and qualifying facilities).",
    schedule: { kind: "quarterly-after", days: 30 },
  },

  /* ---- CARB ---- */
  {
    id: "carb-mrr-report",
    title: "California greenhouse gas emissions report",
    agency: AGENCY.carb,
    form: "CARB Mandatory Reporting Regulation emissions data report (Cal e-GGRT)",
    formUrl: C.mrrDates.url,
    frequency: "annual",
    dueRule: "By April 10 for the prior year. Facilities eligible for abbreviated reporting file by June 1.",
    citations: [C.mrrReg, C.mrrDates],
    notes:
      "Required regardless of emissions for units that report CO2 under 40 CFR part 75; other combustion units report at 10,000 metric tons CO2e or more. Abbreviated reports are for facilities under 25,000 metric tons with no cap-and-invest obligation that are not under EPA part 98. CARB grants no extensions.",
    schedule: { kind: "annual", month: 4, day: 10 },
  },
  {
    id: "carb-mrr-verification",
    title: "Third-party verification of the California greenhouse gas report",
    agency: AGENCY.carb,
    form: "CARB verification statement (by an accredited verification body)",
    formUrl: C.mrrDates.url,
    frequency: "annual",
    dueRule: "Verification statements due to CARB by August 10 each year.",
    citations: [C.mrrReg, C.mrrDates],
    notes: "Required when reported emissions are 25,000 metric tons CO2e or more, or the facility has a cap-and-invest obligation.",
    schedule: { kind: "annual", month: 8, day: 10 },
  },

  /* ---- South Coast AQMD ---- */
  {
    id: "scaqmd-aer",
    title: "Annual emissions report and emission fees",
    agency: AGENCY.scaqmd,
    form: "Annual Emissions Report (AER), Rule 301",
    formUrl: C.aer.url,
    frequency: "annual",
    dueRule:
      "By April 10 for the prior year (moves to the next business day if it falls on a weekend or state holiday). The District can set a later date: 2025 reports were due May 1, 2026.",
    citations: [C.rule301, C.aer, C.aqmdAbout],
    notes:
      "Required for facilities that emit 4 tons a year or more of SOx, VOC, NOx, SPOG or PM, or 100 tons or more of CO, and for AB 2588 and CTR facilities.",
    schedule: { kind: "annual", month: 4, day: 10, roll: "weekend" },
  },

  /* ---- CEC ---- */
  {
    id: "cec-qfer-quarterly",
    title: "Quarterly power plant generation and fuel report",
    agency: AGENCY.cec,
    form: "Form CEC-1304, Schedules 1 and 2 (QFER)",
    formUrl: URL.cecForms,
    frequency: "quarterly",
    dueRule: "On the 15th of February, May, August and November for the previous quarter.",
    citations: [C.qfer],
    schedule: {
      kind: "quarterly-dates",
      due: [
        { yearOffset: 0, month: 5, day: 15 },
        { yearOffset: 0, month: 8, day: 15 },
        { yearOffset: 0, month: 11, day: 15 },
        { yearOffset: 1, month: 2, day: 15 },
      ],
    },
  },
  {
    id: "cec-qfer-annual",
    title: "Annual power plant generation and fuel report",
    agency: AGENCY.cec,
    form: "Form CEC-1304, Schedules 1 and 2 (QFER)",
    formUrl: URL.cecForms,
    frequency: "annual",
    dueRule: "On February 15 for the previous calendar year.",
    citations: [C.qfer],
    schedule: { kind: "annual", month: 2, day: 15 },
  },
  {
    id: "cec-1304-environmental",
    title: "Annual water use and wastewater report",
    agency: AGENCY.cec,
    form: "Form CEC-1304, Schedule 3",
    formUrl: URL.cecForms,
    frequency: "annual",
    dueRule: "On February 15 for the previous calendar year (January to December).",
    citations: [C.qfer],
    schedule: { kind: "annual", month: 2, day: 15 },
  },

  /* ---- CPUC GO 167-C (generating assets and energy storage) ---- */
  {
    id: "go167c-incident",
    title: "Safety incident report for a power plant or storage site",
    agency: AGENCY.cpuc,
    form: "CPUC emergency reporting (GO 167-C section 9.4)",
    formUrl: URL.cpucEmergency,
    frequency: "event",
    dueRule:
      "Within 24 hours of a safety-related incident (death, overnight hospitalization, a report to Cal/OSHA or OSHA, over $200,000 of damage, fire, explosion or hazardous emissions, or major news coverage). A written report follows within five business days if not given at first.",
    citations: [C.go167c, C.gess],
    schedule: { kind: "none" },
  },
  {
    id: "go167c-outage",
    title: "Outage reports to the grid operator",
    agency: AGENCY.cpuc,
    form: "GO 167-C section 9.3.1 outage report to CAISO",
    formUrl: C.gess.url,
    frequency: "event",
    dueRule:
      "Whenever the plant or storage is unavailable or available only at reduced capacity, report the periods and the reasons for unscheduled outages to CAISO.",
    citations: [C.go167c],
    schedule: { kind: "none" },
  },
  {
    id: "go167c-maintenance-logbook",
    title: "Maintenance and logbook standards certification",
    agency: AGENCY.cpuc,
    form: "GO 167-C maintenance and logbook standards filing (PPOR portal)",
    formUrl: C.gess.url,
    frequency: "once",
    dueRule: "Every other year on a schedule set by CPUC staff. Next filing due February 1, 2027.",
    citations: [C.go167c, C.gess],
    notes: "Plants and storage of 50 MW or more. A notice of material change is due within 30 days of a change.",
    schedule: { kind: "dates", dates: [{ due: "2027-02-01", label: "2027 filing" }] },
  },
  {
    id: "go167c-operation",
    title: "Operation standards certification",
    agency: AGENCY.cpuc,
    form: "GO 167-C operation standards filing (PPOR portal)",
    formUrl: C.gess.url,
    frequency: "once",
    dueRule: "Every other year on a schedule set by CPUC staff. Next filing due February 1, 2028.",
    citations: [C.go167c, C.gess],
    notes: "Plants and storage of 50 MW or more.",
    schedule: { kind: "dates", dates: [{ due: "2028-02-01", label: "2028 filing" }] },
  },

  /* ---- NERC GADS ---- */
  {
    id: "nerc-gads-conventional",
    title: "Generator availability data (conventional units)",
    agency: AGENCY.nerc,
    form: "NERC GADS event and performance data (webE-GADS)",
    formUrl: URL.gads,
    frequency: "quarterly",
    dueRule: "Within 45 days after the end of each calendar quarter.",
    citations: [C.gadsConv, C.go167c],
    notes:
      "Required for NERC-registered owners (units of 20 MW or more; wind plants of 75 MW or more; solar plants of 20 MW or more). In California, GO 167-C section 9.3.2 also requires covered generating asset and storage owners to submit the GADS data NERC accepts.",
    schedule: { kind: "quarterly-after", days: 45 },
  },
  {
    id: "nerc-gads-wind",
    title: "Generator availability data (wind)",
    agency: AGENCY.nerc,
    form: "NERC GADS Wind",
    formUrl: URL.gads,
    frequency: "quarterly",
    dueRule: "Within 45 days after the end of each calendar quarter.",
    citations: [C.gadsWind, C.go167c],
    notes:
      "Required for NERC-registered Generator Owners of wind plants of 75 MW or more with a commercial date of 2005 or later. In California, GO 167-C section 9.3.2 also requires covered generating asset and storage owners to submit the GADS data NERC accepts.",
    schedule: { kind: "quarterly-after", days: 45 },
  },
  {
    id: "nerc-gads-solar",
    title: "Generator availability data (solar)",
    agency: AGENCY.nerc,
    form: "NERC GADS Solar",
    formUrl: URL.gads,
    frequency: "quarterly",
    dueRule: "Within 45 days after the end of each calendar quarter.",
    citations: [C.gadsSolar, C.go167c],
    notes:
      "Required for NERC-registered Generator Owners of solar plants of 20 MW or more that began operating in 2010 or later. In California, GO 167-C section 9.3.2 also requires covered generating asset and storage owners to submit the GADS data NERC accepts.",
    schedule: { kind: "quarterly-after", days: 45 },
  },

  /* ---- FERC ---- */
  {
    id: "ferc-eqr",
    title: "Electric Quarterly Report of wholesale sales",
    agency: AGENCY.ferc,
    form: "FERC Electric Quarterly Report (EQR)",
    formUrl: URL.eqr,
    frequency: "quarterly",
    dueRule:
      "One month after each quarter: April 30, July 31, October 31 and January 31 (next business day if that is a weekend or federal holiday).",
    citations: [C.cfr35_10b, C.order917, C.cfr385_2007],
    notes:
      "FERC Order No. 917 moves each deadline to four months after the quarter, but only once FERC's new XBRL-CSV filing system is running. Required for public utilities (such as sellers with market-based rate authority) and large non-public sellers.",
    schedule: {
      kind: "quarterly-dates",
      due: [
        { yearOffset: 0, month: 4, day: 30 },
        { yearOffset: 0, month: 7, day: 31 },
        { yearOffset: 0, month: 10, day: 31 },
        { yearOffset: 1, month: 1, day: 31 },
      ],
      roll: "federal",
    },
  },
  {
    id: "ferc-556",
    title: "Qualifying facility certification",
    agency: AGENCY.ferc,
    form: "FERC Form No. 556",
    formUrl: URL.fercQf,
    frequency: "event",
    dueRule:
      "File to claim qualifying facility status, and file again (recertify) when the facts in the last filing change. Facilities of 1 MW or less are exempt from filing.",
    citations: [C.cfr292_203, C.cfr292_204, C.cfr292_205, C.cfr292_207],
    notes:
      "A small power production qualifying facility is limited to 80 MW of total capacity at one site (18 CFR 292.204(a)), and at least 75% of its energy input must come from renewable resources, biomass or waste (292.204(b)). Cogeneration facilities can also be qualifying facilities at any size (292.205); this list does not test for cogeneration, so a cogeneration owner should check that case separately.",
    schedule: { kind: "none" },
  },
  {
    id: "ferc-form-1",
    title: "Annual report of a major electric utility",
    agency: AGENCY.ferc,
    form: "FERC Form No. 1",
    formUrl: URL.fercForms,
    frequency: "annual",
    dueRule: "By April 18 for the prior year (next business day if that is a weekend or federal holiday).",
    citations: [C.cfr141_1, C.cfr385_2007],
    notes:
      "Required for Major utilities and licensees. Cities and other municipal utilities are excepted. The same companies also file the quarterly FERC Form No. 3-Q.",
    schedule: { kind: "annual", month: 4, day: 18, roll: "federal" },
  },
  {
    id: "ferc-form-3q",
    title: "Quarterly financial report of an electric utility",
    agency: AGENCY.ferc,
    form: "FERC Form No. 3-Q (electric)",
    formUrl: URL.fercForms,
    frequency: "quarterly",
    dueRule:
      "Major utilities: within 60 days after the end of the first, second and third quarters (next business day if that is a weekend or federal holiday). The fourth quarter is covered by the annual Form 1. FERC's 2026 dates were June 1, August 31 and November 30.",
    citations: [C.cfr141_400, C.cfr385_2007],
    notes:
      "Required for the utilities and licensees that file Form 1; cities and other municipal utilities are excepted. Nonmajor utilities file within 70 days instead. FERC posts each year's dates on its electric industry forms page.",
    schedule: { kind: "quarterly-after", days: 60, roll: "federal", quarters: [1, 2, 3] },
  },
  {
    id: "ferc-881-aar",
    title: "Switch to temperature-adjusted line ratings",
    agency: AGENCY.ferc,
    form: "FERC Order No. 881 compliance (ambient-adjusted ratings)",
    formUrl: C.caiso881.url,
    frequency: "once",
    dueRule: "CAISO participating transmission owners must implement by October 15, 2027, and notify FERC seven days before.",
    citations: [C.order881, C.caiso881],
    schedule: { kind: "dates", dates: [{ due: "2027-10-15", label: "Order No. 881 deadline" }] },
  },

  /* ---- EIA: utilities ---- */
  {
    id: "eia-861",
    title: "Annual electric power industry report",
    agency: AGENCY.eia,
    form: "Form EIA-861",
    formUrl: URL.eiaSurvey861,
    frequency: "annual",
    dueRule: "Must reach EIA by April 30 for the prior calendar year.",
    citations: [C.eia861],
    notes: "Filed once per operating company (not per asset) by utilities, transmission owners and operators, and other industry entities.",
    schedule: { kind: "annual", month: 4, day: 30 },
  },

  /* ---- CPUC: lines and substations ---- */
  {
    id: "go95-rule18",
    title: "Fix line safety problems on time and keep records",
    agency: AGENCY.cpuc,
    form: "GO 95 Rule 18 auditable maintenance program",
    formUrl: C.go95.url,
    frequency: "event",
    dueRule:
      "Level 1: fix immediately. Level 2: within 6 months for fire risks in Tier 3 of the High Fire-Threat District, 12 months in Tier 2 or for worker safety, 36 months otherwise. Level 3: within 60 months. Tell another company about a safety hazard on its equipment within 10 business days.",
    citations: [C.go95],
    notes: "Keep records of each correction (work, date, who did it) for at least 10 years.",
    schedule: { kind: "none" },
  },
  {
    id: "go165-transmission",
    title: "Transmission line inspection procedures and records",
    agency: AGENCY.cpuc,
    form: "GO 165 section IV",
    formUrl: C.go165.url,
    frequency: "event",
    dueRule: "Keep and follow written inspection and maintenance procedures for transmission lines, and keep records CPUC staff can inspect.",
    citations: [C.go165],
    schedule: { kind: "none" },
  },
  {
    id: "go174-annual",
    title: "Annual substation inspection filing",
    agency: AGENCY.cpuc,
    form: "GO 174 Inspection Program Summary and inspection report",
    formUrl: C.go174.url,
    frequency: "annual",
    dueRule: "By July 1 each year: the inspection program summary and a report of completed and past-due inspections for the prior year.",
    citations: [C.go174],
    notes:
      "Applies to CPUC-regulated utilities. Substations under CAISO operational control or FERC reliability standards, and customer substations, are exempt. Keep inspection records at least five years.",
    schedule: { kind: "annual", month: 7, day: 1 },
  },
  {
    id: "oeis-wmp",
    title: "Wildfire mitigation plan",
    agency: AGENCY.oeis,
    form: "Base Wildfire Mitigation Plan",
    formUrl: URL.wmp,
    frequency: "once",
    dueRule:
      "Investor-owned utilities file a new base plan in 2027 covering 2028 onward; Energy Safety will set the exact date (expected in the second quarter). Independent transmission owners file in 2028.",
    citations: [C.wmpIou],
    notes: "Energy Safety is not accepting 2027 plan updates.",
    schedule: { kind: "none" },
  },
];

/* ---- WSAB: publicly owned utilities and cooperatives (Southern California entries of Table 1) ---- */

export interface PouWmp {
  key: string;
  name: string;
  dates: string[];
}

export const POU_WMP: PouWmp[] = [
  { key: "ladwp", name: "Los Angeles Department of Water and Power", dates: ["2026-10-02", "2028-10-06"] },
  { key: "anaheim", name: "Anaheim Public Utilities", dates: ["2027-10-01", "2029-10-05"] },
  { key: "anza", name: "Anza Electric Cooperative", dates: ["2027-10-01", "2029-10-05"] },
  { key: "azusa", name: "Azusa Light and Water", dates: ["2027-10-01"] },
  { key: "banning", name: "City of Banning Electric Utility", dates: ["2027-10-01", "2029-10-05"] },
  { key: "burbank", name: "Burbank Water and Power", dates: ["2027-10-01", "2029-10-05"] },
  { key: "cerritos", name: "Cerritos Electric Utility", dates: ["2029-10-05"] },
  { key: "colton", name: "Colton Electric Utility", dates: ["2027-10-01", "2029-10-05"] },
  { key: "corona", name: "City of Corona", dates: ["2027-10-01"] },
  { key: "glendale", name: "Glendale Water and Power", dates: ["2027-10-01", "2029-10-05"] },
  { key: "iid", name: "Imperial Irrigation District", dates: ["2027-10-01"] },
  { key: "industry", name: "Industry Public Utilities", dates: ["2029-10-05"] },
  { key: "moreno", name: "Moreno Valley Utility", dates: ["2028-10-06"] },
  { key: "needles", name: "City of Needles", dates: ["2027-10-01"] },
  { key: "pasadena", name: "Pasadena Water and Power", dates: ["2027-10-01", "2029-10-05"] },
  { key: "rancho", name: "Rancho Cucamonga Municipal Utility", dates: ["2027-10-01"] },
  { key: "riverside", name: "Riverside Public Utilities Department", dates: ["2027-10-01", "2029-10-05"] },
  { key: "vernon", name: "Vernon Public Utility", dates: ["2029-10-05"] },
  { key: "victorville", name: "Victorville Municipal Utility", dates: ["2027-10-01"] },
];

function fmtLong(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1];
  return `${month} ${d}, ${y}`;
}

for (const p of POU_WMP) {
  LIST.push({
    id: `wsab-wmp-${p.key}`,
    title: "Wildfire mitigation plan",
    agency: AGENCY.wsab,
    form: "Wildfire mitigation plan (Public Utilities Code 8387)",
    formUrl: URL.wsab,
    frequency: "once",
    dueRule: `On the Wildfire Safety Advisory Board's schedule for ${p.name}: final plan due ${p.dates.map(fmtLong).join(", then ")}.`,
    citations: [C.wmpPou],
    notes: "Publicly owned utilities and cooperatives submit at least once every four years; those with overhead lines in the High Fire-Threat District every two years.",
    schedule: { kind: "dates", dates: p.dates.map((d) => ({ due: d, label: `${d.slice(0, 4)} plan` })) },
  });
}

export const RULES: Record<string, RuleDef> = Object.fromEntries(LIST.map((r) => [r.id, r]));
