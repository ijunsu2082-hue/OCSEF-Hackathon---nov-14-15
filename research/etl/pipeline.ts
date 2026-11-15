import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { computeBundleId, computeRegistryDigest, digest } from "../../lib/evidence/canonical";
import { EVIDENCE_SCHEMA, type EvidenceBundle, type SourceSnapshot } from "../../lib/evidence/schema";
import { verifyBundle } from "../../lib/evidence/verify";
import { modeledClaim, observedClaim } from "../claims";
import { buildSnapshot, replaySnapshot, type LoadedSnapshot } from "../snapshot";
import { verifyEvidenceFiles } from "../verify-files";
import { feedsFor, nwsObservationUrl, type Feed, type LocationQuery } from "./sources";
import { requestBytes, type RedirectPolicy } from "./http";
import { validOasisNode } from "./oasis";
import { getJson, putJson, reportKey } from "./store";

export function stateRoot(): string {
  const suffix = process.env.ETL_STATE_NAMESPACE;
  if (suffix && !/^[A-Za-z0-9_-]{1,80}$/.test(suffix)) throw new Error("Invalid ETL_STATE_NAMESPACE");
  return suffix ? `research/etl-state/${suffix}` : "research/etl-state";
}
const MAX_BYTES = 8 * 1024 * 1024;

export function locationQuery(
  lat: number, lon: number, radius: number, respondent?: string, caiso = false, oasisNode?: string,
): LocationQuery {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180 ||
      !Number.isFinite(radius) || radius < 1 || radius > 500 ||
      (respondent !== undefined && !/^[A-Z0-9]{2,8}$/.test(respondent)) || typeof caiso !== "boolean" ||
      (oasisNode !== undefined && !validOasisNode(oasisNode))) {
    throw new Error("Expected latitude [-90,90], longitude [-180,180], radius [1,500] miles, optional EIA respondent code and optional OASIS node id");
  }
  // `oasis_node` joins the query (and so the location id digest) only when set,
  // so existing location ids are unchanged.
  return {
    center: [lat, lon], radius_miles: radius,
    ...(respondent ? { respondent } : {}), ...(caiso ? { caiso: true as const } : {}),
    ...(oasisNode !== undefined ? { oasis_node: oasisNode } : {}),
  };
}

export function locationId(query: LocationQuery): string {
  return `location-${digest(query).slice(0, 24)}`;
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Fetch one upstream resource through the shared request layer, which dedupes
 * identical in-flight requests, bounds per-host concurrency, retries with
 * backoff and revalidates with the provider's ETag.
 */
export async function request(
  url: URL, accept = "application/json", redirect?: RedirectPolicy,
): Promise<{ bytes: Uint8Array; headers: Headers }> {
  const target = new URL(url);
  if (target.hostname === "api.eia.gov") {
    const key = process.env.EIA_API_KEY;
    if (!key) throw new Error("EIA_API_KEY is required");
    target.searchParams.set("api_key", key);
  }
  const { bytes, headers } = await requestBytes(target, {
    accept,
    userAgent: process.env.NWS_USER_AGENT || "Mapergy/1.0",
    maxBytes: MAX_BYTES,
    timeoutMs: 15000,
    ...(redirect ? { redirect } : {}),
  });
  return { bytes, headers };
}

async function capture(feed: Feed, now: Date): Promise<LoadedSnapshot> {
  // A time-windowed feed derives its URL from the capture instant; the snapshot
  // stores that URL, and replay reads stored bytes without rebuilding it.
  let url = feed.urlAt ? feed.urlAt(now) : feed.url;
  if (feed.follow) {
    const point = await request(url);
    const stations = await request(feed.follow(JSON.parse(Buffer.from(point.bytes).toString("utf8"))));
    url = nwsObservationUrl(JSON.parse(Buffer.from(stations.bytes).toString("utf8")));
  }
  const { bytes, headers } = await request(url, feed.accept, feed.redirect);
  const { hash, cachePath } = await storeCapture(bytes);
  try {
    const loaded = buildSnapshot({
      sourceId: feed.source.id, url: url.href, retrievedAt: now.toISOString(),
      bytes, cachePath, parser: feed.parser ?? (url.hostname === "api.eia.gov" ? "json.eia-hourly" :
        url.hostname === "api.weather.gov" && url.pathname === "/alerts/active" ? "json.nws-alerts" : "json.object"),
      contentType: headers.get("content-type"),
      etag: headers.get("etag"), lastModified: headers.get("last-modified"),
    });
    if (!feed.extract(loaded.data, loaded.snapshot.retrieved_at, loaded.snapshot.url).length) {
      throw new Error("No usable observations for this scope");
    }
    return loaded;
  } catch (error) {
    await atomicJson(resolve(stateRoot(), "quarantine", `${digest([feed.source.id, url.href, hash])}.json`), {
      source: feed.source.id, url: url.href, cachePath, sha256: hash, retrievedAt: now.toISOString(),
      issue: error instanceof Error ? error.message : "Capture rejected",
    });
    throw error;
  }
}

export async function storeCapture(bytes: Uint8Array) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const cachePath = `${stateRoot()}/blobs/${hash}.json`;
  await mkdir(dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    try {
      await rename(temporary, cachePath);
    } catch (error) {
      // Another adapter may publish the same content while this rename is pending.
      const existing = await readFile(cachePath).catch(() => null);
      if (!existing || createHash("sha256").update(existing).digest("hex") !== hash) throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { hash, cachePath };
}

/**
 * Marker on every report this code writes. Reports without it predate the
 * marker; only those can be in the legacy (pre-observation-time) shape.
 */
export const LOCATION_REPORT_SCHEMA = "mapergy.location-report/2" as const;
/** Pre-rename marker. Same rules as the current one; replays keep it so revisions stay deterministic. */
export const LEGACY_LOCATION_REPORT_SCHEMA = "gridsentinel.location-report/2" as const;
const LOCATION_REPORT_SCHEMAS: readonly string[] = [LOCATION_REPORT_SCHEMA, LEGACY_LOCATION_REPORT_SCHEMA];

interface FeedState {
  attempted_at: string;
  status: "fresh" | "stale" | "unknown" | "fallback" | "unavailable";
  /**
   * Measured freshness of the replayed prior capture. Set only on `fallback`
   * feeds of versioned reports, so a failed refresh never hides whether the
   * data still in use is fresh or stale.
   */
  freshness?: "fresh" | "stale" | "unknown";
  /** `fetch_failed` when this attempt's live fetch failed (status `fallback` or `unavailable`). */
  issue_code?: "fetch_failed";
  observation_at?: string;
  observation_time_basis?: "utc" | "local-unknown";
  source_age_seconds?: number | null;
  snapshot?: SourceSnapshot;
  issue?: string;
}
function observedState(feed: Feed, loaded: LoadedSnapshot, now: Date, attempted_at: string): FeedState {
  if (!feed.observationTime) {
    const age = (now.getTime() - Date.parse(loaded.snapshot.retrieved_at)) / 1000;
    const status = !Number.isFinite(age) || age < 0 ? "unknown" :
      age > feed.source.freshness.max_age_days * 86400 ? "stale" : "fresh";
    return {
      attempted_at, status, source_age_seconds: Number.isFinite(age) ? Math.max(0, age) : null,
      ...(status === "unknown" ? { issue: "Capture age cannot be established safely." } : {}),
      snapshot: loaded.snapshot,
    };
  }
  const observation = feed.observationTime(loaded.data, loaded.snapshot.retrieved_at, loaded.snapshot.url);
  if (!observation) return {
    attempted_at, status: "unknown", source_age_seconds: null,
    issue: "Observation time is unavailable or has no verified timezone.", snapshot: loaded.snapshot,
  };
  const age = (now.getTime() - Date.parse(observation.timestamp)) / 1000;
  const status = observation.basis !== "utc" || !Number.isFinite(age) || age < 0
    ? "unknown"
    : age > feed.source.freshness.max_age_days * 86400 ? "stale" : "fresh";
  return {
    attempted_at, status, observation_at: observation.timestamp,
    observation_time_basis: observation.basis,
    source_age_seconds: observation.basis === "utc" && Number.isFinite(age) && age >= 0 ? age : null,
    ...(status === "unknown" ? { issue: "Observation age cannot be established safely." } : {}),
    snapshot: loaded.snapshot,
  };
}

export interface LocationReport {
  /** Absent only on reports written before the marker existed. */
  schema?: typeof LOCATION_REPORT_SCHEMA | typeof LEGACY_LOCATION_REPORT_SCHEMA;
  query: LocationQuery;
  state_hash: string;
  feeds: Record<string, FeedState>;
  evidence: EvidenceBundle;
  /**
   * Loaded asset inventory this report was built against (inventory id omits
   * respondent/caiso, matching how asset manifests are keyed). `null` when no
   * loaded inventory existed. Absent only on revisions written before binding.
   */
  assets?: { location: string; revision: string } | null;
}

export function reportRevision(report: LocationReport): string {
  return digest(report);
}

export async function readReport(id: string, revision?: string): Promise<LocationReport | null> {
  if (!/^location-[a-f0-9]{24}$/.test(id)) return null;
  if (revision !== undefined && !/^[a-f0-9]{64}$/.test(revision)) return null;
  // The deployed app has no ETL state directory: reports are published to a
  // Supabase bucket, which is the first place to look.
  const mirrored = await getJson<LocationReport>(reportKey(id, revision));
  if (mirrored) {
    if (revision && reportRevision(mirrored) !== revision) throw new Error("Report revision checksum mismatch");
    return mirrored;
  }
  try {
    const path = revision
      ? resolve(stateRoot(), "revisions", id, `${revision}.json`)
      : resolve(stateRoot(), "reports", `${id}.json`);
    const report = JSON.parse(await readFile(path, "utf8")) as LocationReport;
    if (revision && reportRevision(report) !== revision) throw new Error("Report revision checksum mismatch");
    return report;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function runLocation(
  query: LocationQuery, live: boolean, now = new Date(), pinned?: LocationReport,
): Promise<LocationReport> {
  const id = locationId(query);
  const previous = pinned ?? await readReport(id);
  if (pinned?.schema !== undefined && !LOCATION_REPORT_SCHEMAS.includes(pinned.schema)) {
    throw new Error(`Unsupported location report schema ${String(pinned.schema)}`);
  }
  // New reports, and replays of reports carrying the marker, use the current
  // rules. Unversioned reports replay under the rules they were written with.
  const versioned = !pinned || pinned.schema !== undefined;
  // A replay rebuilds under the ids the pinned report was written with: the
  // bundle id hashes the evidence schema id, so a legacy (pre-rename) report
  // only reproduces under its legacy ids. New reports get the current ids.
  const reportSchema = pinned?.schema ?? LOCATION_REPORT_SCHEMA;
  const evidenceSchema = pinned?.evidence.schema ?? EVIDENCE_SCHEMA;
  // Legacy reports recorded no observation-time fields on any feed. An
  // all-unavailable report has the same shape, so only an unversioned report
  // can be legacy (see the state_hash tuple choice below).
  const legacyReplay = !!pinned && !versioned && Object.values(pinned.feeds).every((state) =>
    state.observation_at === undefined && state.observation_time_basis === undefined && state.source_age_seconds === undefined);
  const feeds = feedsFor(query).filter((feed) => !pinned || Object.hasOwn(pinned.feeds, feed.source.id));
  const entries = await Promise.all(feeds.map(async (feed): Promise<[string, FeedState, LoadedSnapshot | null]> => {
    const source = feed.source.id;
    const prior = previous?.feeds[source];
    const due = !prior || now.getTime() - Date.parse(prior.attempted_at) >= feed.interval * 1000;
    let state: FeedState = prior ?? { attempted_at: now.toISOString(), status: "unavailable", issue: "No capture" };
    if (live && due) {
      try {
        const loaded = await capture(feed, now);
        return [source, observedState(feed, loaded, now, now.toISOString()), loaded];
      } catch (error) {
        state = {
          ...prior,
          attempted_at: now.toISOString(),
          status: prior?.snapshot ? "fallback" : "unavailable",
          snapshot: prior?.snapshot,
          issue: error instanceof Error ? error.message : "Source fetch failed",
          issue_code: "fetch_failed",
        };
      }
    }
    if (!state.snapshot) return [source, state, null];
    try {
      const loaded = await replaySnapshot(state.snapshot);
      if (legacyReplay) return [source, state, loaded];
      const measured = observedState(feed, loaded, now, state.attempted_at);
      if (state.status !== "fallback") return [source, measured, loaded];
      // The failed fetch is the status; the replayed capture's measured status
      // is kept beside it instead of being overwritten.
      return [source, versioned
        ? { ...measured, status: "fallback", freshness: measured.status as "fresh" | "stale" | "unknown",
          issue_code: "fetch_failed", issue: state.issue }
        : { ...measured, status: "fallback", issue: state.issue }, loaded];
    } catch {
      return [source, { attempted_at: state.attempted_at, status: "unavailable", issue: "Snapshot failed replay" }, null];
    }
  }));
  const states = Object.fromEntries(entries.map(([source, state]) => [source, state]));
  const sources = feeds.map((feed) => feed.source);
  const snapshots: SourceSnapshot[] = [];
  const subject = `region:${id}`;
  const [lat, lon] = query.center;
  const claims = [
    ["region.home_latitude", lat],
    ["region.home_longitude", lon],
    ["region.radius_miles", query.radius_miles],
  ].map(([predicate, value]) => modeledClaim({
    subject, predicate: String(predicate), value: Number(value), basis: "Caller-defined analysis scope.",
  }));
  const unresolved: EvidenceBundle["unresolved"] = [];
  const measurements: unknown[] = [];
  for (const [source, state, loaded] of entries) {
    const feed = feeds.find((item) => item.source.id === source)!;
    const legacyAged = legacyReplay && loaded && now.getTime() - Date.parse(loaded.snapshot.retrieved_at) >
      feed.source.freshness.max_age_days * 86400000;
    const aged = state.status === "stale" || legacyAged;
    if (versioned && state.status === "fallback") {
      // Reason follows the replayed capture's measured freshness; the failed
      // fetch is named by its code. A still-fresh fallback is not "stale".
      unresolved.push({
        subject, predicate: source, reason: state.freshness === "fresh" ? "requires_review" : "stale",
        detail: `fetch_failed: ${state.issue ?? "Source fetch failed"}. Replayed prior capture ` + (
          state.freshness === "fresh" ? "is still within the source freshness window." :
          state.freshness === "stale" ? "exceeds source freshness window." : "has an unknown observation age."),
        candidate_claim_ids: [], escalated: false,
      });
    } else if (state.status !== "fresh" || aged) unresolved.push({
      subject, predicate: source, reason: loaded ? "stale" : "no_source",
      detail: state.issue ?? (aged ? "Latest observation exceeds source freshness window" :
        state.status === "unknown" ? "Latest observation age is unknown" : "Source unavailable"),
      candidate_claim_ids: [], escalated: false,
    });
    if (!loaded) continue;
    snapshots.push(loaded.snapshot);
    const metrics = feed.extract(loaded.data, loaded.snapshot.retrieved_at, loaded.snapshot.url);
    measurements.push([source, metrics.map(({ predicate, value }) => [predicate, value]).sort()]);
    for (const item of metrics) {
      claims.push(observedClaim({
        ...item, subject: source === "census-geocoder" ? subject : `${subject}/${source}`,
        sourceId: source, snapshot: loaded.snapshot,
        authority: feed.source.authority, caveats: feed.source.caveats,
      }));
    }
  }
  if (!query.respondent) unresolved.push({
    subject, predicate: "telemetry.demand", reason: "no_source",
    detail: query.caiso
      ? "CAISO system telemetry is included; EIA hourly demand additionally requires an explicit respondent."
      : "Supply an EIA balancing-authority respondent explicitly.",
    candidate_claim_ids: [], escalated: false,
  });
  const radiusDegrees = query.radius_miles / 3958.7613 * 180 / Math.PI;
  const south = Math.max(-90, lat - radiusDegrees);
  const north = Math.min(90, lat + radiusDegrees);
  const lonDelta = south <= -90 || north >= 90 ? 180 :
    Math.asin(Math.sin(radiusDegrees * Math.PI / 180) / Math.cos(lat * Math.PI / 180)) * 180 / Math.PI;
  const globalLongitude = lon - lonDelta < -180 || lon + lonDelta > 180;
  const evidence: EvidenceBundle = {
    schema: evidenceSchema, bundle_id: "",
    region: {
      id, name: `Location ${lat}, ${lon}`,
      state: "", center: query.center, radius_miles: query.radius_miles,
      bounds: [[south, globalLongitude ? -180 : lon - lonDelta], [north, globalLongitude ? 180 : lon + lonDelta]],
    },
    generated_at: now.toISOString(), registry_digest: computeRegistryDigest(sources),
    sources, snapshots, claims, resolutions: [], unresolved,
    disclosures: [{
      id: "regional-coverage", subject, severity: "caution",
      text: "Weather applies to the selected station. Grid telemetry applies to the explicitly selected reporting authority. Neither establishes local facility telemetry or asset coverage.",
    }],
    verification: { ok: false, verified_at: "", bundle_id: "", errors: [], warnings: [], checks: [] },
    stats: {
      claims: claims.length, observed: claims.length - 3, derived: 0, modeled: 3, inferred: 0,
      sources: sources.length, snapshots: snapshots.length, unresolved: unresolved.length,
    },
  };
  evidence.bundle_id = computeBundleId(evidence);
  evidence.verification = verifyBundle(evidence, { now, enforceFreshness: true }).report;
  const files = await verifyEvidenceFiles(evidence);
  const errors = [...evidence.verification.errors, ...files.issues];
  if (errors.length) throw new Error(errors.map(({ code, detail }) => `${code}: ${detail}`).join("\n"));
  const hashState = (legacy: boolean) => digest({
    measurements,
    coverage: Object.entries(states).map(([source, state]) => legacy
      ? [source, state.status, state.issue ?? null]
      : [source, state.status, state.observation_at ?? null, state.issue ?? null]),
    gaps: unresolved.map(({ predicate, reason }) => [predicate, reason]),
  });
  // An unversioned report in the legacy shape is either a true legacy report or
  // an all-unavailable one written before the marker; nothing was loaded in the
  // latter, so the bundle is identical and only the coverage tuple differs.
  let state_hash = hashState(legacyReplay);
  if (legacyReplay && entries.every(([, , loaded]) => !loaded) && pinned!.state_hash !== state_hash &&
      pinned!.state_hash === hashState(false)) state_hash = hashState(false);
  // Live builds bind the verified latest loaded inventory; replays reuse the
  // binding recorded on the report being replayed so revisions stay deterministic.
  let assets: LocationReport["assets"];
  if (live) {
    const { readLocationAssets } = await import("./load-assets");
    const inventory = locationId({ center: query.center, radius_miles: query.radius_miles });
    try {
      const loadedAssets = await readLocationAssets(inventory);
      assets = loadedAssets ? { location: inventory, revision: loadedAssets.revision } : null;
    } catch (error) {
      // A corrupt or mismatched inventory must not block live builds: bind
      // nothing, quarantine the failure and rebind on a later live run. One
      // record per (inventory, revision, issue): a persisting failure bumps
      // its count and lastSeen instead of writing a new file every run.
      const issue = error instanceof Error ? error.message : "Asset inventory rejected";
      const directory = `${stateRoot()}/loaded-assets/${inventory}`;
      let revision: string | null = null;
      try {
        const pointer = JSON.parse(await readFile(resolve(directory, "latest.json"), "utf8"))?.revision;
        if (typeof pointer === "string" && /^[a-f0-9]{64}$/.test(pointer)) revision = pointer;
      } catch {
        // An unreadable pointer is itself the issue; the record carries no revision.
      }
      const recordPath = resolve(stateRoot(), "quarantine", "assets", inventory,
        `${digest([inventory, revision, issue]).slice(0, 32)}.json`);
      let existing: { detectedAt?: unknown; count?: unknown } | null = null;
      try {
        existing = JSON.parse(await readFile(recordPath, "utf8"));
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== "ENOENT" && !(readError instanceof SyntaxError)) throw readError;
      }
      const priorCount = typeof existing?.count === "number" && Number.isSafeInteger(existing.count) ? existing.count : 0;
      await atomicJson(recordPath, {
        inventory, revision, path: directory,
        detectedAt: typeof existing?.detectedAt === "string" ? existing.detectedAt : now.toISOString(),
        lastSeen: now.toISOString(), count: priorCount + 1, issue,
      });
      console.warn(`Mapergy: asset inventory ${inventory} rejected (${issue}); report bound to no inventory`);
      assets = null;
    }
  } else {
    assets = previous?.assets;
  }
  const report: LocationReport = {
    ...(versioned ? { schema: reportSchema } : {}),
    query, state_hash, feeds: states, evidence, ...(assets === undefined ? {} : { assets }),
  };
  const rebound = !!previous && ((previous.assets?.location ?? null) !== (assets?.location ?? null) ||
    (previous.assets?.revision ?? null) !== (assets?.revision ?? null));
  if (live && (!previous || rebound || state_hash !== previous.state_hash || entries.some(([source, state]) =>
    state.attempted_at !== previous.feeds[source]?.attempted_at))) {
    await atomicJson(resolve(stateRoot(), "revisions", id, `${reportRevision(report)}.json`), report);
    await atomicJson(resolve(stateRoot(), "reports", `${id}.json`), report);
    // Mirror so a deployed app (no state directory) serves this revision.
    await putJson(reportKey(id, reportRevision(report)), report);
    await putJson(reportKey(id), report);
  }
  if (live && previous && !rebound && state_hash === previous.state_hash && entries.every(([source, state]) =>
    state.attempted_at === previous.feeds[source]?.attempted_at)) {
    const revisionPath = resolve(stateRoot(), "revisions", id, `${reportRevision(previous)}.json`);
    try {
      await access(revisionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicJson(revisionPath, previous);
    }
    return previous;
  }
  return report;
}

export async function verifyLocation(report: LocationReport): Promise<void> {
  const { evidence } = report;
  const id = locationId(report.query);
  if (id !== evidence.region.id) throw new Error("Location scope mismatch");
  const structural = verifyBundle(evidence).report;
  const files = await verifyEvidenceFiles(evidence);
  const errors = [...structural.errors, ...files.issues];
  if (errors.length) throw new Error(errors.map(({ code, detail }) => `${code}: ${detail}`).join("\n"));
  const rebuilt = await runLocation(report.query, false, new Date(evidence.generated_at), report);
  if (rebuilt.evidence.bundle_id !== evidence.bundle_id || rebuilt.state_hash !== report.state_hash) {
    throw new Error("Pinned report failed deterministic replay");
  }
}
