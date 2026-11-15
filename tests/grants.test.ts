import { test } from "node:test";
import assert from "node:assert/strict";
import { watchProgram, searchOpportunities, verifyGrants, type GrantProgram } from "../research/etl/grants";
import { matchGrants, grantFeed, type GrantsArtifact } from "../lib/scan/grants";

const PROGRAM: GrantProgram = {
  id: "p1",
  title: "Programme one",
  funder: "Agency",
  url: "https://example.gov/programme",
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
      hitCount: 3,
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
  assert.equal(result.opportunities.length, 2);
  const first = result.opportunities.find((item) => item.id === "grants-gov-1")!;
  assert.equal(first.title, "Dynamic line rating & transmission capacity");
  assert.equal(first.status, "open");
  assert.equal(first.closeDate, "2026-03-01");
  assert.equal(first.url, "https://www.grants.gov/search-results-detail/1");
  assert.ok(first.levers.includes("weather-rating") && first.levers.includes("hot-day-capacity"));
  assert.ok(result.searches.length >= 1);
  assert.ok(result.searches.every((search) => search.kept <= search.hitCount));
});

test("verifyGrants reports unwatched programmes and rejects an ok watch without a fingerprint", () => {
  const artifact = {
    schema: "mapergy.grants/1",
    generatedAt: "2026-11-15T00:00:00.000Z",
    programs: [
      { ...PROGRAM, watch: { status: "ok", httpStatus: 200, title: "t", fingerprint: null, checkedAt: "2026-11-15T00:00:00.000Z", detail: "" } },
    ],
    opportunities: [],
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
  const report = verifyGrants(mixed);
  assert.equal(report.programs, 2);
  assert.equal(report.watched, 1);
  assert.deepEqual(report.unreachable, ["p2"]);
  assert.deepEqual(report.leversWithFunding, ["weather-rating"]);
  assert.throws(() => verifyGrants({ schema: "other" }), /mapergy\.grants\/1/);
});

function artifact(): GrantsArtifact {
  const watch = { status: "ok" as const, httpStatus: 200, fingerprint: "sha256:0123456789abcdef0123456789abcdef", checkedAt: "2026-11-15T00:00:00.000Z", detail: "" };
  return {
    schema: "mapergy.grants/1",
    generatedAt: "2026-11-15T00:00:00.000Z",
    programs: [
      { ...PROGRAM, id: "ca-storage", states: ["CA"], levers: ["sunset-storage"], watch },
      { ...PROGRAM, id: "national-grid", states: [], levers: ["sunset-storage", "weather-rating"], watch },
      { ...PROGRAM, id: "dead-programme", states: ["CA"], levers: ["sunset-storage"], watch: { ...watch, status: "unreachable", fingerprint: null } },
    ],
    opportunities: [
      { id: "grants-gov-9", title: "Battery demonstration", url: "https://www.grants.gov/search-results-detail/9", agency: "DOE", number: "DE-9", status: "forecasted", openDate: null, closeDate: "2027-01-01", levers: ["sunset-storage"] },
      { id: "grants-gov-8", title: "Storage deployment", url: "https://www.grants.gov/search-results-detail/8", agency: "DOE", number: "DE-8", status: "open", openDate: null, closeDate: "2026-12-01", levers: ["sunset-storage"] },
    ],
    searches: [],
  };
}

test("matchGrants filters by lever, state and watch status, then orders by availability", () => {
  const ca = matchGrants(["sunset-storage"], "CA", artifact());
  assert.deepEqual(ca.map((match) => match.id), ["grants-gov-8", "ca-storage", "national-grid"]);
  assert.deepEqual(ca.map((match) => match.status), ["open", "program", "program"]);
  assert.equal(ca[0].deadline, "2026-12-01");

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
  assert.equal(feed.listings, 2);
  assert.equal(feed.checkedAt.slice(0, 10), "2026-11-15");
});
