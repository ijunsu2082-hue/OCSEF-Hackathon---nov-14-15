import { ownerConfigStatus } from "@/lib/owner/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/owner/config -> { clerk, supabase }. Booleans only, never keys. Works with no keys set. */
export function GET() {
  const { clerk, supabase } = ownerConfigStatus();
  return Response.json({ clerk, supabase }, { headers: { "Cache-Control": "no-store" } });
}
