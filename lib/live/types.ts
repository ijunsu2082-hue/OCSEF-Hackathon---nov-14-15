/**
 * Live data contract (frozen). Every live provider is served by a Next route under
 * app/api/live/<feed>/route.ts that fetches the upstream source server-side (no CORS,
 * no keys in the browser), caches briefly, and returns a LiveFeed<T>. The panel polls
 * these routes on an interval so the app stays current without the user asking.
 */

export type FeedStatus = "live" | "stale" | "error";

/** One upstream provider used to build a feed. */
export interface ProviderRef {
  id: string; // e.g. "nws", "eia", "caiso", "usgs", "nifc", "open-meteo", "fema-nri", "cdc-svi"
  name: string; // e.g. "National Weather Service"
  url: string; // official human-readable page for the source
}

/** Result of comparing the same quantity from two independent providers. */
export interface CrossCheck {
  quantity: string; // e.g. "Air temperature at scan center"
  a: { provider: string; value: number; unit: string };
  b: { provider: string; value: number; unit: string };
  diff: number; // a - b, in unit
  diffPct: number | null; // relative, when meaningful
  tolerance: string; // plain words, e.g. "within 3 °C"
  agree: boolean;
  note?: string;
}

export interface LiveFeed<T> {
  feed: string; // e.g. "weather", "grid", "hazards"
  status: FeedStatus;
  fetchedAt: string; // ISO, when our server fetched upstream
  sourceUpdatedAt: string | null; // ISO, the upstream data's own timestamp
  maxAgeSec: number; // after this many seconds since sourceUpdatedAt the data counts as stale
  refreshSec: number; // how often the client should poll
  providers: ProviderRef[];
  crossChecks: CrossCheck[];
  errors: string[]; // plain-language problems (one provider down etc.), never stack traces
  data: T | null;
}

export const POINT_PARAMS = "lat, lon (decimal degrees), r (miles, optional)";
