import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { LocationReport } from "../../research/etl/pipeline";
import { CAISO_SUBJECT, evidenceFromReport, evidenceIndex, factsFromAssets, type LoadedAssetInventory } from "./etlEvidence";
import type { Claim } from "../evidence/schema";
import { isUnknown } from "./planTypes";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));
const report = (): LocationReport => fixture("location-report.json");
const assets = (): LoadedAssetInventory => fixture("location-assets.json");

test("captured report: one Evidence per snapshot with hash, url, publisher and feed freshness", () => {
  const r = report();
  const { evidence } = evidenceFromReport(r);
  const located = new Set(r.evidence.claims.filter((c) => c.snapshot_id && c.locator !== null).map((c) => `${c.snapshot_id}#${c.locator}`));
  assert.equal(evidence.filter((e) => !e.id.includes("#")).length, r.evidence.snapshots.length);
  assert.equal(evidence.length, r.evidence.snapshots.length + located.size);
  for (const snapshot of r.evidence.snapshots) {
    const item = evidence.find((e) => e.id === `ev:${snapshot.id}`);
    assert.ok(item, snapshot.id);
    assert.equal(item.kind, "snapshot");
    assert.equal(item.source.sha256, snapshot.sha256);
    assert.equal(item.source.url, snapshot.url);
    assert.equal(item.source.snapshot, snapshot.id);
    assert.equal(item.retrievedAt, snapshot.retrieved_at);
    assert.equal(r.feeds[snapshot.source_id].status, "fresh");
    assert.equal(item.freshness, "fresh");
    assert.equal(item.provenance, "public_source");
  }
  const nws = evidence.find((e) => e.source.snapshot === r.feeds["nws-observation"].snapshot!.id)!;
  assert.equal(nws.source.publisher, "National Weather Service");
  assert.equal(nws.observedAt, r.feeds["nws-observation"].observation_at);
});

test("captured report: one Fact per claim; scope claims are user assertions; observed are public_source", () => {
  const r = report();
  const { facts, evidence } = evidenceFromReport(r);
  const scope = ["region.home_latitude", "region.home_longitude", "region.radius_miles"];
  assert.deepEqual(r.evidence.claims.filter((c) => c.method !== "observed").map((c) => c.predicate).sort(), [...scope].sort());
  for (const claim of r.evidence.claims) {
    const fact = facts.find((f) => f.id === `fact:${claim.id}`);
    assert.ok(fact, claim.id);
    assert.equal(fact.predicate, claim.predicate);
    assert.equal(fact.value, claim.value);
    assert.equal(fact.unit, claim.unit ?? undefined);
    assert.equal(fact.provenance, claim.method === "observed" ? "public_source" : "user_assertion");
    if (claim.snapshot_id) {
      // Each Fact cites its own (snapshot, locator) Evidence, which carries the locator.
      assert.ok(claim.locator !== null);
      assert.deepEqual(fact.evidence, [`ev:${claim.snapshot_id}#${claim.locator}`]);
      const cited = evidence.find((e) => e.id === fact.evidence[0])!;
      assert.equal(cited.source.locator, claim.locator);
      assert.equal(cited.source.snapshot, claim.snapshot_id);
      const snapshot = r.evidence.snapshots.find((s) => s.id === claim.snapshot_id)!;
      assert.equal(cited.source.sha256, snapshot.sha256);
      assert.equal(cited.source.url, snapshot.url);
    }
  }
  // Distinct locators in one snapshot stay distinct (state FIPS vs county FIPS vs county name).
  const census = r.evidence.claims.filter((c) => c.source_id === "census-geocoder").map((c) => facts.find((f) => f.id === `fact:${c.id}`)!.evidence[0]);
  assert.equal(new Set(census).size, 3);
  // The pipeline's no-respondent demand gap and the null asset binding surface as explicit Unknowns.
  const demand = facts.find((f) => f.predicate === "telemetry.demand")!;
  assert.ok(isUnknown(demand.value));
  assert.equal(demand.value.state, "unknown");
  assert.match(demand.value.reason, /^telemetry\.demand unavailable: /);
  const inventory = facts.find((f) => f.predicate === "assets.inventory")!;
  assert.ok(isUnknown(inventory.value));
  assert.equal(facts.length, r.evidence.claims.length + 2);
});

test("deterministic: same input yields identical output; input not mutated", () => {
  const r = report();
  const before = JSON.stringify(r);
  assert.deepEqual(evidenceFromReport(r), evidenceFromReport(report()));
  assert.equal(JSON.stringify(r), before);
});

test("stale feed: evidence freshness stale, claims kept", () => {
  const r = report();
  r.feeds["nws-observation"] = { ...r.feeds["nws-observation"], status: "stale" };
  const { evidence, facts } = evidenceFromReport(r);
  const id = `ev:${r.feeds["nws-observation"].snapshot!.id}`;
  assert.equal(evidence.find((e) => e.id === id)!.freshness, "stale");
  assert.ok(facts.some((f) => f.predicate === "weather.temperature_c" && typeof f.value === "number"));
});

test("unavailable feed: Unknown fact with reason, no evidence, never guessed", () => {
  const r = report();
  const snapshotId = r.feeds["nws-observation"].snapshot!.id;
  r.feeds["nws-observation"] = { attempted_at: "2026-11-15T01:15:05.392Z", status: "unavailable", issue: "HTTP 503" };
  r.evidence.snapshots = r.evidence.snapshots.filter((s) => s.id !== snapshotId);
  r.evidence.claims = r.evidence.claims.filter((c) => c.snapshot_id !== snapshotId);
  const { evidence, facts } = evidenceFromReport(r);
  assert.ok(!evidence.some((e) => e.source.snapshot === snapshotId));
  const gap = facts.find((f) => f.id === "fact:unavailable:nws-observation")!;
  assert.deepEqual(gap.value, { state: "unknown", reason: "nws-observation unavailable: HTTP 503" });
  assert.deepEqual(gap.evidence, []);
  assert.ok(!facts.some((f) => f.predicate === "weather.temperature_c"));
});

test("fallback and unknown statuses map to freshness unknown; EIA local-unknown basis is unknown", () => {
  const r = report();
  r.feeds["hifld-substations"] = { ...r.feeds["hifld-substations"], status: "fallback", issue: "timeout" };
  const census = r.feeds["census-geocoder"];
  r.feeds["census-geocoder"] = { ...census, status: "fresh", observation_at: "2026-11-14T23", observation_time_basis: "local-unknown" };
  const { evidence } = evidenceFromReport(r);
  assert.equal(evidence.find((e) => e.id === `ev:${r.feeds["hifld-substations"].snapshot!.id}`)!.freshness, "unknown");
  const eiaLike = evidence.find((e) => e.id === `ev:${census.snapshot!.id}`)!;
  assert.equal(eiaLike.freshness, "unknown");
  assert.equal(eiaLike.observedAt, undefined);
});

test("CAISO values and unavailable CAISO feeds carry the system subject", () => {
  const r = report();
  const base = r.evidence.snapshots[0];
  const snapshot = { ...base, id: "snp_caiso000000000a", source_id: "caiso-demand-5min", url: "https://www.caiso.com/outlook/current/demand.csv" };
  r.evidence.snapshots.push(snapshot);
  r.evidence.sources.push({ ...r.evidence.sources[0], id: "caiso-demand-5min", publisher: "California ISO", title: "CAISO demand" });
  r.evidence.claims.push({
    ...r.evidence.claims.find((c) => c.method === "observed")!,
    id: "clm_caiso00000000001", subject: `region:${r.evidence.region.id}/caiso-demand-5min`,
    predicate: "caiso.system_demand_mw", value: 24000, unit: "MW", source_id: "caiso-demand-5min", snapshot_id: snapshot.id,
  });
  r.feeds["caiso-demand-5min"] = { attempted_at: base.retrieved_at, status: "fresh", observation_at: base.retrieved_at, observation_time_basis: "utc", snapshot };
  r.feeds["caiso-supply-5min"] = { attempted_at: base.retrieved_at, status: "unavailable", issue: "CSV header drift" };
  const { facts, evidence } = evidenceFromReport(r);
  const demand = facts.find((f) => f.predicate === "caiso.system_demand_mw")!;
  assert.equal(demand.subject, CAISO_SUBJECT);
  assert.equal(demand.provenance, "public_source");
  assert.equal(evidence.find((e) => e.id === "ev:snp_caiso000000000a")!.source.publisher, "California ISO");
  const supply = facts.find((f) => f.id === "fact:unavailable:caiso-supply-5min")!;
  assert.equal(supply.subject, CAISO_SUBJECT);
  assert.ok(isUnknown(supply.value));
  assert.ok(!facts.some((f) => f.subject.includes("caiso")));
});

test("a model claim with a non-scope predicate stays model; a claim without a locator cites its snapshot", () => {
  const r = report();
  const observed = r.evidence.claims.find((c) => c.method === "observed")!;
  const scope = r.evidence.claims.find((c) => c.predicate === "region.radius_miles")!;
  r.evidence.claims.push({ ...scope, id: "clm_modeled000000001", predicate: "region.plant_count", source_id: null });
  r.evidence.claims.push({ ...observed, id: "clm_nolocator0000001", locator: null });
  const { facts, evidence } = evidenceFromReport(r);
  assert.equal(facts.find((f) => f.id === "fact:clm_modeled000000001")!.provenance, "model");
  const bare = facts.find((f) => f.id === "fact:clm_nolocator0000001")!;
  assert.deepEqual(bare.evidence, [`ev:${observed.snapshot_id}`]);
  assert.equal(evidence.find((e) => e.id === bare.evidence[0])!.source.locator, undefined);
});

test("EIA balancing-authority values and unavailable EIA feeds carry the respondent subject, never the site", () => {
  const r = report();
  r.query = { ...r.query, respondent: "CISO" };
  const base = r.evidence.snapshots[0];
  const snapshot = { ...base, id: "snp_eia0000000000001", source_id: "eia-hourly-demand", url: "https://api.eia.gov/v2/electricity/rto/region-data/data/" };
  r.evidence.snapshots.push(snapshot);
  r.evidence.sources.push({ ...r.evidence.sources[0], id: "eia-hourly-demand", publisher: "U.S. Energy Information Administration", title: "EIA demand" });
  const claim: Claim = {
    ...r.evidence.claims.find((c) => c.method === "observed")!,
    id: "clm_eia0000000000001", subject: `region:${r.evidence.region.id}/eia-hourly-demand`,
    predicate: "telemetry.demand", value: 502, unit: "MWh", source_id: "eia-hourly-demand",
    snapshot_id: snapshot.id, locator: "/response/data/0/value",
  };
  r.evidence.claims.push(claim);
  r.feeds["eia-hourly-demand"] = { attempted_at: base.retrieved_at, status: "fresh", observation_at: "2026-11-14T18", observation_time_basis: "local-unknown", snapshot };
  r.feeds["eia-hourly-fuel"] = { attempted_at: base.retrieved_at, status: "unavailable", issue: "HTTP 503" };
  const { facts } = evidenceFromReport(r);
  const demand = facts.find((f) => f.id === "fact:clm_eia0000000000001")!;
  assert.equal(demand.subject, "CISO balancing authority");
  assert.deepEqual(demand.evidence, ["ev:snp_eia0000000000001#/response/data/0/value"]);
  const fuel = facts.find((f) => f.id === "fact:unavailable:eia-hourly-fuel")!;
  assert.equal(fuel.subject, "CISO balancing authority");
  assert.ok(isUnknown(fuel.value));
  assert.ok(!facts.some((f) => f.subject.includes("eia-hourly")));
  // The radius-scoped EIA Atlas plant count is not balancing-authority data and keeps the site subject.
  const plants = facts.find((f) => f.predicate === "region.plant_count")!;
  assert.equal(plants.subject, `region:${r.evidence.region.id}/eia-atlas-plants`);
});

test("model and operator provenance by source", () => {
  const r = report();
  const base = r.evidence.snapshots[0];
  const claim = r.evidence.claims.find((c) => c.method === "observed")!;
  for (const [id, authority] of [["open-meteo-era5", "primary"], ["operator-records", "primary"], ["gs-seed-nodes", "modeled"]] as const) {
    const snapshot = { ...base, id: `snp_${id}`, source_id: id };
    r.evidence.snapshots.push(snapshot);
    r.evidence.sources.push({ ...r.evidence.sources[0], id, authority });
    r.evidence.claims.push({ ...claim, id: `clm_${id}`, source_id: id, snapshot_id: snapshot.id });
  }
  const { facts, evidence } = evidenceFromReport(r);
  assert.equal(facts.find((f) => f.id === "fact:clm_open-meteo-era5")!.provenance, "model");
  assert.equal(facts.find((f) => f.id === "fact:clm_operator-records")!.provenance, "operator");
  assert.equal(facts.find((f) => f.id === "fact:clm_gs-seed-nodes")!.provenance, "model");
  assert.equal(evidence.find((e) => e.id === "ev:snp_operator-records")!.provenance, "operator");
  // No feed state for these snapshots: freshness is not asserted.
  assert.equal(evidence.find((e) => e.id === "ev:snp_open-meteo-era5")!.freshness, "unknown");
});

test("assets: property facts cite snapshots; nulls become Unknown; clips and mileage are model", () => {
  const inv = assets();
  const { evidence, facts } = factsFromAssets(inv);
  const dataset = inv.data.datasets[0];
  assert.equal(evidence.length, dataset.snapshots.length);
  assert.ok(evidence.every((e) => e.freshness === "unknown" && e.provenance === "public_source" && e.source.publisher === "HIFLD"));
  const voltage = facts.find((f) => f.subject === "hifld-transmission:1" && f.predicate === "asset.voltage_kv")!;
  assert.equal(voltage.value, 230);
  assert.equal(voltage.unit, "kV");
  assert.equal(voltage.provenance, "public_source");
  assert.deepEqual(voltage.evidence, [`ev:${dataset.features.features[0].citations.voltage_kv.snapshot}`]);
  const owner2 = facts.find((f) => f.subject === "hifld-transmission:2" && f.predicate === "asset.owner")!;
  assert.ok(isUnknown(owner2.value));
  const clip = facts.find((f) => f.subject === "hifld-transmission:1" && f.predicate === "asset.study_clip.inside_miles")!;
  assert.equal(clip.value, 20);
  assert.equal(clip.unit, "mi");
  assert.equal(clip.provenance, "model");
  const total = facts.find((f) => f.predicate === "asset.mileage.inside_miles_total")!;
  assert.equal(total.value, dataset.mileage!.inside_miles_total);
  assert.equal(total.provenance, "model");
  const properties = dataset.features.features.reduce((n, f) => n + Object.keys(f.properties).length, 0);
  const clips = dataset.features.features.filter((f) => f.study_clip).length * 5;
  const mileage = 2 + Object.keys(dataset.mileage!.by_voltage_band).length + Object.keys(dataset.mileage!.counts).length;
  assert.equal(facts.length, 1 + properties + clips + mileage);
});

test("assets: operator import source yields operator provenance", () => {
  const inv = assets();
  inv.data.datasets[0] = { ...inv.data.datasets[0], source: "operator-records", mileage: undefined };
  const { evidence, facts } = factsFromAssets(inv);
  assert.ok(evidence.every((e) => e.provenance === "operator"));
  assert.ok(facts.filter((f) => !f.predicate.startsWith("asset.study_clip")).every((f) => f.provenance === "operator"));
});

test("evidenceIndex merges, dedupes, resolves every reference, rejects conflicts", () => {
  const a = evidenceFromReport(report());
  const b = factsFromAssets(assets());
  const index = evidenceIndex(a, b, a);
  assert.equal(index.evidence.length, a.evidence.length + b.evidence.length);
  assert.equal(index.facts.length, a.facts.length + b.facts.length);
  assert.deepEqual(index.dangling, []);
  for (const fact of index.facts) for (const id of fact.evidence) assert.ok(index.byId[id]);
  const conflict = { evidence: [{ ...a.evidence[0], freshness: "stale" as const }], facts: [] };
  assert.throws(() => evidenceIndex(a, conflict), /Conflicting evidence/);
  assert.deepEqual(evidenceIndex({ evidence: [], facts: [a.facts.find((f) => f.evidence.length)!] }).dangling.length, 1);
});

test("CAISO OASIS nodal prices carry the pricing-node subject, never the CAISO system subject", () => {
  const r = report();
  r.query = { ...r.query, caiso: true, oasis_node: "TH_SP15_GEN-APND" };
  const base = r.evidence.snapshots[0];
  const snapshot = { ...base, id: "snp_oasis000000000a", source_id: "caiso-oasis-dam-lmp", url: "https://oasis.caiso.com/oasisapi/SingleZip" };
  r.evidence.snapshots.push(snapshot);
  r.evidence.sources.push({ ...r.evidence.sources[0], id: "caiso-oasis-dam-lmp", publisher: "California ISO", title: "CAISO OASIS DAM LMP" });
  const observed = r.evidence.claims.find((c) => c.method === "observed")!;
  r.evidence.claims.push(
    { ...observed, id: "clm_oasis00000000001", subject: `region:${r.evidence.region.id}/caiso-oasis-dam-lmp`,
      predicate: "caiso.oasis.dam.lmp_usd_per_mwh", value: 41.2, unit: "USD/MWh", source_id: "caiso-oasis-dam-lmp", snapshot_id: snapshot.id },
    { ...observed, id: "clm_oasis00000000002", subject: `region:${r.evidence.region.id}/caiso-oasis-dam-lmp`,
      predicate: "telemetry.period", value: "2026-11-14T23:00:00Z", unit: null, source_id: "caiso-oasis-dam-lmp", snapshot_id: snapshot.id },
  );
  r.feeds["caiso-oasis-dam-lmp"] = { attempted_at: base.retrieved_at, status: "fresh", snapshot };
  r.feeds["caiso-oasis-rtm-lmp"] = { attempted_at: base.retrieved_at, status: "unavailable", issue: "HTTP 429" };
  r.feeds["caiso-demand-5min"] = { attempted_at: base.retrieved_at, status: "unavailable", issue: "HTTP 503" };
  r.evidence.unresolved.push({ subject: `region:${r.evidence.region.id}`, predicate: "caiso.oasis.rtm.lmp_usd_per_mwh",
    reason: "no_source", detail: "node not priced", candidate_claim_ids: [], escalated: false });
  const { facts } = evidenceFromReport(r);
  const node = "CAISO pricing node TH_SP15_GEN-APND";
  assert.equal(facts.find((f) => f.id === "fact:clm_oasis00000000001")!.subject, node);
  assert.equal(facts.find((f) => f.id === "fact:clm_oasis00000000002")!.subject, node);
  assert.equal(facts.find((f) => f.id === "fact:unavailable:caiso-oasis-rtm-lmp")!.subject, node);
  assert.equal(facts.find((f) => f.predicate === "caiso.oasis.rtm.lmp_usd_per_mwh")!.subject, node);
  // System telemetry keeps the system subject.
  assert.equal(facts.find((f) => f.id === "fact:unavailable:caiso-demand-5min")!.subject, CAISO_SUBJECT);
});

test("fallback feeds: measured freshness field maps to fresh/stale when present, else unknown", () => {
  const r = report();
  const subs = r.feeds["hifld-substations"];
  const lines = r.feeds["hifld-transmission"];
  const plants = r.feeds["eia-atlas-plants"];
  // Synthetic: the pipeline's separate measured-freshness field may or may not be present
  // (absent on older report revisions), and an unrecognised value is never trusted.
  r.feeds["hifld-substations"] = { ...subs, status: "fallback", issue: "timeout", freshness: "fresh" };
  r.feeds["hifld-transmission"] = { ...lines, status: "fallback", issue: "timeout", freshness: "stale" };
  r.feeds["eia-atlas-plants"] = { ...plants, status: "fallback", issue: "timeout" };
  r.feeds["census-geocoder"] = { ...r.feeds["census-geocoder"], status: "fallback", issue: "timeout", freshness: "bogus" } as unknown as typeof subs;
  const { evidence } = evidenceFromReport(r);
  const freshness = (id: string) => evidence.find((e) => e.id === `ev:${r.feeds[id].snapshot!.id}`)!.freshness;
  assert.equal(freshness("hifld-substations"), "fresh");
  assert.equal(freshness("hifld-transmission"), "stale");
  assert.equal(freshness("eia-atlas-plants"), "unknown");
  assert.equal(freshness("census-geocoder"), "unknown");
});
