/**
 * The broadcast topic for one weather cell.
 *
 * Server and browser must derive the same name, so both round to three
 * decimals exactly the way `weatherLocation()` keys the database row.
 */
export function weatherCell(lat: number, lon: number): string {
  return `${Number(lat.toFixed(3))},${Number(lon.toFixed(3))}`;
}

export function weatherTopic(lat: number, lon: number): string {
  return `weather:${weatherCell(lat, lon)}`;
}

/** Broadcast event name; the payload carries only the cell and sample time. */
export const WEATHER_SAMPLE_EVENT = "sample";
