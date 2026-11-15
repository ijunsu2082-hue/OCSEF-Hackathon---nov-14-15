// Maps ETL location reports and loaded asset inventories into owner-plan
// Evidence + Fact entries. Pure and deterministic; browser-safe (type-only
// imports from research/etl, no node: modules, no clock reads).

import type { LocationReport } from "../../research/etl/pipeline";
import type { Claim, SourceDefinition, SourceSnapshot } from "../evidence/schema";
import type { Evidence, Fact, Provenance, Unknown } from "./planTypes";

type FeedState = LocationReport["feeds"][string];

/** Subject for CAISO system telemetry (demand/supply). System-wide, never site-local. */
export const CAISO_SUBJECT = "CAISO system";

/** The only CAISO sources whose values describe the whole CAISO system. */
export const CAISO_SYSTEM_SOURCE_IDS: readonly string[] = ["caiso-demand-5min", "caiso-supply-5min"];

/** Subject for CAISO OASIS nodal prices: one pricing node (the query node), never the system or the site. */
export const caisoNodeSubject = (node: string | undefined) =>
  `CAISO pricing node ${node ?? "unidentified"}`;

/** EIA hourly feeds report one balancing authority (the query respondent), never the site. */
export const EIA_BA_SOURCE_IDS: readonly string[] = ["eia-hourly-demand", "eia-hourly-fuel"];

/** Subject for EIA balancing-authority values, e.g. "CISO balancing authority". */
export const eiaSubject = (respondent: string | undefined) =>
  `${respondent ?? "unidentified"} balancing authority`;

/** Caller-defined analysis scope (lat/lon/radius): the user's assertion, not a model output. */
const SCOPE_PREDICATES: readonly string[] = ["region.home_latitude", "region.home_longitude", "region.radius_miles"];

/** Source ids whose records are operator imports rather than public publications. */
export const OPERATOR_SOURCE_IDS: readonly string[] = ["operator-records"];

/** Source ids whose values are reanalysis/model output (e.g. ERA5), never observations. */
export const MODEL_SOURCE_IDS: readonly string[] = ["open-meteo-era5"];

/** Publishers for asset-inventory sources (loaded inventories do not carry source definitions). */
const ASSET_PUBLISHERS: Record<string, string> = {
  "hifld-substations": "HIFLD",
  "hifld-transmission": "HIFLD",
  "eia-atlas-plants": "U.S. Energy Information Administration",
};

const ASSET_UNITS: Record<string, string> = { voltage_kv: "kV", maximum_voltage_kv: "kV" };

export interface EvidenceSet { evidence: Evidence[]; facts: Fact[] }

const isOasis = (sourceId: string | null | undefined, predicate?: string) =>
  (!!sourceId && sourceId.startsWith("caiso-oasis-")) || (!!predicate && predicate.startsWith("caiso.oasis."));
const isCaisoSystem = (sourceId: string | null | undefined, predicate?: string) =>
  sourceId ? CAISO_SYSTEM_SOURCE_IDS.includes(sourceId) : !!predicate && predicate.startsWith("caiso.");
const evidenceId = (snapshotId: string) => `ev:${snapshotId}`;
/** One Evidence per (snapshot, locator), so each Fact keeps the exact value it cites. */
const locatorEvidenceId = (snapshotId: string, locator: string) => `ev:${snapshotId}#${locator}`;
const unknown = (reason: string): Unknown => ({ state: "unknown", reason });
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function freshnessOf(state: FeedState | undefined): Evidence["freshness"] {
  if (!state) return "unknown";
  // A local-unknown observation basis means no defensible UTC age (EIA hour-ending periods).
  if (state.observation_time_basis === "local-unknown") return "unknown";
  if (state.status === "fresh") return "fresh";
  if (state.status === "stale") return "stale";
  // "fallback" (live fetch failed; prior capture replayed): use the pipeline's separately
  // measured freshness of the replayed capture when recorded, never the fallback status itself.
  if (state.status === "fallback") {
    const measured: unknown = (state as { freshness?: unknown }).freshness;
    return measured === "fresh" || measured === "stale" ? measured : "unknown";
  }
  // "unknown" and "unavailable" are not claimed fresh or stale.
  return "unknown";
}

function sourceProvenance(source: SourceDefinition | undefined, sourceId: string | null): Provenance {
  if (sourceId && OPERATOR_SOURCE_IDS.includes(sourceId)) return "operator";
  if (sourceId && MODEL_SOURCE_IDS.includes(sourceId)) return "model";
  if (source && (source.authority === "modeled" || source.authority === "derived")) return "model";
  return "public_source";
}

function claimProvenance(claim: Claim, source: SourceDefinition | undefined): Provenance {
  if (claim.method === "modeled" && claim.source_id === null && SCOPE_PREDICATES.includes(claim.predicate)) {
    return "user_assertion";
  }
  if (claim.method !== "observed") return "model";
  return sourceProvenance(source, claim.source_id);
}

function snapshotEvidence(
  snapshot: SourceSnapshot, publisher: string, title: string,
  freshness: Evidence["freshness"], provenance: Provenance, observedAt?: string, locator?: string,
): Evidence {
  return {
    id: locator === undefined ? evidenceId(snapshot.id) : locatorEvidenceId(snapshot.id, locator),
    kind: "snapshot",
    title,
    source: {
      publisher, url: snapshot.url, snapshot: snapshot.id, ...(locator === undefined ? {} : { locator }),
      sha256: snapshot.sha256,
    },
    retrievedAt: snapshot.retrieved_at,
    ...(observedAt ? { observedAt } : {}),
    freshness,
    provenance,
  };
}

/**
 * Evidence (one per captured snapshot, plus one per cited (snapshot, locator))
 * and Facts (one per claim, plus explicit Unknowns) for a report. A claim with
 * a locator cites `ev:<snapshot>#<locator>`; one without cites `ev:<snapshot>`.
 */
export function evidenceFromReport(report: LocationReport): EvidenceSet {
  const bundle = report.evidence;
  const sources = new Map(bundle.sources.map((source) => [source.id, source]));
  const regionSubject = `region:${bundle.region.id}`;
  const evidence = new Map<string, Evidence>();
  const snapshots = new Map<string, SourceSnapshot>();
  const describe = (snapshot: SourceSnapshot, locator?: string) => {
    const source = sources.get(snapshot.source_id);
    const state = report.feeds[snapshot.source_id];
    const observedAt = state?.observation_time_basis === "utc" && state.snapshot?.id === snapshot.id
      ? state.observation_at : undefined;
    return snapshotEvidence(
      snapshot, source?.publisher ?? snapshot.source_id, source?.title ?? snapshot.source_id,
      freshnessOf(state), sourceProvenance(source, snapshot.source_id), observedAt, locator,
    );
  };
  for (const snapshot of bundle.snapshots) {
    if (snapshots.has(snapshot.id)) continue;
    snapshots.set(snapshot.id, snapshot);
    evidence.set(evidenceId(snapshot.id), describe(snapshot));
  }
  const cite = (claim: Claim): string[] => {
    const snapshot = claim.snapshot_id ? snapshots.get(claim.snapshot_id) : undefined;
    if (!snapshot) return [];
    if (typeof claim.locator !== "string") return [evidenceId(snapshot.id)];
    const id = locatorEvidenceId(snapshot.id, claim.locator);
    if (!evidence.has(id)) evidence.set(id, describe(snapshot, claim.locator));
    return [id];
  };
  const subjectOf = (claim: Claim) => {
    if (isOasis(claim.source_id, claim.predicate)) return caisoNodeSubject(report.query.oasis_node);
    if (isCaisoSystem(claim.source_id, claim.predicate)) return CAISO_SUBJECT;
    if (claim.source_id && EIA_BA_SOURCE_IDS.includes(claim.source_id)) return eiaSubject(report.query.respondent);
    return claim.subject;
  };

  const facts: Fact[] = bundle.claims.map((claim) => {
    const source = claim.source_id ? sources.get(claim.source_id) : undefined;
    const state = claim.source_id ? report.feeds[claim.source_id] : undefined;
    const observedAt = state?.observation_time_basis === "utc" && state.snapshot?.id === claim.snapshot_id
      ? state.observation_at : undefined;
    const value: Fact["value"] = claim.value === null
      ? unknown(`${claim.predicate} not published in ${claim.source_id ?? "source"}`)
      : claim.value;
    return {
      id: `fact:${claim.id}`,
      subject: subjectOf(claim),
      predicate: claim.predicate,
      value,
      ...(claim.unit ? { unit: claim.unit } : {}),
      provenance: claimProvenance(claim, source),
      evidence: cite(claim),
      asOf: observedAt ?? claim.retrieved_at ?? bundle.generated_at,
    };
  });

  // Feeds with no usable capture: explicit Unknown, never omitted.
  for (const sourceId of Object.keys(report.feeds).sort()) {
    const state = report.feeds[sourceId];
    if (state.snapshot && snapshots.has(state.snapshot.id)) continue;
    facts.push({
      id: `fact:unavailable:${sourceId}`,
      subject: isOasis(sourceId) ? caisoNodeSubject(report.query.oasis_node)
        : isCaisoSystem(sourceId) ? CAISO_SUBJECT
        : EIA_BA_SOURCE_IDS.includes(sourceId) ? eiaSubject(report.query.respondent) : `${regionSubject}/${sourceId}`,
      predicate: sourceId,
      value: unknown(`${sourceId} unavailable: ${state.issue ?? state.status}`),
      provenance: sourceProvenance(sources.get(sourceId), sourceId),
      evidence: [],
      asOf: state.attempted_at,
    });
  }

  // Gaps the pipeline recorded that are not tied to a feed (e.g. telemetry.demand without a respondent).
  for (const gap of bundle.unresolved) {
    if (Object.hasOwn(report.feeds, gap.predicate) || gap.reason !== "no_source") continue;
    facts.push({
      id: `fact:unresolved:${gap.subject}:${gap.predicate}`,
      subject: isOasis(null, gap.predicate) ? caisoNodeSubject(report.query.oasis_node)
        : isCaisoSystem(null, gap.predicate) ? CAISO_SUBJECT : gap.subject,
      predicate: gap.predicate,
      value: unknown(`${gap.predicate} unavailable: ${gap.detail}`),
      provenance: "public_source",
      evidence: [],
      asOf: bundle.generated_at,
    });
  }

  if (report.assets === null || report.assets === undefined) {
    facts.push({
      id: `fact:unavailable:assets:${bundle.region.id}`,
      subject: regionSubject,
      predicate: "assets.inventory",
      value: unknown(report.assets === null
        ? "asset inventory unavailable: no loaded inventory was bound to this report"
        : "asset inventory unavailable: binding not recorded on this report revision"),
      provenance: "public_source",
      evidence: [],
      asOf: bundle.generated_at,
    });
  }

  return { evidence: [...evidence.values()].sort(byId), facts: facts.sort(byId) };
}

// Structural shape of research/etl/load-assets.ts output (that module exports no type).
interface Citation { snapshot: string; locator: string }
interface StudyClip { inside_miles: number; total_miles: number; segments: number; status: string; voltage_band: string }
export interface LoadedAssetDataset {
  source: string;
  scope: { center: [number, number]; radius_miles: number };
  snapshots: SourceSnapshot[];
  counts: { features: number; missing: Record<string, number> };
  features: {
    type: "FeatureCollection";
    features: {
      id: string;
      geometryCitation: Citation;
      properties: Record<string, string | number | null>;
      citations: Record<string, Citation>;
      study_clip?: StudyClip;
    }[];
  };
  mileage?: {
    method: string;
    inside_miles_total: number;
    provider_miles_total: number;
    by_voltage_band: Record<string, number>;
    counts: Record<string, number>;
  };
}
export interface LoadedAssetInventory {
  revision: string;
  data: { schema: string; location: string; datasets: LoadedAssetDataset[] };
}

/** Evidence (one per inventory snapshot) and Facts (one per published property, clip and mileage value). */
export function factsFromAssets(inventory: LoadedAssetInventory): EvidenceSet {
  const { revision, data } = inventory;
  const prefix = `fact:asset:${revision.slice(0, 12)}`;
  const evidence = new Map<string, Evidence>();
  const facts: Fact[] = [];
  for (const dataset of data.datasets) {
    const provenance: Provenance = OPERATOR_SOURCE_IDS.includes(dataset.source) ? "operator" : "public_source";
    const publisher = ASSET_PUBLISHERS[dataset.source] ?? dataset.source;
    const retrieved = new Map<string, string>();
    for (const snapshot of dataset.snapshots) {
      retrieved.set(snapshot.id, snapshot.retrieved_at);
      // Inventories carry no freshness policy or clock, so freshness is not asserted.
      if (!evidence.has(evidenceId(snapshot.id))) evidence.set(evidenceId(snapshot.id), snapshotEvidence(
        snapshot, publisher, `${dataset.source} asset inventory`, "unknown", provenance,
      ));
    }
    const cite = (citation: Citation | undefined) =>
      citation && retrieved.has(citation.snapshot) ? [evidenceId(citation.snapshot)] : [];
    const latest = dataset.snapshots.map((snapshot) => snapshot.retrieved_at).sort().at(-1) ?? "";
    const datasetSubject = `region:${data.location}/${dataset.source}`;
    const all = dataset.snapshots.map((snapshot) => evidenceId(snapshot.id)).sort();

    facts.push({
      id: `${prefix}:${dataset.source}:feature_count`, subject: datasetSubject,
      predicate: "asset.feature_count", value: dataset.counts.features, unit: "count",
      provenance, evidence: all, asOf: latest,
    });
    for (const feature of dataset.features.features) {
      for (const key of Object.keys(feature.properties).sort()) {
        const raw = feature.properties[key];
        const citation = feature.citations[key];
        facts.push({
          id: `${prefix}:${feature.id}:${key}`, subject: feature.id, predicate: `asset.${key}`,
          value: raw === null ? unknown(`${dataset.source} ${key} not published for ${feature.id}`) : raw,
          ...(ASSET_UNITS[key] ? { unit: ASSET_UNITS[key] } : {}),
          provenance, evidence: cite(citation ?? feature.geometryCitation),
          asOf: retrieved.get((citation ?? feature.geometryCitation).snapshot) ?? latest,
        });
      }
      const clip = feature.study_clip;
      if (clip) {
        const geometry = cite(feature.geometryCitation);
        const asOf = retrieved.get(feature.geometryCitation.snapshot) ?? latest;
        for (const [key, value, unit] of [
          ["inside_miles", clip.inside_miles, "mi"], ["total_miles", clip.total_miles, "mi"],
          ["segments", clip.segments, "count"], ["status", clip.status, undefined],
          ["voltage_band", clip.voltage_band, undefined],
        ] as const) {
          facts.push({
            id: `${prefix}:${feature.id}:study_clip.${key}`, subject: feature.id,
            predicate: `asset.study_clip.${key}`, value, ...(unit ? { unit } : {}),
            provenance: "model", evidence: geometry, asOf,
          });
        }
      }
    }
    const mileage = dataset.mileage;
    if (mileage) {
      const rows: [string, number, string][] = [
        ["inside_miles_total", mileage.inside_miles_total, "mi"],
        ["provider_miles_total", mileage.provider_miles_total, "mi"],
        ...Object.keys(mileage.by_voltage_band).sort()
          .map((band): [string, number, string] => [`by_voltage_band.${band}`, mileage.by_voltage_band[band], "mi"]),
        ...Object.keys(mileage.counts).sort()
          .map((status): [string, number, string] => [`counts.${status}`, mileage.counts[status], "count"]),
      ];
      for (const [key, value, unit] of rows) {
        facts.push({
          id: `${prefix}:${dataset.source}:mileage.${key}`, subject: datasetSubject,
          predicate: `asset.mileage.${key}`, value, unit, provenance: "model", evidence: all, asOf: latest,
        });
      }
    }
  }
  return { evidence: [...evidence.values()].sort(byId), facts: facts.sort(byId) };
}

export interface EvidenceIndex extends EvidenceSet {
  byId: Record<string, Evidence>;
  /** Evidence ids referenced by a Fact but absent from the index. */
  dangling: string[];
}

/** Merge sets into one deduplicated, sorted index. Conflicting entries under one id are an error. */
export function evidenceIndex(...sets: EvidenceSet[]): EvidenceIndex {
  const evidence = new Map<string, Evidence>();
  const facts = new Map<string, Fact>();
  const merge = <T extends { id: string }>(target: Map<string, T>, item: T, kind: string) => {
    const existing = target.get(item.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
      throw new Error(`Conflicting ${kind} for id ${item.id}`);
    }
    target.set(item.id, item);
  };
  for (const set of sets) {
    for (const item of set.evidence) merge(evidence, item, "evidence");
    for (const item of set.facts) merge(facts, item, "fact");
  }
  const sortedEvidence = [...evidence.values()].sort(byId);
  const sortedFacts = [...facts.values()].sort(byId);
  const dangling = [...new Set(sortedFacts.flatMap((fact) => fact.evidence))]
    .filter((id) => !evidence.has(id)).sort();
  return {
    evidence: sortedEvidence, facts: sortedFacts,
    byId: Object.fromEntries(sortedEvidence.map((item) => [item.id, item])), dangling,
  };
}
