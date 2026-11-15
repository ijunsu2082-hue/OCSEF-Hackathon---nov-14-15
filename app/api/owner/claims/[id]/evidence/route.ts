import { EVIDENCE_BUCKET } from "@/lib/owner/config";
import { CLAIM_COLUMNS, dbErrorResponse, json, jsonError, ownerContext, toClaim } from "@/lib/owner/db";
import { evidencePath, FILE_TOO_BIG, isUuid, LIMITS, validateEvidenceFile } from "@/lib/owner/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/owner/claims/:id/evidence  multipart field "file" -> { claim }
 * PDF, PNG or JPG up to 5 MB (Netlify caps function request bodies at about 6 MB). Stored privately at <user_id>/<claim_id>/<file name>.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await ownerContext();
  if (!gate.ok) return gate.response;
  const { db, userId } = gate.ctx;

  const { id } = await params;
  if (!isUuid(id)) return jsonError(400, "Claim id is not valid.");
  const claimId = id.toLowerCase();

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > LIMITS.fileBytes + 64 * 1024) return jsonError(413, FILE_TOO_BIG);

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
  } catch {
    return jsonError(400, 'Send the file as multipart form data in a field named "file".');
  }
  if (!file) return jsonError(400, 'Send the file as multipart form data in a field named "file".');
  if (file.size > LIMITS.fileBytes) return jsonError(413, FILE_TOO_BIG);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = validateEvidenceFile({ name: file.name, size: bytes.byteLength, type: file.type, head: bytes.subarray(0, 16) });
  if (!checked.ok) return jsonError(400, checked.error);

  const { data: row, error: readErr } = await db
    .from("claims")
    .select("id,status")
    .eq("id", claimId)
    .eq("user_id", userId)
    .maybeSingle();
  if (readErr) return dbErrorResponse(readErr);
  if (!row) return jsonError(404, "Claim not found.");
  if (row.status !== "pending") return jsonError(409, "Documents can be added only while a claim is pending.");

  const path = evidencePath(userId, claimId, checked.value.fileName);
  const { error: upErr } = await db.storage
    .from(EVIDENCE_BUCKET)
    .upload(path, bytes, { contentType: checked.value.contentType, upsert: false });
  if (upErr) {
    const status = Number((upErr as { statusCode?: string | number }).statusCode ?? 0);
    if (status === 409 || /exists/i.test(upErr.message)) {
      return jsonError(409, "A file with this name is already attached. Rename the file and try again.");
    }
    if (status === 413) return jsonError(413, FILE_TOO_BIG);
    if (status === 403 || status === 401) return jsonError(403, "You are not allowed to add files to this claim.");
    console.error("[owner] evidence upload failed", status, upErr.message);
    return jsonError(500, "The upload failed. Try again.");
  }

  const { data, error } = await db
    .from("claims")
    .update({ evidence_path: path })
    .eq("id", claimId)
    .eq("user_id", userId)
    .select(CLAIM_COLUMNS)
    .single();
  if (error) return dbErrorResponse(error);
  return json({ claim: toClaim(data as Record<string, unknown>) });
}
