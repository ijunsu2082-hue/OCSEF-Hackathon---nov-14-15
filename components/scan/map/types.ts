import type { GridData, ScanArea, ScanResult } from "@/lib/scan";
import type { NewsPin, ReportTarget } from "@/lib/scan/target";

/** A fly-to request from the page. Bump `nonce` to re-trigger the same point. */
export interface MapFocus {
  lat: number;
  lon: number;
  zoom?: number;
  nonce: number;
}

export interface ScanMapProps {
  data: GridData;
  area: ScanArea;
  result: ScanResult | null;
  focus: MapFocus | null;
  /** A story's spot from the Local news tab: one plain pin, cleared by the next map click. */
  newsPin: NewsPin | null;
  /** Click anywhere on the map → scan at that point (page keeps the radius). */
  onScan: (lat: number, lon: number) => void;
  onFocus: (lat: number, lon: number) => void;
  /** "Report a problem" in an asset popup. */
  onReport: (t: ReportTarget) => void;
}
