import { readFile } from "node:fs/promises";
import { atomicJson, locationQuery, readReport, reportRevision, runLocation, verifyLocation } from "./pipeline";
import { backupAssets, backupReport, backupWeather, restoreAssets, restoreReport, restoreWeather } from "./backup";
import { reconcile } from "./reconcile";
import { coverageInventory } from "./coverage";
import { backfillWeather } from "./weather-history";
import { collectAssets, replayAssets } from "./assets";
import { auditSubstations } from "./substation-audit";
import { loadLocationAssets } from "./load-assets";
import { enableSharedDedupeFromEnv } from "./shared-dedupe";
import { backfillEia930 } from "./eia930-bulk";
import { runReconcileCommand } from "./reconcile-report";
import { runCrosswalkCandidatesCommand } from "./crosswalk-candidates";
import { runRatingsCommand } from "./ratings";
import { runOperatorImportCommand } from "./operator-import";

const RESULT_SENTINEL = "@@GRIDSENTINEL_RESULT@@";

type RegenCommand = (args: string[]) => Promise<unknown>;

async function main() {
  // Cross-process HTTP dedupe over Redis; a no-op unless REDIS_URL is set. An unusable
  // REDIS_URL (e.g. rediss://) degrades to process-local dedupe, like any other Redis error.
  try {
    enableSharedDedupeFromEnv();
  } catch (error) {
    console.error(`GridSentinel: shared HTTP dedupe disabled (${error instanceof Error ? error.message : String(error)})`);
  }
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "location";
  if (command === "load-assets") {
    console.log(JSON.stringify(await loadLocationAssets(args)));
    return;
  }
  if (command === "backup-assets") {
    if (args.length !== 3) throw new Error("Expected location ID, asset revision, and destination file");
    await backupAssets(args[0], args[1], args[2]);
    console.log(JSON.stringify({ backed_up: "assets", location: args[0], revision: args[1] }));
    return;
  }
  if (command === "restore-assets") {
    if (args.length !== 1) throw new Error("Expected backup file");
    console.log(JSON.stringify(await restoreAssets(args[0])));
    return;
  }
  if (command === "backup-weather") {
    if (args.length !== 2) throw new Error("Expected weather snapshot ID and destination file");
    await backupWeather(args[0], args[1]);
    console.log(JSON.stringify({ backed_up: "weather", snapshot: args[0] }));
    return;
  }
  if (command === "restore-weather") {
    if (args.length !== 1) throw new Error("Expected backup file");
    console.log(JSON.stringify(await restoreWeather(args[0])));
    return;
  }
  if (command === "audit-substations") {
    if (args.length !== 3) throw new Error("Expected OSM GeoJSON, HIFLD manifest, and reviewed crosswalk paths");
    console.log(JSON.stringify(await auditSubstations(args[0], args[1], args[2])));
    return;
  }
  if (command === "assets") {
    const [source, lat, lon, radius] = args;
    if (args.length !== 4 || [lat, lon, radius].some((value) => !value.trim())) {
      throw new Error("Expected assets <source> <lat> <lon> <radius-miles>");
    }
    console.log(JSON.stringify(await collectAssets(locationQuery(Number(lat), Number(lon), Number(radius)), source)));
    return;
  }
  if (command === "replay-assets") {
    if (args.length !== 1) throw new Error("Expected asset manifest path");
    console.log(JSON.stringify(await replayAssets(JSON.parse(await readFile(args[0], "utf8")))));
    return;
  }
  if (command === "backfill" && args[0] === "eia930") {
    const [, respondent, file, flag, url, ...extra] = args;
    if (!respondent || !/^[A-Z0-9]{2,8}$/.test(respondent) || !file || file.startsWith("--") || extra.length ||
        (flag !== undefined && (flag !== "--url" || !url || !URL.canParse(url)))) {
      throw new Error("Expected backfill eia930 <respondent> <balance-file> [--url <source-url>]");
    }
    console.log(JSON.stringify(await backfillEia930(file, respondent, url ? { url } : {})));
    return;
  }
  if (command === "backfill") {
    const [source, lat, lon, start, end] = args;
    if (source !== "weather" || args.length !== 5 || !lat.trim() || !lon.trim()) {
      throw new Error("Expected backfill weather <lat> <lon> <start-date> <end-date> or backfill eia930 <respondent> <balance-file> [--url <source-url>]");
    }
    console.log(JSON.stringify(await backfillWeather(Number(lat), Number(lon), start, end)));
    return;
  }
  if (command === "coverage") {
    if (args.length && (args.length !== 1 || args[0] !== "--strict")) throw new Error("Expected only --strict");
    const coverage = await coverageInventory();
    console.log(JSON.stringify(coverage));
    if (args.includes("--strict") && coverage.gaps.some((gap) => gap.status === "open")) process.exitCode = 1;
    return;
  }
  if (command === "reconcile") {
    // Prints the persisted reconciliation record itself.
    await runReconcileCommand(args);
    return;
  }
  if (command === "crosswalk-candidates") {
    console.log(JSON.stringify(await runCrosswalkCandidatesCommand(args)));
    return;
  }
  if (command === "ratings") {
    console.log(JSON.stringify(await runRatingsCommand(args)));
    return;
  }
  if (command === "operator-import") {
    console.log(JSON.stringify(await runOperatorImportCommand(args)));
    return;
  }
  if (command === "osm-regen" || command === "eia860") {
    // Loaded on demand so an unfinished regeneration module cannot break other commands.
    // Both entries print their own result.
    const run: RegenCommand | undefined = command === "osm-regen"
      ? ((await import("./osm-regen")) as { runOsmRegenCommand?: RegenCommand }).runOsmRegenCommand
      : ((await import("./eia860")) as { runEia860Command?: RegenCommand }).runEia860Command;
    if (typeof run !== "function") throw new Error(`${command} command is not available`);
    await run(args);
    return;
  }
  if (command === "verify" || command === "replay" || command === "backup") {
    const [id, revision, destination, ...extra] = args;
    if (!id || !revision || extra.length || (command === "backup") !== Boolean(destination)) {
      throw new Error("Expected location ID and revision, plus destination for backup");
    }
    const report = await readReport(id, revision);
    if (!report) throw new Error("Pinned report not found");
    await verifyLocation(report);
    if (command === "backup") await backupReport(report, destination);
    if (command === "replay") console.log(JSON.stringify(await runLocation(
      report.query, false, new Date(report.evidence.generated_at), report,
    )));
    else console.log(JSON.stringify({ verified: true, revision }));
    return;
  }
  if (command === "restore") {
    if (args.length !== 1) throw new Error("Expected backup file");
    const report = await restoreReport(args[0]);
    console.log(JSON.stringify({ location: report.evidence.region.id, revision: reportRevision(report) }));
    return;
  }
  if (command === "compare") {
    if (args.length !== 1) throw new Error("Expected comparison JSON file");
    const { left, right, policy } = JSON.parse(await readFile(args[0], "utf8"));
    console.log(JSON.stringify(reconcile(left, right, policy)));
    return;
  }
  if (command !== "location" && command !== "collect") throw new Error(`Unknown command: ${command}`);
  const options = new Map<string, string>();
  let live = command === "collect";
  let caiso = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--live") {
      live = true;
      continue;
    }
    if (flag === "--caiso") {
      if (caiso) throw new Error(`Invalid argument: ${flag}`);
      caiso = true;
      continue;
    }
    const value = args[++index];
    if (!["--lat", "--lon", "--radius", "--respondent", "--oasis-node", "--out"].includes(flag) ||
        !value || value.startsWith("--") || options.has(flag)) throw new Error(`Invalid argument: ${flag}`);
    options.set(flag, value);
  }
  const query = locationQuery(
    Number(options.get("--lat")), Number(options.get("--lon")),
    Number(options.get("--radius") ?? "100"), options.get("--respondent"), caiso, options.get("--oasis-node"),
  );
  const report = await runLocation(query, live);
  const out = options.get("--out");
  if (out) await atomicJson(out, report.evidence);
  // The service reads the last sentinel line; other stderr output (warnings, retries) is ignored.
  if (live) console.error(`${RESULT_SENTINEL} ${JSON.stringify({ location: report.evidence.region.id, revision: reportRevision(report) })}`);
  process.stdout.write(JSON.stringify(report) + "\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
