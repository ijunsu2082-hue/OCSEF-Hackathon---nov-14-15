import { resolve } from "node:path";
import { digest } from "../../lib/evidence/canonical";
import { buildSnapshot } from "../snapshot";
import { atomicJson, locationQuery, request, stateRoot, storeCapture } from "./pipeline";

export const WEATHER_HISTORY_SCHEMA = "mapergy.weather-history/1" as const;
/** Pre-rename id; archives written with it are still read. */
export const LEGACY_WEATHER_HISTORY_SCHEMA = "gridsentinel.weather-history/1" as const;
export const isWeatherHistorySchema = (value: unknown): boolean =>
  value === WEATHER_HISTORY_SCHEMA || value === LEGACY_WEATHER_HISTORY_SCHEMA;

const HOUR = 3600000;
const FIELDS = { temperature_2m: "°C", wind_speed_10m: "m/s", shortwave_radiation: "W/m²" } as const;

export async function backfillWeather(lat: number, lon: number, start: string, end: string) {
  const query = locationQuery(lat, lon, 1);
  const parseDate = (value: string) => {
    const date = new Date(value + "T00:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.valueOf()) ||
        date.toISOString().slice(0, 10) !== value) throw new Error("Expected ISO calendar date");
    return date.valueOf();
  };
  const first = parseDate(start);
  const last = parseDate(end) + 24 * HOUR;
  const hours = (last - first) / HOUR;
  if (hours <= 0 || hours > 366 * 24) throw new Error("Backfill requires an inclusive range of up to 366 days");
  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.search = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), start_date: start, end_date: end,
    timezone: "GMT", models: "era5", wind_speed_unit: "ms", temperature_unit: "celsius",
    hourly: Object.keys(FIELDS).join(","),
  }).toString();
  const { bytes, headers } = await request(url);
  const { cachePath, hash } = await storeCapture(bytes);
  const retrievedAt = new Date().toISOString();
  try {
    const { snapshot, data } = buildSnapshot({
      sourceId: "open-meteo-era5", url: url.href, retrievedAt, bytes, cachePath,
      parser: "json.object", contentType: headers.get("content-type"),
    });
    const source = data as {
      hourly?: Record<string, unknown>;
      hourly_units?: Record<string, string>;
      latitude?: number;
      longitude?: number;
    };
    if (!Number.isFinite(source.latitude) || !Number.isFinite(source.longitude)) throw new Error("Missing weather grid cell");
    const time = source.hourly?.time;
    if (!Array.isArray(time) || time.length !== hours) throw new Error("Incomplete hourly weather time axis");
    const columns = Object.entries(FIELDS).map(([field, unit]) => {
      const values = source.hourly?.[field];
      if (source.hourly_units?.[field] !== unit || !Array.isArray(values) || values.length !== hours) {
        throw new Error(`Invalid hourly weather column ${field}`);
      }
      return [field, values] as const;
    });
    const rows = time.map((timestamp, index) => {
      if (timestamp !== new Date(first + index * HOUR).toISOString().slice(0, 16)) {
        throw new Error("Unexpected hourly weather interval");
      }
      return {
        timestamp: timestamp + ":00Z",
        metrics: columns.map(([field, values]) => {
          const value = values[index];
          if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
            throw new Error(`Invalid weather value ${field} at row ${index}`);
          }
          return { field, value, locator: `/hourly/${field}/${index}` };
        }),
      };
    });
    const archive = {
      schema: WEATHER_HISTORY_SCHEMA, center: query.center, start, end, model: "era5",
      basis: "modeled_reanalysis", gridCell: [source.latitude, source.longitude], units: FIELDS, snapshot, rows,
    };
    const path = resolve(stateRoot(), "weather", `${snapshot.id}.json`);
    await atomicJson(path, archive);
    return { path, snapshot: snapshot.id, rows: rows.length };
  } catch (error) {
    await atomicJson(resolve(stateRoot(), "quarantine", `${digest([url.href, hash])}.json`), {
      url: url.href, cachePath, sha256: hash, retrievedAt,
      issue: error instanceof Error ? error.message : "Weather archive rejected",
    });
    throw error;
  }
}
