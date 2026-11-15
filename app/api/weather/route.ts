import {
  latestPersistedWeather,
  rememberWeatherLocation,
  refreshWeatherLocation,
} from "@/lib/scan/weather";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (code: string, message: string, status: number) =>
  Response.json({ error: { code, message } }, { status });

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

  const location = rememberWeatherLocation(lat, lon);
  const previous = latestPersistedWeather(location);
  const refreshed = await refreshWeatherLocation(location);
  const current = refreshed.sample ?? latestPersistedWeather(location) ?? previous;
  const source = refreshed.sample ? refreshed.source : current ? "persisted" : "none";
  return Response.json({
    location: { lat: location.lat, lon: location.lon },
    current,
    source,
    fetched_at: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
