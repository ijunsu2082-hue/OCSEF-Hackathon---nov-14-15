"use client";

import { CATEGORY_COLORS, CATEGORY_LABELS, FUEL_LABELS } from "@/lib/scan/colors";
import type { EnergyCategory } from "@/lib/scan/colors";
import type { FuelKey, KvBand, LineRatingNow, ScanResult } from "@/lib/scan";
import { DASH, fmtNum, fmtPct, fmtPowerText, isNum } from "./format";
import { Caption, Group, Row, Section } from "./ui";

const fuelLabel = (k: FuelKey) => FUEL_LABELS[k] ?? String(k).replace(/_/g, " ");

const KV_ORDER: KvBand[] = ["500+", "200-499", "100-199", "<100", "unknown"];
const KV_LABEL: Record<KvBand, string> = {
  "500+": "500 kV and up",
  "200-499": "200 to 499 kV",
  "100-199": "100 to 199 kV",
  "<100": "Under 100 kV",
  unknown: "Voltage unknown",
};

function EnergySources({ r }: { r: ScanResult }) {
  const t = r.totals;
  const other = Math.max(0, (t.nameplate_mw || 0) - (t.renewable_mw || 0) - (t.storage_mw || 0) - (t.fossil_mw || 0));
  const parts: { cat: EnergyCategory; mw: number }[] = [
    { cat: "renewable", mw: isNum(t.renewable_mw) ? t.renewable_mw : 0 },
    { cat: "storage", mw: isNum(t.storage_mw) ? t.storage_mw : 0 },
    { cat: "fossil", mw: isNum(t.fossil_mw) ? t.fossil_mw : 0 },
    ...(other > 0.5 ? [{ cat: "other" as EnergyCategory, mw: other }] : []),
  ];
  const total = parts.reduce((s, p) => s + p.mw, 0);
  const fuels = (Object.entries(t.mw_by_source ?? {}) as [FuelKey, number][])
    .filter(([, mw]) => isNum(mw) && mw > 0)
    .sort((a, b) => b[1] - a[1]);
  const fuelTotal = fuels.reduce((s, [, mw]) => s + mw, 0);

  return (
    <Group title="Energy sources" wide>
      {total <= 0 ? (
        <p className="text-[13px] text-[#556070]">No power plants in this area.</p>
      ) : (
        <>
          <div className="flex h-2 w-full gap-px overflow-hidden rounded-[2px] bg-white" aria-hidden>
            {parts.map((p) =>
              p.mw > 0 ? (
                <div key={p.cat} style={{ width: `${(p.mw / total) * 100}%`, background: CATEGORY_COLORS[p.cat] }} />
              ) : null,
            )}
          </div>
          <p className="mb-2 mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px] tabular-nums text-[#556070]">
            {parts.map((p) => (
              <span key={p.cat} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: CATEGORY_COLORS[p.cat] }} />
                {CATEGORY_LABELS[p.cat]} {fmtPct((p.mw / total) * 100)}
              </span>
            ))}
          </p>
          {fuels.slice(0, 4).map(([k, mw]) => (
            <Row
              key={k}
              label={fuelLabel(k)}
              value={
                <>
                  {fmtPowerText(mw)}{" "}
                  <span className="font-normal text-[#6b7583]">{fmtPct((mw / fuelTotal) * 100)}</span>
                </>
              }
            />
          ))}
        </>
      )}
    </Group>
  );
}

function Output({ r }: { r: ScanResult }) {
  const t = r.totals;
  const largest = r.plants[0];
  return (
    <Group title="Output">
      <Row label="Nameplate" value={fmtPowerText(t.nameplate_mw)} />
      <Row label="Power plants" value={fmtNum(t.plant_count)} />
      <Row label="Largest plant" value={largest ? fmtPowerText(largest.nameplate_mw) : DASH} />
      {largest && <Caption className="truncate">{largest.plant_name}</Caption>}
    </Group>
  );
}

function Capacity({ r }: { r: ScanResult }) {
  const t = r.totals;
  const byKv = t.line_miles_by_kv ?? ({} as Record<KvBand, number>);
  const bands = KV_ORDER.filter((k) => isNum(byKv[k]) && byKv[k] >= 0.5);
  return (
    <Group title="Capacity">
      <Row label="Transmission lines" value={`${fmtNum(t.line_miles, t.line_miles > 0 && t.line_miles < 10 ? 1 : 0)} mi`} />
      {bands.map((k) => (
        <Row
          key={k}
          label={<span className="pl-3">{KV_LABEL[k]}</span>}
          value={<span className="font-normal">{fmtNum(byKv[k], 0)} mi</span>}
        />
      ))}
      <Row label="Substations" value={fmtNum(t.substation_count)} />
      <Row label={<span className="pl-3">200 kV and up</span>} value={<span className="font-normal">{fmtNum(t.hv_substation_count)}</span>} />
    </Group>
  );
}

function EnergyCycle({ r }: { r: ScanResult }) {
  const t = r.totals;
  const solar = t.mw_by_source?.solar ?? 0;
  const cover = t.evening_cover_pct;
  return (
    <Group title="Energy cycle">
      <Row label="Evening cover" value={fmtPct(cover)} />
      <p className="mb-1 text-[13px] leading-snug text-[#556070]">
        {isNum(cover)
          ? `For every 100 MW of solar lost at sunset, there are ${fmtNum(cover, 0)} MW of batteries here.`
          : "No solar here, so there is no sunset handoff."}
      </p>
      <Row label="Battery storage" value={fmtPowerText(t.storage_mw)} />
      <Row label="Solar" value={fmtPowerText(solar)} />
    </Group>
  );
}

function Age({ r }: { r: ScanResult }) {
  const t = r.totals;
  return (
    <Group title="Age">
      <Row label="Capacity-weighted age" value={isNum(t.cap_weighted_age) ? `${fmtNum(t.cap_weighted_age, 0)} yr` : DASH} />
      <Row label="Oldest plant" value={t.oldest && isNum(t.oldest.year) ? String(t.oldest.year) : DASH} />
      {t.oldest && <Caption className="truncate">{t.oldest.name}</Caption>}
      <Row label="Planned retirement" value={fmtPowerText(t.planned_retirement_mw)} />
      <Row label="Already retired" value={fmtPowerText(t.retired_mw)} />
    </Group>
  );
}

function Upgrade({ r, live }: { r: ScanResult; live: LineRatingNow | null }) {
  const t = r.totals;
  const extra = live?.extra_pct;
  return (
    <Group title="Upgrade potential" wide>
      <Row label="Line headroom now" value={isNum(extra) ? `${extra >= 0 ? "+" : ""}${fmtNum(extra, 0)}%` : DASH} />
      <Row label="Proposed generation" value={fmtPowerText(t.proposed_mw)} />
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
        <EnergySources r={result} />
        <Output r={result} />
        <Capacity r={result} />
        <EnergyCycle r={result} />
        <Age r={result} />
        <Upgrade r={result} live={live} />
      </div>
      <Caption className="mt-6">Source: EIA-860 2025 · OpenStreetMap. Line headroom modeled with IEEE 738.</Caption>
    </Section>
  );
}
