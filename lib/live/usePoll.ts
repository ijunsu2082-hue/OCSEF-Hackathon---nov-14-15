"use client";

import { useEffect, useRef, useState } from "react";
import type { LiveFeed } from "./types";

/**
 * Poll a live feed route. Refetches every feed.refreshSec (default 60 s), pauses while the
 * tab is hidden and refetches when it comes back, and keeps the last good data on error.
 */
export function usePoll<T>(url: string | null, fallbackRefreshSec = 60) {
  const [feed, setFeed] = useState<LiveFeed<T> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const run = async () => {
      if (typeof document !== "undefined" && document.hidden) {
        timer.current = setTimeout(run, 5000);
        return;
      }
      setLoading(true);
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = (await res.json()) as LiveFeed<T>;
        if (!cancelled) {
          setFeed(next);
          setError(null);
        }
        if (!cancelled) timer.current = setTimeout(run, (next.refreshSec || fallbackRefreshSec) * 1000);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Request failed");
          timer.current = setTimeout(run, fallbackRefreshSec * 1000);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [url, fallbackRefreshSec]);

  // Tick once a second so "updated 12 s ago" labels stay current.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const ageSec = feed?.sourceUpdatedAt ? Math.max(0, Math.round((now - Date.parse(feed.sourceUpdatedAt)) / 1000)) : null;
  const fetchedAgoSec = feed ? Math.max(0, Math.round((now - Date.parse(feed.fetchedAt)) / 1000)) : null;
  return { feed, loading, error, ageSec, fetchedAgoSec };
}

export function agoLabel(sec: number | null): string {
  if (sec == null) return "";
  if (sec < 60) return `${sec} s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
}
