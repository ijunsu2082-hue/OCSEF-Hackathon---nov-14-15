import type { Line, Plant, Substation } from "./types";
export type ReportTarget =
  | { kind: "plant"; plant: Plant }
  | { kind: "substation"; substation: Substation }
  | { kind: "line"; line: Line }
  | { kind: "area" };
export type PanelTab = "area" | "optimization" | "upgrade" | "news" | "report";
export interface NewsPin { lat: number; lon: number; nonce: number }
