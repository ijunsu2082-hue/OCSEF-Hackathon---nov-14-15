/**
 * Owner portal shared contract (frozen). Owners of infrastructure sign in (Clerk),
 * claim an asset, get verified, and then see the filings they must make, with due dates
 * and fields prefilled from public data. Data lives in Supabase.
 *
 * Writers:
 *   lib/owner/obligations.ts  (engine: what must be filed, when, with what prefill)
 *   lib/owner/db.ts, lib/owner/verify.ts, app/api/owner/**  (auth, storage, verification)
 *   components/owner/**, app/owner/**  (screens)
 */
import type { Line, Plant, Substation } from "@/lib/scan/types";

/* ---- assets -------------------------------------------------------------- */

export type AssetKind = "plant" | "substation" | "line";

/** Stable id: plant -> String(plant_code) (EIA plant code); substation -> osm_id; line -> String(osm_id). */
export type AssetRef = { kind: AssetKind; id: string };

export type OwnedAsset =
  | { kind: "plant"; plant: Plant }
  | { kind: "substation"; substation: Substation }
  | { kind: "line"; line: Line };

/* ---- obligations (pure engine) -------------------------------------------- */

export type Frequency = "monthly" | "quarterly" | "semiannual" | "annual" | "event" | "once";

export interface Citation {
  label: string; // e.g. "CARB Mandatory GHG Reporting, 17 CCR 95103"
  url: string; // official source
}

export interface PrefillField {
  label: string; // e.g. "EIA plant code"
  value: string; // e.g. "335"
  source: string; // e.g. "EIA-860 2025"
}

export interface Obligation {
  id: string; // stable, e.g. "eia-923-annual"
  title: string; // plain words, e.g. "Annual power plant operations report"
  agency: string; // e.g. "U.S. Energy Information Administration (EIA)"
  form: string; // e.g. "Form EIA-923"
  formUrl: string; // official form / filing portal page
  appliesBecause: string; // why this owner must file, from the asset's real data
  frequency: Frequency;
  dueRule: string; // plain-language rule, e.g. "By the last day of February for the prior year"
  citations: Citation[];
  prefill: PrefillField[];
  confidence: "verified" | "check"; // "check" = depends on facts we can't see (size thresholds, permits)
  notes?: string;
}

export interface Deadline {
  obligationId: string;
  due: string; // ISO date YYYY-MM-DD
  periodLabel: string; // e.g. "Q3 2026" or "Calendar year 2026"
}

/* ---- claims and verification (Supabase) ----------------------------------- */

export type ClaimStatus = "pending" | "verified" | "rejected";

/** email_domain: Clerk-verified work email on the owner's official domain (auto).
 *  document: owner uploads proof (e.g. EIA filing confirmation, interconnection agreement,
 *  letterhead authorization) and an admin reviews it. */
export type VerifyMethod = "email_domain" | "document";

export interface Claim {
  id: string;
  user_id: string; // Clerk user id
  asset_kind: AssetKind;
  asset_id: string;
  asset_name: string;
  owner_name: string; // organization the claimant says owns it (e.g. EIA utility_name / OSM operator)
  method: VerifyMethod;
  status: ClaimStatus;
  evidence_path: string | null; // Supabase Storage path for documents
  note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  created_at: string;
}

export type TaskStatus = "not_started" | "in_progress" | "filed";

export interface Task {
  id: string;
  claim_id: string;
  obligation_id: string;
  due: string; // ISO date
  status: TaskStatus;
  filed_at: string | null;
  confirmation: string | null; // filing confirmation number
  note: string | null;
  updated_at: string;
}

/* ---- API (Next route handlers under app/api/owner) ------------------------ */
// GET    /api/owner/claims                       -> { claims: Claim[] }            (signed-in user's claims)
// POST   /api/owner/claims                       body { asset: AssetRef; asset_name; owner_name; method: VerifyMethod; note? }
//                                                -> { claim: Claim }               (email_domain may come back already "verified")
// POST   /api/owner/claims/:id/evidence          multipart file "file"             -> { claim: Claim }
// GET    /api/owner/tasks?claim_id=              -> { tasks: Task[] }
// PUT    /api/owner/tasks                        body { claim_id; obligation_id; due; status; confirmation?; note? } -> { task: Task }
// GET    /api/owner/admin/claims?status=pending  -> { claims: Claim[] }            (admins only)
// POST   /api/owner/admin/claims/:id             body { decision: "verified" | "rejected"; reason? } -> { claim: Claim }
// GET    /api/owner/config                       -> { clerk: boolean; supabase: boolean } (what is configured; no secrets)
