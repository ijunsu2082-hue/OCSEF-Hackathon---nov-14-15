import type { GridData, Line } from "./types";
import { haversineMi } from "./geo";

// ---------- precomputed line index (built once per GridData object) ----------

export interface LineIdx {
  line: Line;
  minLat: number; maxLat: number; minLon: number; maxLon: number;
  seg: Float64Array; // [aLat, aLon, bLat, bLon, lenMi] per segment
}

const indexCache = new WeakMap<GridData, LineIdx[]>();

export function lineIndex(data: GridData): LineIdx[] {
  let idx = indexCache.get(data);
  if (idx) return idx;
  idx = data.lines.map((line) => {
    const c = line.coords;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [la, lo] of c) {
      if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
    }
    const n = Math.max(0, c.length - 1);
    const seg = new Float64Array(n * 5);
    for (let i = 0; i < n; i++) {
      const [aLat, aLon] = c[i], [bLat, bLon] = c[i + 1];
      seg.set([aLat, aLon, bLat, bLon, haversineMi(aLat, aLon, bLat, bLon)], i * 5);
    }
    return { line, minLat, maxLat, minLon, maxLon, seg };
  });
  indexCache.set(data, idx);
  return idx;
}
