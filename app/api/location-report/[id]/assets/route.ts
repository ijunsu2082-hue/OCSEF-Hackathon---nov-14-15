import { readLocationAssets } from "@/research/etl/load-assets";
import { locationId, readReport } from "@/research/etl/pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const revision = new URL(request.url).searchParams.get("revision") ?? undefined;
  const report = await readReport(id);
  const inventoryId = report ? locationId({
    center: report.query.center, radius_miles: report.query.radius_miles,
  }) : id;
  const assets = await readLocationAssets(inventoryId, revision);
  if (!assets) return Response.json({ error: "Location assets unavailable" }, { status: 404 });
  return Response.json(assets, { headers: { "Cache-Control": "no-store" } });
}
