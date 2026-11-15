import { cachedOwnerSources, parseOwnerSourcesQuery } from "@/lib/owner/ownerSources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (code: string, message: string, status: number, headers: Record<string, string> = {}) =>
  Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function GET(request: Request) {
  const parsed = parseOwnerSourcesQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return jsonError("INVALID_QUERY", parsed.error, 400);
  const result = await cachedOwnerSources(parsed.query);
  if (!result.ok) {
    return jsonError("RATE_LIMITED", "Too many owner-source lookups; retry later.", 429, { "Retry-After": String(result.retryAfterSeconds) });
  }
  return Response.json(result.body, { headers: { "Cache-Control": "private, max-age=300" } });
}
