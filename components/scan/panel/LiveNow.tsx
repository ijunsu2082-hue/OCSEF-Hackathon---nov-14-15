"use client";

import type { ReactNode } from "react";
import { agoLabel, usePoll } from "@/lib/live/usePoll";
import type { FeedStatus } from "@/lib/live/types";
import type { WeatherLive } from "@/lib/live/weather";
import type { HazardsLive } from "@/lib/live/hazards";
import { LiveHazards, liveHazardsUrl, type HazardsPoll } from "./LiveHazards";
import { LiveWeather, StatusPill, liveWeatherUrl } from "./LiveWeather";
import { LiveGrid, liveGridUrl } from "./LiveGrid";
import type { GridLive } from "@/lib/live/grid";
import { cToF, fmtNum, isNum } from "./format";
import { Caption, Section } from "./ui";

/*
 * "Live now": the live feeds for this circle, one collapsible row each, placed right under
 * the hero on the Area tab. The weather feed is polled here once and handed to LiveWeather.
 * Hazards come from `hazardsFeed` when the page already polls them (shared with the map);
 * otherwise they are polled here once. Grid operator is a slot; until a caller fills it it
 * reads "Connecting…". The hazards / hazardsSummary slots, when given, override the built-in row.
 */

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";

function Chevron() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 text-[#6b7583] transition-transform group-open:rotate-90"
    >
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** One collapsible feed row: label and key value on the summary line, the full feed below. */
function FeedRow({ label, summary, children }: { label: string; summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group border-t border-[#e6e9ee] first:border-t-0">
      <summary
        className={`flex cursor-pointer list-none items-center gap-3 rounded-[6px] py-3 [&::-webkit-details-marker]:hidden ${FOCUS}`}
      >
        <Chevron />
        <span className="w-[6.5rem] shrink-0 text-[14px] font-semibold leading-snug text-[#1d2733]">{label}</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">{summary}</span>
      </summary>
      <div className="pb-4 pt-1">{children}</div>
    </details>
  );
}

function weatherSummary(d: WeatherLive): string {
  const parts: string[] = [];
  if (isNum(d.center.tempC)) parts.push(`${fmtNum(cToF(d.center.tempC), 0)} °F`);
  if (isNum(d.center.windMs)) parts.push(`wind ${fmtNum(d.center.windMs, 1)} m/s`);
  const n = d.alerts.filter((a) => a.gridRelevant).length;
  parts.push(n === 0 ? "no grid alerts" : `${n} grid alert${n === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/* Kept in step with lib/live/hazards.ts NEAR_FIRE_MI (not imported: that module is server code). */
const NEAR_FIRE_MI = 25;

/** "2 fires within 25 mi · 4 quakes this week · FEMA risk Relatively High"; fires part amber when any is near. */
function HazardsSummaryText({ d, radiusMi }: { d: HazardsLive; radiusMi: number }) {
  const within = Math.min(radiusMi, NEAR_FIRE_MI);
  const fires = d.fires.filter((f) => f.distanceMi <= within).length;
  const withinLabel = `${fmtNum(within, within % 1 !== 0 ? 1 : 0)} mi`;
  const firePart = fires === 0 ? `no fires within ${withinLabel}` : `${fires} fire${fires === 1 ? "" : "s"} within ${withinLabel}`;
  const n = d.quakes.length;
  const rest = [n === 0 ? "no quakes this week" : `${n} quake${n === 1 ? "" : "s"} this week`];
  if (d.nri?.riskRating) rest.push(`FEMA risk ${d.nri.riskRating}`);
  return (
    <span className="min-w-0 text-[14px] font-semibold leading-snug tabular-nums text-[#0284c7]">
      <span className={fires > 0 ? "text-[#b45309]" : undefined}>{firePart}</span>
      {rest.map((t) => ` · ${t}`).join("")}
    </span>
  );
}

export function LiveNow({
  lat,
  lon,
  radiusMi,
  grid,
  gridSummary,
  hazards,
  hazardsSummary,
  hazardsFeed,
}: {
  lat: number;
  lon: number;
  radiusMi: number;
  grid?: ReactNode;
  gridSummary?: ReactNode;
  hazards?: ReactNode;
  hazardsSummary?: ReactNode;
  /** Hazards poll owned by the page (shared with the map). When absent, LiveNow polls once itself. */
  hazardsFeed?: HazardsPoll;
}) {
  const weather = usePoll<WeatherLive>(liveWeatherUrl(lat, lon, radiusMi), 300);
  const { feed, error, ageSec } = weather;
  const d = feed?.data ?? null;
  const status: FeedStatus = feed ? feed.status : error ? "error" : "live";

  const weatherLine = d ? (
    <>
      <span className="min-w-0 text-[14px] font-semibold leading-snug tabular-nums text-[#0284c7]">
        {weatherSummary(d)}
      </span>
      <StatusPill status={status} ago={agoLabel(ageSec)} />
    </>
  ) : feed || error ? (
    <>
      <span className="min-w-0 text-[13px] leading-snug text-[#556070]">Not available right now</span>
      <StatusPill status={status} ago={agoLabel(ageSec)} />
    </>
  ) : (
    <span className="text-[13px] leading-snug text-[#556070]">Loading…</span>
  );

  const ownHazards = usePoll<HazardsLive>(hazardsFeed ? null : liveHazardsUrl(lat, lon, radiusMi), 300);
  const hz = hazardsFeed ?? ownHazards;
  const hd = hz.feed?.data ?? null;
  const hzStatus: FeedStatus = hz.feed
    ? hz.feed.status === "live" && hz.ageSec != null && hz.ageSec > hz.feed.maxAgeSec
      ? "stale"
      : hz.feed.status
    : hz.error
      ? "error"
      : "live";
  const hazardsLine = hd ? (
    <>
      <HazardsSummaryText d={hd} radiusMi={radiusMi} />
      <StatusPill status={hzStatus} ago={agoLabel(hz.ageSec)} />
    </>
  ) : hz.feed || hz.error ? (
    <>
      <span className="min-w-0 text-[13px] leading-snug text-[#556070]">Not available right now</span>
      <StatusPill status={hzStatus} ago={agoLabel(hz.ageSec)} />
    </>
  ) : (
    <span className="text-[13px] leading-snug text-[#556070]">Loading…</span>
  );

  const gridPoll = usePoll<GridLive>(liveGridUrl(lat, lon), 300);
  const gd = gridPoll.feed?.data ?? null;
  const gridStatus: FeedStatus = gridPoll.feed ? gridPoll.feed.status : gridPoll.error ? "error" : "live";
  const gridLine = gd ? (
    <>
      <span className="min-w-0 text-[14px] font-semibold leading-snug tabular-nums text-[#0284c7]">
        {[
          gd.ba.code,
          isNum(gd.caiso?.demandMW ?? gd.latest.demandMW) ? `${fmtNum((gd.caiso?.demandMW ?? gd.latest.demandMW)! / 1000, 1)} GW demand` : null,
          isNum(gd.cleanSharePct) ? `${fmtNum(gd.cleanSharePct, 0)}% clean` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <StatusPill status={gridStatus} ago={agoLabel(gridPoll.ageSec)} />
    </>
  ) : gridPoll.feed || gridPoll.error ? (
    <>
      <span className="min-w-0 text-[13px] leading-snug text-[#556070]">Not available right now</span>
      <StatusPill status={gridStatus} ago={agoLabel(gridPoll.ageSec)} />
    </>
  ) : (
    <span className="text-[13px] leading-snug text-[#556070]">Loading…</span>
  );

  return (
    <Section title="Live now">
      <div className="flex flex-col">
        <FeedRow label="Weather" summary={weatherLine}>
          <LiveWeather lat={lat} lon={lon} radiusMi={radiusMi} feed={weather} bare />
        </FeedRow>
        <FeedRow label="Grid operator" summary={gridSummary ?? gridLine}>
          {grid ?? <LiveGrid lat={lat} lon={lon} feed={gridPoll} bare />}
        </FeedRow>
        <FeedRow label="Hazards" summary={hazardsSummary ?? hazardsLine}>
          {hazards ?? <LiveHazards lat={lat} lon={lon} radiusMi={radiusMi} feed={hz} bare />}
        </FeedRow>
      </div>
      <Caption className="mt-2">Updates on its own every few minutes. Cross-checked between independent providers.</Caption>
    </Section>
  );
}

export default LiveNow;
