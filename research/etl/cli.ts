import { readFile } from "node:fs/promises";
import { atomicJson, locationQuery, readReport, reportRevision, runLocation, verifyLocation } from "./pipeline";
import { backupReport, restoreReport } from "./backup";
import { reconcile } from "./reconcile";
import { coverageInventory } from "./coverage";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "location";
  if (command === "coverage") {
    if (args.length && (args.length !== 1 || args[0] !== "--strict")) throw new Error("Expected only --strict");
    const coverage = await coverageInventory();
    console.log(JSON.stringify(coverage));
    if (args.includes("--strict") && coverage.gaps.length) process.exitCode = 1;
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
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--live") {
      live = true;
      continue;
    }
    const value = args[++index];
    if (!["--lat", "--lon", "--radius", "--respondent", "--out"].includes(flag) ||
        !value || value.startsWith("--") || options.has(flag)) throw new Error(`Invalid argument: ${flag}`);
    options.set(flag, value);
  }
  const query = locationQuery(
    Number(options.get("--lat")), Number(options.get("--lon")),
    Number(options.get("--radius") ?? "100"), options.get("--respondent"),
  );
  const report = await runLocation(query, live);
  const out = options.get("--out");
  if (out) await atomicJson(out, report.evidence);
  if (live) console.error(JSON.stringify({ location: report.evidence.region.id, revision: reportRevision(report) }));
  process.stdout.write(JSON.stringify(report) + "\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
