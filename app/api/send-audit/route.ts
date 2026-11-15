import { dispatchAudit, EMAIL_RE } from "@/lib/email/dispatch";
import { loadFacility } from "@/lib/region";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { node_id?: unknown; brief?: unknown; to?: unknown };

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

  if (typeof body.to !== "string" || !EMAIL_RE.test(body.to)) {
    return Response.json(
      { error: { code: "INVALID_RECIPIENT", message: "A single valid email address is required." } },
      { status: 400 },
    );
  }

  if (typeof body.brief !== "string" || body.brief.trim().length < 20) {
    return Response.json(
      { error: { code: "MISSING_BRIEF", message: "brief must be the generated memo text." } },
      { status: 422 },
    );
  }

  const subject = `${facility.name} — energy resilience & decarbonization screen`;
  const result = await dispatchAudit(body.to, subject, body.brief);

  return Response.json(result);
}
