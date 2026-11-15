/**
 * Live hazards + vulnerability feed for any U.S. point and scan radius (server only).
 *
 * Sources (all public, no key):
 *  - NIFC WFIGS current incident locations + current perimeters (ArcGIS FeatureServer)
 *  - USGS earthquake catalog (FDSN event query, last 7 days)
 *  - FEMA National Risk Index, census tracts (county fallback) (ArcGIS FeatureServer)
 *  - CDC/ATSDR Social Vulnerability Index 2022, census tracts (ArcGIS FeatureServer)
 *
 * The parsers and the cross-reference logic are exported pure functions so they can be
 * tested on fixtures without network.
 */

import type { FeatureCollection, Geometry } from "geojson";
import { haversineMi } from "@/lib/scan/geo";
import type { CrossCheck, FeedStatus, LiveFeed, ProviderRef } from "./types";

export interface HazardFire {
  id: string;
  name: string;
  lat: number;
  lon: number;
  acres: number | null;
  containedPct: number | null;
  discovered: string | null; // ISO
  updated: string | null; // ISO
  distanceMi: number;
}

export interface HazardQuake {
  id: string;
  mag: number;
  place: string;
  time: string; // ISO
  lat: number;
  lon: number;
  distanceMi: number;
  alert: string | null; // USGS PAGER alert level (green/yellow/orange/red) when present
  url: string;
}

export interface NriHazard {
  name: string;
  rating: string;
  score: number | null;
}

export interface HazardsNri {
  scope: "tract" | "county";
  name: string;
  riskScore: number | null;
  riskRating: string | null;
  eal: number | null; // expected annual loss, USD per year
  hazards: NriHazard[];
}

export interface HazardsSvi {
  tract: string;
  overallPct: number | null; // 0-100, share of U.S. tracts less vulnerable
  themes: { name: string; pct: number | null }[];
}

export interface HazardsLive {
  fires: HazardFire[];
  perimeters?: FeatureCollection | null;
  quakes: HazardQuake[];
  nri: HazardsNri | null;
  /** County-level NRI for the same point (used for the wildfire cross-check). */
  nriCounty?: HazardsNri | null;
  svi: HazardsSvi | null;
  /** Plain-language sentences derived from the cross-reference (one per check). */
  summary?: string[];
  /** Last data edit of the NIFC incident layer (informational; it only moves when incidents change). */
  nifcUpdatedAt?: string | null;
}

/* ------------------------------------------------------------------ constants */

const WFIGS = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services";
export const NIFC_INCIDENTS_URL = `${WFIGS}/WFIGS_Incident_Locations_Current/FeatureServer/0/query`;
export const NIFC_PERIMETERS_URL = `${WFIGS}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query`;
export const USGS_FDSN_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query";
export const NRI_TRACTS_URL =
  "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0/query";
export const NRI_COUNTIES_URL =
  "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Counties/FeatureServer/0/query";
export const SVI_TRACTS_URL =
  "https://onemap.cdc.gov/OneMapServices/rest/services/SVI/CDC_ATSDR_Social_Vulnerability_Index_2022_USA/FeatureServer/2/query";

/** Smallest earthquake magnitude we list. */
export const QUAKE_MIN_MAG = 2.0;
export const QUAKE_DAYS = 7;
/** A fire this close to the scan center counts as "near" (banner + cross-check). */
export const NEAR_FIRE_MI = 25;

const TIMEOUT_MS = 8000;
const CACHE_MS = 120_000;
/** USGS feed must be generated within this window for "live" (also the client-side stale switch). */
const MAX_AGE_SEC = 30 * 60;
/** NIFC's layer only changes when incidents change, so it counts as stale only after this long. */
export const NIFC_MAX_AGE_SEC = 6 * 3600;
const REFRESH_SEC = 300;
const M_PER_MI = 1609.344;
const KM_PER_MI = 1.609344;

export const HAZARD_PROVIDERS: ProviderRef[] = [
  { id: "nifc", name: "NIFC WFIGS current wildfire incidents and perimeters", url: "https://data-nifc.opendata.arcgis.com/" },
  { id: "usgs", name: "USGS Earthquake Hazards Program", url: "https://earthquake.usgs.gov/earthquakes/map/" },
  { id: "fema-nri", name: "FEMA National Risk Index", url: "https://hazards.fema.gov/nri/" },
  { id: "cdc-svi", name: "CDC/ATSDR Social Vulnerability Index 2022", url: "https://www.atsdr.cdc.gov/place-health/php/svi/" },
];

/** NRI hazards most relevant to grid assets, in display order. Field prefix -> plain name. */
export const NRI_GRID_HAZARDS: { prefix: string; name: string }[] = [
  { prefix: "WFIR", name: "Wildfire" },
  { prefix: "HWAV", name: "Heat wave" },
  { prefix: "SWND", name: "Strong wind" },
  { prefix: "ISTM", name: "Ice storm" },
  { prefix: "WNTW", name: "Winter weather" },
  { prefix: "HRCN", name: "Hurricane" },
  { prefix: "ERQK", name: "Earthquake" },
  { prefix: "IFLD", name: "Riverine (inland) flooding" },
];

const SVI_THEMES: { field: string; name: string }[] = [
  { field: "RPL_THEME1", name: "Socioeconomic status" },
  { field: "RPL_THEME2", name: "Household characteristics" },
  { field: "RPL_THEME3", name: "Racial and ethnic minority status" },
  { field: "RPL_THEME4", name: "Housing type and transportation" },
];

/** NRI ratings that make an observed event unsurprising. */
const NRI_ELEVATED = new Set(["Relatively Moderate", "Relatively High", "Very High"]);

/** Rank for comparing NRI ratings; unrated values (No Rating, Not Applicable, Insufficient Data) are 0. */
const NRI_RANK: Record<string, number> = {
  "Very Low": 1,
  "Relatively Low": 2,
  "Relatively Moderate": 3,
  "Relatively High": 4,
  "Very High": 5,
};
export function nriRank(rating: string): number {
  return NRI_RANK[rating] ?? 0;
}

/* ------------------------------------------------------------------ helpers */

type Attrs = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function isoFromMs(v: unknown): string | null {
  const n = num(v);
  return n == null || n <= 0 ? null : new Date(n).toISOString();
}

function r1(x: number): number {
  return Math.round(x * 10) / 10;
}

/* ------------------------------------------------------------------ parsers */

interface ArcgisPointFeature {
  attributes?: Attrs;
  geometry?: { x?: number; y?: number };
}

/**
 * WFIGS incident query (f=json, outSR=4326) -> fires within rMi of the center, nearest first.
 * Prescribed burns (IncidentTypeCategory "RX") are dropped: this is a wildfire list.
 */
export function parseFires(json: unknown, lat: number, lon: number, rMi: number): HazardFire[] {
  const features = (json as { features?: ArcgisPointFeature[] })?.features;
  if (!Array.isArray(features)) return [];
  const out: HazardFire[] = [];
  for (const f of features) {
    const a = f.attributes ?? {};
    const x = num(f.geometry?.x);
    const y = num(f.geometry?.y);
    if (x == null || y == null) continue;
    if (str(a.IncidentTypeCategory) === "RX") continue;
    const d = haversineMi(lat, lon, y, x);
    if (d > rMi) continue;
    out.push({
      id: str(a.UniqueFireIdentifier) ?? str(a.IrwinID) ?? String(a.OBJECTID ?? `${y},${x}`),
      name: str(a.IncidentName) ?? "Unnamed fire",
      lat: y,
      lon: x,
      acres: num(a.IncidentSize),
      containedPct: num(a.PercentContained),
      discovered: isoFromMs(a.FireDiscoveryDateTime),
      updated: isoFromMs(a.ModifiedOnDateTime_dt),
      distanceMi: r1(d),
    });
  }
  return out.sort((p, q) => p.distanceMi - q.distanceMi);
}

/** WFIGS perimeter query (f=geojson) -> FeatureCollection with small, plain properties; RX dropped. */
export function parsePerimeters(json: unknown): FeatureCollection | null {
  const fc = json as { type?: string; features?: { geometry?: Geometry | null; properties?: Attrs | null }[] };
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) return null;
  const features: FeatureCollection["features"] = [];
  for (const f of fc.features) {
    const p = f.properties ?? {};
    if (!f.geometry) continue;
    if (str(p.attr_IncidentTypeCategory) === "RX") continue;
    features.push({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        id: str(p.attr_UniqueFireIdentifier),
        name: str(p.poly_IncidentName) ?? "Unnamed fire",
        acres: num(p.attr_IncidentSize) ?? num(p.poly_GISAcres),
        containedPct: num(p.attr_PercentContained),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

interface UsgsFeature {
  id?: string;
  properties?: Attrs;
  geometry?: { coordinates?: number[] };
}

/** USGS GeoJSON (summary feed or FDSN query) -> quakes within rMi and the last `days`, newest first. */
export function parseQuakes(
  json: unknown,
  lat: number,
  lon: number,
  rMi: number,
  nowMs: number = Date.now(),
  days: number = QUAKE_DAYS,
  minMag: number = QUAKE_MIN_MAG,
): HazardQuake[] {
  const features = (json as { features?: UsgsFeature[] })?.features;
  if (!Array.isArray(features)) return [];
  const since = nowMs - days * 86_400_000;
  const out: HazardQuake[] = [];
  for (const f of features) {
    const p = f.properties ?? {};
    const c = f.geometry?.coordinates;
    const qLon = num(c?.[0]);
    const qLat = num(c?.[1]);
    const mag = num(p.mag);
    const t = num(p.time);
    if (qLon == null || qLat == null || mag == null || t == null) continue;
    if (t < since || mag < minMag) continue;
    const d = haversineMi(lat, lon, qLat, qLon);
    if (d > rMi) continue;
    out.push({
      id: str(f.id) ?? `${t}`,
      mag: Math.round(mag * 100) / 100,
      place: str(p.place) ?? "Unknown location",
      time: new Date(t).toISOString(),
      lat: qLat,
      lon: qLon,
      distanceMi: r1(d),
      alert: str(p.alert),
      url: str(p.url) ?? "https://earthquake.usgs.gov/earthquakes/map/",
    });
  }
  return out.sort((p, q) => Date.parse(q.time) - Date.parse(p.time));
}

/** NRI tract/county point query (f=json) -> summary, or null when no polygon contains the point. */
export function parseNri(json: unknown, scope: "tract" | "county"): HazardsNri | null {
  const a = (json as { features?: { attributes?: Attrs }[] })?.features?.[0]?.attributes;
  if (!a) return null;
  const county = str(a.COUNTY);
  const countyType = str(a.COUNTYTYPE) ?? "County";
  const state = str(a.STATE);
  const countyName = [county ? `${county} ${countyType}` : null, state].filter(Boolean).join(", ");
  const tract = str(a.TRACT);
  const name =
    scope === "tract" ? [tract ? `Census tract ${tract}` : str(a.NRI_ID), countyName].filter(Boolean).join(", ") : countyName;
  return {
    scope,
    name: name || (str(a.NRI_ID) ?? "Unknown area"),
    riskScore: num(a.RISK_SCORE),
    riskRating: str(a.RISK_RATNG),
    eal: num(a.EAL_VALT),
    hazards: NRI_GRID_HAZARDS.map((h) => ({
      name: h.name,
      rating: str(a[`${h.prefix}_RISKR`]) ?? "No Rating",
      score: num(a[`${h.prefix}_RISKS`]),
    })),
  };
}

/** SVI percentiles are 0-1 with -999 for "no data". */
function sviPct(v: unknown): number | null {
  const n = num(v);
  if (n == null || n < 0 || n > 1) return null;
  return Math.round(n * 1000) / 10;
}

/** SVI tract point query (f=json) -> overall + theme percentiles (0-100). */
export function parseSvi(json: unknown): HazardsSvi | null {
  const a = (json as { features?: { attributes?: Attrs }[] })?.features?.[0]?.attributes;
  if (!a) return null;
  const loc = str(a.LOCATION);
  return {
    tract: loc ? loc.split(";").map((s) => s.trim()).join(", ") : (str(a.FIPS) ?? "Unknown tract"),
    overallPct: sviPct(a.RPL_THEMES),
    themes: SVI_THEMES.map((t) => ({ name: t.name, pct: sviPct(a[t.field]) })),
  };
}

/* ------------------------------------------------------------------ cross-reference */

function nriHazard(nri: HazardsNri, name: string): NriHazard | undefined {
  return nri.hazards.find((h) => h.name === name);
}

/**
 * Consistency notes between live events and FEMA's long-term risk ratings. These are not
 * numeric agreement: a = live event count, b = NRI hazard score (0-100 national percentile).
 * agree=false only when a live event looks surprising for the rating.
 */
export function crossReference(
  fires: HazardFire[] | null,
  quakes: HazardQuake[] | null,
  nri: HazardsNri | null,
  rMi: number,
  nriCounty: HazardsNri | null = null,
): { checks: CrossCheck[]; summary: string[] } {
  const checks: CrossCheck[] = [];
  const summary: string[] = [];
  if (!nri && !nriCounty) return { checks, summary };

  const wfCheck = wildfireCheck(fires, nri, nriCounty, rMi);
  if (wfCheck) {
    checks.push(wfCheck);
    summary.push(wfCheck.note ?? "");
  }

  const eq = nri ? nriHazard(nri, "Earthquake") : undefined;
  if (nri && quakes && eq) {
    const where = nri.scope === "tract" ? "this census tract" : "this county";
    const score = eq.score ?? 0;
    const elevated = NRI_ELEVATED.has(eq.rating);
    const maxMag = quakes.reduce((m, q) => Math.max(m, q.mag), 0);
    // Small quakes happen almost everywhere; only a felt-size quake (M4+) is surprising under a low rating.
    const agree = !(maxMag >= 4 && !elevated);
    let note: string;
    if (quakes.length === 0) {
      note = `No M${QUAKE_MIN_MAG}+ earthquakes within ${fmtMi(rMi)} in ${QUAKE_DAYS} days. ${femaSays(where, "earthquake", eq.rating)} No conflict: a quiet week says little about long-term risk.`;
    } else {
      const head = `${quakes.length} M${QUAKE_MIN_MAG}+ earthquake${quakes.length === 1 ? "" : "s"} within ${fmtMi(rMi)} in ${QUAKE_DAYS} days (largest M${maxMag.toFixed(1)}); ${femaSays(where, "earthquake", eq.rating)}`;
      note = agree
        ? `${head} ${elevated ? "That fits an active area." : "No conflict: small quakes are common even where risk is low."}`
        : `${head} An M4+ quake is unusual at that rating.`;
    }
    checks.push({
      quantity: `M${QUAKE_MIN_MAG}+ earthquakes within ${fmtMi(rMi)} (${QUAKE_DAYS} days) vs FEMA earthquake risk`,
      a: { provider: "USGS", value: quakes.length, unit: "earthquakes" },
      b: { provider: "FEMA NRI", value: r1(score), unit: "earthquake risk score (0-100)" },
      diff: r1(quakes.length - score),
      diffPct: null,
      tolerance: "qualitative: an M4+ quake is expected only where FEMA rates earthquake risk Relatively Moderate or higher",
      agree,
      note,
    });
    summary.push(note);
  }
  return { checks, summary };
}

/**
 * Fires within 25 mi vs the HIGHER of the tract and county NRI wildfire ratings.
 * agree=false (a consistency note, not an error) when:
 *  - fires are within 25 mi but both ratings are Very Low or unrated, or
 *  - no fire is within 25 mi while the county is rated Very High.
 */
function wildfireCheck(
  fires: HazardFire[] | null,
  nri: HazardsNri | null,
  nriCounty: HazardsNri | null,
  rMi: number,
): CrossCheck | null {
  if (!fires) return null;
  const tract = nri?.scope === "tract" ? nriHazard(nri, "Wildfire") : undefined;
  const county = nriCounty
    ? nriHazard(nriCounty, "Wildfire")
    : nri?.scope === "county"
      ? nriHazard(nri, "Wildfire")
      : undefined;
  if (!tract && !county) return null;

  // Higher rating wins; on a tie prefer the county (wider area, closer to a 25 mi circle).
  const useCounty = !!county && (!tract || nriRank(county.rating) >= nriRank(tract.rating));
  const used = (useCounty ? county : tract) as NriHazard;
  const usedLabel = useCounty ? "county" : "tract";
  const ratingText = (h: NriHazard | undefined) => (h ? (nriRank(h.rating) > 0 ? h.rating : "unrated") : "not available");
  const ratings = `county rating ${ratingText(county)}; tract ${ratingText(tract)}`;
  const which = `FEMA wildfire risk uses the higher ${usedLabel} rating (${ratings})`;

  const nearMi = Math.min(NEAR_FIRE_MI, rMi);
  const near = fires.filter((f) => f.distanceMi <= nearMi);
  const bothLow = nriRank(tract?.rating ?? "") <= 1 && nriRank(county?.rating ?? "") <= 1;
  const countyVeryHigh = county?.rating === "Very High";

  let agree = true;
  let note: string;
  if (near.length > 0) {
    const n = near[0];
    const head = `Active fire ${fmtMi(n.distanceMi)} away (${n.name}); ${which}.`;
    if (bothLow) {
      agree = false;
      note = `${head} A fire this close is less expected where both tract and county are rated Very Low or unrated.`;
    } else {
      note = `${head} A nearby fire fits that rating.`;
    }
  } else {
    const nearest = fires.length > 0 ? ` (nearest ${fmtMi(fires[0].distanceMi)} away)` : "";
    const head = `No active fire within ${fmtMi(nearMi)}${nearest}; ${which}.`;
    if (countyVeryHigh) {
      agree = false;
      note = `${head} Quiet for now in a county FEMA rates among the most wildfire-exposed; the rating is long-term risk, not a forecast.`;
    } else {
      note = `${head} No conflict: the rating is long-term risk, not a forecast.`;
    }
  }

  const score = used.score ?? 0;
  return {
    quantity: `Active wildfires within ${fmtMi(nearMi)} vs FEMA wildfire risk (higher of tract and county)`,
    a: { provider: "NIFC", value: near.length, unit: "fires" },
    b: { provider: `FEMA NRI (${usedLabel})`, value: r1(score), unit: "wildfire risk score (0-100)" },
    diff: r1(near.length - score),
    diffPct: null,
    tolerance:
      "qualitative: consistent unless fires are within 25 mi while tract and county are both Very Low or unrated, or no fire is near while the county is Very High",
    agree,
    note,
  };
}

/** "FEMA rates this census tract's wildfire risk Very Low." / "FEMA gives this census tract no wildfire rating." */
function femaSays(where: string, hazard: string, rating: string): string {
  return rating === "No Rating" || rating === "Not Applicable" || rating === "Insufficient Data"
    ? `FEMA gives ${where} no ${hazard} rating.`
    : `FEMA rates ${where}'s ${hazard} risk ${rating}.`;
}

function fmtMi(mi: number): string {
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

/* ------------------------------------------------------------------ status */

/**
 * live: NIFC and USGS both fetched, USGS feed generated within maxAgeSec (30 min), and NIFC's
 *       layer changed within NIFC_MAX_AGE_SEC (6 h; it only changes when incidents do, so an
 *       unknown NIFC edit time does not by itself make the feed stale).
 * stale: something usable but older than that, or one of NIFC/USGS missing.
 * error: nothing fetched.
 * sourceUpdatedAt is the NEWEST of the two stamps.
 */
export function deriveStatus(
  ok: { nifc: boolean; usgs: boolean; nri: boolean; svi: boolean },
  nifcUpdatedMs: number | null,
  usgsGeneratedMs: number | null,
  nowMs: number,
  maxAgeSec: number = MAX_AGE_SEC,
  nifcMaxAgeSec: number = NIFC_MAX_AGE_SEC,
): { status: FeedStatus; sourceUpdatedAt: string | null } {
  const stamps = [ok.nifc ? nifcUpdatedMs : null, ok.usgs ? usgsGeneratedMs : null].filter(
    (x): x is number => x != null,
  );
  const newest = stamps.length ? Math.max(...stamps) : null;
  const sourceUpdatedAt = newest != null ? new Date(newest).toISOString() : null;
  if (!ok.nifc && !ok.usgs && !ok.nri && !ok.svi) return { status: "error", sourceUpdatedAt };
  const usgsFresh = usgsGeneratedMs != null && (nowMs - usgsGeneratedMs) / 1000 <= maxAgeSec;
  const nifcFresh = nifcUpdatedMs == null || (nowMs - nifcUpdatedMs) / 1000 <= nifcMaxAgeSec;
  if (ok.nifc && ok.usgs && usgsFresh && nifcFresh) return { status: "live", sourceUpdatedAt };
  return { status: "stale", sourceUpdatedAt };
}

/* ------------------------------------------------------------------ fetching */

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: "application/json, application/geo+json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { error?: { message?: string } };
  // ArcGIS reports query errors with HTTP 200 and an error object.
  if (json && typeof json === "object" && json.error) throw new Error(json.error.message ?? "service error");
  return json;
}

function qs(params: Record<string, string | number>): string {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
}

function pointQuery(lat: number, lon: number, distanceM?: number): Record<string, string | number> {
  const base: Record<string, string | number> = {
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: 4326,
    outSR: 4326,
    spatialRel: "esriSpatialRelIntersects",
  };
  if (distanceM != null) {
    base.distance = Math.round(distanceM);
    base.units = "esriSRUnit_Meter";
  }
  return base;
}

function why(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return "timed out after 8 s";
    return e.message;
  }
  return "request failed";
}

async function fetchFires(lat: number, lon: number, rMi: number) {
  const url = `${NIFC_INCIDENTS_URL}?${qs({
    where: "1=1",
    ...pointQuery(lat, lon, rMi * M_PER_MI),
    outFields:
      "OBJECTID,UniqueFireIdentifier,IrwinID,IncidentName,IncidentSize,PercentContained,FireDiscoveryDateTime,ModifiedOnDateTime_dt,IncidentTypeCategory",
    returnGeometry: "true",
    resultRecordCount: 500,
    f: "json",
  })}`;
  return parseFires(await getJson(url), lat, lon, rMi);
}

let nifcStamp: { at: number; value: number | null } | null = null;

/**
 * Last data edit of the WFIGS current incident layer (layer metadata editingInfo.dataLastEditDate),
 * i.e. the feed's own update time. Same for every point, so cached on its own.
 */
async function fetchNifcUpdated(): Promise<number | null> {
  if (nifcStamp && Date.now() - nifcStamp.at < CACHE_MS) return nifcStamp.value;
  const json = (await getJson(`${NIFC_INCIDENTS_URL.replace(/\/query$/, "")}?f=json`)) as {
    editingInfo?: { dataLastEditDate?: unknown; lastEditDate?: unknown };
  };
  const value = num(json.editingInfo?.dataLastEditDate) ?? num(json.editingInfo?.lastEditDate);
  nifcStamp = { at: Date.now(), value };
  return value;
}

async function fetchPerimeters(lat: number, lon: number, rMi: number) {
  const url = `${NIFC_PERIMETERS_URL}?${qs({
    where: "1=1",
    ...pointQuery(lat, lon, rMi * M_PER_MI),
    outFields: "poly_IncidentName,poly_GISAcres,attr_IncidentSize,attr_PercentContained,attr_IncidentTypeCategory,attr_UniqueFireIdentifier",
    maxAllowableOffset: 0.002, // degrees (~200 m): simplified for display
    geometryPrecision: 4,
    resultRecordCount: 50,
    f: "geojson",
  })}`;
  return parsePerimeters(await getJson(url));
}

async function fetchQuakes(lat: number, lon: number, rMi: number, nowMs: number) {
  const start = new Date(nowMs - QUAKE_DAYS * 86_400_000).toISOString().slice(0, 19);
  const url = `${USGS_FDSN_URL}?${qs({
    format: "geojson",
    starttime: start,
    latitude: lat,
    longitude: lon,
    maxradiuskm: Math.round(rMi * KM_PER_MI * 10) / 10,
    minmagnitude: QUAKE_MIN_MAG,
    orderby: "time",
    limit: 500,
  })}`;
  const json = (await getJson(url)) as { metadata?: { generated?: unknown } };
  return { quakes: parseQuakes(json, lat, lon, rMi, nowMs), generated: num(json.metadata?.generated) };
}

const NRI_FIELDS = [
  "NRI_ID",
  "STATE",
  "COUNTY",
  "COUNTYTYPE",
  "TRACT",
  "RISK_SCORE",
  "RISK_RATNG",
  "EAL_VALT",
  ...NRI_GRID_HAZARDS.flatMap((h) => [`${h.prefix}_RISKS`, `${h.prefix}_RISKR`]),
];

/** Tract and county NRI for the point, queried in parallel. Throws only if both queries fail. */
async function fetchNri(lat: number, lon: number): Promise<{ tract: HazardsNri | null; county: HazardsNri | null; note: string | null }> {
  const common = { ...pointQuery(lat, lon), returnGeometry: "false", f: "json" };
  const countyFields = NRI_FIELDS.filter((f) => f !== "TRACT").join(",");
  const [t, c] = await Promise.allSettled([
    getJson(`${NRI_TRACTS_URL}?${qs({ ...common, outFields: NRI_FIELDS.join(",") })}`).then((j) => parseNri(j, "tract")),
    getJson(`${NRI_COUNTIES_URL}?${qs({ ...common, outFields: countyFields })}`).then((j) => parseNri(j, "county")),
  ]);
  if (t.status === "rejected" && c.status === "rejected") throw t.reason;
  const note =
    t.status === "rejected"
      ? `FEMA NRI tract layer unavailable (${why(t.reason)}); using county.`
      : c.status === "rejected"
        ? `FEMA NRI county layer unavailable (${why(c.reason)}); wildfire check uses the tract only.`
        : null;
  return {
    tract: t.status === "fulfilled" ? t.value : null,
    county: c.status === "fulfilled" ? c.value : null,
    note,
  };
}

async function fetchSvi(lat: number, lon: number): Promise<HazardsSvi | null> {
  const url = `${SVI_TRACTS_URL}?${qs({
    ...pointQuery(lat, lon),
    outFields: ["FIPS", "LOCATION", "RPL_THEMES", ...SVI_THEMES.map((t) => t.field)].join(","),
    returnGeometry: "false",
    f: "json",
  })}`;
  return parseSvi(await getJson(url));
}

/* ------------------------------------------------------------------ build */

const cache = new Map<string, { at: number; feed: LiveFeed<HazardsLive> }>();

export async function buildHazardsFeed(lat: number, lon: number, rMi: number): Promise<LiveFeed<HazardsLive>> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${Math.round(rMi * 10) / 10}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.feed;

  const nowMs = Date.now();
  const errors: string[] = [];
  const [firesR, nifcTimeR, perimR, quakesR, nriR, sviR] = await Promise.allSettled([
    fetchFires(lat, lon, rMi),
    fetchNifcUpdated(),
    fetchPerimeters(lat, lon, rMi),
    fetchQuakes(lat, lon, rMi, nowMs),
    fetchNri(lat, lon),
    fetchSvi(lat, lon),
  ]);

  const fires = firesR.status === "fulfilled" ? firesR.value : null;
  if (firesR.status === "rejected") errors.push(`NIFC wildfire incidents unavailable (${why(firesR.reason)}).`);
  const nifcUpdated = nifcTimeR.status === "fulfilled" ? nifcTimeR.value : null;
  if (nifcTimeR.status === "rejected") errors.push(`NIFC feed update time unavailable (${why(nifcTimeR.reason)}).`);
  const perimeters = perimR.status === "fulfilled" ? perimR.value : null;
  if (perimR.status === "rejected") errors.push(`NIFC fire perimeters unavailable (${why(perimR.reason)}).`);
  const quakes = quakesR.status === "fulfilled" ? quakesR.value.quakes : null;
  const usgsGenerated = quakesR.status === "fulfilled" ? quakesR.value.generated : null;
  if (quakesR.status === "rejected") errors.push(`USGS earthquakes unavailable (${why(quakesR.reason)}).`);
  const nriTract = nriR.status === "fulfilled" ? nriR.value.tract : null;
  const nriCounty = nriR.status === "fulfilled" ? nriR.value.county : null;
  const nri = nriTract ?? nriCounty;
  if (nriR.status === "rejected") errors.push(`FEMA National Risk Index unavailable (${why(nriR.reason)}).`);
  else if (nriR.value.note) errors.push(nriR.value.note);
  if (nriR.status === "fulfilled" && !nri) errors.push("FEMA National Risk Index has no tract or county at this point.");
  const svi = sviR.status === "fulfilled" ? sviR.value : null;
  if (sviR.status === "rejected") errors.push(`CDC Social Vulnerability Index unavailable (${why(sviR.reason)}).`);
  else if (!svi) errors.push("CDC Social Vulnerability Index has no tract at this point.");

  const { status, sourceUpdatedAt } = deriveStatus(
    { nifc: fires != null, usgs: quakes != null, nri: nri != null, svi: svi != null },
    nifcUpdated,
    usgsGenerated,
    nowMs,
  );
  const { checks, summary } = crossReference(fires, quakes, nri, rMi, nriCounty);

  const feed: LiveFeed<HazardsLive> = {
    feed: "hazards",
    status,
    fetchedAt: new Date(nowMs).toISOString(),
    sourceUpdatedAt,
    maxAgeSec: MAX_AGE_SEC,
    refreshSec: REFRESH_SEC,
    providers: HAZARD_PROVIDERS,
    crossChecks: checks,
    errors,
    data:
      status === "error"
        ? null
        : {
            fires: fires ?? [],
            perimeters,
            quakes: quakes ?? [],
            nri,
            nriCounty,
            svi,
            summary,
            nifcUpdatedAt: nifcUpdated != null ? new Date(nifcUpdated).toISOString() : null,
          },
  };

  // Do not pin a total failure for the full cache window.
  if (status !== "error") {
    if (cache.size > 200) cache.clear();
    cache.set(key, { at: nowMs, feed });
  }
  return feed;
}
