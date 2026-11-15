"use client";

import { useMemo, useState } from "react";
import type { DailyRating, LineRatingNow, ScanResult } from "@/lib/scan";
import { buildWorkflow, OBJECTIVES, type Objective, type Verdict, type WorkflowStep } from "@/lib/scan/optimization";
import { fmtNum, fmtPct, fmtRatio, isNum } from "./format";
import { Caption, Section } from "./ui";

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

const VERDICT_LABEL: Record<Verdict, string> = {
  pass: "Pass",
  candidate: "Candidate",
  weak: "Weak case",
  not_supported: "Not supported",
  not_applicable: "Not applicable",
  needs_data: "Needs data",
  stop: "Stop",
};

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const tone = verdict === "candidate" || verdict === "pass"
    ? "border-[#bae6fd] bg-[#f0f9ff] text-[#0369a1]"
    : verdict === "stop"
      ? "border-[#fecaca] bg-[#fef2f2] text-[#b91c1c]"
      : verdict === "weak" || verdict === "needs_data"
        ? "border-[#fde68a] bg-[#fffbeb] text-[#92400e]"
        : "border-[#e6e9ee] bg-[#f8fafc] text-[#556070]";
  return <span className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[12px] font-medium ${tone}`}>{VERDICT_LABEL[verdict]}</span>;
}

function StepCard({ step, index }: { step: WorkflowStep; index: number }) {
  return (
    <li className="border-l-2 border-[#bae6fd] pl-4" data-step={step.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <b className="text-[14px] text-[#1d2733]">{index + 1}. {step.title}</b>
        <VerdictBadge verdict={step.verdict} />
      </div>
      <p className="mt-1 text-[14px] leading-snug text-[#556070]">{step.task}</p>
      <p className="mt-2 text-[12px] font-semibold uppercase tracking-wide text-[#6b7583]">Rule</p>
      <p className="mt-0.5 text-[13px] leading-snug text-[#556070]">{step.rule}</p>
      <dl className="mt-2 grid gap-1 text-[13px]">
        {step.inputs.map((input) => (
          <div key={input.label} className="flex justify-between gap-3 border-b border-[#eef1f4] py-1">
            <dt className="text-[#556070]">{input.label}</dt>
            <dd className="text-right font-medium tabular-nums text-[#1d2733]">{input.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[14px] leading-snug text-[#1d2733]">{step.finding}</p>
      <p className="mt-1 text-[14px] leading-snug text-[#1d2733]"><span className="font-semibold">Next:</span> {step.next}</p>
    </li>
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

  const workflow = useMemo(() => buildWorkflow(result, { live, daily, objective }), [result, live, daily, objective]);
  return (
    <div className="px-6 py-6">
      <Section title="Optimization workflow" subtitle="Fixed rules, same answer every time" sources={["osm", "eia860", "era5_2025", "ieee738"]}>
        <p className="text-[14px] leading-relaxed text-[#556070]">
          Work through these steps in order. Each step applies one written rule to this scan&apos;s numbers and says what to do next.
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
          The objective only sets the fixed order of the shortlist. It never changes a step&apos;s verdict.
        </Caption>
        <ol className="mt-5 space-y-5">
          {workflow.steps.map((step, i) => <StepCard key={step.id} step={step} index={i} />)}
        </ol>
        {workflow.stopped && (
          <Caption className="mt-4">The workflow stopped at step 1, so no options were screened.</Caption>
        )}
        {!workflow.stopped && (
          <div className="mt-6 rounded-md bg-[#f6f8fa] p-4" data-testid="optimization-shortlist">
            <p className="text-[14px] font-semibold text-[#1d2733]">Shortlist for this objective</p>
            {workflow.shortlist.length ? (
              <ol className="mt-2 list-decimal space-y-3 pl-4 text-[14px] leading-snug text-[#1d2733]">
                {workflow.shortlist.map((item) => (
                  <li key={item.option}>
                    <span className="font-semibold">{item.title}</span> <VerdictBadge verdict={item.verdict} />
                    <p className="mt-1 text-[#556070]">{item.why}</p>
                    <p className="mt-1"><span className="font-semibold">First action:</span> {item.firstAction}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-2 text-[14px] text-[#556070]">No option passed its screen here. Gather the data the steps above ask for, then rescan.</p>
            )}
          </div>
        )}
        <Caption className="mt-3">Screening rules for a first look, not an engineering study or a utility decision.</Caption>
      </Section>
      <UpgradePlanSection result={result} />
      <Section title="Compare options" subtitle="Area screening only" sources={["osm", "eia860", "era5_2025", "ieee738"]}>
        <p className="text-[14px] leading-relaxed text-[#556070]">
          Compare plausible directions using evidence for {result.area_label}. The scan does not calculate an optimum, rank by cost, or establish engineering feasibility.
        </p>
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

function UpgradePlanSection({ result }: { result: ScanResult }) {
  const t = result.totals;
  return (
      <Section title="Upgrade plan" subtitle={`Working sequence · ${result.area_label}`}>
        <p className="text-[14px] leading-relaxed text-[#556070]">
          Once a fix is on the shortlist above, these steps turn it into a real project through evidence and review. This is a suggested workflow, not a project schedule or approval checklist.
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
  );
}
