# OSM layer regeneration: pinned extract vs committed layers

This document covers `public/layers/substations.geojson` (1271 points) and
`public/layers/transmission.geojson` (5331 LineStrings). Both were rebuilt from a pinned
Geofabrik PBF using `research/etl/osm-pbf.ts` (a streaming PBF reader with no dependencies)
and `research/etl/osm-regen.ts`. The rebuilt layers were then diffed element by element.
`public/layers` was **not** modified. Regenerated output lives in
`research/etl-state/osm/regen/` (gitignored): `substations.geojson`,
`transmission.geojson`, `diff.json` (one entry per element) and `inference.json`
(how each rule variant scored).

Reproduce (until `osm-regen` is wired into `research/etl/cli.ts`, call
`runOsmRegenCommand` from any runner):

```
runOsmRegenCommand(["pin", "--pbf", "research/etl-state/osm/socal-261113.osm.pbf",
  "--url", "https://download.geofabrik.de/north-america/us/california/socal-latest.osm.pbf",
  "--final-url", "https://download.geofabrik.de/north-america/us/california/socal-261113.osm.pbf",
  "--headers", "research/etl-state/osm/headers.txt", "--md5", "89b02a763c0edd126ead705c597659cf"])
runOsmRegenCommand(["regen"])   # defaults: pinned PBF, manifest.json, public/layers, etl-state/osm/regen
```

## Pinned source manifest

From `research/etl-state/osm/manifest.json`:

| Field | Value |
|---|---|
| Requested URL | `https://download.geofabrik.de/north-america/us/california/socal-latest.osm.pbf` |
| Final URL (after 307) | `https://download.geofabrik.de/north-america/us/california/socal-261113.osm.pbf` |
| HTTP statuses | 307 → 200 |
| Size | 673,156,133 bytes (equals Content-Length) |
| Last-Modified | Sat, 14 Nov 2026 02:10:51 GMT |
| ETag | `"281f8c25-660330dc7a647"` |
| sha256 | `874a88252cbf0d15893d51493d5fc871085e18af4585ca862bd7a5f92149594f` |
| md5 | `89b02a763c0edd126ead705c597659cf` (matches Geofabrik's published `.md5`) |
| PBF writing program | osmium/1.16.0 |
| required_features | OsmSchema-V0.6, DenseNodes |
| optional_features | Sort.Type_then_ID |
| osmosis_replication_timestamp | 1794604940 = 2026-11-13T21:22:20Z |
| osmosis_replication_sequence_number | 2911 |
| replication base URL | `https://download.geofabrik.de/north-america/us/california/socal-updates` |
| Header bbox | [-121.440088, 32.344928, -113.860038, 35.81055] |

The public Geofabrik extract strips changeset, uid and user (they decode as 0 or empty).
Versions and timestamps are kept, and the provenance in the regenerated output uses them.

## Inferred selection and normalisation rules, with evidence

"Score" means how many committed elements a variant reproduces. Exact numbers are in
`inference.json`.

1. **Substations: `power=substation` nodes and ways only. Relations are excluded.**
   12 `power=substation` relations reach the circle, and the committed layer has 0
   relations. In an earlier run that included relations, 11 of those 12 had their last
   edit before the substation snapshot's lower bound. Timing therefore cannot explain
   their absence, so this is a selection rule.
2. **Substation point: the mean of all way node references, including the repeated
   closing node.** Matches 1267/1267 committed ways exactly at 5 dp. The alternatives did
   much worse: bbox centre (Overpass `out center`) 13/1267, mean without the closing
   node 12/1267, polygon area centroid 1/1267. The metadata calls this an "outline
   centroid", but it is not an area centroid and not Overpass `center`.
3. **Radius: an element is kept if any part of its geometry (segment interiors
   included) is within 100 mi great-circle of [33.7538, -118.0111].** This matches
   Overpass `around` semantics. For substations, the segment rule scores 1271/1271,
   while the any-vertex and point-only rules score 1270. The deciding element is
   `way/940918950`: its point is 100.096 mi out, its nearest vertex 100.067 mi, and one
   polygon edge comes within 99.847 mi. For lines, the segment and vertex rules tie
   (5338 selected, 5329 hits); the first-vertex rule scores 5308. Distances use
   `greatCircleMiles` from `research/etl/geometry.ts` (R = 6,371,008.8 m).
4. **Lines: `power=line` ways, kept when max(voltage) >= 69 kV or when the voltage
   cannot be parsed.** Line geometry is the whole way; it is not clipped to the radius.
   - Dropping untagged lines would lose 1160 committed lines (4169/5329 hits).
   - Using min(voltage) >= 69 would lose 50 (e.g. `69000;66000`).
   - first and max select identically. The registry note says "highest", so max is used.
   - Lines whose max is 66 kV are excluded (9715 `power=line` ways reach the circle
     under any voltage rule).
   - `voltage=0` counts as a parsed 0 kV value and is excluded. This covers seven HVDC
     electrode lines, e.g. 184909075, 184911843, 398603627. My first parse treated 0 as
     untagged and wrongly added all seven.
   - `66000/12000` (slash, not semicolon) does not parse. It becomes `voltage_kv: null`
     and the line is kept as untagged. The committed layer has exactly this for
     1215389817 and 1215389819.
5. **voltage_kv**: split the tag on `;`, keep only plain-number parts, divide by 1000,
   take the max. A trailing `;` is ignored (`138000;` → 138). This matches all 301
   multi-valued committed substation tags and all 71 multi-valued line tags; min matches
   1/301 and 19/71.
6. **Other properties** are copied verbatim from the tags, with null when absent:
   `name`, `operator` and `substation` for substations; `operator`, `name`, `cables`,
   `circuits` and `line` for lines. `osm_id` is `"node/N"`/`"way/N"` for substations and
   the numeric way id for lines.
7. **Coordinates: `Number(x.toFixed(5))`**, which is the same as Python `round(x, 5)`.
   Using `Math.round(x*1e5)/1e5` instead reproduced only 4891 of the 5329 matched line
   geometries, failing on 7-dp values ending in 5 (-117.183835 is committed as
   -117.18384). With `toFixed`, all non-edited geometries match.
8. **Order**: substations sorted by type (node, way) then by id; lines sorted by id.
   Both committed files follow this order.

## Snapshot timing (from the data; the committed files carry no date)

The two committed layers were **not captured at the same time**.

- **transmission**: snapshot falls in [2026-07-07T03:58:18Z, 2026-07-20T10:19:39Z).
  - Lower bound: way 1536077094 is still at version 1, was created 2026-07-07, and is in
    the committed layer.
  - Upper bound: node 1063066120 of way 520426018 moved at 2026-07-20 (node v7). The
    committed coordinate equals its v6 position rounded: OSM API shows v6
    `-118.4726145, 34.2427343` → committed `[-118.47261, 34.24273]`.
- **substations**: snapshot falls in [2026-10-23T07:34:41Z, 2026-11-13T21:22:20Z].
  - Lower bound: `way/1571010372` (version 1, created 2026-10-23) is in the committed
    layer.
  - Upper bound: only the extract's own timestamp. No substation differs, so the data
    gives no tighter limit.

## Counts

| Layer | Committed | Regenerated | unchanged | geometry_changed | property_changed | removed | added |
|---|---|---|---|---|---|---|---|
| substations | 1271 | 1271 | 1271 | 0 | 0 | 0 | 0 |
| transmission | 5331 | 5338 | 5156 | 42 | 137 | 2 | 9 |

(6 lines are both geometry_changed and property_changed. 5156 + 42 + 137 - 6 + 2 = 5331.)

**version changed**: every matched element reports `baseline_version: "unknown"`. The
committed files carry no versions, so "version changed" cannot be computed directly. The
current version and the last-modified time (way plus its member nodes) are recorded per
entry in `diff.json`. The bounds above stand in for the baseline.

### Causes as attributed by `diffLayers`

The rule used: a difference is labelled `osm_edit_after_snapshot` when the element (or
any of its nodes) was last edited after the layer's lower bound. Otherwise it is labelled
`rule_mismatch`. All 190 transmission differences fall into the first group, and **no
difference is attributed to a rule mismatch** under the final rules. The earliest edit
among changed elements is 2026-07-20, which sets the upper bound. That makes the
attribution self-consistent, but partly circular for elements edited between Jul 7 and
Jul 20 (there is exactly one: 520426018). The OSM API spot checks below are independent
evidence.

## Explanation by difference class

### removed (2): ways deleted from OSM after the snapshot

The PBF does not contain these elements at all. OSM API history (fetched for this
report) confirms both were deleted. In each case the committed vertices now sit on a
neighbouring line, so these are merges or cleanups:

- 486667905 (500 kV, 2 vertices): deleted as v3 on 2026-11-13T19:55:57Z. Both committed
  vertices are now on way 389918596 (v7, edited the same second).
- 1251198898 (500 kV, 2 vertices): deleted as v2 on 2026-11-08T11:34:13Z. Both vertices
  are now on way 386372415, and busbars 1251198905/1251198906 were edited the same
  second.

### added (9): ways created after the transmission snapshot

All 9 are version 1, and their creation times fall after 2026-07-20:

- 1560052529, 1560052532, 1560052544: created 2026-09-18T02:44:09Z (1560052544 is 220 kV;
  the others have no voltage tag).
- 1561295328: 2026-09-22. 1563646719: 2026-09-29.
- 1564015469 (115 kV): created 2026-10-01T08:20:11Z. Way 734090710 shrank from 61 to 37
  vertices in the same second, so this is a split.
- 1578206580: 2026-11-12.

### geometry_changed (42): node moves, splits and re-routes after the snapshot

Max vertex displacement: min 0.52 m, median 34.5 m, max 1612 m. 16 have the same vertex
count (node moves); 26 changed vertex count (nodes added or removed, splits). Every one
was last edited (way or a member node) on or after 2026-07-20.

- 520426018: 0.52 m. A node move on 2026-07-20, confirmed with node history (above).
- 31567002: 3.14 m. Node 1001697123 moved v1→v2 on 2026-11-11. The committed value is
  v1 rounded (`-117.6348481, 34.1587838` → `[-117.63485, 34.15878]`). Confirmed via the
  OSM API.
- 64130150: 272 m, same 246 vertices. The way itself is unchanged since 2024 (v7), but
  member nodes moved on 2026-09-22. This shows why last_modified must include node
  timestamps.
- 734090710: 61 → 37 vertices, 1612 m Hausdorff, and operator changed from Azusa Light &
  Power to Southern California Edison. Split and retagged on 2026-10-01 (see 1564015469).
- 1445899538: 28 → 201 vertices, 1292 m. Re-traced on 2026-09-22.

### property_changed (137): tag edits after the snapshot

Fields changed: line 101, name 25, circuits 23, operator 5. The earliest edit is
2026-09-02.

- `line: null → busbar/bay` (57 busbar, 44 bay), mostly from substation-interior tagging
  on 2026-11-07/08. Example 1215172043: v2 (2024-02-19) had no `line` tag; v3
  (2026-11-08) added `line=busbar`. Confirmed via the OSM API.
- SCE 500 kV renames plus `circuits=1` on 2026-11-13T19:55:57Z. Example 7036381: v12
  `McCullough - Victorville 500KV #1` → v13 `McCullough - Victorville No. 1 500KV`,
  circuits 1. Confirmed via the OSM API. Also 24333122, 24333136, 30370918.
- 30755433: name `Adelanto - Intermountain (Path 27 HVDC)` → `HVDC Intermountain`
  (v23, 2026-09-02).
- 7081468, 606807212, 1251199031: `operator: null → Southern California Edison`, all on
  2026-10-02.
- 86369491: operator became the multi-value
  `Los Angeles Department of Water and Power;Southern California Edison` on 2026-11-13.
  It is copied verbatim, as the committed rule does.

### unchanged (1271 substations, 5156 lines)

These match exactly after normalisation. 46 lines and 15 substations had OSM edits
after their layer's snapshot that did not touch any normalised field (for example tags
the layers do not export). This was inferred from the timestamps; I did not check each
edit individually.

### Selection-rule boundary cases (in `diff.json` → `boundary`)

- **Radius**: 8 substations and 23 lines lie within 0.5 mi of 100 mi. The rules
  reproduce every one: the 3 substations and 1 line on the inside are kept, and the
  5 substations and 22 lines outside (100.066–100.481 mi) are excluded. `way/940918950`
  is the only element that tells the segment rule apart from the vertex rule.
- **Voltage parsing**: 301 substation and 73 line voltage tags are not a single integer.
  All reproduce (`;` lists, a trailing `;`, `0` components such as `230000;230000;0`
  → 230, and `66000/12000` → null).

## Residuals not explained

None in the counts. Two caveats:

1. The attribution assumes each layer had one snapshot. The transmission bracket is
   narrow (13 days) and consistent. The substation layer has no upper bound beyond the
   extract time.
2. "Deleted from OSM" was confirmed only for the 2 removed ways. "Edit after snapshot"
   was confirmed against OSM history for 4 examples (2 node moves, 2 tag edits). For the
   rest it is inferred from PBF timestamps.
