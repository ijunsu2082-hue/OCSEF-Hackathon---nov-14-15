import type { GridData, NicheCase, ScanArea, ScanResult } from "@/lib/scan";

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
  heatwave: boolean;
  selectedCaseId: string | null;
  focus: MapFocus | null;
  /** Click anywhere on the map → scan at that point (page keeps the radius). */
  onScan: (lat: number, lon: number) => void;
  onFocus: (lat: number, lon: number) => void;
  onSelectCase: (c: NicheCase) => void;
}
