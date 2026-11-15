// Owner schedule engine: back-scheduling, critical path, immutable baselines,
// reforecast variance, missed-window and expiry flags, disruption propagation.
//
// Pure and deterministic. Dates are ISO strings with explicit offsets; output
// dates are UTC ISO strings. Calendar assumption: continuous calendar days
// (24 h), no work calendar or holidays. Dates are forecasts, not promised
// authority timelines (INFRASTRUCTURE-LIFECYCLE §5).

import type { OwnerTask } from "./planTypes";
import { parseTime, stableHash } from "./lifecycle";

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const days = (a: number, b: number) => Math.round((a - b) / DAY_MS);

export type ScheduleErrorCode = "CYCLE" | "UNKNOWN_DEPENDENCY" | "DUPLICATE_TASK" | "INVALID_DURATION" | "UNKNOWN_TASK";
export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;
  readonly taskIds: string[];
  constructor(code: ScheduleErrorCode, message: string, taskIds: string[]) {
    super(`${code}: ${message}`);
    this.name = "ScheduleError";
    this.code = code;
    this.taskIds = taskIds;
  }
}

/** Subset of OwnerTask the engine needs; full OwnerTask objects are accepted. */
export type SchedTask = Pick<OwnerTask, "id" | "dependsOn" | "durationDays" | "offsetDays"> & { title?: string };

/** A period shift: the task takes `delayDays` longer (e.g. lead-time slip). */
export interface Disruption { id: string; taskId: string; delayDays: number; reason: string; at: string }
export interface Window { id: string; kind: "grant_deadline" | "submission_window" | "outage_window" | "other"; taskId: string; deadline: string }
export interface Expiry { id: string; expiresAt: string; coversTaskIds: string[] }

export interface ScheduleOptions {
  /** Plan anchor: no task starts before anchor + offsetDays. If omitted, back-scheduled from targetFinish. */
  anchor?: string;
  targetFinish?: string;
  disruptions?: Disruption[];
  windows?: Window[];
  expiries?: Expiry[];
}

export interface ScheduledTask {
  id: string; earlyStart: string; earlyFinish: string; lateStart: string; lateFinish: string;
  floatDays: number; critical: boolean; delayDays: number;
}

export type ScheduleFlag =
  | { code: "TARGET_MISSED"; taskId: string; reason: string; days: number }
  | { code: "MISSED_WINDOW"; taskId: string; windowId: string; reason: string; days: number }
  | { code: "EXPIRES_BEFORE_COMPLETION"; taskId: string; expiryId: string; reason: string; days: number };

export interface ScheduleResult {
  anchor: string; targetFinish: string | null; projectedFinish: string;
  /** Latest plan anchor that still meets targetFinish (back-scheduled). */
  requiredStart: string | null;
  order: string[]; tasks: ScheduledTask[]; criticalPath: string[]; flags: ScheduleFlag[];
  assumptions: string[]; hash: string;
}

/** Topological order (Kahn, ties by id). Throws CYCLE / UNKNOWN_DEPENDENCY / DUPLICATE_TASK. */
export function topoOrder(tasks: SchedTask[]): string[] {
  const byId = new Map<string, SchedTask>();
  for (const t of tasks) {
    if (byId.has(t.id)) throw new ScheduleError("DUPLICATE_TASK", `task ${t.id} appears twice`, [t.id]);
    if (!(t.durationDays >= 0) || !Number.isFinite(t.durationDays)) throw new ScheduleError("INVALID_DURATION", `task ${t.id} duration ${t.durationDays}`, [t.id]);
    byId.set(t.id, t);
  }
  const indeg = new Map<string, number>();
  const succ = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.id, indeg.get(t.id) ?? 0);
    for (const d of t.dependsOn) {
      if (!byId.has(d)) throw new ScheduleError("UNKNOWN_DEPENDENCY", `task ${t.id} depends on unknown ${d}`, [t.id, d]);
      indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
      succ.set(d, [...(succ.get(d) ?? []), t.id]);
    }
  }
  const ready = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift() as string;
    order.push(id);
    for (const s of (succ.get(id) ?? []).sort()) {
      const n = (indeg.get(s) ?? 0) - 1;
      indeg.set(s, n);
      if (n === 0) { ready.push(s); ready.sort(); }
    }
  }
  if (order.length !== tasks.length) {
    const stuck = tasks.map((t) => t.id).filter((id) => !order.includes(id)).sort();
    throw new ScheduleError("CYCLE", `dependency cycle among ${findCycle(byId, stuck).join(" → ")}`, stuck);
  }
  return order;
}

function findCycle(byId: Map<string, SchedTask>, stuck: string[]): string[] {
  const inStuck = new Set(stuck);
  const start = stuck[0];
  const path: string[] = [];
  const seen = new Map<string, number>();
  let cur: string | undefined = start;
  while (cur !== undefined && !seen.has(cur)) {
    seen.set(cur, path.length);
    path.push(cur);
    cur = (byId.get(cur)?.dependsOn ?? []).filter((d) => inStuck.has(d)).sort()[0];
  }
  return cur === undefined ? path : [...path.slice(seen.get(cur)), cur];
}

/** Critical-path schedule. If no anchor is given, the plan is back-scheduled from targetFinish. */
export function schedule(tasks: SchedTask[], opts: ScheduleOptions): ScheduleResult {
  if (!opts.anchor && !opts.targetFinish) throw new ScheduleError("UNKNOWN_TASK", "anchor or targetFinish required", []);
  const order = topoOrder(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const delay = new Map<string, number>();
  for (const d of opts.disruptions ?? []) {
    if (!byId.has(d.taskId)) throw new ScheduleError("UNKNOWN_TASK", `disruption ${d.id} targets unknown task ${d.taskId}`, [d.taskId]);
    parseTime(d.at, "disruption.at");
    delay.set(d.taskId, (delay.get(d.taskId) ?? 0) + d.delayDays);
  }
  const span = (id: string) => (byId.get(id) as SchedTask).durationDays + (delay.get(id) ?? 0);
  const succ = new Map<string, string[]>();
  for (const t of tasks) for (const d of t.dependsOn) succ.set(d, [...(succ.get(d) ?? []), t.id]);

  // Backward pass (latest dates) from target, if given.
  const target = opts.targetFinish ? parseTime(opts.targetFinish, "targetFinish") : null;
  const backward = (finish: number) => {
    const lf = new Map<string, number>();
    const ls = new Map<string, number>();
    for (const id of [...order].reverse()) {
      const ss = succ.get(id) ?? [];
      const f = ss.length ? Math.min(...ss.map((s) => ls.get(s) as number)) : finish;
      lf.set(id, f);
      ls.set(id, f - span(id) * DAY_MS);
    }
    return { lf, ls };
  };

  let anchorMs: number;
  let requiredStart: number | null = null;
  if (target !== null) {
    const { ls } = backward(target);
    requiredStart = Math.min(...order.map((id) => (ls.get(id) as number) - (byId.get(id) as SchedTask).offsetDays * DAY_MS));
  }
  if (opts.anchor) anchorMs = parseTime(opts.anchor, "anchor");
  else anchorMs = requiredStart as number;

  // Forward pass.
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  for (const id of order) {
    const t = byId.get(id) as SchedTask;
    const s = Math.max(anchorMs + t.offsetDays * DAY_MS, ...t.dependsOn.map((d) => ef.get(d) as number));
    es.set(id, s);
    ef.set(id, s + span(id) * DAY_MS);
  }
  const projected = Math.max(...order.map((id) => ef.get(id) as number));
  const { lf, ls } = backward(target ?? projected);

  const floats = new Map(order.map((id) => [id, days(ls.get(id) as number, es.get(id) as number)] as const));
  const minFloat = Math.min(...floats.values());
  const scheduled: ScheduledTask[] = order.map((id) => ({
    id, earlyStart: iso(es.get(id) as number), earlyFinish: iso(ef.get(id) as number),
    lateStart: iso(ls.get(id) as number), lateFinish: iso(lf.get(id) as number),
    floatDays: floats.get(id) as number, critical: (floats.get(id) as number) === minFloat, delayDays: delay.get(id) ?? 0,
  }));

  // Critical path: walk back from the latest-finishing critical task through driving critical predecessors.
  const crit = new Set(scheduled.filter((t) => t.critical).map((t) => t.id));
  const path: string[] = [];
  let cur: string | undefined = [...crit].sort((a, b) => (ef.get(b) as number) - (ef.get(a) as number) || a.localeCompare(b))[0];
  while (cur) {
    path.unshift(cur);
    const t = byId.get(cur) as SchedTask;
    const startMs = es.get(cur) as number;
    cur = t.dependsOn.filter((d) => crit.has(d) && ef.get(d) === startMs).sort()[0];
  }

  const flags: ScheduleFlag[] = [];
  if (target !== null && projected > target) {
    const last = order.filter((id) => ef.get(id) === projected).sort()[0];
    flags.push({ code: "TARGET_MISSED", taskId: last, reason: `projected finish ${iso(projected)} after target ${opts.targetFinish}`, days: days(projected, target) });
  }
  for (const w of opts.windows ?? []) {
    if (!byId.has(w.taskId)) throw new ScheduleError("UNKNOWN_TASK", `window ${w.id} targets unknown task ${w.taskId}`, [w.taskId]);
    const dl = parseTime(w.deadline, "window.deadline");
    const f = ef.get(w.taskId) as number;
    if (f > dl) flags.push({ code: "MISSED_WINDOW", taskId: w.taskId, windowId: w.id, reason: `${w.kind} ${w.deadline} precedes earliest finish ${iso(f)}`, days: days(f, dl) });
  }
  for (const x of opts.expiries ?? []) {
    const exp = parseTime(x.expiresAt, "expiry.expiresAt");
    for (const id of x.coversTaskIds) if (!byId.has(id)) throw new ScheduleError("UNKNOWN_TASK", `expiry ${x.id} covers unknown task ${id}`, [id]);
    const covered = x.coversTaskIds.map((id) => ({ id, f: ef.get(id) as number })).sort((a, b) => b.f - a.f || a.id.localeCompare(b.id));
    if (covered.length && covered[0].f > exp) flags.push({ code: "EXPIRES_BEFORE_COMPLETION", taskId: covered[0].id, expiryId: x.id, reason: `${x.id} expires ${x.expiresAt} before covered work finishes ${iso(covered[0].f)}`, days: days(covered[0].f, exp) });
  }
  flags.sort((a, b) => a.code.localeCompare(b.code) || a.taskId.localeCompare(b.taskId));

  const assumptions = [
    "continuous calendar days; no work calendar or holidays",
    "finish-to-start dependencies only; offsetDays is a start-no-earlier-than offset from the anchor",
    "dates are forecasts, not authority commitments",
    ...(opts.anchor ? [] : ["anchor back-scheduled from targetFinish"]),
  ];
  const body = {
    anchor: iso(anchorMs), targetFinish: opts.targetFinish ?? null, projectedFinish: iso(projected),
    requiredStart: requiredStart === null ? null : iso(requiredStart), order, tasks: scheduled, criticalPath: path, flags, assumptions,
  };
  return { ...body, hash: stableHash(body) };
}

/** Back-schedule from a target date (no anchor): latest start that still meets the target. */
export function backSchedule(tasks: SchedTask[], targetFinish: string, opts: Omit<ScheduleOptions, "anchor" | "targetFinish"> = {}): ScheduleResult {
  return schedule(tasks, { ...opts, targetFinish });
}

// ---------------------------------------------------------------------------
// Baselines and reforecast.

export interface ScheduleBaseline {
  readonly id: string; readonly version: number; readonly createdAt: string; readonly anchor: string;
  readonly targetFinish: string | null;
  readonly tasks: readonly { readonly id: string; readonly earlyStart: string; readonly earlyFinish: string }[];
  readonly contentHash: string;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** Snapshot a schedule as an immutable (deep-frozen, hashed) baseline. */
export function createScheduleBaseline(id: string, result: ScheduleResult, createdAt: string, version = 1): ScheduleBaseline {
  parseTime(createdAt, "createdAt");
  const tasks = result.tasks.map((t) => ({ id: t.id, earlyStart: t.earlyStart, earlyFinish: t.earlyFinish }));
  const body = { id, version, createdAt, anchor: result.anchor, targetFinish: result.targetFinish, tasks };
  return deepFreeze({ ...body, contentHash: stableHash(body) });
}

export function baselineIntact(b: ScheduleBaseline): boolean {
  const { contentHash, ...body } = b;
  return stableHash(body) === contentHash;
}

export interface Variance { taskId: string; baselineFinish: string | null; forecastFinish: string | null; varianceDays: number | null }
export interface Reforecast { baselineId: string; baselineHash: string; revision: number; asOf: string; schedule: ScheduleResult; variance: Variance[] }

/** Reforecast against a named baseline. The baseline is never modified. */
export function reforecast(baseline: ScheduleBaseline, tasks: SchedTask[], opts: ScheduleOptions, asOf: string, revision: number): Reforecast {
  parseTime(asOf, "asOf");
  const sched = schedule(tasks, { anchor: opts.anchor ?? baseline.anchor, ...opts });
  const base = new Map(baseline.tasks.map((t) => [t.id, t.earlyFinish] as const));
  const fc = new Map(sched.tasks.map((t) => [t.id, t.earlyFinish] as const));
  const ids = [...new Set([...base.keys(), ...fc.keys()])].sort();
  const variance = ids.map((id) => {
    const b = base.get(id) ?? null;
    const f = fc.get(id) ?? null;
    return { taskId: id, baselineFinish: b, forecastFinish: f, varianceDays: b && f ? days(Date.parse(f), Date.parse(b)) : null };
  });
  return { baselineId: baseline.id, baselineHash: baseline.contentHash, revision, asOf, schedule: sched, variance };
}

// ---------------------------------------------------------------------------
// Disruption impact.

export function descendants(tasks: SchedTask[], id: string): string[] {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const t of tasks) if (t.dependsOn.includes(cur) && !out.has(t.id)) { out.add(t.id); stack.push(t.id); }
  }
  return [...out].sort();
}

export interface DisruptionImpact {
  disruption: Disruption; before: ScheduleResult; after: ScheduleResult;
  moved: { taskId: string; finishShiftDays: number }[]; unchanged: string[];
  /** True iff every moved task is the disrupted task or one of its dependents. */
  dependentsOnly: boolean;
}

/** Apply a period shift and report which tasks moved. Independent tasks never move. */
export function applyDisruption(tasks: SchedTask[], opts: ScheduleOptions, disruption: Disruption): DisruptionImpact {
  const anchored: ScheduleOptions = { ...opts };
  const before = schedule(tasks, anchored);
  // Hold the anchor fixed so the shift is measured against the same plan start.
  const after = schedule(tasks, { ...anchored, anchor: before.anchor, disruptions: [...(opts.disruptions ?? []), disruption] });
  const b = new Map(before.tasks.map((t) => [t.id, Date.parse(t.earlyFinish)] as const));
  const moved: { taskId: string; finishShiftDays: number }[] = [];
  const unchanged: string[] = [];
  for (const t of after.tasks) {
    const shift = days(Date.parse(t.earlyFinish), b.get(t.id) as number);
    if (shift !== 0) moved.push({ taskId: t.id, finishShiftDays: shift });
    else unchanged.push(t.id);
  }
  const allowed = new Set([disruption.taskId, ...descendants(tasks, disruption.taskId)]);
  return { disruption, before, after, moved, unchanged, dependentsOnly: moved.every((m) => allowed.has(m.taskId)) };
}

/** Convenience: UTC date (YYYY-MM-DD) of an ISO time. */
export function isoDay(isoTime: string): string {
  return new Date(parseTime(isoTime)).toISOString().slice(0, 10);
}
