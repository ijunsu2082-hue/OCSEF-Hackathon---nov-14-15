/**
 * Automatic provider reconciliation for a pinned location report revision.
 *
 * For every reviewed policy in reconcile-policies.ts the two sides are read
 * from the report's claims (plus captured blob bytes or shipped bundles where
 * the policy says so), turned into scoped observations and passed to
 * `reconcile`. The result is persisted once per report revision at
 * `<stateRoot>/reconciliations/<id>/<reportRev>.json`, written as canonical
 * JSON with an embedded digest so identical inputs give identical bytes and
 * any edit is detected on read.
 *
 * Values are never averaged across providers. `selected` is set only by the
 * policy authority, or to the left side on exact agreement; a conflict without
 * an authority keeps both candidates and selects nothing.
 *
 * Everything here is offline: it reads the stored report, stored blobs and
 * repo files only.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalJson, computeBundleId, digest } from "../../lib/evidence/canonical";
import type { Claim, EvidenceBundle, SourceSnapshot } from "../../lib/evidence/schema";
import { replaySnapshot } from "../snapshot";
import { pacificInstant, typedTable, type TypedCsvTable } from "./caiso";
import { readReport, reportRevision, stateRoot, type LocationReport } from "./pipeline";
import {
  reconcile, scopeDifferences, type ComparisonScope, type MetricPolicy, type Observation, type ReconcileStatus,
} from "./reconcile";
import {
  POLICIES_VERSION, RECONCILE_POLICIES, type PolicySide, type ReconcilePolicy,
} from "./reconcile-policies";

export const RECONCILIATION_SCHEMA = "mapergy.reconciliation/1";
/** Pre-rename id. Stored records carrying it are still served (their digest covers it). */
export const LEGACY_RECONCILIATION_SCHEMA = "gridsentinel.reconciliation/1";

export interface ReconciliationSide {
  source: string;
  predicate: string;
  /** Report claim ids the side was read from. Empty for bundled or missing inputs. */
  claim_ids: string[];
  observation: Observation | null;
  /** Why no observation could be built, or null. */
  issue: string | null;
}

export interface ReconciliationComparison {
  policy: string;
  policy_revision: number;
  status: ReconcileStatus;
  left: ReconciliationSide;
  right: ReconciliationSide;
  /** True only when both sides were compared and come from different publishers. */
  independent: boolean;
  /** Side whose value stands: authority, or left on exact agreement. Never a blend. */
  selected: "left" | "right" | null;
  difference: number | null;
  tolerance: { absolute: number; basis: string } | null;
  reason: string | null;
}

export interface Reconciliation {
  schema: typeof RECONCILIATION_SCHEMA | typeof LEGACY_RECONCILIATION_SCHEMA;
  location: string;
  report_revision: string;
  policies_version: string;
  comparisons: ReconciliationComparison[];
  /** sha256 of the canonical record without this field. */
  digest: string;
}

const ID = /^location-[a-f0-9]{24}$/;
const REVISION = /^[a-f0-9]{64}$/;
const HOUR_MS = 3_600_000;

/**
 * Keyed by report revision and the policy registry version, so a policy change
 * yields a new record instead of serving one computed under older policies.
 */
function reconciliationPath(id: string, reportRev: string): string {
  return resolve(stateRoot(), "reconciliations", id, `${reportRev}.${POLICIES_VERSION.slice(0, 12)}.json`);
}

/** Raw side value before the policy's interval rule turns it into a scope. */
interface RawSide {
  value: number;
  source: string;
  publisher: string;
  release: string;
  snapshot: string;
  locator: string;
  claim_ids: string[];
  /** Capture instant used by as-of intervals. */
  at: string;
  /** Explicit UTC hour, for hourly sides. */
  hour?: { start: string; end: string };
}
type SideResult = { raw: RawSide } | { issue: string };

interface Context {
  report: LocationReport;
  bundles: () => Promise<EvidenceBundle[]>;
}

function release(snapshot: SourceSnapshot): string {
  return snapshot.http.last_modified ? `last-modified ${snapshot.http.last_modified}` : `retrieved ${snapshot.retrieved_at}`;
}

function publisherOf(bundle: EvidenceBundle, source: string): string {
  return bundle.sources.find((item) => item.id === source)?.publisher ?? source;
}

function reportClaim(report: LocationReport, source: string, predicate: string):
  { claim: Claim; snapshot: SourceSnapshot } | { issue: string } {
  const feed = report.feeds[source];
  if (!feed) return { issue: `input not captured: source ${source} is not part of this report` };
  const claims = report.evidence.claims.filter((claim) => claim.source_id === source && claim.predicate === predicate);
  if (!claims.length) {
    return {
      issue: `input not captured: ${source} has no ${predicate} claim (feed ${feed.status}` +
        `${feed.issue ? `: ${feed.issue}` : ""})`,
    };
  }
  if (claims.length > 1) return { issue: `ambiguous input: ${claims.length} ${predicate} claims from ${source}` };
  const [claim] = claims;
  const snapshot = report.evidence.snapshots.find((item) => item.id === claim.snapshot_id);
  if (!snapshot) return { issue: `input not captured: ${source} claim ${claim.id} has no snapshot` };
  return { claim, snapshot };
}

function numericClaim(report: LocationReport, source: string, predicate: string): SideResult {
  const found = reportClaim(report, source, predicate);
  if ("issue" in found) return found;
  const { claim, snapshot } = found;
  // Providers such as EIA publish numbers as decimal strings; only a plain decimal is read as a number.
  const value = typeof claim.value === "string" && /^-?\d{1,15}(?:\.\d{1,15})?$/.test(claim.value.trim())
    ? Number(claim.value.trim()) : claim.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { issue: `${source} ${predicate} claim ${claim.id} is not numeric` };
  }
  return {
    raw: {
      value, source, publisher: publisherOf(report.evidence, source), release: release(snapshot),
      snapshot: snapshot.id, locator: claim.locator ?? "", claim_ids: [claim.id], at: snapshot.retrieved_at,
    },
  };
}

async function shippedBundles(): Promise<EvidenceBundle[]> {
  const directory = resolve("public", "evidence");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(names.map(async (name) =>
    JSON.parse(await readFile(resolve(directory, name), "utf8")) as EvidenceBundle));
}

async function bundledClaim(context: Context, source: string, predicate: string): Promise<SideResult> {
  const { center, radius_miles } = context.report.query;
  const matches = (await context.bundles()).filter(({ region }) =>
    Array.isArray(region?.center) && region.center[0] === center[0] && region.center[1] === center[1] &&
    region.radius_miles === radius_miles);
  if (!matches.length) {
    return { issue: `input not captured: no shipped evidence bundle covers center ${center.join(",")} radius ${radius_miles} mi exactly` };
  }
  if (matches.length > 1) return { issue: `ambiguous input: ${matches.length} shipped bundles cover this center and radius` };
  const [bundle] = matches;
  if (computeBundleId(bundle) !== bundle.bundle_id) {
    return { issue: `shipped bundle ${bundle.region.id} fails its bundle id check` };
  }
  const claims = bundle.claims.filter((claim) => claim.source_id === source && claim.predicate === predicate);
  if (claims.length !== 1) {
    return { issue: `input not captured: bundle ${bundle.region.id} has ${claims.length} ${predicate} claims from ${source}` };
  }
  const [claim] = claims;
  const snapshot = bundle.snapshots.find((item) => item.id === claim.snapshot_id);
  if (!snapshot || typeof claim.value !== "number" || !Number.isFinite(claim.value)) {
    return { issue: `bundle ${bundle.region.id} claim ${claim.id} is not a numeric snapshot-backed value` };
  }
  return {
    raw: {
      value: claim.value, source, publisher: publisherOf(bundle, source), release: release(snapshot),
      snapshot: snapshot.id, locator: `bundle:${bundle.bundle_id}#${claim.id}:${claim.locator ?? ""}`,
      claim_ids: [], at: snapshot.retrieved_at,
    },
  };
}

function eiaHour(context: Context, policy: ReconcilePolicy, source: string, predicate: string): SideResult {
  const found = numericClaim(context.report, source, predicate);
  if ("issue" in found) return found;
  const state = context.report.feeds[source];
  if (state.observation_time_basis !== "utc" || !state.observation_at) {
    return {
      issue: `${source} period ${state.observation_at ?? "unknown"} has no verified UTC basis ` +
        `(observation_time_basis ${state.observation_time_basis ?? "absent"})`,
    };
  }
  const convention = policy.interval.kind === "utc-hour" ? policy.interval.eia_period_convention : null;
  if (!convention) return { issue: `EIA period convention (hour-beginning or hour-ending) is not reviewed for policy ${policy.id}` };
  const instant = Date.parse(state.observation_at);
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(state.observation_at) || !Number.isFinite(instant) || instant % HOUR_MS !== 0) {
    return { issue: `${source} observation ${state.observation_at} is not an offset-qualified hour boundary` };
  }
  const start = convention === "hour-beginning" ? instant : instant - HOUR_MS;
  return {
    raw: {
      ...found.raw,
      hour: { start: new Date(start).toISOString(), end: new Date(start + HOUR_MS).toISOString() },
    },
  };
}

function pacificDate(instant: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Mean of the 12 five-minute `Current demand` values labelled inside the UTC
 * hour starting at `hourStart`, on CAISO operating day `operatingDate`. Labels
 * are treated as interval-beginning. Returns an issue unless exactly 12
 * distinct intervals with numeric values are present.
 */
export function caisoHourlyMean(table: TypedCsvTable, operatingDate: string, hourStart: string):
  { value: number; locators: string[] } | { issue: string } {
  const start = Date.parse(hourStart);
  if (!Number.isFinite(start) || start % HOUR_MS !== 0) return { issue: `${hourStart} is not a UTC hour boundary` };
  const timeColumn = table.header.indexOf("Time");
  const demandColumn = table.header.indexOf("Current demand");
  if (timeColumn < 0 || demandColumn < 0) return { issue: "CAISO demand file lacks Time or Current demand columns" };
  const seen = new Set<number>();
  const locators: string[] = [];
  let sum = 0;
  for (const [index, row] of table.rows.entries()) {
    const label = row[timeColumn];
    if (typeof label !== "string" || !/^\d{2}:\d{2}$/.test(label)) continue;
    let instant: number;
    try {
      instant = Date.parse(pacificInstant(operatingDate, label));
    } catch {
      continue;
    }
    if (instant < start || instant >= start + HOUR_MS) continue;
    if (seen.has(instant)) return { issue: `CAISO interval ${label} appears twice in ${operatingDate} (ambiguous local time)` };
    seen.add(instant);
    const value = row[demandColumn];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    sum += value;
    locators.push(`/rows/${index}/${demandColumn}`);
  }
  if (locators.length !== 12) {
    return { issue: `CAISO file has ${locators.length} of 12 five-minute demand values for ${new Date(start).toISOString()}` };
  }
  return { value: sum / 12, locators };
}

async function caisoSide(context: Context, source: string, predicate: string, hour?: RawSide["hour"]): Promise<SideResult> {
  const found = reportClaim(context.report, source, predicate);
  if ("issue" in found) return found;
  if (!hour) return { issue: "not evaluated: no comparison hour was established by the other side" };
  const state = context.report.feeds[source];
  if (state.observation_time_basis !== "utc" || !state.observation_at) {
    return { issue: `${source} has no UTC observation time to anchor its operating day` };
  }
  const table = typedTable((await replaySnapshot(found.snapshot)).data);
  if (!table) return { issue: `${source} snapshot ${found.snapshot.id} is not a typed CSV table` };
  const mean = caisoHourlyMean(table, pacificDate(state.observation_at), hour.start);
  if ("issue" in mean) return mean;
  return {
    raw: {
      value: mean.value, source, publisher: publisherOf(context.report.evidence, source),
      release: release(found.snapshot), snapshot: found.snapshot.id, locator: `mean(${mean.locators.join(",")})`,
      claim_ids: [found.claim.id], at: found.snapshot.retrieved_at, hour,
    },
  };
}

async function evaluateSide(context: Context, policy: ReconcilePolicy, side: PolicySide, hour?: RawSide["hour"]): Promise<SideResult> {
  const { input } = side;
  switch (input.kind) {
    case "report-claim": return numericClaim(context.report, input.source, input.predicate);
    case "bundled-claim": return bundledClaim(context, input.source, input.predicate);
    case "eia-hourly": return eiaHour(context, policy, input.source, input.predicate);
    case "caiso-hourly-mean": return caisoSide(context, input.source, input.predicate, hour);
    case "not-ingested": return { issue: `input not captured: ${input.note}` };
  }
}

function entityFor(context: Context, side: PolicySide): string | { issue: string } {
  const { query } = context.report;
  const rule = side.entity;
  if (rule.kind === "analysis-circle") return `circle:${query.center[0]},${query.center[1]};r=${query.radius_miles}mi`;
  if (rule.kind === "eia-respondent") {
    return query.respondent ? `balancing-authority:${query.respondent}` : { issue: "report has no explicit EIA respondent" };
  }
  if (rule.respondent !== undefined && query.respondent !== rule.respondent) {
    return { issue: `report EIA respondent ${query.respondent ?? "(none)"} is not ${rule.respondent}` };
  }
  return rule.entity;
}

function sideRecord(side: PolicySide, result: SideResult, observation: Observation | null, issue: string | null): ReconciliationSide {
  return {
    source: side.input.source, predicate: side.input.predicate,
    claim_ids: "raw" in result ? result.raw.claim_ids : [], observation, issue,
  };
}

function observationOf(raw: RawSide, scope: ComparisonScope): Observation {
  return {
    scope, source: raw.source, publisher: raw.publisher, release: raw.release,
    snapshot: raw.snapshot, locator: raw.locator, value: raw.value,
  };
}

/** Evaluate one policy against a report. Exported for tests; `reconcileReport` is the persisted path. */
export async function evaluatePolicy(
  policy: ReconcilePolicy, report: LocationReport, bundles: () => Promise<EvidenceBundle[]> = shippedBundles,
): Promise<ReconciliationComparison> {
  const context: Context = { report, bundles };
  // Hourly policies take their comparison hour from the EIA side.
  const leftFirst = policy.right.input.kind === "caiso-hourly-mean";
  const first = await evaluateSide(context, policy, leftFirst ? policy.left : policy.right);
  const hour = "raw" in first ? first.raw.hour : undefined;
  const second = await evaluateSide(context, policy, leftFirst ? policy.right : policy.left, hour);
  const left = leftFirst ? first : second;
  const right = leftFirst ? second : first;
  const issueOf = (result: SideResult, side: PolicySide): string | null => {
    if ("issue" in result) return result.issue;
    const entity = entityFor(context, side);
    return typeof entity === "string" ? null : entity.issue;
  };
  const leftIssue = issueOf(left, policy.left);
  const rightIssue = issueOf(right, policy.right);
  const base = {
    policy: policy.id, policy_revision: policy.revision, tolerance: policy.tolerance,
  };
  if (leftIssue || rightIssue || !("raw" in left) || !("raw" in right)) {
    // A side that was read keeps its value under its own scope, for display; nothing is compared.
    const solo = (result: SideResult, side: PolicySide, issue: string | null): Observation | null => {
      if (issue || !("raw" in result)) return null;
      const { raw } = result;
      const at = new Date(Date.parse(raw.at)).toISOString();
      return observationOf(raw, {
        metric: side.metric, entity: entityFor(context, side) as string, unit: side.unit,
        ...(raw.hour ?? { start: at, end: at }), statistic: side.statistic, basis: side.basis,
      });
    };
    return {
      ...base, status: "incomparable",
      left: sideRecord(policy.left, left, solo(left, policy.left, leftIssue), leftIssue),
      right: sideRecord(policy.right, right, solo(right, policy.right, rightIssue), rightIssue),
      independent: false, selected: null, difference: null,
      reason: [
        leftIssue ? `left (${policy.left.input.source}): ${leftIssue}` : null,
        rightIssue ? `right (${policy.right.input.source}): ${rightIssue}` : null,
        !leftIssue && policy.left.known_defect ? `left (${policy.left.input.source}): known defect: ${policy.left.known_defect}` : null,
        !rightIssue && policy.right.known_defect ? `right (${policy.right.input.source}): known defect: ${policy.right.known_defect}` : null,
      ].filter(Boolean).join("; "),
    };
  }
  const notes: string[] = [];
  const interval = (raw: RawSide, other: RawSide): { start: string; end: string } => {
    if (policy.interval.kind === "utc-hour") return raw.hour ?? other.hour!;
    const a = Date.parse(raw.at);
    const b = Date.parse(other.at);
    const skewDays = Math.abs(a - b) / 86_400_000;
    if (skewDays <= policy.interval.max_skew_days) {
      return { start: new Date(Math.min(a, b)).toISOString(), end: new Date(Math.max(a, b)).toISOString() };
    }
    const note = `captures are ${skewDays.toFixed(1)} days apart, beyond the ${policy.interval.max_skew_days}-day as-of window`;
    if (!notes.includes(note)) notes.push(note);
    return { start: new Date(a).toISOString(), end: new Date(a).toISOString() };
  };
  const scopeFor = (side: PolicySide, raw: RawSide, other: RawSide): ComparisonScope => ({
    metric: side.metric, entity: entityFor(context, side) as string, unit: side.unit,
    ...interval(raw, other), statistic: side.statistic, basis: side.basis,
  });
  const leftObservation = observationOf(left.raw, scopeFor(policy.left, left.raw, right.raw));
  const rightObservation = observationOf(right.raw, scopeFor(policy.right, right.raw, left.raw));
  const defects = [
    policy.left.known_defect ? `left (${policy.left.input.source}): known defect: ${policy.left.known_defect}` : null,
    policy.right.known_defect ? `right (${policy.right.input.source}): known defect: ${policy.right.known_defect}` : null,
  ].filter((item): item is string => item !== null);
  if (defects.length) {
    // Both values are kept for display; a known capture defect never reaches a value comparison.
    return {
      ...base, status: "incomparable",
      left: sideRecord(policy.left, left, leftObservation, null),
      right: sideRecord(policy.right, right, rightObservation, null),
      independent: false, selected: null, difference: null, reason: defects.join("; "),
    };
  }
  const differences = scopeDifferences(leftObservation.scope, rightObservation.scope);
  const metricPolicy: MetricPolicy | undefined = differences.length ? undefined : {
    scope: leftObservation.scope,
    ...(policy.tolerance ? { tolerance: policy.tolerance } : {}),
    ...(policy.authority ? { authority: policy.authority } : {}),
  };
  const result = reconcile(leftObservation, rightObservation, metricPolicy) as {
    status: ReconcileStatus; independent: boolean; selected: Observation | null; difference?: number | null;
  };
  const selected = result.selected === leftObservation ? "left" : result.selected === rightObservation ? "right" : null;
  const difference = typeof result.difference === "number" ? result.difference : null;
  let reason: string | null = null;
  if (result.status === "incomparable") {
    reason = [
      `scope differs in ${differences.map((field) =>
        `${field} (${JSON.stringify(leftObservation.scope[field])} vs ${JSON.stringify(rightObservation.scope[field])})`).join(", ")}`,
      ...notes,
    ].join("; ");
  } else if (result.status === "within_tolerance") {
    reason = `difference ${difference} is within the ${policy.tolerance!.absolute} ${policy.left.unit} tolerance` +
      (selected ? `; ${selected} selected by authority ${policy.authority}` : "; no authority, both values retained");
  } else if (result.status === "conflict") {
    reason = `values differ${difference === null ? "" : ` by ${difference}`}` +
      (policy.tolerance ? `, beyond the ${policy.tolerance.absolute} ${policy.left.unit} tolerance` : " and the policy has no tolerance") +
      (selected ? `; ${selected} selected by authority ${policy.authority}` : "; no authority, both values retained and none selected");
  }
  return {
    ...base, status: result.status,
    left: sideRecord(policy.left, left, leftObservation, null),
    right: sideRecord(policy.right, right, rightObservation, null),
    independent: result.status === "incomparable" ? false : result.independent,
    selected, difference, reason,
  };
}

function withDigest(record: Omit<Reconciliation, "digest">): Reconciliation {
  return { ...record, digest: digest(record) };
}

/**
 * Read the persisted reconciliation for a report revision under the current
 * policies version, verifying its embedded digest and both bindings (report
 * revision and policies_version). Null when absent.
 */
export async function readReconciliation(id: string, reportRev: string): Promise<Reconciliation | null> {
  if (!ID.test(id) || !REVISION.test(reportRev)) return null;
  let text: string;
  try {
    text = await readFile(reconciliationPath(id, reportRev), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const record = JSON.parse(text) as Reconciliation;
  const { digest: recorded, ...rest } = record;
  if ((record.schema !== RECONCILIATION_SCHEMA && record.schema !== LEGACY_RECONCILIATION_SCHEMA) || record.location !== id || record.report_revision !== reportRev ||
      record.policies_version !== POLICIES_VERSION) {
    throw new Error("Reconciliation does not match its report revision");
  }
  if (typeof recorded !== "string" || digest(rest) !== recorded) throw new Error("Reconciliation checksum mismatch");
  return record;
}

async function writeImmutable(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx" });
    // Concurrent writers compute identical bytes, so a rename over a racing
    // writer's file publishes the same content.
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Reconcile a report revision (latest when omitted) and persist the result.
 * An existing record for the revision and current policies version is
 * verified and returned unchanged.
 * Returns null when the report or revision does not exist.
 */
export async function reconcileReport(id: string, reportRev?: string): Promise<Reconciliation | null> {
  if (!ID.test(id) || (reportRev !== undefined && !REVISION.test(reportRev))) return null;
  const report = await readReport(id, reportRev);
  if (!report) return null;
  const revision = reportRev ?? reportRevision(report);
  const existing = await readReconciliation(id, revision);
  if (existing) return existing;
  let cached: Promise<EvidenceBundle[]> | undefined;
  const bundles = () => (cached ??= shippedBundles());
  const comparisons: ReconciliationComparison[] = [];
  for (const policy of RECONCILE_POLICIES) comparisons.push(await evaluatePolicy(policy, report, bundles));
  const record = withDigest({
    schema: RECONCILIATION_SCHEMA, location: id, report_revision: revision,
    policies_version: POLICIES_VERSION, comparisons,
  });
  await writeImmutable(reconciliationPath(id, revision), canonicalJson(record) + "\n");
  return record;
}

/** CLI entry: `reconcile <location-id> [report-revision]`. Prints the persisted record. */
export async function runReconcileCommand(args: string[]): Promise<Reconciliation> {
  if (args.length < 1 || args.length > 2) throw new Error("Expected location id and optional report revision");
  const [id, revision] = args;
  if (!ID.test(id) || (revision !== undefined && !REVISION.test(revision))) {
    throw new Error("Expected location-<24 hex> and optional 64-hex report revision");
  }
  const record = await reconcileReport(id, revision);
  if (!record) throw new Error("Location report not found");
  process.stdout.write(canonicalJson(record) + "\n");
  return record;
}
