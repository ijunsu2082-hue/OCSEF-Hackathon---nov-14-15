#!/usr/bin/env python3
"""Fetch HIFLD "Electric Substations" and HIFLD "Power Plants" point layers for a
100-mile radius around Westminster High School (Westminster, CA) and write clean
CSV / GeoJSON / schema files.

Availability (researched 2026-11-14):
  * HIFLD Open (hifld-geoplatform.opendata.arcgis.com) was retired in 2025. The
    GeoPlatform host org (services1.arcgis.com/Hp6G80Pky0om7QvQ) no longer serves
    either layer ("Plants_gdb" and "Electric_Substations" return "Invalid URL").
  * Electric Substations moved to HIFLD Secure in 2022. The last public release is
    still served, unauthenticated, from a public ArcGIS Online copy:
      item ef04dc8231c9491e804a008e5faa7d3a "Substations" (created 2022-02-14),
      services6.arcgis.com/OO2s4OoyCZkYJ6oE/.../Substations/FeatureServer/0
      (77,946 features, full HIFLD schema, license "None (Public Use)").
  * Power Plants: the final HIFLD Open "Plants_gdb" layer (13,233 features per an
    Internet Archive capture of the official service on 2025-02-02) is served,
    unauthenticated, from a public ArcGIS Online copy:
      item 6e0bdfea762046988469da10407f844f "Plants_gdb__8907007659940948974"
      (created 2024-11-19), services7.arcgis.com/2hYXmwteFLemN5bW/... (13,233
      features, identical field list to the official layer).
  Neither copy is published by DHS; both are verbatim re-hosts of public-domain
  HIFLD Open releases. See research/notes/hifld_substations.md and
  research/notes/hifld_power_plants.md.

Raw query responses are cached in research/raw/hifld_points/. Re-runs reuse the
cache (verified against SOURCE.json sha256); pass --refresh to re-download. A
re-download fetches BOTH layers into a sibling temp directory and replaces the cache
only when both are complete, so a failure on one layer cannot drop the other's cached
files. A download whose bbox count falls below 90% of the previous one is refused
unless --allow-shrink is passed. Output is deterministic for a given cache.

Usage:  python research/scripts/fetch_hifld_points.py [--refresh] [--allow-shrink]
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import math
import os
import re
import shutil
import sys
import time
from collections import Counter, OrderedDict
from typing import Any, Callable, Dict, List, Optional, Tuple

import requests

# --------------------------------------------------------------------------- config
RESEARCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(RESEARCH, "raw", "hifld_points")
SOURCE_JSON = os.path.join(RAW_DIR, "SOURCE.json")

CENTER_LAT = 33.7538
CENTER_LON = -118.0111
RADIUS_MI = 100.0
EARTH_RADIUS_MI = 3958.8
BBOX = (-119.76, 32.29, -116.26, 35.21)  # xmin, ymin, xmax, ymax (lon/lat)
PAGE_SIZE = 2000

# Exact (case-insensitive) matches only: synthetic names such as 'UNKNOWN301234' are kept.
NULL_STRINGS = {"", "NOT AVAILABLE", "UNKNOWN", "N/A", "NA", "NONE", "NULL", "-", "-999999", "-999999.0"}
SHRINK_RATIO = 0.9
NULL_NUMBER = -999999.0

SOURCES: Dict[str, dict] = OrderedDict([
    ("hifld_substations", {
        "raw_prefix": "substations",
        "name": "HIFLD Open 'Electric Substations' (last public release, re-hosted on ArcGIS Online "
                "item ef04dc8231c9491e804a008e5faa7d3a)",
        "item_id": "ef04dc8231c9491e804a008e5faa7d3a",
        "item_url": "https://www.arcgis.com/home/item.html?id=ef04dc8231c9491e804a008e5faa7d3a",
        "layer_url": "https://services6.arcgis.com/OO2s4OoyCZkYJ6oE/arcgis/rest/services/"
                     "Substations/FeatureServer/0",
        "oid_field": "OBJECTID",
        "vintage": "HIFLD Open Electric Substations, final public release before the 2022 move to "
                   "HIFLD Secure (copy published 2022-02-14; max SOURCEDATE/VAL_DATE 2021-06-01)",
    }),
    ("hifld_power_plants", {
        "raw_prefix": "power_plants",
        "name": "HIFLD Open 'Power Plants' (Plants_gdb; final HIFLD Open release, re-hosted on ArcGIS "
                "Online item 6e0bdfea762046988469da10407f844f)",
        "item_id": "6e0bdfea762046988469da10407f844f",
        "item_url": "https://www.arcgis.com/home/item.html?id=6e0bdfea762046988469da10407f844f",
        "layer_url": "https://services7.arcgis.com/2hYXmwteFLemN5bW/arcgis/rest/services/"
                     "Plants_gdb__8907007659940948974/FeatureServer/0",
        "oid_field": "FID",
        "vintage": "HIFLD Open Power Plants, final HIFLD Open release (official service last edited "
                   "2023-09-21, 13,233 features; max SOURCEDATE 2022-06-02, max VAL_DATE 2022-07-18)",
    }),
])
OFFICIAL_RETIRED_URLS = [
    "https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Plants_gdb/FeatureServer/0",
    "https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Substations/FeatureServer/0",
]


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


# --------------------------------------------------------------------------- helpers
def haversine_mi(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(min(1.0, math.sqrt(a)))


_ws = re.compile(r"\s+")


def norm_str(v: Any) -> Optional[str]:
    if v is None:
        return None
    s = _ws.sub(" ", str(v)).strip()
    if s.upper() in NULL_STRINGS:
        return None
    return s


def norm_num(v: Any, ndigits: int = 3, allow_negative: bool = True) -> Optional[float]:
    if v is None or (isinstance(v, str) and norm_str(v) is None):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f == NULL_NUMBER:
        return None
    if not allow_negative and f < 0:
        return None
    f = round(f, ndigits)
    if f == 0:
        f = 0.0  # normalise -0.0
    return f


def norm_int(v: Any, allow_negative: bool = False) -> Optional[int]:
    f = norm_num(v, 6, allow_negative)
    if f is None:
        return None
    if not float(f).is_integer():
        raise ValueError("expected integer, got %r" % v)
    return int(f)


def norm_date(v: Any) -> Optional[str]:
    """ArcGIS dates arrive as epoch milliseconds (UTC)."""
    if v is None or v == "":
        return None
    try:
        ms = float(v)
    except (TypeError, ValueError):
        m = re.match(r"^(\d{4})[-/](\d{2})[-/](\d{2})", str(v).strip())
        return "%s-%s-%s" % m.groups() if m else None
    if ms == NULL_NUMBER or ms <= -2208988800000:  # placeholder / before 1900
        return None
    return (dt.datetime(1970, 1, 1) + dt.timedelta(milliseconds=ms)).strftime("%Y-%m-%d")


def norm_bool(v: Any) -> Optional[bool]:
    s = norm_str(v)
    if s is None:
        return None
    s = s.upper()
    if s in ("Y", "YES", "TRUE", "T", "1"):
        return True
    if s in ("N", "NO", "FALSE", "F", "0"):
        return False
    raise ValueError("unexpected boolean value %r" % v)


def fmt_csv(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v.is_integer():
            return str(int(v))
        return repr(v)
    return str(v)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------- download
def get_json(session: requests.Session, url: str, params: Dict[str, Any]) -> Tuple[dict, bytes]:
    last_err: Optional[Exception] = None
    for attempt in range(4):
        try:
            r = session.get(url, params=params, timeout=120)
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict) and "error" in data:
                raise RuntimeError("ArcGIS error: %s" % json.dumps(data["error"])[:500])
            return data, r.content
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("request failed for %s: %s" % (url, last_err))


def write_bytes(dest_dir: str, name: str, content: bytes) -> str:
    with open(os.path.join(dest_dir, name), "wb") as fh:
        fh.write(content)
    return name


def download_source(session: requests.Session, dataset: str, src: dict, dest_dir: str) -> dict:
    """Download one layer's raw files into dest_dir (a fresh temp dir)."""
    prefix = src["raw_prefix"]
    layer_url = src["layer_url"]
    files: List[str] = []
    _, b = get_json(session, layer_url, {"f": "json"})
    files.append(write_bytes(dest_dir, prefix + "_layer_info.json", b))
    _, b = get_json(session, "https://www.arcgis.com/sharing/rest/content/items/%s" % src["item_id"], {"f": "json"})
    files.append(write_bytes(dest_dir, prefix + "_item_info.json", b))

    base_params = OrderedDict([
        ("where", "1=1"),
        ("geometry", "%s,%s,%s,%s" % BBOX),
        ("geometryType", "esriGeometryEnvelope"),
        ("inSR", "4326"),
        ("spatialRel", "esriSpatialRelIntersects"),
        ("outSR", "4326"),
        ("outFields", "*"),
        ("returnGeometry", "true"),
        ("orderByFields", src["oid_field"] + " ASC"),
        ("f", "geojson"),
    ])
    count_params = dict(base_params, returnCountOnly="true", f="json")
    count_params.pop("orderByFields")
    cnt, _ = get_json(session, layer_url + "/query", count_params)
    expected = int(cnt.get("count", -1))
    _, b = get_json(session, layer_url + "/query", {"where": "1=1", "returnCountOnly": "true", "f": "json"})
    files.append(write_bytes(dest_dir, prefix + "_total_count.json", b))

    offset, page, total = 0, 0, 0
    while True:
        params = dict(base_params, resultOffset=offset, resultRecordCount=PAGE_SIZE)
        data, content = get_json(session, layer_url + "/query", params)
        feats = data.get("features")
        if feats is None:
            raise RuntimeError("unexpected response (no features) at offset %d" % offset)
        files.append(write_bytes(dest_dir, "%s_page_%03d.geojson" % (prefix, page), content))
        total += len(feats)
        exceeded = bool((data.get("properties") or {}).get("exceededTransferLimit")
                        or data.get("exceededTransferLimit"))
        if not feats or (not exceeded and len(feats) < PAGE_SIZE):
            break
        offset += len(feats)
        page += 1
        if page > 200:
            raise RuntimeError("pagination runaway")
    if expected < 0 or total != expected:
        raise RuntimeError("%s: downloaded %d features but server bbox count is %d" % (dataset, total, expected))

    return OrderedDict([
        ("dataset", dataset),
        ("source_name", src["name"]),
        ("item_url", src["item_url"]),
        ("layer_url", layer_url),
        ("query_url", layer_url + "/query"),
        ("query_params", OrderedDict(sorted(base_params.items()))),
        ("page_size", PAGE_SIZE),
        ("server_count_in_bbox", expected),
        ("vintage", src["vintage"]),
        ("retrieval_date", dt.date.today().isoformat()),
        ("files", [OrderedDict([("file", f), ("sha256", sha256_file(os.path.join(dest_dir, f))),
                                ("bytes", os.path.getsize(os.path.join(dest_dir, f)))]) for f in files]),
    ])


def read_source_json() -> Optional[dict]:
    if not os.path.exists(SOURCE_JSON):
        return None
    try:
        with open(SOURCE_JSON, encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, ValueError):
        return None
    return meta if isinstance(meta, dict) else None


def load_cache() -> Optional[dict]:
    meta = read_source_json()
    if meta is None:
        return None
    for ds in SOURCES:
        entry = (meta.get("datasets") or {}).get(ds)
        if not entry:
            log("cache missing %s; re-downloading" % ds)
            return None
        for f in entry.get("files", []):
            fp = os.path.join(RAW_DIR, f["file"])
            if not os.path.exists(fp) or sha256_file(fp) != f["sha256"]:
                log("cache invalid (%s missing or changed); re-downloading" % f["file"])
                return None
    return meta


def check_floor(dataset: str, count: int, previous: Optional[dict], allow_shrink: bool) -> None:
    if allow_shrink:
        return
    if count <= 0:
        raise RuntimeError("%s: server returned no features in the bbox; refusing to replace the cache" % dataset)
    prev = ((previous or {}).get("datasets") or {}).get(dataset, {}).get("server_count_in_bbox")
    if isinstance(prev, int) and prev > 0 and count < SHRINK_RATIO * prev:
        raise RuntimeError("%s: only %d features in bbox, below %d%% of the previous download (%d); refusing "
                           "to replace the cache (pass --allow-shrink to accept)"
                           % (dataset, count, SHRINK_RATIO * 100, prev))


def swap_in(tmp: str) -> None:
    """Replace RAW_DIR with the completed temp dir (old cache removed only after the swap)."""
    old = RAW_DIR + ".old"
    if os.path.exists(old):
        shutil.rmtree(old)
    if os.path.exists(RAW_DIR):
        os.replace(RAW_DIR, old)
    os.replace(tmp, RAW_DIR)
    if os.path.exists(old):
        shutil.rmtree(old)


def acquire(refresh: bool, allow_shrink: bool = False) -> dict:
    if not refresh:
        meta = load_cache()
        if meta:
            return meta
    previous = read_source_json()
    tmp = RAW_DIR + ".tmp-%d" % os.getpid()
    shutil.rmtree(tmp, ignore_errors=True)
    try:
        os.makedirs(tmp)
        session = requests.Session()
        session.headers["User-Agent"] = "research-data-pipeline/1.0"
        datasets = OrderedDict()
        for ds, src in SOURCES.items():
            log("downloading %s from %s" % (ds, src["layer_url"]))
            datasets[ds] = download_source(session, ds, src, tmp)
            check_floor(ds, int(datasets[ds]["server_count_in_bbox"]), previous, allow_shrink)
        meta = OrderedDict([
            ("description", "HIFLD Electric Substations and Power Plants point layers, ArcGIS REST query "
                            "(envelope %s, inSR/outSR 4326, f=geojson, paginated by %d) for a 100-mile radius "
                            "around Westminster High School, Westminster CA." % (",".join(map(str, BBOX)), PAGE_SIZE)),
            ("official_hifld_open_urls_now_retired", OFFICIAL_RETIRED_URLS),
            ("datasets", datasets),
        ])
        with open(os.path.join(tmp, "SOURCE.json"), "w", encoding="utf-8", newline="\n") as fh:
            json.dump(meta, fh, indent=2)
            fh.write("\n")
        swap_in(tmp)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return meta


def load_features(entry: dict) -> List[dict]:
    feats: List[dict] = []
    for f in entry["files"]:
        if "_page_" in f["file"]:
            with open(os.path.join(RAW_DIR, f["file"]), encoding="utf-8") as fh:
                feats.extend(json.load(fh).get("features") or [])
    return feats


# --------------------------------------------------------------------------- field specs
def F(name: str, typ: str, nullable: bool, desc: str, unit: Optional[str] = None,
      enum: Optional[list] = None, mn: Optional[float] = None, mx: Optional[float] = None) -> OrderedDict:
    return OrderedDict([("name", name), ("type", typ), ("nullable", nullable), ("description", desc),
                        ("unit", unit), ("enum", enum), ("min", mn), ("max", mx)])


VOLT_CAVEAT = ("53 records have MIN_VOLT > MAX_VOLT in the source (kept as-is); use "
               "max(max_volt_kv, min_volt_kv) for the highest voltage.")

SUBSTATION_FIELDS = [
    F("hifld_id", "integer", False, "HIFLD substation ID (source field ID). Primary key."),
    F("name", "string", True, "Substation name (source NAME). Many are synthetic 'UNKNOWNnnnnnn' or "
      "'TAPnnnnnn' identifiers assigned by HIFLD."),
    F("city", "string", True, "City (source CITY)."),
    F("state", "string", True, "Two-letter state abbreviation (source STATE)."),
    F("county", "string", True, "County name (source COUNTY)."),
    F("zip", "string", True, "ZIP code as text (source ZIP)."),
    F("type", "string", True, "Facility type (source TYPE), e.g. SUBSTATION, TAP, RISER."),
    F("status", "string", True, "Operating status (source STATUS)."),
    F("naics_desc", "string", True, "NAICS description (source NAICS_DESC)."),
    F("lines", "integer", True, "Number of HIFLD transmission lines connected (source LINES).", None, None, 0, None),
    F("max_volt_kv", "number", True, "Maximum operating voltage (source MAX_VOLT); -999999 -> null. "
      + VOLT_CAVEAT, "kV", None, 0, None),
    F("min_volt_kv", "number", True, "Minimum operating voltage (source MIN_VOLT); -999999 -> null. "
      + VOLT_CAVEAT, "kV", None, 0, None),
    F("max_infer", "boolean", True, "True if max_volt_kv was inferred from connected lines rather than "
      "sourced (source MAX_INFER Y/N)."),
    F("min_infer", "boolean", True, "True if min_volt_kv was inferred (source MIN_INFER Y/N)."),
    F("source", "string", True, "Source reference (source SOURCE), usually a URL or imagery citation."),
    F("sourcedate", "date", True, "Date of source data (source SOURCEDATE, UTC)."),
    F("val_method", "string", True, "Validation method (source VAL_METHOD)."),
    F("val_date", "date", True, "Validation date (source VAL_DATE, UTC)."),
    F("latitude", "number", False, "Latitude of the point geometry, WGS84, 6 decimals.", "degrees", None, -90, 90),
    F("longitude", "number", False, "Longitude of the point geometry, WGS84, 6 decimals.", "degrees", None, -180, 180),
    F("distance_mi", "number", False, "Haversine distance (R=3958.8 mi) from Westminster High School "
      "(33.7538, -118.0111), 1 decimal.", "mi", None, 0, RADIUS_MI),
]

PLANT_FIELDS = [
    F("hifld_id", "integer", False, "HIFLD Power Plants record ID: the layer object ID (FID 1..13233, "
      "contiguous, in the source's PLANT_CODE order). The layer has no other unique ID because PLANT_CODE "
      "is duplicated for some plants. Primary key."),
    F("eia_plant_code", "integer", True, "EIA plant code (source PLANT_CODE parsed as integer; null when "
      "PLANT_CODE is a non-EIA HIFLD code such as 'NA02715'). Join key to eia860_plants.plant_code. "
      "NOT unique: HIFLD carries duplicate records for a few plants."),
    F("name", "string", True, "Plant name (source NAME); the placeholder 'UNKNOWN' -> null."),
    F("operator", "string", True, "Operating utility/company (source OPERATOR)."),
    F("city", "string", True, "City (source CITY)."),
    F("county", "string", True, "County name (source COUNTY)."),
    F("state", "string", True, "Two-letter state abbreviation (source STATE)."),
    F("status", "string", True, "Operating status (source STATUS; EIA-860 status codes: OP operating, "
      "SB standby, OS/OA out of service, RE retired, CN cancelled, IP indefinitely postponed, P planned, "
      "L regulatory approvals pending, T approved/not under construction, U/V under construction, "
      "TS construction complete/not yet operating)."),
    F("plant_type", "string", True, "Generation technology description(s) (source TYPE); multiple "
      "technologies are joined with '; '."),
    F("primary_fuel", "string", True, "Primary fuel / energy source code (source PRIM_FUEL; EIA energy "
      "source codes such as NG, SUN, WAT, MWH)."),
    F("total_mw", "number", True, "Operating (nameplate) capacity of the plant (source OPER_CAP); "
      "-999999 -> null.", "MW", None, 0, None),
    F("net_gen_mwh", "number", True, "Annual net generation (source NET_GEN); may be negative for "
      "storage/pumped hydro; -999999 -> null.", "MWh", None, None, None),
    F("source", "string", True, "Source reference (source SOURCE)."),
    F("sourcedate", "date", True, "Date of source data (source SOURCEDATE, UTC)."),
    F("latitude", "number", False, "Latitude of the point geometry, WGS84, 6 decimals.", "degrees", None, -90, 90),
    F("longitude", "number", False, "Longitude of the point geometry, WGS84, 6 decimals.", "degrees", None, -180, 180),
    F("distance_mi", "number", False, "Haversine distance (R=3958.8 mi) from Westminster High School "
      "(33.7538, -118.0111), 1 decimal.", "mi", None, 0, RADIUS_MI),
]

ENUM_FIELDS = {
    "hifld_substations": ["state", "type", "status", "naics_desc", "val_method"],
    "hifld_power_plants": ["state", "status", "plant_type", "primary_fuel"],
}


def map_substation(p: dict) -> OrderedDict:
    raw_id = norm_str(p.get("ID"))
    if raw_id is None or not raw_id.isdigit():
        raise ValueError("substation ID not numeric: %r" % p.get("ID"))
    return OrderedDict([
        ("hifld_id", int(raw_id)),
        ("name", norm_str(p.get("NAME"))),
        ("city", norm_str(p.get("CITY"))),
        ("state", norm_str(p.get("STATE"))),
        ("county", norm_str(p.get("COUNTY"))),
        ("zip", norm_str(p.get("ZIP"))),
        ("type", norm_str(p.get("TYPE"))),
        ("status", norm_str(p.get("STATUS"))),
        ("naics_desc", norm_str(p.get("NAICS_DESC"))),
        ("lines", norm_int(p.get("LINES"))),
        ("max_volt_kv", norm_num(p.get("MAX_VOLT"), 3, allow_negative=False)),
        ("min_volt_kv", norm_num(p.get("MIN_VOLT"), 3, allow_negative=False)),
        ("max_infer", norm_bool(p.get("MAX_INFER"))),
        ("min_infer", norm_bool(p.get("MIN_INFER"))),
        ("source", norm_str(p.get("SOURCE"))),
        ("sourcedate", norm_date(p.get("SOURCEDATE"))),
        ("val_method", norm_str(p.get("VAL_METHOD"))),
        ("val_date", norm_date(p.get("VAL_DATE"))),
    ])


def map_plant(p: dict) -> OrderedDict:
    fid = norm_int(p.get("FID"))
    if fid is None:
        raise ValueError("power plant without FID: %r" % p.get("NAME"))
    code = norm_str(p.get("PLANT_CODE"))
    eia = int(code) if code is not None and re.fullmatch(r"\d+", code) else None
    return OrderedDict([
        ("hifld_id", fid),
        ("eia_plant_code", eia),
        ("name", norm_str(p.get("NAME"))),
        ("operator", norm_str(p.get("OPERATOR"))),
        ("city", norm_str(p.get("CITY"))),
        ("county", norm_str(p.get("COUNTY"))),
        ("state", norm_str(p.get("STATE"))),
        ("status", norm_str(p.get("STATUS"))),
        ("plant_type", norm_str(p.get("TYPE"))),
        ("primary_fuel", norm_str(p.get("PRIM_FUEL"))),
        ("total_mw", norm_num(p.get("OPER_CAP"), 3, allow_negative=False)),
        ("net_gen_mwh", norm_num(p.get("NET_GEN"), 3, allow_negative=True)),
        ("source", norm_str(p.get("SOURCE"))),
        ("sourcedate", norm_date(p.get("SOURCEDATE"))),
    ])


DATASET_SPECS: Dict[str, Tuple[List[OrderedDict], Callable[[dict], OrderedDict]]] = {
    "hifld_substations": (SUBSTATION_FIELDS, map_substation),
    "hifld_power_plants": (PLANT_FIELDS, map_plant),
}


# --------------------------------------------------------------------------- build
def point_coords(feat: dict) -> Optional[Tuple[float, float]]:
    g = feat.get("geometry")
    if g and g.get("type") == "Point":
        c = g.get("coordinates") or []
        if len(c) >= 2 and c[0] is not None and c[1] is not None:
            x, y = float(c[0]), float(c[1])
            if math.isfinite(x) and math.isfinite(y) and -180 <= x <= 180 and -90 <= y <= 90:
                return x, y
    return None


def pk_sort_key(v: Any) -> Tuple:
    if isinstance(v, int):
        return (0, v, "")
    s = str(v)
    return (0, int(s), "") if s.isdigit() else (1, 0, s)


def build(dataset: str, entry: dict, stats: Counter) -> List[OrderedDict]:
    fields, mapper = DATASET_SPECS[dataset]
    rows: Dict[Any, OrderedDict] = {}
    for feat in load_features(entry):
        stats["raw_in_bbox"] += 1
        props = feat.get("properties") or {}
        xy = point_coords(feat)
        if xy is None:
            stats["dropped_no_geometry"] += 1
            continue
        lon, lat = round(xy[0], 6), round(xy[1], 6)
        d = haversine_mi(CENTER_LAT, CENTER_LON, xy[1], xy[0])
        if d > RADIUS_MI:
            stats["outside_radius"] += 1
            continue
        row = mapper(props)
        row["latitude"] = lat
        row["longitude"] = lon
        row["distance_mi"] = round(d, 1)
        pk = row["hifld_id"]
        if pk in rows:
            raise RuntimeError("%s: duplicate primary key %r" % (dataset, pk))
        rows[pk] = row
        # attribute vs geometry consistency check (informational)
        try:
            alat, alon = float(props.get("LATITUDE")), float(props.get("LONGITUDE"))
            if haversine_mi(alat, alon, xy[1], xy[0]) > 0.1:
                stats["attr_latlon_differs_from_geometry_gt_0.1mi"] += 1
        except (TypeError, ValueError):
            pass
    out = [rows[k] for k in sorted(rows, key=pk_sort_key)]
    names = [f["name"] for f in fields]
    for r in out:
        if list(r.keys()) != names:
            raise RuntimeError("%s: column mismatch %s" % (dataset, list(r.keys())))
    stats["kept"] = len(out)
    return out


def write_csv(path: str, fields: List[OrderedDict], rows: List[OrderedDict]) -> None:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow([f["name"] for f in fields])
    for r in rows:
        w.writerow([fmt_csv(r[f["name"]]) for f in fields])
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(buf.getvalue())


def write_geojson(path: str, dataset: str, fields: List[OrderedDict], rows: List[OrderedDict], src: dict) -> None:
    feats = []
    for r in rows:
        props = OrderedDict((f["name"], r[f["name"]]) for f in fields)
        feats.append(OrderedDict([
            ("type", "Feature"),
            ("geometry", OrderedDict([("type", "Point"), ("coordinates", [r["longitude"], r["latitude"]])])),
            ("properties", props),
        ]))
    fc = OrderedDict([("type", "FeatureCollection"), ("features", feats)])
    text = json.dumps(fc, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
        fh.write("\n")


def write_schema(path: str, dataset: str, fields: List[OrderedDict], rows: List[OrderedDict], src: dict) -> None:
    out_fields = []
    for f in fields:
        f = OrderedDict(f)
        if f["name"] in ENUM_FIELDS[dataset]:
            f["enum"] = sorted({r[f["name"]] for r in rows if r[f["name"]] is not None})
        if not f["nullable"] and any(r[f["name"]] is None for r in rows):
            raise RuntimeError("%s.%s declared non-null but has nulls" % (dataset, f["name"]))
        out_fields.append(f)
    schema = OrderedDict([
        ("dataset", dataset),
        ("primary_key", ["hifld_id"]),
        ("geometry_type", "Point"),
        ("source", OrderedDict([("name", src["source_name"]), ("url", src["layer_url"]),
                                ("vintage", src["vintage"])])),
        ("fields", out_fields),
    ])
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(schema, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--refresh", action="store_true", help="re-download raw data even if cached")
    ap.add_argument("--allow-shrink", action="store_true",
                    help="accept a download below %d%% of the previous bbox count" % (SHRINK_RATIO * 100))
    args = ap.parse_args()
    try:
        meta = acquire(args.refresh, args.allow_shrink)
        summary = []
        for ds in SOURCES:
            entry = meta["datasets"][ds]
            stats: Counter = Counter()
            rows = build(ds, entry, stats)
            if not rows:
                raise RuntimeError("%s: no rows within radius" % ds)
            fields = DATASET_SPECS[ds][0]
            for sub in ("clean", "layers", "schemas"):
                os.makedirs(os.path.join(RESEARCH, sub), exist_ok=True)
            write_csv(os.path.join(RESEARCH, "clean", ds + ".csv"), fields, rows)
            write_geojson(os.path.join(RESEARCH, "layers", ds + ".geojson"), ds, fields, rows, entry)
            write_schema(os.path.join(RESEARCH, "schemas", ds + ".schema.json"), ds, fields, rows, entry)
            log("%s: %s" % (ds, dict(sorted(stats.items()))))
            summary.append("%s=%d (bbox %d)" % (ds, stats["kept"], stats["raw_in_bbox"]))
        print("fetch_hifld_points: " + ", ".join(summary))
        return 0
    except Exception as e:  # noqa: BLE001
        log("ERROR: %s" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
