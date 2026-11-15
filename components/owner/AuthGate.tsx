"use client";

import type { ReactNode } from "react";
import { Show, SignInButton, UserButton } from "@clerk/nextjs";
import { PRIMARY } from "./ui";

/*
 * Signed-in / signed-out switch. Render ONLY when /api/owner/config says Clerk is
 * configured (the caller checks), so Clerk components never mount without a provider.
 * Clerk Core 3 (@clerk/nextjs 7) replaced <SignedIn>/<SignedOut> with <Show when=...>.
 */
export function AuthGate({
  children,
  signedOutText,
  returnTo,
}: {
  children: ReactNode;
  signedOutText: string;
  returnTo?: string;
}) {
  return (
    <>
      <Show when="signed-out">
        <section className="rounded-[6px] border border-[#e6e9ee] bg-white px-5 py-5">
          <p className="text-[15px] leading-relaxed text-[#1d2733]">{signedOutText}</p>
          <div className="mt-4">
            <SignInButton fallbackRedirectUrl={returnTo}>
              <button type="button" className={PRIMARY}>
                Sign in
              </button>
            </SignInButton>
          </div>
        </section>
      </Show>
      <Show when="signed-in">{children}</Show>
    </>
  );
}

/** Account menu for the page header. Same rule: only when Clerk is configured. */
export function AccountButton() {
  return (
    <Show when="signed-in">
      <UserButton />
    </Show>
  );
}
