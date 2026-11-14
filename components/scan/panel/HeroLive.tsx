"use client";

import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyRating, LineRatingNow, ScanResult, WeatherNow } from "@/lib/scan";
import { DASH, cToF, fmtHour, fmtNum, fmtPct, fmtRatio, isNum, monthTick } from "./format";
import { Shimmer, SrcTag } from "./ui";

const SOURCE_BADGE: Record<WeatherNow["source"], { label: string; color: string }> = {
  "open-meteo-live": { label: "LIVE · Open-Meteo", color: "var(--accent)" },
  "fallback-2024": { label: "2024 fallback", color: "var(--warn)" },
  "heatwave-scenario": { label: "105 °F HEATWAVE SCENARIO", color: "var(--critical)" },
};

function SourceBadge({ source }: { source: WeatherNow["source"] }) {
  const b = SOURCE_BADGE[source] ?? { label: source, color: "var(--muted)" };
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 font-mono text-[9.5px] font-semibold uppercase leading-[18px] tracking-[0.1em]"
      style={{ color: b.color, borderColor: `color-mix(in srgb, ${b.color} 45%, transparent)` }}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: b.color }} />
      {b.label}
    </span>
  );
}

function WeatherCell({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">{label}</span>
      <span className="num text-[13px] font-semibold text-ink">
        {value}
        <span className="ml-1 text-[10px] font-medium text-muted">{unit}</span>
      </span>
    </div>
  );
}

function LiveBlock({ live, liveLoading }: { live: LineRatingNow | null; liveLoading: boolean }) {
  if (liveLoading || !live) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <div className="flex items-end gap-3">
          <Shimmer className="h-[52px] w-[150px]" />
          <Shimmer className="h-[34px] flex-1" />
        </div>
        <Shimmer className="h-[38px] w-full" />
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
          {liveLoading ? "Fetching weather at this spot…" : "Live rating unavailable"}
        </p>
      </div>
    );
  }

  const ratio = live.ratio;
  const over = isNum(ratio) && ratio < 1;
  const tone = over ? "var(--critical)" : "var(--accent)";
  const pct = isNum(live.extra_pct) ? Math.abs(live.extra_pct) : null;
  const w = live.weather;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-3">
        <span className="num text-[52px] font-semibold leading-[0.9] tracking-tight" style={{ color: tone }}>
          {fmtRatio(ratio)}
        </span>
        <p className="pb-1 text-[12.5px] leading-snug text-ink">
          {pct === null ? (
            "Live rating could not be computed for this spot."
          ) : over ? (
            <>
              Right now the fixed rating is{" "}
              <strong className="num" style={{ color: "var(--critical)" }}>
                {fmtNum(pct, 0)}% TOO HIGH
              </strong>{" "}
              — the wire would overheat.
            </>
          ) : (
            <>
              Right now the power lines here can safely carry{" "}
              <strong className="num" style={{ color: "var(--accent)" }}>
                {fmtNum(pct, 0)}% more
              </strong>{" "}
              than their fixed rating.
            </>
          )}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-[var(--radius-sm)] border border-line bg-bg-elevated px-3 py-2">
        <WeatherCell
          label="Air"
          value={isNum(w.temp_c) ? `${w.temp_c.toFixed(1)} °C` : DASH}
          unit={isNum(w.temp_c) ? `${Math.round(cToF(w.temp_c))} °F` : ""}
        />
        <WeatherCell label="Wind" value={isNum(w.wind_ms) ? w.wind_ms.toFixed(1) : DASH} unit="m/s" />
        <WeatherCell label="Sun" value={isNum(w.sun_wm2) ? fmtNum(w.sun_wm2, 0) : DASH} unit="W/m²" />
      </div>

      <div className="grid grid-cols-3 gap-2 text-[10.5px]">
        <div className="flex flex-col">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">Fixed rating</span>
          <span className="num text-ink-dim">{fmtNum(live.static_A, 0)} A</span>
        </div>
        <div className="flex flex-col">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">Safe now</span>
          <span className="num font-semibold" style={{ color: tone }}>
            {fmtNum(live.dlr_conservative_A, 0)} A
          </span>
        </div>
        <div className="flex flex-col">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">Weather time</span>
          <span className="num truncate text-ink-dim">{fmtHour(w.time)}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SourceBadge source={w.source} />
        <SrcTag kind="MODELED" />
        <span className="text-[10px] text-muted">ACSR Drake conductor, IEEE 738, wind halved for safety</span>
      </div>
    </div>
  );
}

function DailyChart({ daily, staticA }: { daily: DailyRating[]; staticA: number }) {
  return (
    <div className="h-[140px] w-full">
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 380, height: 140 }}>
        <ComposedChart data={daily} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="date"
            tickFormatter={monthTick}
            interval={30}
            tick={{ fill: "var(--muted)", fontSize: 9, fontFamily: "var(--font-mono)" }}
            axisLine={{ stroke: "var(--border)" }}
            tickLine={false}
            minTickGap={8}
          />
          <YAxis
            tick={{ fill: "var(--muted)", fontSize: 9, fontFamily: "var(--font-mono)" }}
            axisLine={false}
            tickLine={false}
            width={30}
            domain={[0, "auto"]}
            tickCount={4}
            tickFormatter={(v: number) => (v >= 1000 ? `${fmtNum(v / 1000, 1)}k` : fmtNum(v, 0))}
          />
          <Tooltip
            contentStyle={{
              background: "var(--panel-raised)",
              border: "1px solid var(--border-strong)",
              borderRadius: 6,
              fontSize: 11,
              fontFamily: "var(--font-mono)",
            }}
            labelStyle={{ color: "var(--text)" }}
            itemStyle={{ color: "var(--text-dim)" }}
            formatter={(v) => [`${fmtNum(Number(v), 0)} A`]}
          />
          <Area
            type="monotone"
            dataKey="median_A"
            name="Median hour"
            stroke="var(--accent)"
            strokeWidth={1}
            fill="var(--accent)"
            fillOpacity={0.12}
            isAnimationActive={false}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="worst_A"
            name="Worst hour"
            stroke="var(--warn)"
            strokeWidth={1.25}
            dot={false}
            isAnimationActive={false}
          />
          <ReferenceLine
            y={staticA}
            stroke="var(--critical)"
            strokeDasharray="4 3"
            strokeWidth={1}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HeroLive({
  result,
  live,
  liveLoading,
  daily,
}: {
  result: ScanResult;
  live: LineRatingNow | null;
  liveLoading: boolean;
  daily: DailyRating[] | null;
}) {
  const site = result.rating_site;
  const staticA = daily?.find((d) => isNum(d.static_A))?.static_A ?? live?.static_A ?? 723;
  const daysBelow = daily ? daily.filter((d) => isNum(d.worst_A) && d.worst_A < d.static_A).length : null;

  return (
    <section className="rounded-[var(--radius-md)] border border-line-strong bg-panel p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-dim">
          The Wire That Breathes <span className="text-muted">·</span>{" "}
          <span className="text-accent">
            {live?.weather.source === "heatwave-scenario"
              ? "scenario"
              : live?.weather.source === "fallback-2024"
                ? "2024 data"
                : "live"}
          </span>
        </p>
        <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted">dynamic line rating</span>
      </div>

      <LiveBlock live={live} liveLoading={liveLoading} />

      <div className="mt-4 border-t border-line pt-3">
        <div className="mb-1 flex items-center gap-3 font-mono text-[9px] uppercase tracking-[0.12em] text-muted">
          <span className="flex items-center gap-1">
            <span className="inline-block h-[2px] w-3" style={{ background: "var(--warn)" }} /> daily worst hour
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 opacity-40" style={{ background: "var(--accent)" }} /> median hour
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 border-t border-dashed" style={{ borderColor: "var(--critical)" }} /> fixed{" "}
            <span className="num">{fmtNum(staticA, 0)} A</span>
          </span>
          <SrcTag kind="MODELED" className="ml-auto" />
        </div>
        {daily && daily.length > 0 ? (
          <DailyChart daily={daily} staticA={staticA} />
        ) : (
          <Shimmer className="h-[140px] w-full" />
        )}
        <p className="mt-2 text-[11.5px] leading-snug text-ink-dim">
          2024 at <span className="text-ink">{site.name}</span>{" "}
          <span className="num text-muted">({fmtNum(site.distance_mi, 1)} mi away)</span>: safe rating beat the fixed
          rating in{" "}
          <strong className="num text-accent">{fmtPct(site.pct_hours_conservative_dlr_above_static, 1)}</strong> of
          hours.
        </p>
        <p className="mt-1 text-[10.5px] leading-snug text-muted">
          Hottest hour <span className="num text-ink-dim">{fmtHour(site.hottest_hour)}</span> at{" "}
          <span className="num text-ink-dim">
            {isNum(site.hottest_temp_c) ? `${site.hottest_temp_c.toFixed(1)} °C` : DASH}
          </span>{" "}
          — safe rating was{" "}
          <span
            className="num"
            style={{
              color:
                isNum(site.hottest_hour_dlr_vs_static) && site.hottest_hour_dlr_vs_static < 1
                  ? "var(--critical)"
                  : "var(--text-dim)",
            }}
          >
            {fmtRatio(site.hottest_hour_dlr_vs_static)}
          </span>{" "}
          the fixed rating.
          {daysBelow !== null && daysBelow > 0 && (
            <>
              {" "}
              On <span className="num" style={{ color: "var(--critical)" }}>{daysBelow}</span>{" "}
              {daysBelow === 1 ? "day" : "days"} the worst hour fell below it.
            </>
          )}
        </p>
      </div>
    </section>
  );
}
