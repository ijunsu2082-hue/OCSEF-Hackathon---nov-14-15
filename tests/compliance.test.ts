import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BILL_KEY,
  EMPTY_DETAILS,
  MAIL_BODY_MAX,
  SITUATIONS,
  buildComplianceReport,
  detectUtility,
  emergencyContacts,
  emergencyInfo,
  loadBillChoice,
  mailBody,
  mailtoHref,
  reportText,
  resolveUtility,
  saveBillChoice,
  type BillChoice,
  type SituationId,
} from "../lib/scan/compliance";
import { LAWS, UTILITIES } from "../lib/scan/legal";
import { loadGridData } from "../lib/scan/data";
import { scanArea } from "../lib/scan/scan";
import type { Line, Plant, ScanResult, Substation } from "../lib/scan/types";
import type { ReportTarget } from "../lib/scan/target";
import { stubFetchFromPublic } from "./helpers";

stubFetchFromPublic();

/* ------------------------------------------------------------- fixtures */

const LAT = 33.8366;
const LON = -117.9143;
/** About 1 mi of latitude. */
const MI = 1 / 69;

function sub(operator: string | null, dLatMi: number): Substation {
  return { osm_id: `n${operator}${dLatMi}`, name: "Test", operator, voltage_kv: 69, substation: "distribution", lat: LAT + dLatMi * MI, lon: LON };
}

function line(operator: string | null, dLatMi: number): Line {
  const lat = LAT + dLatMi * MI;
  return { osm_id: 1, voltage_kv: 220, operator, name: "Test line", circuits: null, coords: [[lat, LON - 0.01], [lat, LON], [lat, LON + 0.01]] };
}

function scan(parts: { lines?: Line[]; substations?: Substation[]; plants?: Plant[] }): ScanResult {
  const plants = parts.plants ?? [];
  return {
    area: { lat: LAT, lon: LON, radius_mi: 5 },
    area_label: "Test area",
    inside_coverage: true,
    plants,
    lines: parts.lines ?? [],
    substations: parts.substations ?? [],
    cases: [],
    events: [],
    totals: { plant_count: plants.length },
  } as unknown as ScanResult;
}

const AREA: ReportTarget = { kind: "area" };
const BANNED = /unknown|unnamed|not listed|niche case/i;

function doc(situationId: SituationId, result: ScanResult, bill: BillChoice | null = null, target: ReportTarget = AREA) {
  const d = buildComplianceReport({ situationId, target, result, details: EMPTY_DETAILS, bill, now: new Date(2026, 10, 14) });
  return { d, text: reportText(d) };
}

const cites = (d: ReturnType<typeof doc>["d"]) => d.rules.map((r) => r.citation);

/* ------------------------------------------------------------- routing */

test("only a transmission line owner nearby: defaults to Not sure, with the owner as a hint", () => {
  const r = scan({ lines: [line("Southern California Edison", 0.2)] });
  const u = detectUtility(AREA, r);
  assert.equal(u.known, false);
  assert.equal(u.source, "unsure");
  assert.match(u.hint ?? "", /SCE owns the big power lines nearby/);
  assert.match(u.hint ?? "", /not always the one that sends your bill/);

  const { d, text } = doc("tree", r);
  assert.equal(d.to.length, 1);
  assert.match(d.to[0], /electric bill/);
  assert.ok(!cites(d).includes(LAWS.puc_451.citation), "CPUC-only rules must not apply when not sure");
  assert.ok(cites(d).includes(LAWS.go95_35.citation), "GO 95 applies to every utility");
  assert.match(text, /SCE owns the big power lines nearby/);
  assert.doesNotMatch(text, BANNED);
});

test("a line target with an operator but no nearby substation is Not sure, and names the line owner", () => {
  const l = line("Los Angeles Department of Water and Power", 0);
  const u = detectUtility({ kind: "line", line: l }, scan({ lines: [l] }));
  assert.equal(u.known, false);
  assert.match(u.hint ?? "", /LADWP owns this power line/);
});

test("nearest substation within 3 mi gives a 'likely' utility with a plain basis", () => {
  const r = scan({ substations: [sub("Anaheim Public Utilities", 0.5), sub("Southern California Edison", 2)], lines: [line("Southern California Edison", 0.1)] });
  const u = detectUtility(AREA, r);
  assert.equal(u.source, "likely");
  assert.equal(u.utility.key, "anaheim");
  assert.match(u.basis, /^Likely Anaheim Public Utilities, based on who runs the nearest substation \(0\.5 mi away/);
  assert.match(u.basis, /Check your electric bill/);
});

test("a substation farther than 3 mi is not used as evidence", () => {
  const u = detectUtility(AREA, scan({ substations: [sub("Southern California Edison", 4)] }));
  assert.equal(u.known, false);
});

test("city utility: city council route, GO 95 + D.10-02-034, no CPUC complaint, 911.2 deadline on claims", () => {
  const r = scan({ substations: [sub("Anaheim Public Utilities", 0.5)] });
  const tree = doc("tree", r);
  assert.ok(cites(tree.d).includes(LAWS.go95_35.citation));
  assert.ok(cites(tree.d).includes(LAWS.pou_jurisdiction.citation));
  assert.ok(!cites(tree.d).includes(LAWS.puc_451.citation));
  assert.ok(tree.d.steps.some((s) => /city council/.test(s.title)));
  assert.ok(!tree.d.steps.some((s) => /CPUC informal complaint/.test(s.title)));
  const claim = doc("outage_claim", r);
  assert.ok(claim.d.deadlines.some((x) => /911\.2/.test(x)));
});

test("bill pick overrides the guess everywhere (emergency number, route, claims, rules)", () => {
  const r = scan({ substations: [sub("Southern California Edison", 0.3)] });
  assert.equal(resolveUtility(AREA, r).utility.key, "sce");

  const u = resolveUtility(AREA, r, "ladwp");
  assert.equal(u.source, "bill");
  assert.equal(u.utility.key, "ladwp");

  const e = emergencyInfo("wire_down", AREA, r, "ladwp");
  assert.equal(e.utility.utility.key, "ladwp");
  assert.ok(e.steps.some((s) => /LADWP's emergency line/.test(s)));

  const claim = doc("outage_claim", r, "ladwp");
  assert.match(claim.d.to[0], /Los Angeles Department of Water and Power/);
  assert.equal(claim.d.filingUrl, UTILITIES.ladwp.claimsUrl);
  assert.ok(claim.d.deadlines.some((x) => /911\.2/.test(x)));
  assert.ok(!cites(claim.d).includes(LAWS.puc_451.citation));
  assert.ok(!claim.d.steps.some((s) => s.url?.includes("cims.cpuc")));

  // The other way: an investor-owned pick brings CPUC rules and the CAB route.
  const a = scan({ substations: [sub("Anaheim Public Utilities", 0.3)] });
  const iou = doc("tree", a, "sce");
  assert.ok(cites(iou.d).includes(LAWS.puc_451.citation));
  assert.ok(cites(iou.d).includes(LAWS.go165.citation));
  assert.ok(iou.d.steps.some((s) => /CPUC informal complaint/.test(s.title)));
  assert.match(iou.text, /expected to respond within 20 business days/);
  assert.doesNotMatch(iou.text, /must answer/);

  // "Not sure" wins over a guess.
  const ns = resolveUtility(AREA, r, "notsure");
  assert.equal(ns.known, false);
  assert.equal(emergencyInfo("sparks", AREA, r, "notsure").utility.known, false);
});

test("cooperative (Anza): board route, no Gov. Code 911.2, no city council, GO 95 still applies", () => {
  assert.equal(UTILITIES.anza.kind, "coop");
  const r = scan({});
  const claim = doc("outage_claim", r, "anza");
  assert.ok(!cites(claim.d).includes(LAWS.gov_911_2.citation));
  assert.ok(!claim.d.deadlines.some((x) => /911\.2/.test(x)));
  assert.doesNotMatch(claim.text, /city council|city-owned utility for damaged/i);
  assert.ok(claim.d.steps.some((s) => /board of directors/.test(s.title) && /electric bill/.test(s.detail)));
  assert.ok(claim.d.to.some((t) => /Board of Directors/.test(t)));
  assert.doesNotMatch(claim.text, /claims page/, "Anza has no verified claims page");
  const tree = doc("tree", r, "anza");
  assert.ok(cites(tree.d).includes(LAWS.go95_35.citation));
  assert.ok(!cites(tree.d).includes(LAWS.pou_jurisdiction.citation));
  assert.ok(!cites(tree.d).includes(LAWS.puc_451.citation));
});

test("emergency contacts when not sure: utilities named nearby first, else every verified line", () => {
  const r = scan({ lines: [line("Los Angeles Department of Water and Power", 0.1)], substations: [sub("Southern California Edison", 6)] });
  assert.deepEqual(emergencyContacts(AREA, r).map((c) => c.key), ["ladwp", "sce"]);
  const all = emergencyContacts(AREA, scan({}));
  assert.ok(all.length >= 8);
  assert.ok(all.every((c) => c.phone.tel.startsWith("+1")));
  assert.ok(!all.some((c) => c.key === "anza"), "no unverified numbers");
});

test("real data: Pasadena is no longer routed to SCE from a far-off line; Westminster is likely SCE", async () => {
  const data = await loadGridData();
  const pas = scanArea(data, { lat: 34.1478, lon: -118.1445, radius_mi: 3 });
  assert.notEqual(detectUtility(AREA, pas).utility.key, "sce");
  const wes = scanArea(data, { lat: 33.7513, lon: -117.994, radius_mi: 3 });
  const u = detectUtility(AREA, wes);
  assert.equal(u.utility.key, "sce");
  assert.equal(u.source, "likely");
});

test("bill choice storage: survives missing or broken storage, round-trips when available", () => {
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  const prev = g.window;
  try {
    delete g.window;
    assert.equal(loadBillChoice(), null);
    assert.equal(saveBillChoice("sce"), false);

    const store = new Map<string, string>();
    g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } };
    assert.equal(saveBillChoice("ladwp"), true);
    assert.equal(store.get(BILL_KEY), "ladwp");
    assert.equal(loadBillChoice(), "ladwp");
    store.set(BILL_KEY, "not-a-utility");
    assert.equal(loadBillChoice(), null);

    g.window = { localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } };
    assert.equal(loadBillChoice(), null);
    assert.equal(saveBillChoice("notsure"), false);
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
});

/* ------------------------------------------------------------- mailto */

function bodyOf(href: string): string {
  const m = /&body=(.*)$/.exec(href);
  assert.ok(m);
  return m[1];
}

test("mailto: encoded body is at most 1800 characters and cut on whole characters", () => {
  const r = scan({ substations: [sub("Southern California Edison", 0.3)] });
  const { d, text } = doc("tree", r);
  assert.ok(encodeURIComponent(text).length > MAIL_BODY_MAX, "the real report is long enough to need cutting");
  const href = mailtoHref(d.subject, text);
  assert.ok(bodyOf(href).length <= MAIL_BODY_MAX, `encoded body ${bodyOf(href).length}`);
  assert.ok(bodyOf(href).length > MAIL_BODY_MAX - 60, "uses most of the room");
  assert.match(decodeURIComponent(bodyOf(href)), /full report in the download\)$/);

  const emoji = "Branches \u{1F333}\u{1F525} on the wire. ".repeat(200);
  const cut = mailBody(emoji);
  assert.ok(encodeURIComponent(cut).length <= MAIL_BODY_MAX);
  assert.doesNotMatch(cut, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no half emoji");
  assert.doesNotThrow(() => mailtoHref("Subject \u{1F333}", emoji));

  assert.doesNotThrow(() => mailtoHref("bad \uD800 subject", "lone \uDC00 half"));
  const short = "Short report.";
  assert.equal(decodeURIComponent(bodyOf(mailtoHref("s", short))), short);
});

/* ------------------------------------------------------------- emergencies */

test("emergency situations carry no form data and start with 911", () => {
  const em = SITUATIONS.filter((s) => s.emergency);
  assert.deepEqual(em.map((s) => s.id).sort(), ["fire", "gas", "shock", "sparks", "wire_down"]);
  const r = scan({ substations: [sub("Southern California Edison", 0.3)] });
  for (const s of em) {
    assert.equal(s.happened, "");
    assert.deepEqual(s.laws, []);
    assert.deepEqual(s.asks, []);
    assert.deepEqual(s.evidence, []);
    const e = emergencyInfo(s.id, AREA, r);
    assert.deepEqual(Object.keys(e).sort(), ["gasPhone", "sources", "steps", "utility"], "no report fields");
    if (s.id !== "gas") assert.equal(e.steps[0], "Call 911 now.");
    else assert.ok(e.steps.some((x) => /call 911/.test(x)));
    for (const x of e.steps) assert.doesNotMatch(x, BANNED);
  }
});

test("gas company follows the bill: SDG&E and PG&E own numbers; Bear Valley and Not sure get no SoCalGas button", () => {
  const r = scan({});
  assert.equal(emergencyInfo("gas", AREA, r, "sdge").gasPhone?.tel, UTILITIES.sdge.emergency.tel);
  assert.equal(emergencyInfo("gas", AREA, r, "pge").gasPhone?.tel, "+18007435000");
  assert.ok(emergencyInfo("gas", AREA, r, "pge").steps.some((s) => /PG&E \(your gas company\)/.test(s)));
  for (const b of ["bves", "notsure"] as const) {
    const e = emergencyInfo("gas", AREA, r, b);
    assert.equal(e.gasPhone, null);
    assert.ok(e.steps.every((s) => !/SoCalGas/.test(s)));
    assert.ok(e.steps.some((s) => /gas bill/.test(s)));
  }
  assert.equal(emergencyInfo("gas", AREA, r, "sce").gasPhone?.tel, "+18004272200");
});
