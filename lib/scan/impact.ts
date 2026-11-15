/*
 * Why line capacity matters: California curtailment (wind and solar thrown
 * away) and how much of it CAISO attributes to local transmission congestion.
 * Every constant here was read from the linked file; see the "impact" entries
 * in lib/scan/sources.ts. Statewide numbers only: CAISO does not publish
 * which line caused each curtailment in a simple public form.
 */

import type { LineRatingNow, ScanResult } from "./types";

export interface ImpactFact {
  value: number;
  unit: string;
  year: number;
  url: string;
  note: string;
}

const CAISO_CURTAILMENT_XLSX =
  "https://www.caiso.com/documents/production-and-curtailments-data-june-december-2025.xlsx";
const EGRID_2023_PDF = "https://www.epa.gov/system/files/documents/2025-06/summary_tables_rev2.pdf";
const EIA_TABLE_5A_PDF = "https://www.eia.gov/electricity/sales_revenue_price/pdf/table_5A.pdf";

/** Metric tonnes per pound. */
const T_PER_LB = 0.45359237 / 1000;

/** CAISO wind + solar curtailment, calendar 2025 (sum of 5-minute MW / 12). */
export const CURTAILED_TOTAL_2025: ImpactFact = {
  value: 3_765_628,
  unit: "MWh",
  year: 2025,
  url: CAISO_CURTAILMENT_XLSX,
  note: "All wind and solar curtailment in the CAISO area, Jan 1 to Dec 31, 2025.",
};

/** Part of it CAISO labels "Local": dispatched down to relieve local transmission congestion. */
export const CURTAILED_LOCAL_2025: ImpactFact = {
  value: 3_143_397,
  unit: "MWh",
  year: 2025,
  url: CAISO_CURTAILMENT_XLSX,
  note: "Reason = Local (local congestion). The rest (622,231 MWh) is System: too much power grid-wide.",
};

/** Part CAISO labels "System": system-wide oversupply. */
export const CURTAILED_SYSTEM_2025: ImpactFact = {
  value: 622_231,
  unit: "MWh",
  year: 2025,
  url: CAISO_CURTAILMENT_XLSX,
  note: "Reason = System (system-wide oversupply).",
};

/** Same method on the 2024 file; matches CAISO's Dec 31, 2024 daily report exactly. */
export const CURTAILED_TOTAL_2024: ImpactFact = {
  value: 3_423_377,
  unit: "MWh",
  year: 2024,
  url: "https://www.caiso.com/documents/wind-solar-real-time-dispatch-curtailment-report-dec-31-2024.pdf",
  note: "2024 total; 92.1% of it was Local.",
};

/** EPA eGRID2023 CAMX total output CO2 rate (average of all California power). */
export const CAMX_CO2_AVG: ImpactFact = {
  value: 428.5,
  unit: "lb CO2/MWh",
  year: 2023,
  url: EGRID_2023_PDF,
  note: "eGRID2023 rev2, CAMX total output emission rate. Low end: average mix, including clean power.",
};

/** EPA eGRID2023 CAMX non-baseload CO2 rate (plants that ramp up and down, mostly gas). */
export const CAMX_CO2_NONBASELOAD: ImpactFact = {
  value: 958.3,
  unit: "lb CO2/MWh",
  year: 2023,
  url: EGRID_2023_PDF,
  note: "eGRID2023 rev2, CAMX non-baseload output emission rate. High end: as if every MWh replaced flexible (mostly gas) power.",
};

/** EIA average monthly residential use in California, 2024. */
export const CA_HOME_KWH_PER_MONTH: ImpactFact = {
  value: 503,
  unit: "kWh/month",
  year: 2024,
  url: EIA_TABLE_5A_PDF,
  note: "EIA 2024 average monthly bill, residential, California (14,217,180 customers).",
};

/** Share of curtailment caused by local congestion, 0..100. */
export function localSharePct(
  local: ImpactFact = CURTAILED_LOCAL_2025,
  total: ImpactFact = CURTAILED_TOTAL_2025,
): number {
  return total.value > 0 ? (local.value / total.value) * 100 : 0;
}

/**
 * CO2 range in metric tonnes if every curtailed MWh in `mwh` had displaced
 * average (low) or non-baseload, mostly gas (high) California generation.
 * True avoided emissions are likely lower: not every curtailed MWh could have
 * reached a customer or displaced gas.
 */
export function co2RangeTonnes(mwh: number): { low: number; high: number } {
  if (!Number.isFinite(mwh) || mwh <= 0) return { low: 0, high: 0 };
  return {
    low: mwh * CAMX_CO2_AVG.value * T_PER_LB,
    high: mwh * CAMX_CO2_NONBASELOAD.value * T_PER_LB,
  };
}

/** How many average California homes `mwh` would power for a full year. */
export function homesForYear(mwh: number): number {
  const perHomeMwh = (CA_HOME_KWH_PER_MONTH.value * 12) / 1000;
  if (!Number.isFinite(mwh) || mwh <= 0) return 0;
  return mwh / perHomeMwh;
}

/** Miles of 200 kV and up lines inside the scan circle (the big lines that move bulk power). */
export function bulkLineMiles(result: ScanResult): number {
  const kv = result.totals?.line_miles_by_kv;
  if (!kv) return 0;
  const m = (kv["500+"] ?? 0) + (kv["200-499"] ?? 0);
  return Number.isFinite(m) ? m : 0;
}

/**
 * Temperature-only rating vs the fixed rating right now (ambient-adjusted
 * rating / static rating). Null when live data is missing or invalid.
 */
export function temperatureRatio(live: LineRatingNow | null): number | null {
  if (!live) return null;
  const { aar_A, static_A } = live;
  if (!Number.isFinite(aar_A) || !Number.isFinite(static_A) || static_A <= 0) return null;
  return aar_A / static_A;
}
