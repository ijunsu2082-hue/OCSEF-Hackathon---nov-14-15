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

export function stateRoot(): string {
  const suffix = process.env.ETL_STATE_NAMESPACE;
  if (suffix && !/^[A-Za-z0-9_-]{1,80}$/.test(suffix)) throw new Error("Invalid ETL_STATE_NAMESPACE");
  return suffix ? `research/etl-state/${suffix}` : "research/etl-state";
}
const MAX_BYTES = 8 * 1024 * 1024;

export function locationQuery(lat: number, lon: number, radius: number, respondent?: string): LocationQuery {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180 ||
      !Number.isFinite(radius) || radius < 1 || radius > 500 ||
      (respondent !== undefined && !/^[A-Z0-9]{2,8}$/.test(respondent))) {
    throw new Error("Expected latitude [-90,90], longitude [-180,180], radius [1,500] miles and optional EIA respondent code");
  }
  return { center: [lat, lon], radius_miles: radius, ...(respondent ? { respondent } : {}) };
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

export async function request(url: URL): Promise<{ bytes: Uint8Array; response: Response }> {
  const target = new URL(url);
  if (target.hostname === "api.eia.gov") {
    const key = process.env.EIA_API_KEY;
    if (!key) throw new Error("EIA_API_KEY is required");
    target.searchParams.set("api_key", key);
  }
  const response = await fetch(target, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      accept: "application/json",
      "user-agent": process.env.NWS_USER_AGENT || "GridSentinel/1.0",
    },
  });
  if (!response.ok || !response.body) throw new Error(`Upstream HTTP ${response.status}`);
  const parts: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error("Upstream response exceeds capture limit");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { response, bytes: Buffer.concat(parts) };
}

async function capture(feed: Feed, now: Date): Promise<LoadedSnapshot> {
  let url = feed.url;
  if (feed.follow) {
    const point = await request(url);
    const stations = await request(feed.follow(JSON.parse(Buffer.from(point.bytes).toString("utf8"))));
    url = nwsObservationUrl(JSON.parse(Buffer.from(stations.bytes).toString("utf8")));
  }
  const { bytes, response } = await request(url);
  const { hash, cachePath } = await storeCapture(bytes);
  try {
    const loaded = buildSnapshot({
      sourceId: feed.source.id, url: url.href, retrievedAt: now.toISOString(),
      bytes, cachePath, parser: url.hostname === "api.eia.gov" ? "json.eia-hourly" : "json.object",
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified"),
    });
    if (!feed.extract(loaded.data).length) throw new Error("No usable observations for this scope");
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

interface FeedState {
  attempted_at: string;
  status: "fresh" | "stale" | "unknown" | "fallback" | "unavailable";
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
  const observation = feed.observationTime(loaded.data);
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
    source_age_seconds: observation.basis === "utc" && Number.isFinite(age) ? Math.max(0, age) : null,
    ...(status === "unknown" ? { issue: "Observation age cannot be established safely." } : {}),
    snapshot: loaded.snapshot,
  };
}

export interface LocationReport {
  query: LocationQuery;
  state_hash: string;
  feeds: Record<string, FeedState>;
  evidence: EvidenceBundle;
}

export function reportRevision(report: LocationReport): string {
  return digest(report);
}

export async function readReport(id: string, revision?: string): Promise<LocationReport | null> {
  if (!/^location-[a-f0-9]{24}$/.test(id)) return null;
  if (revision !== undefined && !/^[a-f0-9]{64}$/.test(revision)) return null;
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
  const feeds = feedsFor(query);
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
        };
      }
    }
    if (!state.snapshot) return [source, state, null];
    try {
      const loaded = await replaySnapshot(state.snapshot);
      const measured = observedState(feed, loaded, now, state.attempted_at);
      return [source, state.status === "fallback" ? { ...measured, status: "fallback", issue: state.issue } : measured, loaded];
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
    const aged = state.status === "stale";
    if (state.status !== "fresh") unresolved.push({
      subject, predicate: source, reason: loaded ? "stale" : "no_source",
      detail: state.issue ?? (aged ? "Latest observation exceeds source freshness window" :
        state.status === "unknown" ? "Latest observation age is unknown" : "Source unavailable"),
      candidate_claim_ids: [], escalated: false,
    });
    if (!loaded) continue;
    snapshots.push(loaded.snapshot);
    const metrics = feed.extract(loaded.data);
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
    detail: "Supply an EIA balancing-authority respondent explicitly.", candidate_claim_ids: [], escalated: false,
  });
  const radiusDegrees = query.radius_miles / 3958.7613 * 180 / Math.PI;
  const south = Math.max(-90, lat - radiusDegrees);
  const north = Math.min(90, lat + radiusDegrees);
  const lonDelta = south <= -90 || north >= 90 ? 180 :
    Math.asin(Math.sin(radiusDegrees * Math.PI / 180) / Math.cos(lat * Math.PI / 180)) * 180 / Math.PI;
  const globalLongitude = lon - lonDelta < -180 || lon + lonDelta > 180;
  const evidence: EvidenceBundle = {
    schema: EVIDENCE_SCHEMA, bundle_id: "",
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
  const state_hash = digest({
    measurements,
    coverage: Object.entries(states).map(([source, state]) => [source, state.status,
      state.observation_at ?? null, state.source_age_seconds ?? null, state.issue ?? null]),
    gaps: unresolved.map(({ predicate, reason }) => [predicate, reason]),
  });
  const report = { query, state_hash, feeds: states, evidence };
  if (live && (!previous || state_hash !== previous.state_hash || entries.some(([source, state]) =>
    state.attempted_at !== previous.feeds[source]?.attempted_at))) {
    await atomicJson(resolve(stateRoot(), "revisions", id, `${reportRevision(report)}.json`), report);
    await atomicJson(resolve(stateRoot(), "reports", `${id}.json`), report);
  }
  if (live && previous && state_hash === previous.state_hash && entries.every(([source, state]) =>
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
