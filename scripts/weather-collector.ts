import { refreshRecentWeather } from "../lib/scan/weather";

const INTERVAL_MS = 15 * 60 * 1000;
let stopped = false;

async function collect(): Promise<void> {
  try { await refreshRecentWeather(); }
  catch (error) { console.error("Weather collection failed:", error); }
}

async function main(): Promise<void> {
  await collect();
  while (!stopped) {
    await new Promise<void>((resolve) => setTimeout(resolve, INTERVAL_MS));
    if (!stopped) await collect();
  }
}

process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });
void main();
