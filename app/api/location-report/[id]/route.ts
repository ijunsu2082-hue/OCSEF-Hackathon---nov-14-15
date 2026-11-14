import { readReport } from "@/research/etl/pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const revision = new URL(request.url).searchParams.get("revision") ?? undefined;
  const report = await readReport((await params).id, revision);
  if (!report) return Response.json({ error: "Location report unavailable" }, { status: 404 });
  return Response.json(report, { headers: { "Cache-Control": "no-store" } });
}
