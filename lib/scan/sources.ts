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
    note: "22% of lines have no voltage tag and many substations have no operator.",
  },
  openmeteo_live: {
    name: "Open-Meteo forecast API",
    publisher: "Open-Meteo",
    url: "https://open-meteo.com/",
    asOf: "Live",
    what: "Current temperature, wind and sun at the scanned point.",
  },
  era5_2024: {
    name: "Open-Meteo historical archive (ERA5 reanalysis)",
    publisher: "Open-Meteo",
    url: "https://open-meteo.com/en/docs/historical-weather-api",
    asOf: "2024",
    what: "Hourly 2024 weather for 7 sites.",
  },
  ieee738: {
    name: "Line rating model (IEEE Std 738)",
    publisher: "GridSentinel, based on IEEE Std 738",
    url: "https://standards.ieee.org/ieee/738/5765/",
    asOf: "Computed at scan time from live and 2024 weather",
    what: "Our port of the IEEE Std 738 heat balance for an ACSR 795 kcmil \"Drake\" conductor at 75 °C.",
    method: "Static rating is 723 A (40 °C, 0.61 m/s wind, full sun). The safe rating uses real weather with the wind halved.",
    note: "A screening estimate for one typical wire, not a utility rating.",
  },
  risk: {
    name: "GridSentinel risk index",
    publisher: "GridSentinel",
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
} satisfies Record<string, SourceInfo>;

export type SourceId = keyof typeof SOURCES;
