import type { GridData } from "@/lib/scan";
import { lineName, substationName } from "@/lib/scan/labels";
import type { ReportTarget } from "@/lib/scan/target";
import type { AssetKind, AssetRef, OwnedAsset } from "@/lib/owner/types";

/*
 * Asset helpers shared by the owner screens and the public "For owners" tab.
 * Ids follow lib/owner/types.ts: plant -> String(plant_code), substation -> osm_id, line -> String(osm_id).
 */

export const KIND_WORD: Record<AssetKind, string> = {
  plant: "Power plant",
  substation: "Substation",
  line: "Power line",
};

export function isAssetKind(k: string | null | undefined): k is AssetKind {
  return k === "plant" || k === "substation" || k === "line";
}

export function assetRef(a: OwnedAsset): AssetRef {
  if (a.kind === "plant") return { kind: "plant", id: String(a.plant.plant_code) };
  if (a.kind === "substation") return { kind: "substation", id: a.substation.osm_id };
  return { kind: "line", id: String(a.line.osm_id) };
}

export function assetName(a: OwnedAsset): string {
  if (a.kind === "plant") return a.plant.plant_name;
  if (a.kind === "substation") return substationName(a.substation);
  return lineName(a.line);
}

/** Owner organization from public data, or "" when the data has none. */
export function ownerFromData(a: OwnedAsset): string {
  if (a.kind === "plant") return a.plant.utility_name || "";
  if (a.kind === "substation") return a.substation.operator || "";
  return a.line.operator || "";
}

/** Where the owner name came from, for a caption. */
export function ownerSource(a: OwnedAsset): string {
  return a.kind === "plant" ? "EIA-860 2025 (utility name)" : "OpenStreetMap (operator tag)";
}

export function claimHref(a: OwnedAsset): string {
  const r = assetRef(a);
  return `/owner/claim?kind=${encodeURIComponent(r.kind)}&id=${encodeURIComponent(r.id)}`;
}

export function fromTarget(t: ReportTarget | null | undefined): OwnedAsset | null {
  if (!t || t.kind === "area") return null;
  return t;
}

export function findAsset(data: GridData, ref: AssetRef): OwnedAsset | null {
  if (ref.kind === "plant") {
    const plant = data.plants.find((p) => String(p.plant_code) === ref.id);
    return plant ? { kind: "plant", plant } : null;
  }
  if (ref.kind === "substation") {
    const substation = data.substations.find((s) => s.osm_id === ref.id);
    return substation ? { kind: "substation", substation } : null;
  }
  const line = data.lines.find((l) => String(l.osm_id) === ref.id);
  return line ? { kind: "line", line } : null;
}

/** Name / plant code search across plants, named substations and named lines. */
export function searchAssets(data: GridData, query: string, limit = 20): OwnedAsset[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: OwnedAsset[] = [];
  for (const plant of data.plants) {
    if (String(plant.plant_code) === q || plant.plant_name.toLowerCase().includes(q)) out.push({ kind: "plant", plant });
    if (out.length >= limit) return out;
  }
  for (const substation of data.substations) {
    if (substation.name && substation.name.toLowerCase().includes(q)) out.push({ kind: "substation", substation });
    if (out.length >= limit) return out;
  }
  for (const line of data.lines) {
    if (line.name && line.name.toLowerCase().includes(q)) out.push({ kind: "line", line });
    if (out.length >= limit) return out;
  }
  return out;
}
