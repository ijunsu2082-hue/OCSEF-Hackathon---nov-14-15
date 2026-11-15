import { buildNewsFeed, cleanTerms, MAX_PLACES, MAX_UTILITIES, NEWS_PROVIDERS, type NewsLive } from "@/lib/live/news";
import type { LiveFeed } from "@/lib/live/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorFeed(message: string): LiveFeed<NewsLive> {
  return {
    feed: "news",
    status: "error",
    fetchedAt: new Date().toISOString(),
    sourceUpdatedAt: null,
    maxAgeSec: 3600,
    refreshSec: 600,
    providers: NEWS_PROVIDERS,
    crossChecks: [],
    errors: [message],
    data: null,
  };
}

/** GET /api/live/news?places=Anaheim|Garden Grove&utilities=Anaheim Public Utilities (| separated). */
export async function GET(request: Request) {
  try {
    const sp = new URL(request.url).searchParams;
    const places = cleanTerms((sp.get("places") ?? "").split("|"), MAX_PLACES);
    const utilities = cleanTerms((sp.get("utilities") ?? "").split("|"), MAX_UTILITIES);
    if (places.length === 0) {
      return Response.json(errorFeed("places is required: one or more place names separated by |."), { status: 400 });
    }
    const feed = await buildNewsFeed(places, utilities);
    return Response.json(feed, {
      headers:
        feed.status === "error"
          ? { "Cache-Control": "no-store" }
          : { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1200", "Netlify-Vary": "query" },
    });
  } catch {
    return Response.json(errorFeed("News feed failed unexpectedly."), { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
