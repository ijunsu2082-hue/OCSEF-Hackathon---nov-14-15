/*
 * ETL: read the government form behind each owner filing.
 *
 * The owner engine (lib/owner/obligations.ts) decides *which* filings apply to an
 * asset from its infrastructure and its location. That was all typed by hand. This
 * module goes and reads the agency's own page for that filing, copies the evidence,
 * and reads what the form asks for: its designation, its deadline sentence, whether
 * it is filed or signed, and the field labels on it.
 *
 * Rules for honest extraction:
 *   - Every field label we keep must appear on the page; a label we did not see is
 *     not invented here.
 *   - A field with no public-data key stays manual. That is how a person is told
 *     what only they can fill in.
 *   - When a page cannot be read (a PDF, a block, a timeout) the entry is marked
 *     "manual" and keeps the link, so the UI can send the person to the form
 *     instead of pretending the fields were extracted.
 */
import type {
  ExtractedForm,
  ExtractionStatus,
  FormAction,
  FormCatalog,
  FormEvidence,
  FormFieldSpec,
} from "../../../lib/owner/forms";

/* ------------------------------------------------------------- sources */

export interface RuleRef {
  id: string;
  title: string;
  agency: string;
  form: string;
  formUrl: string;
  dueRule: string;
}

export interface FormSource {
  rule: RuleRef;
  /** The page the ETL reads. */
  url: string;
}

/** One source per filing rule: the agency page named in the rule's own citation. */
export function formSources(rules: Record<string, RuleRef>): FormSource[] {
  const out: FormSource[] = [];
  const seen = new Set<string>();
  for (const rule of Object.values(rules)) {
    if (seen.has(rule.id)) continue;
    seen.add(rule.id);
    out.push({ rule, url: rule.formUrl });
  }
  return out.sort((a, b) => a.rule.id.localeCompare(b.rule.id));
}

/* ------------------------------------------------------------- text */

/** Read HTML as plain text, keeping block boundaries as line breaks. */
export function readableText(input: string): string {
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|tr|li|h[1-6]|section|table|td|th)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** <title> of an HTML page, or null. */
export function titleFromHtml(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const text = readableText(m[1]);
  return text || null;
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

export function sentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

function firstSentence(sentences: string[], pattern: RegExp, max = 240): string | null {
  for (const s of sentences) {
    if (!pattern.test(s)) continue;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }
  return null;
}

/* ------------------------------------------------------------- what a form asks for */

/**
 * Field vocabulary. Each entry is a phrase that agencies actually print on their
 * forms or instructions; `key` names the public-data property it is filled from, and
 * null means a person has to supply it.
 */
const FIELD_VOCAB: { label: string; key: FormFieldSpec["key"]; patterns: RegExp[] }[] = [
  { label: "Plant name", key: "plant_name", patterns: [/\bplant name\b/i, /\bfacility name\b/i] },
  { label: "Plant ID (EIA plant code)", key: "plant_code", patterns: [/\bplant (?:id|code)\b/i, /\beia (?:plant )?(?:id|code)\b/i] },
  { label: "Owner or operator", key: "operator", patterns: [/\boperator\b/i, /\bowner(?:'s)? name\b/i, /\butility name\b/i] },
  { label: "County", key: "county", patterns: [/\bcounty\b/i] },
  { label: "City", key: "city", patterns: [/\bcity\b/i] },
  { label: "Rated capacity (MW)", key: "capacity_mw", patterns: [/\bnameplate\b/i, /\brated capacity\b/i, /\bcapacity \(mw\)/i] },
  { label: "Primary fuel", key: "primary_source", patterns: [/\bprimary (?:fuel|energy source)\b/i, /\bfuel type\b/i] },
  { label: "Voltage (kV)", key: "voltage_kv", patterns: [/\bvoltage\b/i, /\bkilovolt/i] },
  { label: "Number of generators or units", key: "generators", patterns: [/\bnumber of (?:generators|units)\b/i, /\bgenerator (?:id|count)\b/i] },
  { label: "Line length (mi)", key: "line_length_mi", patterns: [/\bline length\b/i, /\bcircuit miles\b/i] },
  { label: "Latitude", key: "latitude", patterns: [/\blatitude\b/i] },
  { label: "Longitude", key: "longitude", patterns: [/\blongitude\b/i] },
  { label: "Street address of the site", key: null, patterns: [/\bstreet address\b/i, /\bsite address\b/i, /\bmailing address\b/i] },
  { label: "Reporting contact (name, title, phone, email)", key: null, patterns: [/\bcontact (?:name|person)\b/i, /\bdesignated (?:representative|contact)\b/i] },
  { label: "Emissions or throughput figures", key: null, patterns: [/\bmetric tons\b/i, /\bemissions? (?:data|report|total)\b/i, /\bheat input\b/i] },
  { label: "Permit, registration or facility ID from the agency", key: null, patterns: [/\bpermit (?:number|no\.?|id)\b/i, /\bfacility id\b/i, /\bregistration (?:number|id)\b/i, /\breporting id\b/i] },
  { label: "Signature of the authorized official", key: null, patterns: [/\bsignature\b/i, /\bcertif(?:y|ication)\b/i, /\bverification statement\b/i] },
];

/** Field labels the page actually carries, in vocabulary order, without duplicates. */
export function detectFields(text: string): FormFieldSpec[] {
  const out: FormFieldSpec[] = [];
  const seen = new Set<string>();
  for (const item of FIELD_VOCAB) {
    if (!item.patterns.some((re) => re.test(text))) continue;
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    out.push({ label: item.label, key: item.key });
  }
  return out;
}

const SIGN_RE = /\bsignature\b|\bsigned by\b|\bcertif(?:y|ication)\b|\bverification statement\b|\bdesignated representative\b/i;

/* ------------------------------------------------------------- per-form seeds */

interface FormSeed {
  match: RegExp;
  jurisdiction: string;
  action: FormAction;
  /** Fields the form is known to ask for; merged with whatever the page yields. */
  fields: FormFieldSpec[];
}

const F = (label: string, key: FormFieldSpec["key"] = null): FormFieldSpec => ({ label, key });

const CONTACT = F("Reporting contact (name, title, phone, email)");
const SIGNATURE = F("Signature of the authorized official");

const SEEDS: FormSeed[] = [
  {
    match: /^eia-/,
    jurisdiction: "United States (federal)",
    action: "file",
    fields: [
      F("Plant name", "plant_name"),
      F("Plant ID (EIA plant code)", "plant_code"),
      F("Owner or operator", "operator"),
      F("County", "county"),
      F("City", "city"),
      F("Rated capacity (MW)", "capacity_mw"),
      F("Primary fuel", "primary_source"),
      F("Voltage (kV)", "voltage_kv"),
      F("Number of generators or units", "generators"),
      F("Latitude", "latitude"),
      F("Longitude", "longitude"),
      CONTACT,
      SIGNATURE,
    ],
  },
  {
    match: /^cec-/,
    jurisdiction: "California",
    action: "file",
    fields: [
      F("Plant name", "plant_name"),
      F("Plant ID (EIA plant code)", "plant_code"),
      F("Owner or operator", "operator"),
      F("Rated capacity (MW)", "capacity_mw"),
      F("Primary fuel", "primary_source"),
      F("County", "county"),
      F("CEC generating facility ID"),
      F("Monthly fuel use and net generation"),
      SIGNATURE,
    ],
  },
  {
    match: /^carb-mrr/,
    jurisdiction: "California",
    action: "sign",
    fields: [
      F("Plant name", "plant_name"),
      F("Plant ID (EIA plant code)", "plant_code"),
      F("Owner or operator", "operator"),
      F("County", "county"),
      F("Rated capacity (MW)", "capacity_mw"),
      F("Primary fuel", "primary_source"),
      F("CARB reporting ID"),
      F("Emissions by source (metric tons CO2e)"),
      F("Verification statement from an accredited verifier"),
      SIGNATURE,
    ],
  },
  {
    match: /^epa-ghgrp$/,
    jurisdiction: "United States (federal)",
    action: "sign",
    fields: [
      F("Plant name", "plant_name"),
      F("Plant ID (EIA plant code)", "plant_code"),
      F("Owner or operator", "operator"),
      F("County", "county"),
      F("Rated capacity (MW)", "capacity_mw"),
      F("Primary fuel", "primary_source"),
      F("EPA facility ID (GHGRP)"),
      F("Total emissions (metric tons CO2e)"),
      F("Designated representative and alternate"),
      SIGNATURE,
    ],
  },
  {
    match: /^epa-part75/,
    jurisdiction: "United States (federal)",
    action: "file",
    fields: [
      F("Plant name", "plant_name"),
      F("Plant ID (EIA plant code)", "plant_code"),
      F("Owner or operator", "operator"),
      F("Rated capacity (MW)", "capacity_mw"),
      F("ORIS and unit IDs"),
      F("Monitoring plan and QA test results"),
      F("Quarterly heat input and NOx data"),
      SIGNATURE,
    ],
  },
  {
    match: /^ferc-/,
    jurisdiction: "United States (federal)",
    action: "file",
    fields: [
      F("Owner or operator", "operator"),
      F("Plant name", "plant_name"),
      F("Plant ID (EIA plant code)", "plant_code"),
      F("Rated capacity (MW)", "capacity_mw"),
      F("Voltage (kV)", "voltage_kv"),
      F("FERC company identification"),
      CONTACT,
      SIGNATURE,
    ],
  },
  {
    match: /^nerc-gads/,
    jurisdiction: "United States (federal)",
    action: "file",
    fields: [
      F("Owner or operator", "operator"),
      F("Plant name", "plant_name"),
      F("Plant ID (EIA plant code)", "plant_code"),
      F("Rated capacity (MW)", "capacity_mw"),
      F("Number of generators or units", "generators"),
      F("NERC registering entity ID"),
      F("Unit event dates and outage data"),
    ],
  },
  {
    match: /^scaqmd-/,
    jurisdiction: "South Coast AQMD (Los Angeles, Orange, Riverside, San Bernardino counties)",
    action: "sign",
    fields: [
      F("Plant name", "plant_name"),
      F("Plant ID (EIA plant code)", "plant_code"),
      F("Owner or operator", "operator"),
      F("County", "county"),
      F("Rated capacity (MW)", "capacity_mw"),
      F("Primary fuel", "primary_source"),
      F("AQMD facility ID"),
      F("Annual emissions by equipment"),
      SIGNATURE,
    ],
  },
  {
    match: /^(go95|go165|go174|go167c)-/,
    jurisdiction: "California",
    action: "sign",
    fields: [
      F("Owner or operator", "operator"),
      F("Voltage (kV)", "voltage_kv"),
      F("Line length (mi)", "line_length_mi"),
      F("Latitude", "latitude"),
      F("Longitude", "longitude"),
      F("CPUC utility identification"),
      F("Inspection, incident or maintenance record"),
      SIGNATURE,
    ],
  },
  {
    match: /^(oeis|wsab)-/,
    jurisdiction: "California",
    action: "sign",
    fields: [
      F("Owner or operator", "operator"),
      F("County", "county"),
      F("Voltage (kV)", "voltage_kv"),
      F("Line length (mi)", "line_length_mi"),
      F("Wildfire mitigation plan revision"),
      F("Authorized official signature"),
    ],
  },
];

/** Fallback when no family matches: identity only, everything else is manual. */
const GENERIC_SEED: FormSeed = {
  match: /.*/,
  jurisdiction: "Check the agency page for the jurisdiction",
  action: "file",
  fields: [
    F("Facility or asset name", "plant_name"),
    F("Owner or operator", "operator"),
    F("County", "county"),
    F("Voltage (kV)", "voltage_kv"),
    CONTACT,
    SIGNATURE,
  ],
};

export function seedFor(rule: RuleRef): FormSeed {
  return SEEDS.find((s) => s.match.test(rule.id)) ?? GENERIC_SEED;
}

/* ------------------------------------------------------------- extraction */

export interface ExtractionInput {
  url: string;
  /** The fetched bytes as text (HTML or plain text). */
  body: string;
  pageTitle?: string | null;
  rule: RuleRef;
}

export interface Extraction {
  formId: string | null;
  pageTitle: string | null;
  dueText: string | null;
  action: FormAction | null;
  fields: FormFieldSpec[];
  evidence: FormEvidence[];
  /** What could not be read, in plain words. */
  gaps: string[];
}

const FORM_ID_RE =
  /\b(?:Form\s+)?(EIA-\d{3}[A-Z]?|CEC-\d{4}|GO\s?\d{2,3}(?:-[A-Z])?|Form\s+[A-Z0-9]{1,2}(?:-[A-Z])?|FERC Form No\.?\s*\d+(?:-Q)?)\b/i;

export function detectFormId(text: string, rule: RuleRef): string | null {
  if (text.toLowerCase().includes(rule.form.toLowerCase())) return rule.form;
  const m = FORM_ID_RE.exec(text);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}

const DUE_RE =
  /\b(?:is|are)? ?due\b|\bno later than\b|\bmust be (?:filed|submitted|received)\b|\bdeadline\b|\bfiled? by\b|\bsubmit(?:ted)? by\b|\bpostmarked by\b/i;

export function extractFormDocument(input: ExtractionInput): Extraction {
  const text = readableText(input.body);
  const list = sentences(text);
  const fields = detectFields(text);
  const formId = detectFormId(text, input.rule);
  const dueText = firstSentence(list, DUE_RE) ?? null;
  const action: FormAction | null = SIGN_RE.test(text) ? "sign" : null;

  const evidence: FormEvidence[] = [];
  if (formId) {
    const line = list.find((s) => s.toLowerCase().includes(formId.toLowerCase()));
    evidence.push({ url: input.url, excerpt: line ?? `Form designation ${formId}` });
  }
  if (dueText) evidence.push({ url: input.url, excerpt: dueText });
  if (fields.length > 0) {
    evidence.push({
      url: input.url,
      excerpt: `Field labels read on the page: ${fields.map((f) => f.label).join("; ")}`,
    });
  }

  const gaps: string[] = [];
  if (!formId) gaps.push("The form designation was not on the page.");
  if (!dueText) gaps.push("No deadline sentence was found; the rule's own text is used.");
  if (fields.length === 0) gaps.push("No field labels were read on the page.");

  return { formId, pageTitle: input.pageTitle ?? null, dueText, action, fields, evidence, gaps };
}

/* ------------------------------------------------------------- catalog */

export interface MergeInput {
  rule: RuleRef;
  extraction: Extraction | null;
  retrievedAt: string | null;
  sha256: string | null;
  /** Why the page could not be read, when it could not. */
  unreachable?: string;
}

function mergeFields(extracted: FormFieldSpec[], seeded: FormFieldSpec[]): FormFieldSpec[] {
  const out: FormFieldSpec[] = [];
  const seen = new Set<string>();
  for (const field of [...extracted, ...seeded]) {
    const key = field.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(field);
  }
  return out;
}

export function mergeFormEntry(input: MergeInput): ExtractedForm {
  const seed = seedFor(input.rule);
  const extracted = input.extraction;
  const fields = mergeFields(extracted?.fields ?? [], seed.fields);
  const action = extracted?.action ?? seed.action;

  let status: ExtractionStatus;
  if (input.unreachable || !extracted) status = "manual";
  else if (extracted.formId && extracted.fields.length > 0) status = "extracted";
  else if (fields.length > 0) status = "partial";
  else status = "manual";

  const evidence: FormEvidence[] = extracted?.evidence ?? [];
  if (input.unreachable) evidence.push({ url: input.rule.formUrl, excerpt: input.unreachable });

  return {
    ruleId: input.rule.id,
    form: extracted?.formId ?? input.rule.form,
    title: input.rule.title,
    agency: input.rule.agency,
    jurisdiction: seed.jurisdiction,
    action,
    status,
    formUrl: input.rule.formUrl,
    sourceUrl: input.rule.formUrl,
    retrievedAt: input.retrievedAt,
    sha256: input.sha256,
    dueText: extracted?.dueText ?? null,
    evidence: evidence.slice(0, 4),
    fields,
  };
}

export function buildCatalog(entries: ExtractedForm[], generatedAt: string): FormCatalog {
  const byId: Record<string, ExtractedForm> = {};
  for (const entry of entries) byId[entry.ruleId] = entry;
  return { schema: "compliance-forms/1", generated_at: generatedAt, entries: byId };
}

/** The extracted form's own words for what it is, for a page title. */
export function entryHeading(entry: ExtractedForm): string {
  return `${entry.form} — ${entry.title}`;
}
