import { buildWeatherFeed, MAX_AGE_SEC, REFRESH_SEC, type WeatherLive } from "@/lib/live/weather";
import type { LiveFeed } from "@/lib/live/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_HEADERS = { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=240" };

function errorFeed(message: string): LiveFeed<WeatherLive> {
  return {
    feed: "weather",
    status: "error",
    fetchedAt: new Date().toISOString(),
    sourceUpdatedAt: null,
    maxAgeSec: MAX_AGE_SEC,
    refreshSec: REFRESH_SEC,
    providers: [],
    crossChecks: [],
    errors: [message],
    data: null,
  };
}

const parse = (v: string | null): number | null => {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const lat = parse(q.get("lat"));
  const lon = parse(q.get("lon"));
  const rRaw = q.get("r");
  const r = rRaw == null ? 25 : parse(rRaw);

  if (lat == null || lon == null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return Response.json(errorFeed("lat and lon are required decimal degrees (lat -90..90, lon -180..180)."), { status: 400 });
  }
  if (r == null || r <= 0 || r > 500) {
    return Response.json(errorFeed("r must be a radius in miles between 0 and 500."), { status: 400 });
  }

  try {
    const feed = await buildWeatherFeed(lat, lon, r);
    return Response.json(feed, { headers: feed.status === "error" ? { "Cache-Control": "no-store" } : CACHE_HEADERS });
  } catch {
    return Response.json(errorFeed("Weather feed failed unexpectedly; try again shortly."), {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
