"use client";

import { Cell, Pie, PieChart } from "recharts";
import { FUEL_COLORS, FUEL_LABELS } from "@/lib/scan";
import type { FuelKey, KvBand, LineRatingNow, ScanResult } from "@/lib/scan";
import { DASH, fmtNum, fmtPct, fmtPower, fmtPowerText, isNum } from "./format";
import { Metric, SrcTag, Tile } from "./ui";

const FALLBACK_FUEL = "#94a3b8";
const fuelColor = (k: FuelKey) => FUEL_COLORS[k] ?? FALLBACK_FUEL;
const fuelLabel = (k: FuelKey) => FUEL_LABELS[k] ?? k.replace(/_/g, " ");

const KV_ORDER: KvBand[] = ["500+", "200-499", "100-199", "<100", "unknown"];
const KV_COLOR: Record<KvBand, string> = {
  "500+": "var(--accent)",
  "200-499": "var(--accent-2)",
  "100-199": "color-mix(in srgb, var(--accent-2) 55%, var(--muted))",
  "<100": "var(--muted)",
  unknown: "var(--border-strong)",
};

function SplitBar({ parts }: { parts: { key: string; label: string; value: number; color: string }[] }) {
  const total = parts.reduce((s, p) => s + (isNum(p.value) ? p.value : 0), 0);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg-elevated">
        {total > 0 &&
          parts.map((p) =>
            isNum(p.value) && p.value > 0 ? (
              <div key={p.key} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={p.label} />
            ) : null,
          )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted">
        {parts.map((p) => (
          <span key={p.key} className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: p.color }} />
            {p.label}{" "}
            <span className="num text-ink-dim">{total > 0 && isNum(p.value) ? fmtPct((p.value / total) * 100) : DASH}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function EnergySources({ r }: { r: ScanResult }) {
  const t = r.totals;
  const slices = (Object.entries(t.mw_by_source ?? {}) as [FuelKey, number][])
    .filter(([, mw]) => isNum(mw) && mw > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = slices.reduce((s, [, mw]) => s + mw, 0);
  const other = Math.max(0, (t.nameplate_mw || 0) - (t.renewable_mw || 0) - (t.storage_mw || 0) - (t.fossil_mw || 0));

  return (
    <Tile wide title="Energy sources — renewable vs current" tag={<SrcTag kind="EIA-860" />}>
      {slices.length === 0 ? (
        <p className="text-[11px] text-muted">No power plants in this circle.</p>
      ) : (
        <div className="flex items-center gap-3">
          <div className="relative h-[92px] w-[92px] shrink-0">
            <PieChart width={92} height={92}>
              <Pie
                data={slices.map(([k, mw]) => ({ name: fuelLabel(k), value: mw, key: k }))}
                dataKey="value"
                nameKey="name"
                innerRadius={30}
                outerRadius={44}
                paddingAngle={slices.length > 1 ? 1.5 : 0}
                stroke="none"
                isAnimationActive={false}
              >
                {slices.map(([k]) => (
                  <Cell key={k} fill={fuelColor(k)} />
                ))}
              </Pie>
            </PieChart>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="num text-[15px] font-semibold leading-none text-ink">{fmtPct(t.renewable_pct)}</span>
              <span className="font-mono text-[8px] uppercase tracking-[0.12em] text-muted">renew.</span>
            </div>
          </div>
          <ul className="flex min-w-0 flex-1 flex-col gap-0.5">
            {slices.slice(0, 6).map(([k, mw]) => (
              <li key={k} className="flex items-center justify-between gap-2 text-[10.5px]">
                <span className="flex min-w-0 items-center gap-1.5 text-ink-dim">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-[2px]" style={{ background: fuelColor(k) }} />
                  <span className="truncate">{fuelLabel(k)}</span>
                </span>
                <span className="num shrink-0 text-ink">
                  {fmtPowerText(mw)} <span className="text-muted">{fmtPct((mw / total) * 100)}</span>
                </span>
              </li>
            ))}
            {slices.length > 6 && (
              <li className="text-[10px] text-muted">+{slices.length - 6} more fuels</li>
            )}
          </ul>
        </div>
      )}
      <SplitBar
        parts={[
          { key: "ren", label: "Renewable", value: t.renewable_mw, color: "var(--ok)" },
          { key: "sto", label: "Storage", value: t.storage_mw, color: fuelColor("battery") },
          { key: "fos", label: "Fossil", value: t.fossil_mw, color: fuelColor("natural_gas") },
          ...(other > 0.5 ? [{ key: "oth", label: "Other", value: other, color: fuelColor("other") }] : []),
        ]}
      />
    </Tile>
  );
}

function OutputDraw({ r }: { r: ScanResult }) {
  const t = r.totals;
  const np = fmtPower(t.nameplate_mw);
  const gens = r.plants.reduce((s, p) => s + (isNum(p.generator_count) ? p.generator_count : 0), 0);
  const largest = r.plants[0];
  return (
    <Tile title="Output & power draw" tag={<SrcTag kind="EIA-860" />}>
      <div className="flex items-baseline gap-1.5">
        <span className="num text-[26px] font-semibold leading-none text-ink">{np.value}</span>
        <span className="num text-[11px] text-muted">{np.unit} nameplate</span>
      </div>
      <Metric label="Power plants" value={fmtNum(t.plant_count)} src="EIA-860" />
      <Metric label="Generators" value={fmtNum(gens)} src="EIA-860" />
      <Metric
        label="Largest plant"
        value={largest ? fmtPowerText(largest.nameplate_mw) : DASH}
        src="EIA-860"
      />
      {largest && <p className="truncate text-[10.5px] text-muted">{largest.plant_name}</p>}
    </Tile>
  );
}

function Capacity({ r }: { r: ScanResult }) {
  const t = r.totals;
  const byKv = t.line_miles_by_kv ?? ({} as Record<KvBand, number>);
  const totalMi = KV_ORDER.reduce((s, k) => s + (isNum(byKv[k]) ? byKv[k] : 0), 0);
  return (
    <Tile title="Capacity — wires & substations" tag={<SrcTag kind="OSM" />}>
      <div className="flex items-baseline gap-1.5">
        <span className="num text-[26px] font-semibold leading-none text-ink">{fmtNum(t.line_miles, t.line_miles > 0 && t.line_miles < 10 ? 1 : 0)}</span>
        <span className="num text-[11px] text-muted">mi of transmission line</span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg-elevated">
        {totalMi > 0 &&
          KV_ORDER.map((k) =>
            isNum(byKv[k]) && byKv[k] > 0 ? (
              <div key={k} style={{ width: `${(byKv[k] / totalMi) * 100}%`, background: KV_COLOR[k] }} title={`${k} kV`} />
            ) : null,
          )}
      </div>
      <div className="flex flex-col gap-0.5 text-[10px]">
        {KV_ORDER.map((k) => (
          <span key={k} className="flex items-center justify-between gap-1 text-muted">
            <span className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: KV_COLOR[k] }} />
              {k === "unknown" ? "kV n/a" : `${k} kV`}
            </span>
            <span className="num text-ink-dim">{fmtNum(byKv[k] ?? 0, 0)} mi</span>
          </span>
        ))}
      </div>
      <Metric label="Substations" value={fmtNum(t.substation_count)} src="OSM" />
      <Metric label="High-voltage (≥200 kV)" value={fmtNum(t.hv_substation_count)} src="OSM" />
    </Tile>
  );
}

function EnergyCycle({ r }: { r: ScanResult }) {
  const t = r.totals;
  const solar = t.mw_by_source?.solar ?? 0;
  const storage = t.storage_mw;
  const cover = t.evening_cover_pct;
  const capped = isNum(cover) ? Math.min(cover, 100) : 0;
  return (
    <Tile title="Energy cycle — the sunset handoff" tag={<SrcTag kind="EIA-860" />}>
      <div className="flex items-baseline gap-1.5">
        <span
          className="num text-[26px] font-semibold leading-none"
          style={{ color: isNum(cover) ? (cover < 25 ? "var(--warn)" : "var(--ok)") : "var(--muted)" }}
        >
          {fmtPct(cover)}
        </span>
        <span className="num text-[11px] text-muted">evening cover</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-bg-elevated">
        <div className="h-full" style={{ width: `${capped}%`, background: fuelColor("battery") }} />
      </div>
      <p className="text-[11px] leading-snug text-ink-dim">
        {isNum(cover)
          ? `For every 100 MW of solar that fades at sunset, this circle has ${fmtNum(cover, 0)} MW of batteries ready to pick up the evening peak.`
          : "No solar in this circle, so there is no sunset handoff to manage here."}
      </p>
      <Metric label="Battery storage" value={fmtPowerText(storage)} src="EIA-860" />
      <Metric label="Solar" value={fmtPowerText(solar)} src="EIA-860" />
    </Tile>
  );
}

function Age({ r }: { r: ScanResult }) {
  const t = r.totals;
  return (
    <Tile title="Age of infrastructure" tag={<SrcTag kind="EIA-860" />}>
      <div className="flex items-baseline gap-1.5">
        <span className="num text-[26px] font-semibold leading-none text-ink">
          {isNum(t.cap_weighted_age) ? fmtNum(t.cap_weighted_age, 0) : DASH}
        </span>
        <span className="num text-[11px] text-muted">yr capacity-weighted age</span>
      </div>
      <Metric
        label="Oldest plant"
        value={t.oldest && isNum(t.oldest.year) ? String(t.oldest.year) : DASH}
        src="EIA-860"
      />
      {t.oldest && <p className="-mt-1 truncate text-[10.5px] text-muted">{t.oldest.name}</p>}
      <Metric
        label="Planned retirement"
        value={fmtPowerText(t.planned_retirement_mw)}
        src="EIA-860"
        tone={t.planned_retirement_mw > 0 ? "var(--warn)" : undefined}
      />
      <Metric label="Already retired" value={fmtPowerText(t.retired_mw)} src="EIA-860" />
    </Tile>
  );
}

function Upgrade({ r, live }: { r: ScanResult; live: LineRatingNow | null }) {
  const t = r.totals;
  const extra = live?.extra_pct;
  return (
    <Tile wide title="Upgrade potential">
      <div className="flex items-baseline gap-1.5">
        <span
          className="num text-[26px] font-semibold leading-none"
          style={{ color: isNum(extra) ? (extra < 0 ? "var(--critical)" : "var(--accent)") : "var(--muted)" }}
        >
          {isNum(extra) ? `${extra >= 0 ? "+" : ""}${fmtNum(extra, 0)}%` : DASH}
        </span>
        <span className="num text-[11px] text-muted">live wire headroom</span>
        <SrcTag kind="MODELED" className="ml-auto" />
      </div>
      <Metric label="Proposed generation" value={fmtPowerText(t.proposed_mw)} src="EIA-860" />
      <Metric label="…of which storage" value={fmtPowerText(t.proposed_storage_mw)} src="EIA-860" />
      {r.upgrade_ideas.length > 0 && (
        <ol className="mt-1 flex flex-col gap-1.5">
          {r.upgrade_ideas.map((idea, i) => (
            <li key={i} className="flex gap-2 text-[11px] leading-snug text-ink-dim">
              <span className="num shrink-0 font-semibold text-accent">{i + 1}.</span>
              <span>{idea}</span>
            </li>
          ))}
        </ol>
      )}
    </Tile>
  );
}

export function WhatsHere({ result, live }: { result: ScanResult; live: LineRatingNow | null }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <EnergySources r={result} />
      <OutputDraw r={result} />
      <Capacity r={result} />
      <EnergyCycle r={result} />
      <Age r={result} />
      <Upgrade r={result} live={live} />
    </div>
  );
}
