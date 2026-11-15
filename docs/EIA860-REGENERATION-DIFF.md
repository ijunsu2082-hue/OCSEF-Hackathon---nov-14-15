# EIA-860 regeneration of `public/layers/plants.geojson`

`public/layers/plants.geojson` (697 Point features, metadata "EIA-860 2025 annual",
center 33.7538,-118.0111, radius 100 mi) was produced offline by a script that is
not in the repo. This document records how it was regenerated from the pinned EIA
workbooks and how the result differs from the committed file.

Code: `research/etl/xlsx.ts` (dependency-free XLSX reader), `research/etl/eia860.ts`
(import, regen, diff, join, EIA-860M comparison; entry point `runEia860Command(args)`,
not yet wired into `cli.ts`). Outputs go under `research/etl-state/eia860/`, which is
git-ignored. `public/layers` is never written.

## Pinned inputs

| Input | URL | Bytes | Last-Modified | ETag | sha256 |
|---|---|---|---|---|---|
| EIA-860 2025 annual archive | https://www.eia.gov/electricity/data/eia860/xls/eia8602025.zip | 23,622,347 | Thu, 10 Sep 2026 16:20:14 GMT | `"0337a424041dd1:0"` | `2b27929d26cc1da9ad6a530da1cac6718cd8496098ee560c4d47cfffd96d08ba` |
| EIA-860M, period **September 2026** (released 2026-10-23) | https://www.eia.gov/electricity/data/eia860m/xls/september_generator2026.xlsx | 14,013,970 | Fri, 23 Oct 2026 15:32:18 GMT | `"0ad2b0363dd1:0"` | `bcef74e1af991680731aeecfda967f5950db4ce739bb584edd8b8774c7e6da17` |

Manifests: `research/etl-state/eia860/manifest.json` and `manifest-860m.json`.
Workbooks read from the archive: `2___Plant_Y2025.xlsx` (sheet `Plant`) and
`3_1_Generator_Y2025.xlsx` (sheets `Operable`, `Proposed`, `Retired and Canceled`).

How the EIA-860M period was chosen: the 860M page links `december_generator2026.xlsx`,
`archive/xls/november_generator2026.xlsx` and `october_generator2026.xlsx`. All three
answer 301 to `https://www.eia.gov/cneaf/electricity/` (a landing page, not a
workbook). The page says "Release Date: October 23, 2026; Next Release Date: November 24,
2026". `september_generator2026.xlsx` answers 200 with an XLSX content type. Its sheet
titles say "as of September 2026", and the importer checks that title against the
manifest's `period`.

EIA-923 was **not imported** (it was optional).

## Import

- Headers are found by name. The header row is the first row (within 10) that has every
  required column name. The title rows above it must contain "2025 Form EIA-860", which
  pins the reporting year. Every record carries `reporting_year: 2025`.
- Every normalized plant and generator field cites `{workbook, workbook_sha256, sheet, cell}`.
- A footnote row (no Plant Code, a single text cell) is skipped and recorded. Any other
  row without a key is an error. One footnote was skipped on each of the three generator
  sheets. None was skipped on the Plant sheet.
- Counts: 17,349 plants; 27,918 Operable, 2,850 Proposed and 5,805 Retired and Canceled
  generators. No generator key appears on two sheets.
- How retirement status is kept apart:
  - **planned**: an Operable-sheet generator with a non-blank "Planned Retirement Year".
    There are 573 nationally and 23 at the regenerated plants.
  - **completed**: a Retired-sheet generator with status `RE` and its "Retirement
    Year/Month". There are 4,787 nationally and 308 at plants inside the radius.
  - `CN` (canceled) and `IP` (indefinitely postponed) rows on the Retired sheet are not
    retirements: 111 and 2 inside the radius. The importer rejects a CN or IP row that
    has a Retirement Year, and an RE row that lacks one.
  - The status code sets match Tables 4 and 6 of the published `LayoutY2025.xlsx`. A test
    asserts this against the real workbook.

## Inferred aggregation rules

All of these are reproduced by `regeneratePlants` and listed in the output metadata:

- **Membership:** a Plant-sheet plant is included if it has coordinates, lies
  ≤ 100 mi from the center by `greatCircleMiles`, and has at least one Operable-sheet
  generator. 869 plants lie inside the radius; 697 of them have Operable generators.
- **Plant-sheet fields copied as stored:** coordinates are `[Longitude, Latitude]`.
  `balancing_authority` comes from "Balancing Authority Code", `sector` from "Sector
  Name", and `grid_voltage_kv` from "Grid Voltage (kV)".
- **`nameplate_mw`:** the sum of Operable Nameplate Capacity (MW).
- **`mw_by_source`:** the same sum, grouped by Energy Source 1:
  - NG→natural_gas, WAT→hydro, SUN→solar, MWH→battery, WND→wind
  - OG→other_gas, LFG→biogas, OBG→biogas, WH→waste_heat, DFO→oil
  - PG→other, OTH→other
  - A code not in this table is an error.
- **`primary_source`:** the `mw_by_source` key with the most MW.
- **`planned_retirement_mw`:** the sum of Operable MW where a Planned Retirement Year is set.
- **`generator_count`:** the number of Operable generators.
- **`oldest_year` / `newest_year`:** the minimum and maximum Operating Year.
- **`technologies`:** the distinct Technology values, sorted.
- **`capacity_weighted_year`:** `round(Σ MW·year / Σ MW)`. `capacity_weighted_age_years`
  is 2025 minus that year.
- **Rounding:** half-to-even on the exact double, the same as Python's `round()`, to 0.1
  for MW and miles and to 0 for years. Plain half-up `Math.round` would change 2
  plants: 6196 (1982.5) and 61834 (2016.5).
- **Order:** unrounded total MW descending, then plant_code ascending. Sorting on the
  rounded MW instead puts 26 positions out of order where several plants tie at 1.9
  or 1.1 MW.

## Diff against the committed file (by plant_code)

Full detail: `research/etl-state/eia860/regen/diff.json`. Output layer:
`research/etl-state/eia860/regen/plants.geojson`.

| Class | Count |
|---|---|
| committed features / regenerated features | 697 / 697 |
| added (regenerated only) | 0 |
| removed (committed only) | 0 |
| matched | 697 |
| identical in every property and in geometry | 695 |
| feature order identical | yes |
| field changes | 2, both `distance_mi` |

The two field changes are a **rule mismatch, not a data difference**:

| plant_code | committed | regenerated | Evidence |
|---|---|---|---|
| 484 | 53.5 | 53.4 | haversine with R = 3958.8 mi gives 53.45013 (rounds to 53.5); `greatCircleMiles` (R = 6,371,008.8 m) gives 53.44961 |
| 64751 | 59.6 | 59.5 | haversine with R = 3958.8 mi gives 59.55031; `greatCircleMiles` gives 59.54972 |

The committed script used a 3958.8-mile Earth radius. The spec requires
`greatCircleMiles` (mean radius), so the regeneration keeps that, and the diff labels
both rows `rule_mismatch:earth_radius` after recomputing with the other radius. No
Plant-sheet plant changes membership between the two radii (checked across all 17,349
plants: 0 flips), and membership matched 697/697.

`PG → other` rests on a single plant in the radius. `PG → oil` breaks `mw_by_source`
for that plant.

## EIA-860M (September 2026) against the 2025 annual

Output: `research/etl-state/eia860/m860/status-comparison.json`. This covers the 1,129
annual Operable generators at the 697 regenerated plants:

- 1,128 are still on the 860M `Operating` sheet. None of them changed its planned
  retirement year or month: the same 23 planned retirements, e.g. 315:3–5 in 2026-12,
  350:1–2 in 2027-01 and 404:1–2 in 2029-12.
- 0 have moved to the 860M `Retired` sheet.
- 1 is absent from both 860M sheets: `66466:43580` (Blue Skies Solar, 1.0 MW). The
  cause was not verified.

## Join to loaded assets (eia-atlas-plants)

Input: `research/etl-state/hifld-live/loaded-assets/location-1259cfaed6171d36767e6fe3/<latest revision>.json`,
dataset `eia-atlas-plants` (566 features). The join is on `properties.plant_code`, which
is cited to the ArcGIS field `Plant_Code`. Output:
`research/etl-state/eia860/join/eia-atlas-plants.json`.

| Result | Count |
|---|---|
| atlas features | 566 |
| matched to a regenerated plant | 497 |
| on the 2025 Plant sheet, but with no Operable generators (so not regenerated) | 41 |
| not on the 2025 Plant sheet at all | 28 (e.g. 356 AES Redondo Beach, 10439–10443 SEGS III–VII) |
| atlas features without a plant_code | 0 |
| regenerated plants not in the atlas | 200 (10,222.8 MW; largest 64210 Bellefield, 1000 MW) |
| name equal / different (atlas name vs Plant Name, where the code is on the Plant sheet) | 510 / 28 |
| matched points more than 0.01 mi apart | 2 (52162 "85 A" at 0.792 mi, 52163 "85 B" at 0.283 mi) |

The 69 atlas plants that did not match are consistent with the atlas layer being an
older vintage than EIA-860 2025: plants that retired or are no longer reported. The
200 regenerated plants missing from the atlas are consistent with newer plants.
Neither explanation was verified against the atlas's own vintage metadata.

## Reproducing

```
node node_modules/tsx/dist/cli.mjs -e 'import("./research/etl/eia860.ts").then(m=>m.runEia860Command(process.argv.slice(1)))' \
  regen --m860 research/etl-state/eia860/raw-860m/september_generator2026.xlsx \
        --m860-manifest research/etl-state/eia860/manifest-860m.json
```

The command checks the archive sha256 against the manifest before reading it. One run
took about 8.0 s wall time (import about 4.9 s) with about 1.07 GB peak RSS.
