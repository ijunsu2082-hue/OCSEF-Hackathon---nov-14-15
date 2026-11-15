/*
 * Where each panel number comes from. Shown by the "Sources" button on panel
 * sections. Keep these facts in sync with the data audit; do not add claims
 * that have not been checked.
 */

export interface SourceInfo {
  name: string;
  publisher: string;
  /** Omitted when there is no single page to link (our own index, news). */
  url?: string;
  asOf: string;
  /** One plain sentence: what this source gives us. */
  what: string;
  /** How we computed numbers from it, if we did. */
  method?: string;
  /** Caveats. */
  note?: string;
}

export const SOURCES = {
  eia860: {
    name: "Form EIA-860",
    publisher: "U.S. Energy Information Administration (EIA)",
    url: "https://www.eia.gov/electricity/data/eia860/",
    asOf: "Final 2025 annual data, released Sep 10, 2026",
    what: "Power plants operating at year-end 2025, with MW by fuel, in-service years and planned retirements.",
    note: "Changes during 2026 (e.g. Alamitos 3–5, Huntington Beach 2, Ormond Beach retiring end of 2026) are not reflected until the next release.",
  },
  eia860_events: {
    name: "Form EIA-860, retired and proposed generators",
    publisher: "U.S. Energy Information Administration (EIA)",
    url: "https://www.eia.gov/electricity/data/eia860/",
    asOf: "Final 2025 annual data, released Sep 10, 2026",
    what: "Generators listed on the EIA-860 retired and proposed generator sheets.",
    note: "Changes during 2026 are not reflected until the next release.",
  },
  osm: {
    name: "OpenStreetMap",
    publisher: "OpenStreetMap contributors (ODbL), via the Overpass API",
    url: "https://www.openstreetmap.org/copyright",
    asOf: "Fetched Nov 2026",
    what: "Power lines of 69 kV and up, and substations.",
    method: "Where a line or substation has no voltage tag, we fill it in from connected lines (touching ends) or a substation within about 300 m. Substations and lines without a name are labeled by the nearest power-plant city within 15 mi.",
    note: "22% of lines have no voltage tag before filling (about 12% after) and many substations have no operator.",
  },
  state_substations: {
    name: "California Electrical Substations",
    publisher: "California Energy Commission (CEC), via a public ArcGIS Online copy",
    url: "https://services.arcgis.com/OCBQIMs6mxgHZEQ0/arcgis/rest/services/California_Electrical_Substations/FeatureServer/0",
    asOf: "Fetched Nov 2026",
    what: "Names, owners and voltage class of California substations.",
    method: "An OpenStreetMap substation with no name takes the name of the closest operational CEC substation within 200 m, one CEC substation per map point.",
    note: "The CEC's own copy of this layer now requires sign-in, so we use a public copy. Spellings can differ from OpenStreetMap.",
  },
  openmeteo_live: {
    name: "Open-Meteo forecast API",
    publisher: "Open-Meteo",
    url: "https://open-meteo.com/",
    asOf: "Live",
    what: "Current temperature, wind and sun at the scanned point.",
  },
  era5_2025: {
    name: "Open-Meteo historical archive (ERA5 reanalysis)",
    publisher: "Open-Meteo",
    url: "https://open-meteo.com/en/docs/historical-weather-api",
    asOf: "2025",
    what: "Hourly 2025 weather for 7 sites.",
  },
  ieee738: {
    name: "Line rating model (IEEE Std 738)",
    publisher: "Mapergy, based on IEEE Std 738",
    url: "https://standards.ieee.org/ieee/738/5765/",
    asOf: "Computed at scan time from live and 2025 weather",
    what: "Our port of the IEEE Std 738 heat balance: how much current a bare wire can carry before it heats past 75 °C.",
    method: "Three ratings for the same wire. Fixed rating (static): worst-case 40 °C air, 0.61 m/s wind, full sun, all year; 723 A for an ACSR 795 kcmil \"Drake\" wire. Temperature-adjusted rating (ambient-adjusted rating, AAR, as FERC Order 881 defines it): real air temperature, worst-case 1000 W/m² sun by day and none at night (not measured sun), wind kept at 0.61 m/s at 90°. Wind-based rating (dynamic line rating, DLR): real temperature, sun and wind, with the wind halved for safety. The headline number is AAR divided by static, so it is an upper end: utilities' seasonal ratings already take some of this gain, and equipment or grid stability can set a lower limit. The wind row is DLR divided by static. The wire-type range repeats the math for Linnet (336.4 kcmil), Drake (795 kcmil) and Cardinal (954 kcmil), each divided by its own fixed rating.",
    note: "A screening estimate for typical wires, not a utility rating. Real limits also depend on the exact wire, its worst span, sag clearance and equipment such as breakers.",
  },
  acsr_datasheet: {
    name: "TransPowr ACSR Bare Overhead Conductor (US) data sheet",
    publisher: "Prysmian (General Cable)",
    url: "https://na.prysmian.com/sites/na.prysmian.com/files/media/documents/TransPowr%C2%AE%20ACSR%20Bare%20Overhead%20Conductor%20%28US%29.pdf",
    asOf: "Data sheet, 2020",
    what: "Outside diameter and AC resistance at 25 °C and 75 °C for the Linnet, Drake and Cardinal wires used in the wire-type range.",
    note: "Drake keeps the IEEE Std 738 worked-example values, within about 1.5% of this sheet.",
  },
  risk: {
    name: "Mapergy risk index",
    publisher: "Mapergy",
    asOf: "Computed at scan time",
    what: "Our own composite score, not an official rating.",
    method: "Weighted average of factors scored 0 to 100: age 25%, fossil 20%, turnover 15%, heat stress 15%, hazard history 15%, grid thinness 10%.",
    note: "Built from the inputs listed below.",
  },
  news: {
    name: "Local stories",
    publisher: "News articles and public records",
    asOf: "Links checked Nov 14, 2026",
    what: "Local stories sourced from news articles and public records.",
    note: "Each story links its own sources.",
  },
  ferc881: {
    name: "FERC Order No. 881, Managing Transmission Line Ratings (87 FR 2244)",
    publisher: "Federal Energy Regulatory Commission (FERC), via the Federal Register",
    url: "https://www.federalregister.gov/documents/2022/01/13/2021-27735/managing-transmission-line-ratings",
    asOf: "Final rule published Jan 13, 2022",
    what: "Requires FERC-regulated transmission providers to use ambient-adjusted ratings (ratings that follow air temperature, with day/night sun) and to keep a (password-protected) database of their line ratings and rating methods.",
  },
  caiso881_extension: {
    name: "FERC order granting CAISO an Order 881 extension (ER22-2362)",
    publisher: "Federal Energy Regulatory Commission (FERC), posted by California ISO",
    url: "https://www.caiso.com/documents/apr-30-2025-order-accepting-motion-for-extension-order-no-881-er22-2362.pdf",
    asOf: "Order dated Apr 30, 2025",
    what: "Moves CAISO's Order 881 deadline to Dec 17, 2026 and gives the utilities that own lines in its grid (participating transmission owners, e.g., SCE, SDG&E, PG&E) up to Oct 15, 2027.",
  },
  caiso_curtailment_2025: {
    name: "Production and curtailments data, 2025",
    publisher: "California ISO (CAISO)",
    url: "https://www.caiso.com/documents/production-and-curtailments-data-june-december-2025.xlsx",
    asOf: "Posted Feb 13, 2026; covers Jan 1 to Dec 31, 2025",
    what: "Every 5-minute interval in 2025 when CAISO cut wind or solar output, with the reason: Local (local transmission congestion) or System (too much power grid-wide).",
    method: "We added up the 5-minute MW values (MW ÷ 12 = MWh): 3,765,628 MWh in total, 3,143,397 MWh Local (83.5%), 622,231 MWh System. The same method on CAISO's 2024 file gives 3,423,377 MWh, matching CAISO's own Dec 31, 2024 report exactly.",
    note: "Covers the CAISO grid only, not LADWP or IID. CAISO does not say which line caused each cut.",
  },
  caiso_curtailment_defs: {
    name: "Wind and solar curtailment report, Dec 31, 2024",
    publisher: "California ISO (CAISO)",
    url: "https://www.caiso.com/documents/wind-solar-real-time-dispatch-curtailment-report-dec-31-2024.pdf",
    asOf: "Dec 31, 2024",
    what: "Defines Local curtailment as dispatch \"to mitigate local congestion\" and System as \"to mitigate system-wide oversupply\". Congestion means transmission lines \"do not have sufficient capacity to deliver the energy\".",
  },
  egrid2023_camx: {
    name: "eGRID2023 summary tables (rev 2), CAMX subregion",
    publisher: "U.S. Environmental Protection Agency (EPA)",
    url: "https://www.epa.gov/system/files/documents/2025-06/summary_tables_rev2.pdf",
    asOf: "2023 data, revised Jun 12, 2025",
    what: "California grid CO2 rates: 428.5 lb/MWh for the average mix, 958.3 lb/MWh for non-baseload (plants that ramp up and down, mostly gas).",
    method: "CO2 range = Local curtailment MWh × 428.5 to 958.3 lb/MWh, converted to metric tonnes.",
    note: "A rough estimate; true savings are likely lower, because not all curtailed power could have reached customers or replaced gas.",
  },
  eia_ca_home_use: {
    name: "2024 average monthly bill, residential (Table 5A)",
    publisher: "U.S. Energy Information Administration (EIA)",
    url: "https://www.eia.gov/electricity/sales_revenue_price/pdf/table_5A.pdf",
    asOf: "2024 data, released Oct 7, 2025",
    what: "An average California home uses 503 kWh a month (about 6 MWh a year).",
  },
  doe_dlr_2019: {
    name: "Dynamic Line Rating, Report to Congress",
    publisher: "U.S. Department of Energy (DOE)",
    url: "https://www.energy.gov/sites/prod/files/2019/08/f66/Congressional_DLR_Report_June2019_final_508_0.pdf",
    asOf: "June 2019",
    what: "Calls dynamic line rating \"relatively inexpensive compared to other transmission-capacity expansion\" options and a \"potential low-cost alternative\" to new transmission upgrades.",
  },
  cpuc_go95: {
    name: "CPUC General Order 95 (overhead line rules) and General Order 165 (inspection cycles)",
    publisher: "California Public Utilities Commission (CPUC)",
    url: "https://docs.cpuc.ca.gov/PublishedDocs/Published/G000/M550/K438/550438485.pdf",
    asOf: "GO 95 December 2024 edition; GO 165 December 2017 edition; checked Nov 14, 2026",
    what: "Safety rules the report cites: maintenance (Rule 31.1), inspection (31.2), tree clearance (35, Table 1), wire height (37), pole replacement (44.3), and GO 165 inspection intervals.",
    note: "GO 95 also covers city-owned lines for safety (CPUC D.10-02-034). Each rule in a report links its own official page.",
  },
  cpuc_complaints: {
    name: "CPUC complaint process",
    publisher: "California Public Utilities Commission (CPUC)",
    url: "https://www.cpuc.ca.gov/consumer-support/file-a-complaint/utility-complaint",
    asOf: "Nov 14, 2026",
    what: "Where to file: contact the utility first, then the Consumer Affairs Branch (informal), then a formal complaint. The CPUC does not handle complaints about city-owned utilities.",
    note: "Utilities are expected to respond to a forwarded informal complaint within 20 business days (CAB 2025 year in review).",
  },
  ca_codes_utility: {
    name: "California codes: Public Resources Code 4292 and 4293, Public Utilities Code 451, Government Code 911.2",
    publisher: "California Legislature",
    url: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PRC&sectionNum=4293",
    asOf: "Nov 14, 2026",
    what: "Clearance around lines and poles in wildland areas, the duty to give safe and adequate service, and the claim deadline for public agencies (6 months for damaged belongings).",
  },
  utility_safety_contacts: {
    name: "Utility emergency numbers, safety advice and claims pages",
    publisher: "SCE, SDG&E, PG&E, LADWP, Anaheim, Burbank, Glendale, Riverside and Pasadena utilities; SoCalGas",
    url: "https://www.sce.com/outages-safety/stay-safe/electrical-safety",
    asOf: "Nov 14, 2026",
    what: "Each utility's own emergency number, claims page and claim decision times, and SCE's advice to stay at least 100 feet from a downed line.",
    note: "Numbers for smaller utilities we could not verify are not shown; the report points to the electric bill instead.",
  },
  owner_filing_rules: {
    name: "Owner filing rules (EIA, EPA, CARB, South Coast AQMD, CEC, CPUC, FERC, NERC, Energy Safety)",
    publisher: "Each agency's own forms, instructions and regulations; every rule links its source",
    url: "https://www.eia.gov/survey/",
    asOf: "Checked Nov 14, 2026",
    what: "Which reports a plant, substation or line owner files, when they are due, and the fields we can fill in from EIA-860 and OpenStreetMap.",
    method: "A rule is marked verified only when its size or ownership test is met by our data; anything that depends on emissions, permits, NERC registration, market-based rate authority or utility size is marked check. Dates move off weekends or holidays only where the rule says so (EIA-860, FERC filings, South Coast AQMD).",
    note: "EPA moved the 2025 greenhouse gas report to March 10, 2027 and has proposed ending most reporting. FERC's four-month EQR window starts only with its new filing system. Energy Safety has not yet set the exact 2027 wildfire plan dates for investor-owned utilities.",
  },
} satisfies Record<string, SourceInfo>;

export type SourceId = keyof typeof SOURCES;
