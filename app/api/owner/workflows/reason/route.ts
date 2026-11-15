import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import { buildOwnerPlan } from "@/lib/ownerPlan";
import { ownerContext } from "@/lib/owner/db";
import { loadWorkflowArea } from "@/lib/workflowStore/server";

export const runtime = "nodejs";
export const maxDuration = 20;

const MAX_BODY_BYTES = 8_000;
const MAX_CANDIDATES = 3;
const MAX_TEXT = 900;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

function unavailable() {
  return NextResponse.json({ explanations: [], status: "unavailable" as const });
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return unavailable();
  const gate = await ownerContext();
  if (!gate.ok) return gate.response;
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) return NextResponse.json({ error: "Request too large" }, { status: 413 });

  let body: unknown;
  let deterministicFallback: (() => NextResponse) | null = null;
  try {
    if (!request.body) return NextResponse.json({ error: "Request body is required" }, { status: 400 });
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return NextResponse.json({ error: "Request too large" }, { status: 413 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const input = body as { area?: unknown; candidateIds?: unknown };
  if (!input.area || typeof input.area !== "object" || Array.isArray(input.area)) return NextResponse.json({ error: "area is required" }, { status: 400 });
  const area = input.area as Record<string, unknown>;
  if (![area.lat, area.lon, area.radius_mi].every((value) => typeof value === "number" && Number.isFinite(value))) return NextResponse.json({ error: "area requires finite lat, lon, and radius_mi" }, { status: 400 });
  const lat = area.lat as number, lon = area.lon as number, radius_mi = area.radius_mi as number;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || radius_mi <= 0 || radius_mi > 100) return NextResponse.json({ error: "area is outside supported bounds" }, { status: 400 });
  if (!Array.isArray(input.candidateIds) || input.candidateIds.length < 1 || input.candidateIds.length > MAX_CANDIDATES || input.candidateIds.some((id) => typeof id !== "string" || id.length > 120)) return NextResponse.json({ error: `candidateIds must contain 1 to ${MAX_CANDIDATES} IDs` }, { status: 400 });

  try {
    const scan = await loadWorkflowArea({ lat, lon, radius_mi });
    const plan = buildOwnerPlan(scan, null, null);
    if (!Number.isFinite(plan.confidenceGap.gap) || plan.confidenceGap.gap < 0 || plan.confidenceGap.gap > 100) return unavailable();
    const candidates = [...plan.interventions, ...plan.funding, ...plan.authorizations];
    const ids = [...new Set(input.candidateIds as string[])];
    const selected = ids.map((id) => candidates.find((candidate) => candidate.id === id));
    if (selected.some((candidate) => !candidate)) return NextResponse.json({ error: "Unknown candidate ID" }, { status: 400 });

    const sources: Record<string, string> = {
      "scan:area": `${scan.area_label}; area ${lat.toFixed(4)}, ${lon.toFixed(4)}, radius ${radius_mi} mi; scan risk ${scan.risk.level} (${scan.risk.score}/100).`,
      "plan:evidence-coverage": `Evidence coverage score ${plan.confidenceGap.score}%; evidence gap ${plan.confidenceGap.gap}%; ${plan.confidenceGap.evidenceAvailable} of ${plan.confidenceGap.evidenceExpected} evidence categories present.`,
    };
    const payload = selected.map((candidate) => {
      const sourceIds = ["scan:area", "plan:evidence-coverage"];
      candidate!.evidence.forEach((evidence, index) => {
        const sourceId = `${candidate!.id}:evidence:${index + 1}`;
        sources[sourceId] = evidence;
        sourceIds.push(sourceId);
      });
      return { candidateId: candidate!.id, title: candidate!.title, summary: candidate!.summary, tradeoff: candidate!.tradeoff, evidence: candidate!.evidence, allowedSourceIds: sourceIds, evidenceCoverageScore: plan.confidenceGap.score, evidenceGap: plan.confidenceGap.gap };
    });
    deterministicFallback = () => NextResponse.json({
      explanations: payload.map((entry) => {
        const cited = entry.allowedSourceIds.find((id) => id.endsWith(":evidence:1")) ?? "scan:area";
        return { candidateId: entry.candidateId, text: `${entry.summary} [${cited}] Review the listed evidence and owner-confirmed prerequisites before acting.`, sourceIds: [cited] };
      }),
      status: "unavailable" as const,
    });

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: `Explain each candidate using only its supplied evidence. Return JSON: {"explanations":[{"candidateId":"...","text":"...","sourceIds":["..."]}]}. Keep each explanation under 75 words, describe its numeric evidence coverage score and gap, explain uncertainty and the tradeoff, and cite claims inline with [sourceId]. Only cite allowedSourceIds. Do not present screening as approval, capacity, eligibility, or an operating limit.\nDATA: ${JSON.stringify({ candidates: payload, sources })}`,
      config: {
        systemInstruction: "You produce concise infrastructure screening explanations grounded only in supplied evidence. Never add external facts, estimates, or claims. Output valid JSON only.",
        temperature: 0.1,
        maxOutputTokens: 700,
        responseMimeType: "application/json",
      },
    });
    const raw = response.text?.trim();
    if (!raw) return deterministicFallback();
    const parsed = JSON.parse(raw) as { explanations?: Array<{ candidateId?: string; text?: string; sourceIds?: string[] }> };
    if (!Array.isArray(parsed.explanations)) return deterministicFallback();
    const returned = new Map(parsed.explanations.map((item) => [item.candidateId, item]));
    const explanations = payload.map((entry) => {
      const item = returned.get(entry.candidateId);
      if (!item || typeof item.text !== "string" || !Array.isArray(item.sourceIds)) return null;
      const allowed = new Set(entry.allowedSourceIds);
      if (item.sourceIds.some((id) => typeof id !== "string" || !allowed.has(id))) return null;
      const sourceIds = [...new Set(item.sourceIds)];
      if (!sourceIds.length) return null;
      const text = item.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
      const citedIds = [...text.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
      if (!text || !citedIds.length || citedIds.some((id) => !allowed.has(id) || !sourceIds.includes(id)) || sourceIds.some((id) => !citedIds.includes(id))) return null;
      const factualText = `${entry.title} ${entry.summary} ${entry.tradeoff} ${sourceIds.map((id) => sources[id]).join(" ")}`;
      const numericPattern = /(?<![A-Za-z0-9])\d+(?:,\d{3})*(?:\.\d+)?(?:\s?(?:%|MW|mi|days?|hours?|points?|years?|kV))?(?![A-Za-z0-9])/gi;
      const allowedNumbers = new Set([...factualText.matchAll(numericPattern)].map((match) => match[0].replaceAll(",", "").toLowerCase()));
      const claimedNumbers = [...text.replace(/\[[^\]]+\]/g, "").matchAll(numericPattern)].map((match) => match[0].replaceAll(",", "").toLowerCase());
      if (claimedNumbers.some((number) => !allowedNumbers.has(number))) return null;
      return { candidateId: entry.candidateId, text, sourceIds };
    });
    if (explanations.some((item) => item === null)) return deterministicFallback();
    return NextResponse.json({ explanations, status: "available" as const });
  } catch {
    return deterministicFallback?.() ?? unavailable();
  }
}
