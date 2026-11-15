/*
 * Verified legal material for the compliance report (checked Nov 14, 2026).
 * Every entry was read on the official page (or an official copy) linked in `url`.
 * Research notes with every URL: scratchpad v5/legal-notes.md.
 *
 * applies_to:
 *   "iou"    = investor-owned utilities the CPUC regulates (SCE, SDG&E, PG&E, Bear Valley).
 *   "all"    = every utility that owns the line, including city-owned ones.
 *   "public" = only city-owned / public utilities (claims against a public agency).
 */

export type AppliesTo = "iou" | "all" | "public";

export interface LegalRule {
  citation: string;
  title: string;
  /** One plain sentence a 12-year-old can follow. */
  plain: string;
  url: string;
  applies_to: AppliesTo;
}

/** Current GO 95 (December 2024 edition), linked from https://www.cpuc.ca.gov/Home/Proceedings-and-Rulemaking/CPUC-general-orders */
export const GO95_URL = "https://docs.cpuc.ca.gov/PublishedDocs/Published/G000/M550/K438/550438485.pdf";

export const LAWS = {
  go95_31_1: {
    citation: "CPUC General Order 95, Rule 31.1",
    title: "Design, construction and maintenance",
    plain: "Power lines must be built and kept in good shape so they give safe, proper and adequate service.",
    url: GO95_URL,
    applies_to: "all",
  },
  go95_31_2: {
    citation: "CPUC General Order 95, Rule 31.2",
    title: "Inspection of lines",
    plain: "Lines must be inspected often and carefully to make sure they are in good condition.",
    url: GO95_URL,
    applies_to: "all",
  },
  go95_35: {
    citation: "CPUC General Order 95, Rule 35 and Table 1 (Cases 13 and 14)",
    title: "Vegetation management",
    plain:
      "Trees must be kept a minimum distance from power wires (for common neighborhood lines of 750 volts to 22.5 kV, at least 18 inches; in high fire-threat areas, at least 48 inches for lines up to 72 kV), and dead or rotten trees that could fall into a line should be removed.",
    url: GO95_URL,
    applies_to: "all",
  },
  go95_37: {
    citation: "CPUC General Order 95, Rule 37 and Table 1",
    title: "Minimum clearances of wires",
    plain: "Wires must stay at least a set height above roads, sidewalks, ground and buildings (the heights are in Table 1).",
    url: GO95_URL,
    applies_to: "all",
  },
  go95_44_3: {
    citation: "CPUC General Order 95, Rule 44.3",
    title: "Replacement",
    plain: "Poles and other parts that get weak (for example from rot or damage) must be replaced or reinforced before they lose too much strength.",
    url: GO95_URL,
    applies_to: "all",
  },
  go128_34_3: {
    citation: "CPUC General Order 128, Rule 34.3",
    title: "Above-ground equipment for underground lines (pad-mounted boxes)",
    plain: "Equipment boxes on the ground must be fixed in place, strong, and locked or otherwise secured so people cannot get in.",
    url: "https://ia.cpuc.ca.gov/gos/go128/go_128_rule_34_3.html",
    applies_to: "iou",
  },
  go165: {
    citation: "CPUC General Order 165, Table 1",
    title: "Inspection cycles for distribution equipment",
    plain:
      "Overhead wires and transformers must be patrolled at least every year in cities (every 2 years in rural areas, but every year in Tier 2 and Tier 3 of the state's High Fire-Threat District) and inspected in detail at least every 5 years.",
    url: "https://docs.cpuc.ca.gov/PublishedDocs/Published/G000/M209/K552/209552704.pdf",
    applies_to: "iou",
  },
  go166_8: {
    citation: "CPUC General Order 166, Standard 8",
    title: "Major outage and restoration estimate communication",
    plain: "During big outages the utility must tell customers what is happening and when power should come back.",
    url: "https://ia.cpuc.ca.gov/gos/go166/GO166_startup_page.html",
    applies_to: "iou",
  },
  prc_4293: {
    citation: "California Public Resources Code section 4293",
    title: "Clearance around power lines in wildland areas",
    plain:
      "On mountain, forest, brush or grass land, plants must be kept at least 4 feet from lines of 2.4 to 72 kV (6 feet for 72 to 110 kV, 10 feet above 110 kV), and dead, rotten or leaning hazard trees must be cut back or removed.",
    url: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PRC&sectionNum=4293",
    applies_to: "all",
  },
  prc_4292: {
    citation: "California Public Resources Code section 4292",
    title: "Firebreak around poles in wildland areas",
    plain:
      "On mountain, forest, brush or grass land, poles that hold equipment such as a transformer, switch or fuse need a cleared firebreak at least 10 feet around them.",
    url: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PRC&sectionNum=4292",
    applies_to: "all",
  },
  puc_451: {
    citation: "California Public Utilities Code section 451",
    title: "Adequate and safe service",
    plain: "Every public utility must give adequate, efficient and reasonable service that keeps customers and the public safe.",
    url: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PUC&sectionNum=451",
    applies_to: "iou",
  },
  psps_esrb8: {
    citation: "CPUC Resolution ESRB-8 (July 12, 2018)",
    title: "Power shutoff notice and reporting",
    plain: "Utilities must warn customers before they turn off power for wildfire safety and send the CPUC a report after each shutoff.",
    url: "https://www.cpuc.ca.gov/consumer-support/psps/evolution-of-psps-guidelines",
    applies_to: "iou",
  },
  psps_d1905042: {
    citation: "CPUC Decision D.19-05-042, Appendix A",
    title: "Power shutoff notification timeline",
    plain:
      "Whenever possible, all affected customers should get notice 24 to 48 hours before a planned shutoff, again 1 to 4 hours before if possible, and before and after power is turned back on.",
    url: "https://docs.cpuc.ca.gov/PublishedDocs/Published/G000/M296/K598/296598822.PDF",
    applies_to: "iou",
  },
  psps_d2106034: {
    citation: "CPUC Decision D.21-06-034 (June 24, 2021)",
    title: "Current power shutoff guidelines",
    plain: "Utilities must improve shutoff notices for all customers, with extra help for people who rely on power for medical needs.",
    url: "https://www.cpuc.ca.gov/consumer-support/psps/evolution-of-psps-guidelines",
    applies_to: "iou",
  },
  sdge_rule2: {
    citation: "SDG&E Electric Rule 2, Description of Service (section B.2)",
    title: "Service voltage range",
    plain:
      "For normal 120-volt home service, SDG&E keeps voltage between 114 and 120 volts, except for weather, short flickers, outages, or causes it cannot control.",
    url: "https://www.sdge.com/sites/default/files/elec_elec-rules_erule2.pdf",
    applies_to: "iou",
  },
  sce_rule2: {
    citation: "SCE Electric Rule 2, Description of Service",
    title: "Service voltage range",
    plain: "SCE's tariff sets the voltage range it must keep at your meter.",
    url: "https://www.sce.com/regulatory/regulatory-information/tariff-books",
    applies_to: "iou",
  },
  pge_rule2: {
    citation: "PG&E Electric Rule 2, Description of Service",
    title: "Service voltage range",
    plain: "PG&E's tariff sets the voltage range it must keep at your meter.",
    url: "https://www.pge.com/tariffs/assets/pdf/tariffbook/ELEC_RULES_2.pdf",
    applies_to: "iou",
  },
  gov_911_2: {
    citation: "California Government Code section 911.2",
    title: "Deadline to file a claim with a public agency",
    plain:
      "A claim against a city-owned utility for injury or damaged belongings must be filed within 6 months; most other claims within 1 year.",
    url: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=GOV&sectionNum=911.2",
    applies_to: "public",
  },
  pou_jurisdiction: {
    citation: "CPUC Decision D.10-02-034 (rehearing of D.09-08-029)",
    title: "State safety rules also cover city-owned lines",
    plain:
      "The CPUC can make and enforce safety rules for power lines owned by city utilities, even though it does not handle their customer complaints.",
    url: "https://docs.cpuc.ca.gov/PUBLISHED/FINAL_DECISION/114225-01.htm",
    applies_to: "public",
  },
} as const satisfies Record<string, LegalRule>;

export type LawId = keyof typeof LAWS;

/* ------------------------------------------------------------- complaint routes */

export const CPUC = {
  /** Informal complaint about an investor-owned utility (Consumer Affairs Branch). */
  complaintUrl: "https://cims.cpuc.ca.gov/complaints/Home/FileComplaint",
  complaintInfoUrl: "https://www.cpuc.ca.gov/consumer-support/file-a-complaint/utility-complaint",
  cabPhone: { display: "1-800-649-7570", tel: "+18006497570", hours: "Monday to Friday, 8:30 a.m. to 4:30 p.m." },
  cabPhoneUrl:
    "https://www.cpuc.ca.gov/consumer-support/file-a-complaint/utility-complaint/how-the-consumer-affairs-branch-can-help",
  /** Public safety complaint (dangling wire etc.) after the emergency is handled. */
  safetyComplaintUrl: "https://ia.cpuc.ca.gov/safetyevents/",
  safetyInfoUrl: "https://www.cpuc.ca.gov/consumer-support/file-a-complaint/public-safety-complaint",
  /** Utilities are expected to respond to CAB within 20 business days (CAB 2025 year in review). */
  responseDays: 20,
  responseUrl:
    "https://www.cpuc.ca.gov/-/media/cpuc-website/divisions/news-and-outreach/reports/cab/quarterly-reports/cab-year-in-review-report-2025_final.pdf",
  /** Formal complaints: Rules of Practice and Procedure, Article 4 (Rule 4.2(c) refers un-tried cases back to CAB). */
  formalUrl:
    "https://www.cpuc.ca.gov/-/media/cpuc-website/consumer-support/documents/formal-complaint-directions-and-sample-form-06122026.pdf",
  rulesUrl: "https://www.cpuc.ca.gov/proceedings-and-rulemaking/rules-of-practice-and-procedure",
  /** "CAB does not handle municipal utility complaints"; municipal customers: "refer to your bill". */
  municipalUrl:
    "https://www.cpuc.ca.gov/consumer-support/file-a-complaint/utility-complaint/contacting-your-utility-provider/helpful-resources-for-subjects-not-regulated-by-the-california-public-utilities-commission",
} as const;

/* ------------------------------------------------------------- utilities */

/** iou = investor-owned (CPUC); public = run by a city or public district; coop = member-owned cooperative. */
export type UtilityKind = "iou" | "public" | "coop";

export interface Phone { display: string; tel: string; note?: string }

export interface UtilityInfo {
  key: string;
  name: string;
  short: string;
  kind: UtilityKind;
  /** Verified emergency / outage line. Absent when not verified: the bill has it. */
  emergency?: Phone;
  emergencyUrl?: string;
  /** Where a customer reports a non-emergency problem or opens a ticket (only when verified). */
  reportUrl?: string;
  /** Claims for damages. */
  claimsUrl?: string;
  /** Verified claim decision target, in plain words. */
  claimsTiming?: string;
  /** Plain words about who oversees a public utility. */
  oversight?: string;
  /** Public customer-service email, only when published by the utility, its city or the state. */
  email?: string;
  /** Where the email was published (checked Nov 15, 2026). */
  emailSource?: string;
}

const CITY_OVERSIGHT = "It is run by its city, so the city council (or the utility's board) oversees it, not the CPUC.";

export const UTILITIES = {
  sce: {
    key: "sce",
    name: "Southern California Edison (SCE)",
    short: "SCE",
    kind: "iou",
    emergency: { display: "1-800-611-1911", tel: "+18006111911" },
    emergencyUrl: "https://www.sce.com/outages-safety/report-outage-safety-issue",
    reportUrl: "https://www.sce.com/outages-safety/report-outage-safety-issue",
    claimsUrl: "https://www.sce.com/customer-service-center/help-center/request-support/claims",
    claimsTiming: "SCE says it aims to decide most claims within 30 days.",
  },
  sdge: {
    key: "sdge",
    name: "San Diego Gas & Electric (SDG&E)",
    short: "SDG&E",
    kind: "iou",
    emergency: { display: "1-800-411-7343", tel: "+18004117343" },
    emergencyUrl: "https://www.sdge.com/safety/power-outage-safety",
    reportUrl: "https://www.sdge.com/safety/power-outage-safety",
    claimsUrl: "https://www.sdge.com/residential/customer-service/assistance-help/claims",
    claimsTiming: "SDG&E says a claims representative contacts you in 3 to 5 business days and it aims to decide in 30 to 45 days.",
  },
  pge: {
    key: "pge",
    name: "Pacific Gas and Electric (PG&E)",
    short: "PG&E",
    kind: "iou",
    emergency: { display: "1-800-743-5000", tel: "+18007435000" },
    emergencyUrl: "https://www.pge.com/en/outages-and-safety/outage-preparedness-and-support.html",
    reportUrl: "https://www.pge.com/en/contact-us/report-an-issue/report-electric-issue.html",
    claimsUrl: "https://www.pge.com/en/account/customer-service/claims.html",
    claimsTiming: "PG&E says it aims to decide claims within 30 days.",
  },
  bves: {
    key: "bves",
    name: "Bear Valley Electric Service",
    short: "Bear Valley Electric",
    kind: "iou",
    reportUrl: "https://www.bvesinc.com/",
  },
  ladwp: {
    key: "ladwp",
    name: "Los Angeles Department of Water and Power (LADWP)",
    short: "LADWP",
    kind: "public",
    emergency: { display: "1-800-342-5397 (1-800-DIAL-DWP)", tel: "+18003425397" },
    emergencyUrl: "https://www.ladwp.com/residential-services/electric-safety",
    reportUrl: "https://www.ladwp.com/account/report-problem",
    claimsUrl: "https://www.ladwp.com/account/report-problem/claims",
    claimsTiming: "LADWP says it aims to decide claims in 30 to 45 days.",
    oversight: CITY_OVERSIGHT,
  },
  anaheim: {
    key: "anaheim",
    name: "Anaheim Public Utilities",
    short: "Anaheim Public Utilities",
    kind: "public",
    emergency: { display: "714-765-3300", tel: "+17147653300", note: "24 hours" },
    emergencyUrl: "https://www.anaheim.net/4754/Power-Outage-Safety",
    reportUrl: "https://www.anaheim.net/3146/Outage-Center",
    email: "CustomerService@anaheim.net",
    emailSource: "California Department of Community Services and Development, CAPP utility customer service contact list",
    oversight: CITY_OVERSIGHT,
  },
  burbank: {
    key: "burbank",
    name: "Burbank Water and Power",
    short: "Burbank Water and Power",
    kind: "public",
    emergency: { display: "(818) 238-3778", tel: "+18182383778", note: "after hours, weekends and holidays; (818) 238-3700 during business hours" },
    emergencyUrl: "https://www.burbankwaterandpower.com/about-us/contact-us",
    reportUrl: "https://www.burbankwaterandpower.com/about-us/contact-us",
    email: "bwpcustomerservice@burbankca.gov",
    emailSource: "https://www.burbankwaterandpower.com/about-us/contact-us",
    oversight: CITY_OVERSIGHT,
  },
  glendale: {
    key: "glendale",
    name: "Glendale Water and Power",
    short: "Glendale Water and Power",
    kind: "public",
    emergency: { display: "(818) 548-2011", tel: "+18185482011", note: "24 hours" },
    emergencyUrl:
      "https://www.glendaleca.gov/government/departments/glendale-water-and-power/safety-security/power-outages/power-outage-frequently-asked-questions",
    reportUrl:
      "https://www.glendaleca.gov/government/departments/glendale-water-and-power/safety-security/power-outages/power-outage-frequently-asked-questions",
    email: "GWPCustomerService@GlendaleCA.gov",
    emailSource: "https://www.glendaleca.gov/government/departments/glendale-water-and-power",
    oversight: CITY_OVERSIGHT,
  },
  riverside: {
    key: "riverside",
    name: "Riverside Public Utilities",
    short: "Riverside Public Utilities",
    kind: "public",
    emergency: { display: "(951) 782-0330", tel: "+19517820330", note: "24 hours" },
    emergencyUrl: "https://riversideca.gov/utilities/outage-types",
    reportUrl: "https://riversideca.gov/utilities/outage-types",
    oversight: CITY_OVERSIGHT,
  },
  pasadena: {
    key: "pasadena",
    name: "Pasadena Water and Power",
    short: "Pasadena Water and Power",
    kind: "public",
    emergency: { display: "(626) 744-4673", tel: "+16267444673", note: "power emergencies" },
    emergencyUrl: "https://pwp.cityofpasadena.net/contactus/",
    reportUrl: "https://pwp.cityofpasadena.net/contactus/",
    email: "WPD_Answerline@cityofpasadena.net",
    emailSource: "https://pwp.cityofpasadena.net/contactus/",
    oversight: CITY_OVERSIGHT,
  },
  azusa: { key: "azusa", name: "Azusa Light & Power", short: "Azusa Light & Power", kind: "public", oversight: CITY_OVERSIGHT },
  colton: { key: "colton", name: "Colton Electric Utility", short: "Colton Electric", kind: "public", oversight: CITY_OVERSIGHT },
  vernon: { key: "vernon", name: "Vernon Public Utilities", short: "Vernon Public Utilities", kind: "public", reportUrl: "https://www.cityofvernonca.gov/", oversight: CITY_OVERSIGHT },
  iid: {
    key: "iid",
    name: "Imperial Irrigation District (IID)",
    short: "IID",
    kind: "public",
    oversight: "It is a public district run by an elected board, not the CPUC.",
  },
  anza: {
    key: "anza",
    name: "Anza Electric Cooperative",
    short: "Anza Electric",
    kind: "coop",
    oversight: "It is a member-owned cooperative run by a board of directors.",
  },
} as const satisfies Record<string, UtilityInfo>;

export type UtilityKey = keyof typeof UTILITIES;

/** Fallback when the operator text does not name a utility we know. */
export const LOCAL_UTILITY: UtilityInfo = {
  key: "local",
  name: "your local electric utility",
  short: "your utility",
  kind: "public",
  reportUrl: CPUC.municipalUrl,
};

const MATCHERS: [UtilityKey, RegExp][] = [
  ["sce", /southern california edison|so\.?\s?cal(ifornia)?\s+edison|\bSCE\b/i],
  ["sdge", /san\s+d(ie|ei)go\s+gas|\bSDG\s?&?\s?E\b/i],
  ["pge", /pacific\s+gas\s+(and|&)\s+electric|\bPG\s?&\s?E\b/i],
  ["bves", /bear\s+valley\s+electric/i],
  ["ladwp", /los\s+angeles\s+department|\bLA\s?DWP\b/i],
  ["anaheim", /anaheim/i],
  ["burbank", /burbank/i],
  ["glendale", /glendale/i],
  ["riverside", /riverside\s+public\s+utilities|city\s+of\s+riverside/i],
  ["pasadena", /pasadena/i],
  ["azusa", /azusa/i],
  ["colton", /colton/i],
  ["vernon", /city\s+of\s+vernon|vernon\s+light/i],
  ["iid", /imperial\s+irrigation/i],
  ["anza", /anza\s+electric/i],
];

export function matchUtility(text: string | null | undefined): UtilityKey | null {
  if (!text) return null;
  for (const [k, re] of MATCHERS) if (re.test(text)) return k;
  return null;
}

/** Sources for the panel "Sources" button. */
export const LEGAL_SOURCE_URLS = {
  go95: GO95_URL,
  cpucComplaint: CPUC.complaintInfoUrl,
  sceSafety: "https://www.sce.com/outages-safety/stay-safe/electrical-safety",
} as const;

/** Official safety guidance used on the emergency screen. */
export const SAFETY = {
  distance: "Stay at least 100 feet away from a downed power line and anything touching it, and keep others away.",
  distanceSource: "Southern California Edison electrical safety guidance",
  distanceUrl: "https://www.sce.com/outages-safety/stay-safe/electrical-safety",
  car: "If a wire is on your car, stay inside, warn others away, and call 911.",
  carSource: "PG&E report an electric issue",
  carUrl: "https://www.pge.com/en/contact-us/report-an-issue/report-electric-issue.html",
  gas: "If you smell gas, leave the area right away. Do not light a flame or flip switches. From a safe place, call 911 and SoCalGas at 1-800-427-2200.",
  gasPhone: { display: "1-800-427-2200", tel: "+18004272200" },
  gasSource: "SoCalGas natural gas leak safety",
  gasUrl: "https://www.socalgas.com/safety/safety-and-prevention/natural-gas-leak",
} as const;
