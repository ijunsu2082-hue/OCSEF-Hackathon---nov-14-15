/*
 * Which owner-portal services have keys. Safe to import from middleware (edge),
 * route handlers and server components: reads env only, never returns secrets.
 *
 * Not configured mode: when keys are missing the team app ("/") and the public
 * scan app ("/scan") keep working, /owner pages show setup steps and
 * /api/owner/* answers 503 { error: "not_configured" }.
 */

const has = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";

/** Clerk sign-in needs both keys: publishable (browser) and secret (server). */
export function clerkConfigured(): boolean {
  return has(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) && has(process.env.CLERK_SECRET_KEY);
}

export function supabaseUrl(): string | null {
  const v = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return has(v) ? v.trim().replace(/\/+$/, "") : null;
}

/** Publishable key (sb_publishable_...). The legacy anon key works the same way. */
export function supabasePublishableKey(): string | null {
  const v = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return has(v) ? v.trim() : null;
}

/**
 * Server-only secret key (service_role or sb_secret_...). Optional. Used in exactly one
 * place: marking an email_domain claim verified after the server has checked the
 * user's Clerk-verified primary email (see lib/owner/db.ts markVerifiedByEmailDomain).
 * Without it, email_domain claims stay "pending" for an admin to review.
 * Never put this in a NEXT_PUBLIC_ variable.
 */
export function supabaseServiceKey(): string | null {
  const v = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return has(v) ? v.trim() : null;
}

export function supabaseConfigured(): boolean {
  return supabaseUrl() !== null && supabasePublishableKey() !== null;
}

export interface OwnerConfigStatus {
  clerk: boolean;
  supabase: boolean;
}

export function ownerConfigStatus(): OwnerConfigStatus {
  return { clerk: clerkConfigured(), supabase: supabaseConfigured() };
}

export const OWNER_SIGN_IN_PATH = "/owner/sign-in";
export const OWNER_SIGN_UP_PATH = "/owner/sign-up";
export const OWNER_HOME_PATH = "/owner";

/** Private Supabase Storage bucket for claim evidence (created by the migration). */
export const EVIDENCE_BUCKET = "claim-evidence";
