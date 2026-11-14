export * from "./types";
export { CENTER, COVERAGE_MI, haversineMi, kvBand, lineWeight } from "./geo";
export { FUEL_COLORS, FUEL_LABELS, RISK_COLORS } from "./colors";
export { loadGridData, loadDailyRatings } from "./data";
export { rateLine, fetchWeatherNow, heatwaveWeather } from "./rating";
export { scanArea } from "./scan";
export { scanReportMarkdown } from "./report";

export const QUICK_SPOTS: { name: string; lat: number; lon: number }[] = [
  { name: "Westminster HS", lat: 33.7538, lon: -118.0111 },
  { name: "Downtown LA", lat: 34.059753, lon: -118.2375 },
  { name: "Irvine", lat: 33.70826, lon: -117.8385 },
  { name: "San Onofre", lat: 33.427063, lon: -117.589615 },
  { name: "Riverside", lat: 33.989452, lon: -117.415726 },
  { name: "San Gorgonio Pass", lat: 33.919155, lon: -116.59601 },
  { name: "Santa Ana Canyon", lat: 33.848858, lon: -117.79576 },
];
