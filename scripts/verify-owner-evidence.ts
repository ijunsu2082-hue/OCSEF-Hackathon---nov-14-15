/**
 * Owner-evidence mapping check. Maps the captured ETL location report fixture
 * (and the loaded asset inventory fixture) into owner-plan Evidence + Facts and
 * prints counts by provenance and freshness. Exits non-zero on dangling refs.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-owner-evidence.ts
 */

import { readFileSync } from "node:fs";
import { evidenceFromReport, evidenceIndex, factsFromAssets } from "../lib/owner/etlEvidence";
import { isUnknown } from "../lib/owner/planTypes";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../lib/owner/__fixtures__/${name}`, import.meta.url), "utf8"));

const tally = (values: string[]) =>
  Object.fromEntries([...new Set(values)].sort().map((key) => [key, values.filter((v) => v === key).length]));

function summarize(label: string, set: ReturnType<typeof evidenceIndex>) {
  console.log(`\n== ${label} ==`);
  console.log(`evidence: ${set.evidence.length}`);
  console.log("  by provenance:", tally(set.evidence.map((e) => e.provenance)));
  console.log("  by freshness: ", tally(set.evidence.map((e) => e.freshness)));
  console.log(`facts: ${set.facts.length}`);
  console.log("  by provenance:", tally(set.facts.map((f) => f.provenance)));
  console.log("  unknown values:", set.facts.filter((f) => isUnknown(f.value)).length);
  for (const fact of set.facts.filter((f) => isUnknown(f.value))) {
    if (isUnknown(fact.value)) console.log(`    - ${fact.subject} ${fact.predicate}: ${fact.value.reason}`);
  }
  console.log(`dangling evidence refs: ${set.dangling.length}`);
}

const report = evidenceIndex(evidenceFromReport(load("location-report.json")));
summarize("location-report.json", report);
const combined = evidenceIndex(evidenceFromReport(load("location-report.json")), factsFromAssets(load("location-assets.json")));
summarize("location-report.json + location-assets.json", combined);

if (report.dangling.length || combined.dangling.length) {
  console.error("FAIL: facts reference evidence not in the index");
  process.exit(1);
}
console.log("\nOK");
