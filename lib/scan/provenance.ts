/*
 * "Where these numbers come from": one row per headline number in the Area
 * tab, with how we got it (method), where it comes from (source link) and the
 * formula or assumption in one plain sentence. Pure: every value is computed
 * by the same lib functions the panel uses, and every source is an entry in
 * lib/scan/sources.ts.
 */

import { cToF, fmtNum, fmtPct, fmtPowerText, fmtRatio, isNum } from "@/components/scan/panel/format";
import {
  CAMX_CO2_AVG,
  CAMX_CO2_NONBASELOAD,
  CA_HOME_KWH_PER_MONTH,
  CURTAILED_LOCAL_2025,
  CURTAILED_TOTAL_2025,
  bulkLineMiles,
  co2RangeTonnes,
  homesForYear,
  localSharePct,
} from "./impact";
import { DRAKE, STATIC, aarRatio, ampacity, heatwaveWeather } from "./rating";
import { WEIGHTS, riskRange } from "./risk";
import { SOURCES, type SourceId } from "./sources";
import type { LineRatingNow, ScanResult } from "./types";

/** MEASURED: read from a dataset. MODELED: our own calculation. SCENARIO: a what-if. ESTIMATE: rough statewide figure. */
export type Method = "MEASURED" | "MODELED" | "SCENARIO" | "ESTIMATE";

export interface ProvenanceRow {
  label: string;
  value: string;
  method: Method;
  source: { label: string; url: string };
  how: string;
}

/** Link for a source entry. The risk index has no page of its own, so it is not passed here. */
function src(id: SourceId): { label: string; url: string } {
  const s = SOURCES[id] as { name: string; url?: string };
  return { label: s.name, url: s.url ?? "" };
}

/** Our fixed (static) rating for the default Drake wire, in A. Same math as rateLine(). */
export function staticRatingA(): number {
  return Math.round(ampacity(STATIC.ta, STATIC.wind, STATIC.sun, STATIC.angle));
}

const pct = (w: number) => `${Math.round(w * 100)}%`;

export function provenanceFor(result: ScanResult, live: LineRatingNow | null, heatwave: boolean): ProvenanceRow[] {
  const t = result.totals;
  const rows: ProvenanceRow[] = [];

  // --- Line rating (live weather or the heatwave scenario) ---
  const scenario = heatwave || live?.weather.source === "heatwave-scenario";
  if (scenario) {
    const hw = heatwaveWeather();
    rows.push({
      label: "Heatwave scenario",
      value: `${fmtNum(cToF(hw.temp_c), 0)} °F`,
      method: "SCENARIO",
      source: src("ieee738"),
      how: `A what-if, not a forecast: ${fmtNum(hw.temp_c, 1)} °C air, ${fmtNum(hw.wind_ms, 1)} m/s wind and ${fmtNum(hw.sun_wm2, 0)} W/m² sun fed into the same line rating model.`,
    });
  }
  if (live) {
    const w = live.weather;
    // In the scenario the weather is the "Heatwave scenario" row above.
    if (!scenario && w.source === "fallback-2025") {
      rows.push({
        label: "Weather used (live unavailable)",
        value: `${fmtNum(w.temp_c, 1)} °C, wind ${fmtNum(w.wind_ms, 1)} m/s`,
        method: "MODELED",
        source: src("era5_2025"),
        how: "Live weather did not load, so we use the same hour of 2025 at the nearest of our 7 weather sites (ERA5 reanalysis).",
      });
    } else if (!scenario) {
      rows.push({
        label: "Weather now",
        value: `${fmtNum(w.temp_c, 1)} °C, wind ${fmtNum(w.wind_ms, 1)} m/s, sun ${fmtNum(w.sun_wm2, 0)} W/m²`,
        method: "MEASURED",
        source: src("openmeteo_live"),
        how: "Current temperature, wind and sun at the scanned point from the Open-Meteo forecast API.",
      });
    }

    rows.push({
      label: "Temperature-adjusted rating vs fixed",
      value: fmtRatio(aarRatio(live)),
      method: "MODELED",
      source: src("ieee738"),
      how: `IEEE Std 738 heat balance for a ${DRAKE.name} wire at 75 °C: rating at ${scenario ? "the scenario" : "today's"} air temperature (wind held at ${STATIC.wind} m/s, full sun by day) divided by the fixed rating.`,
    });
    rows.push({
      label: "Wind-based rating vs fixed",
      value: fmtRatio(isNum(live.ratio) && live.ratio > 0 ? live.ratio : null),
      method: "MODELED",
      source: src("ieee738"),
      how: `Same model with ${scenario ? "the scenario's" : "real"} temperature, sun and wind, but the wind speed halved for safety, divided by the fixed rating.`,
    });
    rows.push({
      label: "Line headroom now",
      value: isNum(live.extra_pct) ? `${live.extra_pct >= 0 ? "+" : ""}${fmtNum(live.extra_pct, 0)}%` : "—",
      method: "MODELED",
      source: src("ieee738"),
      how: "(Wind-based rating ÷ fixed rating − 1) × 100, for the same Drake wire.",
    });
  }

  rows.push({
    label: "Fixed (static) rating",
    value: `${fmtNum(staticRatingA(), 0)} A`,
    method: "MODELED",
    source: src("ieee738"),
    how: `IEEE Std 738 rating of a ${DRAKE.name} ACSR wire at 75 °C under a worst case of ${STATIC.ta} °C air, ${STATIC.wind} m/s wind and ${STATIC.sun} W/m² sun, all year.`,
  });

  // --- Plants (EIA-860) ---
  const largest = result.plants[0];
  rows.push({
    label: "Nameplate",
    value: fmtPowerText(t.nameplate_mw),
    method: "MEASURED",
    source: src("eia860"),
    how: "Sum of nameplate MW of every EIA-860 plant operating at year-end 2025 inside the circle.",
  });
  rows.push({
    label: "Power plants",
    value: fmtNum(t.plant_count),
    method: "MEASURED",
    source: src("eia860"),
    how: "Count of EIA-860 plants inside the circle.",
  });
  if (largest) {
    rows.push({
      label: "Largest plant",
      value: `${fmtPowerText(largest.nameplate_mw)} (${largest.plant_name})`,
      method: "MEASURED",
      source: src("eia860"),
      how: "The plant with the most nameplate MW in EIA-860 inside the circle.",
    });
  }
  rows.push({
    label: "Renewables share",
    value: fmtPct(t.renewable_pct),
    method: "MEASURED",
    source: src("eia860"),
    how: "Solar, wind, hydro and biogas MW divided by all nameplate MW, from EIA-860 MW by fuel.",
  });
  rows.push({
    label: "Evening cover",
    value: fmtPct(t.evening_cover_pct),
    method: "MEASURED",
    source: src("eia860"),
    how: "Battery MW divided by solar MW in EIA-860 (over 100% means more battery than solar here).",
  });
  rows.push({
    label: "Capacity-weighted age",
    value: isNum(t.cap_weighted_age) ? `${fmtNum(t.cap_weighted_age, 0)} yr` : "—",
    method: "MEASURED",
    source: src("eia860"),
    how: "Average generator age from EIA-860 in-service years, weighted by each generator's MW.",
  });
  rows.push({
    label: "Proposed storage",
    value: fmtPowerText(t.proposed_storage_mw),
    method: "MEASURED",
    source: src("eia860_events"),
    how: "Battery MW on the EIA-860 proposed generator sheet inside the circle.",
  });

  // --- Lines and substations (OpenStreetMap, CEC names) ---
  const inferredLines = result.lines.filter((l) => l.kv_inferred).length;
  rows.push({
    label: "Transmission lines",
    value: `${fmtNum(t.line_miles, t.line_miles > 0 && t.line_miles < 10 ? 1 : 0)} mi`,
    method: "MEASURED",
    source: src("osm"),
    how: "Length of OpenStreetMap power lines of 69 kV and up inside the circle.",
  });
  const bulk = bulkLineMiles(result);
  rows.push({
    label: "Lines 200 kV and up",
    value: `${fmtNum(bulk, bulk < 10 ? 1 : 0)} mi`,
    method: "MEASURED",
    source: src("osm"),
    how: `OpenStreetMap line miles tagged 200 kV and up; voltages are partly inferred from connected lines or substations (${fmtNum(inferredLines)} of ${fmtNum(result.lines.length)} lines here).`,
  });
  const cecNamed = result.substations.filter((s) => s.name_source === "state_list").length;
  rows.push({
    label: "Substations",
    value: fmtNum(t.substation_count),
    method: "MEASURED",
    source: src("osm"),
    how: `Count of OpenStreetMap substations inside the circle; ${fmtNum(t.hv_substation_count)} are 200 kV and up (voltage partly inferred).`,
  });
  rows.push({
    label: "Substation names from the state list",
    value: fmtNum(cecNamed),
    method: "MEASURED",
    source: src("state_substations"),
    how: "Unnamed OpenStreetMap substations take the name of the closest operational CEC substation within 200 m.",
  });

  // --- Risk index (our own) ---
  const range = riskRange(result.risk);
  const weights = Object.entries(WEIGHTS)
    .map(([k, v]) => `${k} ${pct(v.weight)}`)
    .join(", ");
  rows.push({
    label: "Risk index",
    value: `${fmtNum(result.risk.score, 0)} / 100 (${result.risk.level})`,
    method: "MODELED",
    // Our own index has no page; link the dataset most of its inputs come from.
    source: { label: `${SOURCES.risk.name} (inputs: ${SOURCES.eia860.name})`, url: SOURCES.eia860.url },
    how: `Our own 0–100 weighted average (${weights}), not an official rating; moving every weight by ±50% gives ${fmtNum(range.min, 0)}–${fmtNum(range.max, 0)}.`,
  });

  // --- Statewide curtailment impact (CAISO, EPA, EIA) ---
  const local = CURTAILED_LOCAL_2025.value;
  const co2 = co2RangeTonnes(local);
  const homes = homesForYear(local);
  rows.push({
    label: `Solar and wind curtailed in ${CURTAILED_TOTAL_2025.year}`,
    value: `${fmtNum(CURTAILED_TOTAL_2025.value / 1_000_000, 2)} million MWh`,
    method: "ESTIMATE",
    source: src("caiso_curtailment_2025"),
    how: "Sum of CAISO's 5-minute curtailment MW for 2025, divided by 12 to get MWh (CAISO grid only).",
  });
  rows.push({
    label: "Cut because local lines were full",
    value: fmtPct(localSharePct(), 0),
    method: "ESTIMATE",
    source: src("caiso_curtailment_2025"),
    how: `CAISO "Local" (congestion) curtailment, ${fmtNum(local, 0)} MWh, divided by all curtailment.`,
  });
  rows.push({
    label: "CO2 if congestion curtailment had replaced other power",
    value: `${fmtNum(co2.low / 1_000_000, 1)}–${fmtNum(co2.high / 1_000_000, 1)} million t`,
    method: "ESTIMATE",
    source: src("egrid2023_camx"),
    how: `Local curtailment MWh × ${CAMX_CO2_AVG.value} (average) to ${CAMX_CO2_NONBASELOAD.value} (non-baseload) lb CO2/MWh from eGRID CAMX, in metric tonnes; true savings are likely lower.`,
  });
  rows.push({
    label: "Homes that power could supply for a year",
    value: `about ${fmtNum(Math.round(homes / 10_000) * 10_000, 0)}`,
    method: "ESTIMATE",
    source: src("eia_ca_home_use"),
    how: `Local curtailment MWh ÷ (${CA_HOME_KWH_PER_MONTH.value} kWh a month × 12) for an average California home.`,
  });

  return rows;
}
