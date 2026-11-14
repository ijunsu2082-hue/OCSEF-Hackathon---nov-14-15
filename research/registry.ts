/**
 * Source registry.
 *
 * Adding a source is a reviewed code change, not a runtime configuration. Each
 * entry states who publishes the data, how it is retrieved, what it may be used
 * to claim, and what it may never be used to claim (`caveats`). The registry is
 * hashed into every bundle (`registry_digest`), so a change here invalidates the
 * bundle on the next verification run.
 *
 * `endpoint` templates:
 *   {center}    "lat,lon"
 *   {radius_m}  radius in metres
 *   {bbox}      "south,west,north,east"
 *   {x},{y}     longitude/latitude
 *   {address}   URL-encoded address
 */

import type { SourceDefinition } from "../lib/evidence/schema";

const GRID_SENTINEL_LICENSE = "Internal artifact — see upstream license and caveats";

export const SOURCE_REGISTRY: SourceDefinition[] = [
  {
    id: "census-geocoder",
    title: "Census Geocoder — coordinates to geography",
    publisher: "United States Census Bureau",
    homepage: "https://geocoding.geo.census.gov/geocoder/",
    license: "Public domain (US Census Bureau)",
    authority: "primary",
    access: {
      kind: "rest",
      endpoint:
        "https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x={x}&y={y}&benchmark=Public_AR_Current&vintage=Current_Current&format=json",
      docs: "https://www.census.gov/programs-surveys/geography/technical-documentation/complete-technical-documentation/census-geocoder.html",
      deterministic: true,
      notes: "Public, no key. Vintage and benchmark are pinned in the endpoint.",
    },
    freshness: { cadence: "annual", max_age_days: 400 },
    caveats: [
      "Returns the Census geography containing a point; it does not confirm that a facility occupies that point.",
      "Boundaries are a legal/statistical product, not a utility service territory.",
    ],
  },
  {
    id: "eia-860",
    title: "Form EIA-860 — Annual Electric Generator Report",
    publisher: "U.S. Energy Information Administration",
    homepage: "https://www.eia.gov/electricity/data/eia860/",
    license: "Public domain (US Government work)",
    authority: "primary",
    access: {
      kind: "bulk",
      endpoint: "https://www.eia.gov/electricity/data/eia860/xls/eia860{year}.zip",
      docs: "https://www.eia.gov/electricity/data/eia860/",
      deterministic: true,
      notes:
        "Annual ZIP. Pin the year in the profile; never cite an unpinned 'latest'. Parsers must report the file and row locator.",
    },
    freshness: { cadence: "annual", max_age_days: 500 },
    caveats: [
      "Generator nameplate is a generating capability, not a load-center demand.",
      "Retirement and planned-capacity fields are as-of the filing date, not real time.",
    ],
  },
  {
    id: "epa-egrid",
    title: "EPA eGRID — Emissions & Generation Resource Integrated Database",
    publisher: "U.S. Environmental Protection Agency",
    homepage: "https://www.epa.gov/egrid",
    license: "Public domain (US Government work)",
    authority: "primary",
    access: {
      kind: "bulk",
      endpoint: "https://www.epa.gov/egrid/download-data",
      docs: "https://www.epa.gov/egrid/technical-guide",
      deterministic: true,
      notes:
        "Annual workbook. Subregion output emission rates are the citation target; plant-level rates are a different predicate.",
    },
    freshness: { cadence: "annual", max_age_days: 600 },
    caveats: [
      "eGRID is an annual inventory, not a live marginal emissions signal.",
      "Subregion averages can differ materially from the balancing authority serving a site at a given hour.",
    ],
  },
  {
    id: "osm-overpass",
    title: "OpenStreetMap via Overpass API",
    publisher: "OpenStreetMap contributors",
    homepage: "https://overpass-api.de/",
    license: "ODbL-1.0",
    authority: "secondary",
    access: {
      kind: "overpass",
      endpoint: "https://overpass-api.de/api/interpreter",
      docs: "https://wiki.openstreetmap.org/wiki/Overpass_API",
      deterministic: false,
      notes:
        "Community-maintained, not a utility record. Public endpoint is rate-limited and returns 502 under load; the pipeline retries with exponential backoff and never treats a failed fetch as zero features.",
    },
    freshness: { cadence: "continuous", max_age_days: 120 },
    caveats: [
      "Completeness varies by region and by mapper.",
      "Voltage, operator and name tags are optional and frequently absent.",
      "A missing feature is not evidence that the asset does not exist.",
    ],
  },
  {
    id: "gs-layer-plants",
    title: "GridSentinel generation layer (in-repo)",
    publisher: "GridSentinel",
    homepage: "https://www.eia.gov/electricity/data/eia860/",
    license: GRID_SENTINEL_LICENSE,
    authority: "derived",
    access: {
      kind: "layer",
      endpoint: "public/layers/plants.geojson",
      docs: "https://www.eia.gov/electricity/data/eia860/",
      deterministic: true,
      notes:
        "A filtered, radius-clipped subset built from EIA-860 2025. The snapshot is the exact in-repo artifact; upstream row locators are not preserved by the subset.",
    },
    freshness: { cadence: "annual", max_age_days: 500 },
    caveats: [
      "Derived artifact: cite the layer for counts inside this radius, not for national EIA totals.",
      "Nameplate MW is generator capability, not facility demand.",
    ],
  },
  {
    id: "gs-layer-transmission",
    title: "GridSentinel transmission layer (in-repo)",
    publisher: "GridSentinel / OpenStreetMap contributors",
    homepage: "https://www.openstreetmap.org/",
    license: "ODbL-1.0 (upstream OpenStreetMap)",
    authority: "derived",
    access: {
      kind: "layer",
      endpoint: "public/layers/transmission.geojson",
      docs: "https://wiki.openstreetmap.org/wiki/Key:power",
      deterministic: true,
      notes:
        "Radius-clipped Overpass snapshot. Voltage is the highest tagged voltage on the way, normalised at extraction time.",
    },
    freshness: { cadence: "continuous", max_age_days: 120 },
    caveats: [
      "Line geometry reflects OSM mapping, not utility GIS.",
      "Underground and low-voltage lines are excluded by the extraction rule.",
    ],
  },
  {
    id: "gs-layer-substations",
    title: "GridSentinel substation layer (in-repo)",
    publisher: "GridSentinel / OpenStreetMap contributors",
    homepage: "https://www.openstreetmap.org/",
    license: "ODbL-1.0 (upstream OpenStreetMap)",
    authority: "derived",
    access: {
      kind: "layer",
      endpoint: "public/layers/substations.geojson",
      docs: "https://wiki.openstreetmap.org/wiki/Tag:power%3Dsubstation",
      deterministic: true,
      notes:
        "Radius-clipped Overpass snapshot; point is the outline centroid for way/relation features.",
    },
    freshness: { cadence: "continuous", max_age_days: 120 },
    caveats: [
      "Presence in OSM is not proof of energisation.",
      "Voltage and operator tags are incomplete.",
    ],
  },
  {
    id: "gs-seed-nodes",
    title: "GridSentinel curated load-center records (in-repo)",
    publisher: "GridSentinel",
    homepage: "https://github.com/",
    license: "Internal curated dataset",
    authority: "modeled",
    access: {
      kind: "seed",
      endpoint: "data/nodes.json",
      docs: "README §4.1",
      deterministic: true,
      notes:
        "Curated from operator and agency records during the build sprint. Identity fields are real; electrical ratings and economics are modelled. Every row is addressable by JSON Pointer.",
    },
    freshness: { cadence: "manual", max_age_days: 3650 },
    caveats: [
      "Nameplate MW is a modelled electrical rating derived from published scale, not an operator-published meter value.",
      "Carbon intensity and source mix are modelled for the serving zone until an eGRID/ISO snapshot is captured.",
      "Upgrade economics are screening estimates, not bids.",
    ],
  },
  {
    id: "operator-records",
    title: "Operator and agency records (manual capture)",
    publisher: "Site operator / permitting agency",
    homepage: "https://example.gov/",
    license: "Publisher terms — quote and link, do not redistribute",
    authority: "primary",
    access: {
      kind: "manual",
      endpoint: "research/captures/{source_id}/{file}",
      docs: "research/README.md#manual-captures",
      deterministic: true,
      notes:
        "For PDFs, permits and board packets with no API. A human captures the file, records the page/quote locator, and the build hashes the exact file.",
    },
    freshness: { cadence: "per publication", max_age_days: 1200 },
    caveats: [
      "A manual capture is only as good as the locator: page number and verbatim quote are mandatory.",
      "Do not claim a number from a secondary summary when the primary filing is available.",
    ],
  },
];

export function getSourceDefinition(id: string): SourceDefinition | null {
  return SOURCE_REGISTRY.find((source) => source.id === id) ?? null;
}
