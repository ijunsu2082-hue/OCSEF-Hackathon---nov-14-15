/**
 * Supabase client for the read-only reference datasets (see
 * supabase/migrations/). Every table is public-read for `anon`, so the anon
 * key is enough on both server and browser.
 *
 * Returns null when NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY
 * is missing; callers then fall back to the local files in data/ and
 * public/layers/.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null | undefined;

export function getSupabase(): SupabaseClient | null {
  if (client !== undefined) return client;
  // Referenced literally so Next.js inlines them into the browser bundle.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  client =
    url && key
      ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
      : null;
  return client;
}

const PAGE = 1000;

/**
 * Read every row of a table, paging with .range() past the REST row cap.
 * Throws on any error so callers can fall back.
 */
export async function selectAll<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  orderBy: string,
  filter?: { column: string; value: string },
): Promise<T[]> {
  const rows: T[] = [];
  let total: number | null = null;
  for (;;) {
    let query = supabase
      .from(table)
      .select(columns, rows.length === 0 ? { count: "exact" } : undefined)
      .order(orderBy, { ascending: true });
    if (filter) query = query.eq(filter.column, filter.value);
    const { data, error, count } = await query.range(rows.length, rows.length + PAGE - 1);
    if (error) throw new Error(`supabase ${table}: ${error.message}`);
    if (total === null) total = count ?? null;
    const page = (data ?? []) as unknown as T[];
    rows.push(...page);
    // Advance by what the server actually returned, so a lower server-side cap
    // than PAGE still pages correctly.
    if (page.length === 0 || (total !== null && rows.length >= total)) break;
    if (total === null && page.length < PAGE) break;
  }
  return rows;
}
