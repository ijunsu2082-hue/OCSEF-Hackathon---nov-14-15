import { getFacility } from "@/lib/region";
import { simulate } from "@/lib/simulation";
import { energyRisk } from "@/lib/risk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: {
    node_id?: unknown;
    heatwave_active?: unknown;
    added_solar_mw?: unknown;
    vfd_retrofit?: unknown;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "Body must be valid JSON." } },
      { status: 400 },
    );
  }

  if (typeof body.node_id !== "string" || body.node_id.length === 0) {
    return Response.json(
      { error: { code: "MISSING_NODE", message: "node_id is required." } },
      { status: 422 },
    );
  }

  const facility = getFacility(body.node_id);
  if (!facility) {
    return Response.json(
      { error: { code: "NODE_NOT_FOUND", message: `Unknown facility "${body.node_id}".` } },
      { status: 404 },
    );
  }

  const heatwave = body.heatwave_active === true;
  const vfd = body.vfd_retrofit === true;
  const solarRaw = body.added_solar_mw === undefined ? 0 : Number(body.added_solar_mw);

  if (!Number.isFinite(solarRaw) || solarRaw < 0 || solarRaw > 100) {
    return Response.json(
      {
        error: {
          code: "INVALID_SOLAR",
          message: "added_solar_mw must be a finite number between 0 and 100.",
        },
      },
      { status: 422 },
    );
  }

  const result = simulate(facility, {
    heatwave_active: heatwave,
    added_solar_mw: solarRaw,
    vfd_retrofit: vfd,
  });

  result.risk_score = energyRisk(facility, { heatwave });

  return Response.json(result);
}
