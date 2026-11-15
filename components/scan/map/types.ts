import type { GridData, NicheCase, ScanArea, ScanResult } from "@/lib/scan";
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
  selectedCaseId?: string | null;
  focus: MapFocus | null;
  /** Pin dropped from the Local news tab; the 2D map flies to it. */
  newsPin?: NewsPin | null;
  /** A map popup can start a report; the report tab consumes the target. */
  onReport?: (t: ReportTarget) => void;
  /** Click anywhere on the map → scan at that point (page keeps the radius). */
  onScan: (lat: number, lon: number) => void;
  onFocus: (lat: number, lon: number) => void;
  onSelectCase?: (c: NicheCase) => void;
}
