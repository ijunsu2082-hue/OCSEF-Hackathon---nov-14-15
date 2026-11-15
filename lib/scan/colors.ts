import type { FuelKey, RiskLevel } from "./types";

export type EnergyCategory = "renewable" | "storage" | "fossil" | "other";

export const FUEL_CATEGORY: Record<FuelKey, EnergyCategory> = {
  solar: "renewable", wind: "renewable", hydro: "renewable", biogas: "renewable",
  battery: "storage",
  natural_gas: "fossil", oil: "fossil", other_gas: "fossil",
  waste_heat: "other", other: "other",
};

export const CATEGORY_COLORS: Record<EnergyCategory, string> = {
  renewable: "#0ea5e9", storage: "#7dd3fc", fossil: "#94a3b8", other: "#cbd5e1",
};

export const CATEGORY_LABELS: Record<EnergyCategory, string> = {
  renewable: "Renewable", storage: "Storage", fossil: "Fossil", other: "Other",
};

export const CATEGORY_KEYS: EnergyCategory[] = ["renewable", "storage", "fossil", "other"];

export const FUEL_KEYS: FuelKey[] = [
  "solar", "battery", "natural_gas", "wind", "hydro", "biogas", "oil", "other_gas", "waste_heat", "other",
];

/** Kept for compatibility: every fuel is colored by its energy category. */
export const FUEL_COLORS: Record<FuelKey, string> = Object.fromEntries(
  FUEL_KEYS.map((k) => [k, CATEGORY_COLORS[FUEL_CATEGORY[k]]]),
) as Record<FuelKey, string>;

export const FUEL_LABELS: Record<FuelKey, string> = {
  solar: "Solar", battery: "Battery storage", natural_gas: "Natural gas", wind: "Wind", hydro: "Hydro",
  biogas: "Biogas / waste", oil: "Oil", other_gas: "Other gas", waste_heat: "Waste heat", other: "Other",
};

export const RISK_COLORS: Record<RiskLevel, string> = {
  LOW: "#556070", WATCH: "#d97706", HIGH: "#dc2626", CRITICAL: "#dc2626",
};

export const UI = {
  accent: "#0ea5e9", accentStrong: "#0284c7", accentSoft: "#e0f2fe",
  text: "#1d2733", text2: "#556070", text3: "#6b7583",
  border: "#e6e9ee", subtle: "#f6f8fa", danger: "#dc2626", warning: "#d97706",
} as const;
