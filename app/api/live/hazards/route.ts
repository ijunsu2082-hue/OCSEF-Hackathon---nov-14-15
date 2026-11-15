import { buildHazardsFeed, HAZARD_PROVIDERS, type HazardsLive } from "@/lib/live/hazards";
import type { LiveFeed } from "@/lib/live/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_R_MI = 50;
const MAX_R_MI = 500;

function errorFeed(message: string): LiveFeed<HazardsLive> {
  return {
    feed: "hazards",
    status: "error",
    fetchedAt: new Date().toISOString(),
    sourceUpdatedAt: null,
    maxAgeSec: 1800,
    refreshSec: 300,
    providers: HAZARD_PROVIDERS,
    crossChecks: [],
    errors: [message],
    data: null,
  };
}

/** GET /api/live/hazards?lat=..&lon=..&r=.. (r in miles, optional, default 50, max 500). */
export async function GET(request: Request) {
  try {
    const sp = new URL(request.url).searchParams;
    const lat = Number(sp.get("lat"));
    const lon = Number(sp.get("lon"));
    const rRaw = sp.get("r");
    const r = rRaw == null || rRaw === "" ? DEFAULT_R_MI : Number(rRaw);

    if (!sp.has("lat") || !sp.has("lon") || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return Response.json(errorFeed("lat and lon are required decimal degrees."), { status: 400 });
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return Response.json(errorFeed("lat must be within -90..90 and lon within -180..180."), { status: 400 });
    }
    if (!Number.isFinite(r) || r <= 0 || r > MAX_R_MI) {
      return Response.json(errorFeed(`r must be a radius in miles between 0 and ${MAX_R_MI}.`), { status: 400 });
    }

    const feed = await buildHazardsFeed(lat, lon, r);
    return Response.json(feed, {
      headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300", "Netlify-Vary": "query" },
    });
  } catch {
    return Response.json(errorFeed("Hazards feed failed unexpectedly."), {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
