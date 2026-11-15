export const WORKFLOW_OPTION_IDS = [
  "intervention:microgrid-storage",
  "intervention:dynamic-line-rating",
  "intervention:substation-capacity",
  "intervention:feeder-hardening",
  "intervention:renewables-storage",
] as const;

export type WorkflowOptionId = (typeof WORKFLOW_OPTION_IDS)[number];
export type FeedbackEvent = "approve" | "reject" | "export" | "capex";

export interface AreaInput {
  lat: number;
  lon: number;
  radius_mi: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseArea(value: unknown): AreaInput | null {
  if (!isRecord(value)) return null;
  const { lat, lon, radius_mi } = value;
  if (
    typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
    typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180 ||
    typeof radius_mi !== "number" || !Number.isFinite(radius_mi) || radius_mi <= 0 || radius_mi > 500
  ) return null;
  return { lat, lon, radius_mi };
}

export function parseAreaKey(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 100) return null;
  const parts = value.split(":");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null;
  const [lat, lon, radius] = parts.map(Number);
  if (!parseArea({ lat, lon, radius_mi: radius })) return null;
  return value;
}

export function parseWorkspaceId(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 100 && !/[\u0000-\u001f]/.test(value)
    ? value
    : null;
}

export function parseWorkflowState(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && JSON.stringify(value).length <= 250_000 ? value : null;
}

export function parseFeedback(value: unknown): {
  impressionId: string;
  optionId: string;
  event: FeedbackEvent;
  value?: string;
} | null {
  if (!isRecord(value)) return null;
  const { impressionId, optionId, event } = value;
  if (typeof impressionId !== "string" || !/^[0-9a-f-]{36}$/i.test(impressionId)) return null;
  if (typeof optionId !== "string" || (!WORKFLOW_OPTION_IDS.includes(optionId as WorkflowOptionId) && optionId !== "packet")) return null;
  if (event !== "approve" && event !== "reject" && event !== "export" && event !== "capex") return null;
  if (value.value !== undefined && (typeof value.value !== "string" || value.value.length > 200)) return null;
  return { impressionId, optionId, event, ...(typeof value.value === "string" ? { value: value.value } : {}) };
}

export function feedbackReward(event: FeedbackEvent): number {
  switch (event) {
    case "approve": return 1;
    case "reject": return -1;
    case "export": return 0.25;
    case "capex": return 0;
  }
}
