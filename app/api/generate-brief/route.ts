import { generateBrief } from "@/lib/ai/brief";
import { loadFacility } from "@/lib/region";
import type { SimResult } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { node_id?: unknown; simulation?: unknown; tone?: unknown };

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "Body must be valid JSON." } },
      { status: 400 },
    );
  }

  if (typeof body.node_id !== "string") {
    return Response.json(
      { error: { code: "MISSING_NODE", message: "node_id is required." } },
      { status: 422 },
    );
  }

  const facility = await loadFacility(body.node_id);
  if (!facility) {
    return Response.json(
      { error: { code: "NODE_NOT_FOUND", message: `Unknown facility "${body.node_id}".` } },
      { status: 404 },
    );
  }

  const simulation = body.simulation as SimResult | undefined;
  if (!simulation || typeof simulation !== "object" || simulation.node_id !== body.node_id) {
    return Response.json(
      {
        error: {
          code: "INVALID_SIMULATION",
          message: "simulation is required and must match node_id.",
        },
      },
      { status: 422 },
    );
  }

  const tone = body.tone === "executive" ? "executive" : "technical";
  const result = await generateBrief(facility, simulation, tone);

  return Response.json(result);
}
