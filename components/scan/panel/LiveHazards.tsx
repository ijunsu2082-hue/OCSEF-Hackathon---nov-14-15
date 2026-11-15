"use client";

import type { HazardFire, HazardQuake, HazardsLive, HazardsNri, HazardsSvi } from "@/lib/live/hazards";
import type { ReactNode } from "react";
import type { CrossCheck, FeedStatus, LiveFeed } from "@/lib/live/types";
import { agoLabel, usePoll } from "@/lib/live/usePoll";
import { fmtNum, isNum } from "./format";
import { Caption, Row, Section } from "./ui";

/* Kept in step with lib/live/hazards.ts (not imported: that module is server code). */
const NEAR_FIRE_MI = 25;
const QUAKE_MIN_MAG = 2;
const MAX_FIRES = 8;
const MAX_QUAKES = 6;

const LINK = "text-[13px] text-[#0369a1] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";

function fmtMi(mi: number): string {
  return `${fmtNum(mi, mi < 10 ? 1 : 0)} mi`;
}

function fmtAcres(a: number | null): string {
  if (!isNum(a)) return "size not reported";
  return `${fmtNum(a, a < 10 ? 1 : 0)} acres`;
}

function fmtUsd(n: number | null): string {
  if (!isNum(n)) return "—";
  if (n >= 1e9) return `$${fmtNum(n / 1e9, 2)} billion`;
  if (n >= 1e6) return `$${fmtNum(n / 1e6, 1)} million`;
  return `$${fmtNum(n, 0)}`;
}

function sinceLabel(iso: string, now: number): string {
  return agoLabel(Math.max(0, Math.round((now - Date.parse(iso)) / 1000)));
}

function StatusPill({ status, ageSec, loading }: { status: FeedStatus | null; ageSec: number | null; loading: boolean }) {
  let cls = "border-[#e6e9ee] bg-white text-[#556070]";
  let text = loading ? "Loading live hazards" : "Not loaded";
  if (status === "live") {
    cls = "border-[#bae6fd] bg-[#f0f9ff] text-[#0284c7]";
    text = `Live${ageSec != null ? ` · updated ${agoLabel(ageSec)}` : ""}`;
  } else if (status === "stale") {
    cls = "border-[#fde68a] bg-[#fffbeb] text-[#b45309]";
    text = `Stale${ageSec != null ? ` · updated ${agoLabel(ageSec)}` : ""}`;
  } else if (status === "error") {
    cls = "border-[#fecaca] bg-[#fef2f2] text-[#b91c1c]";
    text = "Live hazards unavailable";
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[12px] font-medium ${cls}`} role="status">
      {text}
    </span>
  );
}

function SubHead({ children }: { children: ReactNode }) {
  return <h4 className="text-[14px] font-semibold leading-snug text-[#1d2733]">{children}</h4>;
}

function Fires({ fires, radiusMi }: { fires: HazardFire[]; radiusMi: number }) {
  const shown = fires.slice(0, MAX_FIRES);
  return (
    <div className="flex flex-col gap-2">
      <SubHead>Active wildfires within {fmtMi(radiusMi)}</SubHead>
      {fires.length === 0 ? (
        <p className="text-[14px] leading-snug text-[#556070]">No active wildfires reported by NIFC in this circle.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((f) => (
            <li key={f.id} className="flex flex-col">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[14px] text-[#1d2733]">{f.name}</span>
                <span className="shrink-0 text-[14px] font-semibold tabular-nums text-[#0284c7]">{fmtMi(f.distanceMi)}</span>
              </div>
              <span className="text-[13px] leading-snug tabular-nums text-[#556070]">
                {fmtAcres(f.acres)} ·{" "}
                {isNum(f.containedPct) ? `${fmtNum(f.containedPct, 0)}% contained` : "containment not reported"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {fires.length > shown.length && (
        <p className="text-[13px] text-[#556070]">and {fires.length - shown.length} more, farther out.</p>
      )}
    </div>
  );
}

function Quakes({ quakes, radiusMi, now }: { quakes: HazardQuake[]; radiusMi: number; now: number }) {
  const shown = quakes.slice(0, MAX_QUAKES);
  return (
    <div className="flex flex-col gap-2">
      <SubHead>
        Earthquakes M{QUAKE_MIN_MAG}+ within {fmtMi(radiusMi)}, last 7 days
      </SubHead>
      {quakes.length === 0 ? (
        <p className="text-[14px] leading-snug text-[#556070]">None recorded by USGS.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((q) => (
            <li key={q.id} className="flex items-baseline justify-between gap-3">
              <a href={q.url} target="_blank" rel="noreferrer" className={`min-w-0 truncate ${LINK}`}>
                <span className="font-semibold tabular-nums text-[#0284c7]">M{q.mag.toFixed(1)}</span> {q.place}
              </a>
              <span className="shrink-0 text-right text-[13px] tabular-nums text-[#556070]">
                {fmtMi(q.distanceMi)} · {sinceLabel(q.time, now)}
                {q.alert ? ` · PAGER ${q.alert}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {quakes.length > shown.length && <p className="text-[13px] text-[#556070]">and {quakes.length - shown.length} more.</p>}
    </div>
  );
}

function NriCard({ nri }: { nri: HazardsNri | null }) {
  return (
    <div className="flex flex-col gap-2 rounded-[8px] border border-[#e6e9ee] bg-white p-4">
      <SubHead>FEMA National Risk Index</SubHead>
      {!nri ? (
        <p className="text-[14px] leading-snug text-[#556070]">Not available for this point.</p>
      ) : (
        <>
          <p className="text-[13px] leading-snug text-[#556070]">{nri.name}</p>
          <p className="text-[14px] leading-snug text-[#1d2733]">
            Overall risk: <span className="font-semibold">{nri.riskRating ?? "not rated"}</span>
            {isNum(nri.riskScore) && (
              <>
                {" "}
                (score <span className="font-semibold tabular-nums text-[#0284c7]">{fmtNum(nri.riskScore, 1)}</span> of 100)
              </>
            )}
            . Expected annual loss from natural hazards:{" "}
            <span className="font-semibold tabular-nums text-[#0284c7]">{fmtUsd(nri.eal)}</span> per year.
          </p>
          <div className="mt-1 flex flex-col">
            {nri.hazards.map((h) => (
              <Row
                key={h.name}
                label={h.name}
                value={
                  <>
                    {h.rating}
                    {isNum(h.score) && h.score > 0 && (
                      <span className="ml-1.5 font-normal text-[#556070]">({fmtNum(h.score, 0)})</span>
                    )}
                  </>
                }
              />
            ))}
          </div>
          <Caption>Ratings compare this {nri.scope} with the rest of the U.S.; scores are national percentiles (0-100).</Caption>
        </>
      )}
    </div>
  );
}

function Svi({ svi }: { svi: HazardsSvi | null }) {
  return (
    <div className="flex flex-col gap-2">
      <SubHead>Social vulnerability (CDC SVI 2022)</SubHead>
      {!svi || !isNum(svi.overallPct) ? (
        <p className="text-[14px] leading-snug text-[#556070]">Not available for this point.</p>
      ) : (
        <>
          <p className="text-[14px] leading-snug text-[#1d2733]">
            More vulnerable than <span className="font-semibold tabular-nums text-[#0284c7]">{fmtNum(svi.overallPct, 0)}%</span>{" "}
            of U.S. census tracts.
          </p>
          <p className="text-[13px] leading-snug text-[#556070]">{svi.tract}</p>
          <div className="flex flex-col">
            {svi.themes.map((t) => (
              <Row key={t.name} label={t.name} value={isNum(t.pct) ? `${fmtNum(t.pct, 0)}th pct` : "—"} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CrossNotes({ checks }: { checks: CrossCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <SubHead>Live events vs FEMA long-term risk</SubHead>
      <ul className="flex flex-col gap-2">
        {checks.map((c) => (
          <li key={c.quantity} className="text-[14px] leading-snug text-[#1d2733]">
            <span className={`font-semibold ${c.agree ? "text-[#0284c7]" : "text-[#b45309]"}`}>
              {c.agree ? "Consistent." : "Worth a look."}
            </span>{" "}
            {c.note}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Poll result for the hazards feed, as returned by usePoll<HazardsLive>(). */
export interface HazardsPoll {
  feed: LiveFeed<HazardsLive> | null;
  loading: boolean;
  error: string | null;
  ageSec: number | null;
  fetchedAgoSec: number | null;
}

/** Route this component polls; null when the inputs are not numbers. */
export function liveHazardsUrl(lat: number, lon: number, radiusMi: number): string | null {
  return isNum(lat) && isNum(lon) && isNum(radiusMi) && radiusMi > 0
    ? `/api/live/hazards?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&r=${Math.round(radiusMi * 10) / 10}`
    : null;
}

/**
 * Pass `feed` when a parent already polls /api/live/hazards (no second poll is started), and
 * `bare` to drop the outer Section and the status pill when the parent supplies its own.
 */
export function LiveHazards({
  lat,
  lon,
  radiusMi,
  feed: given,
  bare = false,
}: {
  lat: number;
  lon: number;
  radiusMi: number;
  feed?: HazardsPoll;
  bare?: boolean;
}) {
  const own = usePoll<HazardsLive>(given ? null : liveHazardsUrl(lat, lon, radiusMi), 300);
  const { feed, loading, error, ageSec, fetchedAgoSec } = given ?? own;
  const data = feed?.data ?? null;
  const now = Date.now();
  const nearFires = data ? data.fires.filter((f) => f.distanceMi <= NEAR_FIRE_MI) : [];

  const body = (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {!bare && (
          <StatusPill
            status={feed?.status === "live" && ageSec != null && ageSec > feed.maxAgeSec ? "stale" : (feed?.status ?? null)}
            ageSec={ageSec}
            loading={loading}
          />
        )}
        {fetchedAgoSec != null && <span className="text-[12px] text-[#6b7583]">checked {agoLabel(fetchedAgoSec)}</span>}
        {data?.nifcUpdatedAt && (
          <span className="text-[12px] text-[#6b7583]">NIFC last changed {sinceLabel(data.nifcUpdatedAt, now)}</span>
        )}
      </div>

      {error && !feed && <p className="text-[14px] leading-snug text-[#b91c1c]">Could not load live hazards ({error}).</p>}
      {feed && feed.errors.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {feed.errors.map((e) => (
            <li key={e} className="text-[13px] leading-snug text-[#b45309]">
              {e}
            </li>
          ))}
        </ul>
      )}

      {nearFires.length > 0 && (
        <div className="rounded-[8px] border border-[#fde68a] bg-[#fffbeb] px-4 py-3 text-[14px] leading-snug text-[#b45309]" role="alert">
          <span className="font-semibold">
            {nearFires.length === 1 ? "Active wildfire" : `${nearFires.length} active wildfires`} within {NEAR_FIRE_MI} mi.
          </span>{" "}
          Nearest: {nearFires[0].name}, {fmtMi(nearFires[0].distanceMi)} away
          {isNum(nearFires[0].containedPct) ? `, ${fmtNum(nearFires[0].containedPct, 0)}% contained` : ""}.
        </div>
      )}

      {data && (
        <>
          <Fires fires={data.fires} radiusMi={radiusMi} />
          <Quakes quakes={data.quakes} radiusMi={radiusMi} now={now} />
          <NriCard nri={data.nri} />
          <Svi svi={data.svi} />
          <CrossNotes checks={feed?.crossChecks ?? []} />
        </>
      )}

      {feed && (
        <div className="flex flex-col gap-1">
          <Caption>
            Sources (refreshed every {Math.round(feed.refreshSec / 60)} min). FEMA and CDC data are periodic releases,
            not live; fire and quake lists are live.
          </Caption>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {feed.providers.map((p) => (
              <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className={LINK}>
                {p.name}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  if (bare) return body;
  return (
    <Section title="Live hazards" subtitle="Wildfires, earthquakes, long-term risk and social vulnerability around this point">
      {body}
    </Section>
  );
}

export default LiveHazards;
