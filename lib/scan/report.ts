import type { LineRatingNow, ScanResult } from "./types";
import { FUEL_KEYS, FUEL_LABELS } from "./colors";

const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
const n1 = (x: number) => (Math.round(x * 10) / 10).toLocaleString("en-US");

export function scanReportMarkdown(r: ScanResult, live: LineRatingNow | null): string {
  const t = r.totals;
  const s = r.rating_site;
  const L: string[] = [];
  L.push(`# GridSentinel Area Scan — ${r.area_label}`);
  L.push("");
  L.push(`**Area:** ${r.area.lat.toFixed(4)}, ${r.area.lon.toFixed(4)} · radius ${r.area.radius_mi} mi${r.inside_coverage ? "" : " · OUTSIDE the 100-mi coverage area (data may be incomplete)"}`);
  L.push("");
  L.push(`## Risk: ${r.risk.score}/100 (${r.risk.level}) (GridSentinel's own index, not an official rating)`);
  for (const f of r.risk.factors) L.push(`- ${f.label}: ${n0(f.score)} (weight ${Math.round(f.weight * 100)}%) — ${f.detail}`);
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
  L.push(`- Lines: ${n1(t.line_miles)} mi (500+ kV ${n1(t.line_miles_by_kv["500+"])}, 200-499 kV ${n1(t.line_miles_by_kv["200-499"])}, 100-199 kV ${n1(t.line_miles_by_kv["100-199"])}, <100 kV ${n1(t.line_miles_by_kv["<100"])}, unknown ${n1(t.line_miles_by_kv.unknown)}) (OSM)`);
  L.push(`- Substations: ${t.substation_count} (${t.hv_substation_count} at >=200 kV) (OSM)`);
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
  L.push(`## The Wire That Breathes (MODELED, ACSR Drake 75 C, nearest weather site ${s.name}, ${n1(s.distance_mi)} mi)`);
  if (live) {
    const w = live.weather;
    L.push(`- Weather (${w.source}, ${w.time}): ${n1(w.temp_c)} C, wind ${n1(w.wind_ms)} m/s, sun ${n0(w.sun_wm2)} W/m2`);
    L.push(`- Static ${n0(live.static_A)} A · AAR ${n0(live.aar_A)} A · DLR ${n0(live.dlr_A)} A · conservative DLR ${n0(live.dlr_conservative_A)} A → ${live.ratio.toFixed(2)}x static (${live.extra_pct >= 0 ? "+" : ""}${n1(live.extra_pct)}%) (MODELED)`);
  }
  L.push(`- 2024: conservative DLR beat static in ${s.pct_hours_conservative_dlr_above_static}% of hours, median ${s.median_conservative_dlr_vs_static}x; hottest hour ${s.hottest_hour} (${s.hottest_temp_c} C) only ${s.hottest_hour_dlr_vs_static}x (MODELED)`);
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
  L.push("Sources: EIA-860 2025 (plants, retired & proposed generators); OpenStreetMap contributors, ODbL (lines, substations); Open-Meteo (weather). Line ratings are MODELED screening estimates (simplified IEEE 738), not operating ratings.");
  L.push("Plants: EIA-860 final 2025 (released Sep 2026). Lines/substations: OpenStreetMap. Weather: Open-Meteo live + 2024 reanalysis. Line ratings modeled with IEEE 738 for one typical conductor.");
  return L.join("\n");
}
