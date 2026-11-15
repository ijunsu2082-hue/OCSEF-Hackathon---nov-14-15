# eia860_generators: EIA Form 860 generators, 100 mi around Westminster, CA

Same download, script and region filter as `eia860_plants`; read `notes/eia860_plants.md` for the
source, vintage, parsing rules, region filter and the plant-level caveats. This note holds only the
generator-specific decisions.

- Script: `research/scripts/fetch_eia860.py` (no arguments; `--refresh` re-downloads the zip).
- Source: EIA-860 2025 final, `3_1_Generator_Y2025.xlsx`, sheets `Operable`, `Proposed` and
  `Retired and Canceled`. Retrieved 2026-11-14; sha256 in `research/raw/eia860/SOURCE.json`.
- Output: `clean/eia860_generators.csv`, primary key (`plant_code`, `generator_id`), **1549 rows**
  (operable 1129, proposed 112, retired 308). No GeoJSON layer.

## Rows and keys
- Generator IDs are always strings (EIA mixes `1`, `GT1`, `BAT1`, ...). Rows sort by plant_code, then
  generator_id as a string.
- Every `plant_code` exists in `clean/eia860_plants.csv` (enforced by the validator).
- No generator key appears in more than one sheet.
- Generators take their latitude, longitude and distance_mi from their plant (Schedule 2), so a
  generator is in the region exactly when its plant is.

## status_group
- `status_group` shows which sheet a generator came from:
  - operable: OP, SB, OS, OA
  - proposed: P, L, T, U, V, TS
  - retired: RE
- The "Retired and Canceled" sheet also has CN (canceled) and IP (indefinitely postponed or no
  longer planned) units. These 113 units are **dropped** because they never operated.
- For proposed units, `operating_year` and `operating_month` hold EIA's "Current Year/Month", which
  is the expected in-service date.
- `retirement_year` is filled only for retired units. `planned_retirement_year`/`month` are EIA's
  planned dates for operable units.

## source_category
- `source_category` comes from `energy_source_1`:
  - NG → natural_gas, SUN → solar, MWH → battery, WND → wind, WAT → hydro (this includes pumped storage)
  - LFG and OBG → biogas
  - OG, BFG, PG, SGP and H2 → other_gas (PG is propane, which EIA counts as "other gases")
  - WH and PUR → waste_heat
  - petroleum codes → oil
  - NUC → nuclear, GEO → geothermal
  - coal codes → coal
  - solid and liquid biomass and MSW → biomass
  - MSN, TDF and OTH → other
  - Any unmapped code is logged and treated as other. There were none in 2025.

## Caveats
- The Retired sheet lists only retirements reported in the current data cycle; it is not a complete
  retirement history. For that, use EIA-860M.
- Proposed units carry EIA status codes from P (planned, no regulatory approvals) to TS/V (under
  construction or nearly complete). Many early-stage P/L units never get built.
- Summer and winter capacity are blank in EIA for 4 units (operable 6645/2; retired 7942/1, 7942/5,
  7942/9). They stay null here; plant sums count them as 0.
- Ownership splits (`4___Owner`) are not applied.
