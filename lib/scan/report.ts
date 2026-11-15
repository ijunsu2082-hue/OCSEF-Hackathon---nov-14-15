import type { LineRatingNow, ScanResult } from "./types";
import { FUEL_KEYS, FUEL_LABELS } from "./colors";
import { aarRatio, conductorRange, ratioRange, windSentence } from "./rating";
import { gridLayerProvider } from "./sourceLabel";

type LayerOrigin = "etl" | "bundled";

/** Footer attribution for the line and substation layers, by provider. */
function gridAttribution(lines: LayerOrigin, substations: LayerOrigin, long: boolean): string {
  const name = (layer: LayerOrigin) => gridLayerProvider(layer) === "HIFLD"
    ? "HIFLD"
    : long ? "OpenStreetMap contributors, ODbL" : "OpenStreetMap";
  return lines === substations
    ? long ? `${name(lines)} (lines, substations)` : `Lines/substations: ${name(lines)}.`
    : long ? `${name(lines)} (lines); ${name(substations)} (substations)` : `Lines: ${name(lines)}. Substations: ${name(substations)}.`;
}

const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
const n1 = (x: number) => (Math.round(x * 10) / 10).toLocaleString("en-US");

/**
 * `rating_unavailable` / `unscored_factors` come from scanArea(); a plain
 * ScanResult without them is rendered as before. `layers` is LoadedGridData's
 * per-layer origin; without it lines and substations are labelled as bundled OSM.
 */
export function scanReportMarkdown(
  r: ScanResult & { rating_unavailable?: string | null; unscored_factors?: string[] },
  live: LineRatingNow | null,
  layers: { lines: LayerOrigin; substations: LayerOrigin } = { lines: "bundled", substations: "bundled" },
): string {
  const t = r.totals;
  const s = r.rating_site;
  const unscored = new Set(r.unscored_factors ?? []);
  const L: string[] = [];
  L.push(`# Mapergy Area Scan — ${r.area_label}`);
  L.push("");
  L.push(`**Area:** ${r.area.lat.toFixed(4)}, ${r.area.lon.toFixed(4)} · radius ${r.area.radius_mi} mi${r.inside_coverage ? "" : " · OUTSIDE the 100-mi coverage area (data may be incomplete)"}`);
  L.push("");
  L.push(`## Risk: ${r.risk.score}/100 (${r.risk.level}) (Mapergy's own index, not an official rating)`);
  for (const f of r.risk.factors) {
    L.push(`- ${f.label}: ${unscored.has(f.key) ? "not scored" : n0(f.score)} (weight ${Math.round(f.weight * 100)}%) — ${f.detail}`);
  }
  L.push("");
  L.push("## Sources: renewable vs current");
  const mix = FUEL_KEYS.filter((k) => t.mw_by_source[k] > 0).map((k) => `${FUEL_LABELS[k]} ${n1(t.mw_by_source[k])} MW`);
  L.push(`- ${t.plant_count} plants, ${n1(t.nameplate_mw)} MW nameplate (EIA-860 2025)`);
  L.push(`- Renewable ${n1(t.renewable_mw)} MW (${n1(t.renewable_pct)}%) · storage ${n1(t.storage_mw)} MW · fossil ${n1(t.fossil_mw)} MW`);
  if (mix.length) L.push(`- Mix: ${mix.join(", ")}`);
  L.push("");
  L.push("## Output & draw / capacity");
  if (r.plants.length) {
    for (const p of r.plants.slice(0, 5)) L.push(`- ${p.plant_name} (${p.city || p.county}): ${n1(p.nameplate_mw)} MW, ${FUEL_LABELS[p.primary_source] ?? p.primary_source}`);
  } else L.push("- No EIA-860 plants in this circle");
  const inferred = r.lines.some((l) => l.kv_inferred) ? "; some voltages filled in from connected lines" : "";
  L.push(`- Lines: ${n1(t.line_miles)} mi (500+ kV ${n1(t.line_miles_by_kv["500+"])}, 200-499 kV ${n1(t.line_miles_by_kv["200-499"])}, 100-199 kV ${n1(t.line_miles_by_kv["100-199"])}, <100 kV ${n1(t.line_miles_by_kv["<100"])}, no voltage listed ${n1(t.line_miles_by_kv.unknown)}) (${gridLayerProvider(layers.lines)}${inferred})`);
  L.push(`- Substations: ${t.substation_count} (${t.hv_substation_count} at >=200 kV) (${gridLayerProvider(layers.substations)})`);
  L.push("");
  L.push("## Energy cycle");
  L.push(t.evening_cover_pct === null
    ? "- No solar here, so no sunset handoff to cover"
    : `- Sunset handoff: storage equals ${n1(t.evening_cover_pct)}% of solar nameplate`);
  L.push("");
  L.push("## Age of infrastructure");
  L.push(`- Capacity-weighted age: ${t.cap_weighted_age === null ? "n/a" : `${n1(t.cap_weighted_age)} yr`}${t.oldest ? ` · oldest unit: ${t.oldest.name} (${t.oldest.year})` : ""}`);
  L.push(`- Planned retirements ${n1(t.planned_retirement_mw)} MW · already retired ${n1(t.retired_mw)} MW · proposed ${n1(t.proposed_mw)} MW (${n1(t.proposed_storage_mw)} MW storage) (EIA-860)`);
  L.push("");
  L.push(`## Line capacity (MODELED, IEEE 738, 75 C wire limit, nearest weather site ${s.name}, ${n1(s.distance_mi)} mi)`);
  if (live) {
    const w = live.weather;
    const aar = aarRatio(live);
    const range = conductorRange(w);
    const pct = (x: number) => `${x >= 1 ? "+" : "-"}${Math.round(Math.abs(x - 1) * 100)}%`;
    L.push(`- Weather (${w.source}, ${w.time}): ${n1(w.temp_c)} C, wind ${n1(w.wind_ms)} m/s, sun ${n0(w.sun_wm2)} W/m2`);
    L.push(`- Fixed worst-case rating (static, 40 C, 0.61 m/s wind, full sun), ACSR Drake 795 kcmil: ${n0(live.static_A)} A`);
    if (aar !== null) {
      L.push(`- Temperature-adjusted rating (ambient-adjusted rating, AAR, as FERC Order 881 defines it; real temperature, worst-case sun by day and none at night, fixed wind): ${n0(live.aar_A)} A = ${aar.toFixed(2)}x static (${pct(aar)}; versus the 40 C worst case, so less versus seasonal ratings and none where equipment or stability sets the limit)`);
    }
    L.push(`- With today's wind too (dynamic line rating, DLR, wind halved for safety): ${n0(live.dlr_conservative_A)} A = ${live.ratio.toFixed(2)}x static (${pct(live.ratio)})`);
    if (aar !== null && aar > 0 && live.ratio > 0) L.push(`- ${windSentence(aar, live.ratio)}`);
    L.push(`- Across common wire types (${range.rows.map((x) => x.name).join(", ")}), each against its own fixed rating: temperature-adjusted ${ratioRange(range.aar_min, range.aar_max)}, with wind ${ratioRange(range.dlr_min, range.dlr_max)}`);
  }
  if (r.rating_unavailable) {
    L.push(`- 2025 rating summary: unavailable (${r.rating_unavailable})`);
  } else {
    const yr: string[] = [];
    if (typeof s.median_aar_vs_static === "number") yr.push(`typical hour ${s.median_aar_vs_static}x from temperature alone`);
    yr.push(`typical hour ${s.median_conservative_dlr_vs_static}x with wind halved`);
    if (Number.isFinite(s.summer_4to8pm_median_wind_gain_over_aar)) {
      const g = Math.round((s.summer_4to8pm_median_wind_gain_over_aar - 1) * 100);
      yr.push(g >= 1 ? `wind adds about ${g}% over temperature alone on summer evenings (4-8 pm)` : "wind adds nothing over temperature alone on summer evenings (4-8 pm)");
    }
    L.push(`- 2025 at ${s.name}: ${yr.join("; ")}. With wind halved the rating beat static in ${s.pct_hours_conservative_dlr_above_static}% of hours; hottest hour ${s.hottest_hour} (${s.hottest_temp_c} C) only ${s.hottest_hour_dlr_vs_static}x`);
  }
  L.push("- Rules: FERC Order 881 requires US transmission providers to use temperature-adjusted ratings (general deadline July 2025; FERC extended CAISO to Dec 17, 2026, and the utilities that own lines in its grid (e.g., SCE, SDG&E, PG&E) have up to Oct 15, 2027). Applies only to FERC-regulated utilities. Wind-based ratings are not required.");
  L.push("- Screening estimate for a typical wire. Real limits also depend on the exact wire, its worst span, and equipment like breakers, so a utility must confirm.");
  L.push("");
  if (r.cases.length) {
    L.push("## Cases in this area");
    for (const c of r.cases) L.push(`- **${c.title}** (${c.category}) — ${c.shock_line}`);
    L.push("");
  }
  L.push("## Upgrade potential");
  for (const u of r.upgrade_ideas) L.push(`- ${u}`);
  L.push("");
  L.push("---");
  L.push(`Sources: EIA-860 final 2025, released Sep 2026 (plants, retired & proposed generators); ${gridAttribution(layers.lines, layers.substations, true)}; Open-Meteo live + 2025 reanalysis (weather). Line ratings are MODELED screening estimates (simplified IEEE 738), not operating ratings; wire sizes from the Prysmian TransPowr ACSR data sheet.`);
  L.push("FERC Order 881: https://www.federalregister.gov/documents/2022/01/13/2021-27735/managing-transmission-line-ratings ; CAISO extension: https://www.caiso.com/documents/apr-30-2025-order-accepting-motion-for-extension-order-no-881-er22-2362.pdf");
  return L.join("\n");
}
