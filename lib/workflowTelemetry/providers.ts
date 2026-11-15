import { createHash } from "node:crypto";
import type { ProviderObservation } from "./types";

const NWS = "https://api.weather.gov";
const OASIS = "https://oasis.caiso.com/oasisapi/SingleZip";
const USER_AGENT = process.env.NWS_USER_AGENT || "GridSentinel workflow telemetry (contact: operator@example.com)";

async function json(url: string, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json, application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  return response.json();
}

function quantity(feature: any, key: string): { value: number; unit: string } | null {
  const q = feature?.properties?.[key];
  if (typeof q?.value !== "number" || !Number.isFinite(q.value) || typeof q?.unitCode !== "string") return null;
  return { value: q.value, unit: q.unitCode };
}

function toCelsius(q: { value: number; unit: string }): number | null {
  if (q.unit.endsWith("degC")) return q.value;
  if (q.unit.endsWith("degF")) return (q.value - 32) * 5 / 9;
  return null;
}

function toMetersPerSecond(q: { value: number; unit: string }): number | null {
  const u = q.unit;
  if (u.endsWith("m_s-1")) return q.value;
  if (u.endsWith("km_h-1")) return q.value / 3.6;
  if (u.endsWith("mi_h-1")) return q.value * 0.44704;
  if (u.endsWith("kt")) return q.value * 0.514444;
  return null;
}

export async function collectNoaa(lat: number, lon: number, fetchedAt = new Date()): Promise<ProviderObservation[]> {
  const point = await json(`${NWS}/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const stationsUrl = point?.properties?.observationStations;
  if (typeof stationsUrl !== "string") throw new Error("NWS point response has no observationStations link");
  const stations = await json(stationsUrl);
  const station = stations?.features?.[0];
  const stationUrl = station?.id;
  if (typeof stationUrl !== "string") throw new Error("NWS returned no nearby observation station");
  const observation = await json(`${stationUrl}/observations/latest`);
  const observedAt = observation?.properties?.timestamp;
  if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) throw new Error("NWS observation has no valid timestamp");
  const result: ProviderObservation[] = [];
  const add = (field: string, unit: "degC" | "m/s", convert: (q: {value:number;unit:string}) => number | null) => {
    const raw = quantity(observation, field);
    const value = raw && convert(raw);
    if (value == null || !Number.isFinite(value)) return;
    result.push({ provider: "noaa-nws", series: field, target: station.properties?.stationIdentifier ?? stationUrl, observedAt, fetchedAt: fetchedAt.toISOString(), value, unit, sourceRevision: observation.properties?.id ?? observedAt, sourceUrl: observation.id ?? `${stationUrl}/observations/latest`, qualifiers: { stationName: station.properties?.name ?? "", rawUnit: raw!.unit } });
  };
  add("temperature", "degC", toCelsius);
  add("windSpeed", "m/s", toMetersPerSecond);
  add("windGust", "m/s", toMetersPerSecond);
  return result;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"' && quoted) { current += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { result.push(current); current = ""; }
    else current += ch;
  }
  result.push(current);
  return result;
}

/** Parse OASIS CSV rows without losing interval, market, node, or revision metadata. */
export function parseCaisoLmpCsv(csv: string, node: string, fetchedAt = new Date(), sourceUrl = OASIS): ProviderObservation[] {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headerIndex = lines.findIndex((line) => /\bINTERVALSTARTTIME_GMT\b/i.test(line) && /\bXML_DATA_ITEM\b/i.test(line));
  if (headerIndex < 0) throw new Error("CAISO OASIS response did not contain an LMP CSV header");
  const headers = parseCsvLine(lines[headerIndex]).map((h) => h.trim().toUpperCase());
  const col = (...names: string[]) => headers.findIndex((h) => names.includes(h));
  const idx = { nodeId: col("NODE_ID"), node: col("NODE"), time: col("INTERVALSTARTTIME_GMT", "INTERVAL_START_GMT"), price: col("VALUE"), item: col("XML_DATA_ITEM"), market: col("MARKET_RUN_ID"), group: col("GROUP"), revision: col("VERSION", "REVISION") };
  if ((idx.nodeId < 0 && idx.node < 0) || idx.time < 0 || idx.price < 0 || idx.item < 0) throw new Error("CAISO OASIS LMP CSV is missing node, interval, or price columns");
  const observations: ProviderObservation[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = parseCsvLine(line);
    if ((idx.node >= 0 ? cells[idx.node] : "") !== node && (idx.nodeId >= 0 ? cells[idx.nodeId] : "") !== node) continue;
    if (cells[idx.item] !== "LMP_PRC") continue; // Component rows (congestion/loss/energy) are not the total LMP.
    const price = Number(cells[idx.price]);
    const time = Date.parse(cells[idx.time]);
    if (!Number.isFinite(price) || !Number.isFinite(time)) continue;
    const market = idx.market >= 0 ? cells[idx.market] : "RTM";
    const providerRevision = idx.revision >= 0 ? cells[idx.revision] : "";
    const sourceGroup = idx.group >= 0 ? cells[idx.group] : "";
    const rowHash = createHash("sha256").update(cells.join("\u001f")).digest("hex").slice(0, 24);
    const revision = providerRevision || `row-${rowHash}`;
    observations.push({ provider: "caiso-oasis", series: "LMP", target: node, observedAt: new Date(time).toISOString(), fetchedAt: fetchedAt.toISOString(), value: price, unit: "USD/MWh", sourceRevision: revision, sourceUrl, qualifiers: { marketRunId: market, sourceInterval: cells[idx.time], sourceGroup, revisionKind: providerRevision ? "provider" : "content-hash" } });
  }
  return observations;
}

/** Fetch one RTM interval for an explicitly named CAISO node. OASIS times are requested in UTC. */
export async function collectCaisoNodeLmp(node: string, fetchedAt = new Date()): Promise<ProviderObservation[]> {
  if (!node.trim()) throw new Error("CAISO node must be a configured OASIS NODE name");
  const end = new Date(Math.floor(fetchedAt.getTime() / (5 * 60_000)) * 5 * 60_000 - 5 * 60_000);
  const start = new Date(end.getTime() - 60 * 60_000);
  const stamp = (date: Date) => `${date.toISOString().slice(0, 10).replaceAll("-", "")}T${date.toISOString().slice(11, 16)}-0000`;
  const url = new URL(OASIS);
  url.search = new URLSearchParams({ resultformat: "6", queryname: "PRC_INTVL_LMP", version: "3", market_run_id: "RTM", node, startdatetime: stamp(start), enddatetime: stamp(end) }).toString();
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`CAISO OASIS returned HTTP ${response.status}`);
  // The provider delivers SingleZip. ZIP extraction is performed by the worker's zip reader.
  const bytes = new Uint8Array(await response.arrayBuffer());
  return parseCaisoLmpCsv(await unzipFirstCsv(bytes), node, fetchedAt, url.toString());
}

async function unzipFirstCsv(bytes: Uint8Array): Promise<string> {
  // Read the central directory: local ZIP headers may omit sizes when a data descriptor is used.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("CAISO OASIS response is not a valid ZIP archive");
  const entries = view.getUint16(eocd + 10, true), directoryOffset = view.getUint32(eocd + 16, true);
  let offset = directoryOffset;
  for (let n = 0; n < entries; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true), compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true), extraLen = view.getUint16(offset + 30, true), commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    if (name.toLowerCase().endsWith(".csv")) {
      const localNameLen = view.getUint16(localOffset + 26, true), localExtraLen = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const compressed = bytes.subarray(start, start + compressedSize);
      const raw = method === 0 ? compressed : method === 8 ? (await import("node:zlib")).inflateRawSync(compressed) : null;
      if (!raw) throw new Error(`Unsupported OASIS ZIP compression method ${method}`);
      return new TextDecoder().decode(raw);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 400))).replace(/\s+/g, " ").trim();
  if (!head.startsWith("PK")) throw new Error(`CAISO OASIS returned a non-ZIP error document: ${head || "empty response"}`);
  throw new Error("CAISO OASIS response ZIP contains no readable CSV entry");
}
