# research/ — grid data pipeline

Fetch scripts pull public grid data (EIA-860, HIFLD) for a **100-mile radius around
Westminster High School, Westminster CA** (33.7538, -118.0111). They write clean CSVs,
GeoJSON layers and a schema per dataset. The `pipeline` package then validates
everything against that schema, writes a manifest, and (only when you ask it to)
publishes layers into `public/layers/`.

## Running it

From the repo root (the path has spaces, so keep the quotes):

```bash
"research/run_pipeline.sh"                 # tests -> fetch -> validate -> manifest -> publish (dry run) -> manifest --check
"research/run_pipeline.sh" --skip-fetch    # re-check existing outputs without fetching
"research/run_pipeline.sh" --refresh       # fetchers re-download raw files
"research/run_pipeline.sh" --publish       # also copy layers to public/layers/ under new names
```

Or run single steps from inside `research/`:

```bash
cd research
export PYTHONPATH=.
.venv/bin/python -m pipeline fetch [--refresh]        # runs every scripts/fetch_*.py; any failure fails the run
.venv/bin/python -m pipeline validate [--dataset NAME] [--json report.json]
.venv/bin/python -m pipeline manifest --generated-at 2026-11-14
.venv/bin/python -m pipeline manifest --check         # exit 1 if manifest.json is stale (hash/bytes/rows/status)
.venv/bin/python -m pipeline publish                  # DRY RUN: prints what it would do
.venv/bin/python -m pipeline publish --publish        # writes the new-name layers
.venv/bin/python -m pipeline publish --publish --replace-plants
.venv/bin/python -m pipeline compat FILE --shape plant|transmission|substation [--against OLD]
.venv/bin/python -m pipeline all [--skip-fetch] [--generated-at X] [--publish] [--replace-plants]
.venv/bin/python -m unittest discover -s tests        # pipeline tests (tiny fixtures in tests/fixtures/)
```

Exit codes: 0 = ok (warnings allowed), 1 = a validation error, a failed fetcher or a
refused publish.

## Layout

| Path | What | Committed |
|---|---|---|
| `raw/<source>/` | raw downloads plus `SOURCE.json` (url, retrieval date, sha256) | no |
| `clean/<dataset>.csv` | tabular output, one row per entity | yes |
| `layers/<dataset>.geojson` | spatial output | yes |
| `schemas/<dataset>.schema.json` | the contract for that dataset; drives validation | yes |
| `notes/<dataset>.md` | source, vintage, filtering, field decisions, caveats | yes |
| `scripts/fetch_*.py` | one fetcher per source | yes |
| `pipeline/` | validate / compat / manifest / publish / CLI | yes |
| `manifest.json` | every dataset's files, sha256, bytes, rows, status | yes |
| `backup/` | copies of public files replaced by `publish` | no |

## Datasets

| Dataset | Producer | Kind | Primary key | Published as (`public/layers/`) |
|---|---|---|---|---|
| `eia860_plants` | `scripts/fetch_eia860.py` | CSV (+ layer) | `plant_code` | `eia860_plants.geojson`, and `plants.geojson` with `--replace-plants` |
| `eia860_plants_layer` | `scripts/fetch_eia860.py` | GeoJSON twin of `eia860_plants` (Point) | `plant_code` | (same file as above) |
| `eia860_generators` | `scripts/fetch_eia860.py` | CSV | `plant_code`, `generator_id` | — |
| `hifld_transmission` | `scripts/fetch_hifld_transmission.py` | CSV + GeoJSON (LineString/MultiLineString) | `hifld_id` | `hifld_transmission.geojson` |
| `hifld_substations` | `scripts/fetch_hifld_points.py` | Point | per schema | `hifld_substations.geojson` |
| `hifld_power_plants` | `scripts/fetch_hifld_points.py` | Point | per schema | `hifld_power_plants.geojson` |

`manifest.json` holds the current row counts, hashes and validation status. This table
only says what each dataset is.

## Data contract (enforced by `pipeline/validate.py`)

**Region.** The haversine distance to (33.7538, -118.0111) with an earth radius of
3958.8 mi must be ≤ 100.0 mi. A point must be inside the radius. A line needs at least
one vertex inside, and its geometry is not clipped. Every coordinate must fall within
lon -125..-110, lat 30..40. Breaking that box is an error for points but only a
warning (`geo.bounds_line`) for lines, because the contract keeps whole lines and real
HIFLD lines run into Oregon and Nevada. A 0.01 mi slack covers rounding to 6 decimals.

**CSV** (`clean/<dataset>.csv`)
- UTF-8 with no BOM, LF line endings only, and a trailing newline (a missing trailing newline is only a warning).
- The header equals the schema `fields` names in order: unique snake_case names, no index column.
- The primary key is unique, non-null and strictly ascending, compared by type (integers numerically, strings by code point).
- A null is an empty string. These tokens are errors in any column, matched case-insensitively
  against the whole value: `nan`, `None`, `NULL`, `NaT`, `<NA>`, `#N/A`, `N/A`, `-`,
  `NOT AVAILABLE`, `UNKNOWN`, `TBD`, `TBA`, `-999999`, `inf`.
- `integer` is `-?(0|[1-9]\d*)`, so `1962.0` and `1,234` are errors. `number` is a plain
  decimal (exponent notation is only a warning). `boolean` is `true`/`false`. `date` is a
  valid `YYYY-MM-DD`. `array`/`object` should be JSON-encoded (a warning otherwise).
- `nullable`, `enum`, `min` and `max` are enforced.
- Strings carry no leading or trailing whitespace, no runs of two or more spaces, and no tabs, newlines or NBSP.
- If the CSV has `latitude` and `longitude`, every row must be within the region
  (`csv.region`), and `distance_mi`, when present, must be within 0.051 mi of the distance
  computed from them (`csv.distance`). This covers the tabular-only datasets too.
- Cross-field rule: `min_volt_kv > max_volt_kv` is a warning (`value.cross_field`); it is a
  known HIFLD source error that is kept as-is.

**GeoJSON** (`layers/<dataset>.geojson`)
- An RFC 7946 FeatureCollection with no `crs` (a `crs` member is a warning). It is UTF-8
  with no BOM and has no `NaN`/`Infinity` anywhere.
- Every feature has a non-null geometry whose type is one the schema's `geometry_type`
  allows. That can be `"Point"`, `"LineString"`, `"MultiLineString"` or an alternation
  such as `"LineString|MultiLineString"`.
- Positions are `[lon, lat]` (two finite numbers) rounded to at most 6 decimals.
- The property keys equal `geojson_fields`, or `fields` when there is no `geojson_fields`.
  A different key order is a warning. Values are typed JSON: `integer` must be a JSON
  integer (`400`, not `400.0`). Nested values are allowed only for `array`/`object`
  fields. Empty strings are errors (use `null`).
- `distance_mi` is present, has 1 decimal, and is within 0.2 mi of the computed distance to the point or nearest vertex.
- The primary key is unique, non-null and features are sorted by it.
- If the dataset has both a CSV and a GeoJSON, the row count and primary-key set must be identical,
  every property that is also a CSV column (same or numeric type) must equal the CSV value for
  the same primary key, and Point coordinates must equal the CSV `longitude`/`latitude`
  (within 1e-6). Differences are `geo.csv_mismatch` errors.

**Twin layers.** A spatial schema named `<base>_layer` describes `layers/<base>.geojson`
when `layers/<base>_layer.geojson` does not exist. A schema can also name its files
with `"csv_file"` and `"geojson_file"`, as paths relative to `research/`. A twin
layer's keys must be a subset of the `<base>` CSV's keys. A subset is reported as info,
because the layer may be filtered, for example to operating plants only. Shared property
values and Point coordinates must agree with the `<base>` CSV, as above. (A non-nullable
layer property may carry a fallback where the CSV value is null.)

Any `clean/*.csv` or `layers/*.geojson` that no schema describes is an error
(`file.unexpected`), as is a schema field entry missing any of `nullable`, `description`,
`unit`, `enum`, `min`, `max`.

**Cross-dataset** (in `pipeline/common.py:REFERENCE_RULES`, and extendable per schema
with `"references": [{"field", "dataset", "target_field", "severity": "error"|"rate"}]`)
- `eia860_generators.plant_code` ⊆ `eia860_plants.plant_code`: an error.
- `hifld_power_plants.eia_plant_code` against `eia860_plants.plant_code`: the match rate
  is reported as a warning, or as info at 100%. It is never an error.

**Schema file** (`schemas/<dataset>.schema.json`)

```json
{"dataset": "x", "primary_key": ["id"], "geometry_type": "Point" | null,
 "source": {"name": "...", "url": "...", "vintage": "..."},
 "fields": [{"name": "id", "type": "integer", "nullable": false, "description": "...",
             "unit": null, "enum": null, "min": null, "max": null}],
 "geojson_fields": [ ...optional, same shape, when the layer's properties differ from the CSV... ]}
```

Types: `string | integer | number | boolean | date | array | object`. Every spatial
dataset needs a `distance_mi` property, and its primary key must be among the GeoJSON
properties.

Errors fail the run. Warnings are printed and recorded in the manifest but do not
fail it. One of them is a missing `notes/<dataset>.md`.

## Publishing and the app

The app reads `public/layers/{plants,transmission,substations}.geojson` with the shapes
in `lib/gridLayers.ts`. `pipeline/compat.py` encodes those interfaces (`PlantProperties`,
`TransmissionProperties` and `SubstationProperties`, plus their geometry types).

- `publish` is a **dry run** by default. With `--publish` it copies validated layers to
  the new names only: `eia860_plants.geojson`, `hifld_transmission.geojson`,
  `hifld_substations.geojson` and `hifld_power_plants.geojson`. If any layer it would
  publish fails validation, nothing is written.
- `--publish --replace-plants` also replaces `public/layers/plants.geojson` with
  `layers/eia860_plants.geojson`, but only when compat passes for `PlantProperties`. The
  features are re-ordered by `nameplate_mw` descending (then `plant_code`), the order the
  app draws markers in, so small plants stay on top and hoverable; compat warns if a
  candidate breaks that order. The old file is first backed up to
  `backup/plants.<sha12>.geojson`.
- Every write goes to a temp file in the same directory followed by `os.replace`. A
  replaced file keeps its mode; a new file gets 0644.
- `transmission.geojson`, `substations.geojson` and `niche_cases.json` are never
  written. A hard guard in `publish.assert_allowed` enforces this.

## Adding a dataset

1. Write `scripts/fetch_<source>.py`. It runs with no arguments, re-downloads only with
   `--refresh`, caches raw files in `raw/<source>/` with `SOURCE.json`, produces
   deterministic output, prints a one-line summary and exits non-zero on failure.
   Download into a sibling temp directory and swap it in only when complete (never delete
   the cache first), and do not fall back to a different source unless asked to (see
   `fetch_hifld_transmission.py --allow-fallback` / `--allow-shrink`).
2. Emit `clean/<dataset>.csv` and/or `layers/<dataset>.geojson` with the same
   `<dataset>` stem as `schemas/<dataset>.schema.json`.
3. Write `notes/<dataset>.md` (one per dataset name; a `<base>_layer` schema may share
   `notes/<base>.md`).
4. If it references another dataset, add a `"references"` entry to its schema or a rule
   to `REFERENCE_RULES`.
5. To publish it, add `(<dataset>, "<new_name>.geojson")` to `publish.PUBLISH_MAP`.
   Never reuse a name the app already reads.
6. Run `.venv/bin/python -m pipeline validate --dataset <dataset>`, then the tests.

The fetch step needs no registration: `python -m pipeline fetch` runs every `scripts/fetch_*.py` in name order.
