/*
 * Server-only data access for the owner portal (route handlers under app/api/owner).
 *
 * Every read and write goes through a Supabase client that carries the signed-in
 * user's Clerk session token (Supabase third-party auth), so row level security in
 * supabase/migrations/0001_owner_portal.sql decides what the user may see and do.
 * Admin decisions use the same client; the admin RLS policies allow them.
 *
 * The one exception is markVerifiedByEmailDomain(), which uses the server-only
 * SUPABASE_SERVICE_ROLE_KEY. RLS (and the claims_guard trigger) never let a user set
 * their own claim to "verified", because the Supabase URL and publishable key are
 * public and a user could call the REST API directly with their own token. So the
 * server checks the Clerk-verified primary email itself and then flips that one
 * claim with the service key. If the key is not set, those claims stay "pending".
 *
 * Do not import this file from client components ("server-only" makes that a build error).
 */
import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { auth } from "@clerk/nextjs/server";
import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import type { AssetKind, AssetRef, Claim, ClaimStatus, Task, TaskStatus, VerifyMethod } from "./types";
import {
  clerkConfigured,
  supabaseConfigured,
  supabasePublishableKey,
  supabaseServiceKey,
  supabaseUrl,
} from "./config";

/* ---- responses ----------------------------------------------------------- */

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

export function json<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export const notConfigured = () => jsonError(503, "not_configured");

/** Map a PostgREST error to a response without leaking SQL details. */
export function dbErrorResponse(e: PostgrestError | { code?: string; message?: string } | null): Response {
  const code = e?.code ?? "";
  if (code === "23505") return jsonError(409, "You already have an open claim for this asset.");
  if (code === "42501") return jsonError(403, "You are not allowed to do that.");
  if (code === "23514" || code === "22P02" || code === "22007" || code === "22008") return jsonError(400, "Some fields are not valid.");
  if (code === "PGRST116") return jsonError(404, "Not found.");
  console.error("[owner] database error", code, e?.message);
  return jsonError(500, "The database request failed. Try again.");
}

/* ---- clients ------------------------------------------------------------- */

function userClient(token: string): SupabaseClient {
  return createClient(supabaseUrl()!, supabasePublishableKey()!, {
    accessToken: async () => token,
  });
}

function serviceClient(): SupabaseClient | null {
  const key = supabaseServiceKey();
  const url = supabaseUrl();
  if (!key || !url) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Server-only client for writes that cannot be trusted to a browser session (for example ranking impressions). */
export function ownerServiceClient(): SupabaseClient | null {
  return serviceClient();
}

export interface OwnerContext {
  userId: string;
  db: SupabaseClient;
}

/**
 * Auth gate for every /api/owner route except /config.
 * 503 not_configured when keys are missing, 401 when signed out.
 * user_id always comes from the Clerk session, never from the request body.
 */
export async function ownerContext(): Promise<{ ok: true; ctx: OwnerContext } | { ok: false; response: Response }> {
  if (!clerkConfigured() || !supabaseConfigured()) return { ok: false, response: notConfigured() };
  const { userId, getToken } = await auth();
  if (!userId) return { ok: false, response: jsonError(401, "Sign in to continue.") };
  const token = await getToken();
  if (!token) return { ok: false, response: jsonError(401, "Sign in to continue.") };
  return { ok: true, ctx: { userId, db: userClient(token) } };
}

/* ---- rows ---------------------------------------------------------------- */

export const CLAIM_COLUMNS =
  "id,user_id,asset_kind,asset_id,asset_name,owner_name,method,status,evidence_path,note,decided_by,decided_at,reason,created_at";
export const TASK_COLUMNS = "id,claim_id,obligation_id,due,status,filed_at,confirmation,note,updated_at";

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const sn = (v: unknown) => (v == null ? null : String(v));

export function toClaim(r: Row): Claim {
  return {
    id: s(r.id),
    user_id: s(r.user_id),
    asset_kind: s(r.asset_kind) as AssetKind,
    asset_id: s(r.asset_id),
    asset_name: s(r.asset_name),
    owner_name: s(r.owner_name),
    method: s(r.method) as VerifyMethod,
    status: s(r.status) as ClaimStatus,
    evidence_path: sn(r.evidence_path),
    note: sn(r.note),
    decided_by: sn(r.decided_by),
    decided_at: sn(r.decided_at),
    reason: sn(r.reason),
    created_at: s(r.created_at),
  };
}

export function toTask(r: Row): Task {
  return {
    id: s(r.id),
    claim_id: s(r.claim_id),
    obligation_id: s(r.obligation_id),
    due: s(r.due).slice(0, 10),
    status: s(r.status) as TaskStatus,
    filed_at: sn(r.filed_at),
    confirmation: sn(r.confirmation),
    note: sn(r.note),
    updated_at: s(r.updated_at),
  };
}

/** True when the signed-in user is in public.admins (RLS lets a user read only their own row). */
export async function isAdmin(ctx: OwnerContext): Promise<boolean> {
  const { data, error } = await ctx.db.from("admins").select("user_id").eq("user_id", ctx.userId).maybeSingle();
  if (error) {
    console.error("[owner] admin check failed", error.code, error.message);
    return false;
  }
  return !!data;
}

/**
 * Service-key write, server only (see the header comment). Call only after
 * lib/owner/verify.ts decideVerification() returned "verified" for this user's
 * Clerk-verified primary email. Returns null when no service key is configured.
 */
export async function markVerifiedByEmailDomain(claimId: string, userId: string, domain: string): Promise<Claim | null> {
  const svc = serviceClient();
  if (!svc) return null;
  const { data, error } = await svc
    .from("claims")
    .update({
      status: "verified",
      decided_by: "system:email_domain",
      decided_at: new Date().toISOString(),
      reason: `Clerk-verified primary email on ${domain}`,
    })
    .eq("id", claimId)
    .eq("user_id", userId)
    .eq("status", "pending")
    .eq("method", "email_domain")
    .select(CLAIM_COLUMNS)
    .maybeSingle();
  if (error) {
    console.error("[owner] email-domain verify update failed", error.code, error.message);
    return null;
  }
  return data ? toClaim(data as Row) : null;
}

/* ---- assets from public data ---------------------------------------------- */

export interface AssetRecord {
  ref: AssetRef;
  /** Name from public data; null when the data has none. */
  name: string | null;
  /** Owner from public data (EIA utility_name / OSM operator); "" when the data has none. */
  owner: string;
}

type Feature = { properties?: Record<string, unknown> | null };
type Index = Map<string, { name: string | null; owner: string }>;

const LAYER: Record<AssetKind, { file: string; id: string; name: string; owner: string }> = {
  plant: { file: "plants.geojson", id: "plant_code", name: "plant_name", owner: "utility_name" },
  substation: { file: "substations.geojson", id: "osm_id", name: "name", owner: "operator" },
  line: { file: "transmission.geojson", id: "osm_id", name: "name", owner: "operator" },
};

/**
 * Reads the same files the public app serves from public/layers. Falls back to fetching
 * them from a fixed origin (OWNER_DATA_ORIGIN, or Netlify's URL) when the server bundle
 * has no public/ folder. Never uses the request's Host header: owner names drive
 * verification, so the data must come from our own deployment.
 */
async function readLayer(file: string): Promise<{ features?: Feature[] }> {
  try {
    return JSON.parse(await readFile(join(process.cwd(), "public", "layers", file), "utf8"));
  } catch (err) {
    const origin = process.env.OWNER_DATA_ORIGIN || process.env.URL;
    if (!origin) throw err;
    const res = await fetch(new URL(`/layers/${file}`, origin), { cache: "force-cache" });
    if (!res.ok) throw new Error(`GET /layers/${file} -> ${res.status}`);
    return (await res.json()) as { features?: Feature[] };
  }
}

const indexes = new Map<AssetKind, Promise<Index>>();

function loadIndex(kind: AssetKind): Promise<Index> {
  let p = indexes.get(kind);
  if (!p) {
    const L = LAYER[kind];
    p = readLayer(L.file).then((fc) => {
      const m: Index = new Map();
      for (const f of fc.features ?? []) {
        const pr = f.properties ?? {};
        const id = pr[L.id];
        if (id == null) continue;
        const name = typeof pr[L.name] === "string" && (pr[L.name] as string).trim() ? (pr[L.name] as string).trim() : null;
        const owner = typeof pr[L.owner] === "string" ? (pr[L.owner] as string).trim() : "";
        m.set(String(id), { name, owner });
      }
      return m;
    });
    p.catch(() => indexes.delete(kind));
    indexes.set(kind, p);
  }
  return p;
}

export async function findAssetRecord(ref: AssetRef): Promise<AssetRecord | null> {
  const hit = (await loadIndex(ref.kind)).get(ref.id);
  return hit ? { ref, name: hit.name, owner: hit.owner } : null;
}
