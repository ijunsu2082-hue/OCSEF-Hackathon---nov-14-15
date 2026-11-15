import { test } from "node:test";
import assert from "node:assert/strict";
import {
  watchProgram,
  searchOpportunities,
  federalRegisterOpportunities,
  cecSolicitations,
  leversForTitle,
  verifyGrants,
  type GrantProgram,
} from "../research/etl/grants";
import { matchGrants, grantFeed, type GrantsArtifact } from "../lib/scan/grants";

const PROGRAM: GrantProgram = {
  id: "p1",
  title: "Programme one",
  funder: "Agency",
  url: "https://www.energy.gov/oe/grid-resilience-state-and-tribal-formula-grants-program",
  states: [],
  levers: ["weather-rating"],
  kind: "grant",
  applicant: "Public agencies.",
  summary: "Test programme.",
};

const responder = (map: Record<string, () => Response>) =>
  (async (input: RequestInfo | URL) => {
    const url = String(input);
    const handler = map[url];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler();
  }) as typeof fetch;

test("watchProgram records status, title and fingerprint; fails closed", async () => {
  const ok = await watchProgram(PROGRAM, {
    fetch: responder({ [PROGRAM.url]: () => new Response("<html><title>Grid &amp; Storage</title></html>", { status: 200 }) }),
    now: () => new Date("2026-11-15T00:00:00Z"),
  });
  assert.equal(ok.watch.status, "ok");
  assert.equal(ok.watch.title, "Grid & Storage");
  assert.match(ok.watch.fingerprint ?? "", /^sha256:[0-9a-f]{32}$/);
  assert.equal(ok.watch.checkedAt, "2026-11-15T00:00:00.000Z");

  const missing = await watchProgram(PROGRAM, { fetch: responder({ [PROGRAM.url]: () => new Response("gone", { status: 404 }) }) });
  assert.equal(missing.watch.status, "not_found");
  assert.equal(missing.watch.fingerprint, null);

  const down = await watchProgram(PROGRAM, { fetch: responder({ [PROGRAM.url]: () => new Response("bad", { status: 503 }) }) });
  assert.equal(down.watch.status, "unreachable");
  assert.equal(down.watch.httpStatus, 503);

  const throwing = await watchProgram(PROGRAM, {
    fetch: (async () => { throw new Error("ENOTFOUND"); }) as typeof fetch,
  });
  assert.equal(throwing.watch.status, "unreachable");
  assert.match(throwing.watch.detail, /ENOTFOUND/);

  const noTitle = await watchProgram(PROGRAM, { fetch: responder({ [PROGRAM.url]: () => new Response("<html></html>", { status: 200 }) }) });
  assert.equal(noTitle.watch.status, "unreachable");
});

test("searchOpportunities keeps only topic-matching titles and maps dates", async () => {
  const payload = {
    errorcode: 0,
    data: {
      hitCount: 4,
      oppHits: [
        { id: "1", title: "Dynamic line rating &amp; transmission capacity", agency: "DOE", number: "DE-1", oppStatus: "posted", openDate: "01/05/2026", closeDate: "03/01/2026" },
        { id: "2", title: "Nuclear workforce scholarship", agency: "DOE", number: "DE-2", oppStatus: "posted", openDate: "01/05/2026", closeDate: "" },
        { id: "3", title: "Grid resilience planning grant", agency: "DOE", number: "DE-3", oppStatus: "forecasted", openDate: "", closeDate: "" },
        { id: "bad", title: "id is not numeric", agency: "DOE", number: "DE-4", oppStatus: "posted" },
      ],
    },
  };
  const result = await searchOpportunities({
    fetch: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
  });
  assert.equal(result.opportunities.length, 1, "a generic grid-resilience title must not be kept");
  const first = result.opportunities.find((item) => item.id === "grants-gov-1")!;
  assert.equal(first.title, "Dynamic line rating & transmission capacity");
  assert.equal(first.status, "open");
  assert.equal(first.closeDate, "2026-03-01");
  assert.equal(first.url, "https://www.grants.gov/search-results-detail/1");
  assert.ok(first.levers.includes("weather-rating") && first.levers.includes("hot-day-capacity"));
  assert.ok(result.searches.length >= 1);
  assert.ok(result.searches.every((search) => search.kept <= search.hitCount));
});

test("verifyGrants fails an artifact that outlived its watch, and honours the age limit", () => {
  const base = artifact();
  const fresh: GrantsArtifact = { ...base, programs: base.programs.filter((program) => program.id !== "dead-programme") };
  const at = (iso: string) => verifyGrants(fresh, { now: new Date(iso) });

  const today = at("2026-11-15T12:00:00Z");
  assert.equal(today.stale, false);
  assert.deepEqual(today.problems, []);
  assert.equal(today.maxAgeDays, 3);

  const late = at("2026-11-19T12:00:00Z");
  assert.equal(late.stale, true);
  assert.ok(late.ageDays > 4 && late.ageDays < 5);
  assert.match(late.problems[0], /Artifact is stale/);
  assert.match(late.problems[0], /Run grants sync/);

  const strict = verifyGrants(fresh, { now: new Date("2026-11-17T00:00:00Z"), maxAgeDays: 1 });
  assert.equal(strict.stale, true);
  assert.equal(strict.maxAgeDays, 1);

  assert.equal(verifyGrants(fresh, { now: new Date("2026-11-16T00:00:00Z"), maxAgeDays: 1 }).stale, false);
  assert.throws(() => verifyGrants({ ...fresh, generatedAt: "not a date" }), /generatedAt/);
  assert.throws(() => verifyGrants(fresh, { maxAgeDays: 0 }), /Invalid max age/);
});

test("verifyGrants reports unwatched programmes and aggregators, and rejects an ok watch without a fingerprint", () => {
  const artifact = {
    schema: "mapergy.grants/2",
    generatedAt: "2026-11-15T00:00:00.000Z",
    programs: [
      { ...PROGRAM, watch: { status: "ok", httpStatus: 200, title: "t", fingerprint: null, checkedAt: "2026-11-15T00:00:00.000Z", detail: "" } },
    ],
    opportunities: [],
    feeds: [{ id: "grants-gov", name: "Grants.gov Search2", url: "https://api.grants.gov/v1/api/search2", hitCount: 0, kept: 0, watch: OK_WATCH }],
    searches: [],
  };
  assert.throws(() => verifyGrants(artifact), /without a fingerprint/);

  const mixed = JSON.parse(JSON.stringify(artifact));
  mixed.programs[0].watch.fingerprint = "sha256:0123456789abcdef0123456789abcdef";
  mixed.programs.push({
    ...PROGRAM,
    id: "p2",
    url: "https://example.gov/two",
    watch: { status: "unreachable", httpStatus: null, title: null, fingerprint: null, checkedAt: "2026-11-15T00:00:00.000Z", detail: "down" },
  });
  mixed.feeds.push({
    id: "cec-solicitations", name: "CEC solicitation index", url: "https://www.energy.ca.gov/funding-opportunities/solicitations",
    hitCount: 0, kept: 0,
    watch: { status: "unreachable", httpStatus: 200, title: null, fingerprint: null, checkedAt: "2026-11-15T00:00:00.000Z", detail: "no cards" },
  });
  const report = verifyGrants(mixed);
  assert.equal(report.programs, 2);
  assert.equal(report.watched, 1);
  assert.deepEqual(report.unreachable, ["p2"]);
  assert.equal(report.feeds, 2);
  assert.deepEqual(report.unreachableFeeds, ["cec-solicitations"]);
  assert.deepEqual(report.leversWithFunding, ["weather-rating"]);
  assert.match(report.problems.join(" "), /p2/);
  assert.match(report.problems.join(" "), /aggregator did not answer: cec-solicitations/);
  assert.throws(() => verifyGrants({ schema: "other" }), /mapergy\.grants\/2/);
});

const OK_WATCH = { status: "ok" as const, httpStatus: 200, fingerprint: "sha256:0123456789abcdef0123456789abcdef", checkedAt: "2026-11-15T00:00:00.000Z", detail: "" };

function artifact(): GrantsArtifact {
  const watch = OK_WATCH;
  return {
    schema: "mapergy.grants/2",
    generatedAt: "2026-11-15T00:00:00.000Z",
    programs: [
      { ...PROGRAM, id: "ca-storage", states: ["CA"], levers: ["sunset-storage"], watch },
      { ...PROGRAM, id: "national-grid", states: [], levers: ["sunset-storage", "weather-rating"], watch },
      { ...PROGRAM, id: "dead-programme", states: ["CA"], levers: ["sunset-storage"], watch: { ...watch, status: "unreachable", fingerprint: null } },
    ],
    opportunities: [
      { id: "grants-gov-9", title: "Battery demonstration", url: "https://www.grants.gov/search-results-detail/9", agency: "DOE", number: "DE-9", status: "forecasted", openDate: null, closeDate: "2027-01-01", states: [], levers: ["sunset-storage"], source: "grants-gov" },
      { id: "grants-gov-8", title: "Storage deployment", url: "https://www.grants.gov/search-results-detail/8", agency: "DOE", number: "DE-8", status: "open", openDate: null, closeDate: "2026-12-01", states: [], levers: ["sunset-storage"], source: "grants-gov" },
      { id: "cec-GFO-26-503", title: "Backup assets", url: "https://www.energy.ca.gov/solicitations/gfo-26-503", agency: "California Energy Commission", number: "GFO-26-503", status: "open", openDate: null, closeDate: null, states: ["CA"], levers: ["sunset-storage"], source: "cec-solicitations" },
    ],
    feeds: [
      { id: "grants-gov", name: "Grants.gov Search2", url: "https://api.grants.gov/v1/api/search2", hitCount: 2, kept: 2, watch: watch },
      { id: "cec-solicitations", name: "CEC solicitation index", url: "https://www.energy.ca.gov/funding-opportunities/solicitations", hitCount: 3, kept: 1, watch: watch },
    ],
    searches: [],
  };
}

test("matchGrants filters by lever, state and watch status, then orders by availability", () => {
  const ca = matchGrants(["sunset-storage"], "CA", artifact());
  assert.deepEqual(ca.map((match) => match.id), ["grants-gov-8", "cec-GFO-26-503", "ca-storage", "national-grid"]);
  assert.deepEqual(ca.map((match) => match.status), ["open", "open", "program", "program"]);
  assert.equal(ca[0].deadline, "2026-12-01");
  assert.equal(ca[1].via, "CEC solicitation index");

  const nevada = matchGrants(["sunset-storage"], "NV", artifact());
  assert.deepEqual(nevada.map((match) => match.id), ["grants-gov-8", "national-grid", "grants-gov-9"]);

  const unknownState = matchGrants(["sunset-storage"], null, artifact());
  assert.deepEqual(unknownState.map((match) => match.id), ["grants-gov-8", "national-grid", "grants-gov-9"]);

  assert.equal(matchGrants([], "CA", artifact()).length, 0);
  assert.equal(matchGrants(["wildfire-hardening"], "CA", artifact()).length, 0);
  assert.equal(matchGrants(["sunset-storage"], "CA", artifact(), 1).length, 1);
});

test("grantFeed reports what the watch run covered", () => {
  const feed = grantFeed(artifact());
  assert.equal(feed.total, 3);
  assert.equal(feed.watched, 2);
  assert.equal(feed.listings, 3);
  assert.equal(feed.feeds, 2);
  assert.equal(feed.feedsWatched, 2);
  assert.equal(feed.checkedAt.slice(0, 10), "2026-11-15");
});

test("leversForTitle maps a listing only to what the money funds", () => {
  assert.deepEqual(leversForTitle("Energy Storage Deployment Grant"), ["sunset-storage"]);
  // Regression: GFO-26-503 says "for Grid Reliability" but funds storage only.
  assert.deepEqual(
    leversForTitle("GFO-26-503 - Distributed Electricity Backup Assets Program - Distributed Energy Resources (DERs) for Grid Reliability"),
    ["sunset-storage"],
  );
  const grid = leversForTitle("Transmission Line Rating and Substation Modernization");
  assert.deepEqual(grid.sort(), ["hot-day-capacity", "weather-rating"]);
  assert.deepEqual(leversForTitle("Grid Reliability Improvements"), []);
  assert.deepEqual(leversForTitle("Generator Retirement and Repowering"), ["retirement-gap"]);
  assert.deepEqual(leversForTitle("Parking lot resurfacing"), []);
});

test("federalRegisterOpportunities keeps money notices and reports its feed", async () => {
  const payload = {
    results: [
      {
        title: "Notice of Funding Opportunity for Transmission Line Rating Upgrades",
        html_url: "https://www.federalregister.gov/documents/2026/11/01/2026-1/grid",
        document_number: "2026-1",
        publication_date: "2026-11-01",
        agencies: [{ name: "Department of Energy" }],
      },
      {
        title: "Environmental Impact Statement for a Transmission Line",
        html_url: "https://www.federalregister.gov/documents/2026/10/01/2026-2/eis",
        document_number: "2026-2",
        publication_date: "2026-10-01",
        agencies: [{ name: "Department of Energy" }],
      },
    ],
  };
  const live = await federalRegisterOpportunities({
    fetch: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
  });
  assert.equal(live.opportunities.length, 1);
  const notice = live.opportunities[0];
  assert.equal(notice.source, "federal-register");
  assert.equal(notice.status, "notice");
  assert.equal(notice.openDate, "2026-11-01");
  assert.equal(notice.agency, "Department of Energy");
  assert.ok(notice.levers.includes("weather-rating"));
  assert.deepEqual(notice.states, []);
  assert.equal(live.feed.watch.status, "ok");
  assert.match(live.feed.watch.fingerprint ?? "", /^sha256:/);

  const down = await federalRegisterOpportunities({
    fetch: (async () => new Response("nope", { status: 500 })) as typeof fetch,
  });
  assert.deepEqual(down.opportunities, []);
  assert.equal(down.feed.watch.status, "unreachable");
  assert.equal(down.feed.watch.httpStatus, 500);
});

test("cecSolicitations parses index cards, keeps lever topics, and fails closed on a layout change", async () => {
  const html = `
    <div class="abstract">
      <a href="/solicitations/2026-10/gfo-26-503-distributed-electricity-backup-assets-program">
        <div class="abstract-header"><div class="abstract-title"><h3 itemprop="name">GFO-26-503 - Distributed Electricity Backup Assets Program</h3></div></div>
      </a>
    </div>
    <div class="abstract">
      <a href="/solicitations/2026-11/zero-emission-school-bus">
        <div class="abstract-title"><h3 itemprop="name">Zero-Emission School Bus and Infrastructure Incentive Project</h3></div>
      </a>
    </div>`;
  const live = await cecSolicitations({ fetch: (async () => new Response(html, { status: 200 })) as typeof fetch });
  assert.equal(live.opportunities.length, 1);
  const solicitation = live.opportunities[0];
  assert.equal(solicitation.source, "cec-solicitations");
  assert.equal(solicitation.status, "open");
  assert.deepEqual(solicitation.states, ["CA"]);
  assert.equal(solicitation.number, "GFO-26-503");
  assert.equal(solicitation.url, "https://www.energy.ca.gov/solicitations/2026-10/gfo-26-503-distributed-electricity-backup-assets-program");
  assert.ok(solicitation.levers.includes("sunset-storage"));
  assert.equal(live.feed.hitCount, 2);
  assert.equal(live.feed.kept, 1);
  assert.equal(live.feed.watch.status, "ok");

  const changed = await cecSolicitations({ fetch: (async () => new Response("<html>redesigned</html>", { status: 200 })) as typeof fetch });
  assert.equal(changed.feed.watch.status, "unreachable");
  assert.match(changed.feed.watch.detail, /layout may have changed/);
});

test("provider fetch blocks cross-origin redirects and oversized pages", async () => {
  let calls = 0;
  const redirected = await watchProgram(PROGRAM, {
    fetch: (async () => {
      calls++;
      return new Response("", { status: 302, headers: { location: "https://attacker.example/credential" } });
    }) as typeof fetch,
  });
  assert.equal(redirected.watch.status, "unreachable");
  assert.equal(calls, 1);

  const oversized = await watchProgram(PROGRAM, {
    fetch: (async () => new Response("", { status: 200, headers: { "content-length": "4000001" } })) as typeof fetch,
  });
  assert.equal(oversized.watch.status, "unreachable");
  assert.match(oversized.watch.detail, /size limit/);
});

test("Federal Register keeps only safe official links and sanitizes source text", async () => {
  const payload = {
    results: [
      {
        title: "Notice of Funding Opportunity <img src=x onerror=alert(1)> for Transmission Line Ratings",
        html_url: "https://www.federalregister.gov/documents/2026/11/01/2026-1/grid-resilience",
        document_number: "2026-1",
        publication_date: "2026-11-01",
        agencies: [{ name: "Attacker controlled agency" }],
      },
      {
        title: "Notice of Funding Opportunity for Transmission Line Ratings",
        html_url: "https://attacker.example/documents/2026/11/01/2026-2/fake",
        document_number: "2026-2",
        publication_date: "2026-11-01",
        agencies: [{ name: "Department of Energy" }],
      },
    ],
  };
  const live = await federalRegisterOpportunities({
    fetch: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
  });
  assert.equal(live.opportunities.length, 1);
  assert.equal(live.opportunities[0].title, "Notice of Funding Opportunity for Transmission Line Ratings");
  assert.equal(live.opportunities[0].agency, "Federal Register notice");
  assert.equal(live.opportunities[0].url, payload.results[0].html_url);
});
