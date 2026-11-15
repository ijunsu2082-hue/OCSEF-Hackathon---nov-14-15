/** Keyless Esri basemaps. Labels for Satellite and Simple come from a separate overlay. */
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const tile = (service: string) => `${ESRI}/${service}/MapServer/tile/{z}/{y}/{x}`;
/** One z=9 tile over Westminster, CA, used as the picker thumbnail. */
const thumb = (service: string) => `${ESRI}/${service}/MapServer/tile/9/204/88`;

export type BasemapId = "map" | "satellite" | "terrain" | "simple";

export interface Basemap {
  id: BasemapId;
  label: string;
  url: string;
  labelsUrl?: string;
  maxNativeZoom: number;
  attribution: string;
  thumb: string;
}

export const BASEMAPS: Basemap[] = [
  {
    id: "map",
    label: "Map",
    url: tile("World_Street_Map"),
    maxNativeZoom: 19,
    attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors",
    thumb: thumb("World_Street_Map"),
  },
  {
    id: "satellite",
    label: "Satellite",
    url: tile("World_Imagery"),
    labelsUrl: tile("Reference/World_Boundaries_and_Places"),
    maxNativeZoom: 19,
    attribution: "Tiles &copy; Esri &mdash; Maxar, Earthstar Geographics",
    thumb: thumb("World_Imagery"),
  },
  {
    id: "terrain",
    label: "Terrain",
    url: tile("World_Topo_Map"),
    maxNativeZoom: 19,
    attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors",
    thumb: thumb("World_Topo_Map"),
  },
  {
    id: "simple",
    label: "Simple",
    url: tile("Canvas/World_Light_Gray_Base"),
    labelsUrl: tile("Canvas/World_Light_Gray_Reference"),
    maxNativeZoom: 16,
    attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
    thumb: thumb("Canvas/World_Light_Gray_Base"),
  },
];

export const DEFAULT_BASEMAP: BasemapId = "simple";
const STORAGE_KEY = "gs-basemap-v2";

export function basemapById(id: BasemapId): Basemap {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
}

export function loadBasemap(): BasemapId {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v && BASEMAPS.some((b) => b.id === v)) return v as BasemapId;
  } catch {
    // storage unavailable (private mode, blocked): fall back to the default
  }
  return DEFAULT_BASEMAP;
}

export function saveBasemap(id: BasemapId) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore
  }
}
