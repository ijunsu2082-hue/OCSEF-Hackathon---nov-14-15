/**
 * Niche-case contract — README §4.7.
 *
 * A niche case is a pinned, real, local story: a specific place, the hidden
 * problem there, the fix, and the numbers behind both. Every number carries a
 * MEASURED or MODELED tag and its source; there is no untagged figure.
 */

export type NicheCategory =
  | "Transmission"
  | "Generation"
  | "Storage"
  | "Load"
  | "Water-Energy"
  | "Gas"
  | "Wildfire"
  | "Heat"
  | "Distributed";

export type TeamBullet =
  | "output_draw"
  | "capacity"
  | "energy_cycle"
  | "infra_age"
  | "upgrade_potential";

export interface NicheStat {
  label: string;
  value: string;
  kind: "measured" | "modeled";
  source: string;
}

export interface NicheCase {
  id: string;
  title: string;
  category: NicheCategory;
  location: { name: string; lat: number; lon: number; distance_mi: number };
  one_liner: string;
  problem: string;
  fix: string;
  shock_line: string;
  stats: NicheStat[];
  team_bullets: TeamBullet[];
  chart?: { kind: "line_rating"; data_url: string };
}

