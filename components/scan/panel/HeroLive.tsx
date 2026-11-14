"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { UI } from "@/lib/scan/colors";
import type { DailyRating, LineRatingNow, ScanResult, WeatherNow } from "@/lib/scan";
import { DASH, fmtNum, fmtPct, fmtRatio, isNum, monthTick } from "./format";
import { Caption, Section } from "./ui";

const GRID = "#eef1f4";
const FIXED = "#94a3b8";
const AXIS_TICK = { fill: UI.text3, fontSize: 12 };

function weatherLine(w: WeatherNow): string {
  const temp = isNum(w.temp_c) ? `${w.temp_c.toFixed(1)} °C` : DASH;
  const wind = `wind ${isNum(w.wind_ms) ? w.wind_ms.toFixed(1) : DASH} m/s`;
  const sun = `sun ${isNum(w.sun_wm2) ? fmtNum(w.sun_wm2, 0) : DASH} W/m²`;
  if (w.source === "heatwave-scenario") return `105 °F heatwave scenario, ${wind}, ${sun}`;
  if (w.source === "fallback-2024") return `2024 weather (live data unavailable): ${temp}, ${wind}, ${sun}`;
  return `Live weather ${temp}, ${wind}, ${sun}`;
}

/** "2024-09-06T13:00" -> "Sep 6, 1 pm" (no Date parsing so no TZ drift). */
function hottestLabel(iso: string | null | undefined): string | null {
  const m = iso ? /^\d{4}-(\d{2})-(\d{2})(?:T(\d{2}))?/.exec(iso) : null;
  if (!m) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = `${months[Number(m[1]) - 1] ?? m[1]} ${Number(m[2])}`;
  if (m[3] === undefined) return date;
  const h = Number(m[3]);
  return `${date}, ${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "am" : "pm"}`;
}

function LiveBlock({ live, liveLoading }: { live: LineRatingNow | null; liveLoading: boolean }) {
  if (liveLoading || !live) {
    return (
      <p className="text-[14px] text-[#556070]" aria-busy={liveLoading}>
        {liveLoading ? "Getting live weather…" : "Live rating unavailable."}
      </p>
    );
  }

  const ratio = live.ratio;
  const over = isNum(ratio) && ratio < 1;
  const pct = isNum(live.extra_pct) ? Math.abs(live.extra_pct) : null;

  return (
    <div className="flex flex-col gap-2">
      <p
        className="text-[40px] font-semibold leading-none tabular-nums"
        style={{ color: over ? UI.danger : UI.accentStrong }}
      >
        {fmtRatio(ratio)}
      </p>
      <p className="text-[14px] leading-snug text-[#1d2733]">
        {pct === null
          ? "Live rating could not be computed for this spot."
          : over
            ? `In this heat the fixed rating is ${fmtNum(pct, 0)}% too high. Lines would overheat.`
            : `Lines here can safely carry ${fmtNum(pct, 0)}% more than their fixed rating right now.`}
      </p>
      <p className="text-[13px] leading-snug tabular-nums text-[#556070]">{weatherLine(live.weather)}</p>
    </div>
  );
}

/** First date of Jan / Apr / Jul / Oct present in the series. */
function quarterTicks(daily: DailyRating[]): string[] {
  const seen = new Set<string>();
  const ticks: string[] = [];
  for (const d of daily) {
    const mm = String(d.date).slice(5, 7);
    if (["01", "04", "07", "10"].includes(mm) && !seen.has(mm)) {
      seen.add(mm);
      ticks.push(d.date);
    }
  }
  return ticks;
}

function DailyChart({ daily, staticA }: { daily: DailyRating[]; staticA: number }) {
  return (
    <div className="h-[120px] w-full">
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 420, height: 120 }}>
        <LineChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis
            dataKey="date"
            ticks={quarterTicks(daily)}
            tickFormatter={monthTick}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            width={40}
            domain={[0, "auto"]}
            tickCount={3}
            tickFormatter={(v: number) => fmtNum(v, 0)}
          />
          <Tooltip
            contentStyle={{
              background: "#ffffff",
              border: `1px solid ${UI.border}`,
              borderRadius: 6,
              fontSize: 12,
              color: UI.text,
            }}
            labelStyle={{ color: UI.text }}
            itemStyle={{ color: UI.text2 }}
            formatter={(v) => [`${fmtNum(Number(v), 0)} A`, "Worst-hour safe rating"]}
          />
          <ReferenceLine y={staticA} stroke={FIXED} strokeDasharray="4 4" strokeWidth={1} />
          <Line
            type="monotone"
            dataKey="worst_A"
            stroke={UI.accent}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
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
  const beat = site.pct_hours_conservative_dlr_above_static;
  const beatDigits = isNum(beat) && Math.round(beat * 10) % 10 === 0 ? 0 : 1;

  const hottest = hottestLabel(site.hottest_hour);
  const hotRatio = site.hottest_hour_dlr_vs_static;

  return (
    <Section
      title="Line capacity right now"
      subtitle="The Wire That Breathes"
      sources={["openmeteo_live", "era5_2024", "ieee738"]}
    >
      <LiveBlock live={live} liveLoading={liveLoading} />

      <div className="mt-6">
        <p className="mb-2 text-[13px] leading-snug text-[#556070]">
          Each day&apos;s worst-hour safe rating in 2024, against the fixed rating of{" "}
          <span className="tabular-nums">{fmtNum(staticA, 0)} A</span> (dashed).
        </p>
        {daily && daily.length > 0 ? (
          <DailyChart daily={daily} staticA={staticA} />
        ) : (
          <p className="text-[14px] text-[#556070]">Loading…</p>
        )}
        <Caption className="mt-3 tabular-nums">
          2024 at {site.name} ({fmtNum(site.distance_mi, 1)} mi away): safe rating beat the fixed rating in{" "}
          {fmtPct(beat, beatDigits)} of hours. Modeled with IEEE 738.
        </Caption>
        {hottest && (
          <p className="mt-1 text-[13px] leading-snug tabular-nums text-[#556070]">
            On the hottest 2024 hour ({hottest}, {fmtNum(site.hottest_temp_c, 0)} °C) the safe rating was{" "}
            <span style={hotRatio < 1 ? { color: "#dc2626" } : undefined}>{fmtRatio(hotRatio)}</span> the fixed rating.
          </p>
        )}
      </div>
    </Section>
  );
}
