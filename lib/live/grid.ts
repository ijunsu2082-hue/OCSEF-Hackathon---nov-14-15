/**
 * LIVE GRID feed (server-side only). Real-time balancing-authority (BA) operations for a U.S. point:
 *  1. discoverBA: which BA is this point in? HIFLD "Control Areas" polygons (ArcGIS Online mirror,
 *     no key); smallest containing polygon wins (e.g. Seattle City Light inside BPA). Fallback: majority
 *     BA code of the nearest EIA-860 plants in our bundled plants layer (Southern California only).
 *  2. fetchEia: EIA API v2 hourly region-data (D, DF, NG, TI) and fuel-type-data for the last ~48 h.
 *     EIA hourly "period" is the UTC hour ENDING at that time (checked against CAISO's own day-ahead
 *     forecast, which EIA republishes: CAISO HE01 PT == EIA period T09 UTC in winter).
 *  3. fetchCaiso: CAISO Today's Outlook 5-minute CSVs (demand, fuel source), only when BA = CISO.
 *  4. Cross-checks between the providers, and an energy-balance sanity check inside EIA.
 */
import type { CrossCheck, FeedStatus, LiveFeed, ProviderRef } from "./types";

/* ------------------------------------------------------------------ types */

export interface GridFuel {
  fuel: string; // plain name, e.g. "Solar"
  mw: number;
  pct: number; // share of positive in-area generation, 0-100
}

export interface GridLive {
  ba: { code: string; name: string; method: string };
  latest: {
    period: string | null; // ISO, end of the latest EIA demand hour (UTC)
    demandMW: number | null;
    forecastMW: number | null;
    netGenMW: number | null; // same hour as demand; null when EIA has not posted it yet
    interchangeMW: number | null; // EIA total interchange, positive = net export
  };
  fuelMix: GridFuel[];
  /** ISO end of the hour the EIA fuel mix (and cleanSharePct) is for; it often lags demand by many hours. */
  fuelMixPeriod: string | null;
  cleanSharePct: number | null;
  series: { period: string; demandMW: number | null; forecastMW: number | null }[];
  caiso?: {
    asOf: string; // ISO time of the latest 5-minute reading
    demandMW: number | null;
    fuelMix: GridFuel[]; // in-area generation, imports excluded (comparable to EIA)
    importsMW: number | null;
  };
}

/* ------------------------------------------------------------------ constants */

export const EIA_REFRESH_SEC = 300;
export const CAISO_REFRESH_SEC = 120;
export const EIA_MAX_AGE_SEC = 3 * 3600;
export const CAISO_MAX_AGE_SEC = 15 * 60;
const CACHE_MS = 60_000;
const DISCOVERY_CACHE_MS = 24 * 3600_000;
// Netlify functions stop at ~10 s, so each upstream call must give up well before that.
const TIMEOUT_MS = 7_000;
// EIA updates hourly. DEMO_KEY allows ~10 calls an hour, so hold EIA results longer without a real key.
const EIA_CACHE_MS = process.env.EIA_API_KEY ? 5 * 60_000 : 15 * 60_000;
const UA = "GridSentinel (hackathon demo)";

export const DEMAND_TOL_PCT = 3;
export const SHARE_TOL_PTS = 5;
export const FORECAST_TOL_PCT = 5;
export const BALANCE_TOL_PCT = 5;

const EIA_BASE = "https://api.eia.gov/v2/electricity/rto";
const CAISO_BASE = "https://www.caiso.com/outlook";
export const CONTROL_AREAS_URL =
  "https://services5.arcgis.com/HDRa0B57OVrv2E1q/arcgis/rest/services/Control_Areas/FeatureServer/0";

const PROVIDERS: Record<"hifld" | "eia" | "caiso" | "eia860", ProviderRef> = {
  hifld: {
    id: "hifld",
    name: "HIFLD Control Areas (ArcGIS Online mirror)",
    url: "https://www.arcgis.com/home/item.html?id=7ccbdeab387949c1a1fabc83e1e474f6",
  },
  eia: { id: "eia", name: "U.S. EIA Hourly Electric Grid Monitor (EIA-930)", url: "https://www.eia.gov/electricity/gridmonitor/" },
  caiso: { id: "caiso", name: "CAISO Today's Outlook", url: "https://www.caiso.com/todays-outlook" },
  eia860: { id: "eia860", name: "EIA-860 plant balancing authority codes", url: "https://www.eia.gov/electricity/data/eia860/" },
};

/**
 * HIFLD Control Areas `ID` (EIA utility ID of the BA operator) -> EIA-930 respondent code.
 * Built by matching all 71 HIFLD polygons to the EIA region-data respondent list. null = no EIA-930
 * respondent (Alaska, Hawaii, Canada, or BAs that no longer report).
 */
export const HIFLD_TO_EIA: Record<string, string | null> = {
  "317": "YAD", "599": null, "803": "AZPS", "56812": "DEAA", "924": "AECI", "20169": "AVA", "16534": "BANC",
  "1738": "BPAT", "2775": "CISO", "3522": null, "8795": "HST", "18429": "TPWR", "18445": "TAL", "5416": "DUK",
  "6455": "FPC", "3046": "CPLE", "58786": "CPLW", "5701": "EPE", "5748": "EEI", "5723": "ERCO", "14610": "FMPP",
  "6452": "FPL", "6909": "GVL", "14412": null, "58790": "GRID", "56545": null, "56090": "GRIF", "19547": null,
  "9191": "IPCO", "9216": "IID", "13434": "ISNE", "9617": "JEA", "11208": "LDWP", "11249": "LGEE", "56669": "MISO",
  "56365": "GWA", "58791": "WWA", "13407": "NEVP", "1": null, "55372": "HGMA", "13485": "NSB", "13501": "NYIS",
  "12825": "NWMT", "14015": null, "14379": "PACE", "14378": "PACW", "14725": "PJM", "15248": "PGE", "189": "AEC",
  "15466": "PSCO", "15473": "PNM", "3413": "CHPD", "14624": "GCPD", "5326": "DOPD", "15500": "PSEI", "16572": "SRP",
  "16868": "SCL", "21554": "SEC", "17539": "SCEG", "17543": "SC", "29304": "SEPA", "18195": "SOCO", "59504": "SWPP",
  "17716": "SPA", "18454": "TEC", "18642": "TVA", "24211": "TEPC", "19281": "TIDC", "25471": "WALC", "28503": "WACM",
  "19610": "WAUW",
};

/** EIA fuel-type codes -> plain names. */
export const EIA_FUEL_NAMES: Record<string, string> = {
  SUN: "Solar", WND: "Wind", WAT: "Hydro", NUC: "Nuclear", NG: "Natural gas", COL: "Coal", OIL: "Oil",
  GEO: "Geothermal", BAT: "Battery", PS: "Pumped storage", SNB: "Solar + battery", WNB: "Wind + battery",
  OES: "Other storage", UES: "Unknown storage", OTH: "Other", UNK: "Unknown",
};

/** Counted as clean in "clean share now": solar, wind, hydro, nuclear, battery discharge (per spec). */
const CLEAN_FUELS = new Set(["Solar", "Wind", "Hydro", "Nuclear", "Battery", "Solar + battery", "Wind + battery"]);
const SOLAR_WIND = new Set(["Solar", "Wind", "Solar + battery", "Wind + battery"]);

/** CAISO fuelsource.csv columns -> the same plain names (Small + Large hydro both map to Hydro). */
const CAISO_FUEL_NAMES: Record<string, string> = {
  Solar: "Solar", Wind: "Wind", Geothermal: "Geothermal", Biomass: "Biomass", Biogas: "Biogas",
  "Small hydro": "Hydro", "Large Hydro": "Hydro", Coal: "Coal", Nuclear: "Nuclear", "Natural Gas": "Natural gas",
  Batteries: "Battery", Other: "Other",
};

/* ------------------------------------------------------------------ small helpers */

const r1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** EIA "2026-11-15T00" -> "2026-11-15T00:00:00.000Z" (end of that UTC hour). */
export function eiaPeriodToIso(p: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(p);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4])).toISOString();
}

/** UTC ms -> EIA "YYYY-MM-DDTHH". */
export function toEiaPeriod(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

function tzOffsetMin(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - utcMs) / 60000;
}

/** Wall-clock time in America/Los_Angeles -> UTC ms (DST-aware). */
export function pacificToUtcMs(y: number, mo: number, d: number, hh: number, mm: number): number {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const off = tzOffsetMin(guess, "America/Los_Angeles");
  let t = guess - off * 60000;
  const off2 = tzOffsetMin(t, "America/Los_Angeles");
  if (off2 !== off) t = guess - off2 * 60000;
  return t;
}

/** Calendar date (y, m, d) in Pacific time for a UTC instant. */
export function pacificDate(utcMs: number): { y: number; m: number; d: number } {
  const t = utcMs + tzOffsetMin(utcMs, "America/Los_Angeles") * 60000;
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

const ymd = (x: { y: number; m: number; d: number }) =>
  `${x.y}${String(x.m).padStart(2, "0")}${String(x.d).padStart(2, "0")}`;

function shiftDate(x: { y: number; m: number; d: number }, days: number) {
  const t = new Date(Date.UTC(x.y, x.m - 1, x.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/* ------------------------------------------------------------------ BA discovery */

export interface ControlAreaHit {
  id: string;
  name: string;
  area: number; // polygon area, any unit; smaller = more specific
}

/** Pick the smallest containing control area that maps to an EIA-930 respondent. */
export function pickControlArea(hits: ControlAreaHit[]): { code: string; hit: ControlAreaHit } | null {
  const ok = hits
    .map((h) => ({ h, code: HIFLD_TO_EIA[h.id] ?? null }))
    .filter((x): x is { h: ControlAreaHit; code: string } => !!x.code)
    .sort((a, b) => a.h.area - b.h.area);
  return ok.length ? { code: ok[0].code, hit: ok[0].h } : null;
}

export function parseControlAreaQuery(j: unknown): ControlAreaHit[] {
  const feats = (j as { features?: { attributes?: Record<string, unknown> }[] })?.features;
  if (!Array.isArray(feats)) {
    const msg = (j as { error?: { message?: string } })?.error?.message;
    throw new Error(msg ? `control-area query failed: ${msg}` : "control-area query returned no features list");
  }
  return feats.map((f) => ({
    id: String(f.attributes?.ID ?? ""),
    name: String(f.attributes?.NAME ?? ""),
    area: num(f.attributes?.Shape__Area) ?? Infinity,
  }));
}

function haversineMi(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Majority BA code among the nearest `k` plants within `maxMi` miles. */
export function baFromPlants(
  plants: { lat: number; lon: number; ba: string }[],
  lat: number,
  lon: number,
  k = 7,
  maxMi = 40,
): { code: string; votes: number; of: number; nearestMi: number } | null {
  const near = plants
    .filter((p) => p.ba)
    .map((p) => ({ ...p, mi: haversineMi(lat, lon, p.lat, p.lon) }))
    .filter((p) => p.mi <= maxMi)
    .sort((a, b) => a.mi - b.mi)
    .slice(0, k);
  if (!near.length) return null;
  const votes = new Map<string, number>();
  for (const p of near) votes.set(p.ba, (votes.get(p.ba) ?? 0) + 1);
  const [code, n] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return { code, votes: n, of: near.length, nearestMi: r1(near[0].mi) };
}

async function getText(url: string, accept: string): Promise<{ status: number; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers: { "User-Agent": UA, Accept: accept } });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    throw new Error(ctrl.signal.aborted ? "timed out" : e instanceof Error ? e.message : "network error");
  } finally {
    clearTimeout(timer);
  }
}

export interface DiscoveredBA {
  code: string;
  name: string; // operator name from the polygon / fallback
  method: string; // plain words
  provider: ProviderRef;
}

const discoveryCache = new Map<string, { at: number; ba: DiscoveredBA }>();

/** Find the EIA-930 balancing authority for a point. Throws with a plain message when none is found. */
export async function discoverBA(lat: number, lon: number, opts: { origin?: string } = {}): Promise<DiscoveredBA> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = discoveryCache.get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_CACHE_MS) return hit.ba;

  const problems: string[] = [];
  try {
    const url =
      `${CONTROL_AREAS_URL}/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326` +
      "&spatialRel=esriSpatialRelIntersects&outFields=ID,NAME,Shape__Area&returnGeometry=false&f=json";
    const r = await getText(url, "application/json");
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const hits = parseControlAreaQuery(JSON.parse(r.text));
    const pick = pickControlArea(hits);
    if (pick) {
      const others = hits.filter((h) => h !== pick.hit).map((h) => h.name);
      const ba: DiscoveredBA = {
        code: pick.code,
        name: pick.hit.name,
        method:
          "HIFLD Control Areas polygon containing the point" +
          (others.length ? ` (smallest of ${hits.length} overlapping areas; also inside ${others.join("; ")})` : ""),
        provider: PROVIDERS.hifld,
      };
      discoveryCache.set(key, { at: Date.now(), ba });
      return ba;
    }
    problems.push(
      hits.length
        ? `the point is in ${hits.map((h) => h.name).join("; ")}, which does not report to EIA's hourly grid monitor`
        : "no HIFLD control-area polygon contains this point",
    );
  } catch (e) {
    problems.push(`HIFLD control-area lookup failed (${e instanceof Error ? e.message : "error"})`);
  }

  // Fallback: nearest EIA-860 plants in our bundled layer.
  if (opts.origin) {
    try {
      const r = await getText(`${opts.origin}/layers/plants.geojson`, "application/json");
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const fc = JSON.parse(r.text) as { features?: { geometry?: { coordinates?: number[] }; properties?: { balancing_authority?: string } }[] };
      const plants = (fc.features ?? [])
        .map((f) => ({ lon: num(f.geometry?.coordinates?.[0]), lat: num(f.geometry?.coordinates?.[1]), ba: f.properties?.balancing_authority ?? "" }))
        .filter((p): p is { lat: number; lon: number; ba: string } => p.lat != null && p.lon != null);
      const v = baFromPlants(plants, lat, lon);
      if (v) {
        const ba: DiscoveredBA = {
          code: v.code,
          name: v.code,
          method: `Nearest EIA-860 plants: ${v.votes} of the ${v.of} closest plants (nearest ${v.nearestMi} mi) report BA ${v.code}`,
          provider: PROVIDERS.eia860,
        };
        discoveryCache.set(key, { at: Date.now(), ba });
        return ba;
      }
      problems.push("no EIA-860 plants in our bundled layer within 40 mi");
    } catch (e) {
      problems.push(`plant-based fallback failed (${e instanceof Error ? e.message : "error"})`);
    }
  }
  throw new Error(`Could not find a U.S. Lower-48 balancing authority for this point: ${problems.join("; ")}.`);
}

/* ------------------------------------------------------------------ EIA */

export interface EiaHour {
  D: number | null;
  DF: number | null;
  NG: number | null;
  TI: number | null;
}

export interface EiaParsed {
  respondentName: string | null;
  hours: Map<string, EiaHour>; // key = EIA period "YYYY-MM-DDTHH"
}

type EiaRow = Record<string, unknown>;

function eiaRows(j: unknown, code: string, what: string): EiaRow[] {
  const err = (j as { error?: unknown })?.error;
  if (err) {
    const msg = typeof err === "string" ? err : (err as { message?: string; code?: string })?.message ?? (err as { code?: string })?.code;
    throw new Error(`EIA ${what}: ${msg ?? "error"}`);
  }
  const resp = (j as { response?: { data?: unknown; total?: unknown } })?.response;
  if (!resp || !Array.isArray(resp.data)) throw new Error(`EIA ${what}: unexpected response`);
  const rows = resp.data as EiaRow[];
  // Verify the facet filter actually applied (an unencoded facet silently returns every BA).
  const wrong = rows.find((r) => r.respondent !== code);
  if (wrong) throw new Error(`EIA ${what}: response not filtered to ${code} (got ${String(wrong.respondent)})`);
  const total = num(resp.total);
  if (total != null && total > 5000) throw new Error(`EIA ${what}: ${total} rows, expected a small filtered set`);
  return rows;
}

export function parseEiaRegion(j: unknown, code: string): EiaParsed {
  const rows = eiaRows(j, code, "region data");
  const hours = new Map<string, EiaHour>();
  let respondentName: string | null = null;
  for (const r of rows) {
    const p = String(r.period ?? "");
    const t = String(r.type ?? "");
    if (!eiaPeriodToIso(p) || !["D", "DF", "NG", "TI"].includes(t)) continue;
    if (!respondentName && typeof r["respondent-name"] === "string") respondentName = r["respondent-name"] as string;
    const h = hours.get(p) ?? { D: null, DF: null, NG: null, TI: null };
    h[t as keyof EiaHour] = num(r.value);
    hours.set(p, h);
  }
  return { respondentName, hours };
}

/** period -> { plain fuel name -> MW } (fuel names merged, e.g. two EIA codes for one fuel). */
export function parseEiaFuel(j: unknown, code: string): Map<string, Record<string, number>> {
  const rows = eiaRows(j, code, "fuel-type data");
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const p = String(r.period ?? "");
    const v = num(r.value);
    if (!eiaPeriodToIso(p) || v == null) continue;
    const name = EIA_FUEL_NAMES[String(r.fueltype)] ?? String(r["type-name"] ?? r.fueltype ?? "Other");
    const rec = out.get(p) ?? {};
    rec[name] = (rec[name] ?? 0) + v;
    out.set(p, rec);
  }
  return out;
}

/** Fuel MW map -> sorted mix; pct is of positive generation (negative = charging / station load, shown as 0 %). */
export function fuelMixFrom(rec: Record<string, number>): GridFuel[] {
  const total = Object.values(rec).reduce((s, v) => s + Math.max(0, v), 0);
  return Object.entries(rec)
    .map(([fuel, mw]) => ({ fuel, mw: Math.round(mw), pct: total > 0 ? r1((Math.max(0, mw) / total) * 100) : 0 }))
    .sort((a, b) => b.mw - a.mw);
}

function shareOf(mix: GridFuel[], set: Set<string>): number | null {
  const total = mix.reduce((s, f) => s + Math.max(0, f.mw), 0);
  if (!(total > 0)) return null;
  return r1((mix.filter((f) => set.has(f.fuel)).reduce((s, f) => s + Math.max(0, f.mw), 0) / total) * 100);
}
export const cleanShare = (mix: GridFuel[]) => shareOf(mix, CLEAN_FUELS);
export const solarWindShare = (mix: GridFuel[]) => shareOf(mix, SOLAR_WIND);

export function eiaUrl(kind: "region-data" | "fuel-type-data", code: string, startPeriod: string, apiKey: string): string {
  const q = new URLSearchParams();
  q.set("api_key", apiKey);
  q.set("frequency", "hourly");
  q.append("data[0]", "value");
  q.append("facets[respondent][]", code);
  if (kind === "region-data") for (const t of ["D", "DF", "NG", "TI"]) q.append("facets[type][]", t);
  q.set("start", startPeriod);
  q.append("sort[0][column]", "period");
  q.append("sort[0][direction]", "desc");
  q.set("offset", "0");
  q.set("length", "5000");
  return `${EIA_BASE}/${kind}/data/?${q.toString()}`;
}

export interface EiaResult {
  region: EiaParsed;
  fuel: Map<string, Record<string, number>>;
  fetchedAt: number;
  keyUsed: "EIA_API_KEY" | "DEMO_KEY";
  fuelError?: string; // fuel-type request failed; region data still usable
}

async function eiaGet(url: string, what: string): Promise<unknown> {
  const r = await getText(url, "application/json");
  if (r.status === 429) throw new Error(`EIA ${what}: rate limit reached (HTTP 429)`);
  let j: unknown;
  try {
    j = JSON.parse(r.text);
  } catch {
    throw new Error(`EIA ${what}: HTTP ${r.status}, not JSON`);
  }
  const ec = (j as { error?: { code?: string } })?.error?.code;
  if (ec === "OVER_RATE_LIMIT") throw new Error(`EIA ${what}: rate limit reached for this API key`);
  if (r.status !== 200) {
    const m = (j as { error?: { message?: string } | string })?.error;
    throw new Error(`EIA ${what}: HTTP ${r.status}${typeof m === "string" ? ` (${m})` : m?.message ? ` (${m.message})` : ""}`);
  }
  return j;
}

const eiaCache = new Map<string, { at: number; value: EiaResult }>();

/** EIA hourly operations for one BA, last ~50 h. Cached 5 min (15 min on DEMO_KEY); on failure returns the last good copy with `staleBecause`. */
export async function fetchEia(code: string, nowMs = Date.now()): Promise<EiaResult & { staleBecause?: string }> {
  const hit = eiaCache.get(code);
  if (hit && nowMs - hit.at < EIA_CACHE_MS) return hit.value;
  const envKey = process.env.EIA_API_KEY?.trim();
  const apiKey = envKey || "DEMO_KEY";
  const start = toEiaPeriod(nowMs - 50 * 3600_000);
  try {
    // Fuel-type data is optional: a slow or failed fuel request must not sink demand/forecast.
    const [rj, fr] = await Promise.all([
      eiaGet(eiaUrl("region-data", code, start, apiKey), "region data"),
      eiaGet(eiaUrl("fuel-type-data", code, start, apiKey), "fuel-type data").then(
        (j) => ({ fuel: parseEiaFuel(j, code), err: undefined as string | undefined }),
        (e: unknown) => ({ fuel: new Map<string, Record<string, number>>(), err: e instanceof Error ? e.message : "failed" }),
      ),
    ]);
    const value: EiaResult = {
      region: parseEiaRegion(rj, code),
      fuel: fr.fuel,
      fetchedAt: nowMs,
      keyUsed: envKey ? "EIA_API_KEY" : "DEMO_KEY",
      ...(fr.err ? { fuelError: fr.err.replace(apiKey, "***") } : {}),
    };
    eiaCache.set(code, { at: nowMs, value });
    return value;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : "EIA request failed").replace(apiKey, "***");
    if (hit) return { ...hit.value, staleBecause: msg };
    throw new Error(msg);
  }
}

/* ------------------------------------------------------------------ CAISO */

export interface CaisoRow {
  at: number; // UTC ms of the 5-minute timestamp
  values: Record<string, number | null>;
}

/**
 * Parse a CAISO Today's Outlook CSV ("Time,ColA,ColB..." with HH:MM Pacific times for one day).
 * A time that goes backwards (the trailing "00:00") rolls into the next day.
 */
export function parseCaisoCsv(text: string, day: { y: number; m: number; d: number }): CaisoRow[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  if (header[0] !== "Time") throw new Error("CAISO CSV: unexpected header");
  const rows: CaisoRow[] = [];
  let dayOffset = 0;
  let prevMin = -1;
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const m = /^(\d{1,2}):(\d{2})$/.exec(cells[0]?.trim() ?? "");
    if (!m) continue;
    const mins = +m[1] * 60 + +m[2];
    if (mins < prevMin) dayOffset += 1;
    prevMin = mins;
    const dd = shiftDate(day, dayOffset);
    const at = pacificToUtcMs(dd.y, dd.m, dd.d, +m[1], +m[2]);
    const values: Record<string, number | null> = {};
    header.slice(1).forEach((h, i) => (values[h] = num(cells[i + 1]?.trim())));
    rows.push({ at, values });
  }
  return rows;
}

/** Latest row with a value in `column`. */
export function latestWith(rows: CaisoRow[], column: string): CaisoRow | null {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].values[column] != null) return rows[i];
  return null;
}

/** Mean of `column` over readings in (hourEnd - 1 h, hourEnd]; null unless at least `minN` readings. */
export function hourAverage(rows: CaisoRow[], column: string, hourEndMs: number, minN = 10): number | null {
  const vals = rows
    .filter((r) => r.at > hourEndMs - 3600_000 && r.at <= hourEndMs)
    .map((r) => r.values[column])
    .filter((v): v is number => v != null);
  return vals.length >= minN ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

/** CAISO fuel row -> in-area mix (imports excluded) + imports MW. */
export function caisoMix(values: Record<string, number | null>): { mix: GridFuel[]; importsMW: number | null } {
  const rec: Record<string, number> = {};
  for (const [col, v] of Object.entries(values)) {
    const name = CAISO_FUEL_NAMES[col];
    if (!name || v == null) continue;
    rec[name] = (rec[name] ?? 0) + v;
  }
  return { mix: fuelMixFrom(rec), importsMW: values.Imports ?? null };
}

/** Hour-average CAISO fuel mix over (hourEnd - 1 h, hourEnd]. */
export function caisoHourMix(rows: CaisoRow[], hourEndMs: number): GridFuel[] | null {
  const inHour = rows.filter((r) => r.at > hourEndMs - 3600_000 && r.at <= hourEndMs && r.values.Solar != null);
  if (inHour.length < 10) return null;
  const avg: Record<string, number | null> = {};
  for (const col of Object.keys(CAISO_FUEL_NAMES)) {
    const vals = inHour.map((r) => r.values[col]).filter((v): v is number => v != null);
    avg[col] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  }
  return caisoMix(avg).mix;
}

export interface CaisoDay {
  day: { y: number; m: number; d: number };
  demand: CaisoRow[];
  fuel: CaisoRow[];
}

const caisoCache = new Map<string, { at: number; value: CaisoDay }>();

async function caisoCsv(path: string): Promise<string> {
  const r = await getText(`${CAISO_BASE}/${path}`, "text/csv");
  if (r.status !== 200) throw new Error(`CAISO ${path}: HTTP ${r.status}`);
  if (!r.text.startsWith("Time,")) throw new Error(`CAISO ${path}: not a CSV`);
  return r.text;
}

/** CAISO Today's Outlook, 5-minute demand and fuel source for today (Pacific), cached 60 s. */
export async function fetchCaiso(nowMs = Date.now()): Promise<CaisoDay> {
  const hit = caisoCache.get("current");
  if (hit && nowMs - hit.at < CACHE_MS) return hit.value;
  const [dText, fText] = await Promise.all([caisoCsv("current/demand.csv"), caisoCsv("current/fuelsource.csv")]);
  let day = pacificDate(nowMs);
  let demand = parseCaisoCsv(dText, day);
  // Just after midnight the "current" files can still hold yesterday: actuals would then sit in the future.
  const lastActual = latestWith(demand, "Current demand");
  if (lastActual && lastActual.at > nowMs + 30 * 60_000) {
    day = shiftDate(day, -1);
    demand = parseCaisoCsv(dText, day);
  }
  const value: CaisoDay = { day, demand, fuel: parseCaisoCsv(fText, day) };
  caisoCache.set("current", { at: nowMs, value });
  return value;
}

/** A past day from CAISO's Outlook history (same CSV format), cached 60 s. */
export async function fetchCaisoHistory(day: { y: number; m: number; d: number }, nowMs = Date.now()): Promise<CaisoDay> {
  const key = ymd(day);
  const hit = caisoCache.get(key);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.value;
  const [dText, fText] = await Promise.all([caisoCsv(`history/${key}/demand.csv`), caisoCsv(`history/${key}/fuelsource.csv`)]);
  const value: CaisoDay = { day, demand: parseCaisoCsv(dText, day), fuel: parseCaisoCsv(fText, day) };
  caisoCache.set(key, { at: nowMs, value });
  return value;
}

/* ------------------------------------------------------------------ cross-checks */

function pctCheck(
  quantity: string,
  a: CrossCheck["a"],
  b: CrossCheck["b"],
  tolPct: number,
  tolerance: string,
  note?: string,
): CrossCheck {
  const diff = a.value - b.value;
  const diffPct = b.value !== 0 ? (diff / Math.abs(b.value)) * 100 : null;
  return {
    quantity,
    a: { ...a, value: Math.round(a.value) },
    b: { ...b, value: Math.round(b.value) },
    diff: Math.round(diff),
    diffPct: diffPct == null ? null : r1(diffPct),
    tolerance,
    agree: diffPct != null && Math.abs(diffPct) <= tolPct,
    ...(note ? { note } : {}),
  };
}

/** CAISO hour-average demand vs EIA CISO demand for the same hour, within 3 %. */
export function demandCrossCheck(caisoAvgMW: number, eiaMW: number, hourLabel: string): CrossCheck {
  return pctCheck(
    "CISO demand, same hour",
    { provider: "CAISO", value: caisoAvgMW, unit: "MW" },
    { provider: "EIA", value: eiaMW, unit: "MW" },
    DEMAND_TOL_PCT,
    `within ${DEMAND_TOL_PCT}%`,
    `Hour ending ${hourLabel}. CAISO = mean of its 5-minute "Current demand" readings in that hour.`,
  );
}

/** CAISO vs EIA solar + wind share of in-area generation, same hour, within 5 percentage points. */
export function shareCrossCheck(caisoPct: number, eiaPct: number, hourLabel: string): CrossCheck {
  const diff = r1(caisoPct - eiaPct);
  return {
    quantity: "Solar + wind share of generation, same hour",
    a: { provider: "CAISO", value: r1(caisoPct), unit: "%" },
    b: { provider: "EIA", value: r1(eiaPct), unit: "%" },
    diff,
    diffPct: null,
    tolerance: `within ${SHARE_TOL_PTS} percentage points`,
    agree: Math.abs(diff) <= SHARE_TOL_PTS,
    note: `Hour ending ${hourLabel}. Share of in-area generation (imports and battery charging excluded) on both sides.`,
  };
}

/** EIA demand vs EIA day-ahead forecast (informational: the forecast error). */
export function forecastCrossCheck(demandMW: number, forecastMW: number, hourLabel: string): CrossCheck {
  const c = pctCheck(
    "Demand vs day-ahead forecast",
    { provider: "EIA demand", value: demandMW, unit: "MW" },
    { provider: "EIA day-ahead forecast", value: forecastMW, unit: "MW" },
    FORECAST_TOL_PCT,
    `within ${FORECAST_TOL_PCT}%`,
  );
  c.note = `Informational: forecast error ${c.diffPct == null ? "n/a" : `${c.diffPct > 0 ? "+" : ""}${c.diffPct}%`} for the hour ending ${hourLabel} (both numbers are the BA's own, reported to EIA).`;
  if (demandMW === forecastMW)
    c.note += " The two values are identical: EIA may have filled this hour's demand from the forecast, so treat this check as unconfirmed.";
  return c;
}

/**
 * Energy balance inside EIA: net generation − demand should equal total interchange
 * (EIA sign convention: TI positive = net export), within 5 % of demand.
 */
export function balanceCrossCheck(d: number, ng: number, ti: number, hourLabel: string): CrossCheck {
  const lhs = ng - d;
  const diff = lhs - ti;
  const diffPct = d !== 0 ? (diff / Math.abs(d)) * 100 : null;
  return {
    quantity: "Energy balance: net generation − demand vs interchange",
    a: { provider: "EIA NG − D", value: Math.round(lhs), unit: "MW" },
    b: { provider: "EIA interchange", value: Math.round(ti), unit: "MW" },
    diff: Math.round(diff),
    diffPct: diffPct == null ? null : r1(diffPct),
    tolerance: `within ${BALANCE_TOL_PCT}% of demand`,
    agree: diffPct != null && Math.abs(diffPct) <= BALANCE_TOL_PCT,
    note: `Hour ending ${hourLabel}. Interchange is positive when the BA exports. diffPct is relative to demand (${Math.round(d)} MW).`,
  };
}

/* ------------------------------------------------------------------ status */

export function gridStatus(eiaNewestIso: string | null, caisoNewestIso: string | null, anyData: boolean, nowMs: number): FeedStatus {
  if (!anyData) return "error";
  const fresh = (iso: string | null, maxSec: number) => iso != null && nowMs - Date.parse(iso) <= maxSec * 1000;
  return fresh(eiaNewestIso, EIA_MAX_AGE_SEC) || fresh(caisoNewestIso, CAISO_MAX_AGE_SEC) ? "live" : "stale";
}

/* ------------------------------------------------------------------ feed */

const hourLabelOf = (iso: string) => `${iso.slice(0, 13).replace("T", " ")}:00 UTC`;

function errorFeed(errors: string[], providers: ProviderRef[], refreshSec: number): LiveFeed<GridLive> {
  return {
    feed: "grid",
    status: "error",
    fetchedAt: new Date().toISOString(),
    sourceUpdatedAt: null,
    maxAgeSec: EIA_MAX_AGE_SEC,
    refreshSec,
    providers,
    crossChecks: [],
    errors,
    data: null,
  };
}

export function gridErrorFeed(message: string): LiveFeed<GridLive> {
  return errorFeed([message], [], EIA_REFRESH_SEC);
}

export async function buildGridFeed(lat: number, lon: number, opts: { origin?: string } = {}): Promise<LiveFeed<GridLive>> {
  const nowMs = Date.now();
  let ba: DiscoveredBA;
  try {
    ba = await discoverBA(lat, lon, opts);
  } catch (e) {
    return errorFeed([e instanceof Error ? e.message : "Balancing authority lookup failed."], [PROVIDERS.hifld], EIA_REFRESH_SEC);
  }

  const isCiso = ba.code === "CISO";
  const providers: ProviderRef[] = [ba.provider, PROVIDERS.eia, ...(isCiso ? [PROVIDERS.caiso] : [])];
  const refreshSec = isCiso ? CAISO_REFRESH_SEC : EIA_REFRESH_SEC;
  const errors: string[] = [];
  const crossChecks: CrossCheck[] = [];

  const [eiaR, caisoR] = await Promise.allSettled([fetchEia(ba.code, nowMs), isCiso ? fetchCaiso(nowMs) : Promise.resolve(null)]);
  const eia = eiaR.status === "fulfilled" ? eiaR.value : null;
  const caiso = caisoR.status === "fulfilled" ? caisoR.value : null;
  if (eiaR.status === "rejected") errors.push(`EIA hourly grid data unavailable: ${(eiaR.reason as Error).message}.`);
  else if (eia?.staleBecause)
    errors.push(`EIA refresh failed (${eia.staleBecause}); showing EIA data fetched ${Math.round((nowMs - eia.fetchedAt) / 60000)} min ago.`);
  if (eia && eia.keyUsed === "DEMO_KEY")
    errors.push("EIA is queried with the shared DEMO_KEY (low hourly limit); set EIA_API_KEY for reliable refreshes.");
  if (isCiso && caisoR.status === "rejected") errors.push(`CAISO Today's Outlook unavailable: ${(caisoR.reason as Error).message}.`);

  if (!eia && !caiso) return errorFeed(errors, providers, refreshSec);

  // ---- EIA latest hour, series, fuel mix
  const periods = eia ? [...eia.region.hours.keys()].sort() : [];
  const withD = periods.filter((p) => eia!.region.hours.get(p)!.D != null);
  const latestP = withD[withD.length - 1] ?? null;
  const latestH = latestP ? eia!.region.hours.get(latestP)! : null;
  const latestIso = latestP ? eiaPeriodToIso(latestP) : null;
  if (eia && !latestP) errors.push(`EIA has no recent hourly demand for ${ba.code}.`);

  const series: GridLive["series"] = [];
  if (latestIso) {
    const endMs = Date.parse(latestIso);
    for (const p of periods) {
      const iso = eiaPeriodToIso(p)!;
      const t = Date.parse(iso);
      if (t <= endMs - 48 * 3600_000 || t > endMs) continue;
      const h = eia!.region.hours.get(p)!;
      series.push({ period: iso, demandMW: h.D, forecastMW: h.DF });
    }
  }

  const fuelPeriods = eia ? [...eia.fuel.keys()].sort() : [];
  const fuelP = fuelPeriods[fuelPeriods.length - 1] ?? null;
  const fuelMix = fuelP ? fuelMixFrom(eia!.fuel.get(fuelP)!) : [];
  const fuelIso = fuelP ? eiaPeriodToIso(fuelP) : null;
  if (eia?.fuelError) errors.push(`EIA fuel mix unavailable (${eia.fuelError}).`);
  else if (eia && !fuelP) errors.push(`EIA has no recent fuel-mix data for ${ba.code}.`);

  // ---- CAISO latest
  let caisoOut: GridLive["caiso"];
  let caisoNewest: string | null = null;
  if (caiso) {
    const dRow = latestWith(caiso.demand, "Current demand");
    const fRow = latestWith(caiso.fuel, "Solar");
    const asOfMs = Math.max(dRow?.at ?? 0, fRow?.at ?? 0);
    if (asOfMs > 0) {
      caisoNewest = new Date(asOfMs).toISOString();
      const m = fRow ? caisoMix(fRow.values) : { mix: [], importsMW: null };
      caisoOut = { asOf: caisoNewest, demandMW: dRow?.values["Current demand"] ?? null, fuelMix: m.mix, importsMW: m.importsMW };
    } else errors.push("CAISO Today's Outlook returned no readings yet.");
  }

  // ---- Cross-checks
  if (eia && caiso && latestIso && latestH?.D != null) {
    const endMs = Date.parse(latestIso);
    const avg = hourAverage(caiso.demand, "Current demand", endMs);
    if (avg != null) crossChecks.push(demandCrossCheck(avg, latestH.D, hourLabelOf(latestIso)));
    else errors.push(`Demand cross-check skipped: CAISO 5-minute data does not cover the EIA hour ending ${hourLabelOf(latestIso)}.`);
  }
  if (eia && caiso && fuelIso && fuelMix.length) {
    const endMs = Date.parse(fuelIso);
    let rows = caiso.fuel;
    if (!(rows.length && rows[0].at < endMs - 3600_000 + 5 * 60_000)) {
      // EIA's fuel mix often lags into a previous Pacific day: use CAISO's Outlook history for that day.
      try {
        rows = (await fetchCaisoHistory(pacificDate(endMs - 1), nowMs)).fuel;
      } catch (e) {
        rows = [];
        errors.push(`Solar + wind cross-check skipped: CAISO history unavailable (${e instanceof Error ? e.message : "error"}).`);
      }
    }
    const cMix = rows.length ? caisoHourMix(rows, endMs) : null;
    const cPct = cMix ? solarWindShare(cMix) : null;
    const ePct = solarWindShare(fuelMix);
    if (cPct != null && ePct != null) crossChecks.push(shareCrossCheck(cPct, ePct, hourLabelOf(fuelIso)));
    else if (rows.length) errors.push(`Solar + wind cross-check skipped: no matching CAISO readings for the hour ending ${hourLabelOf(fuelIso)}.`);
  }
  if (latestIso && latestH?.D != null && latestH.DF != null) {
    crossChecks.push(forecastCrossCheck(latestH.D, latestH.DF, hourLabelOf(latestIso)));
  }
  const balP = [...periods].reverse().find((p) => {
    const h = eia!.region.hours.get(p)!;
    return h.D != null && h.NG != null && h.TI != null;
  });
  if (balP) {
    const h = eia!.region.hours.get(balP)!;
    const c = balanceCrossCheck(h.D!, h.NG!, h.TI!, hourLabelOf(eiaPeriodToIso(balP)!));
    if (balP !== latestP) c.note += " Latest hour with all three EIA values posted.";
    crossChecks.push(c);
  }

  // ---- Latest block (NG / TI only if posted for the demand hour)
  const latest: GridLive["latest"] = {
    period: latestIso,
    demandMW: latestH?.D ?? null,
    forecastMW: latestH?.DF ?? null,
    netGenMW: latestH?.NG ?? null,
    interchangeMW: latestH?.TI ?? null,
  };
  if (latestH && (latestH.NG == null || latestH.TI == null) && latestIso)
    errors.push(`EIA has not yet posted net generation / interchange for the hour ending ${hourLabelOf(latestIso)}.`);

  const newest = [latestIso, caisoNewest].filter((x): x is string => !!x).sort().pop() ?? null;
  const status = gridStatus(latestIso, caisoNewest, !!(latestIso || caisoNewest), nowMs);

  return {
    feed: "grid",
    status,
    fetchedAt: new Date(nowMs).toISOString(),
    sourceUpdatedAt: newest,
    // CAISO 5-minute data sets the clock when it is fresh; otherwise EIA's hourly lag rules apply.
    maxAgeSec: caisoNewest && nowMs - Date.parse(caisoNewest) <= CAISO_MAX_AGE_SEC * 1000 ? CAISO_MAX_AGE_SEC : EIA_MAX_AGE_SEC,
    refreshSec,
    providers,
    crossChecks,
    errors,
    data: {
      ba: { code: ba.code, name: eia?.region.respondentName ?? ba.name, method: ba.method },
      latest,
      fuelMix,
      fuelMixPeriod: fuelIso,
      cleanSharePct: fuelMix.length ? cleanShare(fuelMix) : null,
      series,
      ...(caisoOut ? { caiso: caisoOut } : {}),
    },
  };
}
