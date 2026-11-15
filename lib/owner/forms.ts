/*
 * Government form contract and prefill resolver.
 *
 * The form catalog is produced by the ETL (research/etl/compliance) by reading each
 * agency's own page for a filing: research/etl/cli.ts compliance-forms writes
 * public/compliance/forms.json. This module reads that snapshot, and turns an
 * applicable filing (lib/owner/obligations.ts) into a worksheet: the fields we can
 * prefill from public data, and the fields a person must fill or sign themselves.
 *
 * Nothing here invents a value. A field with no public-data key, or with a key whose
 * value the asset does not carry, is listed as waiting for manual input.
 */
import { FUEL_LABELS } from "../scan/colors";
import { lineMiles, lineName, substationName } from "../scan/labels";
import type { Obligation, OwnedAsset } from "./types";

/* ------------------------------------------------------------- extraction contract */

/** Asset properties a form field can be filled from. */
export const ASSET_FIELD_KEYS = [
  "plant_code",
  "plant_name",
  "operator",
  "county",
  "city",
  "capacity_mw",
  "primary_source",
  "voltage_kv",
  "generators",
  "line_length_mi",
  "osm_id",
  "latitude",
  "longitude",
] as const;

export type AssetFieldKey = (typeof ASSET_FIELD_KEYS)[number];

export function isAssetFieldKey(value: unknown): value is AssetFieldKey {
  return typeof value === "string" && (ASSET_FIELD_KEYS as readonly string[]).includes(value);
}

/** A filing is either sent in, or signed by an authorized person. */
export type FormAction = "file" | "sign";

/** extracted = read from the agency page; partial = form known, fields only partly read;
 *  manual = the page could not be read, so a person has to read the form. */
export type ExtractionStatus = "extracted" | "partial" | "manual";

export interface FormFieldSpec {
  label: string;
  /** Public-data property this field is filled from, or null when a person must supply it. */
  key: AssetFieldKey | null;
}

export interface FormEvidence {
  url: string;
  /** Words copied from the agency page that the extraction rests on. */
  excerpt: string;
}

export interface ExtractedForm {
  ruleId: string;
  form: string;
  title: string;
  agency: string;
  /** Where the filing applies, in plain words. */
  jurisdiction: string;
  action: FormAction;
  status: ExtractionStatus;
  formUrl: string;
  sourceUrl: string;
  retrievedAt: string | null;
  sha256: string | null;
  /** The deadline sentence copied from the source, if the page carried one. */
  dueText: string | null;
  evidence: FormEvidence[];
  fields: FormFieldSpec[];
}

export interface FormCatalog {
  schema: "compliance-forms/1";
  generated_at: string;
  entries: Record<string, ExtractedForm>;
}

/* ------------------------------------------------------------- catalog loader */

let catalogPromise: Promise<FormCatalog | null> | null = null;

/** The ETL snapshot, or null when it has not been generated or cannot be read. */
export function loadFormCatalog(): Promise<FormCatalog | null> {
  if (!catalogPromise) {
    catalogPromise = fetch("/compliance/forms.json")
      .then(async (res) => {
        if (!res.ok) return null;
        const data = (await res.json()) as FormCatalog;
        return data && data.schema === "compliance-forms/1" && data.entries ? data : null;
      })
      .catch(() => null);
  }
  return catalogPromise;
}

/* ------------------------------------------------------------- prefill */

const SOURCE_EIA = "EIA-860 2025";
const SOURCE_OSM = "OpenStreetMap";

function mwText(n: number): string {
  const r = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${r.toLocaleString("en-US")} MW`;
}

function kvText(n: number | null): string | null {
  return n == null || !Number.isFinite(n) ? null : `${Math.round(n)} kV`;
}

/** Value of one asset property, and the public source it came from. */
export function assetFieldValue(
  asset: OwnedAsset,
  key: AssetFieldKey,
): { value: string; source: string } | null {
  if (asset.kind === "plant") {
    const p = asset.plant;
    switch (key) {
      case "plant_code":
        return { value: String(p.plant_code), source: SOURCE_EIA };
      case "plant_name":
        return p.plant_name.trim() ? { value: p.plant_name.trim(), source: SOURCE_EIA } : null;
      case "operator":
        return p.utility_name.trim() ? { value: p.utility_name.trim(), source: SOURCE_EIA } : null;
      case "county":
        return p.county.trim() ? { value: p.county, source: SOURCE_EIA } : null;
      case "city":
        return p.city.trim() ? { value: p.city, source: SOURCE_EIA } : null;
      case "capacity_mw":
        return p.nameplate_mw > 0 ? { value: mwText(p.nameplate_mw), source: SOURCE_EIA } : null;
      case "primary_source":
        return { value: FUEL_LABELS[p.primary_source] ?? "Other", source: SOURCE_EIA };
      case "voltage_kv": {
        const v = kvText(p.grid_voltage_kv);
        return v ? { value: v, source: SOURCE_EIA } : null;
      }
      case "generators":
        return p.generator_count > 0
          ? { value: String(p.generator_count), source: SOURCE_EIA }
          : null;
      case "latitude":
        return { value: p.lat.toFixed(5), source: SOURCE_EIA };
      case "longitude":
        return { value: p.lon.toFixed(5), source: SOURCE_EIA };
      default:
        return null;
    }
  }

  if (asset.kind === "substation") {
    const s = asset.substation;
    switch (key) {
      case "plant_name":
        return { value: substationName(s), source: SOURCE_OSM };
      case "operator":
        return s.operator ? { value: s.operator, source: SOURCE_OSM } : null;
      case "voltage_kv": {
        const v = kvText(s.voltage_kv);
        return v ? { value: v, source: s.kv_inferred ? `${SOURCE_OSM} (from connected lines)` : SOURCE_OSM } : null;
      }
      case "osm_id":
        return { value: s.osm_id, source: SOURCE_OSM };
      case "latitude":
        return { value: s.lat.toFixed(5), source: SOURCE_OSM };
      case "longitude":
        return { value: s.lon.toFixed(5), source: SOURCE_OSM };
      default:
        return null;
    }
  }

  const l = asset.line;
  switch (key) {
    case "plant_name":
      return { value: lineName(l), source: SOURCE_OSM };
    case "operator":
      return l.operator ? { value: l.operator, source: SOURCE_OSM } : null;
    case "voltage_kv": {
      const v = kvText(l.voltage_kv);
      return v ? { value: v, source: l.kv_inferred ? `${SOURCE_OSM} (from connected lines)` : SOURCE_OSM } : null;
    }
    case "line_length_mi": {
      const miles = lineMiles(l);
      return miles > 0
        ? { value: `${miles >= 10 ? Math.round(miles) : Math.round(miles * 10) / 10} mi`, source: "Computed from OpenStreetMap geometry" }
        : null;
    }
    case "osm_id":
      return { value: String(l.osm_id), source: SOURCE_OSM };
    default:
      return null;
  }
}

/** Identity fields used when the ETL could not read the form's own field list. */
const GENERIC_FIELDS: FormFieldSpec[] = [
  { label: "Facility name", key: "plant_name" },
  { label: "Owner or operator", key: "operator" },
  { label: "County", key: "county" },
  { label: "Voltage", key: "voltage_kv" },
  { label: "Latitude", key: "latitude" },
  { label: "Longitude", key: "longitude" },
];

export interface WorksheetField {
  label: string;
  /** Prefilled value, or null when a person must supply it. */
  value: string | null;
  source: string | null;
}

export interface FormWorksheet {
  obligation: Obligation;
  /** The extracted form, or null when no catalog entry exists. */
  form: ExtractedForm | null;
  /** Fields filled from public data. */
  prefilled: WorksheetField[];
  /** Field labels a person must fill or sign themselves. */
  awaiting: string[];
}

/**
 * One worksheet per applicable filing: what the agency's form asks for, which of those
 * fields public data fills, and which must be filled or signed by a person.
 */
export function resolveWorksheet(
  asset: OwnedAsset,
  obligation: Obligation,
  catalog: FormCatalog | null,
): FormWorksheet {
  const form = catalog?.entries[obligation.id] ?? null;
  const specs = form && form.fields.length > 0 ? form.fields : GENERIC_FIELDS;
  const prefilled: WorksheetField[] = [];
  const awaiting: string[] = [];

  for (const spec of specs) {
    const hit = spec.key ? assetFieldValue(asset, spec.key) : null;
    if (hit) prefilled.push({ label: spec.label, value: hit.value, source: hit.source });
    else awaiting.push(spec.label);
  }

  if (!form) {
    awaiting.push("The agency's field list has not been extracted yet — open the form to check.");
  }

  return { obligation, form, prefilled, awaiting };
}

export function resolveWorksheets(
  asset: OwnedAsset,
  obligations: Obligation[],
  catalog: FormCatalog | null,
): FormWorksheet[] {
  return obligations.map((o) => resolveWorksheet(asset, o, catalog));
}

/** Plain-language coverage line for a worksheet batch, e.g. "12 of 17 fields filled". */
export function worksheetCoverage(worksheets: FormWorksheet[]): {
  forms: number;
  filled: number;
  manual: number;
} {
  let filled = 0;
  let manual = 0;
  for (const w of worksheets) {
    filled += w.prefilled.length;
    manual += w.awaiting.length;
  }
  return { forms: worksheets.length, filled, manual };
}
