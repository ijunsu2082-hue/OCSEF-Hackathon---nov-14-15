"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { UI } from "@/lib/scan/colors";
import { agoLabel, usePoll } from "@/lib/live/usePoll";
import type { CrossCheck, FeedStatus } from "@/lib/live/types";
import type { GridFuel, GridLive } from "@/lib/live/grid";
import { fmtNum, fmtPct, fmtPowerText, isNum } from "./format";
import { Caption, Row, Section } from "./ui";

const GRID = "#eef1f4";
const AXIS_TICK = { fill: UI.text3, fontSize: 12 };

const PILL: Record<FeedStatus, { label: string; color: string; bg: string }> = {
  live: { label: "Live", color: UI.accentStrong, bg: UI.accentSoft },
  stale: { label: "Stale", color: UI.warning, bg: "#fef3c7" },
  error: { label: "Error", color: UI.danger, bg: "#fee2e2" },
};

/** "2026-11-15T01:00:00Z" -> "5 PM" style local hour label, plus date when not today. */
function hourLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function StatusPill({ status, ago }: { status: FeedStatus; ago: string }) {
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

function CrossCheckRow({ c }: { c: CrossCheck }) {
  const unit = c.a.unit;
  return (
    <div className="flex flex-col gap-0.5 py-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-[13px] leading-snug text-[#556070]">{c.quantity}</span>
        <span className="shrink-0 text-[13px] font-semibold" style={{ color: c.agree ? UI.accentStrong : UI.warning }}>
          {c.agree ? "Agrees" : "Differs"}
        </span>
      </div>
      <p className="text-[13px] leading-snug tabular-nums text-[#1d2733]">
        {c.a.provider} {fmtNum(c.a.value, unit === "%" ? 1 : 0)} {unit} vs {c.b.provider} {fmtNum(c.b.value, unit === "%" ? 1 : 0)}{" "}
        {c.b.unit} (difference {c.diff > 0 ? "+" : ""}
        {fmtNum(c.diff, unit === "%" ? 1 : 0)} {unit === "%" ? "points" : unit}
        {isNum(c.diffPct) ? `, ${c.diffPct > 0 ? "+" : ""}${fmtNum(c.diffPct, 1)}%` : ""}; agree if {c.tolerance})
      </p>
      {c.note && <Caption>{c.note}</Caption>}
    </div>
  );
}

function FuelBars({ mix }: { mix: GridFuel[] }) {
  const shown = mix.filter((f) => f.pct > 0);
  return (
    <div className="flex flex-col gap-1">
      {shown.map((f) => (
        <div key={f.fuel} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_minmax(0,6.5rem)] items-center gap-2">
          <span className="truncate text-[13px] leading-snug text-[#556070]">{f.fuel}</span>
          <div className="h-2 w-full rounded-sm" style={{ background: GRID }}>
            <div className="h-2 rounded-sm" style={{ width: `${Math.min(100, f.pct)}%`, background: UI.accent }} />
          </div>
          <span className="text-right text-[13px] font-semibold tabular-nums text-[#0284c7]">
            {fmtPct(f.pct, 0)} <span className="font-normal text-[#556070]">· {fmtPowerText(f.mw)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function DemandChart({ series }: { series: GridLive["series"] }) {
  const tEnd = Date.parse(series[series.length - 1].period);
  const data = series.map((s) => ({ ...s, h: Math.round((Date.parse(s.period) - tEnd) / 3600_000) }));
  const minH = data[0].h;
  return (
    <div className="h-[130px] w-full">
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 420, height: 130 }}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis
            dataKey="h"
            type="number"
            domain={[minH, 0]}
            ticks={[-48, -36, -24, -12, 0].filter((t) => t >= minH)}
            tickFormatter={(v: number) => (v === 0 ? "latest" : `${v} h`)}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            width={52}
            domain={["auto", "auto"]}
            tickCount={3}
            tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${fmtNum(v / 1000, 0)} GW` : `${fmtNum(v, 0)}`)}
          />
          <Tooltip
            contentStyle={{ background: "#ffffff", border: `1px solid ${UI.border}`, borderRadius: 6, fontSize: 12, color: UI.text }}
            labelStyle={{ color: UI.text }}
            itemStyle={{ color: UI.text2 }}
            labelFormatter={(v) => {
              const row = data.find((d) => d.h === Number(v));
              return row ? `Hour ending ${hourLabel(row.period)}` : "";
            }}
            formatter={(v, name) => [fmtPowerText(Number(v)), name === "demandMW" ? "Demand" : "Day-ahead forecast"]}
          />
          <Line type="monotone" dataKey="forecastMW" stroke={UI.text3} strokeWidth={1.25} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
          <Line type="monotone" dataKey="demandMW" stroke={UI.accent} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function liveGridUrl(lat: number, lon: number): string | null {
  return isNum(lat) && isNum(lon) ? `/api/live/grid?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}` : null;
}

export type GridPoll = ReturnType<typeof usePoll<GridLive>>;

/** `feed`: a poll owned by the caller (no second request). `bare`: no Section chrome or pill (the caller shows them). */
export function LiveGrid({ lat, lon, feed: given, bare = false }: { lat: number; lon: number; feed?: GridPoll; bare?: boolean }) {
  const own = usePoll<GridLive>(given ? null : liveGridUrl(lat, lon), 300);
  const { feed, error, ageSec } = given ?? own;
  const d = feed?.data ?? null;
  const status: FeedStatus = feed ? feed.status : error ? "error" : "live";
  const subtitle = d
    ? `${d.ba.name} (${d.ba.code}) · EIA hourly data${d.caiso ? ", cross-checked with CAISO 5-minute data" : ""}`
    : "Balancing authority operations from EIA, cross-checked where a second source exists";

  const body = (
      <div className="flex flex-col gap-5">
        {bare && <Caption>{subtitle}</Caption>}
        <div className={`flex flex-wrap items-center gap-2 ${bare && !(error && feed) ? "hidden" : ""}`}>
          {feed || error ? (
            <StatusPill status={status} ago={agoLabel(ageSec)} />
          ) : (
            <span className="text-[13px] text-[#556070]">Loading live grid…</span>
          )}
          {error && feed && <span className="text-[12px] text-[#6b7583]">Last refresh failed ({error}); showing last good data.</span>}
        </div>

        {!d && (error || feed) && (
          <p className="text-[14px] leading-snug text-[#1d2733]">
            Live grid data is not available right now{feed?.errors.length ? `: ${feed.errors.join(" ")}` : error ? ` (${error}).` : "."}
          </p>
        )}

        {d && (
          <>
            <div className="flex flex-col gap-0.5">
              <h4 className="mb-1 text-[14px] font-semibold leading-snug text-[#1d2733]">
                {d.latest.period ? `Hour ending ${hourLabel(d.latest.period)}` : "Latest hour"}
              </h4>
              <Row label="Demand" value={<span className="text-[#0284c7]">{fmtPowerText(d.latest.demandMW)}</span>} />
              <Row label="Day-ahead forecast" value={<span className="text-[#0284c7]">{fmtPowerText(d.latest.forecastMW)}</span>} />
              {isNum(d.latest.netGenMW) && (
                <Row label="Net generation" value={<span className="text-[#0284c7]">{fmtPowerText(d.latest.netGenMW)}</span>} />
              )}
              {isNum(d.latest.interchangeMW) && (
                <Row
                  label={d.latest.interchangeMW >= 0 ? "Net export to neighbors" : "Net import from neighbors"}
                  value={<span className="text-[#0284c7]">{fmtPowerText(Math.abs(d.latest.interchangeMW))}</span>}
                />
              )}
              {d.caiso && (
                <Row
                  label={`CAISO demand, ${hourLabel(d.caiso.asOf)} (5-minute)`}
                  value={<span className="text-[#0284c7]">{fmtPowerText(d.caiso.demandMW)}</span>}
                />
              )}
              {isNum(d.cleanSharePct) && (
                <>
              <Row label={`Clean share, ${hourLabel(d.cleanShareAsOf ?? d.fuelMixPeriod ?? d.latest.period)}`} value={<span className="text-[#0284c7]">{fmtPct(d.cleanSharePct, 0)}</span>} />
              <Caption className="mt-1">
                Clean share = solar, wind, hydro, nuclear and battery discharge as a share of in-area generation
                {d.cleanShareAsOf && d.cleanShareSource
                  ? `, from the freshest fuel data available: ${d.cleanShareSource} ${d.cleanShareAsOf === d.fuelMixPeriod ? "for the hour ending" : "at"} ${hourLabel(d.cleanShareAsOf)}`
                  : d.fuelMixPeriod
                    ? `, for the hour ending ${hourLabel(d.fuelMixPeriod)} (EIA's latest fuel data)`
                    : ""}
                .
              </Caption>
                </>
              )}
            </div>

            {d.series.length > 1 && (
              <div className="flex flex-col gap-1">
                <h4 className="text-[14px] font-semibold leading-snug text-[#1d2733]">Last 48 hours</h4>
                <DemandChart series={d.series} />
                <Caption>Solid: demand. Dashed: day-ahead forecast. Hourly, EIA.</Caption>
              </div>
            )}

            {d.fuelMix.length > 0 && (
              <div className="flex flex-col gap-2">
                <h4 className="text-[14px] font-semibold leading-snug text-[#1d2733]">Fuel mix (EIA)</h4>
                <FuelBars mix={d.fuelMix} />
                {d.fuelMixPeriod && <Caption>Hour ending {hourLabel(d.fuelMixPeriod)}. Imports not included.</Caption>}
              </div>
            )}

            {d.caiso && d.caiso.fuelMix.length > 0 && (
              <div className="flex flex-col gap-2">
                <h4 className="text-[14px] font-semibold leading-snug text-[#1d2733]">Fuel mix right now (CAISO)</h4>
                <FuelBars mix={d.caiso.fuelMix} />
                <Caption>
                  5-minute reading at {hourLabel(d.caiso.asOf)}. Imports not included
                  {isNum(d.caiso.importsMW) ? ` (imports ${fmtPowerText(d.caiso.importsMW)})` : ""}.
                </Caption>
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

            <Caption>How we found the balancing authority: {d.ba.method}.</Caption>
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
    <Section title="Live grid" subtitle={subtitle}>
      {body}
    </Section>
  );
}

export default LiveGrid;
