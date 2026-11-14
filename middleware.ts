import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextMiddleware, type NextRequest } from "next/server";
import { clerkConfigured } from "@/lib/owner/config";

/*
 * Clerk runs only for the owner portal: /owner(.*) and /api/owner(.*) (see `matcher`).
 * The team app at "/" and the public scan app at "/scan" never reach this file.
 *
 * Not configured mode: with no Clerk keys, requests pass through untouched (Clerk is
 * never constructed, so it cannot throw or start keyless mode). Owner pages then show
 * setup steps and /api/owner/* answers 503 { error: "not_configured" }.
 *
 * Access checks live in each route handler and page (auth() from @clerk/nextjs/server),
 * not in path matching here: createRouteMatcher is deprecated in @clerk/nextjs 7.
 */

let clerk: NextMiddleware | null = null;

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  if (!clerkConfigured()) return NextResponse.next();
  clerk ??= clerkMiddleware();
  return clerk(req, event);
}

export const config = {
  matcher: ["/owner", "/owner/:path*", "/api/owner", "/api/owner/:path*"],
};
