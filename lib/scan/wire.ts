/**
 * "The wire that breathes" — the hourly conductor rating from the 2025 weather
 * archive at `public/layers/line_rating_2025_westminster_hs.csv`
 * (one row per hour: temperature, wind, sun for the nearest weather site).
 *
 * Ratings are recomputed here with this app's own IEEE 738 screening model
 * (`lib/physics/thermal.ts`), so every ampere on screen comes from the same
 * heat balance as the grid chain. The comparison is like-for-like: still air
 * (0.61 m/s, the AAR assumption) against the wind that was actually blowing, at
 * the same ambient temperature and the same sun. That isolates what the breeze
 * is worth, which is the whole point of a dynamic line rating.
 *
 * The archive is a fallback. A weather API sample can replace its current-hour
 * calculation while the full-year archive remains the historical comparison.
 */

import { conductorForKv, thermalScreen } from "../gridAssets";
import type { ConductorSpec } from "../physics/network";
import { conductorAmpacity } from "../physics/thermal";

export const RATING_CSV_URL = "/layers/line_rating_2025_westminster_hs.csv";
export const RATING_FALLBACK_CSV_URL = "/layers/line_rating_2024_westminster_hs.csv";
export const RATING_SITE_LABEL = "Westminster HS";

/** IEEE 738 light-wind assumption the fixed rating is based on, m/s. */
const STILL_AIR_MPS = 0.61;
/** Archive timestamps are a fixed UTC-8 clock (no DST). */
const CSV_UTC_OFFSET_H = 8;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export interface WireHour {
  /** Archive timestamp, `2025-09-06T13:00`. */
  time: string;
  temp_c: number;
  wind_mps: number;
  sun_wm2: number;
  /** Rating in still air at this hour's temperature and sun, A. */
  still_a: number;
  /** Rating with the hour's actual wind at the same temperature and sun, A. */
  breeze_a: number;
  /** breeze_a / still_a. */
  ratio: number;
}

export interface WeatherForRating {
  time: string;
  temp_c: number;
  wind_mps: number;
  shortwave_wm2: number;
}

export interface WireSummary {
  site: string;
  voltage_kv: number;
  conductor: string;
  /** Hours in the archive. */
  hours: number;
  /** Latest bundled archive hour; the panel replaces it with live weather when available. */
  now: WireHour | null;
  hottest: WireHour | null;
  /** The 24 hours of that day. */
  today: WireHour[];
  median_ratio: number;
  pct_hours_above_still_air: number;
  still_air_a: number;
  breeze_a: number;
  heatwave: {
    ratio: number;
    derate_pct: number;
    dlr_uplift_pct: number;
    rating_105f_mva: number;
    conductor_temp_c: number;
  };
}

interface WeatherRow {
  time: string;
  temp_c: number;
  wind_mps: number;
  sun_wm2: number;
}

let cachedCsv: string | null = null;
let cachedRows: WeatherRow[] = [];

function rowsFor(csv: string): WeatherRow[] {
  if (cachedCsv === csv) return cachedRows;

  const rows: WeatherRow[] = [];
  const lines = csv.split(/\r?\n/);
  if (lines.length > 1) {
    const header = lines[0].split(",");
    const iTime = header.indexOf("time");
    const iTemp = header.indexOf("temp_c");
    const iWind = header.indexOf("wind_ms");
    const iSun = header.indexOf("sun_wm2");
    if (iTime >= 0 && iTemp >= 0 && iWind >= 0 && iSun >= 0) {
      for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line) continue;
        const cells = line.split(",");
        const time = cells[iTime];
        const temp = Number(cells[iTemp]);
        const wind = Number(cells[iWind]);
        const sun = Number(cells[iSun]);
        if (
          !time ||
          !Number.isFinite(temp) ||
          !Number.isFinite(wind) ||
          !Number.isFinite(sun)
        ) {
          continue;
        }
        rows.push({ time, temp_c: temp, wind_mps: wind, sun_wm2: sun });
      }
    }
  }

  cachedCsv = csv;
  cachedRows = rows;
  return rows;
}

const round = (value: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

function rateHour(row: WeatherRow, conductor: ConductorSpec): WireHour {
  const stillA = conductorAmpacity(conductor, {
    ambient_c: row.temp_c,
    wind_mps: STILL_AIR_MPS,
    solar_w_m2: row.sun_wm2,
  });
  const breezeA = conductorAmpacity(conductor, {
    ambient_c: row.temp_c,
    wind_mps: row.wind_mps,
    solar_w_m2: row.sun_wm2,
  });
  return {
    ...row,
    still_a: Math.round(stillA),
    breeze_a: Math.round(breezeA),
    ratio: stillA > 0 ? round(breezeA / stillA, 3) : 1,
  };
}

/** Re-rate the screened conductor with one live, persisted, or historical sample. */
export function rateWeatherSample(voltageKv: number, sample: WeatherForRating): WireHour {
  const row: WeatherRow = {
    time: sample.time,
    temp_c: sample.temp_c,
    wind_mps: sample.wind_mps,
    sun_wm2: sample.shortwave_wm2,
  };
  return rateHour(row, conductorForKv(voltageKv));
}

/** Latest valid row from the bundled CSV without rating the full history. */
export function latestArchiveWeather(csv: string): WeatherForRating | null {
  const rows = rowsFor(csv);
  const latest = rows[rows.length - 1];
  return latest ? {
    time: latest.time,
    temp_c: latest.temp_c,
    wind_mps: latest.wind_mps,
    shortwave_wm2: latest.sun_wm2,
  } : null;
}

export function conductorForVoltage(voltageKv: number): string {
  return conductorForKv(voltageKv).label;
}

export function heatwaveWireSummary(voltageKv: number): { ratio: number; derate_pct: number } {
  const screen = thermalScreen(voltageKv);
  const ratio = screen.rating_mva_105f > 0 ? screen.dlr_rating_mva / screen.rating_mva_105f : 1;
  return { ratio: round(ratio, 2), derate_pct: screen.derate_pct };
}

// Rating every hour is ~17k heat-balance solves; cache by conductor and archive
// so a radius drag reuses the series instead of recomputing the year.
let seriesKey: string | null = null;
let series: WireHour[] = [];

function seriesFor(csv: string, conductor: ConductorSpec): WireHour[] {
  const key = `${conductor.id}|${csv.length}`;
  if (seriesKey === key && cachedCsv === csv) return series;
  series = rowsFor(csv).map((row) => rateHour(row, conductor));
  seriesKey = key;
  return series;
}

/** The archive key for this clock hour, e.g. `2025-09-06T13:00`. */
function csvHourKey(now: Date, archiveYear: string): string {
  const shifted = new Date(now.getTime() - CSV_UTC_OFFSET_H * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${archiveYear}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}T${p(
    shifted.getUTCHours(),
  )}:00`;
}

/** `2025-09-06T13:00` -> `Sep 6, 1 pm`. No Date parsing, so no timezone drift. */
export function hourLabel(iso: string | null): string {
  const match = iso ? /^\d{4}-(\d{2})-(\d{2})(?:T(\d{2}))?/.exec(iso) : null;
  if (!match) return "—";
  const date = `${MONTHS[Number(match[1]) - 1] ?? match[1]} ${Number(match[2])}`;
  if (match[3] === undefined) return date;
  const hour = Number(match[3]);
  return `${date}, ${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "am" : "pm"}`;
}

/** `2025-09-06T13:00` -> `Sep 6`. */
export function dayLabel(iso: string | null): string {
  return hourLabel(iso ? iso.slice(0, 10) : null);
}

/**
 * Rate the highest-voltage tie in a circle. Null when the archive is empty, so
 * the scan reports a gap instead of a number.
 */
export function summarizeWire(
  csv: string,
  voltageKv: number,
): WireSummary | null {
  const rows = rowsFor(csv);
  if (rows.length === 0) return null;

  const conductor = conductorForKv(voltageKv);
  const hours = seriesFor(csv, conductor);
  if (hours.length === 0) return null;

  const archiveYear = rows[0]?.time.slice(0, 4) ?? "2025";
  const key = csvHourKey(new Date(), archiveYear);
  // `now` is the newest bundled observation, never a same-day proxy for live weather.
  const now = hours[hours.length - 1] ?? null;
  const today = hours.filter((hour) => hour.time.startsWith(key.slice(0, 10)));

  let hottest = hours[0];
  for (const hour of hours) {
    if (hour.temp_c > hottest.temp_c) hottest = hour;
  }

  const ratios = hours.map((hour) => hour.ratio).sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)] ?? 1;
  const above = hours.filter((hour) => hour.ratio > 1.005).length;

  const screen = thermalScreen(voltageKv);
  const heatRatio =
    screen.rating_mva_105f > 0 ? screen.dlr_rating_mva / screen.rating_mva_105f : 1;
  const current = now ?? hottest;

  return {
    site: RATING_SITE_LABEL,
    voltage_kv: Math.round(voltageKv),
    conductor: conductor.label,
    hours: hours.length,
    now,
    hottest,
    today,
    median_ratio: round(median, 2),
    pct_hours_above_still_air: Math.round((above / hours.length) * 100),
    still_air_a: current.still_a,
    breeze_a: current.breeze_a,
    heatwave: {
      ratio: round(heatRatio, 2),
      derate_pct: screen.derate_pct,
      dlr_uplift_pct: round((heatRatio - 1) * 100, 1),
      rating_105f_mva: screen.rating_mva_105f,
      conductor_temp_c: screen.conductor_temp_c_at_rating,
    },
  };
}
