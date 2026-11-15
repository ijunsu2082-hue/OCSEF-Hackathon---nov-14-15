/**
 * Live local news: recent articles that name a place in the scan circle together with a
 * power-grid topic (outage, power lines, substation, the local utility...).
 *
 * Primary source: Google News search RSS (free, no key). Fallback: the GDELT DOC 2.0 API,
 * tried once only when Google News fails (GDELT allows one request per 5 seconds per IP).
 * Fetched server-side by app/api/live/news, cached briefly, polled by the Local news tab.
 */
import type { LiveFeed, ProviderRef } from "./types";

export interface NewsArticle {
  title: string;
  source: string;
  url: string;
  publishedAt: string | null; // ISO
  /** Plain-text summary from the feed, used only to check relevance (not sent to the browser). */
  snippet?: string;
}

export interface NewsLive {
  /** Plain-words description of what was searched. */
  searched: string;
  windowDays: number;
  articles: NewsArticle[];
}

export const NEWS_WINDOW_DAYS = 14;
export const NEWS_MAX_ARTICLES = 12;
const TIMEOUT_MS = 8000;

export const NEWS_PROVIDERS: ProviderRef[] = [
  { id: "google-news", name: "Google News search", url: "https://news.google.com/" },
  { id: "gdelt", name: "GDELT Project (backup)", url: "https://www.gdeltproject.org/" },
];

/** Grid topics searched alongside a place (short list: long OR lists make Google ignore the date window). */
export const NEWS_TOPICS = ["power outage", "power lines", "substation", "electricity"];

/** An article counts as grid news only if its title or summary uses one of these words. */
export const GRID_WORDS =
  /\b(power outages?|outages?|power lines?|transmission lines?|substations?|electricity|electric (grid|utility|service|rates?|bills?)|power grid|the grid|blackouts?|power shutoffs?|rolling blackouts|flex alert|utility|utilities|solar|batter(y|ies)|transformers?|edison|SCE|LADWP|SDG&E|PG&E)\b/i;

/** How many places get their own search per refresh (each is one request to Google News). */
export const SEARCHED_PLACES = 3;

const TERM_RE = /^[A-Za-z0-9 .'&-]{2,60}$/;
export const MAX_PLACES = 5;
export const MAX_UTILITIES = 3;

/** Keep only safe, distinct search terms (letters, digits, spaces and . ' & -). */
export function cleanTerms(raw: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const t = r.replace(/\s+/g, " ").trim();
    const k = t.toLowerCase();
    if (!TERM_RE.test(t) || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

const quote = (t: string) => `"${t}"`;

/** One search per place: "Place" ("topic" OR ... OR "utility"). */
export function newsQuery(place: string, utilities: string[]): string {
  return `${quote(place)} (${[...NEWS_TOPICS, ...utilities].map(quote).join(" OR ")})`;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(item: string, name: string): string {
  const m = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
}

function toIso(s: string): string | null {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Newest first, one per title, at most NEWS_MAX_ARTICLES. */
function tidy(list: NewsArticle[], max = NEWS_MAX_ARTICLES): NewsArticle[] {
  const seen = new Set<string>();
  return list
    .filter((a) => a.title && /^https?:\/\//.test(a.url))
    .filter((a) => {
      const k = a.title.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, max);
}

/** Parse Google News RSS. Titles end in " - Source"; that suffix is dropped. */
export function parseGoogleNewsRss(xml: string): NewsArticle[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return tidy(
    items.map((it) => {
      const source = tag(it, "source");
      let title = tag(it, "title");
      if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
      const snippet = tag(it, "description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return { title, source, url: tag(it, "link"), publishedAt: toIso(tag(it, "pubDate")), snippet };
    }),
    Infinity,
  );
}

/** Parse a GDELT DOC artlist response. seendate looks like 20261115T171500Z. */
export function parseGdelt(json: unknown): NewsArticle[] {
  const arts = (json as { articles?: { url?: string; title?: string; domain?: string; seendate?: string }[] })?.articles ?? [];
  return tidy(
    arts.map((a) => {
      const m = (a.seendate ?? "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      return {
        title: (a.title ?? "").trim(),
        source: (a.domain ?? "").trim(),
        url: (a.url ?? "").trim(),
        publishedAt: m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null,
      };
    }),
  );
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store", headers: { "User-Agent": "Mapergy/1.0 (local grid news)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fromGoogle(q: string): Promise<NewsArticle[]> {
  const u = new URL("https://news.google.com/rss/search");
  u.searchParams.set("q", `${q} when:${NEWS_WINDOW_DAYS}d`);
  u.searchParams.set("hl", "en-US");
  u.searchParams.set("gl", "US");
  u.searchParams.set("ceid", "US:en");
  const xml = await fetchText(u.toString());
  if (!xml.includes("<rss")) throw new Error("not an RSS response");
  return parseGoogleNewsRss(xml);
}

async function fromGdelt(q: string): Promise<NewsArticle[]> {
  const u = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  u.searchParams.set("query", `${q} sourcecountry:US`);
  u.searchParams.set("mode", "artlist");
  u.searchParams.set("format", "json");
  u.searchParams.set("maxrecords", String(NEWS_MAX_ARTICLES * 2));
  u.searchParams.set("sort", "DateDesc");
  u.searchParams.set("timespan", `${NEWS_WINDOW_DAYS}d`);
  const text = await fetchText(u.toString());
  if (!text.trim().startsWith("{")) throw new Error(text.slice(0, 80) || "empty response");
  return parseGdelt(JSON.parse(text));
}

/**
 * Search engines loosen long OR queries (old and far-away stories slip in), so keep only articles
 * published inside the window whose title or summary names one of the places or utilities.
 */
/** Other states and provinces whose towns share Southern California place names. */
const ELSEWHERE =
  /\b(Washington state|Oregon|Colorado|Maryland|Massachusetts|Vermont|South Carolina|North Carolina|New York|New Jersey|Texas|Florida|Arizona|Nevada|British Columbia|Ontario|London|England|Wash\.|Ore\.|Colo\.|Md\.)\b/;
const CALIFORNIA = /\b(California|Calif\.|SoCal|Southern California|Orange County|Los Angeles County|Inland Empire|San Diego County)\b/i;

function placeRe(name: string): RegExp {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Not "New Westminster", not "Long Beach Peninsula".
  return new RegExp(`(^|[^a-z0-9])(?<!new )${n}(?! peninsula)($|[^a-z0-9])`, "i");
}

/**
 * Search engines loosen queries (old, far-away and off-topic stories slip in), so keep only articles
 * published inside the window whose title or summary names one of the places or utilities, uses a
 * grid word, and is not about a same-named town in another state.
 */
export function relevant(articles: NewsArticle[], names: string[], nowMs: number, windowDays = NEWS_WINDOW_DAYS): NewsArticle[] {
  const res = names.map(placeRe);
  const oldest = nowMs - windowDays * 86400_000;
  return articles
    .filter((a) => a.publishedAt !== null && Date.parse(a.publishedAt) >= oldest && Date.parse(a.publishedAt) <= nowMs + 3600_000)
    .filter((a) => {
      const text = `${a.title} ${a.snippet ?? ""}`;
      if (!res.some((re) => re.test(text)) || !GRID_WORDS.test(text)) return false;
      return !(ELSEWHERE.test(text) && !CALIFORNIA.test(text.replace(/Southern California Edison/gi, "")));
    })
    .map(({ snippet: _snippet, ...rest }) => rest);
}

export async function buildNewsFeed(places: string[], utilities: string[]): Promise<LiveFeed<NewsLive>> {
  const fetchedAt = new Date().toISOString();
  const nowMs = Date.parse(fetchedAt);
  const names = [...places, ...utilities];
  const searched = `Power and grid news naming ${places.join(", ")}${utilities.length ? ` or ${utilities.join(", ")}` : ""}`;
  const base = { feed: "news", fetchedAt, sourceUpdatedAt: fetchedAt, maxAgeSec: 3600, refreshSec: 600, crossChecks: [] };
  const errors: string[] = [];
  const ok = (provider: string, raw: NewsArticle[]): LiveFeed<NewsLive> => ({
    ...base,
    status: "live",
    providers: NEWS_PROVIDERS.filter((p) => p.id === provider),
    errors,
    data: { searched, windowDays: NEWS_WINDOW_DAYS, articles: tidy(relevant(raw, names, nowMs)) },
  });

  // Google News: one search per place, in parallel; a feed is live if at least one search answered.
  const results = await Promise.allSettled(places.slice(0, SEARCHED_PLACES).map((p) => fromGoogle(newsQuery(p, utilities))));
  const answered = results.filter((r): r is PromiseFulfilledResult<NewsArticle[]> => r.status === "fulfilled");
  if (answered.length > 0) return ok("google-news", answered.flatMap((r) => r.value));
  errors.push("Google News did not answer.");

  // Backup: one GDELT search for all places together (GDELT allows one request per 5 s).
  try {
    const q = `(${places.map(quote).join(" OR ")}) (${[...NEWS_TOPICS, ...utilities].map(quote).join(" OR ")})`;
    return ok("gdelt", await fromGdelt(q));
  } catch (e) {
    errors.push(`GDELT did not answer (${e instanceof Error ? e.message : "failed"}).`);
  }
  return { ...base, status: "error", sourceUpdatedAt: null, providers: NEWS_PROVIDERS, errors, data: null };
}
