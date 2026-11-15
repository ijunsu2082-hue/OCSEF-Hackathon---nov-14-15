/**
 * Study-radius geometry for loaded assets.
 *
 * A provider's spatial query returns whole features, so a transmission line
 * whose endpoints both sit outside the circle can still cross it. Downstream
 * mileage must reflect the part inside the study radius, not the whole way.
 *
 * The work happens in a local tangent plane around the analysis point. That
 * keeps circle/segment intersection exact instead of iterative, and the
 * projection error is second order in (distance / Earth radius): about 0.03%
 * at 100 miles, well below the precision of a source geometry. Every reported
 * mileage is therefore a derived quantity and never a provider-published one.
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

/** Published voltage to a reporting band. Unknown stays unknown. */
export function voltageBand(voltageKv: number | null): string {
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
