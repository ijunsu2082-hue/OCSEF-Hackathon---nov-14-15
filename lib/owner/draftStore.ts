// Local owner-plan drafts keyed by location, radius, and sector.
//
// Edits are user-owned and survive regeneration: when evidence or generated
// tasks change, user edits are re-applied, edits whose generated task changed
// underneath are flagged, and edits whose task disappeared are surfaced as
// orphans (never silently dropped). Pure apart from the storage adapter; all
// times are passed in.

import type { OwnerTask, Sector, TaskStatus } from "./planTypes";
import { stableHash } from "./lifecycle";

export const DRAFT_SCHEMA = "gridsentinel.owner-draft/1" as const;
export const DRAFT_NAMESPACE = "gridsentinel.owner-draft";

export interface DraftLocation { lat: number; lon: number; radius: number; sector?: Sector | null }

/** `${lat.toFixed(5)}:${lon.toFixed(5)}:${radius}` plus `:${sector}` when a sector is given. */
export function draftKey(loc: DraftLocation): string {
  const base = `${loc.lat.toFixed(5)}:${loc.lon.toFixed(5)}:${loc.radius}`;
  return loc.sector ? `${base}:${loc.sector}` : base;
}

export interface TaskEdit {
  owner?: string;
  due?: string;
  status?: TaskStatus;
  notes?: string;
  editedAt: string;
  /** Hash of the generated task's planner-owned fields when the edit was made. */
  baseTaskHash: string;
}

export interface Draft {
  schema: typeof DRAFT_SCHEMA;
  key: string;
  selectedOption: string | null;
  edits: Record<string, TaskEdit>;
  updatedAt: string | null;
}

export function emptyDraft(key: string): Draft {
  return { schema: DRAFT_SCHEMA, key, selectedOption: null, edits: {}, updatedAt: null };
}

/** Hash of the planner-generated fields only (user-editable fields excluded). */
export function generatedTaskHash(t: OwnerTask): string {
  const { owner: _o, due: _d, status: _s, ...generated } = t;
  return stableHash(generated);
}

/** Return a new draft with a task edit applied (input draft is not mutated). */
export function setTaskEdit(draft: Draft, task: OwnerTask, patch: Partial<Pick<TaskEdit, "owner" | "due" | "status" | "notes">>, at: string): Draft {
  const prior = draft.edits[task.id];
  const edit: TaskEdit = { ...(prior ?? {}), ...patch, editedAt: at, baseTaskHash: generatedTaskHash(task) };
  return { ...draft, edits: { ...draft.edits, [task.id]: edit }, updatedAt: at };
}

export function removeTaskEdit(draft: Draft, taskId: string, at: string): Draft {
  if (!draft.edits[taskId]) return draft;
  const { [taskId]: _gone, ...rest } = draft.edits;
  return { ...draft, edits: rest, updatedAt: at };
}

export function setSelectedOption(draft: Draft, optionId: string | null, at: string): Draft {
  return { ...draft, selectedOption: optionId, updatedAt: at };
}

export interface MergeResult {
  tasks: OwnerTask[];
  /** Edits whose task id is no longer generated. Kept in the draft until the user resolves them. */
  orphaned: { taskId: string; edit: TaskEdit }[];
  /** Edits re-applied to a task whose generated content changed since the edit. */
  changedUnderEdit: string[];
  /** Selected option no longer offered by the planner. */
  orphanedOption: string | null;
}

/**
 * Overlay user edits onto freshly generated tasks. Generated fields come from the
 * planner; user-editable fields (owner, due, status) come from the draft.
 */
export function mergeDraft(generated: OwnerTask[], draft: Draft, optionIds: string[] = []): MergeResult {
  const ids = new Set(generated.map((t) => t.id));
  const changedUnderEdit: string[] = [];
  const tasks = generated.map((t) => {
    const e = draft.edits[t.id];
    if (!e) return t;
    if (e.baseTaskHash !== generatedTaskHash(t)) changedUnderEdit.push(t.id);
    return {
      ...t,
      ...(e.owner !== undefined ? { owner: e.owner } : {}),
      ...(e.due !== undefined ? { due: e.due } : {}),
      ...(e.status !== undefined ? { status: e.status } : {}),
    };
  });
  const orphaned = Object.keys(draft.edits).sort().filter((id) => !ids.has(id)).map((taskId) => ({ taskId, edit: draft.edits[taskId] }));
  const orphanedOption = draft.selectedOption && optionIds.length && !optionIds.includes(draft.selectedOption) ? draft.selectedOption : null;
  return { tasks, orphaned, changedUnderEdit: changedUnderEdit.sort(), orphanedOption };
}

// ---------------------------------------------------------------------------
// Storage.

export interface StorageAdapter {
  getItem(key: string): string | null;
  /** Returns false when the write failed (quota, privacy mode, unavailable). */
  setItem(key: string, value: string): boolean;
  removeItem(key: string): boolean;
}

export function memoryStorage(seed: Record<string, string> = {}): StorageAdapter & { dump(): Record<string, string> } {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => { m.set(k, v); return true; },
    removeItem: (k) => { m.delete(k); return true; },
    dump: () => Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

interface WebStorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** Wrap window.localStorage (or any Storage-like object). Every access is try/catch guarded. */
export function localStorageAdapter(storage?: WebStorageLike | null): StorageAdapter {
  const resolve = (): WebStorageLike | null => {
    if (storage !== undefined) return storage;
    try {
      const g = globalThis as { localStorage?: WebStorageLike };
      return g.localStorage ?? null;
    } catch {
      return null;
    }
  };
  return {
    getItem(k) {
      try { return resolve()?.getItem(k) ?? null; } catch { return null; }
    },
    setItem(k, v) {
      try { const s = resolve(); if (!s) return false; s.setItem(k, v); return true; } catch { return false; }
    },
    removeItem(k) {
      try { const s = resolve(); if (!s) return false; s.removeItem(k); return true; } catch { return false; }
    },
  };
}

export interface LoadResult { draft: Draft; status: "loaded" | "empty" | "corrupt" | "key_mismatch" }

function isDraft(v: unknown): v is Draft {
  if (!v || typeof v !== "object") return false;
  const d = v as Partial<Draft>;
  return d.schema === DRAFT_SCHEMA && typeof d.key === "string" && !!d.edits && typeof d.edits === "object";
}

export interface DraftStore {
  load(loc: DraftLocation): LoadResult;
  save(loc: DraftLocation, draft: Draft): boolean;
  clear(loc: DraftLocation): boolean;
  storageKey(loc: DraftLocation): string;
}

export function createDraftStore(adapter: StorageAdapter, namespace = DRAFT_NAMESPACE): DraftStore {
  const storageKey = (loc: DraftLocation) => `${namespace}:${draftKey(loc)}`;
  return {
    storageKey,
    load(loc) {
      const key = draftKey(loc);
      const raw = adapter.getItem(storageKey(loc));
      if (raw === null) return { draft: emptyDraft(key), status: "empty" };
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return { draft: emptyDraft(key), status: "corrupt" }; }
      if (!isDraft(parsed)) return { draft: emptyDraft(key), status: "corrupt" };
      // A draft stored under one key is never served for another location.
      if (parsed.key !== key) return { draft: emptyDraft(key), status: "key_mismatch" };
      return { draft: parsed, status: "loaded" };
    },
    save(loc, draft) {
      const key = draftKey(loc);
      if (draft.key !== key) return false;
      return adapter.setItem(storageKey(loc), JSON.stringify(draft));
    },
    clear(loc) {
      return adapter.removeItem(storageKey(loc));
    },
  };
}
