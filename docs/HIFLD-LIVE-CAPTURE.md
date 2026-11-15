# HIFLD / EIA asset layers: first live capture and field check

Status: 2026-11-14. The first successful live capture of the three ArcGIS asset layers. Earlier attempts on another machine failed with `ENOTFOUND`. Study area: 33.7538, -118.0111, 100 miles (`location-1259cfaed6171d36767e6fe3`).
Everything below was observed by running the code. Nothing here is corroborated against a utility.

## 1. Captures

State namespace: `ETL_STATE_NAMESPACE=hifld-live`, which maps to `research/etl-state/hifld-live/` (gitignored, about 15 MB, kept).

```sh
ETL_STATE_NAMESPACE=hifld-live node node_modules/tsx/dist/cli.mjs research/etl/cli.ts assets <source> 33.7538 -118.0111 100
```

| Source id | Layer (FeatureServer/0) | Object ID field | Features | Pages (100 IDs each) | Index snapshot |
|---|---|---|---|---|---|
| `hifld-substations` | `services.arcgis.com/HQ0xoN0EzDPBOEci/.../Substations` | `FID` | 1,420 | 15 | `snp_7431b4cce5e945db` |
| `hifld-transmission` | `services1.arcgis.com/oS5ru2iHb8I5vlTv/.../Transmission_Lines` (`VOLTAGE >= 69`) | `OBJECTID` | 1,784 | 18 | `snp_68b9c9dc8a728819` |
| `eia-atlas-plants` | `services.arcgis.com/fGsbyIOAuxHnF97m/.../Power_Plants` | `OBJECTID` | 566 | 6 | `snp_8aca1e779c80c529` |

Manifests are stored at `research/etl-state/hifld-live/assets/location-1259cfaed6171d36767e6fe3/<source>/<digest>/manifest.json`.

**Completeness.** `collectAssets` enforces it: every object ID in the `returnIdsOnly` inventory must appear exactly once across the pages, with no extra or duplicate IDs and no `exceededTransferLimit`. All three captures passed. `replay-assets` was then run on each manifest with `fetch` and `net.Socket.connect` stubbed to throw, so no network was possible. The replays returned 566, 1,420 and 1,784 features with unique IDs. The same stub makes a live `assets` capture fail with "NETWORK DISABLED", which confirms the replay check actually ran offline. No capture failures. `assets.ts` was not changed.

**Layer freshness (`editingInfo.dataLastEditDate`).** Substations 2021-08-06, Transmission 2020-01-03, Power plants 2021-07-09 (all plants report `Period` 202004). `VAL_DATE` spans 2015-04-23 to 2020-04-28 for substations and 2015-07-22 to 2019-04-19 for transmission.

## 2. load-assets (offline)

`load-assets` on the three manifests produced revision `0020d034e4df599e5cde51430d431a5ec9b768acb3d81f0bc8478b622afabbb8`, stored at `research/etl-state/hifld-live/loaded-assets/location-1259cfaed6171d36767e6fe3/`.

| Source | Features | Null after normalization |
|---|---|---|
| eia-atlas-plants | 566 | name 0, plant_code 0, utility_name 3 (values are a single space) |
| hifld-substations | 1,420 | name 0, **owner 1,420**, maximum_voltage_kv 73 |
| hifld-transmission | 1,784 | owner 276, voltage_kv 0, status 219 |

All 1,784 transmission features carry `study_clip`. Point layers carry neither `study_clip` nor `mileage`. Transmission `mileage`:

| Voltage band (lower bound inclusive) | Lines inside radius | Inside-radius miles |
|---|---|---|
| 69-115 | 198 | 834.93 |
| 115-230 | 218 | 1,231.43 |
| 230-345 | 235 | 3,551.71 |
| 345-500 | 0 | 0 |
| 500-765 | 42 | 1,550.60 |
| 765-plus | 1 | 69.95 |
| **Total** | **694** | **7,238.62** (provider length of all 1,784 lines: 26,125.30) |

Clip status counts: inside 640, crossing 54, outside 1,090.

### Re-run after the field fixes (offline)

After the fixes in sections 3 to 5, `load-assets` was re-run on the same three manifests. `fetch` and TCP `net.Socket.connect` were stubbed to throw "NETWORK DISABLED" through `NODE_OPTIONS=--require`, so the tsx child process was covered too. As a control, the same stub makes a live `assets hifld-transmission` capture fail with NETWORK DISABLED. The new revision is `5f8154b655dbf040aeb48f109db09cc8e9420579a1574a3db200d7d902447616`, and an unstubbed run gives the same revision.

The transmission manifest is still the pre-fix capture (1,784 features from the inflated server buffer). It was not re-captured because a full capture would take 8 requests (1 index plus 7 pages), which is over this round's 6-request budget. As a result the clip status counts are unchanged: inside 640, crossing 54, outside 1,090. A fresh capture with the fixed query should return only the 694 in-radius lines (see section 3).

| Source | Features | Null after normalization |
|---|---|---|
| eia-atlas-plants | 566 | name 0, plant_code 0, utility_name 3 |
| hifld-substations | 1,420 | name **455** (placeholders), maximum_voltage_kv 73, minimum_voltage_kv 310, type 24 (NOT AVAILABLE), owner 1,420 (not published, see `field_notes.owner`) |
| hifld-transmission | 1,784 | owner 276, voltage_kv 0, status 219, type 1, voltage_class 0 |

All 1,420 substation records are kept, including TAP 189, RISER 89 and DEAD END 13, and each one exposes `type`. Transmission mileage by band:

| Voltage band | Lines inside radius | Inside-radius miles |
|---|---|---|
| 69-115 | 198 | 834.93 |
| 115-230 | 218 | 1,231.43 |
| 230-345 | 235 | 3,551.71 |
| 345-500 | 0 | 0 |
| 500-765 | 41 | 1,510.21 |
| **dc** | **2** | **110.34** |
| **Total** | **694** | **7,238.62** |

The two DC lines are the Pacific DC Intertie (`hifld-transmission:58767`, VOLTAGE 1000, VOLT_CLASS DC, but TYPE "AC"), with 69.95 miles inside, and Intermountain to Adelanto (`hifld-transmission:78339`, TYPE "DC, OVERHEAD", but VOLT_CLASS 500 and VOLTAGE 500), with 40.39 miles inside. The layer marks DC inconsistently, so either field is enough to band a line as `dc`. Before the fix the second line was counted in 500-765. The `765-plus` band no longer appears because no AC line reaches 765 kV.

## 3. Server-side radius defect on Transmission_Lines

1,090 of the 1,784 "within 100 miles" transmission lines have no vertex within 100 miles of the center. Their nearest vertices are 100.1 to 327.7 miles away (median 225). The point layers do not show this: substations max out at 100.10 miles and plants at 99.86.

This layer is stored in a US-feet state-plane CRS (`wkid 102659 / latestWkid 2237`; `Shape__Length` is about 3.28 times the geodesic length). The server's distance buffer is inflated by roughly the metre-to-foot factor:

| `distance` / `units` | count |
|---|---|
| 100 / esriSRUnit_StatuteMile | 1,784 |
| 160934 / esriSRUnit_Meter | 1,784 |
| 30.48 (= 100 / 3.2808) / esriSRUnit_StatuteMile | **694** |

694 matches the 640 + 54 lines that the local geodesic clip finds inside the true 100-mile disk. Consequences:
- `region.transmission_feature_count` (sources.ts `assetCount`) overstates in-radius lines by about 2.6x here (1,784 vs 694).
- `study_clip` is unaffected because it clips locally, and the extra lines correctly land as `outside`. The capture is complete with respect to the server's own query, so no `assets.ts` change was forced.
- Required change (orchestrator, sources.ts): either derive the transmission count from the clipped inventory, or send the geometry in the layer's spatial reference with an explicit linear unit. Re-probe before trusting any other polyline layer's server-side distance.

### Fixed (2026-11-14): study polygon instead of a server-side distance

The `hifld-transmission` count feed (`sources.ts` `assetCount(..., "study-polygon")`) no longer sends `distance` or `units`. Instead it sends a WGS84 polygon (`geometryType=esriGeometryPolygon`, `inSR=4326`, `spatialRel=esriSpatialRelIntersects`) from `geometry.ts` `studyRing`. That polygon is a 64-vertex clockwise ring that circumscribes the same study circle `clipLine` uses, plus 10 m, rounded to 4 decimals. No linear unit is involved, so the layer's foot/metre handling cannot affect the result. `collectAssets` (`assets.ts`) derives its `returnIdsOnly` index from that same URL, so the asset capture inherits the fix. The two point layers keep the point plus statute-mile distance query, which they honour, and their URLs are byte-identical to before.

GET length is a constraint. A first attempt with 128 vertices, 6 decimals and full percent-encoding (a 4,355-character URL) got an HTML `404 - File or directory not found` from the ArcGIS Online IIS front end. The query string is limited to 2,048 characters. The ring now has 4 decimals and leaves JSON punctuation (`[ ] { } , :`) unencoded, which is legal in a query string. `assets.ts` swaps `returnCountOnly` for `returnIdsOnly` in the raw string, because `searchParams` would re-encode it. The URL is now 1,553 characters, with a 1,446-character query string.

Live proof used 6 ArcGIS requests in total. The evidence is in `research/etl-state/hifld-live/layer-metadata/` (`requests.json` lists URL, status, size and sha256):

| # | Request | Result |
|---|---|---|
| 1-3 | `?f=json` for Substations, Transmission_Lines, Power_Plants | saved as `*.layer.json`. Transmission `extent.spatialReference` = `{wkid 102659, latestWkid 2237}` |
| 4 | count, 128-vertex ring (rejected) | IIS 404 HTML, saved as `hifld-transmission.count-128v-6dp-REJECTED-404.html` |
| 5 | count via the `feedsFor` URL (`pipeline.request`) | `{"count":694}` |
| 6 | `returnIdsOnly` via `collectAssets` itself (page fetches stubbed after the index) | 694 object IDs, **identical set** to the 694 lines the local clip finds inside 100 miles in the captured geometry (0 extra, 0 missing) |

The circumscribing polygon can admit a line up to 0.12% of the radius plus 10 m outside the circle. That is about 0.13 mi at 100 mi. The nearest line outside in this capture is at 100.09 mi, and an offline polygon-intersection check on the captured geometry also gave 694. The feed carries this as a caveat. A transmission count that was already captured and pinned replays its old 1,784.

The "geodesic" disk is the clip's local-plane circle. Measured against great-circle distance, its radius varies by about ±0.33% at 100 miles (from 99.67 to 100.32 great-circle miles). The geometry.ts header claims 0.03%, which understates this. The server count matches the clip because the polygon is built in the same plane.

Regression tests (`assets.test.ts`, mocked fetch) check the following for both the count feed and the `collectAssets` index URL: polygon geometry type, `inSR` 4326, no `distance` or `units`, a literal-bracket ring, a closed ring with 65 positions whose every edge lies outside the clip circle, and a query string under 2,048 characters. The point layers are checked for `distance=…&units=esriSRUnit_StatuteMile`. Each of these three mutations made a test fail: reverting the transmission feed to a point distance, re-serializing through `searchParams` in `assets.ts`, and dropping the DC flag.

## 4. Field definitions (from `?f=json`) against the normalization code

### Substations (`objectIdField` = `FID`, SR 4326)

| Field | Type (alias = name) | Observed in capture |
|---|---|---|
| NAME | String(54) | 455 of 1,420 are placeholders `<TYPE><ID>`: UNKNOWN 201, TAP 152, RISER 89, DEADEND 13 |
| ID | String(6) | HIFLD record id, e.g. `300016` |
| TYPE | String(13) | SUBSTATION 1,105, TAP 189, RISER 89, NOT AVAILABLE 24, DEAD END 13 |
| STATUS | String(13) | IN SERVICE 1,217, NOT AVAILABLE 203 |
| MAX_VOLT / MIN_VOLT | Double | `-999999` = unavailable (MAX 73, MIN 310). 53 records have MIN > MAX |
| MAX_INFER / MIN_INFER | String(13) | Y/N. MAX_VOLT inferred on 793 records |
| SOURCE | String(250) | Mostly CEC (941) or IMAGERY (372). 14 cite OpenStreetMap |
| VAL_METHOD, VAL_DATE, SOURCEDATE | String / Date (epoch ms) | VAL_METHOD includes UNVERIFIED (205) |
| LINES | Double | connected line count |
| **OWNER, OPERATOR** | **not present** | the layer publishes no owner or operator column |

No field has a coded-value domain on any of the three layers.

### Transmission_Lines (`OBJECTID`, SR 102659/2237 US feet)

| Field | Type | Observed |
|---|---|---|
| OWNER | String(80) | `NOT AVAILABLE` 276. Attribution is uneven: AZUSA LIGHT & POWER on 270 lines, SOUTHERN CALIFORNIA EDISON on only 16 |
| VOLTAGE | Single | 69 to 500, plus one `1000` |
| VOLT_CLASS | String(50) | UNDER 100, 100-161, 220-287, 345, 500, DC |
| STATUS | String(60) | IN SERVICE 1,565, NOT AVAILABLE 219 |
| TYPE | String(60) | AC / AC, OVERHEAD / AC, UNDERGROUND / DC, OVERHEAD |
| INFERRED | String(13) | Y on 83 |
| SUB_1 / SUB_2 | String(80) | endpoint substation names (not used yet) |
| SOURCE, VAL_METHOD, VAL_DATE, SOURCEDATE | | as for substations |
| Shape__Length | Double | in **US feet**, not metres |

### Power_Plants (`OBJECTID`, SR 3857)

`Plant_Code` Integer, `Plant_Name` String(254), `Utility_Na` String(254, alias "Utility Name"), `Utility_ID` Integer, `PrimSource`, `Install_MW`/`Total_MW` Double. `Bio_MW`, `Geo_MW`, `Bat_MW` and `Other_MW` are **String**, not Double.

### Mismatches and required changes (status updated 2026-11-14 below the list)

1. **`hifld-substations.owner: ["OWNER", "text"]` maps a field that does not exist.** It is null on 1,420 of 1,420 records and no citation is emitted for it. Either drop the mapping or mark it as not published by this layer. Do not backfill it from transmission OWNER.
2. **`hifld-substations.name` keeps placeholders.** 455 records get names like `UNKNOWN300042` or `TAP300101`. Map `NAME === <TYPE word><ID>` to null. `hifldSubstationName()` in `substation-audit.ts` does this and can be reused.
3. **`hifld-substations.maximum_voltage_kv`** correctly nulls the `-999999` sentinel through `"positive"`. Consider also emitting `MIN_VOLT` and `MAX_INFER` so inferred maxima (793 of 1,420) are not presented like measured ones.
4. **Substation `TYPE` and `STATUS` are not normalized.** TAP, RISER and DEAD END (291 records) are not substations, and no current consumer filters them.
5. **`hifld-transmission.voltage_kv`**: the single `VOLTAGE = 1000` record is the Pacific DC Intertie (`VOLT_CLASS` DC, CELILO–SYLMAR EAST), a ±500 kV bipole. `voltageBand` puts it in `765-plus` (69.95 inside-radius miles). It should be banded as DC, not as an AC voltage. `VOLT_CLASS` is not mapped.
6. **`hifld-transmission.status`**: `NOT AVAILABLE` becomes null, which is correct.
7. **`mileage.center`** is emitted as `[lat, lon]` (`[33.7538, -118.0111]`), while geometry is `[lon, lat]`. Label it or swap it.
8. **`eia-atlas-plants.utility_name`**: 3 values are a single space and correctly become null.
9. **The fixture in `assets.test.ts` gives substations an `OPERATOR` field**, which the live layer lacks. The live audit therefore always reports operator `missing`.

**Status (load-assets.ts):**
- **1. Fixed.** Field names were re-checked against the saved `?f=json` metadata, and Substations has no OWNER or OPERATOR field. `owner` is now emitted as an explicit null and is never cited. `field_notes.owner` explains that it is not published and must not be backfilled.
- **2. Fixed.** `name` goes through `hifldSubstationName`. The 455 placeholders become null, and the citation still points at `NAME`.
- **3. Partly fixed.** `minimum_voltage_kv` (MIN_VOLT) is now emitted, with -999999 becoming null. `MAX_INFER` and `MIN_INFER` are still not emitted.
- **4. Partly fixed, by design.** `type` (TYPE) is exposed, and TAP, RISER and DEAD END records are kept because they are real records. Consumers can filter on `type`. Substation STATUS is still not mapped.
- **5. Fixed.** `voltage_class` (VOLT_CLASS) and `type` are mapped. `study_clip.voltage_band` and `mileage.by_voltage_band` use `dc` when VOLT_CLASS is DC or TYPE starts with DC. `voltageBand(kv, { dc })` keeps its old one-argument behaviour.
- **7. Not changed.** `mileage.center` is still `[lat, lon]`.
- **9.** The fixture keeps `OWNER` and `OPERATOR` on purpose. The test now asserts that neither is mapped (`owner` null, no citation). A second fixture record (`TAP300101`, -999999 voltages) checks the placeholder and sentinel handling.

Every dataset now carries `field_notes`, which states how each provider value is normalized.

## 5. Substation audit assumptions and fixes (substation-audit.ts)

Each problem below was exposed by a new test in `research/etl/substation-audit.test.ts` and then fixed:
- **Unreviewed rows were accepted.** Any row with non-empty `evidence` was compared. Now a row with a `review` object counts only if `review.status === "reviewed"` and `review.reviewer` is non-empty. Other rows are listed under `unreviewed` and never compared. Rows without a `review` key (the README's legacy reviewed-array format) are still accepted. A non-array input (such as the candidate file itself) throws.
- **`hifldMaximum` passed `-999999` through.** It is now null for non-positive values.
- **HIFLD placeholder names were reported as name `conflict`.** They are now `missing`.

Unchanged and tested:
- OSM `operator` is compared only with HIFLD `OPERATOR`, which is never present live. HIFLD `OWNER` is reported separately as `hifldOwner`.
- Voltage is always `incomparable`.
- Unpaired records stay in `unmatchedOsm` and `unmatchedHifld`. A missing HIFLD record means no pairing, not a missing asset.

**Name comparison (fixed 2026-11-14).** Names were compared exactly after case and whitespace normalization, so "Lucas Substation (electricity)" against "LUCAS" was a `conflict`. Names are now compared on `substationNameKey()`, which works in these steps:
1. NFKD decomposition with accents removed.
2. Case fold.
3. Every run of non-letter, non-digit characters becomes a token break.
4. Generic tokens are dropped: substation, sub, station, switching, switchyard, electric, electricity, power, the, ss, receiving, distributing, plus `kv` and `<n>kv`. This is the same list as `crosswalk-candidates.ts`.
5. The remaining tokens are joined without spaces.

Results:
- Lucas against LUCAS, and "Mira Loma Sub" against MIRALOMA, are `agreement`.
- Santiago against VIEJO is `conflict`.
- A name with no specific token left (for example "Substation") is `missing`.

The comparison object still carries the raw OSM and HIFLD values side by side (`{osm, hifld, status}`). The operator comparison is unchanged. The reviewer's `evidence` is still what establishes identity.

## 6. Crosswalk candidates (unreviewed)

`research/etl/crosswalk-candidates.ts` exports `runCrosswalkCandidatesCommand([osm.geojson, hifld-substations manifest, "--max-metres", N])`. It is not yet wired into `cli.ts` and defaults to 300 m. It replays the HIFLD manifest offline and pairs each OSM point with every HIFLD point within the distance, ranked by great-circle distance. Each row has:
- the OSM `osm` id and URL
- `hifld` id, `snapshot`, and `citation {snapshot, locator}` pointing to the captured record
- the HIFLD `ID`, NAME (placeholder nulled, as-published kept), TYPE, STATUS, MAX/MIN_VOLT
- `name_similarity` (bigram Dice, null when either name is unavailable)
- `voltage_hint` (OSM tag within HIFLD MIN..MAX ±10%; a hint, not agreement)
- `review: {status: "unreviewed"}`

Outputs (deterministic, named by content digest):
- `research/etl-state/hifld-live/crosswalk/location-1259cfaed6171d36767e6fe3/candidates-c7a12c6e9c433b8c.json`
- `research/etl-state/hifld-live/crosswalk/location-1259cfaed6171d36767e6fe3/candidates-c7a12c6e9c433b8c.csv`

Results on the bundled `public/layers/substations.geojson` (1,271 OSM) against the live capture (1,420 HIFLD), at 300 m:

| Measure | Value |
|---|---|
| OSM substations with at least one candidate | 982 / 1,271 |
| Unnamed OSM substations with a candidate | 620 / 799 |
| Candidate rows (all pairs ≤ 300 m) | 1,155. 140 OSM records have more than one |
| Nearest-candidate distance | min 0.3 m, p25 5.8, median 10.8, p75 20.1, p90 48.2, max 289.2 |
| Distance buckets (nearest) | 0-25 m 795, 25-50 95, 50-100 52, 100-200 28, 200-300 12 |
| Name similarity (nearest) | unavailable 646, ≥0.8 296, 0.4-0.8 12, <0.4 28 |
| Voltage hint (nearest) | consistent 561, inconsistent 34, unknown 387 |
| HIFLD records that are nearest for more than one OSM record | 43 |
| HIFLD within the geodesic 100-mile radius | 1,419 (1 server-returned point is at 100.10 mi) |
| HIFLD in radius with no OSM candidate | 435 (SUBSTATION 166, TAP 163, RISER 75, NOT AVAILABLE 18, DEAD END 13) |
| **Corroborated** | **0** |

**None of these pairings is corroborated.** Proximity is not identity. Low-similarity nearest pairs include real disagreements (e.g. OSM "Azuaga Street Substation" against HIFLD "CHICARITA" at 2.5 m), and 43 HIFLD records are nearest for several OSM records. Feeding all 1,155 rows, with `evidence` text added, to `audit-substations` gave `matched 0, unreviewed 1155`. A pairing becomes corroborated only after a person reviews it: set `review.status: "reviewed"`, add `review.reviewer` and identity `evidence`, keep one row per OSM and per HIFLD record, and pass the resulting **array** to `audit-substations`.
