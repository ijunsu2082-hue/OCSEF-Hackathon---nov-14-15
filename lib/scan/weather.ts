import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface WeatherSample {
  time: string;
  temp_c: number;
  wind_mps: number;
  wind_direction_deg: number;
  shortwave_wm2: number;
  provider: "open-meteo";
}

const CELL_DIGITS = 3;
const roundCell = (value: number) => Number(value.toFixed(CELL_DIGITS));
/** Default Mapergy coverage center: Westminster, CA. */
export const WEATHER_BASELINE = { lat: 33.7538, lon: -118.0111 };

function databasePath(): string {
  return resolve(process.env.WEATHER_DB_PATH || ".data/weather.sqlite");
}

function openDatabase(): DatabaseSync {
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS weather_locations (
      location_key TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS weather_samples (
      location_key TEXT NOT NULL,
      time TEXT NOT NULL,
      temp_c REAL NOT NULL,
      wind_mps REAL NOT NULL,
      wind_direction_deg REAL NOT NULL,
      shortwave_wm2 REAL NOT NULL,
      provider TEXT NOT NULL DEFAULT 'open-meteo',
      PRIMARY KEY (location_key, time)
    );
    CREATE INDEX IF NOT EXISTS weather_samples_recent
      ON weather_samples(location_key, time DESC);
  `);
  return db;
}

export interface WeatherLocation {
  key: string;
  lat: number;
  lon: number;
}

export function weatherLocation(lat: number, lon: number): WeatherLocation {
  const cellLat = roundCell(lat);
  const cellLon = roundCell(lon);
  return { key: `${cellLat},${cellLon}`, lat: cellLat, lon: cellLon };
}

export function rememberWeatherLocation(lat: number, lon: number, now = new Date()): WeatherLocation {
  const location = weatherLocation(lat, lon);
  const db = openDatabase();
  try {
    db.prepare(`INSERT INTO weather_locations(location_key,lat,lon,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?) ON CONFLICT(location_key) DO UPDATE SET last_seen_at=excluded.last_seen_at`)
      .run(location.key, location.lat, location.lon, now.toISOString(), now.toISOString());
  } finally { db.close(); }
  return location;
}

export function recentWeatherLocations(since = new Date(Date.now() - 24 * 60 * 60 * 1000)): WeatherLocation[] {
  const db = openDatabase();
  try {
    return db.prepare(`SELECT location_key AS key, lat, lon FROM weather_locations
      WHERE last_seen_at >= ? ORDER BY last_seen_at DESC`).all(since.toISOString()) as unknown as WeatherLocation[];
  } finally { db.close(); }
}

export function latestPersistedWeather(location: WeatherLocation, now = new Date()): WeatherSample | null {
  const db = openDatabase();
  try {
    const row = db.prepare(`SELECT time, temp_c, wind_mps, wind_direction_deg,
      shortwave_wm2, provider FROM weather_samples WHERE location_key=? AND time<=? ORDER BY time DESC LIMIT 1`)
      .get(location.key, now.toISOString().slice(0, 16)) as unknown as WeatherSample | undefined;
    return row ?? null;
  } finally { db.close(); }
}

export function persistWeather(location: WeatherLocation, samples: WeatherSample[], refreshEqualTimestamp = false, now = new Date()): void {
  const nowUtc = now.toISOString().slice(0, 16);
  const accepted = samples.filter((sample) => validUtcTime(sample.time) && sample.time <= nowUtc);
  if (!accepted.length) return;
  const db = openDatabase();
  try {
    const insert = db.prepare(refreshEqualTimestamp
      ? `INSERT INTO weather_samples(location_key,time,temp_c,wind_mps,wind_direction_deg,shortwave_wm2,provider)
         VALUES(?,?,?,?,?,?,?) ON CONFLICT(location_key,time) DO UPDATE SET
         temp_c=excluded.temp_c, wind_mps=excluded.wind_mps,
         wind_direction_deg=excluded.wind_direction_deg, shortwave_wm2=excluded.shortwave_wm2`
      : `INSERT INTO weather_samples(location_key,time,temp_c,wind_mps,wind_direction_deg,shortwave_wm2,provider)
         VALUES(?,?,?,?,?,?,?) ON CONFLICT(location_key,time) DO NOTHING`);
    for (const sample of accepted) insert.run(location.key, sample.time, sample.temp_c,
      sample.wind_mps, sample.wind_direction_deg, sample.shortwave_wm2, sample.provider);
  } finally { db.close(); }
}

const CURRENT_FIELDS = "temperature_2m,wind_speed_10m,wind_direction_10m,shortwave_radiation";
const HOURLY_FIELDS = "temperature_2m,wind_speed_10m,wind_direction_10m,shortwave_radiation";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validUtcTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 16) === value;
}

function utcMinute(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16) : null;
  }
  if (typeof value !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return validUtcTime(value) ? value : null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 16) : null;
}

function windMetersPerSecond(value: number, unit: unknown): number {
  if (typeof unit !== "string" || unit === "m/s" || unit === "ms⁻¹") return value;
  if (unit === "km/h") return value / 3.6;
  if (unit === "mph") return value * 0.44704;
  throw new Error(`Unsupported Open-Meteo wind speed unit: ${unit}`);
}

function sampleFrom(values: Record<string, unknown>, time: unknown, windUnit: unknown): WeatherSample | null {
  const temp = values.temperature_2m;
  const wind = values.wind_speed_10m;
  const direction = values.wind_direction_10m;
  const solar = values.shortwave_radiation;
  const normalizedTime = utcMinute(time);
  if (!normalizedTime || !finite(temp) || !finite(wind) || !finite(direction) || !finite(solar)) return null;
  let windMps: number;
  try { windMps = windMetersPerSecond(wind, windUnit); }
  catch { return null; }
  return { time: normalizedTime, temp_c: temp, wind_mps: windMps, wind_direction_deg: direction,
    shortwave_wm2: solar, provider: "open-meteo" };
}

async function fetchJson(url: URL, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (!data || typeof data !== "object") throw new Error("Open-Meteo response was not an object");
  return data as Record<string, unknown>;
}

function apiUrl(endpoint: string, location: WeatherLocation): URL {
  const url = new URL(endpoint);
  url.searchParams.set("latitude", String(location.lat));
  url.searchParams.set("longitude", String(location.lon));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("timeformat", "unixtime");
  return url;
}

export async function fetchCurrentWeather(location: WeatherLocation): Promise<WeatherSample> {
  const url = apiUrl("https://api.open-meteo.com/v1/forecast", location);
  url.searchParams.set("current", CURRENT_FIELDS);
  url.searchParams.set("wind_speed_unit", "ms");
  const data = await fetchJson(url);
  const current = data.current;
  if (!current || typeof current !== "object") throw new Error("Open-Meteo response omitted current weather");
  const units = data.current_units;
  const windUnit = units && typeof units === "object" ? (units as Record<string, unknown>).wind_speed_10m : "m/s";
  const sample = sampleFrom(current as Record<string, unknown>, (current as Record<string, unknown>).time, windUnit);
  if (!sample) throw new Error("Open-Meteo current weather fields were invalid");
  if (sample.time > new Date().toISOString().slice(0, 16)) throw new Error("Open-Meteo current weather timestamp is in the future");
  return sample;
}

export async function fetchHistoricalWeather(location: WeatherLocation, now = new Date()): Promise<WeatherSample | null> {
  const end = new Date(now.getTime() - 60 * 60 * 1000);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const date = (value: Date) => value.toISOString().slice(0, 10);
  const url = apiUrl("https://archive-api.open-meteo.com/v1/archive", location);
  url.searchParams.set("start_date", date(start));
  url.searchParams.set("end_date", date(end));
  url.searchParams.set("hourly", HOURLY_FIELDS);
  url.searchParams.set("wind_speed_unit", "ms");
  const data = await fetchJson(url, 10000);
  const hourly = data.hourly;
  if (!hourly || typeof hourly !== "object") return null;
  const h = hourly as Record<string, unknown>;
  const units = data.hourly_units;
  const windUnit = units && typeof units === "object" ? (units as Record<string, unknown>).wind_speed_10m : "m/s";
  if (!Array.isArray(h.time)) return null;
  const fields = [h.temperature_2m, h.wind_speed_10m, h.wind_direction_10m, h.shortwave_radiation];
  if (fields.some((values) => !Array.isArray(values))) return null;
  for (let i = h.time.length - 1; i >= 0; i -= 1) {
    const sample = sampleFrom({ temperature_2m: (fields[0] as unknown[])[i], wind_speed_10m: (fields[1] as unknown[])[i],
      wind_direction_10m: (fields[2] as unknown[])[i], shortwave_radiation: (fields[3] as unknown[])[i] }, h.time[i], windUnit);
    if (sample && sample.time <= now.toISOString().slice(0, 16)) return sample;
  }
  return null;
}

export type WeatherSource = "live" | "persisted" | "historical" | "none";
export interface WeatherRefreshResult { sample: WeatherSample | null; source: WeatherSource; }

export async function refreshWeatherLocation(location: WeatherLocation): Promise<WeatherRefreshResult> {
  const before = latestPersistedWeather(location);
  try {
    const sample = await fetchCurrentWeather(location);
    const isCurrentOrNewer = !before || sample.time >= before.time;
    if (isCurrentOrNewer) persistWeather(location, [sample], true);
    const latest = latestPersistedWeather(location) ?? sample;
    return { sample: latest, source: isCurrentOrNewer ? "live" : "persisted" };
  } catch {
    const persisted = latestPersistedWeather(location) ?? before;
    try {
      const historical = await fetchHistoricalWeather(location);
      if (historical) persistWeather(location, [historical]);
      const latest = latestPersistedWeather(location) ?? persisted ?? historical;
      if (historical && (!persisted || historical.time > persisted.time)) {
        return { sample: latest ?? historical, source: "historical" };
      }
      return { sample: latest ?? null, source: latest ? "persisted" : "none" };
    } catch { return { sample: persisted ?? null, source: persisted ? "persisted" : "none" }; }
  }
}

export async function refreshRecentWeather(): Promise<void> {
  rememberWeatherLocation(WEATHER_BASELINE.lat, WEATHER_BASELINE.lon);
  for (const location of recentWeatherLocations()) await refreshWeatherLocation(location);
}
