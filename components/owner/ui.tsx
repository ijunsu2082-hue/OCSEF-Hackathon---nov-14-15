"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Frequency, Obligation } from "@/lib/owner/types";

/*
 * Shared pieces for the owner screens. Palette from the design spec: white, borders
 * #e6e9ee, text #1d2733 / #556070 / #6b7583, one sky accent #0ea5e9, links #0369a1.
 */

export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";
export const BTN = `inline-flex h-9 items-center justify-center rounded-[6px] border border-[#e6e9ee] bg-white px-3 text-[14px] font-medium text-[#1d2733] transition-colors hover:bg-[#f6f8fa] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
export const PRIMARY = `inline-flex h-10 items-center justify-center rounded-[6px] bg-[#0ea5e9] px-4 text-[14px] font-semibold text-[#1d2733] transition-colors hover:bg-[#38bdf8] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
export const LINK = `text-[#0369a1] underline-offset-2 hover:underline ${FOCUS}`;
export const INPUT = "w-full rounded-[6px] border border-[#e6e9ee] bg-white px-3 py-2 text-[14px] text-[#1d2733] placeholder:text-[#6b7583] focus-visible:border-[#0ea5e9] focus-visible:outline-none";

export const FREQUENCY_WORD: Record<Frequency, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Twice a year",
  annual: "Once a year",
  event: "When something happens",
  once: "One time",
};

export function ConfidenceText({ c }: { c: Obligation["confidence"] }) {
  return c === "verified" ? (
    <span className="text-[13px] font-medium text-[#0369a1]">Verified</span>
  ) : (
    <span className="text-[13px] font-medium text-[#556070]">Check if it applies</span>
  );
}

/* ---------------------------------------------------------------- API */

export interface OwnerConfig {
  clerk: boolean;
  supabase: boolean;
}

/** Fetch JSON; throws an Error carrying the server's message and HTTP status. */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Request failed (${res.status})`;
    const friendly = msg === "not_configured" ? "The owner portal is not set up yet." : msg;
    const err = new Error(friendly) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body as T;
}

export function errorStatus(e: unknown): number | undefined {
  return (e as { status?: number } | null)?.status;
}

/** GET /api/owner/config. null while loading. */
export function useOwnerConfig(): { config: OwnerConfig | null; error: string | null } {
  const [config, setConfig] = useState<OwnerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<OwnerConfig>("/api/owner/config")
      .then((c) => alive && setConfig({ clerk: !!c.clerk, supabase: !!c.supabase }))
      .catch(() => {
        // No config route reachable: treat as not configured so no Clerk component renders.
        if (alive) {
          setConfig({ clerk: false, supabase: false });
          setError("Could not reach the owner portal settings.");
        }
      });
    return () => {
      alive = false;
    };
  }, []);
  return { config, error };
}

export const isConfigured = (c: OwnerConfig | null) => !!c && c.clerk && c.supabase;

/* ---------------------------------------------------------------- Layout bits */

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 text-[#1d2733]">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[22px] font-semibold leading-snug">{title}</h1>
        {actions}
      </div>
      <div className="mt-6">{children}</div>
    </main>
  );
}

export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <p className="text-[14px] text-[#556070]" aria-busy="true">
      {children}
    </p>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-[14px] leading-snug text-[#dc2626]">
      {children}
    </p>
  );
}

const ENV_VARS: { name: string; what: string }[] = [
  { name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", what: "Clerk publishable key (sign-in)" },
  { name: "CLERK_SECRET_KEY", what: "Clerk secret key (server only)" },
  { name: "NEXT_PUBLIC_SUPABASE_URL", what: "Supabase project URL" },
  { name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", what: "Supabase publishable key (the legacy NEXT_PUBLIC_SUPABASE_ANON_KEY also works)" },
  { name: "SUPABASE_SERVICE_ROLE_KEY", what: "Optional, server only: lets work-email claims verify automatically" },
];

/** Shown when /api/owner/config reports Clerk or Supabase is not set up (e.g. on localhost before keys are added). */
export function SetupCard({ config, note }: { config: OwnerConfig | null; note?: string | null }) {
  return (
    <section
      aria-labelledby="owner-setup-title"
      className="rounded-[6px] border border-[#e6e9ee] bg-white px-5 py-5"
    >
      <h2 id="owner-setup-title" className="text-[16px] font-semibold leading-snug">
        The owner portal is not set up yet
      </h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#556070]">
        Sign-in and storage need keys before owners can claim assets. Add these environment variables (for example in
        .env.local), then restart the app. Setup steps are in <span className="font-medium text-[#1d2733]">docs/OWNER_PORTAL.md</span>.
      </p>
      <ul className="mt-3 flex flex-col gap-1.5">
        {ENV_VARS.map((v) => (
          <li key={v.name} className="text-[14px] leading-snug">
            <code className="font-semibold text-[#1d2733]">{v.name}</code>
            <span className="text-[#556070]"> · {v.what}</span>
          </li>
        ))}
      </ul>
      {config && (
        <p className="mt-3 text-[13px] text-[#6b7583]">
          Sign-in: {config.clerk ? "set up" : "not set up"}. Storage: {config.supabase ? "set up" : "not set up"}.
        </p>
      )}
      {note && <p className="mt-1 text-[13px] text-[#6b7583]">{note}</p>}
    </section>
  );
}

/** Copy-to-clipboard button with a short "Copied" state. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      aria-live="polite"
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => setState("copied"),
          () => setState("error"),
        )
      }
      className={`h-7 rounded-[6px] border border-[#e6e9ee] bg-white px-2 text-[13px] font-medium text-[#1d2733] hover:bg-[#f6f8fa] ${FOCUS}`}
    >
      {state === "copied" ? "Copied" : state === "error" ? "Copy failed" : label}
    </button>
  );
}
