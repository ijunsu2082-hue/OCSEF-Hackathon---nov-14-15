/**
 * Grants ETL.
 *
 * Two watched inputs, one reviewed artifact (`data/grants.json`):
 *
 *  1. A curated catalog of official program pages. Each run requests the page
 *     and records HTTP status, title and a body fingerprint. A program that
 *     stops answering is marked unreachable and the app stops showing it, so
 *     nothing is funded twice from a dead link.
 *  2. Grants.gov Search2, one saved keyword search per upgrade lever. Only hits
 *     whose title matches that lever's topic are kept; the rest is noise from
 *     keyword matching.
 *
 * The artifact records what was asked, when, and what came back. Nothing here
 * asserts eligibility: matching on lever and state is a screening filter, and
 * every screen says so.
 */
import { createHash } from "node:crypto";

export type LeverId =
  | "sunset-storage"
  | "weather-rating"
  | "hot-day-capacity"
  | "wildfire-hardening"
  | "retirement-gap"
  | "aging-fossil";

export interface GrantProgram {
  id: string;
  title: string;
  funder: string;
  url: string;
  /** ISO state codes; empty means national. */
  states: string[];
  levers: LeverId[];
  kind: "grant" | "loan" | "formula" | "tax_credit" | "technical";
  applicant: string;
  summary: string;
}

export interface WatchResult {
  status: "ok" | "unreachable" | "not_found";
  httpStatus: number | null;
  title: string | null;
  /** sha256 of the response body, so a changed page is visible between runs. */
  fingerprint: string | null;
  checkedAt: string;
  detail: string;
}

export interface WatchedProgram extends GrantProgram {
  watch: WatchResult;
}

export interface WatchedOpportunity {
  id: string;
  title: string;
  url: string;
  agency: string;
  number: string;
  status: "open" | "forecasted";
  openDate: string | null;
  closeDate: string | null;
  levers: LeverId[];
}

export interface GrantSearch {
  keyword: string;
  fundingCategory: string | null;
  hitCount: number;
  kept: number;
  detail: string;
}

export interface GrantsArtifact {
  schema: "mapergy.grants/1";
  generatedAt: string;
  programs: WatchedProgram[];
  opportunities: WatchedOpportunity[];
  searches: GrantSearch[];
}

export interface GrantsDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** Official program pages. Adding one is a reviewed change, like the source registry. */
export const GRANT_PROGRAMS: GrantProgram[] = [
  {
    id: "cec-deba",
    title: "CEC Distributed Electricity Backup Assets (GFO-26-503)",
    funder: "California Energy Commission",
    url: "https://www.energy.ca.gov/solicitations/2026-10/gfo-26-503-distributed-electricity-backup-assets-program-distributed-energy",
    states: ["CA"],
    levers: ["sunset-storage"],
    kind: "grant",
    applicant: "California public agencies and eligible project owners; confirm the applicant class in the notice.",
    summary: "Competitive California funding for distributed backup and storage assets that support grid reliability.",
  },
  {
    id: "cec-cerri",
    title: "CEC Community Energy Reliability and Resilience Investment (CERRI)",
    funder: "California Energy Commission",
    url: "https://www.energy.ca.gov/programs-and-topics/programs/community-energy-reliability-and-resilience-investment-cerri-program",
    states: ["CA"],
    levers: ["wildfire-hardening", "weather-rating", "hot-day-capacity"],
    kind: "grant",
    applicant: "California local governments and public agencies; solicitation terms control.",
    summary: "California grid hardening and community resilience funding for overhead and distribution work.",
  },
  {
    id: "doe-formula",
    title: "DOE Grid Resilience State and Tribal Formula Grants",
    funder: "U.S. Department of Energy",
    url: "https://www.energy.gov/oe/grid-resilience-state-and-tribal-formula-grants-program",
    states: [],
    levers: ["weather-rating", "hot-day-capacity", "wildfire-hardening", "retirement-gap", "aging-fossil"],
    kind: "formula",
    applicant: "States and Tribes apply; local projects reach the money through a state subaward.",
    summary: "Formula money allocated to states, then subawarded to local grid projects.",
  },
  {
    id: "doe-grip",
    title: "DOE Grid Resilience and Innovation Partnerships (GRIP)",
    funder: "U.S. Department of Energy",
    url: "https://www.energy.gov/oe/grid-resilience-and-innovation-partnerships-grip",
    states: [],
    levers: ["sunset-storage", "weather-rating", "hot-day-capacity"],
    kind: "grant",
    applicant: "Utilities, states, Tribes and project partners; topic areas change by funding round.",
    summary: "Federal cost-share for grid resilience, including storage and transmission capacity.",
  },
  {
    id: "fema-bric",
    title: "FEMA Building Resilient Infrastructure and Communities (BRIC)",
    funder: "Federal Emergency Management Agency",
    url: "https://www.fema.gov/grants/mitigation/learn/building-resilient-infrastructure-communities",
    states: [],
    levers: ["wildfire-hardening"],
    kind: "grant",
    applicant: "States, Tribes and local governments through the state hazard mitigation process.",
    summary: "Hazard mitigation funding that can cover utility hardening in exposed areas.",
  },
];

/** One saved search per lever topic; `accept` drops keyword noise from the results. */
export const LEVER_SEARCHES: Record<LeverId, { keyword: string; category: string | null; accept: RegExp }> = {
  "sunset-storage": { keyword: "energy storage", category: "EN", accept: /storage|batter/i },
  "weather-rating": { keyword: "transmission", category: "EN", accept: /transmission|dynamic line|grid (resilience|modernization|capacity)/i },
  "hot-day-capacity": { keyword: "transmission", category: "EN", accept: /transmission|dynamic line|grid (resilience|modernization|capacity)/i },
  "wildfire-hardening": { keyword: "wildfire", category: "EN", accept: /wildfire|fire (mitigation|risk)|grid (resilience|hardening)/i },
  "retirement-gap": { keyword: "grid reliability", category: "EN", accept: /generation (replacement|capacity)|retirement|grid (resilience|reliability)/i },
  "aging-fossil": { keyword: "grid reliability", category: "EN", accept: /generation (replacement|capacity)|retirement|grid (resilience|reliability)/i },
};

const GRANTS_SEARCH_URL = "https://api.grants.gov/v1/api/search2";
const GRANTS_DETAIL_URL = "https://www.grants.gov/search-results-detail/";
const ROWS_PER_SEARCH = 6;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

function decodeEntities(text: string): string {
  return text
    .replace(/&rsquo;|&lsquo;|&#39;|&apos;/g, "'")
    .replace(/&rdquo;|&ldquo;|&quot;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** "MM/DD/YYYY" as Grants.gov publishes it, else null. */
export function usDateToIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [, mm, dd, yyyy] = match;
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (date.getUTCFullYear() !== Number(yyyy) || date.getUTCMonth() !== Number(mm) - 1 || date.getUTCDate() !== Number(dd)) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function titleFromHtml(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return title ? decodeEntities(title).slice(0, 160) : null;
}

async function request(
  url: string,
  init: RequestInit,
  deps: Required<Pick<GrantsDeps, "fetch" | "timeoutMs">>,
): Promise<{ ok: true; status: number; body: string } | { ok: false; status: number | null; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const response = await deps.fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const body = await response.text();
    if (!response.ok) return { ok: false, status: response.status, reason: `upstream HTTP ${response.status}` };
    return { ok: true, status: response.status, body };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, status: null, reason: `timed out after ${deps.timeoutMs} ms` };
    return { ok: false, status: null, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function watchProgram(
  program: GrantProgram,
  deps: GrantsDeps = {},
): Promise<WatchedProgram> {
  const d: Required<GrantsDeps> = { fetch: deps.fetch ?? fetch, timeoutMs: deps.timeoutMs ?? 20_000, now: deps.now ?? (() => new Date()) };
  const checkedAt = d.now().toISOString();
  const result = await request(program.url, { method: "GET", headers: { Accept: "text/html,*/*" }, redirect: "follow" }, d);
  if (!result.ok) {
    return {
      ...program,
      watch: {
        status: result.status === 404 || result.status === 410 ? "not_found" : "unreachable",
        httpStatus: result.status,
        title: null,
        fingerprint: null,
        checkedAt,
        detail: `Watched ${program.url}: ${result.reason}. Program is withheld from funding matches until it answers.`,
      },
    };
  }
  const title = titleFromHtml(result.body);
  return {
    ...program,
    watch: {
      status: title ? "ok" : "unreachable",
      httpStatus: result.status,
      title,
      fingerprint: `sha256:${createHash("sha256").update(result.body).digest("hex").slice(0, 32)}`,
      checkedAt,
      detail: title
        ? `Watched ${program.url}: HTTP ${result.status}, title "${title}".`
        : `Watched ${program.url}: HTTP ${result.status} but no readable title; treated as unreachable.`,
    },
  };
}

export async function searchOpportunities(
  deps: GrantsDeps = {},
): Promise<{ opportunities: WatchedOpportunity[]; searches: GrantSearch[] }> {
  const d: Required<GrantsDeps> = { fetch: deps.fetch ?? fetch, timeoutMs: deps.timeoutMs ?? 20_000, now: deps.now ?? (() => new Date()) };

  // One request per distinct keyword/category, then reuse the hits across levers.
  const groups = new Map<string, { keyword: string; category: string | null; levers: LeverId[]; accept: RegExp }>();
  for (const [lever, spec] of Object.entries(LEVER_SEARCHES) as [LeverId, (typeof LEVER_SEARCHES)[LeverId]][]) {
    const key = `${spec.keyword}|${spec.category ?? ""}`;
    const group = groups.get(key);
    if (group) group.levers.push(lever);
    else groups.set(key, { keyword: spec.keyword, category: spec.category, levers: [lever], accept: spec.accept });
  }

  const searches: GrantSearch[] = [];
  const byId = new Map<string, WatchedOpportunity>();

  await Promise.all(
    [...groups.values()].map(async (group) => {
      const body = JSON.stringify({
        keyword: group.keyword,
        oppStatuses: "forecasted|posted",
        rows: ROWS_PER_SEARCH,
        // No orderBy/sortBy: Search2 answers those with an empty result set.
        ...(group.category ? { fundingCategories: group.category } : {}),
      });
      const result = await request(
        GRANTS_SEARCH_URL,
        { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body },
        d,
      );
      if (!result.ok) {
        searches.push({ keyword: group.keyword, fundingCategory: group.category, hitCount: 0, kept: 0, detail: `Search failed: ${result.reason}.` });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.body);
      } catch {
        searches.push({ keyword: group.keyword, fundingCategory: group.category, hitCount: 0, kept: 0, detail: "Search returned a non-JSON body." });
        return;
      }
      if (!isObj(parsed) || parsed.errorcode !== 0 || !isObj(parsed.data) || !Array.isArray(parsed.data.oppHits)) {
        searches.push({ keyword: group.keyword, fundingCategory: group.category, hitCount: 0, kept: 0, detail: "Search response did not match the Search2 shape." });
        return;
      }
      const hits = parsed.data.oppHits;
      const hitCount = typeof parsed.data.hitCount === "number" ? parsed.data.hitCount : hits.length;
      let kept = 0;
      for (const hit of hits) {
        if (!isObj(hit)) continue;
        const id = str(hit.id);
        const title = str(hit.title);
        const status = hit.oppStatus === "posted" ? "open" : hit.oppStatus === "forecasted" ? "forecasted" : null;
        if (!id || !/^\d+$/.test(id) || !title || !status) continue;
        const clean = decodeEntities(title);
        if (!group.accept.test(clean)) continue;
        const existing = byId.get(id);
        const levers = existing ? [...new Set([...existing.levers, ...group.levers])] : [...group.levers];
        byId.set(id, {
          id: `grants-gov-${id}`,
          title: clean,
          url: `${GRANTS_DETAIL_URL}${id}`,
          agency: str(hit.agency) ?? str(hit.agencyCode) ?? "Unknown agency",
          number: str(hit.number) ?? "unknown number",
          status,
          openDate: usDateToIso(hit.openDate),
          closeDate: usDateToIso(hit.closeDate),
          levers,
        });
        kept += 1;
      }
      searches.push({ keyword: group.keyword, fundingCategory: group.category, hitCount, kept, detail: `Kept ${kept} of ${hitCount} hits whose title matched the lever topic.` });
    }),
  );

  return {
    opportunities: [...byId.values()].sort((a, b) => (a.closeDate ?? "9999").localeCompare(b.closeDate ?? "9999")),
    searches: searches.sort((a, b) => a.keyword.localeCompare(b.keyword)),
  };
}

export async function syncGrants(deps: GrantsDeps = {}): Promise<GrantsArtifact> {
  const d: Required<GrantsDeps> = { fetch: deps.fetch ?? fetch, timeoutMs: deps.timeoutMs ?? 20_000, now: deps.now ?? (() => new Date()) };
  const generatedAt = d.now().toISOString();
  const [programs, searched] = await Promise.all([
    Promise.all(GRANT_PROGRAMS.map((program) => watchProgram(program, deps))),
    searchOpportunities(deps),
  ]);
  return {
    schema: "mapergy.grants/1",
    generatedAt,
    programs,
    opportunities: searched.opportunities,
    searches: searched.searches,
  };
}

/** A daily sync means anything older than this is not "watched" any more. */
export const DEFAULT_MAX_AGE_DAYS = 3;

export interface GrantsVerifyOptions {
  now?: Date;
  maxAgeDays?: number;
}

export interface GrantsVerification {
  programs: number;
  watched: number;
  unreachable: string[];
  opportunities: number;
  leversWithFunding: LeverId[];
  generatedAt: string;
  ageDays: number;
  maxAgeDays: number;
  stale: boolean;
  /** Failures that must stop a scheduled run; empty means the artifact passes. */
  problems: string[];
}

/** Structural and freshness check used after a sync and by `grants verify`. Throws on a broken artifact. */
export function verifyGrants(value: unknown, options: GrantsVerifyOptions = {}): GrantsVerification {
  if (!isObj(value) || value.schema !== "mapergy.grants/1") throw new Error("Not a mapergy.grants/1 artifact");
  if (!Array.isArray(value.programs) || !Array.isArray(value.opportunities) || !Array.isArray(value.searches)) {
    throw new Error("Artifact is missing programs, opportunities or searches");
  }
  const ids = new Set<string>();
  let watched = 0;
  const unreachable: string[] = [];
  for (const program of value.programs) {
    if (!isObj(program) || typeof program.id !== "string" || typeof program.url !== "string") throw new Error("Program entry is malformed");
    if (ids.has(program.id)) throw new Error(`Duplicate program ${program.id}`);
    ids.add(program.id);
    if (!Array.isArray(program.levers) || program.levers.length === 0) throw new Error(`${program.id} has no levers`);
    const watch = program.watch;
    if (!isObj(watch) || typeof watch.status !== "string" || typeof watch.checkedAt !== "string") {
      throw new Error(`${program.id} has no watch record`);
    }
    if (watch.status !== "ok") {
      unreachable.push(program.id);
      continue;
    }
    if (typeof watch.fingerprint !== "string" || !/^sha256:[0-9a-f]{32}$/.test(watch.fingerprint)) {
      throw new Error(`${program.id} is watched ok without a fingerprint`);
    }
    watched += 1;
  }
  for (const opportunity of value.opportunities) {
    if (!isObj(opportunity) || typeof opportunity.id !== "string" || typeof opportunity.title !== "string" || typeof opportunity.url !== "string") {
      throw new Error("Opportunity entry is malformed");
    }
    if (!Array.isArray(opportunity.levers) || opportunity.levers.length === 0) throw new Error(`${opportunity.id} has no levers`);
  }
  const funded = new Set<LeverId>();
  for (const program of value.programs) {
    if (!isObj(program) || !isObj(program.watch) || program.watch.status !== "ok") continue;
    for (const lever of program.levers as LeverId[]) funded.add(lever);
  }
  for (const opportunity of value.opportunities as { levers: LeverId[] }[]) {
    for (const lever of opportunity.levers) funded.add(lever);
  }

  const generatedRaw = typeof value.generatedAt === "string" ? value.generatedAt : "";
  const generated = new Date(generatedRaw);
  if (!generatedRaw || !Number.isFinite(generated.getTime())) {
    throw new Error("Artifact has no readable generatedAt");
  }
  const now = options.now ?? new Date();
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) throw new Error(`Invalid max age: ${maxAgeDays}`);
  const ageDays = Math.max(0, (now.getTime() - generated.getTime()) / 86_400_000);
  const stale = ageDays > maxAgeDays;

  const problems: string[] = [];
  if (stale) {
    problems.push(
      `Artifact is stale: watched ${ageDays.toFixed(1)} days ago (${generatedRaw}), limit ${maxAgeDays}. Run grants sync.`,
    );
  }
  if (unreachable.length) {
    problems.push(
      `${unreachable.length} programme${unreachable.length === 1 ? "" : "s"} did not answer the watch: ${unreachable.join(", ")}.`,
    );
  }

  return {
    programs: value.programs.length,
    watched,
    unreachable,
    opportunities: value.opportunities.length,
    leversWithFunding: [...funded].sort(),
    generatedAt: generatedRaw,
    ageDays: Number(ageDays.toFixed(2)),
    maxAgeDays,
    stale,
    problems,
  };
}
