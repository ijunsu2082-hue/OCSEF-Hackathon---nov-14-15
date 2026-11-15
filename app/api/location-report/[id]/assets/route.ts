import { resolveBoundAssets } from "@/research/etl/bound-assets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const search = new URL(request.url).searchParams;
  const resolved = await resolveBoundAssets(
    id, search.get("report") ?? undefined, search.get("revision") ?? undefined,
  );
  if (resolved.status === 502) {
    return Response.json(resolved.body, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  if (resolved.status !== 200) return Response.json(resolved.body, { status: resolved.status });
  return Response.json(resolved.body, { headers: {
    "Cache-Control": resolved.immutable ? "public, max-age=31536000, immutable" : "no-store",
    "X-Report-Revision": resolved.report_revision,
    "X-Asset-Revision": resolved.asset_revision,
  } });
}
