"use client";

import dynamic from "next/dynamic";
import type { ScanMapProps } from "./types";

export type { MapFocus, ScanMapProps } from "./types";

/** Leaflet touches `window` at import time, so the map only ever renders on the client. */
const ScanMap = dynamic<ScanMapProps>(() => import("./ScanMap"), {
  ssr: false,
  loading: () => (
    <div className="grid-texture flex h-full w-full items-center justify-center bg-bg">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Loading map…</span>
    </div>
  ),
});

export default ScanMap;
