import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { collectAssets } from "./assets";
import { atomicJson, locationQuery, stateRoot } from "./pipeline";
import { auditSubstations } from "./substation-audit";

// Field shapes copied from the live HIFLD Substations layer (FID object IDs, no OWNER/OPERATOR
// columns, -999999 voltage sentinels, "<TYPE><ID>" placeholder names). OWNER is added to one
// record only to prove owner and operator stay separate.
const HIFLD = [
  { FID: 7, ID: "300016", NAME: "VIEJO", TYPE: "SUBSTATION", OWNER: "Utility C", MAX_VOLT: 230, MIN_VOLT: 230 },
  { FID: 8, ID: "300042", NAME: "UNKNOWN300042", TYPE: "SUBSTATION", MAX_VOLT: -999999, MIN_VOLT: -999999 },
  { FID: 9, ID: "300275", NAME: "FAIRMONT", TYPE: "SUBSTATION", MAX_VOLT: 66, MIN_VOLT: 69 },
];

async function fixture(t: TestContext) {
  const prior = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_STATE_NAMESPACE = `test-${randomUUID()}`;
  const root = stateRoot();
  t.after(async () => {
    if (prior === undefined) delete process.env.ETL_STATE_NAMESPACE;
    else process.env.ETL_STATE_NAMESPACE = prior;
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.searchParams.get("returnIdsOnly") === "true") {
      return Response.json({ objectIdFieldName: "FID", objectIds: HIFLD.map(({ FID }) => FID) });
    }
    return Response.json({ type: "FeatureCollection", features: HIFLD.map((properties, index) => ({
      type: "Feature", properties, geometry: { type: "Point", coordinates: [-117.6 - index / 100, 33.6] },
    })) });
  });
  const manifest = await collectAssets(locationQuery(33.6, -117.6, 10), "hifld-substations");
  const snapshot: string = JSON.parse(await readFile(manifest.path, "utf8")).pages[0].id;
  const osm = `${root}/osm.geojson`;
  await atomicJson(osm, { features: [
    { properties: { osm_id: "way/1", name: "Viejo Substation", operator: "Utility C", voltage_kv: 220 } },
    { properties: { osm_id: "way/2", name: "Some Substation", voltage_kv: 66 } },
    { properties: { osm_id: "node/3", name: null } },
  ] });
  const crosswalk = `${root}/crosswalk.json`;
  const audit = async (rows: unknown) => {
    await atomicJson(crosswalk, rows);
    return auditSubstations(osm, manifest.path, crosswalk);
  };
  return { snapshot, audit };
}

const reviewed = { status: "reviewed", reviewer: "fixture reviewer" };

test("unreviewed crosswalk candidates are never corroborated", async (t) => {
  const { snapshot, audit } = await fixture(t);
  const row = { osm: "way/1", hifld: "hifld-substations:7", snapshot, evidence: "nearest within 300 m" };
  for (const review of [{ status: "unreviewed" }, { status: "rejected", reviewer: "x" }, { status: "reviewed" }, {}]) {
    const result = await audit([{ ...row, review }]);
    assert.equal(result.comparisons.length, 0);
    assert.equal(result.totals.matched, 0);
    assert.equal(result.totals.unreviewed, 1);
    assert.ok(result.unmatchedOsm.includes("way/1"));
    assert.ok(result.unmatchedHifld.includes("hifld-substations:7"));
  }
  // The candidate file itself (an object, not a reviewed array) is refused outright.
  await assert.rejects(audit({ candidates: [{ ...row, review: { status: "unreviewed" } }] }), /crosswalk array/);
});

test("a reviewed crosswalk tied to the captured record is corroborated", async (t) => {
  const { snapshot, audit } = await fixture(t);
  const row = { osm: "way/1", hifld: "hifld-substations:7", snapshot, evidence: "Same fenced yard on imagery", review: reviewed };
  const result = await audit([row, { ...row, osm: "way/2", hifld: "hifld-substations:9", review: { status: "unreviewed" } }]);
  assert.equal(result.totals.matched, 1);
  assert.equal(result.totals.unreviewed, 1);
  assert.equal(result.comparisons[0].hifld, "hifld-substations:7");
  assert.deepEqual(result.comparisons[0].citation, { snapshot, locator: "/features/0" });
  assert.equal(result.comparisons[0].mappingEvidence, "Same fenced yard on imagery");
  assert.deepEqual(result.unreviewed, [{ osm: "way/2", hifld: "hifld-substations:9", status: "unreviewed" }]);
  // Reviewed but not tied to the captured snapshot, or to a record absent from the capture: refused.
  await assert.rejects(audit([{ ...row, snapshot: "snp_0000000000000000" }]), /Invalid or ambiguous crosswalk/);
  await assert.rejects(audit([{ ...row, hifld: "hifld-substations:99" }]), /Invalid or ambiguous crosswalk/);
});

test("HIFLD owner is never compared with the OSM operator", async (t) => {
  const { snapshot, audit } = await fixture(t);
  const result = await audit([{ osm: "way/1", hifld: "hifld-substations:7", snapshot, evidence: "e", review: reviewed }]);
  const [comparison] = result.comparisons;
  // OSM operator equals HIFLD OWNER text, but the layer publishes no OPERATOR, so there is nothing to agree with.
  assert.deepEqual(comparison.operator, { osm: "Utility C", hifld: null, status: "missing" });
  assert.equal(comparison.hifldOwner, "Utility C");
});

test("HIFLD MAX_VOLT stays separate from the OSM voltage tag and sentinels are unavailable", async (t) => {
  const { snapshot, audit } = await fixture(t);
  const result = await audit([
    { osm: "way/1", hifld: "hifld-substations:7", snapshot, evidence: "e", review: reviewed },
    { osm: "way/2", hifld: "hifld-substations:8", snapshot, evidence: "e", review: reviewed },
  ]);
  assert.deepEqual(result.comparisons[0].voltage, { osm: 220, hifldMaximum: 230, status: "incomparable" });
  assert.deepEqual(result.comparisons[1].voltage, { osm: 66, hifldMaximum: null, status: "incomparable" });
});

test("a missing HIFLD record or name does not imply a missing asset", async (t) => {
  const { snapshot, audit } = await fixture(t);
  const result = await audit([{ osm: "way/2", hifld: "hifld-substations:8", snapshot, evidence: "e", review: reviewed }]);
  // node/3 has no HIFLD counterpart and no name: it stays in the inventory, unpaired, not removed or flagged absent.
  assert.equal(result.totals.osm, 3);
  assert.equal(result.totals.osmNameUnavailable, 1);
  assert.deepEqual(result.unmatchedOsm, ["node/3", "way/1"]);
  assert.deepEqual(result.unmatchedHifld, ["hifld-substations:7", "hifld-substations:9"]);
  // The HIFLD "UNKNOWN<ID>" placeholder is an unavailable name, not a conflicting one.
  assert.deepEqual(result.comparisons[0].name, { osm: "Some Substation", hifld: null, status: "missing" });
});
