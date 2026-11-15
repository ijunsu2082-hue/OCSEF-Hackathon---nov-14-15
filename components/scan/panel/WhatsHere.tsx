"use client";

import type { LineRatingNow, ScanResult } from "@/lib/scan";
import type { Improvement } from "@/lib/scan/upgradePlan";
import { DASH, fmtNum, fmtPct, fmtPowerText, isNum } from "./format";
import { Caption, Group, Row, Section } from "./ui";

function Output({ r }: { r: ScanResult }) {
  const t = r.totals;
  const largest = r.plants[0];
  return (
    <Group title="Output" sources={["eia860"]}>
      <Row label="Nameplate" value={fmtPowerText(t.nameplate_mw)} />
      <Row label="Power plants" value={fmtNum(t.plant_count)} />
      <Row label="Largest plant" value={largest ? fmtPowerText(largest.nameplate_mw) : DASH} />
      {largest && <Caption className="truncate">{largest.plant_name}</Caption>}
    </Group>
  );
}

function Capacity({ r }: { r: ScanResult }) {
  const t = r.totals;
  return (
    <Group title="Capacity" sources={["osm", "eia860"]}>
      <Row label="Transmission lines" value={`${fmtNum(t.line_miles, t.line_miles > 0 && t.line_miles < 10 ? 1 : 0)} mi`} />
      <Row label="Substations" value={fmtNum(t.substation_count)} />
      <Row label={<span className="pl-3">200 kV and up</span>} value={<span className="font-normal">{fmtNum(t.hv_substation_count)}</span>} />
    </Group>
  );
}

function EnergyCycle({ r }: { r: ScanResult }) {
  const t = r.totals;
  const cover = t.evening_cover_pct;
  return (
    <Group title="Energy cycle" sources={["eia860"]}>
      <Row label="Evening cover" value={fmtPct(cover)} />
      <p className="mb-1 text-[13px] leading-snug text-[#556070]">
        {isNum(cover)
          ? `For every 100 MW of solar lost at sunset, there are ${fmtNum(cover, 0)} MW of batteries here.`
          : "No solar here, so there is no sunset handoff."}
      </p>
    </Group>
  );
}

function Age({ r }: { r: ScanResult }) {
  const t = r.totals;
  return (
    <Group title="Age" sources={["eia860"]}>
      <Row label="Capacity-weighted age" value={isNum(t.cap_weighted_age) ? `${fmtNum(t.cap_weighted_age, 0)} yr` : DASH} />
      <Row label="Oldest plant" value={t.oldest && isNum(t.oldest.year) ? String(t.oldest.year) : DASH} />
      {t.oldest && <Caption className="truncate">{t.oldest.name}</Caption>}
    </Group>
  );
}

function Upgrade({
  r,
  live,
  insights,
  onOpenInsight,
}: {
  r: ScanResult;
  live: LineRatingNow | null;
  insights: Improvement[];
  onOpenInsight?: (id: string) => void;
}) {
  const t = r.totals;
  const extra = live?.extra_pct;
  return (
    <Group title="Upgrade potential" wide sources={["eia860_events", "ieee738"]}>
      <Row label="Line headroom now" value={isNum(extra) ? `${extra >= 0 ? "+" : ""}${fmtNum(extra, 0)}%` : DASH} />
      <Row label="Proposed storage" value={fmtPowerText(t.proposed_storage_mw)} />
      {insights.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {insights.map((insight) => (
            <button
              key={insight.id}
              type="button"
              disabled={!onOpenInsight}
              onClick={() => onOpenInsight?.(insight.id)}
              title={insight.headline}
              className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#dbe5f0] bg-[#f8fbfe] px-2 py-1 text-left transition-colors hover:border-[#0ea5e9] hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9] disabled:cursor-default"
            >
              <span className="rounded-[3px] bg-[#e0f2fe] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[#0369a1]">
                Insight
              </span>
              <span className="text-[13px] font-medium leading-snug text-[#1d2733]" title={insight.headline}>
                {insight.label}
              </span>
              <span aria-hidden className="text-[13px] text-[#0369a1]">
                →
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-2">
        <Caption>Each opens its exact steps in Optimize &amp; upgrade.</Caption>
      </div>
    </Group>
  );
}

export function WhatsHere({
  result,
  live,
  insights,
  onOpenInsight,
}: {
  result: ScanResult;
  live: LineRatingNow | null;
  insights: Improvement[];
  onOpenInsight?: (id: string) => void;
}) {
  return (
    <Section title="What's here">
      <div className="grid grid-cols-2 gap-x-8 gap-y-6">
        <Output r={result} />
        <Capacity r={result} />
        <EnergyCycle r={result} />
        <Age r={result} />
        <Upgrade r={result} live={live} insights={insights} onOpenInsight={onOpenInsight} />
      </div>
    </Section>
  );
}
