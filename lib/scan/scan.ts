import type { FuelKey, GridData, KvBand, Line, NicheCase, Plant, ScanArea, ScanResult } from "./types";
import { CENTER, COVERAGE_MI, degSpan, haversineMi, kvBand, round } from "./geo";
import { FUEL_KEYS } from "./colors";
import { nearestSite } from "./data";
import { computeRisk } from "./risk";
import { lineIndex } from "./lineIndex";

// ---------- scan ----------

const emptyBands = (): Record<KvBand, number> => ({ "500+": 0, "200-499": 0, "100-199": 0, "<100": 0, unknown: 0 });

export function scanArea(data: GridData, area: ScanArea, opts?: { heatwave?: boolean }): ScanResult {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { lat, lon } = area;
  const r = Number.isFinite(area.radius_mi) && area.radius_mi > 0 ? area.radius_mi : 0.1;
  const { dLat, dLon } = degSpan(r, lat);
  const bb = { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
  const inBox = (la: number, lo: number) => la >= bb.minLat && la <= bb.maxLat && lo >= bb.minLon && lo <= bb.maxLon;
  const within = (la: number, lo: number) => inBox(la, lo) && haversineMi(lat, lon, la, lo) <= r;

  // Points
  const plants = data.plants.filter((p) => within(p.lat, p.lon)).sort((a, b) => b.nameplate_mw - a.nameplate_mw);
  const substations = data.substations.filter((s) => within(s.lat, s.lon));
  const events = data.events.filter((e) => within(e.lat, e.lon));
  const caseDist = new Map<NicheCase, number>();
  for (const c of data.cases) {
    const l = c.location;
    if (l && Number.isFinite(l.lat) && Number.isFinite(l.lon) && within(l.lat, l.lon)) {
      caseDist.set(c, haversineMi(lat, lon, l.lat, l.lon));
    }
  }
  const cases = [...caseDist.keys()].sort((a, b) => (caseDist.get(a) ?? 0) - (caseDist.get(b) ?? 0));

  // Lines
  const lines: Line[] = [];
  const line_miles_by_kv = emptyBands();
  let line_miles = 0;
  let hvLineMiles = 0;
  const step = r / 4;
  for (const li of lineIndex(data)) {
    if (li.maxLat < bb.minLat || li.minLat > bb.maxLat || li.maxLon < bb.minLon || li.minLon > bb.maxLon) continue;
    let inside = false;
    let miles = 0;
    for (const [la, lo] of li.line.coords) {
      if (within(la, lo)) { inside = true; break; }
    }
    const s = li.seg;
    for (let i = 0; i < s.length; i += 5) {
      const aLat = s[i], aLon = s[i + 1], bLat = s[i + 2], bLon = s[i + 3], len = s[i + 4];
      if (Math.max(aLat, bLat) < bb.minLat || Math.min(aLat, bLat) > bb.maxLat ||
          Math.max(aLon, bLon) < bb.minLon || Math.min(aLon, bLon) > bb.maxLon) continue;
      const k = len > step ? Math.ceil(len / step) : 1;
      const piece = len / k;
      for (let j = 0; j < k; j++) {
        const f = (j + 0.5) / k;
        if (within(aLat + (bLat - aLat) * f, aLon + (bLon - aLon) * f)) { miles += piece; inside = true; }
      }
    }
    if (!inside) continue;
    lines.push(li.line);
    line_miles += miles;
    line_miles_by_kv[kvBand(li.line.voltage_kv)] += miles;
    if ((li.line.voltage_kv ?? 0) >= 200) hvLineMiles += miles;
  }

  // Totals
  const mw_by_source = Object.fromEntries(FUEL_KEYS.map((k) => [k, 0])) as Record<FuelKey, number>;
  let nameplate = 0, planned = 0, ageW = 0, ageMw = 0, fossilAgeW = 0, fossilAgeMw = 0;
  let oldest: { name: string; year: number } | null = null;
  for (const p of plants) {
    nameplate += p.nameplate_mw;
    planned += p.planned_retirement_mw;
    for (const k of FUEL_KEYS) {
      const v = p.mw_by_source[k];
      if (typeof v === "number" && Number.isFinite(v)) mw_by_source[k] += v;
    }
    if (p.capacity_weighted_age_years !== null && p.nameplate_mw > 0) {
      ageW += p.capacity_weighted_age_years * p.nameplate_mw;
      ageMw += p.nameplate_mw;
      const fmw = fossilOf(p);
      if (fmw > 0) { fossilAgeW += p.capacity_weighted_age_years * fmw; fossilAgeMw += fmw; }
    }
    if (p.oldest_year !== null && (!oldest || p.oldest_year < oldest.year)) oldest = { name: p.plant_name, year: p.oldest_year };
  }
  for (const k of FUEL_KEYS) mw_by_source[k] = round(mw_by_source[k], 1);
  const renewable = mw_by_source.solar + mw_by_source.wind + mw_by_source.hydro + mw_by_source.biogas;
  const storage = mw_by_source.battery;
  const fossil = mw_by_source.natural_gas + mw_by_source.oil + mw_by_source.other_gas;
  const sumMw = (kind: "retired" | "proposed", fuel?: FuelKey) =>
    events.filter((e) => e.kind === kind && (!fuel || e.fuel === fuel)).reduce((s, e) => s + (Number.isFinite(e.mw) ? e.mw : 0), 0);
  for (const k of Object.keys(line_miles_by_kv) as KvBand[]) line_miles_by_kv[k] = round(line_miles_by_kv[k], 1);

  const totals: ScanResult["totals"] = {
    plant_count: plants.length,
    nameplate_mw: round(nameplate, 1),
    mw_by_source,
    renewable_mw: round(renewable, 1),
    storage_mw: round(storage, 1),
    fossil_mw: round(fossil, 1),
    renewable_pct: nameplate > 0 ? round((renewable / nameplate) * 100, 1) : 0,
    cap_weighted_age: ageMw > 0 ? round(ageW / ageMw, 1) : null,
    oldest,
    planned_retirement_mw: round(planned, 1),
    retired_mw: round(sumMw("retired"), 1),
    proposed_mw: round(sumMw("proposed"), 1),
    proposed_storage_mw: round(sumMw("proposed", "battery"), 1),
    line_miles: round(line_miles, 1),
    line_miles_by_kv,
    substation_count: substations.length,
    hv_substation_count: substations.filter((s) => (s.voltage_kv ?? 0) >= 200).length,
    evening_cover_pct: mw_by_source.solar > 0 ? round((storage / mw_by_source.solar) * 100, 1) : null,
  };

  const rating_site = nearestSite(data.ratingSites, lat, lon);
  const risk = computeRisk(totals, rating_site, cases, events, lines.length, opts);

  const area_label = areaLabel(data.plants, plants, lat, lon, r, rating_site);

  const upgrade_ideas = upgradeIdeas({
    totals, rating_site, cases, radius: r, hvLineMiles: round(hvLineMiles, 1),
    fossilAge: fossilAgeMw > 0 ? fossilAgeW / fossilAgeMw : null,
  });

  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    area: { lat, lon, radius_mi: area.radius_mi },
    area_label,
    inside_coverage: haversineMi(CENTER.lat, CENTER.lon, lat, lon) <= COVERAGE_MI,
    plants, lines, substations, cases, events,
    totals, risk, rating_site, upgrade_ideas,
    elapsed_ms: round(t1 - t0, 2),
  };
}

function titleCase(s: string): string {
  const t = s.trim();
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s\-'.])([a-z])/g, (_, a, b) => a + b.toUpperCase());
}

function areaLabel(
  all: Plant[], inside: Plant[], lat: number, lon: number, r: number, site: { name: string; lat: number; lon: number },
): string {
  const range = Math.max(r, 15);
  let nearest: Plant | null = null;
  let nd = Infinity;
  for (const p of all) {
    if (!p.city || !p.city.trim()) continue;
    const d = haversineMi(lat, lon, p.lat, p.lon);
    if (d <= range && d < nd) { nd = d; nearest = p; }
  }
  const anchor = inside[0]?.plant_name;
  if (nearest) {
    const city = titleCase(nearest.city);
    return anchor ? `${city} · near ${anchor}` : `${city} area`;
  }
  return `Remote area · ${Math.round(haversineMi(lat, lon, site.lat, site.lon))} mi from ${site.name}`;
}

function fossilOf(p: Plant): number {
  const m = p.mw_by_source;
  return (m.natural_gas ?? 0) + (m.oil ?? 0) + (m.other_gas ?? 0);
}

// ---------- upgrade ideas ----------

const n0 = (x: number) => Math.round(x).toLocaleString("en-US");

function upgradeIdeas(a: {
  totals: ScanResult["totals"]; rating_site: ScanResult["rating_site"]; cases: NicheCase[];
  radius: number; hvLineMiles: number; fossilAge: number | null;
}): string[] {
  const { totals: t, rating_site: s, cases } = a;
  const ideas: string[] = [];
  const solar = t.mw_by_source.solar;
  const headroom = Math.round((s.median_conservative_dlr_vs_static - 1) * 100);

  if (solar > 50 && (t.evening_cover_pct ?? 0) < 50) {
    const add = Math.max(1, solar * 0.5 - t.storage_mw);
    ideas.push(`Add about ${n0(add)} MW of 4-hour storage so solar covers the evening peak. Storage is only ${n0(t.evening_cover_pct ?? 0)}% of solar here.`);
  }
  if ((t.cap_weighted_age ?? 0) > 30 && t.fossil_mw > 200) {
    const z = a.fossilAge ?? t.cap_weighted_age ?? 0;
    ideas.push(`Repower ${n0(t.fossil_mw)} MW of gas averaging ${n0(z)} years old.`);
  }
  if (a.hvLineMiles > 0) {
    ideas.push(`Dynamic line rating on the ${n0(a.hvLineMiles)} mi of ≥200 kV lines here: about ${headroom}% more capacity on a typical hour.`);
  } else if (t.line_miles > 0) {
    ideas.push(`Dynamic line rating on the ${t.line_miles.toFixed(1)} mi of mapped lines here: about ${headroom}% more capacity on a typical hour.`);
  }
  if (t.proposed_mw > 0) {
    const st = t.proposed_storage_mw > 0 ? `, ${n0(t.proposed_storage_mw)} MW of it storage` : "";
    ideas.push(`${n0(t.proposed_mw)} MW is already proposed${st}. Prioritize its grid connection.`);
  }
  if (t.planned_retirement_mw > 0) {
    ideas.push(`Line up replacement for the ${n0(t.planned_retirement_mw)} MW scheduled to retire before it goes offline.`);
  }
  const fire = cases.filter((c) => c.category === "Wildfire");
  if (fire.length) {
    ideas.push(`Covered conductor or undergrounding on fire-exposed lines. ${fire.length} wildfire case${fire.length === 1 ? "" : "s"} here: ${fire[0].title}.`);
  }

  // Fallbacks so there are always at least 2 ideas
  if (ideas.length < 2 && t.plant_count === 0) {
    ideas.push(`No power plants within ${a.radius} mi. Rooftop solar plus home batteries are the main local supply option.`);
  }
  if (ideas.length < 2) {
    ideas.push(`Pilot dynamic line rating using ${s.name} weather (${s.distance_mi} mi away). The conservative rating beat the fixed rating in ${s.pct_hours_conservative_dlr_above_static}% of 2024 hours.`);
  }
  if (ideas.length < 2) {
    ideas.push(`Add sensors at the hottest-hour bottleneck. On ${s.hottest_hour.slice(0, 10) || "the hottest 2024 day"} the safe rating near ${s.name} was ${s.hottest_hour_dlr_vs_static.toFixed(2)}× the fixed rating.`);
  }
  return ideas.slice(0, 5);
}
