"use client";

import { useEffect, useMemo, useState } from "react";
import { EvidenceProvider } from "@/components/evidence/EvidenceProvider";
import {
  CENTER,
  fetchWeatherNow,
  loadGridData,
  rateLine,
  scanArea,
  scanReportMarkdown,
  type LineRatingNow,
  type ScanArea,
} from "@/lib/scan";
import type { LoadedGridData } from "@/lib/scan/data";
import { SOURCES, type SourceId } from "@/lib/scan/sources";
import { locationReportUrl } from "@/lib/scan/locationReport";
import { gridDataSourceLabel, layerSourceLabel } from "@/lib/scan/sourceLabel";
import type { LocationReport as EtlLocationReport } from "@/research/etl/pipeline";
import { LocationClaims } from "./LocationClaims";
import styles from "./location-report.module.css";

const SOURCE_IDS: SourceId[] = [
  "eia860",
  "eia860_events",
  "osm",
  "openmeteo_live",
  "era5_2025",
  "ieee738",
  "risk",
  "news",
];

function inlineMarkdown(value: string) {
  return value.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part,
  );
}

function ReportText({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }
    if (line === "---") {
      blocks.push(<hr key={index} />);
      index += 1;
      continue;
    }
    if (line.startsWith("- ")) {
      const list = [];
      while (index < lines.length && lines[index].trim().startsWith("- ")) {
        list.push(<li key={index}>{inlineMarkdown(lines[index].trim().slice(2))}</li>);
        index += 1;
      }
      blocks.push(<ul key={`list-${index}`}>{list}</ul>);
      continue;
    }
    if (line.startsWith("# ")) blocks.push(<h1 key={index}>{line.slice(2)}</h1>);
    else if (line.startsWith("## ")) blocks.push(<h2 key={index}>{line.slice(3)}</h2>);
    else blocks.push(<p key={index}>{inlineMarkdown(line)}</p>);
    index += 1;
  }
  return <div className={styles.reportText}>{blocks}</div>;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

/**
 * ETL location id for this exact area: `location-` + first 24 hex of the
 * sha256 of the canonical `{center, radius_miles}` query (research/etl/pipeline
 * locationId with no respondent / CAISO / OASIS options).
 */
async function locationIdFor(area: ScanArea): Promise<string> {
  const canonical = `{"center":[${JSON.stringify(area.lat)},${JSON.stringify(area.lon)}],"radius_miles":${JSON.stringify(area.radius_mi)}}`;
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `location-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24)}`;
}

type BoundReport =
  | { status: "loading" }
  | { status: "ready"; locationId: string; report: EtlLocationReport; revision: string }
  | { status: "missing"; reason: string };

function formatNum(value: number, digits = 0): string {
  return Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })
    : "n/a";
}

export default function LocationReport({ area, socketOrigin }: { area: ScanArea; socketOrigin: string }) {
  const [data, setData] = useState<LoadedGridData | null>(null);
  const [bound, setBound] = useState<BoundReport>({ status: "loading" });
  const [live, setLive] = useState<LineRatingNow | null>(null);
  const [inventoryRevision, setInventoryRevision] = useState<string | null>(null);
  const [inventoryLocationId, setInventoryLocationId] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [actionStatus, setActionStatus] = useState("");

  // The ETL location report for this area, if one has been collected. Its
  // revision selects the asset inventory bound to it for the scan layers.
  useEffect(() => {
    let current = true;
    setBound({ status: "loading" });
    (async () => {
      const locationId = await locationIdFor(area);
      const res = await fetch(`/api/location-report/${locationId}`, { cache: "no-store" });
      if (!res.ok) return { status: "missing", reason: `no location report for ${locationId} (${res.status})` } as const;
      const report = (await res.json()) as EtlLocationReport;
      const revision = res.headers.get("X-Report-Revision");
      if (!revision) return { status: "missing", reason: "location report has no revision header" } as const;
      return { status: "ready", locationId, report, revision } as const;
    })()
      .then((next) => { if (current) setBound(next); })
      .catch((error: unknown) => {
        if (current) setBound({ status: "missing", reason: error instanceof Error ? error.message : "location report unreadable" });
      });
    return () => { current = false; };
  }, [area.lat, area.lon, area.radius_mi]);

  const selectorLocation = bound.status === "ready" ? bound.locationId : undefined;
  const selectorRevision = bound.status === "ready" ? bound.revision : undefined;

  useEffect(() => {
    if (bound.status === "loading") return;
    let current = true;
    setStatus("loading");
    setData(null);
    setLive(null);
    loadGridData(selectorLocation ? { locationId: selectorLocation, reportRevision: selectorRevision } : undefined)
      .then(async (grid) => {
        if (!current) return;
        setData(grid);
        const weather = await fetchWeatherNow(area.lat, area.lon, grid);
        if (!current) return;
        setLive(rateLine(weather));
        setStatus("ready");
      })
      .catch(() => {
        if (current) setStatus("error");
      });
    return () => { current = false; };
  }, [area.lat, area.lon, area.radius_mi, inventoryRevision, bound.status, selectorLocation, selectorRevision]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    if (!socketOrigin) return;
    async function connect() {
      const locationId = await locationIdFor(area);
      if (stopped) return;
      const endpoint = new URL(`/ws/location/${locationId}`, socketOrigin);
      if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
      if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
      socket = new WebSocket(endpoint);
      socket.onmessage = ({ data }) => {
        try {
          const event = JSON.parse(String(data));
          if (event.event !== "INVENTORY_UPDATE" || event.location_id !== locationId ||
            typeof event.inventory_revision !== "string") return;
          delay = 1000;
          setInventoryLocationId(locationId);
          setInventoryRevision((current) => current === event.inventory_revision ? current : event.inventory_revision);
        } catch {
          // Malformed events carry no inventory state.
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      };
    }
    void connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [area.lat, area.lon, area.radius_mi, socketOrigin]);

  const result = useMemo(() => data ? scanArea(data, area) : null, [data, area]);
  const layerLabel = useMemo(() => {
    if (!data) return "";
    if (bound.status === "missing" && data.source === "bundled") {
      return layerSourceLabel({ source: "bundled", fallbackReasons: [bound.reason, ...data.fallback_reasons] });
    }
    return gridDataSourceLabel(data);
  }, [data, bound]);
  const markdown = useMemo(() => result && data ? scanReportMarkdown(result, live, data.layers) : "", [result, live, data]);
  const sourceIds = useMemo(() => {
    const ids: SourceId[] = [...SOURCE_IDS];
    return result?.cases.length ? ids : ids.filter((id) => id !== "news");
  }, [result]);
  const caseReferences = useMemo(() => {
    const references = new Map<string, string>();
    for (const entry of result?.cases ?? []) {
      for (const stat of entry.stats) {
        if (/^https?:\/\//i.test(stat.source)) references.set(stat.source, entry.title);
      }
    }
    return [...references.entries()];
  }, [result]);
  const osmUrl = `https://www.openstreetmap.org/?mlat=${area.lat.toFixed(5)}&mlon=${area.lon.toFixed(5)}#map=13/${area.lat.toFixed(5)}/${area.lon.toFixed(5)}`;
  const reportUrl = locationReportUrl(area);

  async function copyReport() {
    const ok = await copyText(markdown);
    setActionStatus(ok ? "Report copied" : "Could not copy report");
    window.setTimeout(() => setActionStatus(""), 2000);
  }

  async function copyLink() {
    const ok = await copyText(`${window.location.origin}${reportUrl}`);
    setActionStatus(ok ? "Report link copied" : "Could not copy report link");
    window.setTimeout(() => setActionStatus(""), 2000);
  }

  return (
    <main className={styles.page}>
      <article className={styles.document}>
        <header className={styles.header}>
          <p className={styles.kicker}>GridSentinel · Area report</p>
          <h1>{result?.area_label ?? "Area report"}</h1>
          <p className={styles.deck}>
            Shareable, printable screening summary for {area.lat.toFixed(4)}, {area.lon.toFixed(4)} · {formatNum(area.radius_mi, 1)} mi radius.
          </p>
          <div className={styles.actions}>
            <button type="button" onClick={() => window.print()} className={styles.buttonPrimary}>Print / Save PDF</button>
            <button type="button" onClick={copyReport} className={styles.button}>Copy report</button>
            <button type="button" onClick={copyLink} className={styles.button}>Copy report link</button>
            <a href={osmUrl} target="_blank" rel="noreferrer" className={styles.linkButton}>Open area map</a>
            <span className={styles.actionStatus} aria-live="polite">{actionStatus}</span>
          </div>
        </header>

        {status === "loading" ? <p className={styles.state}>Loading verified scan inputs and current weather…</p> : null}
        {status === "error" ? (
          <p className={styles.state} role="alert">The report could not load its source data. Reload to try again.</p>
        ) : null}

        {result ? (
          <>
            <section className={styles.summary} aria-label="Verified scan metrics">
              <div><span>Risk screen</span><strong>{formatNum(result.risk.score)}/100 · {result.risk.level}</strong></div>
              <div><span>Generation</span><strong>{formatNum(result.totals.plant_count)} plants · {formatNum(result.totals.nameplate_mw)} MW</strong></div>
              <div><span>Mapped grid</span><strong>{formatNum(result.totals.line_miles, 1)} mi · {formatNum(result.totals.substation_count)} substations</strong></div>
              <div><span>Weather screen</span><strong>{live ? `${formatNum(live.ratio, 2)}× static · ${live.weather.source}` : "Unavailable"}</strong></div>
            </section>

            <p className={styles.coverage} data-testid="grid-layer-source">Grid layers: {layerLabel}</p>

            {inventoryRevision && inventoryLocationId ? (
              <p className={styles.coverage}>
                Inventory snapshot <code>{inventoryRevision}</code> ·{" "}
                <a href={`/api/location-assets/${inventoryLocationId}?revision=${inventoryRevision}`}>
                  Open pinned inventory JSON
                </a>
              </p>
            ) : null}

            {!result.inside_coverage ? (
              <p className={styles.coverage}>Outside the 100-mile Westminster study footprint; local plant and line data may be incomplete.</p>
            ) : null}

            <section className={styles.section}>
              <h2>Area scan</h2>
              <ReportText markdown={markdown} />
            </section>
          </>
        ) : null}

        {/* The location report's claims stand on its own evidence bundle, so they
            render whether or not the grid layers loaded. */}
        {bound.status === "ready" ? (
          <section className={styles.section} aria-label="Location evidence claims">
            {/* Cite reads claim detail from the report's own evidence bundle. */}
            <EvidenceProvider bundle={bound.report.evidence}>
              <LocationClaims report={bound.report} socketOrigin={socketOrigin} />
            </EvidenceProvider>
          </section>
        ) : null}

        {result ? (
          <>
            <section className={styles.section}>
              <h2>Sources and methods</h2>
              <p className={styles.sourceIntro}>Links and limits for the inputs used in this report.</p>
              <ul className={styles.sources}>
                {sourceIds.map((sourceId) => {
                  const source = SOURCES[sourceId];
                  return (
                    <li key={sourceId}>
                      <div className={styles.sourceHeading}>
                        <strong>{source.name}</strong>
                        {source.url ? <a href={source.url} target="_blank" rel="noreferrer">Source</a> : null}
                      </div>
                      <p>{source.publisher} · Data as of {source.asOf}</p>
                      <p>{source.what}</p>
                      {source.method ? <p>{source.method}</p> : null}
                      {source.note ? <p className={styles.sourceNote}>{source.note}</p> : null}
                    </li>
                  );
                })}
              </ul>
              {caseReferences.length ? (
                <div className={styles.caseSources}>
                  <h3>Local case references</h3>
                  <ul>
                    {caseReferences.map(([url, title]) => (
                      <li key={url}><span>{title}</span><a href={url} target="_blank" rel="noreferrer">Open source</a></li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
            <footer className={styles.footer}>
              Report URL: <a href={reportUrl}>{reportUrl}</a> · Current scan data loads from public GridSentinel assets.
            </footer>
          </>
        ) : null}
      </article>
    </main>
  );
}
