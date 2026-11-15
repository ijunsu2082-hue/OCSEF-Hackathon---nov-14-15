/*
 * Legal sources behind the compliance rules (written by
 * research/etl/compliance/sources.ts).
 *
 * For each rule the ETL records the instruments an owner can point at (statute,
 * regulation, general order, program page) and the page it actually read to learn the
 * form's fields, with the date and whether the read succeeded. The Compliance tab shows
 * these next to the decision, so "this applies" comes with the law and the record it
 * rests on.
 */
import type { ExtractionStatus } from "./forms";

export const LEGAL_SOURCES_SCHEMA = "compliance-sources/1";

export interface LegalInstrument {
  label: string;
  url: string;
}

export interface LegalPage {
  url: string;
  retrieved_at: string | null;
  status: ExtractionStatus;
  fields: number;
  excerpts: number;
}

export interface RuleSources {
  rule_id: string;
  title: string;
  agency: string;
  form: string;
  instruments: LegalInstrument[];
  pages: LegalPage[];
}

export interface LegalSourcesFile {
  schema: string;
  generated_at: string;
  forms_generated_at: string | null;
  summary: { rules: number; instruments: number; pages: number; pages_read: number; pages_unread: number };
  rules: Record<string, RuleSources>;
}

let pending: Promise<LegalSourcesFile | null> | null = null;

export function loadLegalSources(): Promise<LegalSourcesFile | null> {
  if (!pending) {
    pending = fetch("/compliance/legal-sources.json")
      .then(async (res) => {
        if (!res.ok) return null;
        const data = (await res.json()) as LegalSourcesFile;
        return data && data.rules ? data : null;
      })
      .catch(() => null);
  }
  return pending;
}
