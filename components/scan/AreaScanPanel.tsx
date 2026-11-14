"use client";

import { useMemo, useState } from "react";
import type { ScanResult } from "@/lib/scan/areaScan";
import { haversineMi } from "@/lib/scan/areaScan";
import type { NicheCase } from "@/lib/niche";
import { fmtNumber } from "@/lib/format";
import { Sparkline } from "@/components/primitives/Sparkline";
import { dayLabel, hourLabel } from "@/lib/scan/wire";

interface Props {
  result: ScanResult | null;
  radius: number;
  loading: boolean;
  error: string | null;
  heatwave: boolean;
  nicheCases: NicheCase[];
  onRadius: (radius: number) => void;
  onClose: () => void;
}

const RISK_COLOR: Record<ScanResult["risk"]["level"], string> = {
  LOW: "var(--risk-low, #2dd4a7)",
  WATCH: "var(--risk-watch, #e8a33d)",
  HIGH: "var(--risk-high, #f97316)",
  CRITICAL: "var(--risk-critical, #f04d5e)",
};

const KV_ORDER = ["500+", "200-499", "100-199", "<100", "unknown"] as const;
const KV_LABEL: Record<string, string> = {
  "500+": "500 kV and up",
  "200-499": "200 to 499 kV",
  "100-199": "100 to 199 kV",
  "<100": "Under 100 kV",
  unknown: "Voltage unknown",
};

const FUEL_LABEL: Record<string, string> = {
  natural_gas: "Natural gas",
  other_gas: "Other gas",
  oil: "Oil",
  solar: "Solar",
  wind: "Wind",
  hydro: "Hydro",
  battery: "Battery",
  biogas: "Biogas",
  waste_heat: "Waste heat",
};

const fuelLabel = (key: string) => FUEL_LABEL[key] ?? key.replace(/_/g, " ");
const isUrl = (value: string) => /^https?:\/\//i.test(value.trim());

function Row({ label, value, sub }: { label: string; value: string; sub?: boolean }) {
  return (
    <div className={`scan-row${sub ? " is-sub" : ""}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function Group({
  title,
  wide,
  children,
}: {
  title: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`scan-group${wide ? " is-wide" : ""}`}>
      <h4>{title}</h4>
      {children}
    </div>
  );
}

/** The stacked mix bar from PR #2's "What's here": proportions at a glance. */
function MixBar({ result }: { result: ScanResult }) {
  const other = Math.max(
    0,
    result.nameplate_mw - result.renewable_mw - result.storage_mw - result.fossil_mw,
  );
  const parts = [
    { key: "renewable", label: "Renewable", mw: result.renewable_mw },
    { key: "storage", label: "Storage", mw: result.storage_mw },
    { key: "fossil", label: "Fossil", mw: result.fossil_mw },
    ...(other > 0.5 ? [{ key: "other", label: "Other", mw: other }] : []),
  ].filter((part) => part.mw > 0);
  const total = parts.reduce((sum, part) => sum + part.mw, 0);
  if (total <= 0) return <p className="scan-empty">No power plants in this area.</p>;

  return (
    <>
      <div className="scan-mix" aria-hidden>
        {parts.map((part) => (
          <span
            key={part.key}
            data-kind={part.key}
            style={{ width: `${(part.mw / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="scan-mix-legend">
        {parts.map((part) => (
          <span key={part.key}>
            <i data-kind={part.key} aria-hidden />
            {part.label} {fmtNumber((part.mw / total) * 100, 0)}%
          </span>
        ))}
      </div>
    </>
  );
}

export default function AreaScanPanel({
  result,
  radius,
  loading,
  error,
  heatwave,
  nicheCases,
  onRadius,
  onClose,
}: Props) {
  const [copied, setCopied] = useState(false);

  async function copyReport() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const bands = result
    ? KV_ORDER.filter((band) => (result.line_miles_by_kv[band] ?? 0) >= 0.5)
    : [];

  const fuels = useMemo(() => {
    if (!result) return [];
    const total = Object.values(result.mw_by_source).reduce((sum, mw) => sum + mw, 0);
    return Object.entries(result.mw_by_source)
      .filter(([, mw]) => mw > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([key, mw]) => ({ key, mw, pct: total > 0 ? (mw / total) * 100 : 0 }));
  }, [result]);

  const casesHere = useMemo(() => {
    if (!result) return [];
    return nicheCases
      .map((entry) => ({
        entry,
        distance_mi: haversineMi(
          result.point.lat,
          result.point.lon,
          entry.location.lat,
          entry.location.lon,
        ),
      }))
      .filter(({ distance_mi }) => distance_mi <= result.point.radius_mi)
      .sort((a, b) => a.distance_mi - b.distance_mi);
  }, [nicheCases, result]);

  // News and document links for the cases above. These are reporting, not
  // generation: they never enter the energy mix or a capacity figure.
  const news = useMemo(() => {
    const seen = new Set<string>();
    const out: { title: string; url: string }[] = [];
    for (const { entry } of casesHere) {
      for (const stat of entry.stats) {
        const url = stat.source.trim();
        if (!isUrl(url) || seen.has(url)) continue;
        seen.add(url);
        out.push({ title: entry.title, url });
      }
    }
    return out.slice(0, 10);
  }, [casesHere]);

  const wire = result?.wire ?? null;
  const archiveRatio = wire?.now?.ratio ?? null;
  const activeRatio = wire ? (heatwave ? wire.heatwave.ratio : archiveRatio) : null;
  const headroomPct =
    activeRatio === null ? null : Math.round(Math.abs(activeRatio - 1) * 100);
  const dayRatios = wire ? wire.today.map((hour) => hour.ratio) : [];

  return (
    <aside className="scan-panel" aria-label="Area scan result">
      <header className="scan-head">
        <div className="scan-head-text">
          <span className="scan-kicker">Area scan · {radius} mi</span>
          <b>{result ? result.label : "Click the map"}</b>
          {result ? (
            <small className="scan-coords">
              {result.point.lat.toFixed(3)}, {result.point.lon.toFixed(3)}
            </small>
          ) : null}
        </div>
        <button type="button" className="scan-close" onClick={onClose} aria-label="Close scan">
          ×
        </button>
      </header>

      <label className="scan-radius">
        <span>Radius</span>
        <input
          type="range"
          min={1}
          max={25}
          step={1}
          value={radius}
          onChange={(event) => onRadius(Number(event.target.value))}
          aria-label="Scan radius in miles"
        />
        <b>{radius} mi</b>
      </label>

      {error ? <p className="scan-error">{error}</p> : null}
      {loading ? <p className="scan-note">Loading grid layers…</p> : null}
      {!loading && !result && !error ? (
        <p className="scan-note">
          Scan mode is on. Click anywhere on the map to read the generation, transmission and
          redundancy inside that circle.
        </p>
      ) : null}

      {result && !result.inside_coverage ? (
        <p className="scan-note">
          Outside the 100 mi data footprint: the plant and line layers may be incomplete here.
        </p>
      ) : null}

      {result ? (
        <div className="scan-body">
          <div className="scan-score">
            <b style={{ color: RISK_COLOR[result.risk.level] }}>{result.risk.score}</b>
            <div>
              <span style={{ color: RISK_COLOR[result.risk.level] }}>
                {result.risk.level}
              </span>
              <small>area risk{heatwave ? " · heatwave" : ""}</small>
            </div>
          </div>

          <section className="scan-section">
            <h3>What&apos;s here</h3>
            <div className="scan-grid">
              <Group title="Energy sources" wide>
                <MixBar result={result} />
                {fuels.map((fuel) => (
                  <Row
                    key={fuel.key}
                    sub
                    label={fuelLabel(fuel.key)}
                    value={`${fmtNumber(fuel.mw, 0)} MW · ${fmtNumber(fuel.pct, 0)}%`}
                  />
                ))}
                {result.plants.length === 0 ? (
                  <Row label="Nameplate" value="0 MW" />
                ) : null}
              </Group>

              <Group title="Output">
                <Row label="Nameplate" value={`${fmtNumber(result.nameplate_mw, 0)} MW`} />
                <Row label="Power plants" value={fmtNumber(result.plant_count, 0)} />
                <Row
                  label="Largest plant"
                  value={result.plants[0] ? `${fmtNumber(result.plants[0].mw, 1)} MW` : "—"}
                />
                {result.plants[0] ? (
                  <p className="scan-caption">{result.plants[0].name}</p>
                ) : null}
              </Group>

              <Group title="Capacity">
                <Row
                  label="Transmission"
                  value={`${fmtNumber(result.line_miles, result.line_miles < 10 ? 1 : 0)} mi`}
                />
                {bands.map((band) => (
                  <Row
                    key={band}
                    sub
                    label={KV_LABEL[band]}
                    value={`${fmtNumber(result.line_miles_by_kv[band], 0)} mi`}
                  />
                ))}
                <Row label="Substations" value={fmtNumber(result.substation_count, 0)} />
                <Row
                  sub
                  label="200 kV and up"
                  value={fmtNumber(result.hv_substation_count, 0)}
                />
              </Group>

              <Group title="Energy cycle">
                <Row
                  label="Evening cover"
                  value={
                    result.evening_cover_pct === null
                      ? "n/a"
                      : `${fmtNumber(result.evening_cover_pct, 0)}%`
                  }
                />
                <p className="scan-caption">
                  {result.evening_cover_pct === null
                    ? "No solar here, so there is no sunset handoff."
                    : `For every 100 MW of solar lost at sunset there are ${fmtNumber(result.evening_cover_pct, 0)} MW of batteries.`}
                </p>
                <Row label="Battery storage" value={`${fmtNumber(result.storage_mw, 0)} MW`} />
                <Row
                  label="Solar"
                  value={`${fmtNumber(result.mw_by_source.solar ?? 0, 0)} MW`}
                />
              </Group>

              <Group title="Age">
                <Row
                  label="Capacity-weighted"
                  value={
                    result.cap_weighted_age === null
                      ? "n/a"
                      : `${fmtNumber(result.cap_weighted_age, 0)} yr`
                  }
                />
                <Row
                  label="Oldest plant"
                  value={result.oldest_plant ? String(result.oldest_plant.year) : "n/a"}
                />
                {result.oldest_plant ? (
                  <p className="scan-caption">{result.oldest_plant.name}</p>
                ) : null}
                <Row
                  label="Planned retirement"
                  value={
                    result.plant_count === 0
                      ? "n/a"
                      : result.planned_retirement_mw > 0
                        ? `${fmtNumber(result.planned_retirement_mw, 0)} MW`
                        : "none listed"
                  }
                />
                <p className="scan-caption">
                  {result.plant_count === 0
                    ? "No plants in this circle, so there is nothing to retire."
                    : result.planned_retirement_plants > 0
                      ? `${result.planned_retirement_plants} plant${
                          result.planned_retirement_plants === 1 ? "" : "s"
                        } carry a retirement date in the EIA-860 2025 extract.`
                      : "The EIA-860 2025 extract lists no planned retirement date for the plants in this circle."}
                </p>
              </Group>

              {result.nearest_load_center ? (
                <Group title="Nearest load">
                  <Row
                    label="Load center"
                    value={`${fmtNumber(result.nearest_load_center.draw_mw, 0)} MW`}
                  />
                  <p className="scan-caption">{result.nearest_load_center.name}</p>
                  <Row
                    label="Distance"
                    value={`${fmtNumber(result.nearest_load_center.distance_mi, 1)} mi`}
                  />
                </Group>
              ) : null}

              <Group title="Upgrade potential" wide>
                <ol className="scan-ideas">
                  {result.ideas.map((idea) => (
                    <li key={idea}>{idea}</li>
                  ))}
                </ol>
              </Group>
            </div>
            <p className="scan-caption scan-source">
              Source: EIA-860 2025 · OpenStreetMap (ODbL) · 2024 weather archive. Line ratings are
              MODELED (IEEE 738 screening), not operating ratings.
            </p>
          </section>

          {wire ? (
            <section className="scan-section">
              <h3>The wire that breathes</h3>
              <div className="scan-wire">
                <div className="scan-wire-head">
                  <b
                    style={{
                      color:
                        activeRatio !== null && activeRatio < 1 ? RISK_COLOR.HIGH : undefined,
                    }}
                  >
                    {activeRatio === null ? "—" : `${fmtNumber(activeRatio, 2)}×`}
                  </b>
                  <div>
                    <span>
                      {activeRatio === null
                        ? "No weather for this hour in the archive."
                        : heatwave
                          ? `At 105 °F a 3 m/s breeze returns ${fmtNumber(activeRatio, 2)}× the fixed rating.`
                          : activeRatio >= 1
                            ? `Lines here can carry ${headroomPct}% more than their still-air rating at this hour.`
                            : `Calm air caps the line ${headroomPct}% below its still-air rating at this hour.`}
                    </span>
                    <small>
                      {wire.conductor} · {wire.voltage_kv} kV · {wire.site}
                    </small>
                  </div>
                </div>

                {dayRatios.length > 1 ? (
                  <>
                    <Sparkline
                      values={dayRatios}
                      floor={0.75}
                      width={290}
                      height={34}
                      area
                      className="scan-wire-chart"
                    />
                    <div className="scan-wire-axis">
                      <span>00:00</span>
                      <span>{dayLabel(wire.now?.time ?? null)}</span>
                      <span>23:00</span>
                    </div>
                  </>
                ) : null}

                <Row label="Still-air rating" value={`${fmtNumber(wire.still_air_a, 0)} A`} />
                <Row label="With this wind" value={`${fmtNumber(wire.breeze_a, 0)} A`} />
                <Row label="2024 median gain" value={`${wire.median_ratio.toFixed(2)}×`} />
                <Row
                  label="Hours above still air"
                  value={`${fmtNumber(wire.pct_hours_above_still_air, 0)}%`}
                />
                {wire.hottest ? (
                  <Row
                    label="Hottest hour"
                    value={`${wire.hottest.ratio.toFixed(2)}× · ${fmtNumber(wire.hottest.temp_c, 1)} °C`}
                  />
                ) : null}
                <p className="scan-caption">
                  {wire.now ? `${hourLabel(wire.now.time)} in the 2024 archive. ` : ""}
                  Still air is 0.61 m/s; temperature and sun are held at the hour&apos;s own
                  values, so the difference is the wind alone.
                </p>
                <p className="scan-caption">
                  105 °F: fixed rating {fmtNumber(wire.heatwave.derate_pct, 1)}% lower, a 3 m/s
                  breeze returns {wire.heatwave.ratio.toFixed(2)}×.
                </p>
              </div>
            </section>
          ) : null}

          <section className="scan-section">
            <h3>Why this score</h3>
            <ul className="scan-factors">
              {result.risk.factors.map((factor) => (
                <li key={factor.label}>
                  <span className="scan-factor-head">
                    {factor.label}
                    <b>{factor.score}</b>
                  </span>
                  <span className="scan-meter">
                    <span style={{ width: `${Math.min(100, factor.score)}%` }} />
                  </span>
                  <span className="scan-factor-detail">{factor.detail}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="scan-section">
            <h3>Niche cases in this circle</h3>
            {casesHere.length === 0 ? (
              <p className="scan-caption">
                No documented cases inside this circle. Widen the radius or move the scan.
              </p>
            ) : (
              <ul className="scan-cases">
                {casesHere.map(({ entry, distance_mi }) => (
                  <li key={entry.id}>
                    <b>{entry.title}</b>
                    <span className="scan-case-meta">
                      {entry.category} · {fmtNumber(distance_mi, 1)} mi
                    </span>
                    <span className="scan-case-text">{entry.shock_line}</span>
                    <span className="scan-case-tags">
                      {[...new Set(entry.stats.map((stat) => stat.kind))].map((kind) => (
                        <span key={kind} className={`tag tag-${kind}`}>
                          {kind}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {news.length > 0 ? (
            <section className="scan-section">
              <h3>In the news</h3>
              <p className="scan-caption">
                Reporting and document links for the cases above. These are not generation
                assets and are never counted in an energy or capacity figure.
              </p>
              <ul className="scan-news">
                {news.map((item) => (
                  <li key={item.url}>
                    <a href={item.url} target="_blank" rel="noopener noreferrer">
                      {item.title}
                    </a>
                    <span>{new URL(item.url).hostname.replace(/^www\./, "")}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="scan-section">
            <h3>Top plants</h3>
            {result.plants.length === 0 ? (
              <p className="scan-caption">No power plants in this area.</p>
            ) : (
              <ul className="scan-news">
                {result.plants.map((plant) => (
                  <li key={`${plant.name}-${plant.distance_mi}`}>
                    <b>{plant.name}</b>
                    <span>
                      {fmtNumber(plant.mw, 1)} MW · {fuelLabel(plant.source)} ·{" "}
                      {fmtNumber(plant.distance_mi, 1)} mi
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="scan-actions">
            <button type="button" className="btn btn-ghost" onClick={copyReport} aria-live="polite">
              {copied ? "Copied" : "Copy scan report"}
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
