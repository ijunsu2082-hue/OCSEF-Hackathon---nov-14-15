/**
 * Binds a scan area to the ETL location report collected for exactly that
 * area, and to the persisted provider reconciliation for that report's
 * revision. No UI: app/location-report/[id]/LocationReport.tsx renders it.
 */

import type { ScanArea } from "./types";
import type { LocationReport as EtlLocationReport } from "../../research/etl/pipeline";
import type { Reconciliation, ReconciliationSide } from "../../research/etl/reconcile-report";

/**
 * ETL location id for this exact area: `location-` + first 24 hex of the
 * sha256 of the canonical `{center, radius_miles}` query (research/etl/pipeline
 * locationId with no respondent / CAISO / OASIS options).
 */
export async function locationIdFor(area: ScanArea): Promise<string> {
  const canonical = `{"center":[${JSON.stringify(area.lat)},${JSON.stringify(area.lon)}],"radius_miles":${JSON.stringify(area.radius_mi)}}`;
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `location-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24)}`;
}

export type BoundReport =
  | { status: "loading" }
  | { status: "ready"; locationId: string; report: EtlLocationReport; revision: string }
  | { status: "missing"; reason: string };

/** The ETL location report for this area, if one has been collected. Its revision selects the bound asset inventory. */
export async function fetchBoundReport(area: ScanArea, signal?: AbortSignal): Promise<Exclude<BoundReport, { status: "loading" }>> {
  try {
    const locationId = await locationIdFor(area);
    const res = await fetch(`/api/location-report/${locationId}`, { cache: "no-store", signal });
    if (!res.ok) return { status: "missing", reason: `no location report for ${locationId} (${res.status})` };
    const report = (await res.json()) as EtlLocationReport;
    const revision = res.headers.get("X-Report-Revision");
    if (!revision) return { status: "missing", reason: "location report has no revision header" };
    return { status: "ready", locationId, report, revision };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "missing", reason: error instanceof Error ? error.message : "location report unreadable" };
  }
}

export type ReconciliationResult = { record: Reconciliation; error: null } | { record: null; error: string };

/**
 * Persisted provider reconciliation for exactly `revision`. A record bound to
 * any other report revision is rejected, never shown.
 */
export async function fetchReconciliation(locationId: string, revision: string, signal?: AbortSignal): Promise<ReconciliationResult> {
  try {
    const response = await fetch(`/api/location-report/${locationId}/reconciliation?report=${revision}`, { signal });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
    if (body?.report_revision !== revision) throw new Error("Reconciliation is bound to a different report revision");
    return { record: body as Reconciliation, error: null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { record: null, error: error instanceof Error ? error.message : "Reconciliation unavailable" };
  }
}

/** One side's value as text, or why it has none. Disagreeing values are shown side by side, never averaged. */
export function reconciliationSideText(side: ReconciliationSide): { value: string; missing: boolean } {
  if (!side.observation) return { value: side.issue ?? "no value", missing: true };
  const { value, scope } = side.observation;
  const shown = typeof value === "number" ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(value);
  return { value: `${shown} ${scope.unit}`, missing: false };
}
