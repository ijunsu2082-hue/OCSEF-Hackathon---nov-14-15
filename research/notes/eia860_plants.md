# eia860_plants (and its layer, eia860_plants_layer): EIA Form 860 plants, 100 mi around Westminster, CA

This note covers `eia860_plants` (CSV) and `eia860_plants_layer` (the GeoJSON twin). The generator-level
dataset has its own note, `notes/eia860_generators.md`; both come from the same download and script.

Script: `research/scripts/fetch_eia860.py` (no arguments; `--refresh` re-downloads the zip).

## Source and vintage
- U.S. EIA Form EIA-860 annual file: https://www.eia.gov/electricity/data/eia860/xls/eia8602025.zip
- Vintage: **2025 final data, released 2026-09-10**. This was the newest final release on 2026-11-14.
  The landing page also listed `eia8602025ER.zip` (the 2025 early release, now replaced by the final data). It was not used.
  The 2026 early release is due in June 2027.
- Retrieved 2026-11-14. The sha256 is in `research/raw/eia860/SOURCE.json`.
- Files used: `2___Plant_Y2025.xlsx` (sheet `Plant`) and `3_1_Generator_Y2025.xlsx` (sheets `Operable`, `Proposed`, `Retired and Canceled`).
  The wind, solar and storage detail files (3_2, 3_3, 3_4) were not needed for the requested columns.
  A good next step is to add storage MWh from 3_4.

## Parsing
- Row 1 of each sheet is a title such as "2025 Form EIA-860 Data - Schedule ...". The script checks that this row names the report year.
  Row 2 is the header, so the files are read with `skiprows=1`.
- Footnote rows are dropped: any row whose `Plant Code` is not numeric. Each generator sheet has one "NOTE: ..." row at the bottom. The plant sheet has none.
- The EIA blanks `" "`, `"."` and `""` become null. Strings have their whitespace trimmed and collapsed.
  EIA had trailing spaces in some names (for example 61661 and 61718); those spaces are removed.
- ZIP codes are strings, zero-padded to 5 digits.
- `street_address` and `city`: the placeholders `N/A`, `NA`, `TBD` and `TBA` (case-insensitive, whole value)
  become null. In 2025 that nulls 31 street addresses (29 `TBD`, 1 `TBA`, 1 `N/A`), mostly proposed sites; no
  city was affected.

## Region filter
- The script computes the haversine distance (R = 3958.8 mi) from (33.7538, -118.0111) to each plant's Schedule 2 lat/lon. Plants with distance <= 100.0 mi are kept.
- 28 plants nationwide have missing or zero coordinates and are dropped. None of them are in CA, so none were lost from the region.
- 1 plant is dropped for a mismatched state: **64670 Big Creek Solar LLC**. EIA lists it as Lee County, AR, but its coordinates (34.870, -117.966) are in the Mojave.
  This is a geocoding error in EIA's data. It is a proposed-only plant of 400 MW, so keeping it would have inflated proposed MW.
  Rule: plants inside the circle must report state CA, because the circle holds no other US state.
- Generators take their latitude, longitude and distance_mi from their plant (see `eia860_generators.md`).

## Datasets
| file | PK | rows |
|---|---|---|
| `clean/eia860_plants.csv` | plant_code | 868 (697 with operable units, 76 proposed-only, 95 with no operable or proposed units) |
| `clean/eia860_generators.csv` | (plant_code, generator_id) | 1549 (operable 1129, proposed 112, retired 308) |
| `layers/eia860_plants.geojson` | plant_code | 697 Point features |

- The plants CSV has every Schedule 2 plant in the region. Plants with no operable generators have nameplate_mw = 0 and a null primary_source.
  Some of those are proposed-only. Others are retired, or listed in Schedule 2 with no generator rows (30 plants).
- The geojson has only plants with at least one operable generator, because the app's `PlantProperties.primary_source` cannot be null.
- Generator rows, `status_group` and the dropped CN/IP units are described in `eia860_generators.md`.

## Field decisions
- `source_category` (generator level, mapped from `energy_source_1`) is defined in `eia860_generators.md`. Plant
  aggregates and `primary_source` are built from it.
- Plant aggregates use operable generators only:
  - nameplate_mw, summer and winter MW (blank counts as 0; one operable unit has a blank summer capacity)
  - mw_by_source, technologies, oldest and newest operating year
  - `planned_retirement_mw`: nameplate MW of operable units that report a Planned Retirement Year
  - `primary_source`: the category with the most MW. On a tie, a generating source beats battery, then alphabetical order decides.
    This affects equal solar and battery plants such as 64210, 66532 and 66533, which come out as solar.
  - `capacity_weighted_age_years` = 2025 − (nameplate-weighted mean operating year), rounded to 1 decimal. `capacity_weighted_year` is that mean year, rounded half up.
- MW sums are rounded to 3 decimals. Integral values are written without ".0".
- The CSV writes `technologies` as one pipe-joined string. The geojson writes it as a JSON array.
- Geojson properties are a strict superset of `PlantProperties` in `lib/gridLayers.ts`, and also of every property in the current `public/layers/plants.geojson`.
  The extra properties are `state`, `utility_id`, `summer_capacity_mw`, `winter_capacity_mw` and `proposed_mw`.
  `balancing_authority` is the BA code and `sector` is the EIA sector name.
- Schema files:
  - `schemas/eia860_plants.schema.json` describes the CSV.
  - The geojson has different properties from the CSV (mw_by_source, renamed aliases), so it has its own schema: `schemas/eia860_plants_layer.schema.json`.

## Comparison with `public/layers/plants.geojson` (697 plants, also EIA-860 2025)
- **Delta: 0 new and 0 removed plant codes.** The 697 plant codes are identical.
- All plant locations match.
- Differences in values:
  - `capacity_weighted_age_years` now has 1 decimal; the old file had an integer. This changes the value for 65 plants. `capacity_weighted_year` is off by one at 2 plants (rounding at x.5).
  - `primary_source` matches the old file for all 697 plants. This includes the exact solar/battery ties, because of the tie-break rule above.
  - 6704 Pebbly Beach: its 2.3 MW propane unit is now `other_gas`; the old file had `other`.
  - Trailing whitespace is gone from 2 plant names and 2 utility names.

## Totals in the region
- Operable: 39,483 MW. By source:
  - natural_gas 18,610
  - solar 7,134
  - battery 6,859
  - wind 4,003
  - hydro 2,374
  - biogas 288
  - other_gas 101
  - waste_heat 64
  - oil 50
  - other 1
- Proposed: 6,775 MW, mostly battery and solar.
- Planned retirements: 3,291 MW.

## Caveats
- Plant coordinates are self-reported to EIA, and some are rough (proposed sites often have no street address,
  which is why 31 `street_address` values are null placeholders).
- The Retired sheet lists only retirements reported in the current data cycle; it is not a complete retirement history. For that, use EIA-860M.
- Proposed units carry EIA status codes from P (planned, no regulatory approvals) to TS/V (under construction or nearly complete). Many early-stage P/L units never get built.
- Ownership splits (`4___Owner`) are not applied. MW is the full plant capacity, attributed to the operator.
- `research/raw/` is not git-ignored at the repo level, so make sure not to commit the 23.6 MB zip.
