"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Panel } from "@/components/ui/kit";
import { loadLineRatingCsv } from "@/lib/gridLayers";
import type { NicheCase } from "@/lib/niche";

interface RatingPoint {
  date: string;
  median: number;
  min: number;
}

/** Daily summary of the hourly `dlr_conservative_vs_static` column. */
export function dailyRatingSeries(csv: string): RatingPoint[] {
  const rows = csv.split(/\r?\n/);
  if (rows.length < 2) return [];
  const header = rows[0].split(",");
  const timeIndex = header.indexOf("time");
  const ratioIndex = header.indexOf("dlr_conservative_vs_static");
  if (timeIndex < 0 || ratioIndex < 0) return [];

  const groups = new Map<string, number[]>();
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const cells = row.split(",");
    const time = cells[timeIndex];
    const ratio = Number(cells[ratioIndex]);
    if (!time || !Number.isFinite(ratio)) continue;
    const day = time.slice(0, 10);
    const bucket = groups.get(day);
    if (bucket) bucket.push(ratio);
    else groups.set(day, [ratio]);
  }

  const points: RatingPoint[] = [];
  for (const [date, values] of groups) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    points.push({ date, median, min: sorted[0] });
  }
  return points;
}

function monthLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("en-US", { month: "short" });
}

function RatingChart({ url }: { url: string }) {
  const [points, setPoints] = useState<RatingPoint[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setPoints(null);
    setFailed(false);
    loadLineRatingCsv(url)
      .then((text) => {
        if (alive) setPoints(dailyRatingSeries(text));
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [url]);

  const interval = useMemo(
    () => Math.max(1, Math.floor((points?.length ?? 0) / 6)),
    [points],
  );

  if (failed) {
    return (
      <p className="facility-note">
        Hourly rating file unavailable at <span className="mono">{url}</span>.
      </p>
    );
  }
  if (!points) {
    return <p className="facility-note">Loading the 8,784-hour 2024 series…</p>;
  }

  return (
    <div className="chart-card">
      <div className="chart-legend">
        <span>
          <i style={{ background: "var(--accent)" }} aria-hidden /> daily median
        </span>
        <span>
          <i style={{ background: "var(--critical)" }} aria-hidden /> daily minimum
        </span>
        <span>
          <i style={{ background: "var(--muted)" }} aria-hidden /> fixed rating = 1×
        </span>
      </div>
      <ResponsiveContainer width="100%" height={176}>
        <LineChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: -24 }}>
          <XAxis
            dataKey="date"
            interval={interval}
            tickFormatter={monthLabel}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            tick={{ fill: "var(--muted)", fontSize: 9 }}
            minTickGap={12}
          />
          <YAxis
            domain={[0.8, 1.9]}
            ticks={[1, 1.25, 1.5, 1.75]}
            tickFormatter={(value: number) => `${value}×`}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--muted)", fontSize: 9 }}
          />
          <ReferenceLine y={1} stroke="var(--muted)" strokeDasharray="4 4" />
          <Tooltip
            contentStyle={{
              background: "var(--panel-raised)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 10,
              color: "var(--text)",
            }}
            labelFormatter={(label) => String(label)}
            formatter={(value) => `${Number(value).toFixed(2)}×`}
          />
          <Line
            type="monotone"
            dataKey="median"
            stroke="var(--accent)"
            strokeWidth={1.6}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="min"
            stroke="var(--critical)"
            strokeWidth={1}
            strokeOpacity={0.7}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="chart-foot">
        Modeled, not a utility operating rating: simplified IEEE 738 heat balance for a
        typical ACSR “Drake” conductor at 75 °C, driven by real 2024 hourly reanalysis
        weather with wind halved for safety.
      </p>
    </div>
  );
}

interface Props {
  nicheCase: NicheCase | null;
}

/**
 * Drawer view of one niche case — README §4.7. Every number shows its
 * MEASURED / MODELED tag and its source; there is no untagged figure.
 */
export default function NicheCaseTab({ nicheCase }: Props) {
  if (!nicheCase) {
    return (
      <Panel title="Niche cases" hint="loading">
        <p className="facility-note">
          The niche-case cards load from <span className="mono">/layers/niche_cases.json</span>.
          Pick a diamond on the map to open one.
        </p>
      </Panel>
    );
  }

  return (
    <>
      <Panel title="The story" hint={nicheCase.category}>
        <p className="niche-liner">{nicheCase.one_liner}</p>
        <p className="niche-location">
          <span className="mono">{nicheCase.location.lat.toFixed(4)}, {nicheCase.location.lon.toFixed(4)}</span>
          {` · ${nicheCase.location.distance_mi} mi from Westminster HS`}
        </p>
      </Panel>

      <Panel title="The hidden problem">
        <p className="niche-body">{nicheCase.problem}</p>
      </Panel>

      <Panel title="The fix">
        <p className="niche-body">{nicheCase.fix}</p>
        <blockquote className="niche-quote">{nicheCase.shock_line}</blockquote>
      </Panel>

      <Panel title="The numbers" hint="every figure tagged">
        <ul className="niche-stats">
          {nicheCase.stats.map((stat) => (
            <li className="niche-stat" key={stat.label}>
              <div className="niche-stat-head">
                <b>{stat.value}</b>
                <span className={`tag tag-${stat.kind}`}>{stat.kind}</span>
              </div>
              <span className="niche-stat-label">{stat.label}</span>
              <small>{stat.source}</small>
            </li>
          ))}
        </ul>
      </Panel>

      {nicheCase.chart?.kind === "line_rating" ? (
        <Panel title="Safe rating vs fixed rating, 2024" hint="modeled · hourly">
          <RatingChart url={nicheCase.chart.data_url} />
        </Panel>
      ) : null}

      <Panel title="Honesty line">
        <p className="facility-note">
          These are screening estimates for a typical conductor, not utility operating
          ratings. Real ratings need line-specific conductor, clearance surveys and
          at-line sensors.
        </p>
      </Panel>
    </>
  );
}
