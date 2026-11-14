/**
 * Area Scan — adapted from PR #2's click-anywhere scan, rebuilt on the loaders
 * this app already ships (public/layers/*.geojson). Given a circle, it answers
 * "what is actually here, and what would I fix first?" from real EIA-860 plants
 * and OpenStreetMap grid assets. Every number is computed from the file at
 * scan time; nothing is quoted from memory.
 */

import type {
  PlantFeature,
  SubstationFeature,
  TransmissionFeature,
} from "../gridLayers";
import { sourceLabel } from "../gridLayers";
import { hourLabel, type WireSummary } from "./wire";

export interface ScanPoint {
  lat: number;
  lon: number;
  radius_mi: number;
}

export interface ScanLoadCenter {
  name: string;
  lat: number;
  lon: number;
  draw_mw: number;
}

export interface ScanInput {
  plants: PlantFeature[];
  substations: SubstationFeature[];
  transmission: TransmissionFeature[];
  loadCenters: ScanLoadCenter[];
}

export interface ScanPlantRow {
  name: string;
  mw: number;
  source: string;
  age_years: number | null;
  distance_mi: number;
}

export interface ScanFactor {
  label: string;
  score: number;
  weight: number;
  detail: string;
}

export type ScanLevel = "LOW" | "WATCH" | "HIGH" | "CRITICAL";

export interface ScanResult {
  point: ScanPoint;
  /** Nearest plant's city and name, or the nearest load center. */
  label: string;
  /** False when the circle sits outside the regional data footprint. */
  inside_coverage: boolean;
  /** Highest mapped voltage inside the circle. */
  max_voltage_kv: number | null;
  /** Hourly conductor rating for that tie, when the archive is available. */
  wire: WireSummary | null;
  plant_count: number;
  nameplate_mw: number;
  renewable_mw: number;
  storage_mw: number;
  fossil_mw: number;
  renewable_pct: number;
  mw_by_source: Record<string, number>;
  line_miles: number;
  hv_line_miles: number;
  line_miles_by_kv: Record<string, number>;
  substation_count: number;
  hv_substation_count: number;
  cap_weighted_age: number | null;
  oldest_plant: { name: string; year: number; distance_mi: number } | null;
  /** Colocated planned retirements (EIA-860), inside the circle. */
  planned_retirement_mw: number;
  planned_retirement_plants: number;
  evening_cover_pct: number | null;
  nearest_load_center: { name: string; distance_mi: number; draw_mw: number } | null;
  plants: ScanPlantRow[];
  risk: { score: number; level: ScanLevel; factors: ScanFactor[] };
  ideas: string[];
  report: string;
}

const MI_PER_DEG_LAT = 69.0;

export function haversineMi(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * 0.621371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function lonSpanMi(radiusMi: number, lat: number): number {
  const cos = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  return radiusMi / (MI_PER_DEG_LAT * cos);
}

export function kvBand(kv: number | null): string {
  if (kv === null || !Number.isFinite(kv)) return "unknown";
  if (kv >= 500) return "500+";
  if (kv >= 200) return "200-499";
  if (kv >= 100) return "100-199";
  return "<100";
}

const round = (value: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

function levelFor(score: number): ScanLevel {
  if (score >= 70) return "CRITICAL";
  if (score >= 50) return "HIGH";
  if (score >= 30) return "WATCH";
  return "LOW";
}

export interface ScanOptions {
  heatwave?: boolean;
  /** Regional data footprint; a scan outside it is flagged, not silently empty. */
  regionCenter?: { lat: number; lon: number };
  coverageMi?: number;
  /**
   * Rate the highest-voltage tie inside the circle. Supplied by the map so the
   * scan itself stays pure and CPU only (no fetch inside the engine).
   */
  rateVoltage?: (voltageKv: number) => WireSummary | null;
}

export function scanArea(
  point: ScanPoint,
  input: ScanInput,
  options: ScanOptions = {},
): ScanResult {
  const { lat, lon } = point;
  const radius = Number.isFinite(point.radius_mi) && point.radius_mi > 0 ? point.radius_mi : 1;
  const dLat = radius / MI_PER_DEG_LAT;
  const dLon = lonSpanMi(radius, lat);
  const minLat = lat - dLat;
  const maxLat = lat + dLat;
  const minLon = lon - dLon;
  const maxLon = lon + dLon;

  const inBox = (a: number, b: number) =>
    a >= minLat && a <= maxLat && b >= minLon && b <= maxLon;
  const within = (a: number, b: number) =>
    inBox(a, b) && haversineMi(lat, lon, a, b) <= radius;

  const plants: ScanPlantRow[] = [];
  const mwBySource: Record<string, number> = {};
  let nameplate = 0;
  let ageWeighted = 0;
  let ageBasis = 0;
  let oldest: ScanResult["oldest_plant"] = null;
  let nearestPlant: { name: string; city: string | null; distance_mi: number; mw: number } | null = null;
  let plannedRetirementMw = 0;
  let plannedRetirementPlants = 0;

  for (const feature of input.plants) {
    const [pLon, pLat] = feature.geometry.coordinates;
    if (!within(pLat, pLon)) continue;
    const props = feature.properties;
    const distance = haversineMi(lat, lon, pLat, pLon);
    const mw = Number.isFinite(props.nameplate_mw) ? props.nameplate_mw : 0;
    // Anchor the label on the biggest generator inside the circle: the city
    // names the place, the plant names what actually supplies it.
    if (
      mw >= 50 &&
      (!nearestPlant || mw > nearestPlant.mw || (mw === nearestPlant.mw && distance < nearestPlant.distance_mi))
    ) {
      nearestPlant = {
        name: props.plant_name,
        city: props.city ?? null,
        distance_mi: distance,
        mw,
      };
    }
    nameplate += mw;
    const source = props.primary_source ?? "other";
    mwBySource[source] = (mwBySource[source] ?? 0) + mw;
    if (props.capacity_weighted_age_years !== null && mw > 0) {
      ageWeighted += props.capacity_weighted_age_years * mw;
      ageBasis += mw;
    }
    if (props.planned_retirement_mw > 0) {
      plannedRetirementMw += props.planned_retirement_mw;
      plannedRetirementPlants += 1;
    }
    if (props.oldest_year !== null && (!oldest || props.oldest_year < oldest.year)) {
      oldest = {
        name: props.plant_name,
        year: props.oldest_year,
        distance_mi: round(distance, 1),
      };
    }
    plants.push({
      name: props.plant_name,
      mw: round(mw, 1),
      source,
      age_years: props.capacity_weighted_age_years,
      distance_mi: round(distance, 1),
    });
  }
  plants.sort((a, b) => b.mw - a.mw);

  let substationCount = 0;
  let hvSubstationCount = 0;
  for (const feature of input.substations) {
    const [sLon, sLat] = feature.geometry.coordinates;
    if (!within(sLat, sLon)) continue;
    substationCount += 1;
    if ((feature.properties.voltage_kv ?? 0) >= 200) hvSubstationCount += 1;
  }

  // Line miles: sample each segment so a long line is counted by the part that
  // actually falls inside the circle.
  const step = radius / 3;
  const bandMiles: Record<string, number> = {
    "500+": 0,
    "200-499": 0,
    "100-199": 0,
    "<100": 0,
    unknown: 0,
  };
  let lineMiles = 0;
  let hvLineMiles = 0;
  let maxKv: number | null = null;

  for (const feature of input.transmission) {
    const coords = feature.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const kv = feature.properties.voltage_kv;
    const band = kvBand(kv);

    for (let i = 1; i < coords.length; i += 1) {
      const [aLon, aLat] = coords[i - 1];
      const [bLon, bLat] = coords[i];
      if (
        Math.max(aLat, bLat) < minLat ||
        Math.min(aLat, bLat) > maxLat ||
        Math.max(aLon, bLon) < minLon ||
        Math.min(aLon, bLon) > maxLon
      ) {
        continue;
      }
      const segMi = haversineMi(aLat, aLon, bLat, bLon);
      if (segMi <= 0) continue;
      const pieces = Math.min(12, Math.max(1, Math.ceil(segMi / step)));
      for (let j = 0; j < pieces; j += 1) {
        const f = (j + 0.5) / pieces;
        if (within(aLat + (bLat - aLat) * f, aLon + (bLon - aLon) * f)) {
          lineMiles += segMi / pieces;
          bandMiles[band] += segMi / pieces;
          if ((kv ?? 0) >= 200) hvLineMiles += segMi / pieces;
          // Only a segment that actually enters the circle sets the circle's
          // voltage class; a bbox overlap is not a delivered circuit.
          if (kv !== null && (maxKv === null || kv > maxKv)) maxKv = kv;
        }
      }
    }
  }

  for (const key of Object.keys(bandMiles)) bandMiles[key] = round(bandMiles[key], 1);

  let nearestLoadCenter: ScanResult["nearest_load_center"] = null;
  for (const center of input.loadCenters) {
    const distance = haversineMi(lat, lon, center.lat, center.lon);
    if (!nearestLoadCenter || distance < nearestLoadCenter.distance_mi) {
      nearestLoadCenter = {
        name: center.name,
        distance_mi: round(distance, 1),
        draw_mw: round(center.draw_mw, 1),
      };
    }
  }

  const renewableMw =
    (mwBySource.solar ?? 0) + (mwBySource.wind ?? 0) + (mwBySource.hydro ?? 0) + (mwBySource.biogas ?? 0);
  const storageMw = mwBySource.battery ?? 0;
  const fossilMw =
    (mwBySource.natural_gas ?? 0) + (mwBySource.other_gas ?? 0) + (mwBySource.oil ?? 0);
  const renewablePct = nameplate > 0 ? (renewableMw / nameplate) * 100 : 0;
  const capAge = ageBasis > 0 ? ageWeighted / ageBasis : null;

  // The highest-voltage tie in the circle is the one that sets deliverability,
  // so it is the one the 2024 archive is asked about.
  const wire = maxKv !== null && options.rateVoltage ? options.rateVoltage(maxKv) : null;

  const fossilScore = nameplate > 0 ? (fossilMw / nameplate) * 100 : 0;
  const ageScore = capAge === null ? 40 : Math.min(100, Math.max(0, ((capAge - 20) / 40) * 100));
  const turnoverNote =
    plannedRetirementMw > 0
      ? ` ${round(plannedRetirementMw, 1)} MW of ${round(nameplate, 1)} MW retires on an announced EIA-860 date.`
      : "";
  const redundancyScore =
    hvSubstationCount === 0 ? 85 : hvSubstationCount === 1 ? 65 : hvSubstationCount <= 3 ? 40 : 20;
  const deliveryScore =
    lineMiles === 0 ? 90 : hvLineMiles === 0 ? 70 : hvLineMiles < radius * 2 ? 55 : 30;

  // Heat stress is the conductor's own heat balance, not a scenario constant:
  // a breeze worth 1.5x the still-air rating is no thermal constraint; a calm
  // hour worth 1.0x is the wire's whole margin gone.
  const wireRatio = wire
    ? options.heatwave
      ? wire.heatwave.ratio
      : wire.hottest?.ratio ?? null
    : null;
  const heatScore =
    wireRatio === null
      ? 40
      : Math.min(100, Math.max(0, ((1.5 - wireRatio) / 0.5) * 100));

  const factors: ScanFactor[] = [
    {
      label: "Fossil share",
      score: round(fossilScore, 0),
      weight: 0.3,
      detail: `${round(fossilMw, 1)} MW of ${round(nameplate, 1)} MW nameplate is gas, oil or other combustion.`,
    },
    {
      label: "Asset age",
      score: round(ageScore, 0),
      weight: 0.2,
      detail:
        (capAge === null
          ? "No capacity-weighted age in range."
          : `${round(capAge, 1)} yr capacity-weighted age.`) + turnoverNote,
    },
    {
      label: "Substation redundancy",
      score: redundancyScore,
      weight: 0.2,
      detail: `${hvSubstationCount} substation${hvSubstationCount === 1 ? "" : "s"} at 200 kV or above inside the circle.`,
    },
    {
      label: "Delivery margin",
      score: deliveryScore,
      weight: 0.15,
      detail: `${round(hvLineMiles, 1)} mi of 200 kV+ line, ${round(lineMiles, 1)} mi total.`,
    },
    {
      label: "Heat stress on wires",
      score: round(heatScore, 0),
      weight: 0.15,
      detail: !wire
        ? "The 2024 conductor archive is not loaded, so heat stress is neutral."
        : options.heatwave
          ? `At 105 °F the fixed rating falls ${wire.heatwave.derate_pct}% and a 3 m/s breeze returns ${wire.heatwave.ratio.toFixed(2)}× it.`
          : wire.hottest
            ? `Hottest 2024 hour (${hourLabel(wire.hottest.time)}, ${round(wire.hottest.temp_c, 1)} °C): the breeze was worth ${wire.hottest.ratio.toFixed(2)}× the still-air rating.`
            : "No hourly weather in the archive.",
    },
  ];

  const score = round(
    factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0),
    0,
  );

  const ideas: string[] = [];
  if (nameplate > 0 && renewablePct < 25) {
    ideas.push(
      `Pair ${round(Math.max(5, nameplate * 0.15), 1)} MW of solar with ${round(
        storageMw > 0 ? storageMw * 0.5 : nameplate * 0.05,
        1,
      )} MW of storage to lift the ${round(renewablePct, 0)}% renewable share.`,
    );
  } else if (storageMw === 0 && (mwBySource.solar ?? 0) > 0) {
    ideas.push("Add storage sized to the solar peak so the evening ramp is covered locally.");
  }
  if (hvSubstationCount <= 2) {
    ideas.push("Review 200 kV+ substation redundancy before adding load in this circle.");
  }
  if (lineMiles === 0) {
    ideas.push("No mapped transmission inside the circle — check the tie line before siting anything here.");
  } else if (hvLineMiles === 0) {
    ideas.push("Only sub-200 kV lines mapped here: confirm import capacity with the operator.");
  }
  if (capAge !== null && capAge > 35) {
    ideas.push(`Refurbish the ${round(capAge, 0)} yr fleet before extending its service life.`);
  }
  if (plannedRetirementMw > 0) {
    ideas.push(
      `Schedule the ${round(plannedRetirementMw, 1)} MW replacement before the announced retirement date, not after it.`,
    );
  }
  if (ideas.length === 0) {
    ideas.push("Area looks resilient on these screens; verify with interval data before committing capital.");
  }

  const result: Omit<ScanResult, "report"> = {
    point: { lat: round(lat, 4), lon: round(lon, 4), radius_mi: radius },
    label:
      nearestPlant?.city
        ? `${nearestPlant.city} · near ${nearestPlant.name}`
        : nearestLoadCenter?.name ?? `${round(lat, 2)}, ${round(lon, 2)}`,
    inside_coverage: options.regionCenter
      ? haversineMi(options.regionCenter.lat, options.regionCenter.lon, lat, lon) <=
        (options.coverageMi ?? 100)
      : true,
    max_voltage_kv: maxKv,
    wire,
    plant_count: plants.length,
    nameplate_mw: round(nameplate, 1),
    renewable_mw: round(renewableMw, 1),
    storage_mw: round(storageMw, 1),
    fossil_mw: round(fossilMw, 1),
    renewable_pct: round(renewablePct, 1),
    mw_by_source: Object.fromEntries(
      Object.entries(mwBySource).map(([key, value]) => [key, round(value, 1)]),
    ),
    line_miles: round(lineMiles, 1),
    hv_line_miles: round(hvLineMiles, 1),
    line_miles_by_kv: bandMiles,
    substation_count: substationCount,
    hv_substation_count: hvSubstationCount,
    cap_weighted_age: capAge === null ? null : round(capAge, 1),
    oldest_plant: oldest,
    planned_retirement_mw: round(plannedRetirementMw, 1),
    planned_retirement_plants: plannedRetirementPlants,
    evening_cover_pct:
      (mwBySource.solar ?? 0) > 0 ? round((storageMw / (mwBySource.solar ?? 1)) * 100, 0) : null,
    nearest_load_center: nearestLoadCenter,
    plants: plants.slice(0, 6),
    risk: { score, level: levelFor(score), factors },
    ideas,
  };

  return { ...result, report: scanReport(result) };
}

function scanReport(result: Omit<ScanResult, "report">): string {
  const lines: string[] = [];
  const mix = Object.entries(result.mw_by_source)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${sourceLabel(key)} ${value} MW`);

  lines.push(`# GridSentinel Area Scan — ${result.label}`);
  lines.push("");
  lines.push(`**At:** ${result.point.lat}, ${result.point.lon} · radius ${result.point.radius_mi} mi`);
  if (!result.inside_coverage) {
    lines.push("**Coverage:** outside the 100 mi data footprint — layers may be incomplete here");
  }
  lines.push(`**Risk:** ${result.risk.score}/100 (${result.risk.level})`);
  lines.push("");
  lines.push("## Generation");
  lines.push(
    `- ${result.plant_count} plants, ${result.nameplate_mw} MW nameplate (EIA-860 2025)`,
  );
  lines.push(
    `- Renewable ${result.renewable_mw} MW (${result.renewable_pct}%) · storage ${result.storage_mw} MW · fossil ${result.fossil_mw} MW`,
  );
  if (mix.length) lines.push(`- Mix: ${mix.join(", ")}`);
  lines.push("");
  if (result.evening_cover_pct !== null) {
    lines.push(
      `- Evening cover: ${result.evening_cover_pct}% — for every 100 MW of solar lost at sunset there are ${result.evening_cover_pct} MW of batteries here`,
    );
  }
  if (result.planned_retirement_mw > 0) {
    lines.push(
      `- Planned retirements: ${result.planned_retirement_mw} MW across ${result.planned_retirement_plants} plant${result.planned_retirement_plants === 1 ? "" : "s"} (EIA-860)`,
    );
  }
  lines.push("");
  lines.push("## Grid");
  lines.push(
    `- ${result.line_miles} mi of transmission (200 kV+ ${result.hv_line_miles} mi) (OSM)`,
  );
  lines.push(
    `- ${result.substation_count} substations, ${result.hv_substation_count} at 200 kV+ (OSM)`,
  );
  if (result.nearest_load_center) {
    lines.push(
      `- Nearest load center: ${result.nearest_load_center.name} at ${result.nearest_load_center.distance_mi} mi, ${result.nearest_load_center.draw_mw} MW live draw`,
    );
  }
  lines.push("");
  if (result.wire) {
    const wire = result.wire;
    lines.push("## The wire that breathes (MODELED, IEEE 738 screening)");
    lines.push(
      `- ${wire.conductor} at ${wire.voltage_kv} kV · still air vs the 2024 wind at ${wire.site}`,
    );
    if (wire.now) {
      lines.push(
        `- This hour (${hourLabel(wire.now.time)}): still air ${wire.now.still_a} A, with this wind ${wire.now.breeze_a} A → ${wire.now.ratio.toFixed(2)}× static`,
      );
    }
    lines.push(
      `- 2024: above the still-air rating in ${wire.pct_hours_above_still_air}% of ${wire.hours} hours, median ${wire.median_ratio.toFixed(2)}×`,
    );
    if (wire.hottest) {
      lines.push(
        `- Hottest hour ${hourLabel(wire.hottest.time)}: ${wire.hottest.temp_c} °C, ${wire.hottest.ratio.toFixed(2)}× static`,
      );
    }
    lines.push(
      `- 105 °F: fixed rating ${wire.heatwave.derate_pct}% lower, a 3 m/s breeze returns ${wire.heatwave.ratio.toFixed(2)}×`,
    );
    lines.push("");
  }
  lines.push("## Risk factors");
  for (const factor of result.risk.factors) {
    lines.push(
      `- ${factor.label}: ${factor.score}/100 (weight ${Math.round(factor.weight * 100)}%) — ${factor.detail}`,
    );
  }
  lines.push("");
  lines.push("## What to fix first");
  for (const idea of result.ideas) lines.push(`- ${idea}`);
  lines.push("");
  lines.push("---");
  lines.push(
    "Screening estimates. Sources: EIA-860 2025 (plants); OpenStreetMap contributors, ODbL (lines, substations).",
  );
  return lines.join("\n");
}
