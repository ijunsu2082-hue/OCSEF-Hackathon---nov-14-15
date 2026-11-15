/**
 * Study-radius geometry for loaded assets.
 *
 * A provider's spatial query returns whole features, so a transmission line
 * whose endpoints both sit outside the circle can still cross it. Downstream
 * mileage must reflect the part inside the study radius, not the whole way.
 *
 * The work happens in a local tangent plane around the analysis point. That
 * keeps circle/segment intersection exact instead of iterative. The plane is
 * equirectangular about the analysis point, so its distortion grows with
 * distance and with tan(latitude): mapping the 100-mile local circle back to
 * WGS84 at Westminster (33.75 N) and sampling 3,600 bearings gives great-circle
 * distances of 99.67 to 100.32 miles (about +/-0.33%; extremes near bearings
 * 55 and 125 degrees). The same check gives about +/-0.49% at 45 N and +/-0.23%
 * at 25 N. Every reported mileage is therefore a derived quantity and never a
 * provider-published one.
 *
 * `studyRing` (the provider query polygon) is built on the great-circle circle
 * instead, so it encloses every point within the true radius. The two circles
 * therefore differ by that same +/-0.33% at Westminster: a line the ring fetches
 * can clip to zero miles, and at bearings where the local circle reaches past
 * the true radius (up to about 100.32 miles there) a line `clipLine` would
 * keep, but that lies wholly beyond the ring, is not fetched. Both effects sit
 * in that band just outside the true radius; `clipLine` is unchanged.
 */

export type Position = [number, number];

const EARTH_METERS = 6_371_008.8;
const METRES_PER_MILE = 1609.344;
const RADIANS = Math.PI / 180;

interface Local {
  x: number;
  y: number;
}

function projector(center: Position) {
  const lon0 = center[0] * RADIANS;
  const lat0 = center[1] * RADIANS;
  const cos = Math.cos(lat0);
  if (!Number.isFinite(cos) || Math.abs(cos) < 1e-9) throw new Error("Cannot project geometry at a pole");
  return {
    toLocal([lon, lat]: Position): Local {
      let delta = lon * RADIANS - lon0;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      return { x: delta * cos * EARTH_METERS, y: (lat * RADIANS - lat0) * EARTH_METERS };
    },
    toWorld({ x, y }: Local): Position {
      return [(lon0 + x / (cos * EARTH_METERS)) / RADIANS, (lat0 + y / EARTH_METERS) / RADIANS];
    },
  };
}

/** Great-circle distance in statute miles between two WGS84 positions. */
export function greatCircleMiles(from: Position, to: Position): number {
  const [lon1, lat1] = [from[0] * RADIANS, from[1] * RADIANS];
  const [lon2, lat2] = [to[0] * RADIANS, to[1] * RADIANS];
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * EARTH_METERS) / METRES_PER_MILE;
}

export function polylineMiles(coordinates: Position[]): number {
  let miles = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    miles += greatCircleMiles(coordinates[index - 1], coordinates[index]);
  }
  return miles;
}

function lerp(a: Local, b: Local, t: number): Local {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Portion of segment a→b inside a circle centred on the origin, as fractions of
 * the segment. Returns null when the segment never enters the circle.
 */
function clipSegment(a: Local, b: Local, radius: number): [number, number] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const quadA = dx * dx + dy * dy;
  const quadB = 2 * (a.x * dx + a.y * dy);
  const quadC = a.x * a.x + a.y * a.y - radius * radius;
  if (quadA === 0) return quadC <= 0 ? [0, 1] : null;
  if (quadC <= 0 && quadA + quadB + quadC <= 0) return [0, 1];
  const discriminant = quadB * quadB - 4 * quadA * quadC;
  if (discriminant <= 0) return quadC <= 0 ? [0, 1] : null;
  const root = Math.sqrt(discriminant);
  const start = Math.max(0, (-quadB - root) / (2 * quadA));
  const end = Math.min(1, (-quadB + root) / (2 * quadA));
  return end > start ? [start, end] : null;
}

/**
 * Default vertex count for `studyRing`. The polygon overshoots the circle by
 * about 0.13% of the radius at 100 miles, and the ring stays short enough
 * (about 1.3 kB of JSON) for a GET query string: ArcGIS Online's IIS front end
 * answered a 128-vertex, 6-decimal ring (about 4.3 kB URL) with an HTML 404.
 */
export const STUDY_RING_VERTICES = 64;

/** Spherical direct problem: the point `metres` from `center` along initial `bearing` (radians from north). */
function destination(center: Position, bearing: number, metres: number): Position {
  const lat1 = center[1] * RADIANS;
  const lon1 = center[0] * RADIANS;
  const angle = metres / EARTH_METERS;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angle) + Math.cos(lat1) * Math.sin(angle) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angle) * Math.cos(lat1),
    Math.cos(angle) - Math.sin(lat1) * Math.sin(lat2));
  return [lon2 / RADIANS, lat2 / RADIANS];
}

/**
 * Smallest great-circle distance, in metres, from `center` to the straight
 * lon/lat edge a→b (how a 4326 polygon edge is read): a coarse scan, then a
 * ternary search around its best sample.
 */
function edgeMinMetres(center: Position, a: Position, b: Position): number {
  const at = (t: number) =>
    greatCircleMiles(center, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]) * METRES_PER_MILE;
  const steps = 16;
  let best = 0;
  let min = Infinity;
  for (let step = 0; step <= steps; step += 1) {
    const value = at(step / steps);
    if (value < min) [min, best] = [value, step / steps];
  }
  let low = Math.max(0, best - 1 / steps);
  let high = Math.min(1, best + 1 / steps);
  for (let round = 0; round < 80; round += 1) {
    const left = low + (high - low) / 3;
    const right = high - (high - low) / 3;
    if (at(left) < at(right)) high = right;
    else low = left;
  }
  return Math.min(min, at((low + high) / 2));
}

/**
 * Closed WGS84 ring ([lon, lat], rounded to 4 decimals) that encloses the
 * great-circle study circle: every point within `radiusMiles` (as
 * `greatCircleMiles` measures it) is inside, and every edge stays at or beyond
 * the radius.
 *
 * It exists for providers whose server-side `distance` buffer cannot be
 * trusted (HIFLD Transmission_Lines, stored in a US-feet state plane, inflates
 * a statute-mile or metre distance about 3.28 times). An intersects query with
 * this polygon involves no linear unit and so never misses a record within the
 * radius. Vertices are placed with the spherical direct formula at a common
 * distance, starting from radius * sec(pi / vertices) and widened until the
 * nearest point of every straight lon/lat edge (after rounding) is at least
 * 1 m beyond the radius. The excess is about 0.13% of the radius at 100 miles
 * (at most about 0.16% plus 15 m across the latitudes and radii tested). See
 * the module note for how this differs from `clipLine`'s local-plane circle.
 * Vertices run clockwise, as Esri JSON requires for an outer ring.
 */
export function studyRing(center: Position, radiusMiles: number, vertices = STUDY_RING_VERTICES): Position[] {
  if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) throw new Error("Study radius must be positive");
  if (!Number.isSafeInteger(vertices) || vertices < 8) throw new Error("Study ring needs at least 8 vertices");
  projector(center); // Same pole guard as the clip plane.
  const target = radiusMiles * METRES_PER_MILE + 1;
  const round = (value: number) => Math.round(value * 1e4) / 1e4;
  let distance = target / Math.cos(Math.PI / vertices);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const ring: Position[] = [];
    for (let index = 0; index < vertices; index += 1) {
      const [lon, lat] = destination(center, (2 * Math.PI * index) / vertices, distance);
      ring.push([round(lon), round(lat)]);
    }
    ring.push([...ring[0]] as Position);
    let nearest = Infinity;
    for (let index = 1; index < ring.length; index += 1) {
      nearest = Math.min(nearest, edgeMinMetres(center, ring[index - 1], ring[index]));
    }
    if (nearest >= target) return ring;
    // Widen in proportion to the shortfall, plus half a metre so rounding cannot stall it.
    distance *= (target + 0.5) / nearest;
  }
  throw new Error("Study ring did not converge");
}

export interface ClippedLine {
  coordinates: Position[];
  miles: number;
}

/** Clip one path against the study circle. Returns inside pieces in order. */
export function clipLine(center: Position, radiusMiles: number, coordinates: Position[]): ClippedLine[] {
  if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) throw new Error("Clip radius must be positive");
  if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
  for (const point of coordinates) {
    if (!Array.isArray(point) || point.length < 2 ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
        Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
      throw new Error("Invalid line position");
    }
  }
  const project = projector(center);
  const radius = radiusMiles * METRES_PER_MILE;
  const pieces: Local[][] = [];
  let current: Local[] = [];
  for (let index = 1; index < coordinates.length; index += 1) {
    const a = project.toLocal(coordinates[index - 1]);
    const b = project.toLocal(coordinates[index]);
    const inside = clipSegment(a, b, radius);
    if (!inside) {
      if (current.length) {
        pieces.push(current);
        current = [];
      }
      continue;
    }
    const [start, end] = inside;
    if (start <= 1e-12) {
      if (!current.length) current.push(a);
      current.push(end >= 1 - 1e-12 ? b : lerp(a, b, end));
    } else {
      if (current.length) {
        pieces.push(current);
        current = [];
      }
      pieces.push([lerp(a, b, start), lerp(a, b, end)]);
    }
  }
  if (current.length) pieces.push(current);
  return pieces
    .map((piece) => piece.map(project.toWorld))
    .map((line) => ({ coordinates: line, miles: polylineMiles(line) }))
    .filter((piece) => piece.miles > 0);
}

const VOLTAGE_BANDS: [number, number, string][] = [
  [0, 69, "below-69"],
  [69, 115, "69-115"],
  [115, 230, "115-230"],
  [230, 345, "230-345"],
  [345, 500, "345-500"],
  [500, 765, "500-765"],
  [765, Number.POSITIVE_INFINITY, "765-plus"],
];

/**
 * Published voltage to a reporting band. Unknown stays unknown. A line the
 * caller identifies as direct current is banded "dc" whatever its voltage, so
 * an HVDC pole voltage (or HIFLD's 1000 for a ±500 kV bipole) never lands in
 * an AC band.
 */
export function voltageBand(voltageKv: number | null, options: { dc?: boolean } = {}): string {
  if (options.dc) return "dc";
  if (voltageKv === null || !Number.isFinite(voltageKv)) return "unknown";
  for (const [low, high, label] of VOLTAGE_BANDS) if (voltageKv >= low && voltageKv < high) return label;
  return "unknown";
}

export interface ClippedFeatureGeometry {
  miles: number;
  segments: number;
}

/** Clip a GeoJSON LineString or MultiLineString; null for other geometry types. */
export function clipFeature(
  center: Position,
  radiusMiles: number,
  geometry: unknown,
): ClippedFeatureGeometry | null {
  const shape = geometry as { type?: unknown; coordinates?: unknown } | null;
  if (!shape || typeof shape !== "object") return null;
  const lines = shape.type === "LineString"
    ? [shape.coordinates]
    : shape.type === "MultiLineString"
      ? shape.coordinates
      : null;
  if (!Array.isArray(lines)) return null;
  let miles = 0;
  let segments = 0;
  for (const line of lines) {
    if (!Array.isArray(line)) continue;
    for (const piece of clipLine(center, radiusMiles, line as Position[])) {
      miles += piece.miles;
      segments += 1;
    }
  }
  return { miles: Math.round(miles * 100) / 100, segments };
}
