import { resolvePointer } from "../parsers";
import { getSourceDefinition } from "../registry";
import type { SourceDefinition } from "../../lib/evidence/schema";
import { EIA_FUEL_CODES } from "../../lib/evidence/predicates";
import { caisoFeeds } from "./caiso";

export interface LocationQuery {
  center: [number, number];
  radius_miles: number;
  respondent?: string;
  /** Opt in to system-wide CAISO telemetry. Not every location is in CAISO. */
  caiso?: true;
}

export interface Metric {
  predicate: string;
  locator: string;
  value: string | number;
}

export interface Feed {
  source: SourceDefinition;
  interval: number;
  url: URL;
  extract(data: unknown): Metric[];
  /**
   * `retrievedAt` is the snapshot's capture instant. A feed needs it only when
   * the payload omits its own date, so the derived observation time stays
   * replayable instead of depending on the current clock.
   */
  observationTime?(data: unknown, retrievedAt?: string): { timestamp: string; basis: "utc" | "local-unknown" } | null;
  follow?: (data: unknown) => URL;
  /** Snapshot parser id for these bytes. Defaults to the JSON parser in pipeline.capture. */
  parser?: string;
  /** Accept header. Defaults to application/json. */
  accept?: string;
}

function at(data: unknown, pointer: string): unknown {
  try {
    return resolvePointer(data, pointer);
  } catch {
    return undefined;
  }
}

function metric(data: unknown, locator: string, predicate: string): Metric[] {
  const value = at(data, locator);
  if (typeof value === "string" && value.trim()) return [{ predicate, locator, value }];
  if (typeof value === "number" && Number.isFinite(value)) return [{ predicate, locator, value }];
  return [];
}
function validEiaPeriod(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(value)) return false;
  const hour = Number(value.slice(-2));
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return hour >= 0 && hour <= 23 && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
}
function validNwsTimestamp(value: unknown): value is string {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  const [hour, minute, second] = value.slice(11, 19).split(":").map(Number);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10) &&
    hour <= 23 && minute <= 59 && second <= 59;
}

function nwsLink(data: unknown, pointer: string, path: RegExp): URL {
  const value = at(data, pointer);
  if (typeof value !== "string") throw new Error("NWS location has no station link");
  const url = new URL(value);
  if (url.origin !== "https://api.weather.gov" || !path.test(url.pathname) || url.search || url.hash ||
      url.username || url.password) throw new Error("Unexpected NWS station URL");
  return url;
}

const nws: SourceDefinition = {
  id: "nws-observation",
  title: "Latest NWS station observation",
  publisher: "National Weather Service",
  homepage: "https://www.weather.gov/",
  license: "U.S. government public data",
  authority: "primary",
  access: {
    kind: "rest",
    endpoint: "https://api.weather.gov/stations/{stationId}/observations/latest",
    docs: "https://www.weather.gov/documentation/services-web-api",
    deterministic: false,
    notes: "Station chosen using NWS point and grid station discovery.",
  },
  freshness: { cadence: "10 minutes", max_age_days: 2 / 24 },
  caveats: ["Point-associated station observation. Represents station conditions."],
};

const nwsAlerts: SourceDefinition = {
  id: "nws-active-alerts",
  title: "Active NWS alerts near location",
  publisher: "National Weather Service",
  homepage: "https://www.weather.gov/",
  license: "U.S. government public data",
  authority: "primary",
  access: {
    kind: "rest",
    endpoint: "https://api.weather.gov/alerts/active?point={latitude},{longitude}",
    docs: "https://www.weather.gov/documentation/services-web-api",
    deterministic: false,
    notes: "Active alerts returned for the analysis point.",
  },
  freshness: { cadence: "10 minutes", max_age_days: 2 / 24 },
  caveats: ["Counts active alert features returned for the point; it does not summarize alert impacts."],
};

function eiaFeed(respondent: string, fuel: boolean): Feed {
  const endpoint = `https://api.eia.gov/v2/electricity/rto/${fuel ? "fuel-type-data" : "region-data"}`;
  const url = new URL(`${endpoint}/data/`);
  url.search = new URLSearchParams({
    frequency: "hourly",
    "data[0]": "value",
    "facets[respondent][]": respondent,
    "sort[0][column]": "period",
    "sort[0][direction]": "desc",
    "sort[1][column]": fuel ? "fueltype" : "respondent",
    "sort[1][direction]": "asc",
    length: fuel ? "200" : "24",
    ...(fuel ? {} : { "facets[type][]": "D" }),
  }).toString();
  return {
    url,
    interval: 3600,
    source: {
      id: fuel ? "eia-hourly-fuel" : "eia-hourly-demand",
      title: fuel ? "EIA hourly generation by fuel" : "EIA hourly balancing-authority demand",
      publisher: "U.S. Energy Information Administration",
      homepage: "https://www.eia.gov/opendata/",
      license: "U.S. government public data",
      authority: "primary",
      access: {
        kind: "rest", endpoint,
        docs: "https://www.eia.gov/opendata/documentation.php",
        deterministic: false, notes: "Requires an EIA API key.",
      },
      freshness: { cadence: "hourly", max_age_days: 2 },
      caveats: [`Balancing authority ${respondent}. Values cover the reporting authority, not the analysis radius.`],
    },
    extract(data) {
      const rows = at(data, "/response/data");
      if (!Array.isArray(rows) || !rows.length) return [];
      const period = at(data, "/response/data/0/period");
      if (!validEiaPeriod(period)) return [];
      const results = metric(data, "/response/data/0/period", "telemetry.period");
      const fuels = new Set<string>();
      rows.forEach((_, index) => {
        const path = `/response/data/${index}`;
        if (at(data, `${path}/period`) !== period || at(data, `${path}/respondent`) !== respondent) return;
        if (!["megawatthours", "MWh"].includes(String(at(data, `${path}/value-units`)))) return;
        const amount = at(data, `${path}/value`);
        if (typeof amount !== "number" || !Number.isFinite(amount)) return;
        const code = fuel ? at(data, `${path}/fueltype`) : at(data, `${path}/type`);
        if (typeof code !== "string" ||
            (fuel ? !EIA_FUEL_CODES.some((allowed) => allowed === code) : code !== "D")) return;
        if (fuels.has(code)) throw new Error("Duplicate EIA series in latest period");
        fuels.add(code);
        results.push(...metric(data, `${path}/value`, fuel ? `telemetry.fuel_${code}` : "telemetry.demand"));
      });
      return results.length > 1 ? results : [];
    },
    observationTime(data) {
      const period = at(data, "/response/data/0/period");
      // EIA publishes hour-ending data in balancing-authority local reporting zones.
      // Retain the period string; no defensible UTC age can be calculated here.
      return validEiaPeriod(period) ? { timestamp: period, basis: "local-unknown" } : null;
    },
  };
}

function assetCount(
  query: LocationQuery, id: string, title: string, publisher: string,
  endpoint: string, predicate: string, where = "1=1",
): Feed {
  const [lat, lon] = query.center;
  const url = new URL(`${endpoint}/query`);
  url.search = new URLSearchParams({
    f: "json", where, geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint",
    inSR: "4326", spatialRel: "esriSpatialRelIntersects",
    distance: String(query.radius_miles), units: "esriSRUnit_StatuteMile", returnCountOnly: "true",
  }).toString();
  return {
    url, interval: 86400,
    source: {
      id, title, publisher, homepage: endpoint,
      license: "See published layer metadata", authority: "primary",
      access: {
        kind: "arcgis", endpoint, docs: endpoint, deterministic: false,
        notes: "Server-side distance query against published layer geometry.",
      },
      freshness: { cadence: "daily check", max_age_days: 30 },
      caveats: ["Count of matching records in this layer. Zero matches establishes only that the layer returned no records."],
    },
    extract(data) {
      const count = at(data, "/count");
      return Number.isSafeInteger(count) && Number(count) >= 0 ? metric(data, "/count", predicate) : [];
    },
  };
}

export function feedsFor(query: LocationQuery): Feed[] {
  const [lat, lon] = query.center;
  const census = getSourceDefinition("census-geocoder")!;
  const weather: Feed = {
    source: nws,
    interval: 600,
    url: new URL(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`),
    follow(data) {
      return nwsLink(data, "/properties/observationStations", /^\/gridpoints\/[A-Z]+\/\d+,\d+\/stations$/);
    },
    extract(data) {
      const timestamp = at(data, "/properties/timestamp");
      if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return [];
      const result = metric(data, "/properties/timestamp", "telemetry.period");
      for (const [field, unit, predicate] of [
        ["temperature", "wmoUnit:degC", "weather.temperature_c"],
        ["windSpeed", "wmoUnit:km_h-1", "weather.wind_kmh"],
        ["windGust", "wmoUnit:km_h-1", "weather.gust_kmh"],
      ]) {
        const path = `/properties/${field}`;
        if (at(data, `${path}/unitCode`) !== unit ||
            typeof at(data, `${path}/value`) !== "number") continue;
        result.push(...metric(data, `${path}/value`, predicate));
      }
      return result.length > 1 ? result : [];
    },
    observationTime(data) {
      const timestamp = at(data, "/properties/timestamp");
      if (!validNwsTimestamp(timestamp)) return null;
      return { timestamp: new Date(timestamp).toISOString(), basis: "utc" };
    },
  };
  const alerts: Feed = {
    source: nwsAlerts,
    interval: 600,
    url: new URL(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`),
    extract(data) {
      const features = at(data, "/features");
      if (!Array.isArray(features)) return [];
      return [
        ...metric(data, "/etl/active_alert_count", "weather.active_alert_count"),
        ...features.flatMap((_, index) => metric(
        data, `/features/${index}/properties/event`, "weather.active_alert_event",
        )),
      ];
    },
  };
  return [
    {
      source: census, interval: 86400,
      url: new URL(census.access.endpoint.replace("{x}", String(lon)).replace("{y}", String(lat))),
      extract(data) {
        return [
          ...metric(data, "/result/geographies/States/0/GEOID", "region.state_fips"),
          ...metric(data, "/result/geographies/Counties/0/GEOID", "region.county_fips"),
          ...metric(data, "/result/geographies/Counties/0/NAME", "region.county_name"),
        ];
      },
    },
    weather,
    alerts,
    assetCount(query, "eia-atlas-plants", "EIA Energy Atlas power plants", "U.S. Energy Information Administration",
      "https://services.arcgis.com/fGsbyIOAuxHnF97m/ArcGIS/rest/services/Power_Plants/FeatureServer/0", "region.plant_count"),
    assetCount(query, "hifld-substations", "HIFLD substation inventory", "HIFLD",
      "https://services.arcgis.com/HQ0xoN0EzDPBOEci/ArcGIS/rest/services/Substations/FeatureServer/0",
      "region.substation_feature_count"),
    assetCount(query, "hifld-transmission", "HIFLD transmission inventory (69 kV and above)", "HIFLD",
      "https://services1.arcgis.com/oS5ru2iHb8I5vlTv/ArcGIS/rest/services/Transmission_Lines/FeatureServer/0",
      "region.transmission_feature_count", "VOLTAGE >= 69"),
    ...(query.caiso ? caisoFeeds() : []),
    ...(query.respondent ? [eiaFeed(query.respondent, false), eiaFeed(query.respondent, true)] : []),
  ];
}

export function nwsObservationUrl(data: unknown): URL {
  const url = nwsLink(data, "/features/0/id", /^\/stations\/[A-Z0-9]+$/);
  return new URL(`${url.href}/observations/latest`);
}
