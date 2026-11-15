import { POLICIES_VERSION } from "@/research/etl/reconcile-policies";
import { reconcileReport } from "@/research/etl/reconcile-report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Stored-record integrity failures, safe to show verbatim; anything else may carry paths. */
const INTEGRITY_ERRORS = new Set([
  "Report revision checksum mismatch",
  "Reconciliation does not match its report revision",
  "Reconciliation checksum mismatch",
]);

/**
 * Persisted provider reconciliation for a report revision (`?report=<rev>`),
 * or for the latest report when omitted. Reconciliation is deterministic over
 * the stored report, its blobs and the reviewed policy registry, so the first
 * request computes and persists it; later requests return the stored record.
 *
 * The record also depends on the policy registry, so the response is immutable
 * only when the URL pins both: `?report=<rev>&policies=<first 12 hex of
 * POLICIES_VERSION>` matching the current version. `?report=<rev>` alone gets
 * a short `max-age=300`; a stale or malformed `policies` gets `no-store`.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const revision = query.get("report") ?? undefined;
  const policies = query.get("policies");
  let record;
  try {
    record = await reconcileReport(id, revision);
  } catch (error) {
    if (error instanceof Error && INTEGRITY_ERRORS.has(error.message)) {
      return Response.json({ error: error.message }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ error: "Reconciliation unavailable" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  if (!record) return Response.json({ error: "Location report unavailable" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const pinned = policies !== null && policies === POLICIES_VERSION.slice(0, 12) && record.policies_version === POLICIES_VERSION;
  const cacheControl = !revision ? "no-store"
    : pinned ? "public, max-age=31536000, immutable"
    : policies === null ? "public, max-age=300"
    : "no-store";
  return Response.json(record, { headers: {
    "Cache-Control": cacheControl,
    "X-Report-Revision": record.report_revision,
    "X-Policies-Version": record.policies_version,
  } });
}
