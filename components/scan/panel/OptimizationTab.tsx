"use client";

import { useEffect, useRef, useState } from "react";
import type { GrantMatch } from "@/lib/scan/grants";
import {
  upgradePlanMarkdown,
  type Improvement,
  type UpgradePlan,
} from "@/lib/scan/upgradePlan";
import { Caption, Section } from "./ui";

/*
 * Two steps and nothing else: pick the lever, then read its plan. The chooser
 * is built from the scan, so the options and their numbers change with the
 * circle. No forms, drafts, assignments or seeded scenarios on this screen.
 */

const LABEL = "text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6b7583]";

const PRIORITY: Record<Improvement["severity"], { label: string; color: string; background: string }> = {
  critical: { label: "Top priority", color: "#b91c1c", background: "#fef2f2" },
  high: { label: "High priority", color: "#b45309", background: "#fffbeb" },
  medium: { label: "Worth doing", color: "#0369a1", background: "#f0f9ff" },
  low: { label: "Low priority", color: "#556070", background: "#f6f8fa" },
};

function PriorityPill({ severity }: { severity: Improvement["severity"] }) {
  const style = PRIORITY[severity];
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ color: style.color, background: style.background }}
    >
      {style.label}
    </span>
  );
}

function LeverChooser({
  plan,
  activeId,
  onSelect,
}: {
  plan: UpgradePlan;
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="What do you want to improve?" className="grid gap-2 sm:grid-cols-2">
      {plan.improvements.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(item.id)}
            className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9] ${
              active
                ? "border-[#0ea5e9] bg-[#f0f9ff]"
                : "border-[#e6e9ee] bg-white hover:border-[#cbd5e1] hover:bg-[#f6f8fa]"
            }`}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold leading-snug text-[#1d2733]">{item.label}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-[#556070]">{item.headline}</span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-[11px] leading-snug text-[#6b7583]">
                {item.steps.length} step{item.steps.length === 1 ? "" : "s"}
              </span>
              <span className="mt-1 block text-[11px] font-semibold" style={{ color: PRIORITY[item.severity].color }}>
                {PRIORITY[item.severity].label}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const FUNDING_STATUS: Record<GrantMatch["status"], string> = {
  open: "Open listing",
  forecasted: "Forecast",
  notice: "Funding notice",
  program: "Programme page",
};

function LeverPlan({
  item,
  grants,
  state,
}: {
  item: Improvement;
  grants: UpgradePlan["grants"];
  state: string | null;
}) {
  const matched = item.funding;
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-[15px] font-semibold leading-snug text-[#1d2733]">{item.target}</p>
        <PriorityPill severity={item.severity} />
      </div>
      <p className="mt-2 text-[14px] leading-relaxed text-[#1d2733]">{item.finding}</p>

      <dl className="mt-3 grid grid-cols-3 gap-x-4 border-y border-[#eef1f4] py-3">
        {item.metrics.map((metric) => (
          <div key={metric.label} className="min-w-0">
            <dt className="text-[11px] leading-snug text-[#6b7583]">{metric.label}</dt>
            <dd className="text-[15px] font-semibold tabular-nums leading-snug text-[#1d2733]">{metric.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 flex flex-col gap-1 text-[13px] leading-relaxed">
        <p className="text-[#1d2733]">
          <span className="font-semibold">How: </span>
          {item.how}
        </p>
        <p className="text-[#556070]">
          <span className="font-medium text-[#1d2733]">Tradeoff: </span>
          {item.tradeoff}
        </p>
      </div>

      <p className={`${LABEL} mt-5`}>Steps</p>
      <ol className="mt-1">
        {item.steps.map((step, index) => (
          <li
            key={`${item.id}-${index}`}
            className="grid grid-cols-[1.25rem_1fr] gap-x-2 border-t border-[#eef1f4] py-2.5 first:border-t-0 first:pt-1"
          >
            <span aria-hidden className="mt-0.5 text-[12px] font-semibold tabular-nums text-[#0369a1]">
              {index + 1}.
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-medium leading-snug text-[#1d2733]">
                {step.title}
                <span className="ml-2 rounded-[3px] bg-[#f1f5f9] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[#556070]">
                  {step.kind}
                </span>
              </p>
              <p className="text-[12px] text-[#6b7583]">
                {step.who} · {step.when}
              </p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-[#556070]">{step.detail}</p>
              <p className="text-[12px] leading-snug text-[#6b7583]">Done: {step.done}</p>
            </div>
          </li>
        ))}
      </ol>

      {matched.length > 0 && (
        <div className="mt-4">
          <p className={LABEL}>Funding for this lever</p>
          <ul className="mt-1 flex flex-col gap-2">
            {matched.map((match) => (
              <li key={match.id} className="rounded-md border border-[#e6e9ee] px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[13px] font-semibold leading-snug text-[#1d2733]">{match.title}</p>
                  <span className="text-[11px] uppercase tracking-[0.06em] text-[#6b7583]">
                    {FUNDING_STATUS[match.status]}
                    {match.deadline ? ` · closes ${match.deadline}` : ""}
                  </span>
                </div>
                <p className="text-[12px] leading-relaxed text-[#556070]">{match.why}</p>
                <p className="text-[12px] leading-relaxed text-[#556070]">
                  <span className="font-medium text-[#1d2733]">Next: </span>
                  {match.next}
                </p>
                <a
                  href={match.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[12px] text-[#0369a1] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]"
                >
                  {match.source === "opportunity" ? `${match.via} entry` : "Official programme page"}
                </a>
              </li>
            ))}
          </ul>
          <Caption>
            Matched from {grants.watched}/{grants.total} watched programmes and {grants.listings} live listing
            {grants.listings === 1 ? "" : "s"} across {grants.feedsWatched}/{grants.feeds} aggregators, last checked{" "}
            {grants.checkedAt.slice(0, 10)}.
          </Caption>
        </div>
      )}
      {matched.length === 0 && (
        <Caption>
          No watched source covers this lever for {state ? `${state} yet` : "this area"}. Funding is left blank rather than guessed.
        </Caption>
      )}
    </div>
  );
}

export function OptimizationTab({
  plan,
  areaLabel,
  radiusMi,
  selectedId,
  onSelect,
}: {
  plan: UpgradePlan;
  areaLabel: string;
  radiusMi: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const active = plan.improvements.find((item) => item.id === selectedId) ?? plan.improvements[0];
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (!active) {
    return (
      <div className="px-6 py-6 text-[14px] text-[#556070]">
        No lever can be ranked for this circle. Move the scan onto mapped lines or plants.
      </div>
    );
  }

  const copyPlan = async () => {
    try {
      await navigator.clipboard.writeText(upgradePlanMarkdown(plan, areaLabel, radiusMi, active.id));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy("idle"), 2000);
  };

  return (
    <div>
      <header className="px-6 py-5">
        <p className={LABEL}>Upgrade plan</p>
        <h3 className="mt-1 text-[18px] font-semibold leading-snug text-[#1d2733]">{active.headline}</h3>
        <p className="mt-1 text-[13px] leading-snug text-[#556070]">{plan.summary}</p>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1">
          {plan.facts.map((fact) => (
            <div key={fact.label} className="flex items-baseline gap-1.5">
              <dt className="text-[12px] text-[#6b7583]">{fact.label}</dt>
              <dd className="text-[13px] font-semibold tabular-nums text-[#1d2733]">{fact.value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <Section title="What do you want to improve?" subtitle="Built from this circle. Reopen the tab after moving the scan.">
        <LeverChooser plan={plan} activeId={active.id} onSelect={onSelect} />
      </Section>

      <Section
        title={active.label}
        subtitle={`${active.steps.length} step${active.steps.length === 1 ? "" : "s"} · ${plan.operators[0]?.name ?? "operator not in the map data"}`}
        sources={["eia860", "osm", "era5_2025", "ieee738"]}
      >
        <LeverPlan item={active} grants={plan.grants} state={plan.state} />
      </Section>

      <Section title="Before you rely on it">
        <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] leading-relaxed text-[#556070]">
          {plan.caveats.map((item) => (
            <li key={item}>{item}</li>
          ))}
          <li>Not in this plan yet: {plan.needData.join("; ")}.</li>
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void copyPlan()}
            aria-live="polite"
            className="h-8 rounded-[6px] border border-[#d8dee6] bg-white px-3 text-[13px] font-medium text-[#1d2733] transition-colors hover:bg-[#f6f8fa] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]"
          >
            {copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy these steps"}
          </button>
          <Caption>{plan.operators.length > 0 ? `Named here: ${plan.operators.map((operator) => operator.name).join(", ")}.` : ""}</Caption>
        </div>
      </Section>
    </div>
  );
}
