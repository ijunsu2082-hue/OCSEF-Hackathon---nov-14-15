"use client";

import dynamic from "next/dynamic";
import type { ScanMapProps } from "./types";

export type { MapFocus, ScanMapProps } from "./types";

/** Leaflet touches `window` at import time, so the map only ever renders on the client. */
const ScanMap = dynamic<ScanMapProps>(() => import("./ScanMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#f6f8fa]">
      <span className="text-[14px] text-[#556070]">Loading map…</span>
    </div>
  ),
});

export default ScanMap;
