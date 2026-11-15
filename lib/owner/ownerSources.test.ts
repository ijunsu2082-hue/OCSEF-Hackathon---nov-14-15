import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GRANTS_SEARCH_URL,
  lookupOwnerSources,
  parseOwnerSourcesQuery,
  resetOwnerSourcesCache,
  usDateToIso,
  type OwnerSourceItem,
  type OwnerSourcesQuery,
} from "./ownerSources";
import { GET as getSources } from "../../app/api/owner-plan/sources/route";

const Q: OwnerSourcesQuery = { lat: 33.7538, lon: -118.0111, radiusMi: 5, sector: "electric" };
const NOW = () => new Date("2026-11-14T12:00:00.000Z");

type Body = unknown | { status: number; text: string };
interface Call { url: string; method: string; body?: string }

const GRANTS_OK = {
  errorcode: 0,
  data: {
    hitCount: 2,
    oppHits: [
      { id: "364174", number: "DE-FOA-0003641", title: "Grid Supply Chain &rsquo;SCALED&rsquo;", agency: "NETL", openDate: "10/30/2026", closeDate: "02/08/2027", oppStatus: "posted", cfdaList: ["81.122"] },
      { id: "360645", number: "RFA-X", title: "Forecast program", agency: "NIH", openDate: "09/23/2025", closeDate: "", oppStatus: "forecasted", cfdaList: [] },
    ],
  },
};
const CENSUS_OK = {
  result: {
    geographies: {
      States: [{ NAME: "California", GEOID: "06" }],
      Counties: [{ NAME: "Orange County", GEOID: "06059" }],
      "Incorporated Places": [{ NAME: "Westminster city", GEOID: "0684550" }],
    },
  },
};
const FEMA_POINT_OK = { features: [{ attributes: { FLD_ZONE: "X", ZONE_SUBTY: "0.2 PCT ANNUAL CHANCE FLOOD HAZARD", SFHA_TF: "F", DFIRM_ID: "06059C" } }] };
const FEMA_RADIUS_OK = { features: [{ attributes: { FLD_ZONE: "AE", n: 42 } }, { attributes: { FLD_ZONE: "X", n: 95 } }] };
const CPUC_HIT = { features: [{ attributes: { HFTD: "Tier 3" } }] };
const CPUC_NONE = { features: [] };

type Route = "grants" | "census" | "femaPoint" | "femaRadius" | "cpucPoint" | "cpucRadius";

function routeOf(url: string): Route {
  if (url.startsWith(GRANTS_SEARCH_URL)) return "grants";
  if (url.startsWith("https://geocoding.geo.census.gov/")) return "census";
  const radius = url.includes("distance=");
  if (url.startsWith("https://hazards.fema.gov/")) return radius ? "femaRadius" : "femaPoint";
  if (url.startsWith("https://services2.arcgis.com/VofPZYDe2pLxSP5G/")) return radius ? "cpucRadius" : "cpucPoint";
  throw new Error(`unexpected URL ${url}`);
}

function mockFetch(overrides: Partial<Record<Route, Body>> = {}) {
  const calls: Call[] = [];
  const defaults: Record<Route, Body> = {
    grants: GRANTS_OK, census: CENSUS_OK, femaPoint: FEMA_POINT_OK, femaRadius: FEMA_RADIUS_OK, cpucPoint: CPUC_NONE, cpucRadius: CPUC_HIT,
  };
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), body: typeof init?.body === "string" ? init.body : undefined });
    const body = { ...defaults, ...overrides }[routeOf(url)];
    if (body && typeof body === "object" && "status" in body && "text" in body) {
      const b = body as { status: number; text: string };
      return new Response(b.text, { status: b.status });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

const byId = (items: OwnerSourceItem[], id: string) => {
  const it = items.find((i) => i.id === id);
  assert.ok(it, `missing item ${id}`);
  return it;
};

test("happy path: every source yields a matched item with freshness stamp", async () => {
  const { fn } = mockFetch();
  const res = await lookupOwnerSources(Q, { fetch: fn, now: NOW });
  assert.equal(res.retrievedAt, "2026-11-14T12:00:00.000Z");

  const j = byId(res.items, "census-jurisdiction");
  assert.equal(j.status, "informational");
  assert.equal(j.kind, "jurisdiction");
  assert.match(j.detail, /Westminster city \(GEOID 0684550\)/);
  assert.match(j.detail, /Orange County \(FIPS 06059\)/);

  const fp = byId(res.items, "fema-nfhl-point");
  assert.equal(fp.status, "informational");
  assert.match(fp.detail, /Matched: X \(0\.2 PCT ANNUAL CHANCE FLOOD HAZARD\), not in SFHA/);

  const fr = byId(res.items, "fema-nfhl-radius");
  assert.match(fr.detail, /AE \(42 polygons\), X \(95 polygons\)/);

  const cp = byId(res.items, "cpuc-hftd-point");
  assert.equal(cp.status, "informational");
  assert.match(cp.detail, /no HFTD Tier 2\/Tier 3 polygon intersects/);
  const cr = byId(res.items, "cpuc-hftd-radius");
  assert.match(cr.detail, /Matched: Tier 3\./);

  const gs = byId(res.items, "grants-gov-search");
  assert.equal(gs.status, "informational");
  assert.match(gs.detail, /Matched: 2 listing\(s\)/);
  const g1 = byId(res.items, "grants-gov-364174");
  assert.equal(g1.status, "open");
  assert.equal(g1.deadline, "2027-02-08");
  assert.equal(g1.url, "https://www.grants.gov/search-results-detail/364174");
  assert.equal(g1.title, "Grid Supply Chain 'SCALED'");
  const g2 = byId(res.items, "grants-gov-360645");
  assert.equal(g2.status, "forecasted");
  assert.equal(g2.deadline, undefined, "no deadline unless publisher states one");
  assert.match(g2.detail, /No close date stated by publisher/);

  const sam = byId(res.items, "sam-assistance-listings");
  assert.equal(sam.status, "unresolved");
  assert.match(sam.detail, /API key/);

  for (const it of res.items) assert.ok(it.detail.includes(res.retrievedAt), `${it.id} lacks freshness stamp`);
});

for (const route of ["grants", "census", "femaPoint", "femaRadius", "cpucPoint", "cpucRadius"] as const) {
  const id = { grants: "grants-gov-search", census: "census-jurisdiction", femaPoint: "fema-nfhl-point", femaRadius: "fema-nfhl-radius", cpucPoint: "cpuc-hftd-point", cpucRadius: "cpuc-hftd-radius" }[route];

  test(`${route}: upstream 500 becomes an unresolved item with reason, others unaffected`, async () => {
    const { fn } = mockFetch({ [route]: { status: 500, text: "boom" } });
    const res = await lookupOwnerSources(Q, { fetch: fn, now: NOW });
    const it = byId(res.items, id);
    assert.equal(it.status, "unresolved");
    assert.match(it.detail, /upstream HTTP 500/);
    assert.match(it.detail, /Looked up: /);
    const otherOk = res.items.filter((i) => i.id !== id && i.id !== "sam-assistance-listings");
    assert.ok(otherOk.length > 0 && otherOk.every((i) => i.status !== "unresolved"), "failure must stay scoped to its own lookup");
  });

  test(`${route}: malformed JSON becomes an unresolved item`, async () => {
    const { fn } = mockFetch({ [route]: { status: 200, text: "{not json" } });
    const res = await lookupOwnerSources(Q, { fetch: fn, now: NOW });
    const it = byId(res.items, id);
    assert.equal(it.status, "unresolved");
    assert.match(it.detail, /not valid JSON/);
  });

  test(`${route}: valid JSON with wrong shape fails closed`, async () => {
    const { fn } = mockFetch({ [route]: { unexpected: true } });
    const res = await lookupOwnerSources(Q, { fetch: fn, now: NOW });
    assert.equal(byId(res.items, id).status, "unresolved");
  });
}

test("ArcGIS error envelope (HTTP 200 with error) is unresolved", async () => {
  const { fn } = mockFetch({ femaRadius: { error: { code: 400, message: "Failed to execute query." } } });
  const res = await lookupOwnerSources(Q, { fetch: fn, now: NOW });
  const it = byId(res.items, "fema-nfhl-radius");
  assert.equal(it.status, "unresolved");
  assert.match(it.detail, /ArcGIS error 400 Failed to execute query\./);
});

test("empty matches are reported, never dropped", async () => {
  const { fn } = mockFetch({ femaPoint: { features: [] }, grants: { errorcode: 0, data: { hitCount: 0, oppHits: [] } }, census: { result: { geographies: { States: [], Counties: [] } } } });
  const res = await lookupOwnerSources(Q, { fetch: fn, now: NOW });
  assert.equal(byId(res.items, "fema-nfhl-point").status, "unresolved");
  assert.match(byId(res.items, "grants-gov-search").detail, /0 opportunities/);
  assert.equal(byId(res.items, "grants-gov-search").status, "unresolved");
  assert.equal(byId(res.items, "census-jurisdiction").status, "unresolved");
});

test("malformed single Grants.gov hit is unresolved while valid hits remain", async () => {
  const { fn } = mockFetch({ grants: { errorcode: 0, data: { hitCount: 2, oppHits: [GRANTS_OK.data.oppHits[0], { id: "x", oppStatus: "weird" }] } } });
  const res = await lookupOwnerSources(Q, { fetch: fn, now: NOW });
  assert.equal(byId(res.items, "grants-gov-364174").status, "open");
  assert.equal(byId(res.items, "grants-gov-hit-1").status, "unresolved");
});

test("timeout becomes unresolved", async () => {
  const fn = ((_: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as unknown as typeof fetch;
  const res = await lookupOwnerSources(Q, { fetch: fn, now: NOW, timeoutMs: 20 });
  for (const it of res.items) assert.equal(it.status, "unresolved");
  assert.match(byId(res.items, "census-jurisdiction").detail, /timed out after 20 ms/);
});

test("thrown fetch error becomes unresolved", async () => {
  const fn = (async () => { throw new TypeError("network down"); }) as typeof fetch;
  const res = await lookupOwnerSources(Q, { fetch: fn, now: NOW });
  assert.match(byId(res.items, "fema-nfhl-point").detail, /network down/);
});

test("read-only: only GETs, except the documented Grants.gov Search2 POST", async () => {
  for (const sector of ["electric", "water", "wastewater", "transport", "telecom"] as const) {
    const { fn, calls } = mockFetch();
    await lookupOwnerSources({ ...Q, sector }, { fetch: fn, now: NOW });
    assert.equal(calls.length, 6);
    for (const c of calls) {
      if (c.method === "GET") continue;
      assert.equal(c.method, "POST");
      assert.equal(c.url, GRANTS_SEARCH_URL);
      const body = JSON.parse(c.body ?? "{}");
      assert.deepEqual(Object.keys(body).sort().filter((k) => k !== "fundingCategories"), ["keyword", "oppStatuses", "rows"]);
    }
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);
    assert.ok(calls.every((c) => !/api_key|token|login|submit|apply/i.test(c.url)));
  }
});

test("no eligibility or qualification language in any detail string", async () => {
  const scenarios = [mockFetch(), mockFetch({ grants: { status: 500, text: "" }, census: { status: 200, text: "x" } })];
  for (const { fn } of scenarios) {
    const res = await lookupOwnerSources(Q, { fetch: fn, now: NOW });
    for (const it of res.items) {
      assert.ok(!/eligib/i.test(it.detail), `${it.id}: ${it.detail}`);
      assert.ok(!/qualif/i.test(it.detail), `${it.id}: ${it.detail}`);
      assert.ok(!/approved|you can apply/i.test(it.detail), `${it.id}: ${it.detail}`);
    }
  }
});

test("parseOwnerSourcesQuery validates lat/lon/radius/sector", () => {
  const ok = parseOwnerSourcesQuery(new URLSearchParams("lat=33.7538&lon=-118.0111&radius=5&sector=electric"));
  assert.deepEqual(ok, { ok: true, query: Q });
  for (const bad of [
    "lon=-118&radius=5&sector=electric",
    "lat=91&lon=-118&radius=5&sector=electric",
    "lat=33&lon=-181&radius=5&sector=electric",
    "lat=33&lon=-118&radius=0&sector=electric",
    "lat=33&lon=-118&radius=51&sector=electric",
    "lat=33&lon=-118&radius=abc&sector=electric",
    "lat=33&lon=-118&radius=5&sector=gas",
    "lat=33&lon=-118&radius=5",
  ]) {
    assert.equal(parseOwnerSourcesQuery(new URLSearchParams(bad)).ok, false, bad);
  }
});

test("usDateToIso only accepts real MM/DD/YYYY dates", () => {
  assert.equal(usDateToIso("02/08/2027"), "2027-02-08");
  assert.equal(usDateToIso(""), null);
  assert.equal(usDateToIso("02/30/2027"), null);
  assert.equal(usDateToIso("2027-02-08"), null);
  assert.equal(usDateToIso(undefined), null);
});

// ---------------------------------------------------------------------------
// Route: in-process cache and upstream rate limit

function sourcesRequest(lat: number, lon: number, radius = 5, sector = "electric") {
  return new Request(`http://localhost/api/owner-plan/sources?lat=${lat}&lon=${lon}&radius=${radius}&sector=${sector}`);
}

test("route: an identical (3 dp rounded) request is served from cache with 0 upstream calls", async (t) => {
  resetOwnerSourcesCache();
  t.after(() => resetOwnerSourcesCache());
  const { fn, calls } = mockFetch();
  t.mock.method(globalThis, "fetch", fn);
  const first = await getSources(sourcesRequest(33.7538, -118.0111));
  assert.equal(first.status, 200);
  const upstream = calls.length;
  assert.equal(upstream, 6, "one lookup is six upstream calls");
  const second = await getSources(sourcesRequest(33.75381, -118.01112));
  assert.equal(second.status, 200);
  assert.equal(calls.length, upstream, "second identical request made upstream calls");
  assert.deepEqual(await second.json(), await first.json());
  // Lookups use the rounded point, so the cached detail strings name the coordinates actually queried.
  assert.ok(calls.every((call) => !call.url.includes("33.7538")), "query rounded to 3 dp");
  assert.ok(calls.some((call) => call.url.includes("33.754")), "rounded point queried");
  // A different sector or radius is a different key.
  await getSources(sourcesRequest(33.7538, -118.0111, 5, "water"));
  assert.equal(calls.length, upstream + 6);
});

test("route: a burst beyond the upstream budget gets 429 JSON with Retry-After", async (t) => {
  resetOwnerSourcesCache();
  t.after(() => resetOwnerSourcesCache());
  const { fn, calls } = mockFetch();
  t.mock.method(globalThis, "fetch", fn);
  const statuses: number[] = [];
  for (let i = 0; i < 31; i += 1) statuses.push((await getSources(sourcesRequest(30 + i / 100, -118))).status);
  assert.deepEqual(statuses, [...Array(30).fill(200), 429]);
  assert.equal(calls.length, 30 * 6, "the rejected lookup made no upstream calls");
  const limited = await getSources(sourcesRequest(40, -118));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("cache-control"), "no-store");
  assert.match(limited.headers.get("retry-after") ?? "", /^[1-9]\d*$/);
  assert.deepEqual(await limited.json(), { error: { code: "RATE_LIMITED", message: "Too many owner-source lookups; retry later." } });
  // Cached keys are still served while the budget is exhausted.
  assert.equal((await getSources(sourcesRequest(30, -118))).status, 200);
  assert.equal(calls.length, 30 * 6);
});
