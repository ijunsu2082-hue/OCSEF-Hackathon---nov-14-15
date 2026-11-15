"use client";

import "./scan.css";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  CENTER,
  fetchWeatherNow,
  heatwaveWeather,
  loadDailyRatings,
  loadGridData,
  rateLine,
  scanArea,
} from "@/lib/scan";
import type { DailyRating, GridData, LineRatingNow, NicheCase, ScanArea } from "@/lib/scan";
import type { NewsPin, PanelTab, ReportTarget } from "@/lib/scan/target";
import { parseReportId } from "@/lib/scan/reportLink";
import { usePoll } from "@/lib/live/usePoll";
import type { HazardsLive } from "@/lib/live/hazards";
import { liveHazardsUrl } from "@/components/scan/panel/LiveHazards";
import ScanMap, { type MapFocus } from "@/components/scan/map";
import { TopBar } from "@/components/scan/shell/TopBar";
import ScanPanel from "@/components/scan/panel/ScanPanel";
import { cx } from "@/components/primitives";

const DEFAULT_AREA: ScanArea = { lat: CENTER.lat, lon: CENTER.lon, radius_mi: 5 };
const LIVE_DEBOUNCE_MS = 300;
/** How long a radius drag must settle before the region is re-scanned. */
const RADIUS_SETTLE_MS = 160;
const EMPTY_CASES: NicheCase[] = [];

/**
 * Circle from a shared link (?lat=&lon=&r=), checked with the same rules as a report id.
 * r is optional (default radius). Null when lat/lon are missing or invalid.
 */
function areaFromQuery(search: string): ScanArea | null {
  const q = new URLSearchParams(search);
  const lat = q.get("lat");
  const lon = q.get("lon");
  if (!lat || !lon) return null;
  const r = q.get("r") || String(DEFAULT_AREA.radius_mi);
  return parseReportId(`area_${lat.trim()}_${lon.trim()}_${r.trim()}`);
}

export default function Page() {
  const [data, setData] = useState<GridData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [area, setArea] = useState<ScanArea>(DEFAULT_AREA);
  // Committed radius: the slider moves `area` on every step, this only on settle.
  const [scanRadius, setScanRadius] = useState(DEFAULT_AREA.radius_mi);
  const radiusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (radiusTimer.current) clearTimeout(radiusTimer.current);
    },
    [],
  );
  const [heatwave, setHeatwave] = useState(false);
  const [live, setLive] = useState<LineRatingNow | null>(null);
  const [liveLoading, setLiveLoading] = useState(true);
  const [daily, setDaily] = useState<DailyRating[] | null>(null);
  const [tab, setTab] = useState<PanelTab>("area");
  const [reportTarget, setReportTarget] = useState<ReportTarget>({ kind: "area" });
  const [selected, setSelected] = useState<ReportTarget | null>(null);
  const [newsPin, setNewsPin] = useState<NewsPin | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false); // only matters below lg
  const nonce = useRef(0);

  // ---- shared link: open the circle from ?lat=&lon=&r= once, on first load ----
  const sharedArea = useRef<ScanArea | null>(null);
  useEffect(() => {
    const a = areaFromQuery(window.location.search);
    if (!a) return;
    sharedArea.current = a;
    setArea(a);
    setScanRadius(a.radius_mi);
  }, []);

  // ---- data -----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    loadGridData()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A radius change re-scans every layer. Three things keep that off the
  // interaction path: the circle tracks the drag immediately, the committed
  // radius only moves once the drag settles, and the scan runs at low priority
  // so the panel keeps its last result until the new one is ready.
  const deferredArea = useDeferredValue(area);
  const scanTarget = useMemo(
    () => ({ ...deferredArea, radius_mi: scanRadius }),
    [deferredArea, scanRadius],
  );
  const result = useMemo(
    () => (data ? scanArea(data, scanTarget, { heatwave }) : null),
    [data, scanTarget, heatwave],
  );

  // ---- live hazards: one poll per scan circle, shared by the panel and the map ----
  // Debounced so the brief in-between circles on first load (default, then a shared link)
  // never start a request of their own.
  const hazardsTarget = liveHazardsUrl(scanTarget.lat, scanTarget.lon, scanTarget.radius_mi);
  const [hazardsUrl, setHazardsUrl] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setHazardsUrl(hazardsTarget), LIVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [hazardsTarget]);
  const hazardsPoll = usePoll<HazardsLive>(hazardsUrl, 300);
  // usePoll keeps the last circle's feed until the new one answers; only show a feed (or
  // error) once a response for the current circle has arrived, so the panel and map never
  // label the previous circle's fires with the new circle.
  const [hazardsAnsweredUrl, setHazardsAnsweredUrl] = useState<string | null>(null);
  useEffect(() => {
    if (hazardsPoll.feed || hazardsPoll.error) setHazardsAnsweredUrl(hazardsUrl);
    // Only a new response (feed or error) marks the current URL as answered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hazardsPoll.feed, hazardsPoll.error]);
  const hazards =
    hazardsAnsweredUrl !== null && hazardsAnsweredUrl === hazardsTarget
      ? hazardsPoll
      : { ...hazardsPoll, feed: null, error: null, ageSec: null, fetchedAgoSec: null };

  // ---- live line rating (debounced, stale-safe) ------------------------------
  const liveReq = useRef(0);
  useEffect(() => {
    if (!data) return;
    const req = ++liveReq.current;
    if (heatwave) {
      setLive(rateLine(heatwaveWeather()));
      setLiveLoading(false);
      return;
    }
    setLive(null);
    setLiveLoading(true);
    const t = setTimeout(() => {
      fetchWeatherNow(area.lat, area.lon, data)
        .then((w) => {
          if (req === liveReq.current) setLive(rateLine(w));
        })
        .catch(() => {
          if (req === liveReq.current) setLive(null);
        })
        .finally(() => {
          if (req === liveReq.current) setLiveLoading(false);
        });
    }, LIVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [data, area.lat, area.lon, heatwave]);

  // ---- daily ratings for the nearest rating site ------------------------------
  const siteKey = result?.rating_site.key ?? null;
  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    setDaily(null);
    loadDailyRatings(siteKey)
      .then((rows) => {
        if (!cancelled) setDaily(rows);
      })
      .catch(() => {
        if (!cancelled) setDaily(null);
      });
    return () => {
      cancelled = true;
    };
  }, [siteKey]);

  // ---- handlers ---------------------------------------------------------------
  const flyTo = useCallback((lat: number, lon: number, zoom?: number) => {
    nonce.current += 1;
    setFocus({ lat, lon, zoom, nonce: nonce.current });
  }, []);

  // Fly to the shared circle once the map is on screen. The map recenters on its
  // first frames after mounting, so a fly sent before then would be undone.
  useEffect(() => {
    const a = sharedArea.current;
    if (!data || !a) return;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    const wait = () => {
      if (document.querySelector(".leaflet-container") || ++tries > 600) {
        timer = setTimeout(() => {
          sharedArea.current = null;
          flyTo(a.lat, a.lon, 10);
        }, 300);
        return;
      }
      raf = requestAnimationFrame(wait);
    };
    raf = requestAnimationFrame(wait);
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [data, flyTo]);

  const onScan = useCallback((lat: number, lon: number) => {
    setArea((a) => ({ lat, lon, radius_mi: a.radius_mi }));
  }, []);

  const onJump = useCallback(
    (spot: { lat: number; lon: number }) => {
      setArea((a) => ({ lat: spot.lat, lon: spot.lon, radius_mi: a.radius_mi }));
      flyTo(spot.lat, spot.lon, 10);
    },
    [flyTo],
  );

  const onRadius = useCallback((radius_mi: number) => {
    setArea((a) => ({ ...a, radius_mi }));
    if (radiusTimer.current) clearTimeout(radiusTimer.current);
    radiusTimer.current = setTimeout(() => setScanRadius(radius_mi), RADIUS_SETTLE_MS);
  }, []);

  const onReport = useCallback((t: ReportTarget) => {
    setReportTarget(t);
    setTab("report");
    setDrawerOpen(true);
  }, []);

  // Asset clicked on the map (or a top-plants row): show its card on the Area tab.
  // Drawer state is left alone, same as a plain map click.
  const onSelectAsset = useCallback((t: ReportTarget | null) => {
    setSelected(t);
    if (t) setTab("area");
  }, []);

  const onReportArea = useCallback(() => onReport({ kind: "area" }), [onReport]);

  const onClearTarget = useCallback(() => setReportTarget({ kind: "area" }), []);

  const onShowOnMap = useCallback((c: NicheCase) => {
    nonce.current += 1;
    setNewsPin({ lat: c.location.lat, lon: c.location.lon, nonce: nonce.current });
    setDrawerOpen(false);
  }, []);

  const onFocus = useCallback((lat: number, lon: number) => flyTo(lat, lon), [flyTo]);

  // ---- render -----------------------------------------------------------------
  return (
    <div className="gs-scan-app flex h-screen flex-col overflow-hidden bg-white text-ink">
      <TopBar
        data={data}
        area={area}
        heatwave={heatwave}
        onJump={onJump}
        onRadius={onRadius}
        onHeatwave={setHeatwave}
      />

      <main className="relative flex min-h-0 flex-1">
        {/* Map */}
        <section className="relative min-w-0 flex-1" aria-label="Scan map">
          {data ? (
            <ScanMap
              data={data}
              area={area}
              result={result}
              focus={focus}
              newsPin={newsPin}
              onScan={onScan}
              onFocus={onFocus}
              onSelectAsset={onSelectAsset}
              selected={selected}
              hazards={hazards.feed?.data ?? null}
            />
          ) : (
            <BootScreen error={loadError} />
          )}
        </section>

        {/* Drawer: docked at lg+, overlay sheet below lg */}
        <aside
          aria-label="Scan results"
          className={cx(
            "gs-scroll overflow-y-auto border-line bg-white",
            "lg:static lg:block lg:h-auto lg:w-[35%] lg:min-w-[400px] lg:translate-y-0 lg:border-l lg:border-t-0 lg:shadow-none",
            "absolute inset-x-0 bottom-0 h-[62%] border-t transition-transform duration-200 ease-out",
            "sm:left-auto sm:top-0 sm:h-auto sm:w-[420px] sm:max-w-full sm:border-l sm:border-t-0",
            drawerOpen ? "translate-y-0 sm:translate-x-0" : "translate-y-full sm:translate-x-full sm:translate-y-0",
            "lg:translate-x-0",
          )}
          style={{ zIndex: 30 }}
        >
          <ScanPanel
            result={result}
            live={live}
            liveLoading={liveLoading}
            heatwave={heatwave}
            daily={daily}
            onFocus={onFocus}
            tab={tab}
            onTab={setTab}
            cases={data?.cases ?? EMPTY_CASES}
            reportTarget={reportTarget}
            onClearTarget={onClearTarget}
            onShowOnMap={onShowOnMap}
            onReportArea={onReportArea}
            selected={selected}
            onSelectAsset={onSelectAsset}
            onReport={onReport}
            hazards={hazards}
          />
        </aside>

        {/* Drawer toggle (below lg only) */}
        <button
          type="button"
          onClick={() => setDrawerOpen((o) => !o)}
          aria-expanded={drawerOpen}
          className={cx(
            "absolute right-3 flex h-8 items-center gap-2 rounded-[6px] border border-line bg-white px-3 text-[13px] font-medium text-ink shadow-[var(--shadow-pop)] lg:hidden",
            // sit just outside the open sheet so it never covers panel content
            drawerOpen ? "bottom-[calc(62%+12px)] sm:bottom-8 sm:right-[432px]" : "bottom-8",
          )}
          style={{ zIndex: 35 }}
        >
          {drawerOpen ? "Hide results" : "Scan results"}
          {result && !drawerOpen && (
            <span className="num text-[var(--text-dim)]">{result.totals.plant_count}</span>
          )}
        </button>
      </main>
    </div>
  );
}

function BootScreen({ error }: { error: string | null }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#f6f8fa]">
      {error ? (
        <>
          <p className="text-[14px] font-medium text-critical">Map data failed to load.</p>
          <p className="max-w-md text-center text-[13px] text-ink-dim">{error}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-8 rounded-[6px] border border-line bg-white px-3 text-[13px] text-ink"
          >
            Retry
          </button>
        </>
      ) : (
        <p className="text-[14px] text-ink-dim">Loading…</p>
      )}
    </div>
  );
}
