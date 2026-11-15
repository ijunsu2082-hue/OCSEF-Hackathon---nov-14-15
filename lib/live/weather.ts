// Live weather feed (server only). NOAA/NWS station observation, hourly forecast and alerts,
// cross-checked against Open-Meteo at five points inside the scan circle. Line rating ratios come
// from our own model (lib/scan/rating.ts); no math is duplicated here.
import type { CrossCheck, FeedStatus, LiveFeed, ProviderRef } from "./types";
import { aarRatio, rateLine } from "../scan/rating";
import { degSpan, haversineMi } from "../scan/geo";

export interface WeatherLive {
  center: {
    tempC: number | null;
    windMs: number | null;
    windDirDeg: number | null;
    gustMs: number | null;
    sunWm2: number | null;
    observedAt: string | null;
    station: { id: string; name: string; distanceMi: number } | null;
  };
  /** Open-Meteo current weather at center, N, S, E, W (0.6 x radius). Empty when Open-Meteo is down. */
  samples: { label: string; lat: number; lon: number; tempC: number; windMs: number; ratio: { aar: number; dlr: number } }[];
  /** Sample with the lowest rating ratio (min of AAR and conservative DLR); null when there are no samples. */
  worst: { label: string; aar: number; dlr: number } | null;
  /** Min / max Open-Meteo temperature across the five sample points; null when there are no samples. */
  tempRange: { minC: number; maxC: number } | null;
  alerts: {
    id: string; event: string; severity: string; headline: string | null;
    onset: string | null; ends: string | null; gridRelevant: boolean; why: string | null;
  }[];
  hourly: { time: string; tempC: number; windMs: number | null }[];
}

export const NWS_UA = "Mapergy (hackathon demo)";
const NWS = "https://api.weather.gov";
const OM = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT_MS = 8000;
export const MAX_AGE_SEC = 90 * 60;
export const REFRESH_SEC = 300;
const CACHE_MS = 60_000;
export const TEMP_TOL_C = 3;
export const WIND_TOL_MS = 3;

/* ------------------------------------------------------------------ geometry */

export interface SamplePoint { label: string; lat: number; lon: number }

/** Center plus N, S, E, W at 0.6 x radius (miles). */
export function samplePoints(lat: number, lon: number, rMi: number): SamplePoint[] {
  const { dLat, dLon } = degSpan(0.6 * rMi, lat);
  return [
    { label: "Center", lat, lon },
    { label: "North", lat: lat + dLat, lon },
    { label: "South", lat: lat - dLat, lon },
    { label: "East", lat, lon: lon + dLon },
    { label: "West", lat, lon: lon - dLon },
  ];
}

/* ------------------------------------------------------------------ helpers */

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** NWS quantitative value -> m/s (handles km/h, m/s, knots, mph unit codes). */
export function nwsSpeedMs(q: { unitCode?: string; value?: unknown } | null | undefined): number | null {
  const v = num(q?.value);
  if (v == null) return null;
  const u = String(q?.unitCode ?? "");
  if (u.endsWith("km_h-1")) return v / 3.6;
  if (u.endsWith("m_s-1")) return v;
  if (u.endsWith("kt")) return v * 0.514444;
  if (u.endsWith("mi_h-1")) return v * 0.44704;
  return null; // unknown unit: don't guess
}

/** NWS quantitative temperature -> °C. */
export function nwsTempC(q: { unitCode?: string; value?: unknown } | null | undefined): number | null {
  const v = num(q?.value);
  if (v == null) return null;
  const u = String(q?.unitCode ?? "");
  if (u.endsWith("degC")) return v;
  if (u.endsWith("degF")) return ((v - 32) * 5) / 9;
  return null;
}

export interface NwsObs { tempC: number | null; windMs: number | null; windDirDeg: number | null; gustMs: number | null; observedAt: string | null }

export function parseNwsObservation(j: unknown): NwsObs {
  const p = (j as { properties?: Record<string, { unitCode?: string; value?: unknown } | string | undefined> })?.properties ?? {};
  const q = (k: string) => (typeof p[k] === "object" ? (p[k] as { unitCode?: string; value?: unknown }) : null);
  const ts = typeof p.timestamp === "string" ? p.timestamp : null;
  return {
    tempC: nwsTempC(q("temperature")),
    windMs: nwsSpeedMs(q("windSpeed")),
    windDirDeg: num(q("windDirection")?.value),
    gustMs: nwsSpeedMs(q("windGust")),
    observedAt: ts && Number.isFinite(Date.parse(ts)) ? new Date(Date.parse(ts)).toISOString() : null,
  };
}

/** NWS hourly forecast wind string ("5 km/h", "10 to 15 mph") -> m/s; ranges use the midpoint. */
export function parseWindString(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const nums = (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (!nums.length) return null;
  const v = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (/km\/h/i.test(s)) return v / 3.6;
  if (/mph/i.test(s)) return v * 0.44704;
  if (/kt|knot/i.test(s)) return v * 0.514444;
  if (/m\/s/i.test(s)) return v;
  return null;
}

export function parseNwsHourly(j: unknown, nowMs: number, hours = 24): WeatherLive["hourly"] {
  const periods = (j as { properties?: { periods?: Record<string, unknown>[] } })?.properties?.periods ?? [];
  const out: WeatherLive["hourly"] = [];
  for (const p of periods) {
    const end = Date.parse(String(p.endTime ?? ""));
    const start = Date.parse(String(p.startTime ?? ""));
    if (!Number.isFinite(start) || (Number.isFinite(end) && end <= nowMs)) continue;
    const t = num(p.temperature);
    if (t == null) continue;
    const tempC = p.temperatureUnit === "F" ? ((t - 32) * 5) / 9 : t;
    const w = parseWindString(p.windSpeed);
    out.push({ time: new Date(start).toISOString(), tempC: r1(tempC), windMs: w == null ? null : r1(w) });
    if (out.length >= hours) break;
  }
  return out;
}

/* ------------------------------------------------------------------ alerts */

const GRID_RULES: { re: RegExp; why: string }[] = [
  { re: /^(Excessive|Extreme) Heat (Warning|Watch)$/i, why: "Extreme heat lowers line and transformer ratings while air-conditioning demand peaks." },
  { re: /^Heat Advisory$/i, why: "Heat lowers line ratings while air-conditioning demand rises." },
  { re: /^Red Flag Warning$/i, why: "Critical fire weather: utilities may de-energize lines (public safety power shutoffs)." },
  { re: /^Fire Weather Watch$/i, why: "Fire weather possible soon: utilities may plan power shutoffs." },
  { re: /^High Wind (Warning|Watch)$/i, why: "Strong wind can bring down lines and trees onto lines." },
  { re: /^(Winter|Ice) Storm (Warning|Watch)$/i, why: "Ice and snow load on lines can cause outages; heating demand rises." },
  { re: /^(Hurricane|Tropical Storm) (Warning|Watch)$/i, why: "Tropical wind and flooding can cause widespread outages." },
];

export function tagAlert(event: string): { gridRelevant: boolean; why: string | null } {
  const hit = GRID_RULES.find((r) => r.re.test(event.trim()));
  return hit ? { gridRelevant: true, why: hit.why } : { gridRelevant: false, why: null };
}

/** Parse one or more NWS alert FeatureCollections, dedupe by alert id. */
export function parseAlerts(collections: unknown[]): WeatherLive["alerts"] {
  const seen = new Map<string, WeatherLive["alerts"][number]>();
  for (const c of collections) {
    const feats = (c as { features?: { id?: string; properties?: Record<string, unknown> }[] })?.features ?? [];
    for (const f of feats) {
      const p = f.properties ?? {};
      const id = String(p.id ?? f.id ?? "");
      const event = typeof p.event === "string" ? p.event : "";
      if (!id || !event || seen.has(id)) continue;
      seen.set(id, {
        id,
        event,
        severity: typeof p.severity === "string" ? p.severity : "Unknown",
        headline: typeof p.headline === "string" ? p.headline : null,
        onset: typeof p.onset === "string" ? p.onset : null,
        ends: typeof p.ends === "string" ? p.ends : null,
        ...tagAlert(event),
      });
    }
  }
  // Grid-relevant first, then by severity.
  const rank: Record<string, number> = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };
  return [...seen.values()].sort(
    (a, b) => Number(b.gridRelevant) - Number(a.gridRelevant) || (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4),
  );
}

/* ------------------------------------------------------------------ Open-Meteo */

export interface OmCurrent { tempC: number; windMs: number; windDirDeg: number | null; sunWm2: number; time: string }

/** Open-Meteo current block(s) -> one entry per requested location (null when a field is missing). */
export function parseOpenMeteo(j: unknown, n: number): (OmCurrent | null)[] {
  const arr = Array.isArray(j) ? j : [j];
  const out: (OmCurrent | null)[] = [];
  for (let i = 0; i < n; i++) {
    const c = (arr[i] as { current?: Record<string, unknown> } | undefined)?.current;
    const t = num(c?.temperature_2m), w = num(c?.wind_speed_10m), s = num(c?.shortwave_radiation), ts = num(c?.time);
    out.push(
      c && t != null && w != null && s != null && ts != null
        ? { tempC: t, windMs: w, windDirDeg: num(c.wind_direction_10m), sunWm2: s, time: new Date(ts * 1000).toISOString() }
        : null,
    );
  }
  return out;
}

export function parseOpenMeteoHourly(j: unknown, nowMs: number, hours = 24): WeatherLive["hourly"] {
  const h = (j as { hourly?: { time?: unknown[]; temperature_2m?: unknown[]; wind_speed_10m?: unknown[] } })?.hourly;
  const out: WeatherLive["hourly"] = [];
  const times = h?.time ?? [];
  for (let i = 0; i < times.length && out.length < hours; i++) {
    const ts = num(times[i]), t = num(h?.temperature_2m?.[i]), w = num(h?.wind_speed_10m?.[i]);
    if (ts == null || t == null || ts * 1000 + 3600_000 <= nowMs) continue;
    out.push({ time: new Date(ts * 1000).toISOString(), tempC: r1(t), windMs: w == null ? null : r1(w) });
  }
  return out;
}

/* ------------------------------------------------------------------ rating + checks */

/** AAR and conservative DLR ratios (vs the fixed 40 °C worst-case rating) from our IEEE 738 model. */
export function rateSample(tempC: number, windMs: number, sunWm2: number, time: string): { aar: number; dlr: number } {
  const r = rateLine({ temp_c: tempC, wind_ms: windMs, sun_wm2: sunWm2, time, source: "open-meteo-live" });
  return { aar: r3(aarRatio(r) ?? 0), dlr: r3(r.ratio) };
}

export function worstSample(samples: WeatherLive["samples"]): WeatherLive["worst"] {
  let best: WeatherLive["samples"][number] | null = null;
  for (const s of samples) {
    if (!best || Math.min(s.ratio.aar, s.ratio.dlr) < Math.min(best.ratio.aar, best.ratio.dlr)) best = s;
  }
  return best ? { label: best.label, aar: best.ratio.aar, dlr: best.ratio.dlr } : null;
}

export function tempCrossCheck(nwsC: number, omC: number, stationMi: number | null): CrossCheck {
  const diff = r1(nwsC - omC);
  return {
    quantity: "Air temperature at scan center",
    a: { provider: "NWS station (observed)", value: r1(nwsC), unit: "°C" },
    b: { provider: "Open-Meteo (model, center)", value: r1(omC), unit: "°C" },
    diff,
    diffPct: null,
    tolerance: `within ${TEMP_TOL_C} °C`,
    agree: Math.abs(nwsC - omC) <= TEMP_TOL_C,
    note: stationMi == null ? undefined : `Station is ${r1(stationMi)} mi from the scan center.`,
  };
}

export function windCrossCheck(nwsMs: number, omMs: number, stationMi: number | null): CrossCheck {
  const diff = r1(nwsMs - omMs);
  return {
    quantity: "Wind speed at scan center",
    a: { provider: "NWS station (observed)", value: r1(nwsMs), unit: "m/s" },
    b: { provider: "Open-Meteo (model, center)", value: r1(omMs), unit: "m/s" },
    diff,
    diffPct: omMs > 0 ? r1(((nwsMs - omMs) / omMs) * 100) : null,
    tolerance: `within ${WIND_TOL_MS} m/s`,
    agree: Math.abs(nwsMs - omMs) <= WIND_TOL_MS,
    note:
      "Station wind is a 2-minute average near 10 m; the model is a grid-cell value." +
      (stationMi == null ? "" : ` Station is ${r1(stationMi)} mi from the scan center.`),
  };
}

export function feedStatus(newestIso: string | null, hasData: boolean, nowMs: number): FeedStatus {
  if (!hasData) return "error";
  if (!newestIso) return "stale";
  return nowMs - Date.parse(newestIso) <= MAX_AGE_SEC * 1000 ? "live" : "stale";
}

/* ------------------------------------------------------------------ fetching */

async function getJson(url: string, nws: boolean): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: nws ? { "User-Agent": NWS_UA, Accept: "application/geo+json" } : { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? "timed out after 8 s" : e.message) : "request failed";
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

const f4 = (x: number) => x.toFixed(4);

interface NwsCenter {
  obs: NwsObs | null;
  station: { id: string; name: string; distanceMi: number } | null;
  hourly: WeatherLive["hourly"];
  notes: string[];
}

async function fetchNwsCenter(lat: number, lon: number, nowMs: number): Promise<NwsCenter> {
  const notes: string[] = [];
  const pt = (await getJson(`${NWS}/points/${f4(lat)},${f4(lon)}`, true)) as {
    properties?: { observationStations?: string; forecastHourly?: string };
  };
  const stationsUrl = pt?.properties?.observationStations;
  const hourlyUrl = pt?.properties?.forecastHourly;

  const hourlyP: Promise<WeatherLive["hourly"]> = hourlyUrl
    ? getJson(`${hourlyUrl}?units=si`, true).then((j) => parseNwsHourly(j, nowMs)).catch((e: Error) => {
        notes.push(`NWS hourly forecast unavailable (${e.message}).`);
        return [];
      })
    : Promise.resolve([]);

  let obs: NwsObs | null = null;
  let station: NwsCenter["station"] = null;
  if (stationsUrl) {
    try {
      const sj = (await getJson(`${stationsUrl}?limit=10`, true)) as {
        features?: { geometry?: { coordinates?: number[] }; properties?: { stationIdentifier?: string; name?: string } }[];
      };
      const list = (sj.features ?? [])
        .map((f) => {
          const [sLon, sLat] = f.geometry?.coordinates ?? [];
          const id = f.properties?.stationIdentifier;
          if (!id || num(sLat) == null || num(sLon) == null) return null;
          return { id, name: f.properties?.name ?? id, distanceMi: haversineMi(lat, lon, sLat, sLon) };
        })
        .filter((s): s is NonNullable<typeof s> => s != null)
        .sort((a, b) => a.distanceMi - b.distanceMi);
      // Nearest station first; if it has no temperature or a reading older than 90 min, try the next two.
      // If none is fresh, keep the nearest one that has a temperature and say how old it is.
      let fallback: { o: NwsObs; s: (typeof list)[number] } | null = null;
      for (const s of list.slice(0, 3)) {
        try {
          const o = parseNwsObservation(await getJson(`${NWS}/stations/${s.id}/observations/latest`, true));
          if (o.tempC == null || !o.observedAt) continue;
          if (nowMs - Date.parse(o.observedAt) <= MAX_AGE_SEC * 1000) {
            obs = o;
            station = { id: s.id, name: s.name, distanceMi: r1(s.distanceMi) };
            if (s !== list[0]) notes.push(`Nearest NWS station ${list[0].id} had no recent temperature; used ${s.id} instead.`);
            break;
          }
          fallback ??= { o, s };
        } catch {
          /* try next station */
        }
      }
      if (!obs && fallback) {
        obs = fallback.o;
        station = { id: fallback.s.id, name: fallback.s.name, distanceMi: r1(fallback.s.distanceMi) };
        const h = r1((nowMs - Date.parse(fallback.o.observedAt as string)) / 3600_000);
        notes.push(`Latest NWS station reading (${fallback.s.id}) is ${h} h old; no nearby station has a reading from the last 90 min.`);
      }
      if (!obs) notes.push("No nearby NWS station reported a current temperature.");
    } catch (e) {
      notes.push(`NWS station list unavailable (${(e as Error).message}).`);
    }
  } else {
    notes.push("NWS returned no observation stations for this point.");
  }

  return { obs, station, hourly: await hourlyP, notes };
}

const cache = new Map<string, { at: number; feed: LiveFeed<WeatherLive> }>();
export const cacheKey = (lat: number, lon: number, rMi: number) => `${lat.toFixed(2)},${lon.toFixed(2)},${Math.round(rMi * 10) / 10}`;

export async function buildWeatherFeed(lat: number, lon: number, rMi: number): Promise<LiveFeed<WeatherLive>> {
  const key = cacheKey(lat, lon, rMi);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.feed;
  const feed = await buildUncached(lat, lon, rMi);
  if (feed.status !== "error") cache.set(key, { at: Date.now(), feed });
  return feed;
}

async function buildUncached(lat: number, lon: number, rMi: number): Promise<LiveFeed<WeatherLive>> {
  const nowMs = Date.now();
  const errors: string[] = [];
  const pts = samplePoints(lat, lon, rMi);
  const providers: ProviderRef[] = [
    { id: "nws", name: "National Weather Service", url: `https://forecast.weather.gov/MapClick.php?lat=${f4(lat)}&lon=${f4(lon)}` },
    { id: "open-meteo", name: "Open-Meteo", url: "https://open-meteo.com/en/docs" },
  ];

  const omUrl =
    `${OM}?latitude=${pts.map((p) => f4(p.lat)).join(",")}&longitude=${pts.map((p) => f4(p.lon)).join(",")}` +
    "&current=temperature_2m,wind_speed_10m,wind_direction_10m,shortwave_radiation&wind_speed_unit=ms&timeformat=unixtime";

  const [nwsR, omR, ...alertR] = await Promise.allSettled([
    fetchNwsCenter(lat, lon, nowMs),
    getJson(omUrl, false),
    ...pts.map((p) => getJson(`${NWS}/alerts/active?status=actual&point=${f4(p.lat)},${f4(p.lon)}`, true)),
  ]);

  // NWS center
  let nws: NwsCenter | null = null;
  if (nwsR.status === "fulfilled") {
    nws = nwsR.value;
    errors.push(...nws.notes);
  } else {
    errors.push(`National Weather Service unavailable (${(nwsR.reason as Error).message}).`);
  }

  // Open-Meteo samples
  let om: (OmCurrent | null)[] = [];
  if (omR.status === "fulfilled") {
    om = parseOpenMeteo(omR.value, pts.length);
    if (om.every((x) => x == null)) errors.push("Open-Meteo returned no current weather.");
  } else {
    errors.push(`Open-Meteo unavailable (${(omR.reason as Error).message}); sample grid and line ratings skipped.`);
  }
  const samples: WeatherLive["samples"] = [];
  pts.forEach((p, i) => {
    const c = om[i];
    if (!c) return;
    samples.push({
      label: p.label, lat: r3(p.lat), lon: r3(p.lon), tempC: r1(c.tempC), windMs: r1(c.windMs),
      ratio: rateSample(c.tempC, c.windMs, c.sunWm2, c.time),
    });
  });
  const omCenter = om[0] ?? null;

  // Alerts
  const okAlerts = alertR.filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled").map((r) => r.value);
  const failedAlerts = alertR.map((r, i) => (r.status === "rejected" ? pts[i].label : null)).filter(Boolean);
  if (failedAlerts.length === pts.length) errors.push("NWS alerts unavailable.");
  else if (failedAlerts.length) errors.push(`NWS alerts unavailable for: ${failedAlerts.join(", ")}.`);
  const alerts = parseAlerts(okAlerts);

  // Hourly: NWS, else Open-Meteo for the center.
  let hourly = nws?.hourly ?? [];
  if (!hourly.length) {
    try {
      const hj = await getJson(
        `${OM}?latitude=${f4(lat)}&longitude=${f4(lon)}&hourly=temperature_2m,wind_speed_10m&forecast_hours=25&wind_speed_unit=ms&timeformat=unixtime`,
        false,
      );
      hourly = parseOpenMeteoHourly(hj, nowMs);
      if (hourly.length) errors.push("Hourly forecast is from Open-Meteo (NWS hourly unavailable).");
    } catch (e) {
      errors.push(`No hourly forecast available (${(e as Error).message}).`);
    }
  }

  // Center conditions: NWS observed where present, Open-Meteo otherwise. Never filled in from nothing.
  const obs = nws?.obs ?? null;
  const pick = (a: number | null | undefined, b: number | null | undefined) => (a != null ? a : b != null ? b : null);
  const center: WeatherLive["center"] = {
    tempC: pick(obs?.tempC, omCenter?.tempC),
    windMs: pick(obs?.windMs, omCenter?.windMs),
    windDirDeg: pick(obs?.windDirDeg, omCenter?.windDirDeg),
    gustMs: obs?.gustMs ?? null,
    sunWm2: omCenter?.sunWm2 ?? null,
    observedAt: obs?.observedAt ?? omCenter?.time ?? null,
    station: obs ? nws?.station ?? null : null,
  };
  for (const k of ["tempC", "windMs", "windDirDeg"] as const) {
    if (center[k] != null) center[k] = r1(center[k] as number);
  }
  if (center.gustMs != null) center.gustMs = r1(center.gustMs);
  if (obs && obs.windMs == null && omCenter) errors.push("NWS station reported no wind; center wind is from Open-Meteo.");

  // Cross-checks
  const crossChecks: CrossCheck[] = [];
  const stMi = nws?.station?.distanceMi ?? null;
  if (obs?.tempC != null && omCenter) crossChecks.push(tempCrossCheck(obs.tempC, omCenter.tempC, stMi));
  if (obs?.windMs != null && omCenter) crossChecks.push(windCrossCheck(obs.windMs, omCenter.windMs, stMi));
  if (crossChecks.length === 2 && crossChecks.every((c) => !c.agree)) {
    errors.push("NWS station and Open-Meteo differ on both temperature and wind; treat current conditions with caution.");
  }
  if (!crossChecks.length) errors.push("Cross-check not possible: needs both an NWS observation and Open-Meteo.");

  const stamps = [obs?.observedAt, omCenter?.time].filter((s): s is string => !!s).sort();
  const newest = stamps.length ? stamps[stamps.length - 1] : null;
  const hasData = center.tempC != null || samples.length > 0;
  const status = feedStatus(newest, hasData, nowMs);

  const temps = samples.map((s) => s.tempC);
  return {
    feed: "weather",
    status,
    fetchedAt: new Date(nowMs).toISOString(),
    sourceUpdatedAt: newest,
    maxAgeSec: MAX_AGE_SEC,
    refreshSec: REFRESH_SEC,
    providers,
    crossChecks,
    errors,
    data: hasData
      ? {
          center,
          samples,
          worst: worstSample(samples),
          tempRange: temps.length ? { minC: Math.min(...temps), maxC: Math.max(...temps) } : null,
          alerts,
          hourly,
        }
      : null,
  };
}
