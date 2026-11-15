/**
 * Basemaps for the layers picker — adapted from PR #2's basemaps.ts.
 *
 * The shell's default is the dark canvas the rest of the UI is built around;
 * the other three are keyless Esri services. The choice is remembered per
 * browser so a reload keeps the map a user left.
 */

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const tile = (service: string) => `${ESRI}/${service}/MapServer/tile/{z}/{y}/{x}`;
/** One z=9 tile over Westminster, CA — the picker thumbnail. */
const thumb = (service: string) => `${ESRI}/${service}/MapServer/tile/9/204/88`;

export type BasemapId = "dark" | "satellite" | "streets" | "terrain";
export type SurfaceMode = "flat" | "elevation";

export interface Basemap {
  id: BasemapId;
  label: string;
  url: string;
  maxNativeZoom: number;
  thumb: string;
}

export const BASEMAPS: Basemap[] = [
  {
    id: "dark",
    label: "Dark",
    url: tile("Canvas/World_Dark_Gray_Base"),
    maxNativeZoom: 16,
    thumb: thumb("Canvas/World_Dark_Gray_Base"),
  },
  {
    id: "satellite",
    label: "Satellite",
    url: tile("World_Imagery"),
    maxNativeZoom: 19,
    thumb: thumb("World_Imagery"),
  },
  {
    id: "streets",
    label: "Streets",
    url: tile("World_Street_Map"),
    maxNativeZoom: 19,
    thumb: thumb("World_Street_Map"),
  },
  {
    id: "terrain",
    label: "Topographic",
    url: tile("World_Topo_Map"),
    maxNativeZoom: 19,
    thumb: thumb("World_Topo_Map"),
  },
];

export const DEFAULT_BASEMAP: BasemapId = "dark";
const STORAGE_KEY = "gs-basemap";
const SURFACE_STORAGE_KEY = "gs-surface";

export function loadSurfaceMode(): SurfaceMode {
  try {
    return window.localStorage.getItem(SURFACE_STORAGE_KEY) === "elevation" ? "elevation" : "flat";
  } catch {
    return "flat";
  }
}

export function saveSurfaceMode(mode: SurfaceMode) {
  try { window.localStorage.setItem(SURFACE_STORAGE_KEY, mode); } catch { /* Storage is optional. */ }
}

export function basemapById(id: BasemapId): Basemap {
  return BASEMAPS.find((basemap) => basemap.id === id) ?? BASEMAPS[0];
}

export function loadBasemap(): BasemapId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && BASEMAPS.some((basemap) => basemap.id === stored)) {
      return stored as BasemapId;
    }
  } catch {
    // Storage blocked: the default is fine.
  }
  return DEFAULT_BASEMAP;
}

export function saveBasemap(id: BasemapId) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Ignore: persistence is a nicety, not a requirement.
  }
}
