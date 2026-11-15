import { NextResponse } from "next/server";
import { EVIDENCE_BUCKET } from "@/lib/owner/config";
import { dbErrorResponse, isAdmin, json, jsonError, ownerContext } from "@/lib/owner/db";
import { isUuid, sniffType } from "@/lib/owner/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/owner/admin/claims/:id/evidence -> 302 to a 5-minute signed URL for the claim's
 * document (admins only; storage policy "claim-evidence: admins read").
 * Add ?format=json to get { url } instead of a redirect.
 * Before signing, the file is downloaded and its first bytes re-checked (%PDF-, PNG or JPEG
 * signature): a user can upload straight to Storage with any bytes labelled as a PDF and
 * skip the API's check. Files that fail are 422 and are never signed.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await ownerContext();
  if (!gate.ok) return gate.response;
  if (!(await isAdmin(gate.ctx))) return jsonError(403, "Only admins can review claims.");
  const { id } = await params;
  if (!isUuid(id)) return jsonError(400, "Claim id is not valid.");
  const { data, error } = await gate.ctx.db.from("claims").select("evidence_path").eq("id", id.toLowerCase()).maybeSingle();
  if (error) return dbErrorResponse(error);
  if (!data) return jsonError(404, "Claim not found.");
  if (!data.evidence_path) return jsonError(404, "This claim has no document yet.");
  const path = String(data.evidence_path);
  const file = await gate.ctx.db.storage.from(EVIDENCE_BUCKET).download(path);
  if (file.error || !file.data) {
    console.error("[owner] evidence download failed", file.error?.message);
    return jsonError(500, "Could not open the document. Try again.");
  }
  const head = new Uint8Array(await file.data.slice(0, 16).arrayBuffer());
  if (!sniffType(head)) return jsonError(422, "This file is not a real PDF, PNG or JPG, so it was not opened. Reject the claim or ask for a new file.");
  const signed = await gate.ctx.db.storage.from(EVIDENCE_BUCKET).createSignedUrl(path, 300);
  if (signed.error || !signed.data?.signedUrl) {
    console.error("[owner] signed url failed", signed.error?.message);
    return jsonError(500, "Could not open the document. Try again.");
  }
  if (new URL(request.url).searchParams.get("format") === "json") return json({ url: signed.data.signedUrl });
  const res = NextResponse.redirect(signed.data.signedUrl, 302);
  res.headers.set("Cache-Control", "no-store");
  return res;
}
