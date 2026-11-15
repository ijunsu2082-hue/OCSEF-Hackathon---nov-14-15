"use client";

// scan.css: light tokens, the body:has(.gs-scan-app) revert-layer fix for app/globals.css.
import "../../scan/scan.css";
import "./location-report.css";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchWeatherNow, loadGridData, rateLine, scanArea } from "@/lib/scan";
import type { FuelKey, GridData, LineRatingNow, RiskLevel, ScanArea, WeatherNow } from "@/lib/scan";
import { aarRatio, conductorRange, ratioRange, windSentence } from "@/lib/scan/rating";
import { riskRange } from "@/lib/scan/risk";
import {
  CATEGORY_COLORS, CATEGORY_KEYS, CATEGORY_LABELS, FUEL_CATEGORY, FUEL_KEYS, FUEL_LABELS, RISK_COLORS, UI,
  type EnergyCategory,
} from "@/lib/scan/colors";
import { SOURCES, type SourceId } from "@/lib/scan/sources";
import { reportUrl } from "@/lib/scan/reportLink";
import { DASH, fmtCoord, fmtNum, fmtPct, fmtPowerText, fmtRatio, isNum } from "@/components/scan/panel/format";

const SOURCE_IDS: SourceId[] = [
  "eia860", "eia860_events", "osm", "state_substations", "openmeteo_live", "era5_2025", "ieee738", "risk", "news",
];
const LEVEL_WORD: Record<RiskLevel, string> = { LOW: "Low", WATCH: "Watch", HIGH: "High", CRITICAL: "Critical" };
const TOP_PLANTS = 10;

const pctOf = (r: number) => Math.round(Math.abs(r - 1) * 100);

function weatherLine(w: WeatherNow): string {
  const temp = isNum(w.temp_c) ? `${w.temp_c.toFixed(1)} °C` : DASH;
  const wind = `wind ${isNum(w.wind_ms) ? w.wind_ms.toFixed(1) : DASH} m/s`;
  const sun = `sun ${isNum(w.sun_wm2) ? fmtNum(w.sun_wm2, 0) : DASH} W/m²`;
  if (w.source === "fallback-2025") return `2025 weather (live data unavailable): ${temp}, ${wind}, ${sun}`;
  return `Live weather ${temp}, ${wind}, ${sun}`;
}

function capacitySentence(aar: number | null): string {
  if (!isNum(aar)) return "The rating could not be computed for this spot.";
  if (pctOf(aar) === 0) return "Right now lines here can safely carry about the same as their fixed worst-case rating.";
  if (aar < 1) {
    return `In this heat, lines here can safely carry about ${pctOf(aar)}% less than their fixed worst-case rating, so loading them to it would overheat them.`;
  }
  return `Lines here could carry up to about ${pctOf(aar)}% more than their fixed worst-case rating right now, from the air temperature alone.`;
}

function fmtGenerated(d: Date): string {
  return d.toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="gs-scan-app lr-page">
      <div className="lr-doc">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="lr-section">
      <h2 className="lr-h2">{title}</h2>
      {children}
    </section>
  );
}

export function InvalidReport({ id }: { id: string }) {
  return (
    <Shell>
      <p className="lr-kicker">GridSentinel location report</p>
      <h1 className="lr-h1">This report link is not valid</h1>
      <p className="lr-deck">
        The link <span className="lr-code">{id}</span> does not describe a scan area. Report links look like{" "}
        <span className="lr-code">area_33.7538_-118.0111_5</span> (latitude, longitude, radius in miles).
      </p>
      <p className="lr-actions">
        <a className="lr-button" href="/scan">Open GridSentinel</a>
      </p>
    </Shell>
  );
}

export default function LocationReport({ area }: { area: ScanArea }) {
  const [data, setData] = useState<GridData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState<LineRatingNow | null>(null);
  const [liveLoading, setLiveLoading] = useState(true);
  const [generated, setGenerated] = useState<Date | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setGenerated(new Date());
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLiveLoading(true);
    loadGridData()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        return fetchWeatherNow(area.lat, area.lon, d).then((w) => {
          if (!cancelled) setLive(rateLine(w));
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLiveLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [area.lat, area.lon]);

  const result = useMemo(() => (data ? scanArea(data, area) : null), [data, area]);

  if (loadError) {
    return (
      <Shell>
        <p className="lr-kicker">GridSentinel location report</p>
        <h1 className="lr-h1">Map data failed to load</h1>
        <p className="lr-deck">{loadError}</p>
        <p className="lr-actions">
          <button type="button" className="lr-button" onClick={() => window.location.reload()}>Retry</button>
          <a className="lr-button" href="/scan">Open GridSentinel</a>
        </p>
      </Shell>
    );
  }

  if (!result) {
    return (
      <Shell>
        <p className="lr-kicker">GridSentinel location report</p>
        <p className="lr-deck" aria-busy="true">Loading…</p>
      </Shell>
    );
  }

  const t = result.totals;
  const site = result.rating_site;
  const range = riskRange(result.risk);
  const aar = live ? aarRatio(live) : null;
  const dlr = live && isNum(live.ratio) && live.ratio > 0 ? live.ratio : null;
  const wires = live ? conductorRange(live.weather) : null;

  const catMw: Record<EnergyCategory, number> = { renewable: 0, storage: 0, fossil: 0, other: 0 };
  for (const k of FUEL_KEYS) catMw[FUEL_CATEGORY[k]] += t.mw_by_source[k] ?? 0;
  const catTotal = CATEGORY_KEYS.reduce((s, k) => s + catMw[k], 0);
  const fuels = FUEL_KEYS.filter((k) => (t.mw_by_source[k] ?? 0) > 0).sort(
    (a, b) => (t.mw_by_source[b] ?? 0) - (t.mw_by_source[a] ?? 0),
  );
  const link = reportUrl(area.lat, area.lon, area.radius_mi, origin || undefined);

  return (
    <Shell>
      <header className="lr-header">
        <p className="lr-kicker">GridSentinel location report</p>
        <h1 className="lr-h1">{result.area_label}</h1>
        <p className="lr-deck lr-num">
          {fmtCoord(area.lat, area.lon)} · {area.radius_mi} mi radius
        </p>
        <p className="lr-meta">Generated {generated ? fmtGenerated(generated) : DASH}</p>
        {!result.inside_coverage && (
          <p className="lr-note">This point is outside GridSentinel&apos;s 100-mile coverage area, so counts may be incomplete.</p>
        )}
        <div className="lr-actions lr-noprint">
          <button type="button" className="lr-button lr-button-primary" onClick={() => window.print()}>
            Print / Save PDF
          </button>
          <a className="lr-button" href={`/scan?lat=${area.lat}&lon=${area.lon}&r=${area.radius_mi}`}>Open in GridSentinel</a>
        </div>
      </header>

      <Section title="Line capacity right now">
        {liveLoading || !live ? (
          <p className="lr-text-dim">{liveLoading ? "Getting live weather…" : "Live rating unavailable."}</p>
        ) : (
          <>
            <p className="lr-big lr-num" style={isNum(aar) && aar < 1 ? { color: UI.danger } : undefined}>
              {fmtRatio(aar)}
            </p>
            <p className="lr-text">{capacitySentence(aar)}</p>
            <p className="lr-text-dim lr-num">{weatherLine(live.weather)}</p>
            <dl className="lr-rows">
              {isNum(aar) && isNum(dlr) && (
                <div className="lr-row">
                  <dt>With today&apos;s wind too (dynamic line rating, wind halved for safety)</dt>
                  <dd className="lr-num" style={dlr < 1 ? { color: UI.danger } : undefined}>{fmtRatio(dlr)}</dd>
                </div>
              )}
              {isNum(aar) && wires && (
                <div className="lr-row">
                  <dt>Range for 3 common wire types (temperature only)</dt>
                  <dd className="lr-num">{ratioRange(wires.aar_min, wires.aar_max, "×")}</dd>
                </div>
              )}
            </dl>
            {isNum(aar) && isNum(dlr) && <p className="lr-text-dim">{windSentence(aar, dlr)}</p>}
          </>
        )}
        <p className="lr-caption lr-num">
          2025 at {site.name} ({fmtNum(site.distance_mi, 1)} mi away): with wind halved, the rating beat the fixed rating in{" "}
          {fmtPct(site.pct_hours_conservative_dlr_above_static, 0)} of hours. Modeled with IEEE 738. Screening estimate for a
          typical wire; a utility must confirm real limits.
        </p>
      </Section>

      <Section title="What is inside the circle">
        <div className="lr-stats">
          <Stat label="Power plants" value={fmtNum(t.plant_count, 0)} sub={`${fmtPowerText(t.nameplate_mw)} nameplate`} />
          <Stat label="Power lines" value={fmtNum(result.lines.length, 0)} sub={`${fmtNum(t.line_miles, 1)} mi mapped`} />
          <Stat
            label="Substations"
            value={fmtNum(t.substation_count, 0)}
            sub={`${fmtNum(t.hv_substation_count, 0)} at 200 kV or more`}
          />
          <Stat label="Local stories" value={fmtNum(result.cases.length, 0)} sub="inside the circle" />
        </div>
      </Section>

      <Section title="Energy mix">
        {catTotal > 0 ? (
          <>
            <div className="lr-bar" role="img" aria-label="Energy mix by category">
              {CATEGORY_KEYS.filter((k) => catMw[k] > 0).map((k) => (
                <span key={k} style={{ width: `${(catMw[k] / catTotal) * 100}%`, background: CATEGORY_COLORS[k] }} />
              ))}
            </div>
            <dl className="lr-rows">
              {CATEGORY_KEYS.filter((k) => catMw[k] > 0).map((k) => (
                <div className="lr-row" key={k}>
                  <dt>
                    <span className="lr-swatch" style={{ background: CATEGORY_COLORS[k] }} />
                    {CATEGORY_LABELS[k]}
                  </dt>
                  <dd className="lr-num">
                    {fmtPowerText(catMw[k])} <span className="lr-text-dim">({fmtPct((catMw[k] / catTotal) * 100, 0)})</span>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="lr-caption">
              By fuel: {fuels.map((k: FuelKey) => `${FUEL_LABELS[k]} ${fmtPowerText(t.mw_by_source[k])}`).join(", ")}.
            </p>
          </>
        ) : (
          <p className="lr-text-dim">No power plants within {area.radius_mi} mi.</p>
        )}
      </Section>

      <Section title="Risk">
        <p className="lr-text">
          Risk <span className="lr-strong lr-num">{fmtNum(result.risk.score, 0)}</span> ·{" "}
          <span className="lr-strong" style={{ color: RISK_COLORS[result.risk.level] }}>
            {LEVEL_WORD[result.risk.level]}
          </span>{" "}
          <span className="lr-text-dim lr-num">
            (range {fmtNum(range.min, 0)}-{fmtNum(range.max, 0)} if the weights change)
          </span>
        </p>
        <table className="lr-table">
          <thead>
            <tr>
              <th>Factor</th>
              <th className="lr-r">Score</th>
              <th className="lr-r">Weight</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {result.risk.factors.map((f) => (
              <tr key={f.key}>
                <td>{f.label}</td>
                <td className="lr-r lr-num lr-sky">{isNum(f.score) ? fmtNum(f.score, 0) : DASH}</td>
                <td className="lr-r lr-num">{fmtPct(f.weight * 100, 0)}</td>
                <td className="lr-text-dim">{f.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="lr-caption">GridSentinel&apos;s own composite score (0 to 100), not an official rating.</p>
      </Section>

      <Section title="Top plants">
        {result.plants.length === 0 ? (
          <p className="lr-text-dim">No power plants within {area.radius_mi} mi.</p>
        ) : (
          <table className="lr-table">
            <thead>
              <tr>
                <th>Plant</th>
                <th>Main fuel</th>
                <th className="lr-r">Nameplate</th>
                <th className="lr-r">Online since</th>
              </tr>
            </thead>
            <tbody>
              {result.plants.slice(0, TOP_PLANTS).map((p) => (
                <tr key={p.plant_code}>
                  <td>
                    <span className="lr-strong">{p.plant_name}</span>
                    {p.city && <span className="lr-text-dim"> · {p.city}</span>}
                  </td>
                  <td>{FUEL_LABELS[p.primary_source] ?? p.primary_source}</td>
                  <td className="lr-r lr-num lr-sky">{fmtPowerText(p.nameplate_mw)}</td>
                  <td className="lr-r lr-num">{p.oldest_year ?? DASH}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {result.plants.length > TOP_PLANTS && (
          <p className="lr-caption">
            Showing the {TOP_PLANTS} largest of {fmtNum(result.plants.length, 0)} plants.
          </p>
        )}
      </Section>

      <Section title="Local stories inside the circle">
        {result.cases.length === 0 ? (
          <p className="lr-text-dim">No local stories inside this circle.</p>
        ) : (
          <ul className="lr-list">
            {result.cases.map((c) => (
              <li key={c.id}>
                <p className="lr-strong">{c.title}</p>
                <p className="lr-text-dim">
                  {c.category} · {c.location.name}
                </p>
                <p className="lr-text">{c.one_liner}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Data sources">
        <ul className="lr-list lr-sources">
          {SOURCE_IDS.map((sid) => {
            const s = SOURCES[sid] as { name: string; publisher: string; url?: string; asOf: string; what: string };
            return (
              <li key={sid}>
                <p>
                  {s.url ? (
                    <a className="lr-link" href={s.url} target="_blank" rel="noreferrer">{s.name}</a>
                  ) : (
                    <span className="lr-strong">{s.name}</span>
                  )}
                  <span className="lr-text-dim"> · {s.publisher} · {s.asOf}</span>
                </p>
                <p className="lr-text-dim">{s.what}</p>
              </li>
            );
          })}
        </ul>
      </Section>

      <footer className="lr-footer">
        <p className="lr-text-dim">
          Report link: <a className="lr-link lr-break" href={link}>{link}</a>
        </p>
        <p className="lr-text-dim">
          Generated by GridSentinel {generated ? `on ${fmtGenerated(generated)}` : ""} from public data. Numbers are
          screening estimates.
        </p>
      </footer>
    </Shell>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="lr-stat">
      <p className="lr-stat-label">{label}</p>
      <p className="lr-stat-value lr-num">{value}</p>
      <p className="lr-text-dim lr-num">{sub}</p>
    </div>
  );
}
