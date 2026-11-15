# hifld_transmission

HIFLD "Electric Power Transmission Lines", clipped to a 100-mile radius around
Westminster High School (33.7538, -118.0111).

- Script: `research/scripts/fetch_hifld_transmission.py` (`--refresh` to re-download)
- Outputs: `research/clean/hifld_transmission.csv`, `research/layers/hifld_transmission.geojson`,
  `research/schemas/hifld_transmission.schema.json`
- Raw cache: `research/raw/hifld_transmission/` (query pages, layer and item metadata, `SOURCE.json`
  with URLs, query params, retrieval date and sha256 of every raw file)

## Source (which one worked)

HIFLD Open (hifld-geoplatform.opendata.arcgis.com) was retired in 2025. Two ArcGIS REST copies
still answer queries. By default the script uses only the first; the second is tried only with
`--allow-fallback`:

1. **Used:** Esri Living Atlas / Federal User Community item `d4090758322c4d32a4cd002ffaa0aa12`,
   "U.S. Electric Power Transmission Lines (Archive)".
   Layer: `https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/US_Electric_Power_Transmission_Lines/FeatureServer/0`.
   The item page says the layer is archived and no longer maintained. Its last HIFLD data
   update is **2024-09-30**. It has 94,619 features nationally and uses the standard HIFLD
   schema. The item states U.S. Government data and the Esri Master License Agreement.
2. Fallback, not used: the GeoPlatform ArcGIS Online org (`Hp6G80Pky0om7QvQ`, the former
   HIFLD Open host), item `8ac33965336e498cbe35cd238b3f1ee6`,
   `https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0`.
   It was last edited 2023-09-05 and holds 52,244 features nationally. It returns only
   520 features in our bounding box, compared with 1,796 from the archive. That makes it
   an older and much sparser copy (no `UNDER 100` kV lines; about 500 rows instead of 1,695).
   Falling back to it silently would replace the dataset with a much smaller one, so the
   fallback is opt-in (`--allow-fallback`). It also needs `--allow-shrink` because of the
   row-count floor below.

The query is an envelope `-119.76,32.29,-116.26,35.21` (`inSR=4326`, `outSR=4326`, `f=geojson`,
`outFields=*`, `orderByFields=OBJECTID_1`). It pages with `resultOffset`/`resultRecordCount=1000`
until `exceededTransferLimit` is false. The script also checks the result against
`returnCountOnly`. Retrieval date: 2026-11-14.

### Raw cache safety

- `--refresh` downloads into a sibling temp directory (`raw/hifld_transmission.tmp-<pid>`). That
  directory replaces the cache only after every page has downloaded and the total matches the
  server's `returnCountOnly`.
- **Row-count floor:** a download with fewer than 1,500 features in the bbox, or fewer than 90%
  of the previous `SOURCE.json` `server_count_in_bbox`, is refused unless `--allow-shrink` is
  passed. The same 1,500 floor is checked against the cache before any output is written.
- On any failure the script exits 1 and leaves the existing cache and outputs untouched. This
  matters because the primary item is archived and the local cache may become the only copy.

## Filtering

- A line is kept if **any** vertex is within 100.0 mi of the center. Distance is haversine
  with R = 3958.8 mi. Geometry is not clipped: lines such as the Pacific DC Intertie
  (846 mi) are delivered whole.
- Bounding box returned 1,796 features. 101 had no vertex within 100 mi. **1,695 kept.**
- Empty or zero-length geometries dropped: 0. Duplicate `ID`s: 0 (if any appear, the rule
  keeps the lowest OBJECTID and logs the rest). Null or non-numeric IDs: 0.

## Field decisions

| column | from | notes |
|---|---|---|
| hifld_id | ID | string in the source, cast to int; primary key |
| owner, status, type, volt_class, sub_1, sub_2, naics_desc, source, val_method | same names | whitespace collapsed; `NOT AVAILABLE`/`UNKNOWN`/`N/A`/`-999999` set to null |
| voltage_kv | VOLTAGE | `-999999` (and any value <= 0) set to null; HIFLD kV kept as given |
| inferred | INFERRED | `Y` = true, `N` = false, `NOT AVAILABLE` = null |
| sourcedate, val_date | SOURCEDATE, VAL_DATE | epoch ms converted to a UTC ISO date |
| shape_length_mi | computed | geodesic length (Vincenty, WGS84) of the output geometry, 2 dp. The source `Shape__Length` is in Web Mercator metres, which inflates it by about 1.2x at this latitude, so it is not used |
| distance_mi | computed | haversine distance to the nearest vertex, 1 dp |
| vertex_count | computed | vertices across all parts of the output geometry |

The following are dropped: NAICS_CODE (constant 221121), OBJECTID/OBJECTID_1/GlobalID
(internal), and Shape__Len/Shape__Length.

Geometry is kept as delivered (LineString 1,663, MultiLineString 32). Coordinates are rounded
to 6 dp. Consecutive duplicate vertices produced by rounding are removed. Parts with fewer
than 2 vertices are dropped (none were).

Placeholders nulled among kept rows: sub_2 1,346, sub_1 609, status 438, owner 155,
voltage_kv/volt_class 75, inferred 4, type 2. The script also prints these counts to stderr.

## Counts (1,695 lines)

By volt_class: UNDER 100 = 1,106; 100-161 = 230; 220-287 = 239; 500 = 44; DC = 1; null = 75.

Voltage distribution (kV: n): 33: 40, 34: 23, 66: 841, 69: 191, 70: 3, 89: 3, 92: 5, 115: 176,
138: 54, 220: 29, 230: 208, 287: 2, 500: 44, 1000 (DC, Pacific Intertie): 1, null: 75.

status: IN SERVICE 1,257, null 438. type: AC; OVERHEAD 1,635, OVERHEAD 32,
AC; UNDERGROUND 19, UNDERGROUND 5, DC; OVERHEAD 2, null 2.

## Known caveats

- **The data is archived and frozen at 2024-09-30.** Lines built or retired since then are
  not reflected. No maintained public successor was found.
- **Owner attribution is unreliable.** "AZUSA LIGHT & POWER" is listed as owner of 653 lines,
  including SCE 230 kV corridors (for example Moorpark lines). This looks like a known HIFLD
  ingest artifact from the CEC source. LADWP also appears under two spellings
  ("LOS ANGELES DEPARTMENT OF WATER & POWER" and "LADWP"). Owner values are left as given.
- Most of the lines (66/69 kV, "UNDER 100") are sub-transmission from the California
  Energy Commission layer. HIFLD's nominal scope is 69 kV and above.
- `inferred = true` (88 lines) means HIFLD estimated the voltage.
- Underground segments are included only where HIFLD had sources (24 lines).
- `shape_length_mi` covers the full line, including any portion outside the 100-mi radius.
- Total length summed over kept lines is about 13,465 mi. That figure double-counts parallel
  circuits, which HIFLD stores as separate features (for example Intermountain 500 kV
  circuits 211843 and 211844).
