import { buildGridFeed, gridErrorFeed } from "@/lib/live/grid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_HEADERS = { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" };

const parse = (v: string | null): number | null => {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = parse(url.searchParams.get("lat"));
  const lon = parse(url.searchParams.get("lon"));

  if (lat == null || lon == null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return Response.json(gridErrorFeed("lat and lon are required decimal degrees (lat -90..90, lon -180..180)."), {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const feed = await buildGridFeed(lat, lon, { origin: url.origin });
    return Response.json(feed, { headers: feed.status === "error" ? { "Cache-Control": "no-store" } : CACHE_HEADERS });
  } catch {
    return Response.json(gridErrorFeed("Grid feed failed unexpectedly; try again shortly."), {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
