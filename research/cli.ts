#!/usr/bin/env tsx
/**
 * Research CLI.
 *
 *   npm run evidence:build -- --profile westminster-100mi
 *   npm run evidence:verify -- --bundle public/evidence/westminster-100mi.json --files --strict
 *   npm run evidence:discover -- --center 33.7538,-118.0111 --radius 5 --offline research/fixtures/osm/...
 *   npm run evidence:report -- --bundle public/evidence/westminster-100mi.json
 *   npm run evidence:hash -- data/nodes.json
 *   npm run evidence:sources
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sha256BytesHex } from "../lib/evidence/sha256";
import { computeRegistryDigest } from "../lib/evidence/canonical";
import { verifyBundle } from "../lib/evidence/verify";
import type { EvidenceBundle, VerificationIssue } from "../lib/evidence/schema";
import { buildRegion, loadProfile } from "./build";
import { SOURCE_REGISTRY, getSourceDefinition } from "./registry";
import { REPO_ROOT, loadFixture, fetchLive } from "./snapshot";
import { verifyEvidenceFiles } from "./verify-files";

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberPair(value: string | null, label: string): [number, number] {
  if (!value) throw new Error(`--${label} is required, e.g. 33.7538,-118.0111`);
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`--${label} must be "lat,lon"`);
  }
  return [parts[0], parts[1]];
}

function printIssues(issues: VerificationIssue[]) {
  for (const issue of issues) {
    console.log(`  ${issue.severity.toUpperCase()} ${issue.code}: ${issue.detail}`);
  }
}

async function commandBuild() {
  const profile = arg("profile") ?? "westminster-100mi";
  const out = arg("out") ?? undefined;
  const bundle = await buildRegion({ profile, out });
  console.log(
    `built ${bundle.region.id}: ${bundle.stats.claims} claims ` +
      `(${bundle.stats.observed} observed / ${bundle.stats.derived} derived / ${bundle.stats.modeled} modeled) ` +
      `from ${bundle.stats.snapshots} snapshots`,
  );
  console.log(`bundle ${bundle.bundle_id}`);
  console.log(`verification ${bundle.verification.ok ? "OK" : "FAILED"}`);
  if (bundle.verification.warnings.length > 0) {
    console.log("warnings:");
    printIssues(bundle.verification.warnings);
  }
  if (bundle.unresolved.length > 0) {
    console.log("unresolved:");
    for (const item of bundle.unresolved) {
      console.log(`  ${item.subject}/${item.predicate}: ${item.reason} — ${item.detail}`);
    }
  }
}

async function commandVerify() {
  const path = arg("bundle") ?? arg("profile") ?? "public/evidence/westminster-100mi.json";
  const absolute = resolve(REPO_ROOT, path);
  const bundle = JSON.parse(await readFile(absolute, "utf8")) as EvidenceBundle;
  const strict = has("strict");
  const { report } = verifyBundle(bundle, {
    strict,
    enforceFreshness: true,
    now: new Date(),
  });

  console.log(`bundle ${bundle.bundle_id} (${bundle.region.id})`);
  console.log(`claims ${bundle.claims.length} · snapshots ${bundle.snapshots.length} · strict=${strict}`);

  const extraIssues: VerificationIssue[] = [];
  if (has("files")) {
    const files = await verifyEvidenceFiles(bundle);
    extraIssues.push(...files.issues);
    console.log(
      `files: ${files.checkedSnapshots}/${bundle.snapshots.length} snapshots rehashed, ` +
        `${files.checkedLocators} locators re-resolved`,
    );
  }

  const errors = [...report.errors, ...extraIssues.filter((issue) => issue.severity === "error")];
  const warnings = [...report.warnings, ...extraIssues.filter((issue) => issue.severity === "warning")];

  for (const check of report.checks) {
    console.log(`  ${check.ok ? "ok  " : "FAIL"} ${check.name} — ${check.detail}`);
  }
  if (warnings.length > 0) {
    console.log(`warnings (${warnings.length}):`);
    printIssues(warnings);
  }
  if (errors.length > 0) {
    console.log(`errors (${errors.length}):`);
    printIssues(errors);
    process.exitCode = 1;
    return;
  }
  console.log("verified: every claim reproduced from its recorded evidence");
}

async function commandDiscover() {
  const [lat, lon] = numberPair(arg("center"), "center");
  const radiusMiles = Number(arg("radius") ?? "5");
  if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) throw new Error("--radius must be positive");
  const radiusM = radiusMiles * 1609.344;
  const offline = arg("offline");
  const slug = `${lat.toFixed(4)}_${lon.toFixed(4)}_${radiusMiles}mi`.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const fixturePath = `research/fixtures/osm/discover_${slug}.json`;
  const query = `[out:json][timeout:60];(nwr["power"="substation"](around:${Math.round(
    radiusM,
  )},${lat},${lon});nwr["power"="plant"](around:${Math.round(
    radiusM,
  )},${lat},${lon}););out center tags;`;

  const loaded = offline
    ? await loadFixture("osm-overpass", offline, "json.overpass.elements", [
        `Offline discovery fixture. Query: ${query}`,
      ])
    : await fetchLive({
        sourceId: "osm-overpass",
        url: "https://overpass-api.de/api/interpreter",
        method: "POST",
        body: new TextEncoder().encode(`data=${encodeURIComponent(query)}`),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        parser: "json.overpass.elements",
        fixturePath,
      });

  const elements = (loaded.data as { elements?: RawOverpassElement[] }).elements ?? [];
  const candidates = elements
    .map((element) => {
      const center = element.center ?? (element.lat !== undefined && element.lon !== undefined
        ? { lat: element.lat, lon: element.lon }
        : null);
      if (!center) return null;
      return {
        osm: `${element.type}/${element.id}`,
        power: element.tags?.power ?? null,
        name: element.tags?.name ?? null,
        operator: element.tags?.operator ?? null,
        voltage: element.tags?.voltage ?? null,
        lat: center.lat,
        lon: center.lon,
        distance_mi: Number(haversineMiles(lat, lon, center.lat, center.lon).toFixed(2)),
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .filter((candidate) => candidate.distance_mi <= radiusMiles + 0.05)
    .sort((a, b) => a.distance_mi - b.distance_mi || a.osm.localeCompare(b.osm));

  const report = {
    schema: "mapergy.discovery/1",
    center: [lat, lon],
    radius_miles: radiusMiles,
    query,
    snapshot: loaded.snapshot,
    candidate_count: candidates.length,
    candidates,
  };
  const out = arg("out") ?? `research/discovery/${slug}.json`;
  const absolute = resolve(REPO_ROOT, out);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`discovered ${candidates.length} mapped power features within ${radiusMiles} mi`);
  for (const candidate of candidates.slice(0, 25)) {
    console.log(
      `  ${candidate.distance_mi.toFixed(2).padStart(6)} mi  ${candidate.power ?? "?"}  ` +
        `${candidate.name ?? "(unnamed)"}  ${candidate.voltage ? `${candidate.voltage} kV` : ""}`,
    );
  }
  if (candidates.length > 25) console.log(`  … ${candidates.length - 25} more in ${out}`);
  console.log(`wrote ${out}`);
}

async function commandReport() {
  const path = arg("bundle") ?? "public/evidence/westminster-100mi.json";
  const bundle = JSON.parse(await readFile(resolve(REPO_ROOT, path), "utf8")) as EvidenceBundle;
  const { report } = verifyBundle(bundle, { enforceFreshness: true });
  const out = arg("out") ?? `research/reports/${bundle.region.id}.md`;
  const absolute = resolve(REPO_ROOT, out);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, renderReport(bundle), "utf8");
  console.log(`wrote ${out} (${report.ok ? "verified" : "VERIFICATION FAILED"})`);
}

async function commandHash() {
  const path = arg("file") ?? process.argv[3];
  if (!path) throw new Error("usage: evidence:hash --file <path>");
  const bytes = new Uint8Array(await readFile(resolve(REPO_ROOT, path)));
  console.log(sha256BytesHex(bytes));
}

async function commandSources() {
  console.log(`registry ${computeRegistryDigest(SOURCE_REGISTRY)}`);
  for (const source of SOURCE_REGISTRY) {
    console.log(
      `${source.id.padEnd(24)} ${source.authority.padEnd(9)} ${source.access.kind.padEnd(9)} ${source.publisher}`,
    );
    console.log(`  ${source.access.endpoint}`);
  }
}

async function commandProfiles() {
  const profile = arg("profile") ?? "westminster-100mi";
  const loaded = await loadProfile(profile);
  console.log(JSON.stringify(loaded.profile, null, 2));
}

function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 3958.7613;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

interface RawOverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function renderReport(bundle: EvidenceBundle): string {
  const { report } = verifyBundle(bundle, { enforceFreshness: true });
  const byMethod = (method: string) =>
    bundle.claims.filter((claim) => claim.method === method).length;
  const lines: string[] = [
    `# Evidence report — ${bundle.region.name}`,
    "",
    `- Bundle: \`${bundle.bundle_id}\``,
    `- Schema: \`${bundle.schema}\``,
    `- Generated: ${bundle.generated_at}`,
    `- Verification: **${report.ok ? "PASS" : "FAIL"}**`,
    `- Claims: ${bundle.claims.length} (${byMethod("observed")} observed, ${byMethod(
      "derived",
    )} derived, ${byMethod("modeled")} modeled, ${byMethod("inferred")} inferred)`,
    `- Snapshots: ${bundle.snapshots.length}`,
    `- Registry: \`${bundle.registry_digest}\``,
    "",
    "## Sources",
    "",
    "| id | publisher | authority | license | endpoint |",
    "| --- | --- | --- | --- | --- |",
    ...bundle.sources.map(
      (source) =>
        `| \`${source.id}\` | ${source.publisher} | ${source.authority} | ${source.license} | \`${source.access.endpoint}\` |`,
    ),
    "",
    "## Snapshots",
    "",
    "| id | source | retrieved | bytes | sha256 | path |",
    "| --- | --- | --- | ---: | --- | --- |",
    ...bundle.snapshots.map(
      (snapshot) =>
        `| \`${snapshot.id}\` | \`${snapshot.source_id}\` | ${snapshot.retrieved_at} | ${snapshot.bytes} | \`${snapshot.sha256.slice(
          0,
          16,
        )}…\` | \`${snapshot.cache_path}\` |`,
    ),
    "",
    "## Disclosures",
    "",
    ...bundle.disclosures.map(
      (disclosure) => `- **${disclosure.severity}** ${disclosure.text}`,
    ),
    "",
    "## Verification",
    "",
    ...report.checks.map((check) => `- ${check.ok ? "✓" : "✗"} ${check.name} — ${check.detail}`),
    "",
  ];
  if (report.errors.length > 0) {
    lines.push("### Errors", "", ...report.errors.map((issue) => `- \`${issue.code}\` ${issue.detail}`), "");
  }
  if (report.warnings.length > 0) {
    lines.push(
      "### Warnings",
      "",
      ...report.warnings.map((issue) => `- \`${issue.code}\` ${issue.detail}`),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = {
  build: commandBuild,
  verify: commandVerify,
  discover: commandDiscover,
  report: commandReport,
  hash: commandHash,
  sources: commandSources,
  profiles: commandProfiles,
};

(async () => {
  const run = commands[command];
  if (!run) {
    console.log(
      "usage: tsx research/cli.ts <build|verify|discover|report|hash|sources|profiles> [flags]",
    );
    process.exitCode = 2;
    return;
  }
  try {
    await run();
  } catch (error) {
    console.error(`[evidence:${command}] ${(error as Error).message}`);
    process.exitCode = 1;
  }
})();
