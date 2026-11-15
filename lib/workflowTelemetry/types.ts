export type TelemetryUnit = "degC" | "m/s" | "MW" | "USD/MWh";

/** Immutable observation as reported by the provider; value/unit are never normalized in storage. */
export interface ProviderObservation {
  provider: "noaa-nws" | "caiso-oasis";
  series: string;
  target: string;
  observedAt: string;
  fetchedAt: string;
  value: number;
  unit: TelemetryUnit;
  sourceRevision: string | null;
  sourceUrl: string;
  qualifiers: Record<string, string>;
}

export interface TelemetryTarget {
  key: string;
  workspaceId: string;
  latitude: number;
  longitude: number;
  caisoNodeId: string;
  caisoNodeName: string;
}

export interface CalibrationStatus {
  status: "pending-commissioning" | "review-required" | "verified";
  verifiedAt: string | null;
  reviewer: string | null;
  evidenceCount: number;
  reason: string;
}
