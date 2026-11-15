# hifld_substations

The HIFLD "Electric Substations" point layer, limited to a 100-mile radius around Westminster High
School (33.7538, -118.0111). The same script also builds `hifld_power_plants`. The sections on
availability, raw cache safety, query, filtering and null handling below apply to both layers.
The plant-specific source, field decisions and caveats are in `notes/hifld_power_plants.md`.

- Script: `research/scripts/fetch_hifld_points.py`. Pass `--refresh` to re-download. With no
  arguments it reuses the raw cache, checks each cached file against its sha256 in `SOURCE.json`,
  and writes byte-identical outputs.
- Outputs:
  - `research/clean/hifld_substations.csv`
  - `research/layers/hifld_substations.geojson`
  - `research/schemas/hifld_substations.schema.json`
- Raw cache: `research/raw/hifld_points/`. It holds the `f=geojson` query pages, the layer and item
  metadata, the national feature count, and `SOURCE.json`. `SOURCE.json` records the URLs, query
  parameters, retrieval date (2026-11-14) and the sha256 of every raw file.

## What is publicly available now (researched 2026-11-14)

- **HIFLD Open is gone.** HIFLD Open used the GeoPlatform ArcGIS Online org `Hp6G80Pky0om7QvQ`.
  That org no longer serves `Plants_gdb` or `Electric_Substations`: both return "Invalid URL", and
  neither layer appears in the org's service directory or in item searches. Only
  `Electric_Power_Transmission_Lines` is still there. The `hifld-geoplatform` hub still loads but
  does not list these layers.
- **Esri Living Atlas does not carry the HIFLD versions.** The Federal User Community org
  (`FiaPA4ga0iQKduv3`) has an HIFLD transmission archive, but its "Power Plants in the U.S." layer
  is built from EIA data, not HIFLD. It has no substations layer.
- **Internet Archive** holds only service metadata and count responses for the official
  `Plants_gdb` layer, not the features. Those captures are still useful: the 2025-02-02 capture
  shows the official layer had **13,233 features**, its last edit was 2023-09-21, and its field
  list is the same as the copy used here. No capture of the official substations service was found.
- **What remains is public, unauthenticated re-hosts** of the final public HIFLD Open releases on
  ArcGIS Online. Each carries HIFLD's original item metadata, with the license
  "None (Public Use)". No login or token is used.

### Substations source

ArcGIS Online item `ef04dc8231c9491e804a008e5faa7d3a` ("Substations", created 2022-02-14). Item
`83397b209bfb4007a2f4c00e70df8e5d`, "HIFLD Substations 1_9_25", points to the same service:
`https://services6.arcgis.com/OO2s4OoyCZkYJ6oE/arcgis/rest/services/Substations/FeatureServer/0`

- 77,946 features nationally, with the full HIFLD schema (ID, NAME, …, LINES, MAX_VOLT, MIN_VOLT,
  MAX_INFER, MIN_INFER).
- The item description matches HIFLD's release note ("2,630 features added").
- The latest SOURCEDATE and VAL_DATE nationally is 2021-06-01.
- **Vintage:** the final public HIFLD release before Electric Substations moved to HIFLD Secure in
  2022. It is frozen and will not be updated.

The power plants source is another ArcGIS Online re-host; see `notes/hifld_power_plants.md`.

### Raw cache safety

DHS did not publish either re-host. Both are verbatim copies of public-domain HIFLD releases, and
they could be deleted at any time, so the local raw cache may become the only copy.

- If a service disappears, the script exits non-zero and writes no partial output.
- `--refresh` downloads both layers into a temp directory next to the cache
  (`raw/hifld_points.tmp-<pid>`). The temp directory replaces the cache only when both layers
  downloaded completely and matched the server counts. A failure on one layer therefore cannot
  drop the other layer's cached files.
- A download whose bbox count is below 90% of the previous download is refused unless
  `--allow-shrink` is passed.
- On any failure the cache and outputs are left as they were, so a rebuild without `--refresh`
  still works.

## Query and filtering

- Each layer is queried with an envelope of `-119.76,32.29,-116.26,35.21` (`inSR=4326`,
  `outSR=4326`, `f=geojson`, `outFields=*`). Results are ordered by object ID and paged 2,000
  records at a time. The number of downloaded features must equal the server's
  `returnCountOnly` count, or the script fails.
- Each point is kept if its haversine distance from the center is 100.0 miles or less (earth
  radius 3958.8 mi). Distance is calculated from the full-precision geometry, then `distance_mi`
  is rounded to 1 decimal.
- Coordinates come from the point geometry and are rounded to 6 decimals. The source
  LATITUDE/LONGITUDE attributes match the geometry to within 0.1 mi for every kept record.

| dataset | in bbox | outside 100 mi | kept |
|---|---|---|---|
| hifld_substations | 1,520 | 99 | **1,421** |
| hifld_power_plants | 852 | 48 | **804** |

For comparison, the app's existing OSM substations layer (`public/layers/substations.geojson`) has
1,271 features. The new files sit alongside it and do not replace it. Nothing under
`public/`, `lib/` or `app/` was touched.

## Field decisions

**Null handling (both datasets)**
- These placeholders are written as null: numeric `-999999`, and the strings `NOT AVAILABLE`,
  `UNKNOWN`, `N/A`, `NA`, `NONE`, `NULL`, `-` and the empty string. Matching is on the whole value
  and ignores case.
- Synthetic names such as `UNKNOWN301234`, `TAP300123` and `RISER300022` are HIFLD's own
  identifiers. They are kept as given. Only an exact `UNKNOWN` is nulled; that affects 2 plant
  names and no substation names.
- Strings are stripped and runs of whitespace collapsed. Upper case is kept as in the source.
- Dates are converted from epoch milliseconds (UTC) to `YYYY-MM-DD`.

**hifld_substations** (primary key `hifld_id`, from the source ID field; all values are numeric
and unique)
- `lines` is an integer.
- `max_volt_kv` and `min_volt_kv` come from MAX_VOLT and MIN_VOLT, which HIFLD already gives in kV.
- `max_infer` and `min_infer` are converted from Y/N to true/false. A value of true means HIFLD
  inferred the voltage from the lines connected to the substation.
- Columns dropped from the source: OBJECTID, COUNTYFIPS, COUNTRY, NAICS_CODE, GlobalID, and the
  attribute LATITUDE/LONGITUDE (replaced by the geometry values).

## Known caveats

- **Data is stale.** Substations are as of the 2021–2022 HIFLD release.
- **Many substation values are missing or inferred.**
  - `status` is null (NOT AVAILABLE) for 204 of 1,421 records.
  - `max_volt_kv` is null for 72 and `min_volt_kv` for 309.
  - Many voltages are inferred (`max_infer` or `min_infer` is true).
  - 66 kV is the most common maximum voltage (793 records), which reflects SCE's 66 kV
    subtransmission system.
  - TAP, RISER and DEAD END records are line features, not substations (292 records). Filter on
    `type == "SUBSTATION"` (1,105 records) for facilities.
- **Source data errors are kept as-is.**
  - **53 of 1,421 records have MIN_VOLT > MAX_VOLT in the source (kept as-is); use
    max(max_volt_kv, min_volt_kv) for the highest voltage.** Examples: 300528 DUARTE (max 16,
    min 66) and 300220 DESERT OUTPOST (max 33, min 115). The values match the raw attributes. In 52
    of the 53, at least one of the two voltages is inferred (`max_infer` or `min_infer` is true).
    Anything that styles by `max_volt_kv` alone will put these substations in too low a class.
    The validator reports the count on every run as a `value.cross_field` warning.
  - Two substations have the county misspelled `SAN BERNADINO`.
- **Coverage is not complete.** HIFLD says substations below 69 kV are not completely covered.
- **The source is a third-party re-host.** Its provenance was checked against HIFLD's item
  metadata, its field schema and its release note. It was not compared record by record with an
  official download, because none is publicly available.
