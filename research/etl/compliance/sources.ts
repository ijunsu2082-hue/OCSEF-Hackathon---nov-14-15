/*
 * ETL: the legal sources behind every compliance rule.
 *
 * The Compliance tab tells an owner which filings apply; that answer is only worth
 * anything if it says what the answer rests on. This job writes
 * public/compliance/legal-sources.json:
 *
 *   - the instruments each rule comes from (statute, regulation, general order, agency
 *     program), with the official URL the rule cites;
 *   - the page the extraction actually read for that form, when it was read, whether it
 *     was read at all, and how many field labels and quoted excerpts came back.
 *
 * It reads only files already in the repo (lib/owner/rules.ts and the forms snapshot),
 * so it runs without the network: npm run compliance:sources -- --offline is honoured
 * for symmetry with the other jobs, and changes nothing.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { RULES } from "../../../lib/owner/rules";
import type { ExtractionStatus, FormCatalog } from "../../../lib/owner/forms";
import { atomicJson } from "../pipeline";

export const DEFAULT_SOURCES_OUT = "public/compliance/legal-sources.json";
export const DEFAULT_FORMS_PATH = "public/compliance/forms.json";

export const SOURCES_SCHEMA = "compliance-sources/1";

export interface SourceInstrument {
  /** e.g. "CARB Mandatory GHG Reporting, 17 CCR 95103" */
  label: string;
  /** Official source page. */
  url: string;
}

export interface SourcePage {
  url: string;
  /** When the ETL read this page, if it did. */
  retrieved_at: string | null;
  /** extracted = read; partial = read, field list incomplete; manual = not read. */
  status: ExtractionStatus;
  /** Field labels the page gave us. */
  fields: number;
  /** Quoted excerpts the extraction kept as evidence. */
  excerpts: number;
}

export interface RuleSources {
  rule_id: string;
  title: string;
  agency: string;
  form: string;
  /** The instruments an owner can point at. */
  instruments: SourceInstrument[];
  /** The pages the ETL read to learn the form and its fields. */
  pages: SourcePage[];
}

export interface LegalSourcesFile {
  schema: typeof SOURCES_SCHEMA;
  generated_at: string;
  forms_generated_at: string | null;
  summary: {
    rules: number;
    instruments: number;
    pages: number;
    pages_read: number;
    pages_unread: number;
  };
  rules: Record<string, RuleSources>;
}

export interface SourcesOptions {
  out?: string;
  formsPath?: string;
  /** Accepted for symmetry with the other compliance jobs; this one reads no network. */
  offline?: boolean;
  now?: Date;
}

function emptySummary(): LegalSourcesFile["summary"] {
  return { rules: 0, instruments: 0, pages: 0, pages_read: 0, pages_unread: 0 };
}

export function buildLegalSources(catalog: FormCatalog | null, now: Date = new Date()): LegalSourcesFile {
  const rules: Record<string, RuleSources> = {};
  const summary = emptySummary();

  for (const [id, rule] of Object.entries(RULES)) {
    const form = catalog?.entries[id] ?? null;
    const instruments: SourceInstrument[] = (rule.citations ?? []).map((c) => ({ label: c.label, url: c.url }));
    const pages: SourcePage[] = [];
    if (form?.sourceUrl) {
      pages.push({
        url: form.sourceUrl,
        retrieved_at: form.retrievedAt,
        status: form.status,
        fields: form.fields.length,
        excerpts: form.evidence.length,
      });
    }

    rules[id] = {
      rule_id: id,
      title: rule.title,
      agency: rule.agency,
      form: rule.form,
      instruments,
      pages,
    };

    summary.rules += 1;
    summary.instruments += instruments.length;
    summary.pages += pages.length;
    for (const page of pages) {
      if (page.status === "manual") summary.pages_unread += 1;
      else summary.pages_read += 1;
    }
  }

  return {
    schema: SOURCES_SCHEMA,
    generated_at: now.toISOString(),
    forms_generated_at: catalog?.generated_at ?? null,
    summary,
    rules,
  };
}

async function readCatalog(path: string): Promise<FormCatalog | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as FormCatalog;
    return parsed && parsed.entries ? parsed : null;
  } catch {
    return null;
  }
}

export async function syncLegalSources(
  options: SourcesOptions = {},
): Promise<{ out: string } & LegalSourcesFile["summary"]> {
  const catalog = await readCatalog(options.formsPath ?? DEFAULT_FORMS_PATH);
  const file = buildLegalSources(catalog, options.now ?? new Date());
  const out = options.out ?? DEFAULT_SOURCES_OUT;
  await atomicJson(out, file);
  return { out, ...file.summary };
}
