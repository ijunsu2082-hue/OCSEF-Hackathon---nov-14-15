"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { UI } from "@/lib/scan/colors";
import { agoLabel, usePoll } from "@/lib/live/usePoll";
import type { CrossCheck, FeedStatus, LiveFeed } from "@/lib/live/types";
import type { WeatherLive } from "@/lib/live/weather";
import { cToF, fmtNum, fmtRatio, isNum } from "./format";
import { Caption, Row, Section } from "./ui";

const GRID = "#eef1f4";
const AXIS_TICK = { fill: UI.text3, fontSize: 12 };

const PILL: Record<FeedStatus, { label: string; color: string; bg: string }> = {
  live: { label: "Live", color: UI.accentStrong, bg: UI.accentSoft },
  stale: { label: "Stale", color: UI.warning, bg: "#fef3c7" },
  error: { label: "Error", color: UI.danger, bg: "#fee2e2" },
};

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg: number | null) => (isNum(deg) ? COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8] : null);

function temp(c: number | null | undefined): string {
  return isNum(c) ? `${fmtNum(c, 1)} °C (${fmtNum(cToF(c), 0)} °F)` : "—";
}

export function StatusPill({ status, ago }: { status: FeedStatus; ago: string }) {
  const p = PILL[status];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold leading-snug"
      style={{ color: p.color, background: p.bg }}
    >
      {p.label}
      {ago && <span className="font-normal">· updated {ago}</span>}
    </span>
  );
}

/** Red only for Extreme severity or Warning-level events; otherwise amber. */
function AlertBanner({ a }: { a: WeatherLive["alerts"][number] }) {
  const red = a.severity === "Extreme" || /Warning$/i.test(a.event);
  const color = red ? UI.danger : UI.warning;
  const until = a.ends ? new Date(a.ends).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  return (
    <div className="rounded-md border px-3 py-2" style={{ borderColor: color, background: red ? "#fef2f2" : "#fffbeb" }}>
      <p className="text-[14px] font-semibold leading-snug" style={{ color }}>
        {a.event}
        <span className="font-normal text-[#556070]"> · {a.severity}{until ? ` · until ${until}` : ""}</span>
      </p>
      {a.headline && <p className="mt-0.5 text-[13px] leading-snug text-[#1d2733]">{a.headline}</p>}
      {a.why && <p className="mt-0.5 text-[13px] leading-snug text-[#556070]">{a.why}</p>}
    </div>
  );
}

function CrossCheckRow({ c }: { c: CrossCheck }) {
  return (
    <div className="flex flex-col gap-0.5 py-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-[13px] leading-snug text-[#556070]">{c.quantity}</span>
        <span className="shrink-0 text-[13px] font-semibold" style={{ color: c.agree ? UI.accentStrong : UI.warning }}>
          {c.agree ? "Agrees" : "Differs"}
        </span>
      </div>
      <p className="text-[13px] leading-snug tabular-nums text-[#1d2733]">
        {c.a.provider} {fmtNum(c.a.value, 1)} {c.a.unit} vs {c.b.provider} {fmtNum(c.b.value, 1)} {c.b.unit} (difference{" "}
        {c.diff > 0 ? "+" : ""}
        {fmtNum(c.diff, 1)} {c.a.unit}; agree if {c.tolerance})
      </p>
      {c.note && <Caption>{c.note}</Caption>}
    </div>
  );
}

function HourlyChart({ hourly }: { hourly: WeatherLive["hourly"] }) {
  const t0 = Date.parse(hourly[0].time);
  const data = hourly.map((h) => ({ ...h, h: Math.round((Date.parse(h.time) - t0) / 3600_000) }));
  return (
    <div className="h-[110px] w-full">
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 420, height: 110 }}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis
            dataKey="h"
            type="number"
            domain={[0, "dataMax"]}
            ticks={[0, 6, 12, 18, 24].filter((t) => t <= data[data.length - 1].h)}
            tickFormatter={(v: number) => (v === 0 ? "now" : `+${v} h`)}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            width={36}
            domain={["auto", "auto"]}
            tickCount={3}
            tickFormatter={(v: number) => `${fmtNum(v, 0)}°`}
          />
          <Tooltip
            contentStyle={{ background: "#ffffff", border: `1px solid ${UI.border}`, borderRadius: 6, fontSize: 12, color: UI.text }}
            labelStyle={{ color: UI.text }}
            itemStyle={{ color: UI.text2 }}
            labelFormatter={(v) => (Number(v) === 0 ? "This hour" : `In ${v} h`)}
            formatter={(v) => [`${fmtNum(Number(v), 0)} °C`, "Forecast air temperature"]}
          />
          <Line type="monotone" dataKey="tempC" stroke={UI.accent} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Poll result for the weather feed, as returned by usePoll<WeatherLive>(). */
export interface WeatherPoll {
  feed: LiveFeed<WeatherLive> | null;
  error: string | null;
  ageSec: number | null;
}

/** Route this component polls; null when the inputs are not numbers. */
export function liveWeatherUrl(lat: number, lon: number, radiusMi: number): string | null {
  return isNum(lat) && isNum(lon) && isNum(radiusMi)
    ? `/api/live/weather?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&r=${radiusMi}`
    : null;
}

/**
 * Pass `feed` when a parent already polls /api/live/weather (no second poll is started), and
 * `bare` to drop the outer Section when the parent supplies its own heading.
 */
export function LiveWeather({
  lat,
  lon,
  radiusMi,
  feed: given,
  bare = false,
}: {
  lat: number;
  lon: number;
  radiusMi: number;
  feed?: WeatherPoll;
  bare?: boolean;
}) {
  const own = usePoll<WeatherLive>(given ? null : liveWeatherUrl(lat, lon, radiusMi), 300);
  const { feed, error, ageSec } = given ?? own;
  const d = feed?.data ?? null;
  const status: FeedStatus = feed ? feed.status : error ? "error" : "live";

  const body = (
    <div className="flex flex-col gap-5">
      {/* Bare: the parent's summary line already shows the status pill. */}
      {(!bare || (error && feed)) && (
        <div className="flex flex-wrap items-center gap-2">
          {bare ? null : feed || error ? (
            <StatusPill status={status} ago={agoLabel(ageSec)} />
          ) : (
            <span className="text-[13px] text-[#556070]">Loading live weather…</span>
          )}
          {error && feed && <span className="text-[12px] text-[#6b7583]">Last refresh failed ({error}); showing last good data.</span>}
        </div>
      )}

      {!d && (error || feed) && (
        <p className="text-[14px] leading-snug text-[#1d2733]">
          Live weather is not available right now{feed?.errors.length ? `: ${feed.errors.join(" ")}` : error ? ` (${error}).` : "."}
        </p>
      )}

      {d && (
        <>
          {d.alerts.filter((a) => a.gridRelevant).length > 0 && (
            <div className="flex flex-col gap-2">
              {d.alerts.filter((a) => a.gridRelevant).map((a) => (
                <AlertBanner key={a.id} a={a} />
              ))}
            </div>
          )}

          <div className="flex flex-col gap-0.5">
            <h4 className="mb-1 text-[14px] font-semibold leading-snug text-[#1d2733]">Right now at the center</h4>
            <Row label="Air temperature" value={<span className="text-[#0284c7]">{temp(d.center.tempC)}</span>} />
            <Row
              label="Wind"
              value={
                <span className="text-[#0284c7]">
                  {isNum(d.center.windMs) ? `${fmtNum(d.center.windMs, 1)} m/s` : "—"}
                  {compass(d.center.windDirDeg) && (d.center.windMs ?? 0) > 0 ? ` from ${compass(d.center.windDirDeg)}` : ""}
                  {isNum(d.center.gustMs) && d.center.gustMs > 0 ? `, gusts ${fmtNum(d.center.gustMs, 1)} m/s` : ""}
                </span>
              }
            />
            <Row
              label="Sunlight (model)"
              value={<span className="text-[#0284c7]">{isNum(d.center.sunWm2) ? `${fmtNum(d.center.sunWm2, 0)} W/m²` : "—"}</span>}
            />
            {d.tempRange && (
              <Row
                label="Across the circle (5 points)"
                value={<span className="text-[#0284c7]">{`${fmtNum(d.tempRange.minC, 1)}–${fmtNum(d.tempRange.maxC, 1)} °C`}</span>}
              />
            )}
            <Caption className="mt-1">
              {d.center.station
                ? `Observed at NWS station ${d.center.station.name} (${d.center.station.id}), ${fmtNum(d.center.station.distanceMi, 1)} mi from center.`
                : "No NWS station observation; values are Open-Meteo model estimates."}
              {d.center.observedAt ? ` Reading time ${new Date(d.center.observedAt).toLocaleString()}.` : ""}
            </Caption>
          </div>

          {d.samples.length > 0 && (
            <div className="flex flex-col gap-2">
              <h4 className="text-[14px] font-semibold leading-snug text-[#1d2733]">Line rating across the circle</h4>
              <table className="w-full border-collapse text-[13px] tabular-nums">
                <thead>
                  <tr className="border-b border-[#e6e9ee] text-left text-[12px] text-[#556070]">
                    <th className="py-1 font-normal">Point</th>
                    <th className="py-1 text-right font-normal">Air</th>
                    <th className="py-1 text-right font-normal">Wind</th>
                    <th className="py-1 text-right font-normal">Temp-adjusted</th>
                    <th className="py-1 text-right font-normal">Wind-based</th>
                  </tr>
                </thead>
                <tbody>
                  {d.samples.map((s) => {
                    const worst = d.worst?.label === s.label;
                    return (
                      <tr key={s.label} className={`border-b border-[#e6e9ee] ${worst ? "bg-[#f6f8fa]" : ""}`}>
                        <td className="py-1 text-[#1d2733]">
                          {s.label}
                          {worst && <span className="ml-1 text-[12px] text-[#556070]">(lowest)</span>}
                        </td>
                        <td className="py-1 text-right text-[#1d2733]">{fmtNum(s.tempC, 1)} °C</td>
                        <td className="py-1 text-right text-[#1d2733]">{fmtNum(s.windMs, 1)} m/s</td>
                        <td className="py-1 text-right font-semibold text-[#0284c7]">{fmtRatio(s.ratio.aar)}</td>
                        <td className="py-1 text-right font-semibold text-[#0284c7]">{fmtRatio(s.ratio.dlr)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {d.worst && (
                <p className="text-[14px] leading-snug text-[#1d2733]">
                  Lowest in the circle: {d.worst.label}, {fmtRatio(Math.min(d.worst.aar, d.worst.dlr))} the fixed 40 °C
                  worst-case rating.
                </p>
              )}
              <Caption>
                Ratios vs a fixed 40 °C, 0.61 m/s, full-sun rating for a Drake conductor (our IEEE 738 screening model, not
                an operating rating). Temp-adjusted = air temperature only (FERC Order 881 style); wind-based = real wind
                halved for safety. North/South/East/West points sit at 0.6 × the scan radius.
              </Caption>
            </div>
          )}

          {d.hourly.length > 1 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-[14px] font-semibold leading-snug text-[#1d2733]">Next 24 hours</h4>
              <HourlyChart hourly={d.hourly} />
            </div>
          )}

          {feed && feed.crossChecks.length > 0 && (
            <div className="flex flex-col">
              <h4 className="mb-1 text-[14px] font-semibold leading-snug text-[#1d2733]">Cross-checks</h4>
              {feed.crossChecks.map((c) => (
                <CrossCheckRow key={c.quantity} c={c} />
              ))}
            </div>
          )}
        </>
      )}

      {feed && feed.errors.length > 0 && d && (
        <ul className="flex flex-col gap-0.5">
          {feed.errors.map((e) => (
            <li key={e} className="text-[12px] leading-snug text-[#b45309]">
              {e}
            </li>
          ))}
        </ul>
      )}

      {feed && feed.providers.length > 0 && (
        <Caption>
          Sources:{" "}
          {feed.providers.map((p, i) => (
            <span key={p.id}>
              {i > 0 && " · "}
              <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-[#0369a1] underline">
                {p.name}
              </a>
            </span>
          ))}
        </Caption>
      )}
    </div>
  );

  if (bare) return body;
  return (
    <Section title="Live weather" subtitle="National Weather Service, cross-checked with Open-Meteo">
      {body}
    </Section>
  );
}

export default LiveWeather;
