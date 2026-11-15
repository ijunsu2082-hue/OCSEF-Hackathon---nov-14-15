import { readLocationAssets } from "@/research/etl/load-assets";
import { ASSET_INTEGRITY_ERROR, isAssetIntegrityFailure } from "@/research/etl/bound-assets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Inventory-only view of a loaded asset revision, keyed by inventory id (center
 * + radius). Report citations use /api/location-report/[id]/assets instead.
 */
export async function GET(request: Request, { params }: { params: Promise<{ inventory: string }> }) {
  const { inventory } = await params;
  const revision = new URL(request.url).searchParams.get("revision") ?? undefined;
  if (!/^location-[a-f0-9]{24}$/.test(inventory)) {
    return Response.json({ error: "Invalid inventory id" }, { status: 400 });
  }
  if (revision !== undefined && !/^[a-f0-9]{64}$/.test(revision)) {
    return Response.json({ error: "Invalid asset revision" }, { status: 400 });
  }
  let assets: Awaited<ReturnType<typeof readLocationAssets>>;
  try {
    assets = await readLocationAssets(inventory, revision);
  } catch (error) {
    // Never serve bytes that failed verification. Without ?revision the failing
    // revision is whatever latest points at, which is not trusted here.
    if (!isAssetIntegrityFailure(error)) throw error;
    return Response.json({ error: ASSET_INTEGRITY_ERROR, asset_revision: revision ?? null },
      { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  if (!assets) return Response.json({ error: "Asset inventory unavailable" }, { status: 404 });
  return Response.json(assets, { headers: {
    "Cache-Control": revision ? "public, max-age=31536000, immutable" : "no-store",
    "X-Asset-Revision": assets.revision,
  } });
}
