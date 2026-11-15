// Read-only official source lookups for the owner plan (funding candidates,
// jurisdiction, and permit-applicability inputs).
//
// Rules: GET lookups against public machine-readable endpoints, plus the one
// documented Grants.gov Search2 POST (a search, not a submission). Every lookup
// yields at least one item; failures become status "unresolved" with a reason.
// Detail strings state what was looked up and what came back. They never assert
// fit, approval, or permit applicability; those are owner/reviewer decisions.

import type { Sector } from "./planTypes";

export type OwnerSourceStatus = "open" | "closed" | "forecasted" | "informational" | "unresolved";
export type OwnerSourceKind = "funding" | "jurisdiction" | "permit_input";

export interface OwnerSourceItem {
  id: string;
  title: string;
  url: string;
  kind: OwnerSourceKind;
  deadline?: string;
  status: OwnerSourceStatus;
  detail: string;
}

export interface OwnerSourcesResponse {
  retrievedAt: string;
  items: OwnerSourceItem[];
}

export interface OwnerSourcesQuery {
  lat: number;
  lon: number;
  radiusMi: number;
  sector: Sector;
}

export interface OwnerSourcesDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export const SECTORS: readonly Sector[] = ["electric", "water", "wastewater", "transport", "telecom"];
export const MAX_RADIUS_MI = 50;
export const DEFAULT_TIMEOUT_MS = 12_000;

export const GRANTS_SEARCH_URL = "https://api.grants.gov/v1/api/search2";
const GRANTS_DETAIL_URL = "https://www.grants.gov/search-results-detail/";
const CENSUS_GEOGRAPHIES_URL = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates";
const FEMA_NFHL_ZONES_URL = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";
const CPUC_HFTD_URL =
  "https://services2.arcgis.com/VofPZYDe2pLxSP5G/arcgis/rest/services/CPUC_High_Fire_Threat_District/FeatureServer/0/query";
const SAM_ASSISTANCE_URL = "https://sam.gov/assistance-listings";

/** Grants.gov keyword (+ optional funding category) per sector. Keyword match only. */
const GRANTS_QUERY: Record<Sector, { keyword: string; fundingCategories?: string }> = {
  electric: { keyword: "grid resilience", fundingCategories: "EN" },
  water: { keyword: "water infrastructure", fundingCategories: "ENV" },
  wastewater: { keyword: "wastewater infrastructure", fundingCategories: "ENV" },
  transport: { keyword: "bridge", fundingCategories: "T" },
  telecom: { keyword: "broadband" },
};
const GRANTS_ROWS = 10;

// ---------------------------------------------------------------------------
// Query validation (used by the route)

export type ParseResult = { ok: true; query: OwnerSourcesQuery } | { ok: false; error: string };

function num(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseOwnerSourcesQuery(params: URLSearchParams): ParseResult {
  const lat = num(params.get("lat"));
  const lon = num(params.get("lon"));
  const radius = num(params.get("radius"));
  const sector = params.get("sector");
  if (lat === null || lat < -90 || lat > 90) return { ok: false, error: "lat must be a number in [-90, 90]." };
  if (lon === null || lon < -180 || lon > 180) return { ok: false, error: "lon must be a number in [-180, 180]." };
  if (radius === null || radius <= 0 || radius > MAX_RADIUS_MI) {
    return { ok: false, error: `radius (miles) must be a number in (0, ${MAX_RADIUS_MI}].` };
  }
  if (sector === null || !(SECTORS as readonly string[]).includes(sector)) {
    return { ok: false, error: `sector must be one of ${SECTORS.join(", ")}.` };
  }
  return { ok: true, query: { lat, lon, radiusMi: radius, sector: sector as Sector } };
}

// ---------------------------------------------------------------------------
// Fetch helper: timeout, HTTP status, JSON parse. Never throws.

type JsonResult = { ok: true; json: unknown } | { ok: false; reason: string };

async function fetchJson(url: string, init: RequestInit, deps: Required<Pick<OwnerSourcesDeps, "fetch" | "timeoutMs">>): Promise<JsonResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await deps.fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    if (!res.ok) return { ok: false, reason: `upstream HTTP ${res.status}` };
    const text = await res.text();
    try {
      return { ok: true, json: JSON.parse(text) };
    } catch {
      return { ok: false, reason: "upstream response was not valid JSON" };
    }
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, reason: `upstream timed out after ${deps.timeoutMs} ms` };
    return { ok: false, reason: `upstream request failed (${err instanceof Error ? err.message : String(err)})` };
  } finally {
    clearTimeout(timer);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

function decodeEntities(s: string): string {
  return s
    .replace(/&rsquo;|&lsquo;|&#39;|&apos;/g, "'")
    .replace(/&rdquo;|&ldquo;|&quot;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** "MM/DD/YYYY" (as Grants.gov publishes) to ISO "YYYY-MM-DD"; null if absent or invalid. */
export function usDateToIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (d.getUTCFullYear() !== Number(yyyy) || d.getUTCMonth() !== Number(mm) - 1 || d.getUTCDate() !== Number(dd)) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function unresolved(id: string, title: string, url: string, kind: OwnerSourceKind, lookedUp: string, reason: string, stamp: string): OwnerSourceItem {
  return { id, title, url, kind, status: "unresolved", detail: `Looked up: ${lookedUp}. Not matched: ${reason}. Checked ${stamp}.` };
}

// ---------------------------------------------------------------------------
// Grants.gov Search2 (documented public search endpoint; POST JSON, no key)

function mapGrantsStatus(s: string): OwnerSourceStatus | null {
  switch (s) {
    case "posted": return "open";
    case "forecasted": return "forecasted";
    case "closed":
    case "archived": return "closed";
    default: return null;
  }
}

async function lookupGrants(q: OwnerSourcesQuery, deps: Required<OwnerSourcesDeps>, stamp: string): Promise<OwnerSourceItem[]> {
  const params = GRANTS_QUERY[q.sector];
  const lookedUp = `Grants.gov Search2 keyword "${params.keyword}"${params.fundingCategories ? ` in funding category ${params.fundingCategories}` : ""}, statuses posted|forecasted, national scope (not filtered by location)`;
  const title = `Grants.gov search: ${params.keyword}`;
  const body = JSON.stringify({ keyword: params.keyword, oppStatuses: "forecasted|posted", rows: GRANTS_ROWS, ...(params.fundingCategories ? { fundingCategories: params.fundingCategories } : {}) });
  const r = await fetchJson(GRANTS_SEARCH_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body }, deps);
  const searchUrl = "https://www.grants.gov/search-grants";
  if (!r.ok) return [unresolved("grants-gov-search", title, searchUrl, "funding", lookedUp, r.reason, stamp)];
  const j = r.json;
  if (!isObj(j) || j.errorcode !== 0 || !isObj(j.data) || !Array.isArray(j.data.oppHits) || typeof j.data.hitCount !== "number") {
    return [unresolved("grants-gov-search", title, searchUrl, "funding", lookedUp, "response did not match the expected Search2 shape", stamp)];
  }
  const hits = j.data.oppHits as unknown[];
  const hitCount = j.data.hitCount as number;
  if (hits.length === 0) {
    return [unresolved("grants-gov-search", title, searchUrl, "funding", lookedUp, "search returned 0 opportunities", stamp)];
  }
  const items: OwnerSourceItem[] = [{
    id: "grants-gov-search",
    title,
    url: searchUrl,
    kind: "funding",
    status: "informational",
    detail: `Looked up: ${lookedUp}. Matched: ${hitCount} listing(s); first ${hits.length} shown. Keyword match only; applicant and activity fit not assessed. Checked ${stamp}.`,
  }];
  hits.forEach((hit, i) => {
    const id = isObj(hit) ? str(hit.id) : null;
    const t = isObj(hit) ? str(hit.title) : null;
    const st = isObj(hit) && typeof hit.oppStatus === "string" ? mapGrantsStatus(hit.oppStatus) : null;
    if (!isObj(hit) || !id || !/^\d+$/.test(id) || !t || !st) {
      items.push(unresolved(`grants-gov-hit-${i}`, `Grants.gov result #${i + 1}`, searchUrl, "funding", lookedUp, "result entry missing id/title/status or had an unknown status", stamp));
      return;
    }
    const number = str(hit.number) ?? "unknown number";
    const agency = str(hit.agency) ?? str(hit.agencyCode) ?? "unknown agency";
    const cfda = Array.isArray(hit.cfdaList) ? hit.cfdaList.filter((c): c is string => typeof c === "string") : [];
    const deadline = usDateToIso(hit.closeDate);
    const openDate = usDateToIso(hit.openDate);
    const item: OwnerSourceItem = {
      id: `grants-gov-${id}`,
      title: decodeEntities(t),
      url: `${GRANTS_DETAIL_URL}${id}`,
      kind: "funding",
      status: st,
      detail: [
        `Grants.gov listing ${number} (${agency})${cfda.length ? `, Assistance Listing ${cfda.join(", ")}` : ""}.`,
        `Publisher status: ${hit.oppStatus}.`,
        openDate ? `Posted/open date ${openDate}.` : "",
        deadline ? `Publisher close date ${deadline}.` : "No close date stated by publisher.",
        `Matched keyword search only; read the controlling notice for applicant, activity, match and date terms. Checked ${stamp}.`,
      ].filter(Boolean).join(" "),
    };
    if (deadline) item.deadline = deadline;
    items.push(item);
  });
  return items;
}

// ---------------------------------------------------------------------------
// SAM.gov Assistance Listings: requires an API key; not queried.

function samUnavailable(stamp: string): OwnerSourceItem {
  return {
    id: "sam-assistance-listings",
    title: "SAM.gov Assistance Listings",
    url: SAM_ASSISTANCE_URL,
    kind: "funding",
    status: "unresolved",
    detail: `Not looked up: the SAM.gov Assistance Listings API (api.sam.gov) requires a registered API key; keyless requests returned HTTP 404 when tested on 2026-11-14. Search the listings manually at sam.gov. Status as of ${stamp}.`,
  };
}

// ---------------------------------------------------------------------------
// Census geocoder: jurisdiction (state / county / incorporated place)

function censusUrl(q: OwnerSourcesQuery): string {
  const p = new URLSearchParams({ x: String(q.lon), y: String(q.lat), benchmark: "Public_AR_Current", vintage: "Current_Current", format: "json" });
  return `${CENSUS_GEOGRAPHIES_URL}?${p}`;
}

async function lookupJurisdiction(q: OwnerSourcesQuery, deps: Required<OwnerSourcesDeps>, stamp: string): Promise<OwnerSourceItem[]> {
  const url = censusUrl(q);
  const lookedUp = `US Census geocoder geographies at ${q.lat},${q.lon} (Public_AR_Current / Current_Current)`;
  const title = "Jurisdiction (Census geographies)";
  const r = await fetchJson(url, { method: "GET", headers: { Accept: "application/json" } }, deps);
  if (!r.ok) return [unresolved("census-jurisdiction", title, url, "jurisdiction", lookedUp, r.reason, stamp)];
  const g = isObj(r.json) && isObj(r.json.result) && isObj(r.json.result.geographies) ? r.json.result.geographies : null;
  if (!g) return [unresolved("census-jurisdiction", title, url, "jurisdiction", lookedUp, "response did not match the expected geocoder shape", stamp)];
  const first = (key: string): Record<string, unknown> | null => {
    const arr = g[key];
    return Array.isArray(arr) && isObj(arr[0]) ? arr[0] : null;
  };
  const state = first("States");
  const county = first("Counties");
  const place = first("Incorporated Places");
  const stateName = state ? str(state.NAME) : null;
  const stateId = state ? str(state.GEOID) : null;
  const countyName = county ? str(county.NAME) : null;
  const countyId = county ? str(county.GEOID) : null;
  if (!stateName || !stateId || !countyName || !countyId) {
    return [unresolved("census-jurisdiction", title, url, "jurisdiction", lookedUp, "no state/county geography returned for this point", stamp)];
  }
  const placeName = place ? str(place.NAME) : null;
  const placeId = place ? str(place.GEOID) : null;
  const placeText = placeName && placeId
    ? `incorporated place ${placeName} (GEOID ${placeId})`
    : "no incorporated place returned (point may be in unincorporated county area)";
  return [{
    id: "census-jurisdiction",
    title: placeName ? `Jurisdiction: ${placeName}, ${countyName}, ${stateName}` : `Jurisdiction: ${countyName}, ${stateName}`,
    url,
    kind: "jurisdiction",
    status: "informational",
    detail: `Looked up: ${lookedUp}. Matched: state ${stateName} (FIPS ${stateId}), ${countyName} (FIPS ${countyId}), ${placeText}. Candidate local authorities only; permitting authority not determined. Checked ${stamp}.`,
  }];
}

// ---------------------------------------------------------------------------
// ArcGIS feature queries (FEMA NFHL flood zones, CPUC HFTD)

function arcgisUrl(base: string, q: OwnerSourcesQuery, extra: Record<string, string>): string {
  const p = new URLSearchParams({
    geometry: `${q.lon},${q.lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "false",
    f: "json",
    ...extra,
  });
  return `${base}?${p}`;
}

type FeaturesResult = { ok: true; attrs: Record<string, unknown>[] } | { ok: false; reason: string };

async function arcgisFeatures(url: string, deps: Required<OwnerSourcesDeps>): Promise<FeaturesResult> {
  const r = await fetchJson(url, { method: "GET", headers: { Accept: "application/json" } }, deps);
  if (!r.ok) return r;
  const j = r.json;
  if (isObj(j) && isObj(j.error)) return { ok: false, reason: `ArcGIS error ${str(j.error.code) ?? ""} ${str(j.error.message) ?? ""}`.trim() };
  if (!isObj(j) || !Array.isArray(j.features)) return { ok: false, reason: "response did not match the expected ArcGIS query shape" };
  const attrs: Record<string, unknown>[] = [];
  for (const f of j.features) {
    if (!isObj(f) || !isObj(f.attributes)) return { ok: false, reason: "ArcGIS feature missing attributes" };
    attrs.push(f.attributes);
  }
  return { ok: true, attrs };
}

async function lookupFemaPoint(q: OwnerSourcesQuery, deps: Required<OwnerSourcesDeps>, stamp: string): Promise<OwnerSourceItem> {
  const url = arcgisUrl(FEMA_NFHL_ZONES_URL, q, { outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF,DFIRM_ID" });
  const lookedUp = `FEMA NFHL Flood Hazard Zones (layer 28) at point ${q.lat},${q.lon}`;
  const id = "fema-nfhl-point";
  const title = "FEMA flood zone at site point";
  const r = await arcgisFeatures(url, deps);
  if (!r.ok) return unresolved(id, title, url, "permit_input", lookedUp, r.reason, stamp);
  if (r.attrs.length === 0) return unresolved(id, title, url, "permit_input", lookedUp, "no mapped NFHL flood zone polygon at this point (unmapped or outside NFHL coverage)", stamp);
  const zones: string[] = [];
  for (const a of r.attrs) {
    const z = str(a.FLD_ZONE);
    if (!z) return unresolved(id, title, url, "permit_input", lookedUp, "feature missing FLD_ZONE", stamp);
    const sub = str(a.ZONE_SUBTY);
    const sfha = a.SFHA_TF === "T" ? "in SFHA" : a.SFHA_TF === "F" ? "not in SFHA" : "SFHA flag not stated";
    const panel = str(a.DFIRM_ID);
    zones.push(`${z}${sub ? ` (${sub})` : ""}, ${sfha}${panel ? `, DFIRM ${panel}` : ""}`);
  }
  return {
    id, title: `FEMA flood zone at site: ${str(r.attrs[0].FLD_ZONE)}`, url, kind: "permit_input", status: "informational",
    detail: `Looked up: ${lookedUp}. Matched: ${zones.join("; ")}. Input to floodplain permit screening; applicability not determined. Checked ${stamp}.`,
  };
}

async function lookupFemaRadius(q: OwnerSourcesQuery, deps: Required<OwnerSourcesDeps>, stamp: string): Promise<OwnerSourceItem> {
  const stats = JSON.stringify([{ statisticType: "count", onStatisticField: "FLD_ZONE", outStatisticFieldName: "n" }]);
  const url = arcgisUrl(FEMA_NFHL_ZONES_URL, q, {
    distance: String(q.radiusMi), units: "esriSRUnit_StatuteMile", outStatistics: stats, groupByFieldsForStatistics: "FLD_ZONE",
  });
  const lookedUp = `FEMA NFHL Flood Hazard Zones (layer 28) within ${q.radiusMi} mi of ${q.lat},${q.lon}`;
  const id = "fema-nfhl-radius";
  const title = `FEMA flood zones within ${q.radiusMi} mi`;
  const r = await arcgisFeatures(url, deps);
  if (!r.ok) return unresolved(id, title, url, "permit_input", lookedUp, r.reason, stamp);
  if (r.attrs.length === 0) return unresolved(id, title, url, "permit_input", lookedUp, "no mapped NFHL flood zone polygons in radius", stamp);
  const parts: string[] = [];
  for (const a of r.attrs) {
    const z = str(a.FLD_ZONE);
    const n = typeof a.n === "number" ? a.n : null;
    if (!z || n === null) return unresolved(id, title, url, "permit_input", lookedUp, "statistics row missing FLD_ZONE or count", stamp);
    parts.push(`${z} (${n} polygons)`);
  }
  parts.sort();
  return {
    id, title, url, kind: "permit_input", status: "informational",
    detail: `Looked up: ${lookedUp}. Matched zones: ${parts.join(", ")}. FEMA zones starting with A or V are Special Flood Hazard Areas; route/site-specific screening still required. Checked ${stamp}.`,
  };
}

async function lookupCpuc(q: OwnerSourcesQuery, deps: Required<OwnerSourcesDeps>, stamp: string, radius: boolean): Promise<OwnerSourceItem> {
  const url = arcgisUrl(CPUC_HFTD_URL, q, {
    outFields: "HFTD",
    ...(radius ? { distance: String(q.radiusMi), units: "esriSRUnit_StatuteMile" } : {}),
  });
  const where = radius ? `within ${q.radiusMi} mi of ${q.lat},${q.lon}` : `at point ${q.lat},${q.lon}`;
  const lookedUp = `CPUC Fire-Threat Map (HFTD Tier 2 and Tier 3 layer, California only) ${where}`;
  const id = radius ? "cpuc-hftd-radius" : "cpuc-hftd-point";
  const title = radius ? `CPUC High Fire-Threat District within ${q.radiusMi} mi` : "CPUC High Fire-Threat District at site point";
  const r = await arcgisFeatures(url, deps);
  if (!r.ok) return unresolved(id, title, url, "permit_input", lookedUp, r.reason, stamp);
  const tiers = new Set<string>();
  for (const a of r.attrs) {
    const t = str(a.HFTD);
    if (!t) return unresolved(id, title, url, "permit_input", lookedUp, "feature missing HFTD tier", stamp);
    tiers.add(t);
  }
  const matched = tiers.size
    ? `Matched: ${[...tiers].sort().join(", ")}.`
    : "Matched: no HFTD Tier 2/Tier 3 polygon intersects (the layer does not cover areas outside California).";
  return {
    id, title, url, kind: "permit_input", status: "informational",
    detail: `Looked up: ${lookedUp}. ${matched} Input to CPUC fire-safety rule screening for overhead electric work; applicability not determined. Checked ${stamp}.`,
  };
}

// ---------------------------------------------------------------------------

async function settle(id: string, title: string, url: string, kind: OwnerSourceKind, stamp: string, run: () => Promise<OwnerSourceItem[]>): Promise<OwnerSourceItem[]> {
  try {
    return await run();
  } catch (err) {
    return [unresolved(id, title, url, kind, title, `internal lookup error (${err instanceof Error ? err.message : String(err)})`, stamp)];
  }
}

export async function lookupOwnerSources(q: OwnerSourcesQuery, deps: OwnerSourcesDeps = {}): Promise<OwnerSourcesResponse> {
  const d: Required<OwnerSourcesDeps> = {
    fetch: deps.fetch ?? fetch,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    now: deps.now ?? (() => new Date()),
  };
  const retrievedAt = d.now().toISOString();
  const groups = await Promise.all([
    settle("census-jurisdiction", "Jurisdiction (Census geographies)", CENSUS_GEOGRAPHIES_URL, "jurisdiction", retrievedAt, () => lookupJurisdiction(q, d, retrievedAt)),
    settle("fema-nfhl-point", "FEMA flood zone at site point", FEMA_NFHL_ZONES_URL, "permit_input", retrievedAt, async () => [await lookupFemaPoint(q, d, retrievedAt)]),
    settle("fema-nfhl-radius", "FEMA flood zones in radius", FEMA_NFHL_ZONES_URL, "permit_input", retrievedAt, async () => [await lookupFemaRadius(q, d, retrievedAt)]),
    settle("cpuc-hftd-point", "CPUC High Fire-Threat District at site point", CPUC_HFTD_URL, "permit_input", retrievedAt, async () => [await lookupCpuc(q, d, retrievedAt, false)]),
    settle("cpuc-hftd-radius", "CPUC High Fire-Threat District in radius", CPUC_HFTD_URL, "permit_input", retrievedAt, async () => [await lookupCpuc(q, d, retrievedAt, true)]),
    settle("grants-gov-search", "Grants.gov search", GRANTS_SEARCH_URL, "funding", retrievedAt, () => lookupGrants(q, d, retrievedAt)),
    Promise.resolve([samUnavailable(retrievedAt)]),
  ]);
  return { retrievedAt, items: groups.flat() };
}

// ---------------------------------------------------------------------------
// Per-process cache and upstream budget (used by the route). One lookup is six
// upstream calls, so unauthenticated GETs are served from a small LRU keyed on
// the point rounded to 3 dp (~110 m), radius and sector, and cache misses draw
// from a token bucket shared by all callers in this process.

export const SOURCES_CACHE_MAX = 128;
export const SOURCES_CACHE_TTL_MS = 10 * 60_000;
export const SOURCES_LOOKUPS_PER_MINUTE = 30;

export type CachedOwnerSources = { ok: true; body: OwnerSourcesResponse } | { ok: false; retryAfterSeconds: number };

const sourcesCache = new Map<string, { expires: number; body: OwnerSourcesResponse }>();
let bucket = { tokens: SOURCES_LOOKUPS_PER_MINUTE, at: Number.NaN };

/** Clear the cache and refill the budget (tests). */
export function resetOwnerSourcesCache(): void {
  sourcesCache.clear();
  bucket = { tokens: SOURCES_LOOKUPS_PER_MINUTE, at: Number.NaN };
}

const round3 = (value: number) => Number(value.toFixed(3));

/**
 * Cached lookup. The query is rounded to 3 dp before it is looked up, so a
 * cached body's detail strings name the coordinates that were actually queried.
 * A miss with an empty budget makes no upstream call and returns retryAfterSeconds.
 */
export async function cachedOwnerSources(q: OwnerSourcesQuery, deps: OwnerSourcesDeps = {}): Promise<CachedOwnerSources> {
  const rounded: OwnerSourcesQuery = { ...q, lat: round3(q.lat), lon: round3(q.lon) };
  const key = `${rounded.lat}|${rounded.lon}|${rounded.radiusMi}|${rounded.sector}`;
  const now = (deps.now ?? (() => new Date()))().getTime();
  const hit = sourcesCache.get(key);
  if (hit && hit.expires > now) {
    sourcesCache.delete(key);
    sourcesCache.set(key, hit);
    return { ok: true, body: hit.body };
  }
  if (hit) sourcesCache.delete(key);
  const perMs = SOURCES_LOOKUPS_PER_MINUTE / 60_000;
  const elapsed = Number.isNaN(bucket.at) ? 0 : Math.max(0, now - bucket.at);
  bucket = { tokens: Math.min(SOURCES_LOOKUPS_PER_MINUTE, bucket.tokens + elapsed * perMs), at: now };
  if (bucket.tokens < 1) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000)) };
  bucket.tokens -= 1;
  const body = await lookupOwnerSources(rounded, deps);
  sourcesCache.set(key, { expires: now + SOURCES_CACHE_TTL_MS, body });
  while (sourcesCache.size > SOURCES_CACHE_MAX) sourcesCache.delete(sourcesCache.keys().next().value!);
  return { ok: true, body };
}
