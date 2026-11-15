/**
 * Supabase Storage mirror for ETL state.
 *
 * The location pipeline writes checksummed, immutable JSON documents (reports,
 * pinned revisions, loaded asset inventories and raw captures). On disk they
 * live under `research/etl-state/`, which a deployed app cannot read — so every
 * publish is mirrored into a private bucket at the same relative path:
 *
 *   reports/<location-id>.json
 *   revisions/<location-id>/<revision>.json
 *   loaded-assets/<location-id>/<revision>.json
 *   loaded-assets/<location-id>/latest.json
 *   blobs/<sha256>.json
 *
 * Reads prefer the bucket and fall back to disk, so local CLI work keeps
 * functioning with no credentials. A Supabase failure never breaks collection:
 * the disk write already happened and `putJson` reports false instead of throwing.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const ETL_BUCKET = "etl-state";

let client: SupabaseClient | null | undefined;

/** Service-role client: the bucket is private, so the anon key cannot read it. */
function serviceClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  client =
    url && key
      ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
      : null;
  return client;
}

export function etlStorageConfigured(): boolean {
  return serviceClient() !== null;
}

let ready: Promise<SupabaseClient | null> | null = null;

/** Client with the bucket ensured to exist (created once per process on demand). */
function storageClient(): Promise<SupabaseClient | null> {
  const supabase = serviceClient();
  if (!supabase) return Promise.resolve(null);
  ready ??= (async () => {
    const { data, error } = await supabase.storage.getBucket(ETL_BUCKET);
    if (data && !error) return supabase;
    const created = await supabase.storage.createBucket(ETL_BUCKET, { public: false });
    if (created.error && !/already exists/i.test(created.error.message)) {
      console.warn(`[etl] cannot create bucket "${ETL_BUCKET}": ${created.error.message}`);
      ready = null;
      return null;
    }
    return supabase;
  })().catch((error: unknown) => {
    console.warn("[etl] storage unavailable:", error instanceof Error ? error.message : error);
    ready = null;
    return null;
  });
  return ready;
}

/** Upload one document. Returns false (never throws) when Supabase is unset or fails. */
export async function putJson(objectPath: string, value: unknown): Promise<boolean> {
  const supabase = await storageClient();
  if (!supabase) return false;
  try {
    const body = new Blob([JSON.stringify(value)], { type: "application/json" });
    const { error } = await supabase.storage
      .from(ETL_BUCKET)
      .upload(objectPath, body, { upsert: true, contentType: "application/json" });
    if (error) {
      console.warn(`[etl] upload "${objectPath}" failed: ${error.message}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`[etl] upload "${objectPath}" failed:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/** Read one document back, or null when it is missing. */
export async function getJson<T>(objectPath: string): Promise<T | null> {
  const supabase = await storageClient();
  if (!supabase) return null;
  const { data, error } = await supabase.storage.from(ETL_BUCKET).download(objectPath);
  if (error || !data) return null;
  try {
    return JSON.parse(await data.text()) as T;
  } catch {
    console.warn(`[etl] "${objectPath}" is not valid JSON`);
    return null;
  }
}

/** Raw bytes, used to mirror capture blobs for replay on another host. */
export async function putText(objectPath: string, body: string): Promise<boolean> {
  const supabase = await storageClient();
  if (!supabase) return false;
  try {
    const { error } = await supabase.storage
      .from(ETL_BUCKET)
      .upload(objectPath, new Blob([body], { type: "application/json" }), {
        upsert: true,
        contentType: "application/json",
      });
    if (error) {
      console.warn(`[etl] upload "${objectPath}" failed: ${error.message}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`[etl] upload "${objectPath}" failed:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/** Key for the current report of a location, and for a pinned revision. */
export function reportKey(location: string, revision?: string): string {
  return revision ? `revisions/${location}/${revision}.json` : `reports/${location}.json`;
}
