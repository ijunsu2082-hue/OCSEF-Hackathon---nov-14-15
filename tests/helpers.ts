import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Repo root (tests/ sits one level below it). */
export const ROOT = join(__dirname, "..");

/**
 * lib/scan/data.ts loads layers with fetch("/layers/..."). In tests we stub
 * fetch so those URLs read the real files from public/.
 */
export function stubFetchFromPublic(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("/")) throw new Error(`test fetch stub: no network (${url})`);
    try {
      const body = readFileSync(join(ROOT, "public", url));
      return new Response(body, { status: 200 });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;
}

export function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T;
}

/** Minimal CSV reader (no quoted fields in these files). */
export function readCsv(rel: string, headerStartsWith: string): Record<string, string>[] {
  const lines = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(headerStartsWith));
  if (start < 0) throw new Error(`no header "${headerStartsWith}" in ${rel}`);
  const head = lines[start].split(",");
  const out: Record<string, string>[] = [];
  for (const l of lines.slice(start + 1)) {
    if (!l.trim()) continue;
    const c = l.split(",");
    out.push(Object.fromEntries(head.map((h, i) => [h, c[i]])));
  }
  return out;
}
