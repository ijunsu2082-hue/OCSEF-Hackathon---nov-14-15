import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { clerkConfigured, OWNER_HOME_PATH, OWNER_SIGN_IN_PATH, OWNER_SIGN_UP_PATH } from "@/lib/owner/config";

export const metadata: Metadata = { title: "GridSentinel · Owner portal" };

// Decide on ClerkProvider per request, matching /api/owner/config, so keys added after the
// build (or set only at runtime) still mount the provider.
export const dynamic = "force-dynamic";

/*
 * Owner portal chrome. ClerkProvider mounts only when Clerk keys are set, so with no
 * keys nothing Clerk-related runs (no keyless dev instance) and pages show setup steps.
 */

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";

function Chrome({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-h-screen bg-white text-[#1d2733]"
      style={{ fontFamily: 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif' }}
    >
      <header className="border-b border-[#e6e9ee] bg-white">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-4 px-6">
          <div className="flex items-center gap-3">
            <a href="/scan" className={`flex items-center gap-2 rounded-[6px] text-[15px] font-semibold ${FOCUS}`}>
              <span aria-hidden className="inline-block h-3 w-3 rounded-[3px] bg-[#0ea5e9]" />
              GridSentinel
            </a>
            <a href={OWNER_HOME_PATH} className={`rounded-[6px] text-[14px] text-[#556070] hover:text-[#1d2733] ${FOCUS}`}>
              Owner portal
            </a>
          </div>
          <a href="/scan" className={`rounded-[6px] text-[14px] text-[#0369a1] underline-offset-2 hover:underline ${FOCUS}`}>
            Back to the map
          </a>
        </div>
      </header>
      {children}
    </div>
  );
}

export default function OwnerLayout({ children }: { children: ReactNode }) {
  if (!clerkConfigured()) return <Chrome>{children}</Chrome>;
  return (
    <ClerkProvider
      signInUrl={OWNER_SIGN_IN_PATH}
      signUpUrl={OWNER_SIGN_UP_PATH}
      signInFallbackRedirectUrl={OWNER_HOME_PATH}
      signUpFallbackRedirectUrl={OWNER_HOME_PATH}
      appearance={{
        variables: {
          colorPrimary: "#0ea5e9",
          colorPrimaryForeground: "#1d2733",
          colorForeground: "#1d2733",
          colorMutedForeground: "#556070",
          colorBackground: "#ffffff",
          colorBorder: "#e6e9ee",
          borderRadius: "6px",
          fontFamily: 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif',
        },
      }}
    >
      <Chrome>{children}</Chrome>
    </ClerkProvider>
  );
}
