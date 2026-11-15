/**
 * Grants ETL.
 *
 * Four watched inputs, one reviewed artifact (`data/grants.json`):
 *
 *  1. A curated catalog of official program pages. Each run requests the page
 *     and records HTTP status, title and a body fingerprint. A program that
 *     stops answering is marked unreachable and the app stops showing it, so
 *     nothing is funded twice from a dead link.
 *  2. Grants.gov Search2, one saved keyword search per upgrade lever. Only hits
 *     whose title matches that lever's topic are kept; the rest is noise from
 *     keyword matching.
 *  3. Federal Register notices from DOE, FEMA, EPA and USDA, filtered to the
 *     notices that announce money (NOFO, funding availability, solicitation).
 *  4. The California Energy Commission's solicitation index, which is where the
 *     state's energy money actually opens.
 *
 * Every feed carries its own watch record, so an aggregator that breaks is a
 * failed verification rather than a quietly empty list.
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

export type FeedId = "grants-gov" | "federal-register" | "cec-solicitations";

export interface WatchedOpportunity {
  id: string;
  title: string;
  url: string;
  agency: string;
  number: string;
  status: "open" | "forecasted" | "notice";
  openDate: string | null;
  closeDate: string | null;
  /** ISO state codes; empty means the feed carries no usable geography. */
  states: string[];
  levers: LeverId[];
  source: FeedId;
}

export interface WatchedFeed {
  id: FeedId;
  name: string;
  url: string;
  /** Rows the feed returned before the topic filter. */
  hitCount: number;
  kept: number;
  watch: WatchResult;
}

export interface GrantSearch {
  keyword: string;
  fundingCategory: string | null;
  hitCount: number;
  kept: number;
  detail: string;
}

export interface GrantsArtifact {
  schema: "mapergy.grants/2";
  generatedAt: string;
  programs: WatchedProgram[];
  opportunities: WatchedOpportunity[];
  feeds: WatchedFeed[];
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

/** One saved search per lever topic; the title screen decides what is kept. */
export const LEVER_SEARCHES: Record<LeverId, { keyword: string; category: string | null }> = {
  "sunset-storage": { keyword: "energy storage", category: "EN" },
  "weather-rating": { keyword: "transmission", category: "EN" },
  "hot-day-capacity": { keyword: "transmission", category: "EN" },
  "wildfire-hardening": { keyword: "wildfire", category: "EN" },
  "retirement-gap": { keyword: "grid reliability", category: "EN" },
  "aging-fossil": { keyword: "grid reliability", category: "EN" },
};

/**
 * Shared title screen for the aggregators that return prose titles, not tags.
 *
 * Each rule names the thing the money buys, and only that. Generic words such as
 * "reliability", "resilience" or "grid" are deliberately absent: a storage award
 * written "for grid reliability" funds storage, not retirement or gas upkeep.
 */
const TOPIC_LEVERS: { levers: LeverId[]; pattern: RegExp }[] = [
  { levers: ["sunset-storage"], pattern: /storage|batter(y|ies)|backup asset|standby|long-duration|pumped (hydro|storage)/i },
  { levers: ["weather-rating", "hot-day-capacity"], pattern: /transmission|line rating|dynamic line|ambient.adjusted|reconductor|substation|grid (capacity|modernization)/i },
  { levers: ["wildfire-hardening"], pattern: /wildfire|fire (mitigation|risk|threat)|covered conductor|vegetation management/i },
  { levers: ["retirement-gap"], pattern: /retirement|retiring|repowering|generation (replacement|capacity)/i },
  { levers: ["aging-fossil"], pattern: /heat rate|condition assessment|fossil|gas turbine|combustion turbine/i },
];

export function leversForTitle(title: string): LeverId[] {
  return [...new Set(TOPIC_LEVERS.filter((topic) => topic.pattern.test(title)).flatMap((topic) => topic.levers))];
}

/** Titles that announce money rather than a study or a rule. */
const MONEY_TITLE = /funding opportunit|notice of funding|funding availability|solicitation|grant (program|opportunit|notice)|request for applications|notice of intent to fund/i;

const GRANTS_SEARCH_URL = "https://api.grants.gov/v1/api/search2";
const GRANTS_DETAIL_URL = "https://www.grants.gov/search-results-detail/";
const GRANTS_ORIGINS = ["https://api.grants.gov"] as const;
const FEDERAL_REGISTER_ORIGINS = ["https://www.federalregister.gov"] as const;
const CEC_ORIGINS = ["https://www.energy.ca.gov"] as const;
const PROGRAM_ORIGINS = ["https://www.energy.ca.gov", "https://www.energy.gov", "https://www.fema.gov"] as const;
const ROWS_PER_SEARCH = 6;
const MAX_JSON_BYTES = 2_000_000;
const MAX_HTML_BYTES = 4_000_000;
const MAX_REDIRECTS = 3;

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

function cleanProviderText(value: unknown, maxLength: number): string | null {
  const raw = str(value);
  if (raw === null) return null;
  const clean = decodeEntities(raw).replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, maxLength) : null;
}

function checkedUrl(input: string, base: string | undefined, allowedOrigins: readonly string[]): URL {
  let url: URL;
  try { url = base ? new URL(input, base) : new URL(input); }
  catch { throw new Error("upstream supplied an invalid URL"); }
  if (url.protocol !== "https:" || !allowedOrigins.includes(url.origin) || url.username || url.password || url.port || url.hash) {
    throw new Error("upstream URL is outside the allowed official origins");
  }
  return url;
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error("upstream response exceeded size limit");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("upstream response exceeded size limit");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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

/** Grants.gov publishes MM/DD/YYYY; the Federal Register publishes ISO dates. */
export function dateToIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return usDateToIso(text);
}

function titleFromHtml(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return cleanProviderText(match?.[1], 160);
}

async function request(
  url: string,
  init: RequestInit,
  deps: Required<Pick<GrantsDeps, "fetch" | "timeoutMs">>,
  allowedOrigins: readonly string[],
  maxBytes: number,
): Promise<{ ok: true; status: number; body: string } | { ok: false; status: number | null; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    let current = checkedUrl(url, undefined, allowedOrigins);
    for (let redirects = 0; ; redirects++) {
      const response = await deps.fetch(current.toString(), { ...init, redirect: "manual", signal: controller.signal, cache: "no-store" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects >= MAX_REDIRECTS || init.method?.toUpperCase() === "POST") {
          return { ok: false, status: response.status, reason: "upstream redirect was missing, excessive, or unsafe for this request" };
        }
        current = checkedUrl(location, current.toString(), allowedOrigins);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, status: response.status, reason: `upstream HTTP ${response.status}` };
      }
      return { ok: true, status: response.status, body: await readBounded(response, maxBytes) };
    }
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, status: null, reason: `timed out after ${deps.timeoutMs} ms` };
    return { ok: false, status: null, reason: error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 240) : "upstream request failed" };
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
  let programOrigin: string;
  try { programOrigin = new URL(program.url).origin; } catch { programOrigin = ""; }
  const allowedOrigins = PROGRAM_ORIGINS.filter((origin) => origin === programOrigin);
  const result = await request(program.url, { method: "GET", headers: { Accept: "text/html,*/*" } }, d, allowedOrigins, MAX_HTML_BYTES);
  if (!result.ok) {
    return {
      ...program,
      watch: {
        status: result.status === 404 || result.status === 410 ? "not_found" : "unreachable",
        httpStatus: result.status,
        title: null,
        fingerprint: null,
        checkedAt,
        detail: `Watched approved program page: ${result.reason}. Program is withheld from funding matches until it answers.`,
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
        ? `Watched approved program page: HTTP ${result.status}, title "${title}".`
        : `Watched approved program page: HTTP ${result.status} but no readable title; treated as unreachable.`,
    },
  };
}

export async function searchOpportunities(
  deps: GrantsDeps = {},
): Promise<{ opportunities: WatchedOpportunity[]; searches: GrantSearch[]; feed: WatchedFeed }> {
  const d: Required<GrantsDeps> = { fetch: deps.fetch ?? fetch, timeoutMs: deps.timeoutMs ?? 20_000, now: deps.now ?? (() => new Date()) };

  // One request per distinct keyword/category, then reuse the hits across levers.
  const groups = new Map<string, { keyword: string; category: string | null; levers: LeverId[] }>();
  for (const [lever, spec] of Object.entries(LEVER_SEARCHES) as [LeverId, (typeof LEVER_SEARCHES)[LeverId]][]) {
    const key = `${spec.keyword}|${spec.category ?? ""}`;
    const group = groups.get(key);
    if (group) group.levers.push(lever);
    else groups.set(key, { keyword: spec.keyword, category: spec.category, levers: [lever] });
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
        GRANTS_ORIGINS,
        MAX_JSON_BYTES,
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
      const hitCount = parsed.data.hitCount;
      if (hits.length > ROWS_PER_SEARCH || typeof hitCount !== "number" || !Number.isSafeInteger(hitCount) || hitCount < hits.length || hitCount > 1_000_000) {
        searches.push({ keyword: group.keyword, fundingCategory: group.category, hitCount: 0, kept: 0, detail: "Search response did not match the Search2 bounds." });
        return;
      }
      let kept = 0;
      for (const hit of hits) {
        if (!isObj(hit)) continue;
        const id = str(hit.id);
        const title = cleanProviderText(hit.title, 240);
        const status = hit.oppStatus === "posted" ? "open" : hit.oppStatus === "forecasted" ? "forecasted" : null;
        if (!id || !/^\d{1,20}$/.test(id) || !title || !status) continue;
        const clean = title;
        // Same subject screen as the other aggregators: the title must name what
        // the money buys, not merely repeat the search keyword.
        const levers = leversForTitle(clean).filter((lever) => group.levers.includes(lever));
        if (!levers.length) continue;
        const existing = byId.get(id);
        const merged = existing ? [...new Set([...existing.levers, ...levers])] : levers;
        byId.set(id, {
          id: `grants-gov-${id}`,
          title: clean,
          url: `${GRANTS_DETAIL_URL}${id}`,
          agency: cleanProviderText(hit.agency, 120) ?? cleanProviderText(hit.agencyCode, 80) ?? "Unknown agency",
          number: cleanProviderText(hit.number, 80) ?? "unknown number",
          status,
          openDate: usDateToIso(hit.openDate),
          closeDate: usDateToIso(hit.closeDate),
          states: [],
          levers: merged,
          source: "grants-gov",
        });
        kept += 1;
      }
      searches.push({ keyword: group.keyword, fundingCategory: group.category, hitCount, kept, detail: `Kept ${kept} of ${hitCount} hits whose title matched the lever topic.` });
    }),
  );

  const opportunities = [...byId.values()].sort((a, b) => (a.closeDate ?? "9999").localeCompare(b.closeDate ?? "9999"));
  const failures = searches.filter((search) => /^Search failed|non-JSON|did not match/.test(search.detail));
  const feed: WatchedFeed = {
    id: "grants-gov",
    name: "Grants.gov Search2",
    url: GRANTS_SEARCH_URL,
    hitCount: searches.reduce((sum, search) => sum + search.hitCount, 0),
    kept: opportunities.length,
    watch: {
      status: failures.length ? "unreachable" : "ok",
      httpStatus: failures.length ? null : 200,
      title: null,
      fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(opportunities)).digest("hex").slice(0, 32)}`,
      checkedAt: d.now().toISOString(),
      detail: failures.length
        ? `${failures.length} of ${searches.length} saved searches failed: ${failures.map((search) => `${search.keyword} (${search.detail})`).join("; ")}`
        : `${searches.length} saved searches answered; ${opportunities.length} kept.`,
    },
  };
  return { opportunities, searches: searches.sort((a, b) => a.keyword.localeCompare(b.keyword)), feed };
}

const FEDERAL_REGISTER_URL = "https://www.federalregister.gov/api/v1/documents.json";
const CEC_SOLICITATIONS_URL = "https://www.energy.ca.gov/funding-opportunities/solicitations";

const FEDERAL_REGISTER_AGENCIES = [
  "energy-department",
  "federal-emergency-management-agency",
  "environmental-protection-agency",
  "agriculture-department",
];

/** Notices of funding from four federal agencies, screened to money announcements. */
export async function federalRegisterOpportunities(
  deps: GrantsDeps = {},
): Promise<{ opportunities: WatchedOpportunity[]; feed: WatchedFeed }> {
  const d: Required<GrantsDeps> = { fetch: deps.fetch ?? fetch, timeoutMs: deps.timeoutMs ?? 20_000, now: deps.now ?? (() => new Date()) };
  const params = new URLSearchParams();
  params.set("per_page", "100");
  params.set("order", "newest");
  params.set("conditions[term]", "funding");
  params.set("conditions[type][]", "NOTICE");
  for (const agency of FEDERAL_REGISTER_AGENCIES) params.append("conditions[agencies][]", agency);
  const url = `${FEDERAL_REGISTER_URL}?${params.toString()}`;
  const checkedAt = d.now().toISOString();
  const result = await request(url, { method: "GET", headers: { Accept: "application/json" } }, d, FEDERAL_REGISTER_ORIGINS, MAX_JSON_BYTES);

  const feed = (opportunities: WatchedOpportunity[], considered: number): WatchedFeed => ({
    id: "federal-register",
    name: "Federal Register notices",
    url,
    hitCount: considered,
    kept: opportunities.length,
    watch: {
      status: "ok",
      httpStatus: 200,
      title: null,
      fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(opportunities)).digest("hex").slice(0, 32)}`,
      checkedAt,
      detail: `Federal Register returned ${considered} notices; ${opportunities.length} matched a lever.`,
    },
  });

  if (!result.ok) {
    return {
      opportunities: [],
      feed: {
        id: "federal-register", name: "Federal Register notices", url, hitCount: 0, kept: 0,
        watch: { status: "unreachable", httpStatus: result.status, title: null, fingerprint: null, checkedAt, detail: `Federal Register: ${result.reason}.` },
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    return {
      opportunities: [],
      feed: {
        id: "federal-register", name: "Federal Register notices", url, hitCount: 0, kept: 0,
        watch: { status: "unreachable", httpStatus: 200, title: null, fingerprint: null, checkedAt, detail: "Federal Register returned a non-JSON body." },
      },
    };
  }
  if (!isObj(parsed) || !Array.isArray(parsed.results) || parsed.results.length > 100) {
    return {
      opportunities: [],
      feed: {
        id: "federal-register", name: "Federal Register notices", url, hitCount: 0, kept: 0,
        watch: { status: "unreachable", httpStatus: 200, title: null, fingerprint: null, checkedAt, detail: "Federal Register response did not match the documents shape." },
      },
    };
  }

  const opportunities: WatchedOpportunity[] = [];
  for (const row of parsed.results) {
    if (!isObj(row)) continue;
    const clean = cleanProviderText(row.title, 240);
    const rawLink = str(row.html_url);
    const number = cleanProviderText(row.document_number, 40);
    if (!clean || !rawLink || !number || !/^\d{4}-\d{1,8}$/.test(number)) continue;
    let link: string;
    try {
      const safeLink = checkedUrl(rawLink, undefined, FEDERAL_REGISTER_ORIGINS);
      if (safeLink.search || !/^\/documents\/\d{4}\/\d{2}\/\d{2}\/\d{4}-\d{1,8}\/[a-z0-9-]+$/i.test(safeLink.pathname)) continue;
      link = safeLink.toString();
    } catch { continue; }
    if (!MONEY_TITLE.test(clean)) continue;
    const levers = leversForTitle(clean);
    if (!levers.length) continue;
    const agencyList = Array.isArray(row.agencies) ? row.agencies.slice(0, 10) : [];
    const agency = agencyList.map((entry) => isObj(entry) ? cleanProviderText(entry.name, 120) : null)
      .find((name): name is string => !!name && ["Department of Energy", "Federal Emergency Management Agency", "Environmental Protection Agency", "Department of Agriculture"].includes(name))
      ?? "Federal Register notice";
    opportunities.push({
      id: `fr-${number}`,
      title: clean,
      url: link,
      agency,
      number,
      status: "notice",
      openDate: dateToIso(row.publication_date),
      closeDate: null,
      states: [],
      levers,
      source: "federal-register",
    });
  }
  const kept = opportunities.slice(0, 12);
  return { opportunities: kept, feed: feed(kept, parsed.results.length) };
}

/** The CEC solicitation index: the list the state's energy money opens on. */
export async function cecSolicitations(
  deps: GrantsDeps = {},
): Promise<{ opportunities: WatchedOpportunity[]; feed: WatchedFeed }> {
  const d: Required<GrantsDeps> = { fetch: deps.fetch ?? fetch, timeoutMs: deps.timeoutMs ?? 20_000, now: deps.now ?? (() => new Date()) };
  const checkedAt = d.now().toISOString();
  const result = await request(CEC_SOLICITATIONS_URL, { method: "GET", headers: { Accept: "text/html" } }, d, CEC_ORIGINS, MAX_HTML_BYTES);
  const fail = (status: WatchResult["status"], detail: string, httpStatus: number | null): { opportunities: WatchedOpportunity[]; feed: WatchedFeed } => ({
    opportunities: [],
    feed: {
      id: "cec-solicitations", name: "CEC solicitation index", url: CEC_SOLICITATIONS_URL, hitCount: 0, kept: 0,
      watch: { status, httpStatus, title: null, fingerprint: null, checkedAt, detail },
    },
  });
  if (!result.ok) return fail(result.status === 404 ? "not_found" : "unreachable", `CEC solicitations: ${result.reason}.`, result.status);

  const cards: { url: string; title: string }[] = [];
  const pattern = /href="(\/solicitations\/[^"?]+)"[\s\S]{0,500}?itemprop="name">([\s\S]*?)<\/h3>/g;
  for (const match of result.body.matchAll(pattern)) {
    const title = cleanProviderText(match[2], 240);
    if (!title) continue;
    let link: string;
    try {
      const safeLink = checkedUrl(match[1], "https://www.energy.ca.gov", CEC_ORIGINS);
      if (!/^\/solicitations\/[a-z0-9-]+\/[a-z0-9-]+$/i.test(safeLink.pathname)) continue;
      link = safeLink.toString();
    } catch { continue; }
    if (cards.some((card) => card.url === link)) continue;
    cards.push({ url: link, title });
    if (cards.length > 200) return fail("unreachable", "CEC solicitations page returned too many solicitation cards; response was rejected.", result.status);
  }
  if (!cards.length) return fail("unreachable", "CEC solicitations page answered but no solicitation cards parsed; the page layout may have changed.", result.status);

  const opportunities: WatchedOpportunity[] = [];
  for (const card of cards) {
    const levers = leversForTitle(card.title);
    if (!levers.length) continue;
    const id = /\/(gfo|rfp|rfq|ifb)-([0-9]{2}-[0-9]{3})(?:-|$)/i.exec(card.url);
    opportunities.push({
      id: `cec-${id ? `${id[1]}-${id[2]}`.toUpperCase() : card.url.split("/").pop()}`,
      title: card.title,
      url: card.url,
      agency: "California Energy Commission",
      number: id ? `${id[1]}-${id[2]}`.toUpperCase() : "solicitation",
      status: "open",
      openDate: null,
      closeDate: null,
      states: ["CA"],
      levers,
      source: "cec-solicitations",
    });
  }
  return {
    opportunities,
    feed: {
      id: "cec-solicitations", name: "CEC solicitation index", url: CEC_SOLICITATIONS_URL,
      hitCount: cards.length, kept: opportunities.length,
      watch: {
        status: "ok", httpStatus: 200, title: null,
        fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(cards)).digest("hex").slice(0, 32)}`,
        checkedAt,
        detail: `CEC listed ${cards.length} solicitations; ${opportunities.length} matched a lever.`,
      },
    },
  };
}

export async function syncGrants(deps: GrantsDeps = {}): Promise<GrantsArtifact> {
  const d: Required<GrantsDeps> = { fetch: deps.fetch ?? fetch, timeoutMs: deps.timeoutMs ?? 20_000, now: deps.now ?? (() => new Date()) };
  const generatedAt = d.now().toISOString();
  const [programs, searched, federal, cec] = await Promise.all([
    Promise.all(GRANT_PROGRAMS.map((program) => watchProgram(program, deps))),
    searchOpportunities(deps),
    federalRegisterOpportunities(deps),
    cecSolicitations(deps),
  ]);
  return {
    schema: "mapergy.grants/2",
    generatedAt,
    programs,
    opportunities: [...searched.opportunities, ...federal.opportunities, ...cec.opportunities],
    feeds: [searched.feed, federal.feed, cec.feed],
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
  feeds: number;
  unreachableFeeds: string[];
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
  if (!isObj(value) || value.schema !== "mapergy.grants/2") throw new Error("Not a mapergy.grants/2 artifact");
  if (!Array.isArray(value.programs) || !Array.isArray(value.opportunities) || !Array.isArray(value.searches) || !Array.isArray(value.feeds)) {
    throw new Error("Artifact is missing programs, opportunities, feeds or searches");
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
  const feedIds = new Set<string>();
  const unreachableFeeds: string[] = [];
  for (const feed of value.feeds) {
    if (!isObj(feed) || typeof feed.id !== "string" || typeof feed.name !== "string" || typeof feed.url !== "string") {
      throw new Error("Feed entry is malformed");
    }
    if (feedIds.has(feed.id)) throw new Error(`Duplicate feed ${feed.id}`);
    feedIds.add(feed.id);
    const watch = feed.watch;
    if (!isObj(watch) || typeof watch.status !== "string" || typeof watch.checkedAt !== "string") {
      throw new Error(`${feed.id} has no watch record`);
    }
    if (watch.status !== "ok") {
      unreachableFeeds.push(feed.id);
      continue;
    }
    if (typeof watch.fingerprint !== "string" || !/^sha256:[0-9a-f]{32}$/.test(watch.fingerprint)) {
      throw new Error(`${feed.id} is watched ok without a fingerprint`);
    }
  }
  for (const opportunity of value.opportunities) {
    if (!isObj(opportunity) || typeof opportunity.id !== "string" || typeof opportunity.title !== "string" || typeof opportunity.url !== "string") {
      throw new Error("Opportunity entry is malformed");
    }
    if (!Array.isArray(opportunity.levers) || opportunity.levers.length === 0) throw new Error(`${opportunity.id} has no levers`);
    if (typeof opportunity.source !== "string" || !feedIds.has(opportunity.source)) {
      throw new Error(`${opportunity.id} comes from an unknown feed`);
    }
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
  if (unreachableFeeds.length) {
    problems.push(
      `${unreachableFeeds.length} aggregator${unreachableFeeds.length === 1 ? "" : "s"} did not answer: ${unreachableFeeds.join(", ")}.`,
    );
  }

  return {
    programs: value.programs.length,
    watched,
    unreachable,
    feeds: value.feeds.length,
    unreachableFeeds,
    opportunities: value.opportunities.length,
    leversWithFunding: [...funded].sort(),
    generatedAt: generatedRaw,
    ageDays: Number(ageDays.toFixed(2)),
    maxAgeDays,
    stale,
    problems,
  };
}
