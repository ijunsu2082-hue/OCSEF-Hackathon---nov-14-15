import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { collectAssets } from "./assets";
import { nameSimilarity, runCrosswalkCandidatesCommand, voltageHint } from "./crosswalk-candidates";
import { atomicJson, locationQuery, stateRoot } from "./pipeline";
import { auditSubstations } from "./substation-audit";

// ~0.0009 degrees of latitude is ~100 m.
const HIFLD = [
  { FID: 1, ID: "300001", NAME: "LUCAS", TYPE: "SUBSTATION", MAX_VOLT: 66, MIN_VOLT: 12, at: [-118, 34] },
  { FID: 2, ID: "300002", NAME: "UNKNOWN300002", TYPE: "SUBSTATION", MAX_VOLT: -999999, MIN_VOLT: -999999, at: [-118, 34.0018] },
  { FID: 3, ID: "300003", NAME: "TAP300003", TYPE: "TAP", MAX_VOLT: 230, MIN_VOLT: -999999, at: [-118.03, 34] },
];

test("candidates cite the captured HIFLD record, stay unreviewed, and are ignored by the audit", async (t) => {
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
    return Response.json({ type: "FeatureCollection", features: HIFLD.map(({ at, ...properties }) => ({
      type: "Feature", properties, geometry: { type: "Point", coordinates: at },
    })) });
  });
  const manifest = await collectAssets(locationQuery(34, -118, 2), "hifld-substations");
  const snapshot: string = JSON.parse(await readFile(manifest.path, "utf8")).pages[0].id;
  const osm = `${root}/osm.geojson`;
  await atomicJson(osm, { features: [
    // 100 m north of LUCAS and 100 m south of the UNKNOWN placeholder: two candidates.
    { geometry: { type: "Point", coordinates: [-118, 34.0009] },
      properties: { osm_id: "way/10", name: "Lucas Substation (electricity)", operator: "Southern California Edison", voltage_kv: 66 } },
    // Unnamed, >2 km from anything: no candidate, which says nothing about whether either asset exists.
    { geometry: { type: "Point", coordinates: [-118.02, 34.02] }, properties: { osm_id: "node/11", name: null } },
  ] });

  const result = await runCrosswalkCandidatesCommand([osm, manifest.path]);
  const data = JSON.parse(await readFile(result.json, "utf8"));
  assert.ok(result.json.startsWith(`${process.cwd()}/${root}/crosswalk/`));
  assert.equal(data.candidates.length, 2);
  const [first, second] = data.candidates;
  assert.equal(first.osm, "way/10");
  assert.equal(first.hifld, "hifld-substations:1");
  assert.equal(first.rank, 1);
  assert.equal(second.hifld, "hifld-substations:2");
  assert.ok(Math.abs(first.distance_m - 100) < 1);
  assert.deepEqual(first.citation, { snapshot, locator: "/features/0" });
  assert.equal(first.snapshot, snapshot);
  assert.equal(first.features.name_similarity, 1);
  assert.equal(first.features.voltage_hint, "consistent");
  assert.equal(second.hifld_record.name, null);
  assert.equal(second.hifld_record.name_as_published, "UNKNOWN300002");
  assert.equal(second.hifld_record.max_volt_kv, null);
  assert.equal(second.features.voltage_hint, "unknown");
  assert.ok(data.candidates.every(({ review }: { review: unknown }) =>
    JSON.stringify(review) === JSON.stringify({ status: "unreviewed" })));
  assert.equal(data.stats.corroborated, 0);
  assert.equal(data.stats.osm_with_candidate, 1);
  assert.equal(data.stats.osm_unnamed, 1);
  assert.equal(data.stats.osm_unnamed_with_candidate, 0);
  assert.equal(data.stats.hifld_within_radius, 3);
  assert.equal(data.stats.hifld_within_radius_without_candidate, 1);
  assert.deepEqual(data.stats.hifld_within_radius_without_candidate_by_type, { TAP: 1 });
  const csv = (await readFile(result.csv, "utf8")).trim().split("\n");
  assert.equal(csv.length, 3);
  assert.match(csv[1], /^way\/10,https:\/\/www\.openstreetmap\.org\/way\/10,Lucas Substation \(electricity\),/);
  assert.match(csv[1], /,unreviewed,,$/);

  // Candidate rows fed to the audit, even with evidence text, establish nothing.
  const crosswalk = `${root}/crosswalk.json`;
  await atomicJson(crosswalk, data.candidates.slice(0, 1).map((row: Record<string, unknown>) =>
    ({ ...row, evidence: "nearest within 300 m" })));
  const audit = await auditSubstations(osm, manifest.path, crosswalk);
  assert.equal(audit.comparisons.length, 0);
  assert.equal(audit.totals.unreviewed, 1);
  await assert.rejects(auditSubstations(osm, manifest.path, result.json), /crosswalk array/);

  // Deterministic: the same inputs give the same revision.
  assert.equal((await runCrosswalkCandidatesCommand([osm, manifest.path])).revision, result.revision);
  assert.equal((await runCrosswalkCandidatesCommand([osm, manifest.path, "--max-metres", "50"])).stats.osm_with_candidate, 0);
  await assert.rejects(runCrosswalkCandidatesCommand([osm]), /Expected crosswalk-candidates/);
});

test("name and voltage features are review hints with explicit unavailability", () => {
  assert.equal(nameSimilarity("Lucas Substation (electricity)", "LUCAS"), 1);
  assert.equal(nameSimilarity(null, "LUCAS"), null);
  assert.equal(nameSimilarity("Substation", "LUCAS"), null);
  assert.ok(nameSimilarity("Mira Loma Substation", "MIRALOMA")! > 0.8);
  assert.ok(nameSimilarity("Santiago Substation", "VIEJO")! < 0.2);
  // HIFLD parentheses carry real names (LADWP receiving stations), so they are kept.
  assert.equal(nameSimilarity("Receiving Station E - Toluca", "STATION E (TOLUCA)"), 1);
  assert.equal(voltageHint(220, 230, 66), "consistent");
  assert.equal(voltageHint(500, 230, 66), "inconsistent");
  assert.equal(voltageHint(66, 230, null), "consistent");
  assert.equal(voltageHint(null, 230, 66), "unknown");
  assert.equal(voltageHint(66, null, null), "unknown");
});
