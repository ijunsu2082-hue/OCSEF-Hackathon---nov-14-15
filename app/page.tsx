"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import ScanMap, { type MapFocus } from "@/components/scan/map";
import { TopBar } from "@/components/scan/shell/TopBar";
import ScanPanel from "@/components/scan/panel/ScanPanel";
import { cx } from "@/components/primitives";

const DEFAULT_AREA: ScanArea = { lat: CENTER.lat, lon: CENTER.lon, radius_mi: 5 };
const LIVE_DEBOUNCE_MS = 300;

export default function Page() {
  const [data, setData] = useState<GridData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [area, setArea] = useState<ScanArea>(DEFAULT_AREA);
  const [heatwave, setHeatwave] = useState(false);
  const [live, setLive] = useState<LineRatingNow | null>(null);
  const [liveLoading, setLiveLoading] = useState(true);
  const [daily, setDaily] = useState<DailyRating[] | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false); // only matters below lg
  const nonce = useRef(0);

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

  const result = useMemo(() => (data ? scanArea(data, area, { heatwave }) : null), [data, area, heatwave]);

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

  // ---- heatwave retheme -------------------------------------------------------
  useEffect(() => {
    const root = document.documentElement;
    if (heatwave) root.dataset.stress = "true";
    else delete root.dataset.stress;
    return () => {
      delete root.dataset.stress;
    };
  }, [heatwave]);

  // ---- handlers ---------------------------------------------------------------
  const flyTo = useCallback((lat: number, lon: number, zoom?: number) => {
    nonce.current += 1;
    setFocus({ lat, lon, zoom, nonce: nonce.current });
  }, []);

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
  }, []);

  const onSelectCase = useCallback(
    (c: NicheCase) => {
      setSelectedCaseId(c.id);
      flyTo(c.location.lat, c.location.lon, 12);
    },
    [flyTo],
  );

  const onFocus = useCallback((lat: number, lon: number) => flyTo(lat, lon), [flyTo]);

  // ---- render -----------------------------------------------------------------
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-ink">
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
              heatwave={heatwave}
              selectedCaseId={selectedCaseId}
              focus={focus}
              onScan={onScan}
              onFocus={onFocus}
              onSelectCase={onSelectCase}
            />
          ) : (
            <BootScreen error={loadError} />
          )}
        </section>

        {/* Drawer: docked at lg+, overlay sheet below lg */}
        <aside
          aria-label="Scan results"
          className={cx(
            "gs-scroll overflow-y-auto border-line bg-panel",
            "lg:static lg:block lg:h-auto lg:w-[35%] lg:min-w-[400px] lg:translate-y-0 lg:border-l lg:border-t-0 lg:shadow-none",
            "absolute inset-x-0 bottom-0 h-[62%] border-t shadow-[var(--shadow-pop)] transition-transform duration-200 ease-out",
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
            selectedCaseId={selectedCaseId}
            onSelectCase={onSelectCase}
            onFocus={onFocus}
          />
        </aside>

        {/* Drawer toggle (below lg only) */}
        <button
          type="button"
          onClick={() => setDrawerOpen((o) => !o)}
          aria-expanded={drawerOpen}
          className={cx(
            "absolute right-3 flex h-8 items-center gap-2 rounded-[var(--radius-sm)] border border-line-strong bg-panel-raised px-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink shadow-[var(--shadow-pop)] lg:hidden",
            // sit just outside the open sheet so it never covers panel content
            drawerOpen ? "bottom-[calc(62%+12px)] sm:bottom-8 sm:right-[432px]" : "bottom-8",
          )}
          style={{ zIndex: 35 }}
        >
          {drawerOpen ? "Hide results" : "Scan results"}
          {result && !drawerOpen && (
            <span className="num rounded-full bg-[var(--accent-soft)] px-1.5 text-accent">
              {result.totals.plant_count}
            </span>
          )}
        </button>
      </main>
    </div>
  );
}

function BootScreen({ error }: { error: string | null }) {
  return (
    <div className="grid-texture flex h-full w-full flex-col items-center justify-center gap-4 bg-bg">
      {error ? (
        <>
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-critical">Grid layers failed to load</p>
          <p className="max-w-md text-center text-[12px] text-ink-dim">{error}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-8 rounded-[var(--radius-sm)] border border-line-strong bg-panel px-3 text-[12px] text-ink"
          >
            Retry
          </button>
        </>
      ) : (
        <>
          <div className="gs-boot-radar" aria-hidden />
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
            Loading plants · transmission lines · substations
          </p>
        </>
      )}
    </div>
  );
}
