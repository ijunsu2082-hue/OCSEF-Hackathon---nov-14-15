/*
 * ETL: build public/compliance/forms.json.
 *
 * One pass over the owner filing rules. For each rule the ETL reads the agency's own
 * page (through the shared HTTP layer, so retries, per-host limits and ETag reuse all
 * apply), extracts the form, and writes a snapshot the app reads. A page that cannot
 * be read is recorded as manual, with its URL, instead of being skipped silently.
 *
 *   npm run compliance:forms            # read the live agency pages
 *   npm run compliance:forms -- --offline   # no network: seeds only, marked manual
 */
import { createHash } from "node:crypto";
import { RULES } from "../../../lib/owner/rules";
import { atomicJson } from "../pipeline";
import { requestBytes } from "../http";
import { buildCatalog, extractFormDocument, formSources, mergeFormEntry, titleFromHtml } from "./forms";

export const DEFAULT_OUT = "public/compliance/forms.json";
const MAX_BYTES = 4 * 1024 * 1024;

export interface SyncOptions {
  /** Skip the network; every form is recorded as manual so the snapshot is still usable. */
  offline?: boolean;
  out?: string;
  /** Read at most this many rule sources (for a quick check). */
  limit?: number;
}

export interface SyncSummary {
  out: string;
  forms: number;
  extracted: number;
  partial: number;
  manual: number;
  sources_read: number;
  sources_failed: number;
}

function looksPdf(url: string, contentType: string | null): boolean {
  if (/\.pdf(?:$|[?#])/i.test(url)) return true;
  return !!contentType && /application\/pdf/i.test(contentType);
}

export async function syncComplianceForms(options: SyncOptions = {}): Promise<SyncSummary> {
  const out = options.out ?? DEFAULT_OUT;
  const sources = formSources(RULES);
  const selected = options.limit && options.limit > 0 ? sources.slice(0, options.limit) : sources;

  const entries = [];
  let extracted = 0;
  let partial = 0;
  let manual = 0;
  let read = 0;
  let failed = 0;

  for (const { rule, url } of selected) {
    if (options.offline) {
      const entry = mergeFormEntry({
        rule,
        extraction: null,
        retrievedAt: null,
        sha256: null,
        unreachable: "Offline run: the agency page was not read.",
      });
      manual += 1;
      entries.push(entry);
      continue;
    }

    try {
      const response = await requestBytes(new URL(url), {
        accept: "text/html,application/xhtml+xml",
        userAgent: process.env.COMPLIANCE_USER_AGENT || "GridSentinel/1.0 (compliance form extraction)",
        maxBytes: MAX_BYTES,
        timeoutMs: 20000,
      });
      const contentType = response.headers.get("content-type");
      if (looksPdf(url, contentType)) {
        // A PDF's field names are not read here: say so, keep the link, mark it manual.
        const entry = mergeFormEntry({
          rule,
          extraction: null,
          retrievedAt: new Date().toISOString(),
          sha256: createHash("sha256").update(response.bytes).digest("hex"),
          unreachable: "The agency publishes this form as a PDF. Its fields must be read from the form itself; the labels below are the ones this filing is known to ask for.",
        });
        manual += 1;
        entries.push(entry);
        continue;
      }

      const body = Buffer.from(response.bytes).toString("utf8");
      const extraction = extractFormDocument({
        url,
        body,
        pageTitle: titleFromHtml(body),
        rule,
      });
      read += 1;
      const entry = mergeFormEntry({
        rule,
        extraction,
        retrievedAt: new Date().toISOString(),
        sha256: createHash("sha256").update(response.bytes).digest("hex"),
      });
      if (entry.status === "extracted") extracted += 1;
      else if (entry.status === "partial") partial += 1;
      else manual += 1;
      entries.push(entry);
    } catch (error) {
      failed += 1;
      entries.push(
        mergeFormEntry({
          rule,
          extraction: null,
          retrievedAt: null,
          sha256: null,
          unreachable: `Could not read the page: ${error instanceof Error ? error.message : "unknown error"}. Open the form to check what it asks for.`,
        }),
      );
      manual += 1;
    }
  }

  const catalog = buildCatalog(entries, new Date().toISOString());
  await atomicJson(out, catalog);

  return {
    out,
    forms: entries.length,
    extracted,
    partial,
    manual,
    sources_read: read,
    sources_failed: failed,
  };
}
