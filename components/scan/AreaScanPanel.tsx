"use client";

import { useEffect, useMemo, useState } from "react";
import type { ScanResult } from "@/lib/scan/areaScan";
import { haversineMi } from "@/lib/scan/areaScan";
import type { NicheCase } from "@/lib/niche";
import { sourceLabel } from "@/lib/gridLayers";
import { fmtNumber } from "@/lib/format";
import { Sparkline } from "@/components/primitives/Sparkline";
import {
  conductorForVoltage,
  dayLabel,
  heatwaveWireSummary,
  hourLabel,
  rateWeatherSample,
  type WireHour,
} from "@/lib/scan/wire";
import {
  corridorBearingDeg,
  pointOnCorridor,
  useWeatherSample,
  weatherSampleAgeLabel,
  weatherSourceLabel,
} from "@/lib/scan/useWeatherSample";
import OwnerPlanView, { useOwnerPlan } from "@/components/scan/OwnerPlanView";
import LifecycleGatesView from "@/components/scan/LifecycleGatesView";

interface Props {
  result: ScanResult | null;
  radius: number;
  loading: boolean;
  error: string | null;
  heatwave: boolean;
  nicheCases: NicheCase[];
  onRadius: (radius: number) => void;
  onClose: () => void;
  onTopPlant?: (lat: number, lon: number) => void;
  corridor?: { coordinates: [number, number][]; voltage: number | null } | null;
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

// One label table for the whole map: gridLayers owns the fuel names.
const fuelLabel = (key: string) => {
  const label = sourceLabel(key);
  return label.charAt(0).toUpperCase() + label.slice(1);
};

const isUrl = (value: string) => /^https?:\/\//i.test(value.trim());
const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, "");

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
  onTopPlant,
  corridor = null,
}: Props) {
  const [view, setView] = useState<"scan" | "plan" | "gates">("scan");
  const [copyStatus, setCopyStatus] = useState<"idle" | "success" | "failure">("idle");
  const corridorPoint = useMemo(
    () => corridor ? pointOnCorridor(corridor.coordinates) : null,
    [corridor],
  );
  const weatherTarget = corridor
    ? corridorPoint
    : result
      ? { lat: result.point.lat, lon: result.point.lon }
      : null;
  const { weather, pending: weatherPending, error: weatherError } = useWeatherSample(weatherTarget);
  const ownerPlan = useOwnerPlan(result, heatwave);

  useEffect(() => {
    setView("scan");
  }, [result?.point.lat, result?.point.lon]);

  async function copyReport() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.report);
      setCopyStatus("success");
      window.setTimeout(() => setCopyStatus("idle"), 1800);
    } catch {
      setCopyStatus("failure");
      window.setTimeout(() => setCopyStatus("idle"), 2400);
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

  // News and document links for the cases above, one row per case with one
  // link per distinct source host. These are reporting, not generation: they
  // never enter the energy mix or a capacity figure.
  const news = useMemo(() => {
    const out: { id: string; title: string; sources: { host: string; url: string }[] }[] = [];
    for (const { entry } of casesHere) {
      const hosts = new Set<string>();
      const sources: { host: string; url: string }[] = [];
      for (const stat of entry.stats) {
        const url = stat.source.trim();
        if (!isUrl(url)) continue;
        const host = hostOf(url);
        if (hosts.has(host)) continue;
        hosts.add(host);
        sources.push({ host, url });
      }
      if (sources.length > 0) out.push({ id: entry.id, title: entry.title, sources });
    }
    return out;
  }, [casesHere]);

  const wire = result?.wire ?? null;
  const ratingVoltage = corridor?.voltage ?? wire?.voltage_kv ?? null;
  const archiveWire = wire && result?.inside_coverage &&
    (!corridor || corridorPoint !== null) &&
    (!corridor?.voltage || corridor.voltage === wire.voltage_kv)
    ? wire
    : null;
  const archiveYear = wire?.now?.time.slice(0, 4) ?? wire?.hottest?.time.slice(0, 4) ?? "2025";
  const weatherWire: WireHour | null =
    ratingVoltage !== null && weather?.current
      ? rateWeatherSample(ratingVoltage, weather.current)
      : null;
  const displayWeather = weatherWire ?? archiveWire?.now ?? null;
  const weatherSource = weather?.source ?? "none";
  const weatherProvenance = weather?.current
    ? weatherSourceLabel(weatherSource)
    : displayWeather
      ? `Bundled ${displayWeather.time.slice(0, 4)} archive`
      : "No compatible weather sample";
  const heatwaveRating = ratingVoltage === null ? null : heatwaveWireSummary(ratingVoltage);
  const activeRatio = ratingVoltage !== null
    ? heatwave
      ? heatwaveRating?.ratio ?? null
      : displayWeather?.ratio ?? null
    : null;
  const headroomPct =
    activeRatio === null ? null : Math.round(Math.abs(activeRatio - 1) * 100);
  const dayRatios = archiveWire ? archiveWire.today.map((hour) => hour.ratio) : [];
  const selectedBearing = corridor ? corridorBearingDeg(corridor.coordinates) : null;

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

      <div className="scan-tabs" role="tablist" aria-label="Area scan views">
        <button type="button" role="tab" aria-selected={view === "scan"} data-active={view === "scan"} onClick={() => setView("scan")}>
          Area scan
        </button>
        <button type="button" role="tab" aria-selected={view === "plan"} data-active={view === "plan"} onClick={() => setView("plan")}>
          Owner plan
        </button>
        <button type="button" role="tab" aria-selected={view === "gates"} data-active={view === "gates"} onClick={() => setView("gates")}>
          Gates &amp; sources
        </button>
      </div>

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

      {result && view === "plan" ? (
        <div className="scan-body" role="tabpanel" aria-label="Owner plan">
          {ownerPlan.state ? <OwnerPlanView owner={ownerPlan.state} /> : null}
          {ownerPlan.error ? <p className="scan-error">Owner plan unavailable: {ownerPlan.error}</p> : null}
          {!ownerPlan.state && !ownerPlan.error ? <p className="scan-note">Building the owner plan…</p> : null}
          <section className="scan-section">
            <h3>Compare opportunities</h3>
            <p className="scan-caption">For {result.label} · {radius} mi circle</p>
            <div className="scan-grid">
              <Group title="Supply">
                <Row label="Nameplate" value={`${fmtNumber(result.nameplate_mw, 0)} MW`} />
                <Row label="Renewables" value={`${fmtNumber(result.renewable_pct, 0)}%`} />
                <Row label="Battery storage" value={`${fmtNumber(result.storage_mw, 0)} MW`} />
              </Group>
              <Group title="Grid">
                <Row label="Mapped lines" value={`${fmtNumber(result.line_miles, 0)} mi`} />
                <Row label="200 kV+ lines" value={`${fmtNumber(result.hv_line_miles, 0)} mi`} />
                <Row label="200 kV+ substations" value={fmtNumber(result.hv_substation_count, 0)} />
              </Group>
              {result.evening_cover_pct !== null ? (
                <Group title="Evening cover" wide>
                  <Row label="Storage relative to solar" value={`${fmtNumber(result.evening_cover_pct, 0)}%`} />
                  <p className="scan-caption">Area-wide ratio; not a dispatch or project design.</p>
                </Group>
              ) : null}
            </div>
            <h4 className="scan-subhead">Area-specific opportunities to assess</h4>
            {result.ideas.length ? (
              <ul className="scan-ideas">{result.ideas.map((idea) => <li key={idea}>{idea}</li>)}</ul>
            ) : <p className="scan-caption">No candidate opportunity surfaced from the available area data.</p>}
            <p className="scan-caption scan-source">These are heuristic screening signals from the metrics above, not ranked by cost or validated capacity. Confirm with engineering and the system operator.</p>
          </section>
        </div>
      ) : null}

      {result && view === "gates" ? (
        <div className="scan-body" role="tabpanel" aria-label="Gates and sources">
          {ownerPlan.state ? <LifecycleGatesView plan={ownerPlan.state.plan} asOf={ownerPlan.state.asOf} /> : null}
          {ownerPlan.error ? <p className="scan-error">Owner plan unavailable: {ownerPlan.error}</p> : null}
          {!ownerPlan.state && !ownerPlan.error ? <p className="scan-note">Building the owner plan…</p> : null}
        </div>
      ) : null}

      {result && view === "scan" ? (
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
                    value={`${fmtNumber(fuel.mw, fuel.mw >= 100 ? 0 : 1)} MW · ${fmtNumber(fuel.pct, 0)}%`}
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
                          result.planned_retirement_plants === 1 ? " carries" : "s carry"
                        } a retirement date in the EIA-860 2025 extract.`
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

            </div>
            <p className="scan-caption scan-source">
              Source: EIA-860 2025 · OpenStreetMap (ODbL) · {archiveYear} weather archive. Line ratings are
              MODELED (IEEE 738 screening), not operating ratings.
            </p>
          </section>

          {ratingVoltage !== null && (archiveWire || weatherWire || weatherPending || weatherError) ? (
            <section className="scan-section">
              <h3>{corridor ? "Selected corridor rating" : "The wire that breathes"}</h3>
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
                        ? "No compatible weather sample for this corridor."
                        : heatwave
                          ? `At 105 °F a 3 m/s breeze returns ${fmtNumber(activeRatio, 2)}× the fixed rating.`
                          : activeRatio >= 1
                            ? `Lines here can carry ${headroomPct}% more than their still-air rating at this hour.`
                            : `Calm air caps the line ${headroomPct}% below its still-air rating at this hour.`}
                    </span>
                    <small>
                      {conductorForVoltage(ratingVoltage)} · {ratingVoltage} kV · {wire?.site ?? "selected corridor"}
                    </small>
                    <small>
                      {heatwave
                        ? `Simulated heatwave · ${weatherProvenance}`
                        : weatherPending
                          ? "Checking live weather…"
                          : weather?.current
                          ? weatherProvenance
                          : weatherProvenance}
                      {displayWeather
                        ? ` · ${weatherSampleAgeLabel(displayWeather.time)}${weather?.current ? ` · ${hourLabel(displayWeather.time)} UTC` : ` · ${hourLabel(displayWeather.time)} Pacific`}`
                        : ""}
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
                      <span>{dayLabel(archiveWire?.today[0]?.time ?? null)}</span>
                      <span>23:00</span>
                    </div>
                  </>
                ) : null}

                <Row
                  label="Still-air rating"
                  value={displayWeather
                    ? `${fmtNumber(displayWeather.still_a, 0)} A`
                    : archiveWire
                      ? `${fmtNumber(archiveWire.still_air_a, 0)} A`
                      : "n/a"}
                />
                <Row
                  label="Weather-based rating"
                  value={displayWeather
                    ? `${fmtNumber(displayWeather.breeze_a, 0)} A`
                    : archiveWire
                      ? `${fmtNumber(archiveWire.breeze_a, 0)} A`
                      : "n/a"}
                />
                <Row
                  label="Ambient / wind speed"
                  value={displayWeather
                    ? `${fmtNumber(displayWeather.temp_c, 1)} °C · ${fmtNumber(displayWeather.wind_mps, 1)} m/s`
                    : "n/a"}
                />
                {weather?.current ? (
                  <Row
                    label="Wind direction (from)"
                    value={`${Math.round(weather.current.wind_direction_deg)}°`}
                  />
                ) : null}
                {selectedBearing !== null ? (
                  <Row
                    label="Corridor bearing"
                    value={`${Math.round(selectedBearing)}° clockwise from north`}
                  />
                ) : null}
                {archiveWire ? (
                  <>
                    <Row label={`${archiveYear} median gain`} value={`${archiveWire.median_ratio.toFixed(2)}×`} />
                    <Row
                      label="Hours above still air"
                      value={`${fmtNumber(archiveWire.pct_hours_above_still_air, 0)}%`}
                    />
                  </>
                ) : null}
                {archiveWire?.hottest ? (
                  <Row
                    label="Hottest hour"
                    value={`${archiveWire.hottest.ratio.toFixed(2)}× · ${fmtNumber(archiveWire.hottest.temp_c, 1)} °C`}
                  />
                ) : null}
                <p className="scan-caption">
                  {weather?.current
                    ? `${hourLabel(weather.current.time)} weather sample. `
                    : archiveWire?.now
                      ? `${hourLabel(archiveWire.now.time)} in the bundled ${archiveYear} archive. `
                      : ""}
                  Still air is 0.61 m/s; temperature and sun are held at the hour&apos;s own
                  values, so the difference is wind speed alone. Direction is a meteorological
                  bearing from north; this screening model does not adjust for line heading.
                </p>
                {weatherError ? (
                  <p className="scan-caption">Live weather unavailable; showing the bundled archive.</p>
                ) : null}
                <p className="scan-caption">
                  105 °F: fixed rating {fmtNumber(heatwaveRating?.derate_pct ?? 0, 1)}% lower, a 3 m/s
                  breeze returns {(heatwaveRating?.ratio ?? 1).toFixed(2)}×.
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
                  <li key={item.id}>
                    <b>{item.title}</b>
                    <span className="scan-news-links">
                      {item.sources.map((source) => (
                        <a
                          key={source.host}
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {source.host}
                        </a>
                      ))}
                    </span>
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
                    {onTopPlant ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => onTopPlant(plant.lat, plant.lon)}
                      >
                        Locate plant
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="scan-actions">
            <button type="button" className="btn btn-ghost" onClick={copyReport} aria-live="polite">
              {copyStatus === "success"
                ? "Copied"
                : copyStatus === "failure"
                  ? "Copy failed"
                  : "Copy scan report"}
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
