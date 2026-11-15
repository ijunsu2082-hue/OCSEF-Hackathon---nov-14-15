import { loadRegion } from "@/lib/region";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ regionId: string }> },
) {
  const { regionId } = await params;
  const payload = await loadRegion(regionId);

  if (!payload) {
    return Response.json(
      { error: { code: "REGION_NOT_FOUND", message: `Unknown region "${regionId}"` } },
      { status: 404 },
    );
  }

  return Response.json(payload);
}
