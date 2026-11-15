"use client";

import { FUEL_LABELS } from "@/lib/scan/colors";
import { kvLabel, lineMiles, lineName, substationName } from "@/lib/scan/labels";
import type { FuelKey, Plant, ScanResult } from "@/lib/scan";
import type { ReportTarget } from "@/lib/scan/target";
import { CorridorWeather } from "./CorridorWeather";
import { fmtNum, fmtPowerText, isNum } from "./format";
import { Caption } from "./ui";

/*
 * The asset clicked on the map (or picked in Top plants), shown at the top of
 * the Area tab. Rows with missing data are left out, never filled with a placeholder.
 */

type AssetTarget = Exclude<ReportTarget, { kind: "area" }>;

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";

/** Fuel name mid-sentence ("natural gas", not "Natural gas"). */
function fuelText(k: string): string {
  const label = FUEL_LABELS[k as FuelKey] ?? k.replace(/_/g, " ");
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** "120 MW solar" or "120 MW: solar 60%, battery 40%". */
function plantMix(p: Plant): string {
  const total = p.nameplate_mw || 0;
  const mix = Object.entries(p.mw_by_source)
    .filter(([, v]) => (v ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 3)
    .map(([k, v]) => ({ label: fuelText(k), pct: total > 0 ? Math.round(((v ?? 0) / total) * 100) : 0 }));
  const mw = fmtPowerText(total);
  if (mix.length === 0) return mw;
  if (mix.length === 1) return `${mw} ${mix[0].label}`;
  return `${mw}: ${mix.map((m) => `${m.label} ${m.pct}%`).join(", ")}`;
}

function scanRow(inside: boolean): string {
  return inside ? "Inside your scan area" : "Outside your scan area";
}

function details(t: AssetTarget, result: ScanResult): { title: string; rows: string[]; source: string } {
  if (t.kind === "plant") {
    const p = t.plant;
    const place = [p.city, p.utility_name].filter(Boolean).join(" · ");
    return {
      title: p.plant_name,
      rows: [
        plantMix(p),
        ...(isNum(p.capacity_weighted_age_years)
          ? [`Capacity-weighted age ${fmtNum(p.capacity_weighted_age_years, 0)} yr`]
          : []),
        ...(place ? [place] : []),
        ...(isNum(p.planned_retirement_mw) && p.planned_retirement_mw > 0
          ? [`Planned retirement: ${fmtPowerText(p.planned_retirement_mw)}`]
          : []),
      ],
      source: "Power plant. Source: EIA-860 2025",
    };
  }
  if (t.kind === "substation") {
    const s = t.substation;
    const kv = kvLabel(s.voltage_kv, s.kv_inferred);
    return {
      title: substationName(s),
      rows: [
        ...(kv ? [kv] : []),
        ...(s.operator ? [`Operator: ${s.operator}`] : []),
        scanRow(result.substations.some((x) => x.osm_id === s.osm_id)),
      ],
      source: "Substation. Source: OpenStreetMap",
    };
  }
  const l = t.line;
  const kv = kvLabel(l.voltage_kv, l.kv_inferred);
  const mi = lineMiles(l);
  return {
    title: lineName(l),
    rows: [
      ...(kv ? [kv] : []),
      ...(l.operator ? [`Operator: ${l.operator}`] : []),
      `${fmtNum(mi, mi >= 10 ? 0 : 1)} mi long`,
      scanRow(result.lines.some((x) => x.osm_id === l.osm_id)),
    ],
    source: "Power line. Source: OpenStreetMap",
  };
}

export function SelectedAsset({
  target,
  result,
  onReport,
  onOwners,
  onClear,
}: {
  target: ReportTarget;
  result: ScanResult;
  onReport: (t: ReportTarget) => void;
  onOwners: () => void;
  onClear: () => void;
}) {
  if (target.kind === "area") return null;
  const d = details(target, result);
  return (
    <div className="px-6 pt-6">
      <section
        aria-label="Selected on the map"
        className="rounded-[6px] border border-[#e6e9ee] bg-[#f6f8fa] px-4 py-4"
      >
        <h3 className="text-[15px] font-semibold leading-snug text-[#1d2733]">{d.title}</h3>
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {d.rows.map((r) => (
            <li key={r} className="text-[14px] leading-snug tabular-nums text-[#556070]">
              {r}
            </li>
          ))}
        </ul>
        <Caption className="mt-2">{d.source}</Caption>
        {target.kind === "substation" &&
          (target.substation as { name_source?: string | null })?.name_source === "state_list" && (
            <Caption className="mt-1">Name matched by location from California&apos;s state substation list.</Caption>
          )}
        {target.kind === "line" && <CorridorWeather key={target.line.osm_id} line={target.line} />}
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => onReport(target)}
            className={`h-8 rounded-[6px] bg-[#0ea5e9] px-3 text-[14px] font-semibold text-[#1d2733] transition-colors hover:bg-[#38bdf8] ${FOCUS}`}
          >
            Report a problem
          </button>
          <button
            type="button"
            onClick={onOwners}
            className={`h-8 rounded-[6px] border border-[#e6e9ee] bg-white px-3 text-[14px] font-medium text-[#1d2733] transition-colors hover:bg-[#f6f8fa] ${FOCUS}`}
          >
            Owner filings
          </button>
          <button
            type="button"
            onClick={onClear}
            className={`h-8 rounded-[6px] px-2 text-[13px] font-medium text-[#556070] transition-colors hover:text-[#1d2733] ${FOCUS}`}
          >
            Clear
          </button>
        </div>
      </section>
    </div>
  );
}
