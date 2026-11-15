/**
 * One-line provenance label for the grid layers a view is drawing: either the
 * location's loaded ETL inventory (and whether it is the one bound to a report
 * revision) or the bundled `public/layers` files, with the reason the ETL
 * inventory was not used.
 */

import type { EtlPlantFeature } from "../etlAssets";
import { escapeHtml, sourceLabel, type PlantFeature } from "../gridLayers";

export interface LayerSourceInput {
  source: "etl" | "bundled";
  /** Loaded-asset (inventory) revision; set when `source` is "etl". */
  revision?: string | null;
  /** Report revision the inventory is bound to; null/absent → unbound. */
  reportRevision?: string | null;
  /** Why the ETL inventory (or part of it) was not used. */
  fallbackReasons?: string[];
}

export function layerSourceLabel({ source, revision, reportRevision, fallbackReasons = [] }: LayerSourceInput): string {
  const reasons = fallbackReasons.filter((reason) => reason.trim() !== "");
  if (source === "etl") {
    const base = `ETL inventory rev ${revision ? revision.slice(0, 8) : "unknown"}${reportRevision ? " (report-bound)" : ""}`;
    return reasons.length ? `${base} · ${reasons.join("; ")}` : base;
  }
  return reasons.length ? `Bundled layers (fallback: ${reasons.join("; ")})` : "Bundled layers";
}

/** Label for `loadGridData()` output (lib/scan/data.ts LoadedGridData). */
export function gridDataSourceLabel(data: {
  source: "etl" | "bundled";
  etl: { revision: string; report_revision: string | null } | null;
  fallback_reasons: string[];
}): string {
  return layerSourceLabel({
    source: data.source,
    revision: data.etl?.revision ?? null,
    reportRevision: data.etl?.report_revision ?? null,
    fallbackReasons: data.fallback_reasons,
  });
}

// ---- Line / substation provider ---------------------------------------------

/**
 * Publisher of a line or substation layer: the loaded ETL inventory feeds those
 * layers from HIFLD (lib/etlAssets LAYER_DATASETS), the bundled files from OSM.
 */
export function gridLayerProvider(layer: "etl" | "bundled"): "HIFLD" | "OSM" {
  return layer === "etl" ? "HIFLD" : "OSM";
}

// ---- Plant popups ------------------------------------------------------------

/** A bundled plant, or one adapted from loaded ETL assets (absent fields null). */
export type MapPlant = PlantFeature | EtlPlantFeature;

const NOT_REPORTED = "not reported by source";

/** Tooltip for a plant; a null field reads "not reported by source", never 0 or NaN. */
export function plantTooltipHtml(feature: MapPlant): string {
  const props = feature.properties;
  const name = props.plant_name ? escapeHtml(props.plant_name) : `Plant name ${NOT_REPORTED}`;
  const mw = typeof props.nameplate_mw === "number" && Number.isFinite(props.nameplate_mw)
    ? `${props.nameplate_mw.toFixed(1)} MW`
    : `nameplate MW ${NOT_REPORTED}`;
  const fuel = props.primary_source ? sourceLabel(props.primary_source) : `fuel ${NOT_REPORTED}`;
  const years = props.oldest_year
    ? props.newest_year && props.newest_year !== props.oldest_year
      ? `${props.oldest_year}–${props.newest_year}`
      : `${props.oldest_year}`
    : "in-service year untagged";
  const retirement =
    typeof props.planned_retirement_mw === "number" && props.planned_retirement_mw > 0
      ? `<br/>planned retirement ${props.planned_retirement_mw.toFixed(1)} MW`
      : "";
  const source = "etl" in feature ? escapeHtml(feature.etl.source) : "EIA-860 2025";
  return `<b>${name}</b><br/>${mw} · ${fuel}<br/>in service ${years}${retirement}<br/><span class="tt-src">${source}</span>`;
}
