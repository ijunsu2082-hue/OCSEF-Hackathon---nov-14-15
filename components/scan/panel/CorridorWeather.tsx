"use client";

import { useEffect, useMemo, useState } from "react";
import { UI } from "@/lib/scan/colors";
import { loadGridData } from "@/lib/scan/data";
import { fetchWeatherNow } from "@/lib/scan/rating";
import { corridorBearingDeg, corridorMidpoint, rateCorridor, windAngleToLine } from "@/lib/scan/corridor";
import type { Line, WeatherNow } from "@/lib/scan/types";
import { DASH, fmtHour, fmtNum, fmtRatio, isNum } from "./format";
import { Caption } from "./ui";

/*
 * "Line right now": live weather at the middle of the selected line, rated with the real
 * wind angle to the wire. Rendered inside the SelectedAsset card when a line is selected.
 * Temperature / wind speed / sun come from fetchWeatherNow() (same as the hero); wind direction
 * comes from one extra Open-Meteo request because fetchWeatherNow() does not return it.
 */

interface WindDir {
  from_deg: number;
  /** Open-Meteo's offset for the America/Los_Angeles times it returns. */
  utc_offset_s: number;
}

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; weather: WeatherNow; dir: WindDir | null };

/** Wind direction (degrees the wind blows FROM) at the point. Null on any failure. */
async function fetchWindDir(lat: number, lon: number, signal: AbortSignal): Promise<WindDir | null> {
  try {
    const url =
      "https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(4) + "&longitude=" + lon.toFixed(4) +
      "&current=wind_direction_10m&timezone=America%2FLos_Angeles";
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const j = (await res.json()) as { utc_offset_seconds?: number; current?: { wind_direction_10m?: number } };
    const d = j.current?.wind_direction_10m;
    if (!isNum(d)) return null;
    return { from_deg: d, utc_offset_s: isNum(j.utc_offset_seconds) ? j.utc_offset_seconds : NaN };
  } catch {
    return null;
  }
}

/** "12 min old" from an Open-Meteo local time ("2026-11-14T10:15") and its UTC offset. */
function ageLabel(time: string, offsetS: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(time);
  if (!m || !isNum(offsetS)) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - offsetS * 1000;
  const min = Math.max(0, Math.round((Date.now() - utc) / 60_000));
  if (min < 60) return `${min} min old`;
  if (min < 48 * 60) return `${Math.round(min / 60)} hr old`;
  return `${Math.round(min / 1440)} d old`;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

function Compare({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 text-[13px] leading-snug text-[#556070]">{label}</span>
      <span
        className="shrink-0 text-[15px] font-semibold tabular-nums"
        style={{ color: danger ? UI.danger : UI.text }}
      >
        {value}
      </span>
    </div>
  );
}

export function CorridorWeather({ line }: { line: Line }) {
  const mid = useMemo(() => corridorMidpoint(line.coords), [line.coords]);
  const lineBearing = useMemo(() => corridorBearingDeg(line.coords), [line.coords]);
  const [state, setState] = useState<State>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const lat = mid?.[0], lon = mid?.[1];

  useEffect(() => {
    if (!isNum(lat) || !isNum(lon)) {
      setState({ status: "error" });
      return;
    }
    const ctrl = new AbortController();
    let alive = true;
    setState({ status: "loading" });
    Promise.all([loadGridData().then((data) => fetchWeatherNow(lat, lon, data)), fetchWindDir(lat, lon, ctrl.signal)])
      .then(([weather, dir]) => {
        if (alive) setState({ status: "ok", weather, dir });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [lat, lon, retry]);

  return (
    <div className="mt-4 rounded-[6px] border border-[#e6e9ee] bg-white px-4 py-4" aria-label="Line right now">
      <h4 className="text-[15px] font-semibold leading-snug text-[#1d2733]">Line right now</h4>
      <Body state={state} lineBearing={lineBearing} onRetry={() => setRetry((n) => n + 1)} />
    </div>
  );
}

function Body({
  state,
  lineBearing,
  onRetry,
}: {
  state: State;
  lineBearing: number | null;
  onRetry: () => void;
}) {
  if (state.status === "loading") {
    return (
      <p className="mt-2 text-[13px] text-[#556070]" aria-busy>
        Getting weather for this line…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className="mt-2 text-[13px] leading-snug text-[#556070]">
        Weather for this line is not available right now.{" "}
        <button
          type="button"
          onClick={onRetry}
          className="font-medium text-[#0369a1] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]"
        >
          Try again
        </button>
      </p>
    );
  }

  const { weather: w, dir } = state;
  const live = w.source === "open-meteo-live";
  // Only pair the live direction with live speed; the 2025 fallback has no direction.
  const angle = live && dir && lineBearing !== null ? windAngleToLine(dir.from_deg, lineBearing) : null;
  const r = rateCorridor(w, angle);
  const nowLow = isNum(r.now_ratio) && r.now_ratio < 1;
  const age = live && dir ? ageLabel(w.time, dir.utc_offset_s) : null;
  const wind = isNum(w.wind_ms) ? `${w.wind_ms.toFixed(1)} m/s` : DASH;
  const windText = r.angle_known && dir
    ? `Wind ${wind} from ${compass(dir.from_deg)}, ${fmtNum(r.angle_deg, 0)}° to the line`
    : `Wind ${wind}, direction not known (45° to the line assumed)`;
  const when = live
    ? `Live weather, ${fmtHour(w.time)} Pacific${age ? ` (${age})` : ""}`
    : `2025 weather for this hour (live data unavailable), ${fmtHour(w.time)}`;

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <p
          className="text-[40px] font-semibold leading-none tabular-nums"
          style={{ color: nowLow ? UI.danger : UI.accentStrong }}
        >
          {fmtRatio(r.now_ratio)}
        </p>
        <p className="min-w-0 text-[13px] leading-snug text-[#556070]">
          of its fixed {fmtNum(r.fixed_A, 0)} A rating, with today&apos;s wind halved for safety
        </p>
      </div>
      <div className="flex flex-col gap-1 border-t border-[#e6e9ee] pt-2">
        <Compare label="Temperature only" value={fmtRatio(r.still_ratio)} danger={r.still_ratio < 1} />
        <Compare label="On a 105 °F day" value={fmtRatio(r.hot_ratio)} danger={r.hot_ratio < 1} />
      </div>
      <p className="text-[13px] leading-snug tabular-nums text-[#556070]">{windText}</p>
      <p className="text-[13px] leading-snug tabular-nums text-[#556070]">{when}</p>
      <Caption>Screening estimate for a typical wire</Caption>
    </div>
  );
}
