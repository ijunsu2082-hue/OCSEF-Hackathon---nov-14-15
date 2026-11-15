"use client";

import { useMemo, useState } from "react";
import type { DailyRating, LineRatingNow, ScanResult } from "@/lib/scan";
import { fmtNum, fmtPct, fmtRatio, isNum } from "./format";
import { Caption, Section } from "./ui";

type Objective = "transfer" | "resilience" | "emissions" | "cost";

const OBJECTIVES: Record<Objective, string> = {
  transfer: "Increase transfer capability",
  resilience: "Improve reliability and resilience",
  emissions: "Reduce operating emissions",
  cost: "Minimize lifecycle cost",
};

const OBJECTIVE_CHECKS: Record<Objective, string[]> = {
  transfer: ["Utility-confirmed interconnection limit and network power-flow study.", "Line-specific loading, conductor, protection and operating limits."],
  resilience: ["Reliability target, critical loads and acceptable outage duration.", "Outage history and whether each candidate remains available during the same hazard."],
  emissions: ["Hourly facility load and generation profiles.", "Time-matched emissions factors and operating constraints for each candidate."],
  cost: ["Comparable capital, operating, replacement and interconnection cost estimates.", "Financing assumptions, project life and cost uncertainty range."],
};

function value(value: number | null | undefined, unit = "") {
  return isNum(value) ? `${fmtNum(value, 1)}${unit}` : "Unknown";
}

function Status({ children, tone = "neutral" }: { children: string; tone?: "signal" | "missing" | "neutral" }) {
  const style = tone === "signal"
    ? "border-[#bae6fd] bg-[#f0f9ff] text-[#0369a1]"
    : tone === "missing"
      ? "border-[#e6e9ee] bg-[#f8fafc] text-[#556070]"
      : "border-[#e6e9ee] bg-white text-[#556070]";
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[12px] font-medium ${style}`}>{children}</span>;
}

function OptionCard({ title, status, evidence, missing, next }: {
  title: string;
  status: string;
  evidence: string[];
  missing: string[];
  next: string;
}) {
  return (
    <article className="rounded-lg border border-[#e6e9ee] bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[15px] font-semibold text-[#1d2733]">{title}</h4>
        <Status tone={evidence.length ? "signal" : "missing"}>{status}</Status>
      </div>
      <p className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-[#6b7583]">Scan evidence</p>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-[14px] leading-snug text-[#1d2733]">
        {evidence.length ? evidence.map((item) => <li key={item}>{item}</li>) : <li>No supporting signal in this scan.</li>}
      </ul>
      <p className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-[#6b7583]">Still needed</p>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-[14px] leading-snug text-[#556070]">
        {missing.map((item) => <li key={item}>{item}</li>)}
      </ul>
      <p className="mt-3 border-t border-[#eef1f4] pt-3 text-[14px] leading-snug text-[#1d2733]">
        <span className="font-semibold">Next evidence:</span> {next}
      </p>
    </article>
  );
}

export function OptimizationTab({ result, live, daily }: {
  result: ScanResult;
  live: LineRatingNow | null;
  daily: DailyRating[] | null;
}) {
  const [objective, setObjective] = useState<Objective>("transfer");
  const t = result.totals;
  const lineSignal = t.line_miles > 0;
  const dayRatios = useMemo(() => (daily ?? [])
    .filter((day) => isNum(day.worst_A) && isNum(day.static_A) && day.static_A > 0)
    .map((day) => day.worst_A / day.static_A)
    .sort((a, b) => a - b), [daily]);
  const range = dayRatios.length
    ? `${fmtRatio(dayRatios[0])}–${fmtRatio(dayRatios[dayRatios.length - 1])}`
    : "Not available";

  const dlrEvidence = lineSignal
    ? [
        `${fmtNum(t.line_miles, 1)} mi of mapped lines in the circle; ${fmtNum(t.line_miles_by_kv["200-499"] + t.line_miles_by_kv["500+"], 1)} mi mapped at 200 kV or higher.`,
        `Nearest weather rating site: ${result.rating_site.name}, ${fmtNum(result.rating_site.distance_mi, 1)} mi away; conservative modeled rating exceeded the fixed rating in ${fmtPct(result.rating_site.pct_hours_conservative_dlr_above_static, 0)} of 2025 hours.`,
      ]
    : [];

  return (
    <div className="px-6 py-6">
      <Section title="Compare options" subtitle="Area screening only" sources={["osm", "eia860", "era5_2025", "ieee738"]}>
        <p className="text-[14px] leading-relaxed text-[#556070]">
          Compare plausible directions using evidence for {result.area_label}. The scan does not calculate an optimum, rank by cost, or establish engineering feasibility.
        </p>
        <label className="mt-4 block text-[13px] font-semibold text-[#1d2733]" htmlFor="optimization-objective">
          Planning objective
        </label>
        <select
          id="optimization-objective"
          className="mt-1 h-10 w-full rounded-md border border-[#d8dee6] bg-white px-3 text-[14px] text-[#1d2733] focus-visible:outline-2 focus-visible:outline-[#0ea5e9]"
          value={objective}
          onChange={(event) => setObjective(event.target.value as Objective)}
        >
          {Object.entries(OBJECTIVES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <Caption className="mt-2">
          The selected objective only changes which evidence requests appear first. It does not change modeled results or rank options.
        </Caption>
        <div className="mt-3 rounded-md bg-[#f6f8fa] p-3">
          <p className="text-[13px] font-semibold text-[#1d2733]">Evidence to resolve first for this objective</p>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-[14px] leading-snug text-[#556070]">
            {OBJECTIVE_CHECKS[objective].map((check) => <li key={check}>{check}</li>)}
          </ol>
        </div>

        <div className="mt-5 grid gap-3">
          <OptionCard
            title="Weather based line rating"
            status={lineSignal ? "Signal present · proxy model" : "No mapped line signal"}
            evidence={dlrEvidence}
            missing={["Match the scan lines to operator asset IDs, conductor and condition.", "Obtain line loading, protection limits, validated local weather, telemetry and operator acceptance."]}
            next="Request a line-specific operating study from the transmission owner; compare its validated rating with the fixed rating."
          />
          <OptionCard
            title="Local storage or flexible demand"
            status={t.storage_mw > 0 || t.renewable_mw > 0 ? "Area supply signal" : "Project evidence missing"}
            evidence={[
              `${fmtNum(t.renewable_mw, 1)} MW renewable nameplate and ${fmtNum(t.storage_mw, 1)} MW battery nameplate are mapped in the area.`,
              t.evening_cover_pct === null ? "Solar-to-storage evening cover: unknown (no mapped solar)." : `Area storage is ${fmtNum(t.evening_cover_pct, 0)}% of solar nameplate; this is not a dispatch result.`,
            ]}
            missing={["Hourly facility load and generation profiles.", "Site, duration, dispatch limits, interconnection requirements and lifecycle cost."]}
            next="Collect interval load and generation data, then test a site-specific dispatch scenario against the chosen objective."
          />
          <OptionCard
            title="Grid reinforcement or reconductoring"
            status={lineSignal || t.substation_count > 0 ? "Mapped assets · capacity unknown" : "Mapped asset evidence sparse"}
            evidence={[
              `${fmtNum(t.line_miles, 1)} mi of mapped line and ${t.substation_count} mapped substation${t.substation_count === 1 ? "" : "s"} in the circle.`,
              `${t.hv_substation_count} mapped substation${t.hv_substation_count === 1 ? "" : "s"} at 200 kV or above.`,
            ]}
            missing={["Network topology, power flows, asset condition and available capacity.", "Feasible route/site, land rights, environmental review, outage plan and cost estimate."]}
            next="Ask the system operator for a constraints study and confirm candidate routes with asset owners."
          />
        </div>
      </Section>

      <Section title="Weather sensitivity" subtitle="Modeled rating context" sources={["openmeteo_live", "era5_2025", "ieee738"]}>
        <div className="grid gap-2 text-[14px] text-[#1d2733]">
          <div className="flex justify-between gap-3 border-b border-[#eef1f4] py-2">
            <span>Current weather screen</span>
            <b className="tabular-nums">{live ? fmtRatio(live.ratio) : "Unavailable"}</b>
          </div>
          <div className="flex justify-between gap-3 border-b border-[#eef1f4] py-2">
            <span>2025 daily worst-hour modeled range</span>
            <b className="tabular-nums">{range}</b>
          </div>
          <div className="flex justify-between gap-3 py-2">
            <span>2025 hottest-hour site ratio</span>
            <b className="tabular-nums">{value(result.rating_site.hottest_hour_dlr_vs_static, "×")}</b>
          </div>
        </div>
        <Caption className="mt-2">
          Ratios use the PR #2 representative conductor and IEEE 738 screening assumptions at {result.rating_site.name}. The weather site is {fmtNum(result.rating_site.distance_mi, 1)} mi from the scan center. Results are sensitivity context, not a rating for any mapped line; verify site weather, conductor, clearance, protection and operating limits before use.
        </Caption>
      </Section>

      <Section title="Constraints not resolved" subtitle="Required before alternatives can be ranked">
        <ul className="space-y-2 text-[14px] text-[#556070]">
          <li className="flex justify-between gap-3"><span>Interconnection and transfer limits</span><Status tone="missing">Unknown</Status></li>
          <li className="flex justify-between gap-3"><span>Capital and operating cost</span><Status tone="missing">Not supplied</Status></li>
          <li className="flex justify-between gap-3"><span>Site, route and land constraints</span><Status tone="missing">Not assessed</Status></li>
          <li className="flex justify-between gap-3"><span>Reliability target and outage limits</span><Status tone="missing">Not supplied</Status></li>
        </ul>
        <Caption className="mt-3">No option is recommended or marked feasible from these unknowns. Missing inputs remain visible instead of being filled with assumptions.</Caption>
      </Section>
    </div>
  );
}

export function UpgradePlanTab({ result }: { result: ScanResult }) {
  const t = result.totals;
  return (
    <div className="px-6 py-6">
      <Section title="Upgrade plan" subtitle={`Working sequence · ${result.area_label}`}>
        <p className="text-[14px] leading-relaxed text-[#556070]">
          Turn the area screen into a project candidate through evidence and review. This is a suggested workflow, not a project schedule or approval checklist.
        </p>
        <ol className="mt-5 space-y-4">
          <li className="border-l-2 border-[#bae6fd] pl-4">
            <b className="text-[14px] text-[#1d2733]">1. Confirm the candidate area</b>
            <p className="mt-1 text-[14px] leading-snug text-[#556070]">Check scan coverage and mapped assets with an owner representative. Record asset IDs, source, date and what remains unknown.</p>
          </li>
          <li className="border-l-2 border-[#bae6fd] pl-4">
            <b className="text-[14px] text-[#1d2733]">2. Gather operational evidence</b>
            <p className="mt-1 text-[14px] leading-snug text-[#556070]">Request interval load, interconnection limits and network studies. This screen currently finds {fmtNum(t.line_miles, 1)} mi of mapped line and {t.substation_count} substations; it does not establish available capacity.</p>
          </li>
          <li className="border-l-2 border-[#bae6fd] pl-4">
            <b className="text-[14px] text-[#1d2733]">3. Compare feasible designs</b>
            <p className="mt-1 text-[14px] leading-snug text-[#556070]">Use project-specific engineering, cost, siting and reliability constraints to compare line operations, storage/flexibility and reinforcement options.</p>
          </li>
          <li className="border-l-2 border-[#bae6fd] pl-4">
            <b className="text-[14px] text-[#1d2733]">4. Plan delivery and approvals</b>
            <p className="mt-1 text-[14px] leading-snug text-[#556070]">After a candidate design is supported, identify responsible owners, jurisdiction-specific permitting, funding sources and decision authority. Track each response as separate evidence.</p>
          </li>
        </ol>
        <Caption className="mt-5">No step is marked complete. Area Scan does not establish ownership, utility agreement, funding, permit status or regulatory approval.</Caption>
      </Section>
    </div>
  );
}
