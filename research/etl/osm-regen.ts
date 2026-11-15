/**
 * Regenerate the OSM-derived layers (public/layers/substations.geojson and
 * public/layers/transmission.geojson) from a pinned OSM PBF extract, then diff
 * the result against the committed artifacts and classify every difference.
 *
 * Never writes to public/layers. Output goes to research/etl-state/osm/regen/.
 *
 * Passes over the PBF (all streamed, blob by blob):
 *   1. every block: power=substation nodes, power=substation|line ways,
 *      power=substation relations, and any element whose id the committed layers
 *      reference (so removals can be explained). Records which frames hold
 *      nodes and which hold ways.
 *   1b. way frames only, if a selected relation references ways not yet held.
 *   2. node frames only: coordinates + timestamp for the referenced node ids,
 *      stored in typed arrays keyed by a sorted id array (bounded memory).
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { clipLine, greatCircleMiles, type Position } from "./geometry";
import { readOsmPbf, type OsmHeader, type OsmNode, type OsmRelation, type OsmTags, type OsmWay } from "./osm-pbf";

export const CENTER: Position = [-118.0111, 33.7538];
export const RADIUS_MI = 100;
export const MIN_LINE_KV = 69;
const METRES_PER_MILE = 1609.344;

/* ------------------------------------------------------------------------ */
/* Types                                                                     */
/* ------------------------------------------------------------------------ */

export type ElementType = "node" | "way" | "relation";

export interface OsmProvenance {
  type: ElementType;
  id: number;
  version: number | null;
  /** ISO time of the element's own last edit. */
  timestamp: string | null;
  /** ISO time of the latest edit to the element or any node it references. */
  last_modified: string | null;
  tags: OsmTags;
  nodes?: number[];
  missing_nodes?: number;
}

export interface SubstationProperties {
  osm_id: string;
  name: string | null;
  operator: string | null;
  voltage_kv: number | null;
  substation: string | null;
}

export interface TransmissionProperties {
  osm_id: number;
  voltage_kv: number | null;
  operator: string | null;
  name: string | null;
  cables: string | null;
  circuits: string | null;
  line: string | null;
}

export interface PointFeature<P> {
  type: "Feature";
  geometry: { type: "Point"; coordinates: Position };
  properties: P;
  osm?: OsmProvenance;
}

export interface LineFeature<P> {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: Position[] };
  properties: P;
  osm?: OsmProvenance;
}

export interface Collection<F> {
  type: "FeatureCollection";
  metadata?: Record<string, unknown>;
  features: F[];
}

export type SubstationFeature = PointFeature<SubstationProperties>;
export type TransmissionFeature = LineFeature<TransmissionProperties>;

/* ------------------------------------------------------------------------ */
/* Node coordinate index (typed arrays, sorted ids)                          */
/* ------------------------------------------------------------------------ */

export class NodeCoordIndex {
  readonly ids: Float64Array;
  readonly lat: Float64Array;
  readonly lon: Float64Array;
  readonly ts: Float64Array;
  found = 0;

  constructor(wanted: Iterable<number>) {
    const unique = Float64Array.from(new Set(wanted)).sort();
    this.ids = unique;
    this.lat = new Float64Array(unique.length).fill(Number.NaN);
    this.lon = new Float64Array(unique.length).fill(Number.NaN);
    this.ts = new Float64Array(unique.length).fill(Number.NaN);
  }

  get size(): number {
    return this.ids.length;
  }

  indexOf(id: number): number {
    const ids = this.ids;
    let lo = 0;
    let hi = ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const value = ids[mid];
      if (value === id) return mid;
      if (value < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  set(id: number, lat: number, lon: number, ts: number | undefined): void {
    const index = this.indexOf(id);
    if (index < 0) return;
    if (Number.isNaN(this.lat[index])) this.found += 1;
    this.lat[index] = lat;
    this.lon[index] = lon;
    this.ts[index] = ts ?? Number.NaN;
  }

  get(id: number): { lon: number; lat: number; ts: number } | null {
    const index = this.indexOf(id);
    if (index < 0 || Number.isNaN(this.lat[index])) return null;
    return { lon: this.lon[index], lat: this.lat[index], ts: this.ts[index] };
  }

  bytes(): number {
    return this.ids.byteLength * 4;
  }
}

/* ------------------------------------------------------------------------ */
/* Collection passes                                                         */
/* ------------------------------------------------------------------------ */

export interface WantedIds {
  nodes: Set<number>;
  ways: Set<number>;
  relations: Set<number>;
}

export interface CollectedOsm {
  header?: OsmHeader;
  nodes: Map<number, OsmNode>;
  ways: Map<number, OsmWay>;
  relations: Map<number, OsmRelation>;
  coords: NodeCoordIndex;
  /** Committed substation way ids (evaluated even if no longer power=substation). */
  wantedSubstationWays?: Set<number>;
  /** Committed transmission way ids (evaluated even if no longer power=line). */
  wantedLineWays?: Set<number>;
  stats: {
    blocks: number;
    nodeFrames: number;
    wayFrames: number;
    totalNodes: number;
    totalWays: number;
    totalRelations: number;
    neededNodes: number;
    resolvedNodes: number;
    pass1bWays: number;
    passMs: Record<string, number>;
  };
}

const isSubstation = (tags: OsmTags) => tags.power === "substation";
const isLine = (tags: OsmTags) => tags.power === "line";

export async function collectOsm(pbfPath: string, wanted: WantedIds, log: (line: string) => void = () => {}): Promise<CollectedOsm> {
  const nodes = new Map<number, OsmNode>();
  const ways = new Map<number, OsmWay>();
  const relations = new Map<number, OsmRelation>();
  const nodeFrames: number[] = [];
  const wayFrames: number[] = [];
  const totals = { nodes: 0, ways: 0, relations: 0 };
  const passMs: Record<string, number> = {};

  let t0 = Date.now();
  const pass1 = await readOsmPbf(
    pbfPath,
    {
      nodeFilter: (id, tag) => tag("power") === "substation" || wanted.nodes.has(id),
      node: (node) => void nodes.set(node.id, node),
      way: (way) => {
        if (isSubstation(way.tags) || isLine(way.tags) || wanted.ways.has(way.id)) ways.set(way.id, way);
      },
      relation: (relation) => {
        if (isSubstation(relation.tags) || wanted.relations.has(relation.id)) relations.set(relation.id, relation);
      },
    },
    {
      onBlock: (offset, summary) => {
        totals.nodes += summary.nodes;
        totals.ways += summary.ways;
        totals.relations += summary.relations;
        if (summary.nodes) nodeFrames.push(offset);
        if (summary.ways) wayFrames.push(offset);
      },
    },
  );
  passMs.pass1 = Date.now() - t0;
  log(`pass 1: ${pass1.blocks} blocks, ${totals.nodes} nodes, ${totals.ways} ways, ${totals.relations} relations; kept ${nodes.size} nodes, ${ways.size} ways, ${relations.size} relations (${passMs.pass1} ms)`);

  // Pass 1b: member ways of kept relations that were not kept in pass 1.
  const memberWays = new Set<number>();
  for (const relation of relations.values()) {
    for (const member of relation.members) if (member.type === "way" && !ways.has(member.ref)) memberWays.add(member.ref);
  }
  let pass1bWays = 0;
  if (memberWays.size) {
    t0 = Date.now();
    await readOsmPbf(pbfPath, {
      way: (way) => {
        if (memberWays.has(way.id)) {
          ways.set(way.id, way);
          pass1bWays += 1;
        }
      },
    }, { offsets: wayFrames });
    passMs.pass1b = Date.now() - t0;
    log(`pass 1b: ${pass1bWays}/${memberWays.size} relation member ways (${passMs.pass1b} ms)`);
  }

  const needed: number[] = [];
  for (const way of ways.values()) for (const ref of way.refs) needed.push(ref);
  for (const relation of relations.values()) for (const member of relation.members) if (member.type === "node") needed.push(member.ref);
  const coords = new NodeCoordIndex(needed);
  t0 = Date.now();
  await readOsmPbf(pbfPath, { nodeInfo: true, nodeCoord: (id, lat, lon, ts) => coords.set(id, lat, lon, ts) }, { offsets: nodeFrames });
  passMs.pass2 = Date.now() - t0;
  log(`pass 2: resolved ${coords.found}/${coords.size} needed nodes over ${nodeFrames.length} node frames (${passMs.pass2} ms)`);

  return {
    header: pass1.header,
    nodes,
    ways,
    relations,
    coords,
    stats: {
      blocks: pass1.blocks,
      nodeFrames: nodeFrames.length,
      wayFrames: wayFrames.length,
      totalNodes: totals.nodes,
      totalWays: totals.ways,
      totalRelations: totals.relations,
      neededNodes: coords.size,
      resolvedNodes: coords.found,
      pass1bWays,
      passMs,
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Normalisation rules                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Parse an OSM `voltage` tag (volts, `;`-separated) into kV values. Non-numeric
 * parts are dropped. "0" is a real value (HVDC electrode lines are tagged
 * voltage=0); the committed layer excluded those as < 69 kV rather than treating
 * them as untagged.
 */
export function parseVoltageKv(tag: string | undefined): number[] {
  if (tag === undefined) return [];
  return tag
    .split(";")
    .map((part) => part.trim())
    .filter((part) => /^\d+(\.\d+)?$/.test(part))
    .map((part) => Number(part) / 1000)
    .filter((kv) => Number.isFinite(kv) && kv >= 0);
}

/** voltage_kv as committed: the highest tagged voltage, or null. */
export function maxVoltageKv(tag: string | undefined): number | null {
  const values = parseVoltageKv(tag);
  return values.length ? Math.max(...values) : null;
}

/** Transmission voltage rule: keep >= 69 kV or no parseable voltage ("untagged"). */
export function lineVoltageSelected(tag: string | undefined): boolean {
  const kv = maxVoltageKv(tag);
  return kv === null || kv >= MIN_LINE_KV;
}

/**
 * Committed coordinates are `Number(x.toFixed(5))` (correct rounding of the exact
 * binary value, same as Python round(x, 5)). Math.round(x * 1e5) / 1e5 differs on
 * 7-dp values ending in 5 (e.g. -117.183835 -> -117.18383 vs committed -117.18384)
 * and reproduced only 4891/5329 line geometries; toFixed reproduces 5287.
 */
export const round5 = (value: number): number => Number(value.toFixed(5));
const roundPosition = ([lon, lat]: Position): Position => [round5(lon), round5(lat)];

const text = (value: string | undefined): string | null => (value === undefined ? null : value);

/**
 * "ref_mean": arithmetic mean of every way node reference, INCLUDING the repeated
 * closing node of a closed way (this is what the committed layer used: 1267/1267
 * exact at 5 dp). "vertex_mean" drops the closing duplicate; "bbox" is Overpass
 * `out center`; "area" is the planar polygon centroid.
 */
export type CentroidMethod = "ref_mean" | "bbox" | "vertex_mean" | "area";

/** Way/relation representative point. "bbox" is Overpass `out center`. */
export function centroid(points: Position[], method: CentroidMethod): Position {
  if (!points.length) throw new Error("centroid of empty geometry");
  if (method === "bbox") {
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return [(minX + maxX) / 2, (minY + maxY) / 2];
  }
  if (method === "ref_mean") {
    const sum = points.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
    return [sum[0] / points.length, sum[1] / points.length];
  }
  const closed = points.length > 2 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1];
  const ring = closed ? points.slice(0, -1) : points;
  if (method === "vertex_mean" || ring.length < 3) {
    const sum = ring.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
    return [sum[0] / ring.length, sum[1] / ring.length];
  }
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-18) return centroid(points, "vertex_mean");
  return [cx / (3 * area), cy / (3 * area)];
}

export type RadiusMethod = "segment" | "vertex" | "center";

/** Does the geometry reach the study circle? "segment" matches Overpass `around` on ways. */
export function withinRadius(points: Position[], representative: Position, method: RadiusMethod, radiusMi = RADIUS_MI): boolean {
  if (method === "center") return greatCircleMiles(CENTER, representative) <= radiusMi;
  if (points.length === 1 || method === "vertex") return points.some((p) => greatCircleMiles(CENTER, p) <= radiusMi);
  if (points.some((p) => greatCircleMiles(CENTER, p) <= radiusMi)) return true;
  return clipLine(CENTER, radiusMi, points).length > 0;
}

/** Minimum distance (miles) from the centre to the geometry, vertices or segment interior. */
export function minDistanceMiles(points: Position[]): number {
  let best = Math.min(...points.map((p) => greatCircleMiles(CENTER, p)));
  // refine with segment interiors by bisection on the clip radius
  if (points.length > 1) {
    let lo = 0;
    let hi = best;
    if (clipLine(CENTER, hi, points).length === 0) return best;
    for (let i = 0; i < 40; i += 1) {
      const mid = (lo + hi) / 2;
      if (mid <= 0) break;
      if (clipLine(CENTER, mid, points).length > 0) hi = mid;
      else lo = mid;
    }
    best = Math.min(best, hi);
  }
  return best;
}

/* ------------------------------------------------------------------------ */
/* Build features                                                            */
/* ------------------------------------------------------------------------ */

export interface BuildRules {
  centroid: CentroidMethod;
  substationRadius: RadiusMethod;
  lineRadius: RadiusMethod;
  includeRelations: boolean;
}

export const INFERRED_RULES: BuildRules = {
  centroid: "ref_mean",
  substationRadius: "segment",
  lineRadius: "segment",
  includeRelations: false,
};

export interface Evaluation {
  key: string;
  selected: boolean;
  reasons: string[];
  minDistanceMi: number | null;
  provenance: OsmProvenance;
  points: Position[];
}

const iso = (seconds: number | undefined): string | null =>
  seconds === undefined || !Number.isFinite(seconds) ? null : new Date(seconds * 1000).toISOString();

function wayPoints(way: OsmWay, coords: NodeCoordIndex): { points: Position[]; missing: number; lastTs: number } {
  const points: Position[] = [];
  let missing = 0;
  let lastTs = way.info?.timestamp ?? Number.NaN;
  for (const ref of way.refs) {
    const node = coords.get(ref);
    if (!node) {
      missing += 1;
      continue;
    }
    points.push([node.lon, node.lat]);
    if (!Number.isNaN(node.ts) && !(node.ts <= lastTs)) lastTs = node.ts;
  }
  return { points, missing, lastTs };
}

function provenance(type: ElementType, id: number, tags: OsmTags, info: OsmNode["info"], lastTs: number, extra: Partial<OsmProvenance> = {}): OsmProvenance {
  return {
    type,
    id,
    version: info?.version ?? null,
    timestamp: iso(info?.timestamp),
    last_modified: iso(lastTs),
    tags,
    ...extra,
  };
}

export interface BuiltLayers {
  substations: Collection<SubstationFeature>;
  transmission: Collection<TransmissionFeature>;
  /** Every collected candidate (selected or not), keyed "node/1", "way/2". */
  substationEvals: Map<string, Evaluation>;
  lineEvals: Map<string, Evaluation>;
}

function substationProps(key: string, tags: OsmTags): SubstationProperties {
  return {
    osm_id: key,
    name: text(tags.name),
    operator: text(tags.operator),
    voltage_kv: maxVoltageKv(tags.voltage),
    substation: text(tags.substation),
  };
}

function lineProps(id: number, tags: OsmTags): TransmissionProperties {
  return {
    osm_id: id,
    voltage_kv: maxVoltageKv(tags.voltage),
    operator: text(tags.operator),
    name: text(tags.name),
    cables: text(tags.cables),
    circuits: text(tags.circuits),
    line: text(tags.line),
  };
}

export function evaluateSubstations(osm: CollectedOsm, rules: BuildRules): Map<string, Evaluation & { point: Position | null }> {
  const out = new Map<string, Evaluation & { point: Position | null }>();
  for (const node of osm.nodes.values()) {
    const key = `node/${node.id}`;
    const point: Position = [node.lon, node.lat];
    const reasons: string[] = [];
    if (!isSubstation(node.tags)) reasons.push(`power=${node.tags.power ?? "(none)"}`);
    const distance = greatCircleMiles(CENTER, point);
    if (distance > RADIUS_MI) reasons.push("outside_radius");
    out.set(key, {
      key,
      selected: reasons.length === 0,
      reasons,
      minDistanceMi: distance,
      provenance: provenance("node", node.id, node.tags, node.info, node.info?.timestamp ?? Number.NaN),
      points: [point],
      point,
    });
  }
  for (const way of osm.ways.values()) {
    const key = `way/${way.id}`;
    if (!isSubstation(way.tags) && !osm.wantedSubstationWays?.has(way.id)) continue;
    const { points, missing, lastTs } = wayPoints(way, osm.coords);
    const reasons: string[] = [];
    if (!isSubstation(way.tags)) reasons.push(`power=${way.tags.power ?? "(none)"}`);
    if (missing) reasons.push(points.length ? "incomplete_geometry" : "no_geometry");
    const point = points.length ? centroid(points, rules.centroid) : null;
    if (point && !withinRadius(points, point, rules.substationRadius)) reasons.push("outside_radius");
    out.set(key, {
      key,
      selected: Boolean(point) && reasons.every((r) => r === "incomplete_geometry"),
      reasons,
      minDistanceMi: points.length ? minDistanceMiles(points) : null,
      provenance: provenance("way", way.id, way.tags, way.info, lastTs, { nodes: way.refs, ...(missing ? { missing_nodes: missing } : {}) }),
      points,
      point,
    });
  }
  for (const relation of osm.relations.values()) {
    const key = `relation/${relation.id}`;
    const points: Position[] = [];
    let missing = 0;
    let lastTs = relation.info?.timestamp ?? Number.NaN;
    for (const member of relation.members) {
      if (member.type === "node") {
        const node = osm.coords.get(member.ref);
        if (node) points.push([node.lon, node.lat]);
        else missing += 1;
      } else if (member.type === "way") {
        const way = osm.ways.get(member.ref);
        if (!way) {
          missing += 1;
          continue;
        }
        const wp = wayPoints(way, osm.coords);
        points.push(...wp.points);
        missing += wp.missing;
        if (!(wp.lastTs <= lastTs)) lastTs = wp.lastTs;
      }
    }
    const reasons: string[] = [];
    if (!isSubstation(relation.tags)) reasons.push(`power=${relation.tags.power ?? "(none)"}`);
    if (!rules.includeRelations) reasons.push("relations_excluded");
    if (missing) reasons.push(points.length ? "incomplete_geometry" : "no_geometry");
    const point = points.length ? centroid(points, "bbox") : null;
    if (point && !withinRadius(points, point, rules.substationRadius === "center" ? "center" : "vertex")) reasons.push("outside_radius");
    out.set(key, {
      key,
      selected: Boolean(point) && reasons.every((r) => r === "incomplete_geometry"),
      reasons,
      minDistanceMi: points.length ? Math.min(...points.map((p) => greatCircleMiles(CENTER, p))) : null,
      provenance: provenance("relation", relation.id, relation.tags, relation.info, lastTs, missing ? { missing_nodes: missing } : {}),
      points,
      point,
    });
  }
  return out;
}

export function evaluateLines(osm: CollectedOsm, rules: BuildRules): Map<string, Evaluation> {
  const out = new Map<string, Evaluation>();
  for (const way of osm.ways.values()) {
    if (!isLine(way.tags) && !osm.wantedLineWays?.has(way.id)) continue;
    const key = String(way.id);
    const { points, missing, lastTs } = wayPoints(way, osm.coords);
    const reasons: string[] = [];
    if (!isLine(way.tags)) reasons.push(`power=${way.tags.power ?? "(none)"}`);
    if (!lineVoltageSelected(way.tags.voltage)) reasons.push("below_69kv");
    if (missing) reasons.push(points.length >= 2 ? "incomplete_geometry" : "no_geometry");
    if (points.length >= 2 && !withinRadius(points, points[0], rules.lineRadius)) reasons.push("outside_radius");
    out.set(key, {
      key,
      selected: points.length >= 2 && reasons.every((r) => r === "incomplete_geometry"),
      reasons,
      minDistanceMi: points.length ? minDistanceMiles(points) : null,
      provenance: provenance("way", way.id, way.tags, way.info, lastTs, { nodes: way.refs, ...(missing ? { missing_nodes: missing } : {}) }),
      points,
    });
  }
  return out;
}

const SUB_METADATA = (header: OsmHeader | undefined, source: string) => ({
  source,
  license: "ODbL",
  center_westminster_hs: [CENTER[1], CENTER[0]],
  radius_mi: RADIUS_MI,
  note: "power=substation nodes and ways (relations excluded), point = mean of all way node refs incl. the closing node",
  replication_timestamp: header?.replicationTimestamp ? iso(header.replicationTimestamp) : null,
  replication_sequence: header?.replicationSequence ?? null,
});

export function buildLayers(osm: CollectedOsm, rules: BuildRules = INFERRED_RULES, source = "OpenStreetMap PBF extract"): BuiltLayers {
  const substationEvals = evaluateSubstations(osm, rules);
  const lineEvals = evaluateLines(osm, rules);
  const order = { node: 0, way: 1, relation: 2 } as const;
  const substationFeatures: SubstationFeature[] = [...substationEvals.values()]
    .filter((e) => e.selected && e.point)
    .sort((a, b) => order[a.provenance.type] - order[b.provenance.type] || a.provenance.id - b.provenance.id)
    .map((e) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: e.point! },
      properties: substationProps(e.key, e.provenance.tags),
      osm: e.provenance,
    }));
  const lineFeatures: TransmissionFeature[] = [...lineEvals.values()]
    .filter((e) => e.selected)
    .sort((a, b) => a.provenance.id - b.provenance.id)
    .map((e) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: e.points },
      properties: lineProps(e.provenance.id, e.provenance.tags),
      osm: e.provenance,
    }));
  const meta = SUB_METADATA(osm.header, source);
  return {
    substations: { type: "FeatureCollection", metadata: meta, features: substationFeatures },
    transmission: {
      type: "FeatureCollection",
      metadata: { ...meta, note: "power=line ways >= 69 kV or untagged; voltage_kv is the highest tagged voltage" },
      features: lineFeatures,
    },
    substationEvals,
    lineEvals,
  };
}

/* ------------------------------------------------------------------------ */
/* Diff                                                                      */
/* ------------------------------------------------------------------------ */

export type DiffClass =
  | "added"
  | "removed"
  | "geometry_changed"
  | "property_changed"
  | "unchanged";

export type Cause =
  | "osm_edit_after_snapshot"
  | "osm_edit_timing_unknown"
  | "element_absent_from_extract"
  | "extract_boundary"
  | "rule_mismatch"
  | "unexplained";

export interface FieldChange {
  field: string;
  committed: unknown;
  regen: unknown;
}

export interface DiffEntry {
  layer: "substations" | "transmission";
  id: string;
  classes: DiffClass[];
  geometry?: { max_displacement_m: number; committed_vertices: number; regen_vertices: number; method: string };
  fields?: FieldChange[];
  /** Why a removed element is no longer selected (from the regen evaluation). */
  reasons?: string[];
  version: number | null;
  baseline_version: "unknown";
  timestamp: string | null;
  last_modified: string | null;
  min_distance_mi: number | null;
  cause: Cause;
}

export interface BoundaryCase {
  layer: "substations" | "transmission";
  id: string;
  kind: "radius" | "voltage_parse";
  detail: string;
  in_committed: boolean;
  in_regen: boolean;
}

export interface DiffReport {
  counts: Record<"substations" | "transmission", Record<string, number>>;
  causes: Record<"substations" | "transmission", Record<string, Record<string, number>>>;
  snapshot: Record<
    "substations" | "transmission",
    { lower_bound: string | null; lower_bound_evidence: string | null; upper_bound: string | null; upper_bound_evidence: string | null }
  >;
  entries: DiffEntry[];
  boundary: BoundaryCase[];
}

export function metres(a: Position, b: Position): number {
  return greatCircleMiles(a, b) * METRES_PER_MILE;
}

/** Max vertex displacement; pairwise if vertex counts match, otherwise discrete Hausdorff. */
export function displacement(committed: Position[], regen: Position[]): { max: number; method: string } {
  if (committed.length === regen.length) {
    let max = 0;
    for (let i = 0; i < committed.length; i += 1) max = Math.max(max, metres(committed[i], regen[i]));
    // a reversed way is not a geometry change worth hiding: report both
    let reversed = 0;
    for (let i = 0; i < committed.length; i += 1) reversed = Math.max(reversed, metres(committed[i], regen[regen.length - 1 - i]));
    return reversed < max ? { max: reversed, method: "pairwise_reversed" } : { max, method: "pairwise" };
  }
  const directed = (a: Position[], b: Position[]) => {
    let worst = 0;
    for (const p of a) {
      let best = Infinity;
      for (const q of b) best = Math.min(best, metres(p, q));
      worst = Math.max(worst, best);
    }
    return worst;
  };
  return { max: Math.max(directed(committed, regen), directed(regen, committed)), method: "hausdorff_vertices" };
}

function sameCoords(a: Position[], b: Position[]): boolean {
  return a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);
}

type AnyFeature = { geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown>; osm?: OsmProvenance };

function positions(feature: AnyFeature): Position[] {
  return feature.geometry.type === "Point" ? [feature.geometry.coordinates as Position] : (feature.geometry.coordinates as Position[]);
}

export interface DiffInput {
  committedSubstations: Collection<AnyFeature>;
  committedTransmission: Collection<AnyFeature>;
  built: Pick<BuiltLayers, "substations" | "transmission" | "substationEvals" | "lineEvals">;
  /** Extract polygon bbox [left, bottom, right, top] for "outside extract" attribution. */
  extractBbox?: [number, number, number, number];
}

const toSeconds = (value: string | null): number => (value ? Date.parse(value) / 1000 : Number.NaN);

export function diffLayers(input: DiffInput): DiffReport {
  const entries: DiffEntry[] = [];
  const boundary: BoundaryCase[] = [];
  const layers = [
    { layer: "substations" as const, committed: input.committedSubstations, regen: input.built.substations as unknown as Collection<AnyFeature>, evals: input.built.substationEvals },
    { layer: "transmission" as const, committed: input.committedTransmission, regen: input.built.transmission as unknown as Collection<AnyFeature>, evals: input.built.lineEvals },
  ];

  for (const { layer, committed, regen, evals } of layers) {
    const committedById = new Map(committed.features.map((f) => [String(f.properties.osm_id), f]));
    const regenById = new Map(regen.features.map((f) => [String(f.properties.osm_id), f]));
    for (const [id, c] of committedById) {
      const r = regenById.get(id);
      const evaluation = evals.get(id);
      const prov = r?.osm ?? evaluation?.provenance;
      const base = {
        layer,
        id,
        version: prov?.version ?? null,
        baseline_version: "unknown" as const,
        timestamp: prov?.timestamp ?? null,
        last_modified: prov?.last_modified ?? null,
        min_distance_mi: evaluation?.minDistanceMi ?? null,
      };
      if (!r) {
        entries.push({ ...base, classes: ["removed"], reasons: evaluation ? evaluation.reasons : ["absent_from_extract"], cause: "unexplained" });
        continue;
      }
      const classes: DiffClass[] = [];
      const cPos = positions(c);
      const rPos = positions(r).map(roundPosition);
      let geometry: DiffEntry["geometry"];
      if (!sameCoords(cPos, rPos)) {
        const d = displacement(cPos, positions(r));
        geometry = { max_displacement_m: Math.round(d.max * 100) / 100, committed_vertices: cPos.length, regen_vertices: rPos.length, method: d.method };
        classes.push("geometry_changed");
      }
      const fields: FieldChange[] = [];
      for (const field of Object.keys(c.properties)) {
        if (field === "osm_id") continue;
        if (c.properties[field] !== r.properties[field]) fields.push({ field, committed: c.properties[field], regen: r.properties[field] });
      }
      if (fields.length) classes.push("property_changed");
      if (!classes.length) classes.push("unchanged");
      entries.push({ ...base, classes, ...(geometry ? { geometry } : {}), ...(fields.length ? { fields } : {}), cause: "unexplained" });
    }
    for (const [id, r] of regenById) {
      if (committedById.has(id)) continue;
      const evaluation = evals.get(id);
      entries.push({
        layer,
        id,
        classes: ["added"],
        version: r.osm?.version ?? null,
        baseline_version: "unknown",
        timestamp: r.osm?.timestamp ?? null,
        last_modified: r.osm?.last_modified ?? null,
        min_distance_mi: evaluation?.minDistanceMi ?? null,
        cause: "unexplained",
      });
    }
    // Boundary cases: near the radius, and voltage tags whose parse is not a plain single number.
    for (const evaluation of evals.values()) {
      const inCommitted = committedById.has(evaluation.key);
      const inRegen = regenById.has(evaluation.key);
      if (evaluation.minDistanceMi !== null && Math.abs(evaluation.minDistanceMi - RADIUS_MI) <= 0.5 && (inCommitted || inRegen || evaluation.reasons.length === 1)) {
        boundary.push({ layer, id: evaluation.key, kind: "radius", detail: `min distance ${evaluation.minDistanceMi.toFixed(3)} mi`, in_committed: inCommitted, in_regen: inRegen });
      }
      const voltage = evaluation.provenance.tags.voltage;
      if (voltage !== undefined && (inCommitted || inRegen) && !/^\d+$/.test(voltage)) {
        boundary.push({ layer, id: evaluation.key, kind: "voltage_parse", detail: `voltage=${JSON.stringify(voltage)} -> ${JSON.stringify(parseVoltageKv(voltage))} max ${maxVoltageKv(voltage)}`, in_committed: inCommitted, in_regen: inRegen });
      }
    }
  }

  // Snapshot bracket, per layer (the two committed layers need not share a capture time).
  // Lower bound: a committed element still at version 1 existed at snapshot time, so
  // snapshot >= its creation timestamp. Upper bound: the earliest-created (version 1)
  // element the rules select that is absent from the committed layer, assuming it is
  // absent because it did not exist yet, or the earliest last-edit among changed
  // elements, assuming each change is an OSM edit (both assumptions are reported).
  const snapshot = {} as DiffReport["snapshot"];
  for (const layer of ["substations", "transmission"] as const) {
    let lower = Number.NEGATIVE_INFINITY;
    let lowerEvidence: string | null = null;
    let upper = Number.POSITIVE_INFINITY;
    let upperEvidence: string | null = null;
    for (const entry of entries) {
      if (entry.layer !== layer || entry.version !== 1) continue;
      const ts = toSeconds(entry.timestamp);
      if (!entry.classes.includes("added") && ts > lower) {
        lower = ts;
        lowerEvidence = `${entry.id} (version 1, created ${entry.timestamp}) is in the committed layer`;
      }
    }
    for (const entry of entries) {
      if (entry.layer !== layer || entry.classes.includes("unchanged") || entry.classes.includes("removed")) continue;
      // Added v1 elements: creation time. Changed elements: latest edit to the way or its nodes.
      const added = entry.classes.includes("added");
      if (added && entry.version !== 1) continue;
      const ts = toSeconds(added ? entry.timestamp : entry.last_modified);
      if (ts > lower && ts < upper) {
        upper = ts;
        upperEvidence = added
          ? `${entry.id} (version 1, created ${entry.timestamp}) is selected but absent from the committed layer`
          : `${entry.id} differs from the committed layer (${entry.classes.join("+")}) and was last edited (way or a member node) at ${entry.last_modified}`;
      }
    }
    snapshot[layer] = {
      lower_bound: Number.isFinite(lower) ? iso(lower) : null,
      lower_bound_evidence: lowerEvidence,
      upper_bound: Number.isFinite(upper) ? iso(upper) : null,
      upper_bound_evidence: upperEvidence,
    };
  }

  // Cause attribution.
  const inBbox = (points: Position[]) => {
    const box = input.extractBbox;
    if (!box) return true;
    return points.every(([x, y]) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]);
  };
  for (const entry of entries) {
    if (entry.classes.includes("unchanged")) {
      entry.cause = "osm_edit_timing_unknown";
      continue;
    }
    const lastModified = toSeconds(entry.last_modified);
    const lower = toSeconds(snapshot[entry.layer].lower_bound);
    const editedAfter = Number.isFinite(lastModified) && Number.isFinite(lower) && lastModified > lower;
    if (entry.classes.includes("removed")) {
      const reasons = entry.reasons ?? [];
      const committedFeature = (entry.layer === "substations" ? input.committedSubstations : input.committedTransmission).features.find(
        (f) => String(f.properties.osm_id) === entry.id,
      );
      if (reasons.includes("absent_from_extract")) {
        entry.cause = committedFeature && !inBbox(positions(committedFeature)) ? "extract_boundary" : "element_absent_from_extract";
      } else if (reasons.includes("no_geometry") || reasons.includes("incomplete_geometry")) entry.cause = "extract_boundary";
      else entry.cause = editedAfter ? "osm_edit_after_snapshot" : "rule_mismatch";
      continue;
    }
    if (entry.classes.includes("added")) {
      entry.cause = editedAfter ? "osm_edit_after_snapshot" : "rule_mismatch";
      continue;
    }
    entry.cause = editedAfter ? "osm_edit_after_snapshot" : "rule_mismatch";
  }

  const counts: DiffReport["counts"] = { substations: {}, transmission: {} };
  const causes: DiffReport["causes"] = { substations: {}, transmission: {} };
  for (const entry of entries) {
    for (const cls of entry.classes) {
      counts[entry.layer][cls] = (counts[entry.layer][cls] ?? 0) + 1;
      const byCause = (causes[entry.layer][cls] ??= {});
      byCause[entry.cause] = (byCause[entry.cause] ?? 0) + 1;
    }
  }
  return {
    counts,
    causes,
    snapshot,
    entries,
    boundary,
  };
}

/* ------------------------------------------------------------------------ */
/* Rule inference (variants scored against the committed layers)             */
/* ------------------------------------------------------------------------ */

export interface InferenceReport {
  centroid: Record<CentroidMethod, { exact_5dp: number; within_1m: number; compared: number }>;
  substation_radius: Record<RadiusMethod, { selected: number; committed_hit: number; extra: number }>;
  line_radius: Record<RadiusMethod, { selected: number; committed_hit: number; extra: number }>;
  line_voltage: Record<string, { selected: number; committed_hit: number; extra: number }>;
  voltage_kv: Record<string, { substations_match: number; lines_match: number; compared_substations: number; compared_lines: number }>;
  relations_selected: number;
  committed_relations: number;
}

export function inferRules(osm: CollectedOsm, committedSubs: Collection<AnyFeature>, committedLines: Collection<AnyFeature>): InferenceReport {
  const subIds = new Set(committedSubs.features.map((f) => String(f.properties.osm_id)));
  const lineIds = new Set(committedLines.features.map((f) => String(f.properties.osm_id)));
  const subById = new Map(committedSubs.features.map((f) => [String(f.properties.osm_id), f]));
  const lineById = new Map(committedLines.features.map((f) => [String(f.properties.osm_id), f]));

  const centroidScore = {} as InferenceReport["centroid"];
  for (const method of ["ref_mean", "bbox", "vertex_mean", "area"] as CentroidMethod[]) {
    let exact = 0;
    let near = 0;
    let compared = 0;
    for (const way of osm.ways.values()) {
      const c = subById.get(`way/${way.id}`);
      if (!c || !isSubstation(way.tags)) continue;
      const { points, missing } = wayPoints(way, osm.coords);
      if (missing || !points.length) continue;
      compared += 1;
      const p = centroid(points, method);
      const committed = c.geometry.coordinates as Position;
      if (round5(p[0]) === committed[0] && round5(p[1]) === committed[1]) exact += 1;
      if (metres(p, committed) <= 1) near += 1;
    }
    centroidScore[method] = { exact_5dp: exact, within_1m: near, compared };
  }

  const score = (selected: Set<string>, committed: Set<string>) => {
    let hit = 0;
    for (const id of selected) if (committed.has(id)) hit += 1;
    return { selected: selected.size, committed_hit: hit, extra: selected.size - hit };
  };

  const subRadius = {} as InferenceReport["substation_radius"];
  const lineRadius = {} as InferenceReport["line_radius"];
  for (const method of ["segment", "vertex", "center"] as RadiusMethod[]) {
    const rules = { ...INFERRED_RULES, substationRadius: method, lineRadius: method };
    const subs = new Set([...evaluateSubstations(osm, rules).values()].filter((e) => e.selected).map((e) => e.key));
    const lines = new Set([...evaluateLines(osm, rules).values()].filter((e) => e.selected).map((e) => e.key));
    subRadius[method] = score(subs, subIds);
    lineRadius[method] = score(lines, lineIds);
  }

  const lineEvals = evaluateLines(osm, INFERRED_RULES);
  const geometryOk = (e: Evaluation) => !e.reasons.some((r) => r === "outside_radius" || r === "no_geometry" || r.startsWith("power="));
  const voltageRules: Record<string, (tag: string | undefined) => boolean> = {
    "max>=69 or unparseable": lineVoltageSelected,
    "max>=69 only (drop untagged)": (tag) => (maxVoltageKv(tag) ?? 0) >= 69,
    "first>=69 or unparseable": (tag) => {
      const v = parseVoltageKv(tag);
      return !v.length || v[0] >= 69;
    },
    "min>=69 or unparseable": (tag) => {
      const v = parseVoltageKv(tag);
      return !v.length || Math.min(...v) >= 69;
    },
    "max>66 or unparseable": (tag) => {
      const v = maxVoltageKv(tag);
      return v === null || v > 66;
    },
    "any voltage": () => true,
  };
  const lineVoltage: InferenceReport["line_voltage"] = {};
  for (const [label, rule] of Object.entries(voltageRules)) {
    const selected = new Set([...lineEvals.values()].filter((e) => geometryOk(e) && rule(e.provenance.tags.voltage)).map((e) => e.key));
    lineVoltage[label] = score(selected, lineIds);
  }

  const kvRules: Record<string, (tag: string | undefined) => number | null> = {
    max: maxVoltageKv,
    first: (tag) => parseVoltageKv(tag)[0] ?? null,
    min: (tag) => {
      const v = parseVoltageKv(tag);
      return v.length ? Math.min(...v) : null;
    },
  };
  const voltageKv: InferenceReport["voltage_kv"] = {};
  for (const [label, rule] of Object.entries(kvRules)) {
    let sm = 0;
    let sc = 0;
    let lm = 0;
    let lc = 0;
    for (const [key, f] of subById) {
      const [type, id] = key.split("/");
      const el = type === "node" ? osm.nodes.get(Number(id)) : type === "way" ? osm.ways.get(Number(id)) : osm.relations.get(Number(id));
      if (!el || (el.tags.voltage ?? "").indexOf(";") < 0) continue;
      sc += 1;
      if (rule(el.tags.voltage) === f.properties.voltage_kv) sm += 1;
    }
    for (const [key, f] of lineById) {
      const el = osm.ways.get(Number(key));
      if (!el || (el.tags.voltage ?? "").indexOf(";") < 0) continue;
      lc += 1;
      if (rule(el.tags.voltage) === f.properties.voltage_kv) lm += 1;
    }
    voltageKv[label] = { substations_match: sm, lines_match: lm, compared_substations: sc, compared_lines: lc };
  }

  const relationsSelected = [...evaluateSubstations(osm, { ...INFERRED_RULES, includeRelations: true }).values()].filter((e) => e.selected && e.provenance.type === "relation").length;
  return {
    centroid: centroidScore,
    substation_radius: subRadius,
    line_radius: lineRadius,
    line_voltage: lineVoltage,
    voltage_kv: voltageKv,
    relations_selected: relationsSelected,
    committed_relations: committedSubs.features.filter((f) => String(f.properties.osm_id).startsWith("relation/")).length,
  };
}

/* ------------------------------------------------------------------------ */
/* Pinning manifest                                                          */
/* ------------------------------------------------------------------------ */

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Parse a `curl -sSIL` header dump (possibly several responses) into the final response's headers. */
export function parseCurlHeaders(dump: string): { statuses: number[]; final: Record<string, string> } {
  const blocks = dump.split(/\r?\n\r?\n/).map((b) => b.trim()).filter((b) => b.startsWith("HTTP/"));
  const statuses: number[] = [];
  let final: Record<string, string> = {};
  for (const block of blocks) {
    const [status, ...lines] = block.split(/\r?\n/);
    statuses.push(Number(status.split(" ")[1]));
    final = {};
    for (const line of lines) {
      const at = line.indexOf(":");
      if (at > 0) final[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
  }
  return { statuses, final };
}

async function atomicWrite(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function headerOnly(pbfPath: string): Promise<OsmHeader | undefined> {
  let header: OsmHeader | undefined;
  await readOsmPbf(pbfPath, {}, { onHeader: (h) => void (header = h), onBlock: () => false });
  return header;
}

/* ------------------------------------------------------------------------ */
/* Command                                                                   */
/* ------------------------------------------------------------------------ */

function flag(args: string[], name: string, fallback?: string): string {
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] !== undefined) return args[index + 1];
  if (fallback === undefined) throw new Error(`Missing --${name}`);
  return fallback;
}

const DEFAULT_DIR = "research/etl-state/osm";
const DEFAULT_PBF = `${DEFAULT_DIR}/socal-261113.osm.pbf`;

/**
 * osm-regen pin  --pbf F --url U --headers curl-I-dump [--out manifest.json]
 * osm-regen regen [--pbf F] [--manifest M] [--committed public/layers] [--out dir]
 */
export async function runOsmRegenCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "pin") {
    const pbf = resolve(flag(rest, "pbf", DEFAULT_PBF));
    const headerDump = await readFile(resolve(flag(rest, "headers")), "utf8");
    const { statuses, final } = parseCurlHeaders(headerDump);
    const size = (await stat(pbf)).size;
    if (final["content-length"] && Number(final["content-length"]) !== size) {
      throw new Error(`Downloaded size ${size} != Content-Length ${final["content-length"]}`);
    }
    const header = await headerOnly(pbf);
    const manifest = {
      url: flag(rest, "url"),
      final_url: flag(rest, "final-url", flag(rest, "url")),
      http_statuses: statuses,
      size_bytes: size,
      content_length: final["content-length"] ? Number(final["content-length"]) : null,
      last_modified: final["last-modified"] ?? null,
      etag: final.etag ?? null,
      sha256: await sha256File(pbf),
      md5_published: rest.includes("--md5") ? flag(rest, "md5") : null,
      file: pbf.split("/").pop(),
      header: {
        required_features: header?.requiredFeatures ?? [],
        optional_features: header?.optionalFeatures ?? [],
        writing_program: header?.writingProgram ?? null,
        bbox: header?.bbox ?? null,
        osmosis_replication_timestamp: header?.replicationTimestamp ?? null,
        osmosis_replication_timestamp_iso: iso(header?.replicationTimestamp),
        osmosis_replication_sequence_number: header?.replicationSequence ?? null,
        osmosis_replication_base_url: header?.replicationBaseUrl ?? null,
      },
      pinned_at: new Date().toISOString(),
    };
    const out = resolve(flag(rest, "out", `${DEFAULT_DIR}/manifest.json`));
    await atomicWrite(out, JSON.stringify(manifest, null, 2) + "\n");
    console.log(JSON.stringify({ pinned: out, sha256: manifest.sha256, size: size }));
    return;
  }
  if (sub === "regen") {
    const pbf = resolve(flag(rest, "pbf", DEFAULT_PBF));
    const committedDir = resolve(flag(rest, "committed", "public/layers"));
    const outDir = resolve(flag(rest, "out", `${DEFAULT_DIR}/regen`));
    if (outDir.startsWith(resolve("public"))) throw new Error("Refusing to write regenerated layers under public/");
    const manifestPath = resolve(flag(rest, "manifest", `${DEFAULT_DIR}/manifest.json`));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { sha256?: string; url?: string; final_url?: string };
    const committedSubstations = JSON.parse(await readFile(`${committedDir}/substations.geojson`, "utf8")) as Collection<AnyFeature>;
    const committedTransmission = JSON.parse(await readFile(`${committedDir}/transmission.geojson`, "utf8")) as Collection<AnyFeature>;

    const wanted: WantedIds = { nodes: new Set(), ways: new Set(), relations: new Set() };
    const substationWays = new Set<number>();
    for (const f of committedSubstations.features) {
      const [type, id] = String(f.properties.osm_id).split("/");
      if (type === "way") substationWays.add(Number(id));
      (wanted[`${type}s` as keyof WantedIds] as Set<number>).add(Number(id));
    }
    for (const f of committedTransmission.features) wanted.ways.add(Number(f.properties.osm_id));

    // Provenance quotes the manifest's sha256, so the parsed file must be the pinned file.
    if (manifest.sha256 !== undefined) {
      const actual = await sha256File(pbf);
      if (actual !== manifest.sha256) throw new Error(`PBF sha256 ${actual} does not match manifest sha256 ${manifest.sha256}`);
    }
    const started = Date.now();
    const osm = await collectOsm(pbf, wanted, (line) => console.error(line));
    osm.wantedSubstationWays = substationWays;
    osm.wantedLineWays = new Set(committedTransmission.features.map((f) => Number(f.properties.osm_id)));
    const source = `OpenStreetMap PBF extract ${manifest.final_url ?? manifest.url ?? pbf} (sha256 ${manifest.sha256 ?? "unpinned"})`;
    const built = buildLayers(osm, INFERRED_RULES, source);
    const inference = inferRules(osm, committedSubstations, committedTransmission);
    const diff = diffLayers({ committedSubstations, committedTransmission, built, extractBbox: osm.header?.bbox });

    await atomicWrite(`${outDir}/substations.geojson`, JSON.stringify(built.substations) + "\n");
    await atomicWrite(`${outDir}/transmission.geojson`, JSON.stringify(built.transmission) + "\n");
    await atomicWrite(`${outDir}/inference.json`, JSON.stringify(inference, null, 2) + "\n");
    await atomicWrite(`${outDir}/diff.json`, JSON.stringify(diff, null, 2) + "\n");
    console.log(
      JSON.stringify({
        out: outDir,
        wall_ms: Date.now() - started,
        stats: osm.stats,
        coord_index_bytes: osm.coords.bytes(),
        regen: { substations: built.substations.features.length, transmission: built.transmission.features.length },
        committed: { substations: committedSubstations.features.length, transmission: committedTransmission.features.length },
        counts: diff.counts,
        causes: diff.causes,
        snapshot: diff.snapshot,
        inference,
      }, null, 2),
    );
    return;
  }
  throw new Error("Usage: osm-regen pin --pbf F --url U --headers H [--final-url U2] [--md5 X] [--out M] | osm-regen regen [--pbf F] [--manifest M] [--committed DIR] [--out DIR]");
}
