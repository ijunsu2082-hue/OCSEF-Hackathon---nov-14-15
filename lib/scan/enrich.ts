import type { Line, Plant, Substation } from "./types";

/*
 * Fill gaps in the OpenStreetMap layers from real connected data, once per load:
 *  (a) a line with no voltage takes the voltage of a tagged line whose endpoint
 *      touches its endpoint (within ~40 m), repeated until nothing changes (max 6 passes);
 *  (b) a substation with no voltage takes the highest voltage of tagged lines
 *      with an endpoint within ~300 m;
 *  (c) a line still without voltage takes the voltage of a substation (tagged or
 *      filled) within ~300 m of an endpoint;
 *  (d) unnamed substations and lines get `near` = nearest plant city within 15 mi.
 * Anything filled is marked kv_inferred. Values we cannot fill stay null.
 * Uses lat/lon grid buckets so this stays well under 150 ms for the full layers.
 */

const M_PER_DEG_LAT = 111_320;
const TOUCH_M = 40;
const NEAR_SUB_M = 300;
const NEAR_CITY_MI = 15;

/** Squared distance in meters (equirectangular; fine at these short ranges). */
function d2m(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  const dx = (bLon - aLon) * M_PER_DEG_LAT * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  return dx * dx + dy * dy;
}

/** Point bucket grid. Cell must be >= the search radius in both axes (3x3 search). */
class Grid<T> {
  private cells = new Map<number, { lat: number; lon: number; item: T }[]>();
  constructor(private cellDeg: number) {}
  private key(ix: number, iy: number) { return ix * 1_048_576 + iy; } // |iy| < 2^19 for any lon at cell >= 0.001 deg
  add(lat: number, lon: number, item: T) {
    const k = this.key(Math.floor(lat / this.cellDeg), Math.floor(lon / this.cellDeg));
    const arr = this.cells.get(k);
    if (arr) arr.push({ lat, lon, item }); else this.cells.set(k, [{ lat, lon, item }]);
  }
  *near(lat: number, lon: number): Generator<{ lat: number; lon: number; item: T }> {
    const ix = Math.floor(lat / this.cellDeg), iy = Math.floor(lon / this.cellDeg);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const arr = this.cells.get(this.key(ix + a, iy + b));
      if (arr) yield* arr;
    }
  }
}

const hasKv = (kv: number | null) => kv != null && Number.isFinite(kv);
const ends = (l: Line): [number, number][] => [l.coords[0], l.coords[l.coords.length - 1]];

export function enrichGrid(d: { plants: Plant[]; lines: Line[]; substations: Substation[] }): void {
  const { plants, lines, substations } = d;

  // (a) line-to-line through touching endpoints, a few passes so voltage can chain along a run.
  const touch2 = TOUCH_M * TOUCH_M;
  const endGrid = new Grid<Line>(0.001); // ~111 m lat / ~92 m lon, > 40 m
  for (const l of lines) for (const [la, lo] of ends(l)) endGrid.add(la, lo, l);
  for (let pass = 0; pass < 6; pass++) {
    const updates: [Line, number][] = [];
    for (const l of lines) {
      if (hasKv(l.voltage_kv) || l.coords.length < 2) continue;
      let best: number | null = null;
      for (const [la, lo] of ends(l)) {
        for (const p of endGrid.near(la, lo)) {
          const o = p.item;
          if (o === l || !hasKv(o.voltage_kv)) continue;
          if (d2m(la, lo, p.lat, p.lon) <= touch2 && (best === null || o.voltage_kv! > best)) best = o.voltage_kv;
        }
      }
      if (best !== null) updates.push([l, best]);
    }
    if (updates.length === 0) break;
    for (const [l, kv] of updates) { l.voltage_kv = kv; l.kv_inferred = true; }
  }

  // (b) substation from tagged lines that END within ~300 m (lines merely passing by don't count).
  const sub2 = NEAR_SUB_M * NEAR_SUB_M;
  const vtxGrid = new Grid<number>(0.004); // ~445 m lat / ~370 m lon, > 300 m
  for (const l of lines) {
    if (!hasKv(l.voltage_kv) || l.kv_inferred) continue;
    for (const [la, lo] of ends(l)) vtxGrid.add(la, lo, l.voltage_kv!);
  }
  for (const s of substations) {
    if (hasKv(s.voltage_kv)) continue;
    let best: number | null = null;
    for (const p of vtxGrid.near(s.lat, s.lon)) {
      if (d2m(s.lat, s.lon, p.lat, p.lon) <= sub2 && (best === null || p.item > best)) best = p.item;
    }
    if (best !== null) { s.voltage_kv = best; s.kv_inferred = true; }
  }

  // (c) remaining untagged lines from a substation near an endpoint.
  const subGrid = new Grid<Substation>(0.004);
  for (const s of substations) if (hasKv(s.voltage_kv)) subGrid.add(s.lat, s.lon, s);
  for (const l of lines) {
    if (hasKv(l.voltage_kv) || l.coords.length < 2) continue;
    let best: number | null = null;
    for (const [la, lo] of ends(l)) {
      for (const p of subGrid.near(la, lo)) {
        if (d2m(la, lo, p.lat, p.lon) <= sub2 && (best === null || p.item.voltage_kv! > best)) best = p.item.voltage_kv;
      }
    }
    if (best !== null) { l.voltage_kv = best; l.kv_inferred = true; }
  }

  // (d) nearest plant city for unnamed assets.
  const cityGrid = new Grid<string>(0.4); // ~44 km lat / ~37 km lon, > 15 mi (24 km)
  for (const p of plants) if (p.city.trim()) cityGrid.add(p.lat, p.lon, p.city.trim());
  const maxD2 = (NEAR_CITY_MI * 1609.344) ** 2;
  const nearestCity = (lat: number, lon: number): string | null => {
    let best: string | null = null, bestD = maxD2;
    for (const p of cityGrid.near(lat, lon)) {
      const dd = d2m(lat, lon, p.lat, p.lon);
      if (dd <= bestD) { bestD = dd; best = p.item; }
    }
    return best;
  };
  for (const s of substations) if (!s.name) s.near = nearestCity(s.lat, s.lon);
  for (const l of lines) {
    if (l.name || l.coords.length === 0) continue;
    const [la, lo] = l.coords[Math.floor(l.coords.length / 2)];
    l.near = nearestCity(la, lo);
  }
}
