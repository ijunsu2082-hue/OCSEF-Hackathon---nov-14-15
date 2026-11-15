/**
 * Watched grant sources, screened for one circle.
 *
 * `data/grants.json` is written by `npm run grants:sync` (research/etl/grants.ts):
 * every programme page in it was requested during that run and carries its HTTP
 * status, title and body fingerprint, and the Grants.gov listings come from one
 * saved search per lever. This module only reads that artifact and applies two
 * filters: the lever must be tagged on the source, and the source must cover the
 * circle's state. A programme that failed its watch is never offered.
 *
 * Screening only. None of this establishes eligibility — the notice does.
 */
import grantsJson from "../../data/grants.json";
import regionsJson from "../../data/regions.json";
import { haversineMi } from "./geo";

export interface GrantMatch {
  id: string;
  title: string;
  funder: string;
  url: string;
  /** Why this source matched: lever topic plus geography. */
  why: string;
  /** The next action, screened from public listing text only. */
  next: string;
  status: "open" | "forecasted" | "notice" | "program";
  /** ISO date the listing closes, when the feed published one. */
  deadline: string | null;
  checkedAt: string;
  source: "program" | "opportunity";
  /** Short label for where an opportunity came from. */
  via: string;
}

export interface GrantFeed {
  /** When the artifact's watch run finished. */
  checkedAt: string;
  /** Programme pages that answered during the run. */
  watched: number;
  /** Pages in the catalog, including ones that did not answer. */
  total: number;
  /** Listings kept across every aggregator. */
  listings: number;
  /** Aggregators watched during the run. */
  feeds: number;
  /** Aggregators that answered and passed their shape check. */
  feedsWatched: number;
}

interface Watch {
  status: "ok" | "unreachable" | "not_found";
  httpStatus: number | null;
  fingerprint: string | null;
  checkedAt: string;
  detail: string;
}

interface Program {
  id: string;
  title: string;
  funder: string;
  url: string;
  states: string[];
  levers: string[];
  kind: string;
  applicant: string;
  summary: string;
  watch: Watch;
}

interface Opportunity {
  id: string;
  title: string;
  url: string;
  agency: string;
  number: string;
  status: "open" | "forecasted" | "notice";
  openDate: string | null;
  closeDate: string | null;
  states: string[];
  levers: string[];
  source: string;
}

interface Feed {
  id: string;
  name: string;
  url: string;
  hitCount: number;
  kept: number;
  watch: Watch;
}

export interface GrantsArtifact {
  schema: string;
  generatedAt: string;
  programs: Program[];
  opportunities: Opportunity[];
  feeds: Feed[];
  searches: { keyword: string; hitCount: number; kept: number; detail: string }[];
}

const VIA: Record<string, string> = {
  "grants-gov": "Grants.gov",
  "federal-register": "Federal Register",
  "cec-solicitations": "CEC solicitation index",
};

const ARTIFACT = grantsJson as unknown as GrantsArtifact;

interface Region {
  id: string;
  name: string;
  state: string;
  center: [number, number];
  radius_miles: number;
}

const REGIONS = regionsJson as unknown as Region[];

/** The state of the region containing this point, or null outside every region. */
export function stateForArea(lat: number, lon: number): string | null {
  const hit = REGIONS.find((region) => haversineMi(lat, lon, region.center[0], region.center[1]) <= region.radius_miles);
  return hit?.state ?? null;
}

export function grantFeed(artifact: GrantsArtifact = ARTIFACT): GrantFeed {
  const feeds = artifact.feeds ?? [];
  return {
    checkedAt: artifact.generatedAt,
    watched: artifact.programs.filter((program) => program.watch.status === "ok").length,
    total: artifact.programs.length,
    listings: artifact.opportunities.length,
    feeds: feeds.length,
    feedsWatched: feeds.filter((feed) => feed.watch.status === "ok").length,
  };
}

const STATUS_ORDER: Record<GrantMatch["status"], number> = { open: 0, program: 1, notice: 2, forecasted: 3 };

/** Funding for one lever, from sources watched for this lever and this state. */
export function matchGrants(
  leverIds: string[],
  state: string | null,
  artifact: GrantsArtifact = ARTIFACT,
  limit = 4,
): GrantMatch[] {
  const levers = new Set(leverIds);
  if (!levers.size) return [];

  const programs: GrantMatch[] = artifact.programs
    .filter((program) => program.watch.status === "ok" && program.watch.fingerprint)
    .filter((program) => program.levers.some((lever) => levers.has(lever)))
    .filter((program) => program.states.length === 0 || (state !== null && program.states.includes(state)))
    .map((program) => ({
      id: program.id,
      title: program.title,
      funder: program.funder,
      url: program.url,
      why: `${program.summary} ${program.states.length ? `Covers ${program.states.join("/")} only.` : "National programme."}`,
      next: `Read the notice and confirm the applicant class: ${program.applicant}`,
      status: "program",
      deadline: null,
      checkedAt: program.watch.checkedAt,
      source: "program",
      via: program.funder,
    }));

  // Grants.gov results are national: the search API carries no geography, so the
  // notice decides. They are offered after a matching programme page.
  const opportunities: GrantMatch[] = artifact.opportunities
    .filter((opportunity) => opportunity.levers.some((lever) => levers.has(lever)))
    .filter((opportunity) => !opportunity.states?.length || (state !== null && opportunity.states.includes(state)))
    .map((opportunity) => ({
      id: opportunity.id,
      title: opportunity.title,
      funder: opportunity.agency,
      url: opportunity.url,
      why: opportunity.source === "cec-solicitations"
        ? "Listed on the California Energy Commission's solicitation index; California projects only."
        : opportunity.source === "federal-register"
          ? "Federal Register notice announcing funding; the notice carries the geography and eligibility."
          : `${VIA[opportunity.source] ?? "Aggregator"} ${opportunity.status === "open" ? "listing, currently open" : "forecast"}; geography is in the notice, not in the listing feed.`,
      next: `Open the ${VIA[opportunity.source] ?? "listing"} entry, confirm it covers ${state ?? "this area"}, and check eligibility: ${opportunity.number}.`,
      status: opportunity.status,
      deadline: opportunity.closeDate,
      checkedAt: artifact.generatedAt,
      source: "opportunity",
      via: VIA[opportunity.source] ?? "Aggregator",
    }));

  return [...programs, ...opportunities]
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"))
    .slice(0, limit);
}
