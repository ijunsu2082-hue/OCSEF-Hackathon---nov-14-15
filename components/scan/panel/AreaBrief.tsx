"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LineRatingNow, ScanResult } from "@/lib/scan";
import { SOURCES, type SourceId } from "@/lib/scan/sources";
import { GridImpact } from "./GridImpact";
import { fmtCoord, fmtNum, fmtPowerText, isNum } from "./format";

/*
 * One-page brief for a city council meeting. Every number comes from the scan
 * result or the live rating; clauses are skipped when their number is missing.
 */

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";

/** Percent change of a over b, or null. */
function pctOver(a: number | null | undefined, b: number | null | undefined): number | null {
  return isNum(a) && isNum(b) && b > 0 ? (a / b - 1) * 100 : null;
}

function fossilShare(result: ScanResult): { pct: number; mostlyGas: boolean } | null {
  const t = result.totals;
  if (!isNum(t.nameplate_mw) || t.nameplate_mw <= 0 || !isNum(t.fossil_mw)) return null;
  const gas = (t.mw_by_source.natural_gas ?? 0) + (t.mw_by_source.other_gas ?? 0);
  return { pct: (t.fossil_mw / t.nameplate_mw) * 100, mostlyGas: t.fossil_mw > 0 && gas >= t.fossil_mw / 2 };
}

/** Temperature clause (ambient-adjusted rating vs fixed rating). Null when live is missing. */
function temperatureSentence(live: LineRatingNow | null): string | null {
  if (!live) return null;
  const pct = pctOver(live.aar_A, live.static_A);
  if (pct === null) return null;
  const when =
    live.weather.source === "heatwave-scenario"
      ? "in a 105 °F heatwave"
      : live.weather.source === "fallback-2025"
        ? "in typical 2025 weather"
        : "today";
  if (Math.round(pct) < 0) {
    return `${when === "today" ? "Today" : when[0].toUpperCase() + when.slice(1)}, the fixed rating is about ${fmtNum(-pct, 0)}% too high for the wires here, so they need a lower limit.`;
  }
  if (Math.round(pct) === 0) return `Rating the wires here for the real air temperature would not change their limit ${when}.`;
  return `Wires here could carry up to about ${fmtNum(pct, 0)}% more ${when} than a 40 °C worst-case rating, just by rating them for the real air temperature (less against the utility's seasonal ratings, and nothing where equipment or grid stability sets the limit).`;
}

/** One plain sentence for the top of the Area tab. */
export function areaTakeaway(result: ScanResult, live: LineRatingNow | null): string {
  const t = result.totals;
  const parts: string[] = [];
  const temp = temperatureSentence(live);
  if (temp) parts.push(temp);

  const fossil = fossilShare(result);
  if (!t.plant_count || !fossil) {
    parts.push("There are no power plants inside this circle.");
  } else {
    const fuel = fossil.pct >= 0.5 ? (fossil.mostlyGas ? "burns fossil fuel, mostly gas" : "burns fossil fuel") : null;
    let s = fuel
      ? `${fmtNum(fossil.pct, 0)}% of the power plant capacity here ${fuel}`
      : `None of the power plant capacity here burns fossil fuel`;
    if (isNum(t.planned_retirement_mw) && t.planned_retirement_mw > 0) {
      s += `, and ${fmtPowerText(t.planned_retirement_mw)} is scheduled to retire`;
    }
    parts.push(`${s}.`);
  }
  return parts.join(" ");
}

/** Finding 1: temperature-adjusted rating, plus what real wind adds. */
export function ratingFinding(result: ScanResult, live: LineRatingNow | null): string[] {
  const out: string[] = [];
  if (live) {
    const temp = pctOver(live.aar_A, live.static_A);
    const wind = pctOver(live.dlr_conservative_A, live.aar_A);
    if (temp !== null) {
      out.push(
        Math.round(temp) === 0
          ? `Rated for the real air temperature (an ambient-adjusted rating, which FERC Order No. 881 requires of FERC-regulated utilities), the lines here could carry about the same as a 40 °C worst-case rating right now.`
          : temp > 0
            ? `Rated for the real air temperature (an ambient-adjusted rating, which FERC Order No. 881 requires of FERC-regulated utilities), the lines here could carry up to about ${fmtNum(temp, 0)}% more than a 40 °C worst-case rating right now. The gain is smaller against the utility's seasonal ratings, and nothing where equipment or grid stability sets the limit.`
            : `In this heat the fixed rating is about ${fmtNum(-temp, 0)}% too high, so the lines need a lower limit right now.`,
      );
    }
    if (wind !== null) {
      out.push(
        wind >= 0.5
          ? `Counting real wind and sun too (dynamic line rating, with the wind cut in half to be safe) adds about ${fmtNum(wind, 0)}% more on top of that.`
          : `Counting the real wind too (dynamic line rating, with the wind cut in half and a less helpful wind direction to be safe) does not add more right now.`,
      );
    }
  }
  const s = result.rating_site;
  const summer = pctOver(s.summer_4to8pm_median_wind_gain_over_aar, 1);
  if (s && isNum(s.pct_hours_conservative_dlr_above_static)) {
    let txt = `With 2025 weather at the ${s.name} weather point (${isNum(s.distance_mi) && s.distance_mi < 1 ? "under 1 mi" : `${fmtNum(s.distance_mi, 0)} mi`} away), the weather-based rating beat the fixed rating in ${fmtNum(s.pct_hours_conservative_dlr_above_static, 1)}% of hours`;
    if (summer !== null) {
      txt += `, and on summer evenings (4 to 8 pm, when demand peaks) real wind and sun added a median ${fmtNum(summer, 0)}% over the temperature-only rating`;
    }
    out.push(`${txt}.`);
  }
  return out;
}

/** Finding 2: energy mix, retirements and what is proposed. */
export function mixFinding(result: ScanResult): string[] {
  const t = result.totals;
  if (!t.plant_count || !isNum(t.nameplate_mw) || t.nameplate_mw <= 0) {
    return ["There are no power plants inside this circle."];
  }
  const pct = (mw: number) => fmtNum((mw / t.nameplate_mw) * 100, 0);
  const out = [
    `${fmtNum(t.plant_count, 0)} power plant${t.plant_count === 1 ? "" : "s"} with ${fmtPowerText(t.nameplate_mw)} of capacity: ${pct(t.renewable_mw)}% renewable (sun, wind, water, biogas), ${pct(t.storage_mw)}% batteries and ${pct(t.fossil_mw)}% fossil fuel.`,
  ];
  if (isNum(t.planned_retirement_mw) && t.planned_retirement_mw > 0) {
    out.push(`${fmtPowerText(t.planned_retirement_mw)} is scheduled to retire.`);
  }
  if (isNum(t.proposed_mw) && t.proposed_mw > 0) {
    const st = t.proposed_storage_mw > 0 ? `, ${fmtPowerText(t.proposed_storage_mw)} of it battery storage` : "";
    out.push(`${fmtPowerText(t.proposed_mw)} of new power is proposed${st}.`);
  }
  return out;
}

/** 2-3 polite asks built from the same numbers the upgrade ideas use. */
export function briefAsks(result: ScanResult): string[] {
  const t = result.totals;
  const asks: string[] = [];
  if (isNum(t.line_miles) && t.line_miles > 0) {
    asks.push(
      `Please ask the utility that owns the ${fmtNum(t.line_miles, t.line_miles < 10 ? 1 : 0)} miles of power lines here for their temperature-adjusted ratings (ambient-adjusted ratings under FERC Order No. 881) and when they will start using them. If the utility is FERC-regulated and in the California ISO grid, its deadline is October 15, 2027.`,
    );
  }
  if (isNum(t.proposed_storage_mw) && t.proposed_storage_mw > 0) {
    asks.push(`Please ask the city and the utility to make connecting the ${fmtPowerText(t.proposed_storage_mw)} of battery storage already proposed here a priority.`);
  } else if (isNum(t.proposed_mw) && t.proposed_mw > 0) {
    asks.push(`Please ask the city and the utility to make connecting the ${fmtPowerText(t.proposed_mw)} of new power already proposed here a priority.`);
  }
  if (isNum(t.planned_retirement_mw) && t.planned_retirement_mw > 0) {
    asks.push(`Please ask for a public plan to replace the ${fmtPowerText(t.planned_retirement_mw)} scheduled to retire with clean power and storage before it shuts down.`);
  }
  if (asks.length < 2 && !t.plant_count) {
    asks.push("There are no power plants inside this circle, so please ask the city to put solar panels and batteries on city buildings here.");
  }
  if (asks.length < 2) {
    asks.push("Please ask the utility to share its line ratings and how it calculates them. If the utility is FERC-regulated and in the California ISO grid, FERC Order No. 881 requires it to keep a (password-protected) database of ratings and methods.");
  }
  return asks.slice(0, 3);
}

const BRIEF_SOURCES: SourceId[] = ["eia860", "eia860_events", "osm", "openmeteo_live", "era5_2025", "ieee738", "ferc881", "caiso881_extension"];

function Heading({ children }: { children: string }) {
  return <h2 className="text-[16px] font-semibold text-[#1d2733] print:text-[13pt]">{children}</h2>;
}

export function AreaBrief({
  result,
  live,
  onClose,
}: {
  result: ScanResult;
  live: LineRatingNow | null;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (mounted) closeRef.current?.focus();
  }, [mounted]);

  if (!mounted) return null;

  const place = result.area_label || "This area";
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const r = result.area.radius_mi;
  const ideas = result.upgrade_ideas.slice(0, 3);
  const sources = BRIEF_SOURCES.filter((id) => id !== "openmeteo_live" || live?.weather.source === "open-meteo-live");

  // Portal to <body> so print can hide every other child of <body>; the html/body
  // print variants undo the app's 100% height + overflow hidden so long briefs paginate.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="gs-brief-title"
      className="fixed inset-0 overflow-y-auto bg-white text-[#1d2733] print:static print:overflow-visible print:[body:has(>&)>:not(&)]:!hidden print:[body:has(>&)]:!h-auto print:[body:has(>&)]:!overflow-visible print:[html:has(&)]:!h-auto print:[html:has(&)]:!overflow-visible"
      style={{ zIndex: 2000 }}
    >
      <div className="sticky top-0 border-b border-[#e6e9ee] bg-white print:hidden">
        <div className="mx-auto flex max-w-[760px] items-center justify-between gap-3 px-6 py-3">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className={`h-8 rounded-[6px] border border-[#e6e9ee] bg-white px-3 text-[14px] font-medium text-[#1d2733] transition-colors hover:bg-[#f6f8fa] ${FOCUS}`}
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className={`h-8 rounded-[6px] bg-[#0ea5e9] px-3 text-[14px] font-semibold text-[#1d2733] transition-colors hover:bg-[#38bdf8] ${FOCUS}`}
          >
            Print or save as PDF
          </button>
        </div>
      </div>

      <article className="mx-auto max-w-[760px] px-6 py-8 text-[14px] leading-relaxed print:max-w-none print:px-0 print:py-0 print:text-[10.5pt] print:leading-snug">
        <header className="border-b border-[#e6e9ee] pb-4">
          <h1 id="gs-brief-title" className="text-[22px] font-semibold leading-tight print:text-[17pt]">
            Power grid brief: {place}
          </h1>
          <p className="mt-1 text-[13px] tabular-nums text-[#556070]">
            {date} · {fmtCoord(result.area.lat, result.area.lon)} · {fmtNum(r, isNum(r) && r % 1 !== 0 ? 1 : 0)} mi
            radius
          </p>
        </header>

        <section className="mt-6 print:mt-4">
          <Heading>Three key findings</Heading>
          <ol className="mt-2 list-decimal space-y-3 pl-5">
            <li>
              <p className="font-semibold">Power lines can carry more when we rate them for real weather.</p>
              {ratingFinding(result, live).map((s) => (
                <p key={s} className="text-[#1d2733]">
                  {s}
                </p>
              ))}
            </li>
            <li>
              <p className="font-semibold">Where the power comes from.</p>
              {mixFinding(result).map((s) => (
                <p key={s}>{s}</p>
              ))}
            </li>
            <li>
              <p className="font-semibold">Upgrade ideas for this area.</p>
              {ideas.length ? (
                <ul className="list-disc pl-5">
                  {ideas.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              ) : (
                <p>No upgrade ideas came up for this area.</p>
              )}
            </li>
          </ol>
        </section>

        <section className="mt-6 break-inside-avoid print:mt-4">
          <Heading>Why this matters</Heading>
          <div className="mt-2">
            <GridImpact result={result} live={live} />
          </div>
        </section>

        <section className="mt-6 break-inside-avoid print:mt-4">
          <Heading>What you can ask for</Heading>
          <ol className="mt-2 list-decimal space-y-2 pl-5">
            {briefAsks(result).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </section>

        <section className="mt-6 break-inside-avoid border-t border-[#e6e9ee] pt-4 print:mt-4">
          <Heading>Sources</Heading>
          <ul className="mt-2 space-y-1 text-[12px] leading-snug text-[#556070] print:text-[8.5pt]">
            {sources.map((id) => {
              const s = SOURCES[id];
              return (
                <li key={id}>
                  <span className="font-medium text-[#1d2733]">{s.name}</span>, {s.publisher}. {s.asOf}.
                  {"url" in s && s.url ? (
                    <>
                      {" "}
                      <a href={s.url} className="break-all text-[#0369a1] underline" target="_blank" rel="noreferrer">
                        {s.url}
                      </a>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[12px] leading-snug text-[#6b7583] print:text-[8.5pt]">
            Line ratings are a screening estimate for one common wire type (ACSR 795 kcmil Drake at 75 °C), not a
            utility rating. Made with Mapergy.
          </p>
        </section>
      </article>
    </div>,
    document.body,
  );
}
