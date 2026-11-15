import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Weather samples, stored in Supabase (`weather_locations` + `weather_samples`).
 *
 * They used to live in `.data/weather.sqlite`. Samples are operational state,
 * so the tables are service-role only: RLS is on with no public policy, and the
 * server (or the weather collector) writes with the service key. Without
 * credentials the store is unavailable rather than silently local — a deployed
 * app must not fall back to a file that does not exist there.
 */

export interface WeatherSample {
  time: string;
  temp_c: number;
  wind_mps: number;
  wind_direction_deg: number;
  shortwave_wm2: number;
  provider: "open-meteo";
}

/** Raised when Supabase is missing or a weather-table call fails; routes answer 503. */
export class WeatherStoreUnavailable extends Error {
  constructor(message = "Weather samples live in Supabase; set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.") {
    super(message);
    this.name = "WeatherStoreUnavailable";
  }
}

export interface WeatherLocation {
  key: string;
  lat: number;
  lon: number;
}

/** The persistence surface, so tests can substitute an in-memory backend. */
export interface WeatherStore {
  remember(location: WeatherLocation, now: Date): Promise<void>;
  recent(since: Date): Promise<WeatherLocation[]>;
  latest(location: WeatherLocation, now: Date): Promise<WeatherSample | null>;
  persist(location: WeatherLocation, samples: WeatherSample[], refreshEqualTimestamp: boolean): Promise<void>;
}

const CELL_DIGITS = 3;
const roundCell = (value: number) => Number(value.toFixed(CELL_DIGITS));
/** Default Mapergy coverage center: Westminster, CA. */
export const WEATHER_BASELINE = { lat: 33.7538, lon: -118.0111 };

// ---- Supabase backend -------------------------------------------------------

let client: SupabaseClient | null | undefined;

function supabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new WeatherStoreUnavailable();
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

interface SampleRow {
  observed_at: string;
  temp_c: number;
  wind_mps: number;
  wind_direction_deg: number;
  shortwave_wm2: number;
  provider: WeatherSample["provider"];
}

const SAMPLE_COLUMNS = "observed_at,temp_c,wind_mps,wind_direction_deg,shortwave_wm2,provider";

/** Sample times are UTC minutes; Postgres keeps them as timestamptz. */
const toTimestamp = (minute: string) => `${minute}:00.000Z`;
const fromTimestamp = (value: string) => new Date(value).toISOString().slice(0, 16);

function toSample(row: SampleRow): WeatherSample {
  return {
    time: fromTimestamp(row.observed_at),
    temp_c: row.temp_c,
    wind_mps: row.wind_mps,
    wind_direction_deg: row.wind_direction_deg,
    shortwave_wm2: row.shortwave_wm2,
    provider: row.provider,
  };
}

function storeFailure(error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error);
  throw new WeatherStoreUnavailable(`Weather store query failed: ${detail}`);
}

const supabaseStore: WeatherStore = {
  async remember(location, now) {
    const db = supabase();
    const nowIso = now.toISOString();
    // Insert-once so `first_seen_at` survives; then touch the last sighting.
    const inserted = await db.from("weather_locations").upsert(
      {
        location_key: location.key,
        lat: location.lat,
        lon: location.lon,
        first_seen_at: nowIso,
        last_seen_at: nowIso,
      },
      { onConflict: "location_key", ignoreDuplicates: true },
    );
    if (inserted.error) storeFailure(inserted.error);
    const touched = await db
      .from("weather_locations")
      .update({ last_seen_at: nowIso })
      .eq("location_key", location.key);
    if (touched.error) storeFailure(touched.error);
  },

  async recent(since) {
    const { data, error } = await supabase()
      .from("weather_locations")
      .select("location_key,lat,lon")
      .gte("last_seen_at", since.toISOString())
      .order("last_seen_at", { ascending: false });
    if (error) storeFailure(error);
    return (data ?? []).map((row) => ({
      key: (row as { location_key: string }).location_key,
      lat: (row as { lat: number }).lat,
      lon: (row as { lon: number }).lon,
    }));
  },

  async latest(location, now) {
    const { data, error } = await supabase()
      .from("weather_samples")
      .select(SAMPLE_COLUMNS)
      .eq("location_key", location.key)
      .lte("observed_at", toTimestamp(now.toISOString().slice(0, 16)))
      .order("observed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) storeFailure(error);
    return data ? toSample(data as SampleRow) : null;
  },

  async persist(location, samples, refreshEqualTimestamp) {
    const rows = samples.map((sample) => ({
      location_key: location.key,
      observed_at: toTimestamp(sample.time),
      temp_c: sample.temp_c,
      wind_mps: sample.wind_mps,
      wind_direction_deg: sample.wind_direction_deg,
      shortwave_wm2: sample.shortwave_wm2,
      provider: sample.provider,
    }));
    const { error } = await supabase().from("weather_samples").upsert(rows, {
      onConflict: "location_key,observed_at",
      // A first observation wins; an equal timestamp only refreshes on request.
      ignoreDuplicates: !refreshEqualTimestamp,
    });
    if (error) storeFailure(error);
  },
};

let override: WeatherStore | null = null;

/** Test seam: pass null to restore the Supabase backend. */
export function setWeatherStoreForTests(store: WeatherStore | null): void {
  override = store;
}

function active(): WeatherStore {
  return override ?? supabaseStore;
}

// ---- Public API -------------------------------------------------------------

export function weatherLocation(lat: number, lon: number): WeatherLocation {
  const cellLat = roundCell(lat);
  const cellLon = roundCell(lon);
  return { key: `${cellLat},${cellLon}`, lat: cellLat, lon: cellLon };
}

export async function rememberWeatherLocation(
  lat: number,
  lon: number,
  now = new Date(),
): Promise<WeatherLocation> {
  const location = weatherLocation(lat, lon);
  await active().remember(location, now);
  return location;
}

export async function recentWeatherLocations(
  since = new Date(Date.now() - 24 * 60 * 60 * 1000),
): Promise<WeatherLocation[]> {
  return active().recent(since);
}

export async function latestPersistedWeather(
  location: WeatherLocation,
  now = new Date(),
): Promise<WeatherSample | null> {
  return active().latest(location, now);
}

export async function persistWeather(
  location: WeatherLocation,
  samples: WeatherSample[],
  refreshEqualTimestamp = false,
  now = new Date(),
): Promise<void> {
  const nowUtc = now.toISOString().slice(0, 16);
  const accepted = samples.filter((sample) => validUtcTime(sample.time) && sample.time <= nowUtc);
  if (!accepted.length) return;
  await active().persist(location, accepted, refreshEqualTimestamp);
}

// ---- Open-Meteo -------------------------------------------------------------

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
  // Resolves the store first: an unconfigured project answers 503 instead of
  // pretending a live reading was persisted.
  const before = await latestPersistedWeather(location);
  try {
    const sample = await fetchCurrentWeather(location);
    const isCurrentOrNewer = !before || sample.time >= before.time;
    if (isCurrentOrNewer) await persistWeather(location, [sample], true);
    const latest = (await latestPersistedWeather(location)) ?? sample;
    return { sample: latest, source: isCurrentOrNewer ? "live" : "persisted" };
  } catch {
    const persisted = (await latestPersistedWeather(location)) ?? before;
    try {
      const historical = await fetchHistoricalWeather(location);
      if (historical) await persistWeather(location, [historical]);
      const latest = (await latestPersistedWeather(location)) ?? persisted ?? historical;
      if (historical && (!persisted || historical.time > persisted.time)) {
        return { sample: latest ?? historical, source: "historical" };
      }
      return { sample: latest ?? null, source: latest ? "persisted" : "none" };
    } catch { return { sample: persisted ?? null, source: persisted ? "persisted" : "none" }; }
  }
}

export async function refreshRecentWeather(): Promise<void> {
  await rememberWeatherLocation(WEATHER_BASELINE.lat, WEATHER_BASELINE.lon);
  for (const location of await recentWeatherLocations()) await refreshWeatherLocation(location);
}
