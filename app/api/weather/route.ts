import {
  latestPersistedWeather,
  rememberWeatherLocation,
  refreshWeatherLocation,
  WeatherStoreUnavailable,
} from "@/lib/scan/weather";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const jsonError = (code: string, message: string, status: number) =>
  Response.json({ error: { code, message } }, { status, headers: NO_STORE });

/**
 * Anything that escapes the refresh fallbacks: an unconfigured Supabase (the
 * weather tables are the store) → 503, anything else (an unparseable upstream
 * body, e.g. `SyntaxError: Unexpected end of JSON input`) → 502.
 */
function failure(error: unknown): Response {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof WeatherStoreUnavailable) {
    return jsonError("WEATHER_STORE_UNAVAILABLE", detail, 503);
  }
  return jsonError("WEATHER_UPSTREAM_FAILED", `Weather could not be loaded: ${detail}`, 502);
}

function parseCoordinate(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const lat = parseCoordinate(params.get("lat"));
  const lon = parseCoordinate(params.get("lon"));
  if (lat === null || lon === null) return jsonError("INVALID_COORDINATES", "lat and lon must be finite numbers.", 400);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return jsonError("INVALID_COORDINATES", "lat/lon are outside WGS84 bounds.", 422);
  }

  try {
    const location = await rememberWeatherLocation(lat, lon);
    const previous = await latestPersistedWeather(location);
    const refreshed = await refreshWeatherLocation(location);
    const current = refreshed.sample ?? (await latestPersistedWeather(location)) ?? previous;
    const source = refreshed.sample ? refreshed.source : current ? "persisted" : "none";
    return Response.json({
      location: { lat: location.lat, lon: location.lon },
      current,
      source,
      fetched_at: new Date().toISOString(),
    }, { headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}
