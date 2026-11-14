"use client";

import type { LineRatingNow, ScanResult } from "@/lib/scan";
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

function Upgrade({ r, live }: { r: ScanResult; live: LineRatingNow | null }) {
  const t = r.totals;
  const extra = live?.extra_pct;
  return (
    <Group title="Upgrade potential" wide sources={["eia860_events", "ieee738"]}>
      <Row label="Line headroom now" value={isNum(extra) ? `${extra >= 0 ? "+" : ""}${fmtNum(extra, 0)}%` : DASH} />
      <Row label="Proposed storage" value={fmtPowerText(t.proposed_storage_mw)} />
      {r.upgrade_ideas.length > 0 && (
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[14px] leading-snug text-[#1d2733] marker:text-[#6b7583]">
          {r.upgrade_ideas.map((idea, i) => (
            <li key={i}>{idea}</li>
          ))}
        </ol>
      )}
    </Group>
  );
}

export function WhatsHere({ result, live }: { result: ScanResult; live: LineRatingNow | null }) {
  return (
    <Section title="What's here">
      <div className="grid grid-cols-2 gap-x-8 gap-y-6">
        <Output r={result} />
        <Capacity r={result} />
        <EnergyCycle r={result} />
        <Age r={result} />
        <Upgrade r={result} live={live} />
      </div>
    </Section>
  );
}
