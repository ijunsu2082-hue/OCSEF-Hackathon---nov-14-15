import type { FuelKey, RiskLevel } from "./types";

export const FUEL_COLORS: Record<FuelKey, string> = {
  solar: "#f2c94c", battery: "#b18cff", natural_gas: "#d9825b", wind: "#7dd3fc", hydro: "#3b82f6",
  biogas: "#84cc16", oil: "#a16207", other_gas: "#c08457", waste_heat: "#e879f9", other: "#94a3b8",
};

export const FUEL_LABELS: Record<FuelKey, string> = {
  solar: "Solar", battery: "Battery storage", natural_gas: "Natural gas", wind: "Wind", hydro: "Hydro",
  biogas: "Biogas / waste", oil: "Oil", other_gas: "Other gas", waste_heat: "Waste heat", other: "Other",
};

export const RISK_COLORS: Record<RiskLevel, string> = {
  LOW: "var(--ok)", WATCH: "var(--warn)", HIGH: "var(--high)", CRITICAL: "var(--critical)",
};

export const FUEL_KEYS: FuelKey[] = [
  "solar", "battery", "natural_gas", "wind", "hydro", "biogas", "oil", "other_gas", "waste_heat", "other",
];
