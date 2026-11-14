import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichGrid } from "../lib/scan/enrich";
import { kvLabel, lineName, substationName } from "../lib/scan/labels";
import type { Line, Plant, Substation } from "../lib/scan/types";
import { readJson } from "./helpers";

type F = { geometry: { type: string; coordinates: any }; properties: Record<string, any> };
type FC = { features: F[] };
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown) => (typeof x === "string" && x !== "" ? x : null);

// Same field mapping as lib/scan/data.ts (toLine / toSubstation / toPlant), only the fields enrichGrid uses.
function load() {
  const lines: Line[] = readJson<FC>("public/layers/transmission.geojson").features
    .filter((f) => f.geometry?.type === "LineString" && f.geometry.coordinates.length >= 2)
    .map((f) => ({
      osm_id: Number(f.properties.osm_id), voltage_kv: num(f.properties.voltage_kv),
      operator: str(f.properties.operator), name: str(f.properties.name), circuits: str(f.properties.circuits),
      coords: (f.geometry.coordinates as [number, number][]).map(([lo, la]) => [la, lo] as [number, number]),
    }) as Line);
  const substations: Substation[] = readJson<FC>("public/layers/substations.geojson").features
    .filter((f) => f.geometry?.type === "Point")
    .map((f) => ({
      osm_id: String(f.properties.osm_id), name: str(f.properties.name), operator: str(f.properties.operator),
      voltage_kv: num(f.properties.voltage_kv), substation: str(f.properties.substation),
      lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
    }) as Substation);
  const plants = readJson<FC>("public/layers/plants.geojson").features
    .filter((f) => f.geometry?.type === "Point")
    .map((f) => ({ city: String(f.properties.city ?? ""), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }) as Plant);
  return { lines, substations, plants };
}

const hasKv = (kv: number | null) => kv != null && Number.isFinite(kv);
const BAD = /unknown|unnamed|not listed/i;

test("enrichGrid fills voltages and place names from the real layers", () => {
  const d = load();
  const before = {
    lineKv: d.lines.filter((l) => hasKv(l.voltage_kv)).length,
    subKv: d.substations.filter((s) => hasKv(s.voltage_kv)).length,
    subPlace: d.substations.filter((s) => s.name).length,
    linePlace: d.lines.filter((l) => l.name).length,
  };
  const taggedKv = new Map(d.lines.map((l) => [l, l.voltage_kv]));
  const t0 = performance.now();
  enrichGrid(d);
  const ms = performance.now() - t0;
  const after = {
    lineKv: d.lines.filter((l) => hasKv(l.voltage_kv)).length,
    subKv: d.substations.filter((s) => hasKv(s.voltage_kv)).length,
    subPlace: d.substations.filter((s) => s.name || s.near).length,
    linePlace: d.lines.filter((l) => l.name || l.near).length,
  };
  console.log(`enrich: lines ${d.lines.length}, subs ${d.substations.length}, ${ms.toFixed(0)} ms`, { before, after });

  assert.ok(after.lineKv > before.lineKv, "line voltage coverage should improve");
  assert.ok(after.subKv > before.subKv, "substation voltage coverage should improve");
  assert.ok(after.subPlace > before.subPlace, "substation place coverage should improve");
  assert.ok(after.linePlace > before.linePlace, "line place coverage should improve");

  // Tagged values are never overwritten; filled values are marked.
  for (const l of d.lines) {
    const orig = taggedKv.get(l)!;
    if (hasKv(orig)) {
      assert.equal(l.voltage_kv, orig);
      assert.ok(!l.kv_inferred);
    } else if (hasKv(l.voltage_kv)) {
      assert.equal(l.kv_inferred, true);
    }
  }
});

test("asset labels never use placeholder words", () => {
  const d = load();
  enrichGrid(d);
  for (const s of d.substations) {
    const n = substationName(s);
    assert.ok(n.length > 0 && !BAD.test(n), `substation label "${n}"`);
    const k = kvLabel(s.voltage_kv, s.kv_inferred);
    assert.ok(k === null || !BAD.test(k), `kv label "${k}"`);
  }
  for (const l of d.lines) {
    const n = lineName(l);
    assert.ok(n.length > 0 && !BAD.test(n), `line label "${n}"`);
    const k = kvLabel(l.voltage_kv, l.kv_inferred);
    assert.ok(k === null || !BAD.test(k), `kv label "${k}"`);
  }
});
