import { readLocationAssets } from "./load-assets";
import { readReport, reportRevision } from "./pipeline";

export const ASSET_INTEGRITY_ERROR = "Asset inventory failed integrity check";

/**
 * True for a stored inventory that exists but cannot be trusted: its bytes do
 * not match their revision digest, its latest pointer is not a revision, or
 * the stored JSON does not parse. Other failures (I/O) are not classified.
 */
export function isAssetIntegrityFailure(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  return error instanceof Error && /^(Asset revision checksum mismatch|Invalid asset revision)$/.test(error.message);
}

export type BoundAssets =
  | { status: 404 | 409; body: { error: string; report_revision?: string; asset_revision?: string } }
  | { status: 502; body: { error: typeof ASSET_INTEGRITY_ERROR; report_revision: string; asset_revision: string } }
  | {
    status: 200; report_revision: string; asset_revision: string; immutable: boolean;
    body: { revision: string; data: unknown };
  };

/**
 * Resolve the asset inventory a report revision was built against. Defaults to
 * the latest report; never falls back to the latest loaded inventory.
 */
export async function resolveBoundAssets(
  id: string, reportRev?: string, requestedAssetRev?: string,
): Promise<BoundAssets> {
  const report = await readReport(id, reportRev);
  if (!report) return { status: 404, body: { error: "Location report unavailable" } };
  const report_revision = reportRev ?? reportRevision(report);
  if (!report.assets) {
    return { status: 404, body: { error: "report has no bound asset inventory", report_revision } };
  }
  const { location, revision } = report.assets;
  if (requestedAssetRev !== undefined && requestedAssetRev !== revision) {
    return {
      status: 409,
      body: { error: `report is bound to asset revision ${revision}`, report_revision, asset_revision: revision },
    };
  }
  let assets: Awaited<ReturnType<typeof readLocationAssets>>;
  try {
    assets = await readLocationAssets(location, revision);
  } catch (error) {
    // Never serve bytes that failed verification; report which revision failed.
    if (!isAssetIntegrityFailure(error)) throw error;
    return { status: 502, body: { error: ASSET_INTEGRITY_ERROR, report_revision, asset_revision: revision } };
  }
  if (!assets) {
    return { status: 404, body: { error: "Bound asset inventory unavailable", report_revision, asset_revision: revision } };
  }
  return { status: 200, report_revision, asset_revision: assets.revision, immutable: reportRev !== undefined, body: assets };
}
