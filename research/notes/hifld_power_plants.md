# hifld_power_plants

The HIFLD "Power Plants" point layer, limited to a 100-mile radius around Westminster High School
(33.7538, -118.0111). The same script also builds `hifld_substations`. The availability research,
query parameters, region filter and null handling apply to both layers and are written up once in
`notes/hifld_substations.md`. This note holds the plant-specific parts.

- Script: `research/scripts/fetch_hifld_points.py`. Pass `--refresh` to re-download both layers.
- Outputs:
  - `research/clean/hifld_power_plants.csv`
  - `research/layers/hifld_power_plants.geojson`
  - `research/schemas/hifld_power_plants.schema.json`
- Raw cache: `research/raw/hifld_points/power_plants_*`, plus the shared `SOURCE.json`. It records
  the URLs, query parameters, retrieval date (2026-11-14) and the sha256 of every raw file.
- Counts: 852 features in the bbox, 48 more than 100 mi away, **804 kept**.

## Source

ArcGIS Online item `6e0bdfea762046988469da10407f844f` ("Plants_gdb__8907007659940948974", created
2024-11-19 in a UCLA org):
`https://services7.arcgis.com/2hYXmwteFLemN5bW/arcgis/rest/services/Plants_gdb__8907007659940948974/FeatureServer/0`

- 13,233 features, with FID running contiguously from 1 to 13,233. That is the same count as the
  official layer in the 2025-02-02 Internet Archive capture, and the fields are the same 43 HIFLD
  fields.
- The latest SOURCEDATE nationally is 2022-06-02 and the latest VAL_DATE is 2022-07-18. Records
  inside the radius have SOURCEDATE from 2012-11-30 to 2019-05-06. Most cite EIA-860 2017 or
  EIA-923 2018.
- **Vintage:** the final HIFLD Open Power Plants release. Its capacity and generation figures are
  several years older than the project's EIA-860 2025 data.
- DHS did not publish this copy. It is a verbatim re-host of a public-domain HIFLD release and
  could be deleted at any time. See "Raw cache safety" in `notes/hifld_substations.md`.

## Field decisions

Primary key: `hifld_id`.

- **PLANT_CODE cannot be the primary key.** HIFLD carries duplicate records for some plants. In
  the radius, 18 EIA codes appear twice: 303, 56976, 57231, 57708, 58202, 58388, 58626, 58627,
  58750–58757, 59169 and 59431. Examples are "RODEO D2" and "RODEO SOLAR D2", or the two
  "OTAY MESA GENERATING PROJECT" records.
- `hifld_id` is therefore the layer's object ID (FID). It runs 1–13,233 in the source's
  PLANT_CODE order, which matches the official record count. Both records of each duplicate pair
  are kept, so this file mirrors HIFLD as published.
- `eia_plant_code` is PLANT_CODE when it is all digits. It is null for 152 records whose code is
  an HIFLD-assigned ID such as `NA02715`. Most of these are school sites and small solar sites
  sourced from the Solar Foundation or the CEC.
- `eia_plant_code` is the join key to `eia860_plants.plant_code`. It is not unique, so dedupe
  before any 1:1 join. Of the 652 records with an EIA code, 572 match a row in
  `research/clean/eia860_plants.csv`.
- `name` is null for 2 records, `hifld_id` 12035 and 12305, whose source NAME is the placeholder
  `UNKNOWN`. Other placeholders follow the shared null rules.
- Column sources:
  - `total_mw` is OPER_CAP (operating capacity, MW).
  - `net_gen_mwh` is NET_GEN (annual net generation, MWh). It can legitimately be negative for
    storage. Only `-999999` is treated as null.
  - `plant_type` is TYPE. Multiple technologies are joined with `; `.
  - `primary_fuel` is PRIM_FUEL (EIA energy source code).
  - `status` is STATUS (EIA status code; the schema lists the codes).
- `total_mw` is `0` for 52 records: 24 with status OP, and the rest planned, cancelled or
  otherwise not operating. Most are solar (29) or storage (9). They are kept as reported, not
  nulled.
- Columns dropped from the source: address, phone, website, OPERAT_ID, summer, winter, planned and
  retired capacity, unit counts, fuel use, CAP_FACTOR, SUB_1, SUB_2, LINES and SOURCE_LAT/LON.
  They are all still in the raw cache.

## Known caveats

- **Data is stale.** The plant attributes come mostly from EIA-860 2017 and EIA-923 2018. Use
  `eia860_plants` for current capacity. Use this layer for HIFLD's IDs, locations and cross-checks.
- **Source data errors are kept as-is.** `hifld_id` 11835, Pearblossom Solar, has state `MN` and
  city `HASTINGS`, but its coordinates and county are in Los Angeles County, CA.
- **Plant data has gaps.** `operator` is null for 278 records, `status` for 78, `net_gen_mwh` for
  321 and `name` for 2.
- **Coverage is not complete.** The layer includes very small non-EIA solar sites but misses some
  EIA plants: 313 `eia860_plants` codes have no HIFLD record in the radius. Of those, 207 first
  operated in 2018 or later and 82 have no operating generator yet.
- **The source is a third-party re-host.** Its provenance was checked against HIFLD's item
  metadata, its field schema and the archived official record count. It was not compared record
  by record with an official download, because none is publicly available.
