"use client";

import { useMemo } from "react";
import type { ScanResult } from "@/lib/scan";
import { heatStress, type DayAging } from "@/lib/scan/heatStress";
import { cToF, fmtNum } from "./format";
import { Caption, Section } from "./ui";

/** Life-used percent; the model rounds to 4 decimals, so a cool day can show as 0. */
function lifePct(n: number): string {
  return n > 0 ? `${fmtNum(n, 4)}%` : "<0.0001%";
}

function CompareRow({
  label,
  base,
  hot,
  hotClass = "text-[#0284c7]",
}: {
  label: string;
  base: string;
  hot: string;
  hotClass?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_5.5rem_5.5rem] items-baseline gap-x-3 border-t border-[#e6e9ee] py-1.5">
      <dt className="min-w-0 text-[13px] leading-snug text-[#556070]">{label}</dt>
      <dd className="text-right text-[14px] font-semibold tabular-nums text-[#0284c7]">{base}</dd>
      <dd className={`text-right text-[14px] font-semibold tabular-nums ${hotClass}`}>{hot}</dd>
    </div>
  );
}

function CompareHead({ base, hot }: { base: string; hot: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_5.5rem_5.5rem] gap-x-3 pb-1">
      <span />
      <span className="text-right text-[12px] leading-snug text-[#556070]">{base}</span>
      <span className="text-right text-[12px] leading-snug text-[#556070]">{hot}</span>
    </div>
  );
}

function dayLabel(d: DayAging): string {
  return `${fmtNum(cToF(d.peak_ambient_c), 0)} °F`;
}

export function HeatStress({ result, heatwave }: { result: ScanResult; heatwave: boolean }) {
  const h = useMemo(() => heatStress(result, heatwave), [result, heatwave]);
  const { loads, transformer: t } = h;
  const n = t.substations;

  const lead = heatwave
    ? "The 105 °F heatwave is on. Here is what it does to the load and the substation transformers in this circle."
    : "Heatwave is off. Here is what a 105 °F day would do here.";

  const where = loads.inside_circle
    ? `${loads.nodes.length} seeded load center${loads.nodes.length === 1 ? "" : "s"} inside this circle.`
    : `No seeded load center is inside this circle, so this uses the nearest one: ${loads.nodes[0]?.name ?? "—"} (${fmtNum(loads.nodes[0]?.distance_mi, 1)} mi away).`;

  return (
    <Section title="Heatwave stress" subtitle={lead}>
      <div className="flex flex-col gap-5 print:break-inside-avoid">
        <div className="flex flex-col gap-2">
          <h4 className="text-[14px] font-semibold leading-snug text-[#1d2733]">Load centers</h4>
          <p className="text-[14px] leading-snug text-[#1d2733]">{where}</p>
          <dl className="flex flex-col">
            <CompareHead base="Normal" hot="105 °F" />
            <CompareRow
              label="Power draw (MW)"
              base={fmtNum(loads.baseline_mw, 1)}
              hot={fmtNum(loads.heatwave_mw, 1)}
            />
            <CompareRow
              label="CO2 if sustained a year (t/yr)"
              base={fmtNum(loads.baseline_co2_t_yr, 0)}
              hot={fmtNum(loads.heatwave_co2_t_yr, 0)}
            />
            <CompareRow
              label="Load centers pushed past 100% utilization"
              base="0"
              hot={loads.overloads > 0 ? `${fmtNum(loads.overloads, 0)} WATCH` : "0"}
              hotClass={loads.overloads > 0 ? "text-[#b45309]" : "text-[#0284c7]"}
            />
          </dl>
          <Caption>Modeled · seeded load centers. Not metered data for this circle.</Caption>
        </div>

        <div className="flex flex-col gap-2">
          <h4 className="text-[14px] font-semibold leading-snug text-[#1d2733]">Substation transformer aging</h4>
          <p className="text-[14px] leading-snug text-[#1d2733]">
            {n > 0
              ? `This circle has ${fmtNum(n, 0)} substation${n === 1 ? "" : "s"}. For a typical transformer in one of them, a 105 °F day uses about ${fmtNum(t.aging_multiple, 0)} times the insulation life of a normal day.`
              : "This circle has no substations in our map data. The numbers below are for one typical substation transformer nearby."}
          </p>
          <dl className="flex flex-col">
            <CompareHead base={`Normal (${dayLabel(t.normal)})`} hot={dayLabel(t.heatwave)} />
            <CompareRow label="Peak load (% of rating)" base={`${fmtNum(t.normal.peak_loading_pct, 0)}%`} hot={`${fmtNum(t.heatwave.peak_loading_pct, 0)}%`} />
            <CompareRow
              label="Peak winding hot-spot (°C)"
              base={fmtNum(t.normal.peak_hotspot_c, 0)}
              hot={fmtNum(t.heatwave.peak_hotspot_c, 0)}
              hotClass={t.heatwave.peak_hotspot_c >= 110 ? "text-[#b45309]" : "text-[#0284c7]"}
            />
            <CompareRow label="Insulation aging (hours in one day)" base={fmtNum(t.normal.aging_hours, 1)} hot={fmtNum(t.heatwave.aging_hours, 1)} />
            <CompareRow label="Insulation life used in one day" base={lifePct(t.normal.life_used_pct)} hot={lifePct(t.heatwave.life_used_pct)} />
          </dl>
          <Caption>
            Modeled · IEEE C57.91, generic transformer. Assumed: {fmtNum(t.spec.rating_mva, 0)} MVA {t.spec.hv_kv}/
            {t.spec.lv_kv} kV, {t.spec.cooling} cooling, {t.spec.rated_top_oil_rise_k} K top-oil and{" "}
            {t.spec.rated_hotspot_rise_k} K hot-spot rise at rating, {t.spec.design_life_years}-year design life; daily
            load peaks at 4 pm and air temperature swings 11 °C overnight. Not the real nameplate or loading of any
            substation here.
          </Caption>
        </div>
      </div>
    </Section>
  );
}

export default HeatStress;
