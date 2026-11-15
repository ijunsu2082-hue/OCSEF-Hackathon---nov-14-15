/**
 * Reviewed registry of provider pairs that reconciliation may compare.
 *
 * Comparability is never inferred from predicate names or units. Each entry
 * states, for both sides, where the value comes from and the exact scope it is
 * compared under. Two sides only reach a value comparison when every scope
 * field (metric, entity, unit, interval, statistic, basis) is identical, so a
 * `basis` that differs between sides is how a reviewer records "different
 * definitions": the pair then reconciles as `incomparable` with that reason.
 *
 * The registry is plain data so its digest (`POLICIES_VERSION`) changes
 * whenever a reviewed field changes. Bump `revision` on an entry when the
 * extraction logic in reconcile-report.ts changes for it.
 */

import { digest } from "../../lib/evidence/canonical";

/** Where one side's value is read from. */
export type PolicyInput =
  /** One observed claim in the report, matched by `source_id` and predicate. */
  | { kind: "report-claim"; source: string; predicate: string }
  /**
   * One claim from a shipped evidence bundle in `public/evidence/` whose region
   * center and radius are exactly the report's. Never interpolated or rescaled.
   */
  | { kind: "bundled-claim"; source: string; predicate: string }
  /**
   * Mean of the 12 CAISO five-minute `Current demand` values whose interval
   * labels fall in the comparison UTC hour, read from the captured CSV bytes.
   * A missing, duplicated or non-numeric interval makes the side incomparable.
   */
  | { kind: "caiso-hourly-mean"; source: "caiso-demand-5min"; predicate: "caiso.system_demand_mw" }
  /** Hourly EIA-930 value from a report claim; the hour must have a reviewed UTC interval. */
  | { kind: "eia-hourly"; source: string; predicate: string }
  /** A provider release this ETL does not ingest yet. Always "input not captured". */
  | { kind: "not-ingested"; source: string; predicate: string; note: string };

/** How a side's `entity` scope field is built from the report query. */
export type EntityRule =
  /** `circle:<lat>,<lon>;r=<miles>mi` from the report query (or bundle region). */
  | { kind: "analysis-circle" }
  /** Fixed balancing-authority entity; `respondent` must equal the report's EIA respondent when given. */
  | { kind: "balancing-authority"; entity: string; respondent?: string }
  /** `balancing-authority:<respondent>` from the report's explicit EIA respondent. */
  | { kind: "eia-respondent" };

export interface PolicySide {
  input: PolicyInput;
  entity: EntityRule;
  metric: string;
  unit: string;
  statistic: string;
  /** Definition the value is measured under. Sides with different bases never compare. */
  basis: string;
  /**
   * Known capture defect that makes this side's value unfit for comparison.
   * While set, the pair is incomparable with this text as the reason.
   */
  known_defect?: string;
}

/** How both sides' `start`/`end` scope fields are built. */
export type IntervalRule =
  /**
   * Inventory counts are point-in-time. Both sides share the interval spanning
   * their two capture instants when those are at most `max_skew_days` apart;
   * otherwise each keeps its own instant and the pair is incomparable.
   */
  | { kind: "as-of"; max_skew_days: number }
  /**
   * One UTC clock hour. The EIA side must carry a UTC observation basis and the
   * policy must state a reviewed EIA period convention; `null` means the
   * convention is unreviewed and the side fails closed.
   */
  | { kind: "utc-hour"; eia_period_convention: "hour-beginning" | "hour-ending" | null };

export interface ReconcilePolicy {
  id: string;
  revision: number;
  title: string;
  left: PolicySide;
  right: PolicySide;
  interval: IntervalRule;
  tolerance: { absolute: number; basis: string } | null;
  /** Source id whose value is selected on disagreement. `null`: no side is preferred. */
  authority: string | null;
  rationale: string;
}

export const RECONCILE_POLICIES: readonly ReconcilePolicy[] = [
  {
    id: "substation-count.hifld-vs-osm-bundle",
    revision: 2,
    title: "Substations in radius: HIFLD live count vs bundled OSM extract",
    left: {
      input: { kind: "report-claim", source: "hifld-substations", predicate: "region.substation_feature_count" },
      entity: { kind: "analysis-circle" },
      metric: "substation count within radius",
      unit: "count",
      statistic: "count",
      basis: "HIFLD Substations FeatureServer records returned by a server-side esriSpatialRelIntersects distance query",
    },
    right: {
      input: { kind: "bundled-claim", source: "gs-layer-substations", predicate: "region.substation_feature_count" },
      entity: { kind: "analysis-circle" },
      metric: "substation count within radius",
      unit: "count",
      statistic: "count",
      basis: "OpenStreetMap power=substation features in the in-repo radius-clipped Overpass extract (outline centroid)",
    },
    interval: { kind: "as-of", max_skew_days: 30 },
    tolerance: null,
    authority: null,
    rationale:
      "HIFLD and OSM use different inclusion rules (HIFLD layer records vs any power=substation tag, including " +
      "unnamed and non-transmission substations) and no reviewed crosswalk establishes common identity, so the " +
      "bases differ and the pair is incomparable. The bundled count is used only when a shipped bundle covers " +
      "exactly the report's center and radius. Change both bases to one shared definition only after a reviewed " +
      "crosswalk proves equal definitions. No known capture defect applies: the server-side radius-unit defect " +
      "affected only the HIFLD transmission line layer (US-feet state plane, wkid 102659), now queried with a " +
      "study polygon; point-layer distance queries were measured correct (max returned distance 100.10 mi for " +
      "substations, 99.86 mi for plants at a 100 mi radius; docs/HIFLD-LIVE-CAPTURE.md).",
  },
  {
    id: "plant-count.eia-atlas-vs-eia860-bundle",
    revision: 1,
    title: "Generating plants in radius: EIA Energy Atlas live count vs bundled EIA-860 layer",
    left: {
      input: { kind: "report-claim", source: "eia-atlas-plants", predicate: "region.plant_count" },
      entity: { kind: "analysis-circle" },
      metric: "power plant count within radius",
      unit: "count",
      statistic: "count",
      basis: "EIA Energy Atlas Power_Plants FeatureServer records returned by a server-side esriSpatialRelIntersects distance query",
    },
    right: {
      input: { kind: "bundled-claim", source: "gs-layer-plants", predicate: "region.plant_count" },
      entity: { kind: "analysis-circle" },
      metric: "power plant count within radius",
      unit: "count",
      statistic: "count",
      basis: "Plants in the in-repo filtered, radius-clipped EIA-860 2025 annual subset",
    },
    interval: { kind: "as-of", max_skew_days: 30 },
    tolerance: null,
    authority: null,
    rationale:
      "No HIFLD power-plant feed is captured in location reports, so the second plant count is the shipped " +
      "EIA-860 layer for an identical center/radius. The Atlas layer's vintage and inclusion rule are not " +
      "captured and the in-repo subset's filter is not recorded in the artifact, so the definitions are not " +
      "shown to match and the pair is incomparable.",
  },
  {
    id: "ba-demand.eia930-ciso-vs-caiso-5min",
    revision: 1,
    title: "CAISO balancing-authority demand: EIA-930 hourly vs CAISO five-minute telemetry",
    left: {
      input: { kind: "eia-hourly", source: "eia-hourly-demand", predicate: "telemetry.demand" },
      entity: { kind: "balancing-authority", entity: "balancing-authority:CISO", respondent: "CISO" },
      metric: "balancing-authority demand",
      unit: "MW",
      statistic: "hourly mean MW",
      basis: "Balancing-authority demand averaged over one UTC clock hour",
    },
    right: {
      input: { kind: "caiso-hourly-mean", source: "caiso-demand-5min", predicate: "caiso.system_demand_mw" },
      entity: { kind: "balancing-authority", entity: "balancing-authority:CISO" },
      metric: "balancing-authority demand",
      unit: "MW",
      statistic: "hourly mean MW",
      basis: "Balancing-authority demand averaged over one UTC clock hour",
    },
    interval: { kind: "utc-hour", eia_period_convention: "hour-ending" },
    tolerance: {
      absolute: 300,
      basis:
        "Reviewer-chosen band, not a published provider tolerance: CAISO states Today's Outlook telemetry " +
        "summaries do not reconcile with OASIS or settlement, and EIA-930 is a separate balancing-authority " +
        "submission. 300 MW is 1-1.5% of load at 20-30 GW.",
    },
    authority: null,
    rationale:
      "EIA-930 hourly demand (MWh over one hour) equals the hour's mean MW. CAISO publishes five-minute averages, " +
      "so the CAISO side is the mean of the 12 intervals labelled inside the same UTC hour, computed only when " +
      "all 12 are present in the captured file. CAISO interval labels are treated as interval-beginning; this " +
      "label convention is not verified from CAISO documentation. The EIA side requires a UTC observation basis: " +
      "sources.ts records frequency=hourly periods as UTC hour-ending (route metadata \"hourly (UTC)\"; CISO " +
      "period 2026-11-14T08 matched the bulk row \"UTC Time at End of Hour\" 8:00 AM), so observation_at is the " +
      "hour's end. Reports whose EIA basis is not utc stay incomparable. No authority: a conflict keeps both values.",
  },
  {
    id: "ba-demand.eia930-api-vs-bulk",
    revision: 1,
    title: "EIA-930 demand: API release vs bulk release for the same respondent and hour",
    left: {
      input: { kind: "eia-hourly", source: "eia-hourly-demand", predicate: "telemetry.demand" },
      entity: { kind: "eia-respondent" },
      metric: "balancing-authority demand",
      unit: "MWh",
      statistic: "hourly total",
      basis: "EIA-930 hourly demand (type D) as published",
    },
    right: {
      input: {
        kind: "not-ingested", source: "eia-930-bulk", predicate: "telemetry.demand",
        note: "EIA-930 bulk BALANCE rows are an opt-in backfill (eia930-bulk.ts), not part of location reports.",
      },
      entity: { kind: "eia-respondent" },
      metric: "balancing-authority demand",
      unit: "MWh",
      statistic: "hourly total",
      basis: "EIA-930 hourly demand (type D) as published",
    },
    interval: { kind: "utc-hour", eia_period_convention: "hour-ending" },
    tolerance: null,
    authority: null,
    rationale:
      "Same publisher, different release: a difference is a revision, not independent corroboration, and is " +
      "reported as a conflict with both values. Kept so the comparison is ready when a bulk adapter lands.",
  },
];

export const POLICIES_VERSION = digest(RECONCILE_POLICIES);

export function getPolicy(id: string): ReconcilePolicy | null {
  return RECONCILE_POLICIES.find((policy) => policy.id === id) ?? null;
}
