#!/usr/bin/env python3
"""Fetch HIFLD "Electric Power Transmission Lines" for a 100-mile radius around
Westminster High School (Westminster, CA) and write clean CSV / GeoJSON / schema.

HIFLD Open (hifld-geoplatform.opendata.arcgis.com) was retired in 2025. This script
queries ArcGIS REST FeatureServers that still serve the HIFLD layer, in order:

  1. Esri Living Atlas / Federal User Community archive
     "U.S. Electric Power Transmission Lines (Archive)" (item d4090758322c4d32a4cd002ffaa0aa12),
     HIFLD data currency 2024-09-30.
  2. GeoPlatform ArcGIS Online (HIFLD Open host org Hp6G80Pky0om7QvQ)
     "Electric_Power_Transmission_Lines" (item 8ac33965336e498cbe35cd238b3f1ee6), last edit 2023-09-05.

Only source 1 is used unless --allow-fallback is passed: source 2 is an older
release without the 'UNDER 100' kV lines, so silently falling back to it would shrink
the dataset by about 70%. Because of the row-count floor below, accepting that older
copy needs --allow-shrink as well.

Raw query pages are cached in research/raw/hifld_transmission/. Re-runs reuse the
cache; pass --refresh to re-download. A re-download goes into a sibling temp directory
and replaces the cache only after it is complete and passes the row-count floor, so a
failed or shrunken download leaves the existing cache and outputs untouched. Output is
deterministic for a given cache.

Usage:  python research/scripts/fetch_hifld_transmission.py [--refresh]
            [--allow-fallback] [--allow-shrink]
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
from typing import Any, Dict, List, Optional, Tuple

import requests

# --------------------------------------------------------------------------- config
DATASET = "hifld_transmission"
RESEARCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(RESEARCH, "raw", DATASET)
CLEAN_CSV = os.path.join(RESEARCH, "clean", DATASET + ".csv")
LAYER_GEOJSON = os.path.join(RESEARCH, "layers", DATASET + ".geojson")
SCHEMA_JSON = os.path.join(RESEARCH, "schemas", DATASET + ".schema.json")

CENTER_LAT = 33.7538
CENTER_LON = -118.0111
RADIUS_MI = 100.0
EARTH_RADIUS_MI = 3958.8
BBOX = (-119.76, 32.29, -116.26, 35.21)  # xmin, ymin, xmax, ymax (lon/lat)
PAGE_SIZE = 1000
# Row-count floor: the 2024-09-30 primary release has 1,796 features in the bbox. A
# download below MIN_RAW_IN_BBOX, or below SHRINK_RATIO of the previous download, is
# refused unless --allow-shrink is passed.
MIN_RAW_IN_BBOX = 1500
SHRINK_RATIO = 0.9

SOURCES = [
    {
        "key": "living_atlas_archive",
        "name": "HIFLD Electric Power Transmission Lines via Esri Living Atlas "
                "(Federal User Community) 'U.S. Electric Power Transmission Lines (Archive)'",
        "item_id": "d4090758322c4d32a4cd002ffaa0aa12",
        "item_url": "https://www.arcgis.com/home/item.html?id=d4090758322c4d32a4cd002ffaa0aa12",
        "layer_url": "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/"
                     "US_Electric_Power_Transmission_Lines/FeatureServer/0",
        "vintage": "2024-09-30",
    },
    {
        "key": "geoplatform_hifld_open",
        "name": "HIFLD Electric Power Transmission Lines via GeoPlatform ArcGIS Online "
                "(former HIFLD Open host org)",
        "item_id": "8ac33965336e498cbe35cd238b3f1ee6",
        "item_url": "https://www.arcgis.com/home/item.html?id=8ac33965336e498cbe35cd238b3f1ee6",
        "layer_url": "https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/"
                     "Electric_Power_Transmission_Lines/FeatureServer/0",
        "vintage": "2023-09-05",
    },
]

NULL_STRINGS = {"", "NOT AVAILABLE", "UNKNOWN", "N/A", "NA", "NONE", "NULL", "-", "-999999"}
NULL_NUMBER = -999999.0

COLUMNS = [
    "hifld_id", "owner", "status", "type", "voltage_kv", "volt_class", "inferred",
    "sub_1", "sub_2", "naics_desc", "source", "sourcedate", "val_method", "val_date",
    "shape_length_mi", "distance_mi", "vertex_count",
]


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


# --------------------------------------------------------------------------- geometry
def haversine_mi(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(min(1.0, math.sqrt(a)))


_WGS84_A = 6378137.0
_WGS84_F = 1 / 298.257223563
_WGS84_B = _WGS84_A * (1 - _WGS84_F)
_M_PER_MI = 1609.344


def vincenty_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Geodesic distance on the WGS84 ellipsoid (Vincenty inverse), metres."""
    if lat1 == lat2 and lon1 == lon2:
        return 0.0
    a, b, f = _WGS84_A, _WGS84_B, _WGS84_F
    L = math.radians(lon2 - lon1)
    U1 = math.atan((1 - f) * math.tan(math.radians(lat1)))
    U2 = math.atan((1 - f) * math.tan(math.radians(lat2)))
    sinU1, cosU1, sinU2, cosU2 = math.sin(U1), math.cos(U1), math.sin(U2), math.cos(U2)
    lam = L
    for _ in range(200):
        sinLam, cosLam = math.sin(lam), math.cos(lam)
        sinSigma = math.sqrt((cosU2 * sinLam) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLam) ** 2)
        if sinSigma == 0:
            return 0.0
        cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLam
        sigma = math.atan2(sinSigma, cosSigma)
        sinAlpha = cosU1 * cosU2 * sinLam / sinSigma
        cos2Alpha = 1 - sinAlpha ** 2
        cos2SigmaM = cosSigma - 2 * sinU1 * sinU2 / cos2Alpha if cos2Alpha != 0 else 0.0
        C = f / 16 * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha))
        lam_prev = lam
        lam = L + (1 - C) * f * sinAlpha * (
            sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)))
        if abs(lam - lam_prev) < 1e-12:
            break
    else:  # no convergence (near-antipodal; impossible at this scale) -> spherical fallback
        return haversine_mi(lat1, lon1, lat2, lon2) * _M_PER_MI
    u2 = cos2Alpha * (a * a - b * b) / (b * b)
    A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)))
    B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)))
    dSigma = B * sinSigma * (cos2SigmaM + B / 4 * (
        cosSigma * (-1 + 2 * cos2SigmaM ** 2)
        - B / 6 * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)))
    return b * A * (sigma - dSigma)


def part_length_mi(part: List[List[float]]) -> float:
    total = 0.0
    for (x1, y1), (x2, y2) in zip(part, part[1:]):
        total += vincenty_m(y1, x1, y2, x2)
    return total / _M_PER_MI


def clean_parts(geom: Optional[dict]) -> Tuple[Optional[str], List[List[List[float]]]]:
    """Return (type, parts) with coords rounded to 6 dp, consecutive duplicate
    vertices removed, and degenerate parts (<2 vertices) dropped."""
    if not geom or geom.get("type") not in ("LineString", "MultiLineString"):
        return (geom or {}).get("type"), []
    raw_parts = [geom.get("coordinates") or []] if geom["type"] == "LineString" else (geom.get("coordinates") or [])
    parts = []
    for rp in raw_parts:
        out: List[List[float]] = []
        for pt in rp or []:
            if pt is None or len(pt) < 2:
                continue
            x, y = float(pt[0]), float(pt[1])
            if not (math.isfinite(x) and math.isfinite(y)):
                continue
            q = [round(x, 6), round(y, 6)]
            if q[0] == 0.0:
                q[0] = 0.0  # normalise -0.0
            if q[1] == 0.0:
                q[1] = 0.0
            if not out or out[-1] != q:
                out.append(q)
        if len(out) >= 2:
            parts.append(out)
    return geom["type"], parts


# --------------------------------------------------------------------------- normalisation
_ws = re.compile(r"\s+")


def norm_str(v: Any) -> Optional[str]:
    if v is None:
        return None
    s = _ws.sub(" ", str(v)).strip()
    if s.upper() in NULL_STRINGS:
        return None
    return s


def norm_voltage(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f == NULL_NUMBER or f <= 0:
        return None
    return f


def norm_date(v: Any) -> Optional[str]:
    """ArcGIS dates arrive as epoch milliseconds (UTC)."""
    if v is None or v == "":
        return None
    try:
        ms = float(v)
    except (TypeError, ValueError):
        s = str(v).strip()
        m = re.match(r"^(\d{4})[-/](\d{2})[-/](\d{2})", s)
        return "%s-%s-%s" % m.groups() if m else None
    if ms == NULL_NUMBER or ms <= -2208988800000:  # placeholder / before 1900
        return None
    d = dt.datetime(1970, 1, 1) + dt.timedelta(milliseconds=ms)
    return d.strftime("%Y-%m-%d")


def norm_bool(v: Any) -> Optional[bool]:
    s = norm_str(v)
    if s is None:
        return None
    s = s.upper()
    if s in ("Y", "YES", "TRUE", "T", "1"):
        return True
    if s in ("N", "NO", "FALSE", "F", "0"):
        return False
    return None


def fmt_num(v: Optional[float]) -> str:
    if v is None:
        return ""
    if float(v).is_integer():
        return str(int(v))
    return repr(float(v))


# --------------------------------------------------------------------------- download
def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


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


def download(source: dict, dest_dir: str) -> dict:
    """Download every raw file plus SOURCE.json into dest_dir (an empty temp dir)."""
    session = requests.Session()
    session.headers["User-Agent"] = "research-data-pipeline/1.0"
    layer_url = source["layer_url"]
    os.makedirs(dest_dir, exist_ok=True)

    files = []
    info, info_bytes = get_json(session, layer_url, {"f": "json"})
    with open(os.path.join(dest_dir, "layer_info.json"), "wb") as fh:
        fh.write(info_bytes)
    files.append("layer_info.json")
    try:
        _, item_bytes = get_json(session, "https://www.arcgis.com/sharing/rest/content/items/%s" % source["item_id"], {"f": "json"})
        with open(os.path.join(dest_dir, "item_info.json"), "wb") as fh:
            fh.write(item_bytes)
        files.append("item_info.json")
    except Exception as e:  # noqa: BLE001
        log("warning: could not fetch item metadata: %s" % e)

    base_params = {
        "where": "1=1",
        "geometry": "%s,%s,%s,%s" % BBOX,
        "geometryType": "esriGeometryEnvelope",
        "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "outSR": 4326,
        "outFields": "*",
        "returnGeometry": "true",
        "orderByFields": "OBJECTID_1 ASC",
        "f": "geojson",
    }
    count_params = dict(base_params, returnCountOnly="true", f="json")
    count_params.pop("orderByFields")
    cnt, _ = get_json(session, layer_url + "/query", count_params)
    expected = int(cnt.get("count", -1))

    offset, page, total = 0, 0, 0
    while True:
        params = dict(base_params, resultOffset=offset, resultRecordCount=PAGE_SIZE)
        data, content = get_json(session, layer_url + "/query", params)
        feats = data.get("features")
        if feats is None:
            raise RuntimeError("unexpected response (no features) at offset %d" % offset)
        fn = "page_%03d.geojson" % page
        with open(os.path.join(dest_dir, fn), "wb") as fh:
            fh.write(content)
        files.append(fn)
        total += len(feats)
        exceeded = bool((data.get("properties") or {}).get("exceededTransferLimit") or data.get("exceededTransferLimit"))
        if not exceeded or not feats:
            break
        offset += len(feats)
        page += 1
        if page > 500:
            raise RuntimeError("pagination runaway")
    if expected >= 0 and total != expected:
        raise RuntimeError("downloaded %d features but server count is %d" % (total, expected))

    meta = OrderedDict([
        ("source_key", source["key"]),
        ("source_name", source["name"]),
        ("item_url", source["item_url"]),
        ("layer_url", layer_url),
        ("query_url", layer_url + "/query"),
        ("query_params", OrderedDict(sorted({k: str(v) for k, v in base_params.items()}.items()))),
        ("page_size", PAGE_SIZE),
        ("server_count_in_bbox", expected),
        ("vintage", source["vintage"]),
        ("retrieval_date", dt.date.today().isoformat()),
        ("files", [OrderedDict([("file", f), ("sha256", sha256_file(os.path.join(dest_dir, f))),
                                ("bytes", os.path.getsize(os.path.join(dest_dir, f)))]) for f in files]),
        ("sources_tried_order", [s["layer_url"] for s in SOURCES]),
    ])
    with open(os.path.join(dest_dir, "SOURCE.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(meta, fh, indent=2)
        fh.write("\n")
    return meta


def read_source_json(raw_dir: str) -> Optional[dict]:
    p = os.path.join(raw_dir, "SOURCE.json")
    if not os.path.exists(p):
        return None
    try:
        with open(p, encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, ValueError):
        return None
    return meta if isinstance(meta, dict) else None


def load_cache() -> Optional[dict]:
    meta = read_source_json(RAW_DIR)
    if meta is None:
        return None
    for f in meta.get("files", []):
        fp = os.path.join(RAW_DIR, f["file"])
        if not os.path.exists(fp) or sha256_file(fp) != f["sha256"]:
            log("cache invalid (%s missing or changed); re-downloading" % f["file"])
            return None
    return meta


def check_floor(count: int, previous: Optional[dict], allow_shrink: bool) -> None:
    """Refuse a download that is implausibly small (lost lines / older release)."""
    if allow_shrink:
        return
    if count < MIN_RAW_IN_BBOX:
        raise RuntimeError("only %d features in bbox (< floor %d); refusing to replace the cache "
                           "(pass --allow-shrink to accept)" % (count, MIN_RAW_IN_BBOX))
    prev = (previous or {}).get("server_count_in_bbox")
    if isinstance(prev, int) and prev > 0 and count < SHRINK_RATIO * prev:
        raise RuntimeError("only %d features in bbox, below %d%% of the previous download (%d); refusing to "
                           "replace the cache (pass --allow-shrink to accept)" % (count, SHRINK_RATIO * 100, prev))


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


def acquire(refresh: bool, allow_fallback: bool = False, allow_shrink: bool = False) -> dict:
    if not refresh:
        meta = load_cache()
        if meta:
            return meta
    previous = read_source_json(RAW_DIR)
    sources = SOURCES if allow_fallback else SOURCES[:1]
    errors = []
    for src in sources:
        tmp = RAW_DIR + ".tmp-%d" % os.getpid()
        shutil.rmtree(tmp, ignore_errors=True)
        try:
            log("downloading from %s" % src["layer_url"])
            meta = download(src, tmp)
            check_floor(int(meta["server_count_in_bbox"]), previous, allow_shrink)
            swap_in(tmp)
            return meta
        except Exception as e:  # noqa: BLE001
            shutil.rmtree(tmp, ignore_errors=True)
            log("source %s failed: %s" % (src["key"], e))
            errors.append("%s: %s" % (src["key"], e))
    if not allow_fallback:
        raise RuntimeError("primary source failed (%s); existing cache and outputs left untouched. "
                           "Pass --allow-fallback to try the older GeoPlatform copy." % "; ".join(errors))
    raise RuntimeError("all sources failed: " + "; ".join(errors))


# --------------------------------------------------------------------------- build
def build(meta: dict) -> Tuple[List[dict], List[dict], dict]:
    raw_feats: List[dict] = []
    for f in meta["files"]:
        if f["file"].startswith("page_"):
            with open(os.path.join(RAW_DIR, f["file"]), encoding="utf-8") as fh:
                raw_feats.extend(json.load(fh).get("features") or [])

    stats = Counter()
    stats["raw_in_bbox"] = len(raw_feats)
    candidates = []
    for feat in raw_feats:
        props = feat.get("properties") or {}
        gtype, parts = clean_parts(feat.get("geometry"))
        if not parts:
            stats["dropped_empty_geometry"] += 1
            continue
        length = sum(part_length_mi(p) for p in parts)
        if length <= 0:
            stats["dropped_zero_length"] += 1
            continue
        dmin = min(haversine_mi(CENTER_LAT, CENTER_LON, y, x) for p in parts for x, y in p)
        if dmin > RADIUS_MI:
            stats["outside_radius"] += 1
            continue
        raw_id = norm_str(props.get("ID"))
        try:
            hid = int(raw_id) if raw_id is not None else None
        except ValueError:
            hid = None
        if hid is None:
            stats["dropped_null_or_nonnumeric_id"] += 1
            log("dropping feature OBJECTID=%s with unusable ID %r" % (props.get("OBJECTID"), props.get("ID")))
            continue
        if gtype == "MultiLineString":
            geom = {"type": "MultiLineString", "coordinates": parts}
        else:
            geom = {"type": "LineString", "coordinates": parts[0]}
        row = OrderedDict([
            ("hifld_id", hid),
            ("owner", norm_str(props.get("OWNER"))),
            ("status", norm_str(props.get("STATUS"))),
            ("type", norm_str(props.get("TYPE"))),
            ("voltage_kv", norm_voltage(props.get("VOLTAGE"))),
            ("volt_class", norm_str(props.get("VOLT_CLASS"))),
            ("inferred", norm_bool(props.get("INFERRED"))),
            ("sub_1", norm_str(props.get("SUB_1"))),
            ("sub_2", norm_str(props.get("SUB_2"))),
            ("naics_desc", norm_str(props.get("NAICS_DESC"))),
            ("source", norm_str(props.get("SOURCE"))),
            ("sourcedate", norm_date(props.get("SOURCEDATE"))),
            ("val_method", norm_str(props.get("VAL_METHOD"))),
            ("val_date", norm_date(props.get("VAL_DATE"))),
            ("shape_length_mi", round(length, 2)),
            ("distance_mi", round(dmin, 1)),
            ("vertex_count", sum(len(p) for p in parts)),
        ])
        # placeholder accounting
        for col, src in (("owner", "OWNER"), ("status", "STATUS"), ("type", "TYPE"), ("volt_class", "VOLT_CLASS"),
                         ("sub_1", "SUB_1"), ("sub_2", "SUB_2"), ("naics_desc", "NAICS_DESC"),
                         ("source", "SOURCE"), ("val_method", "VAL_METHOD"), ("inferred", "INFERRED")):
            rv = props.get(src)
            if rv is not None and row[col] is None:
                stats["placeholder_nulled_" + col] += 1
        if props.get("VOLTAGE") is not None and row["voltage_kv"] is None:
            stats["placeholder_nulled_voltage_kv"] += 1
        oid = props.get("OBJECTID")
        oid1 = props.get("OBJECTID_1", feat.get("id"))
        sort_oid = (oid if oid is not None else float("inf"), oid1 if oid1 is not None else float("inf"))
        candidates.append((hid, sort_oid, row, geom, oid))

    candidates.sort(key=lambda c: (c[0], c[1]))
    rows, geoms = [], []
    seen = set()
    for hid, _, row, geom, oid in candidates:
        if hid in seen:
            stats["dropped_duplicate_id"] += 1
            log("duplicate hifld_id %d: dropping OBJECTID=%s (kept lower OBJECTID)" % (hid, oid))
            continue
        seen.add(hid)
        rows.append(row)
        geoms.append(geom)
    stats["kept"] = len(rows)
    return rows, geoms, dict(stats)


def write_csv(rows: List[dict]) -> None:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
    w.writerow(COLUMNS)
    for r in rows:
        out = []
        for c in COLUMNS:
            v = r[c]
            if v is None:
                out.append("")
            elif isinstance(v, bool):
                out.append("true" if v else "false")
            elif isinstance(v, int):
                out.append(str(v))
            elif isinstance(v, float):
                out.append(fmt_num(v))
            else:
                out.append(v)
        w.writerow(out)
    os.makedirs(os.path.dirname(CLEAN_CSV), exist_ok=True)
    with open(CLEAN_CSV, "w", encoding="utf-8", newline="") as fh:
        fh.write(buf.getvalue())


def write_geojson(rows: List[dict], geoms: List[dict]) -> None:
    feats = []
    for r, g in zip(rows, geoms):
        props = OrderedDict()
        for c in COLUMNS:
            v = r[c]
            if c == "voltage_kv" and v is not None and float(v).is_integer():
                v = int(v)  # keep JSON tidy; schema type is "number"
            props[c] = v
        feats.append(OrderedDict([("type", "Feature"), ("geometry", g), ("properties", props)]))
    fc = OrderedDict([("type", "FeatureCollection"), ("features", feats)])
    os.makedirs(os.path.dirname(LAYER_GEOJSON), exist_ok=True)
    with open(LAYER_GEOJSON, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(fc, fh, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        fh.write("\n")


def write_schema(meta: dict, rows: List[dict]) -> None:
    def rng(col: str) -> Tuple[Optional[float], Optional[float]]:
        vals = [r[col] for r in rows if r[col] is not None]
        return (min(vals), max(vals)) if vals else (None, None)

    def enum(col: str) -> Optional[List[str]]:
        vals = sorted({r[col] for r in rows if r[col] is not None})
        return vals or None

    def nullable(col: str) -> bool:
        return any(r[col] is None for r in rows)

    def fld(name, typ, desc, unit=None, en=None, mn=None, mx=None, null=None):
        return OrderedDict([("name", name), ("type", typ),
                            ("nullable", nullable(name) if null is None else null),
                            ("description", desc), ("unit", unit), ("enum", en), ("min", mn), ("max", mx)])

    vmin, vmax = rng("voltage_kv")
    lmin, lmax = rng("shape_length_mi")
    dmin, dmax = rng("distance_mi")
    cmin, cmax = rng("vertex_count")
    imin, imax = rng("hifld_id")
    schema = OrderedDict([
        ("dataset", DATASET),
        ("primary_key", ["hifld_id"]),
        ("geometry_type", "LineString|MultiLineString"),
        ("source", OrderedDict([("name", meta["source_name"]), ("url", meta["layer_url"]),
                                ("vintage", meta["vintage"])])),
        ("fields", [
            fld("hifld_id", "integer", "HIFLD transmission line unique identifier (source field ID, cast to int).",
                mn=imin, mx=imax, null=False),
            fld("owner", "string", "Transmission line ownership entity (OWNER). 'NOT AVAILABLE'/'UNKNOWN' -> null."),
            fld("status", "string", "Operational status of line (STATUS).", en=enum("status")),
            fld("type", "string", "Line type as given by HIFLD, e.g. AC/DC and overhead/underground (TYPE).",
                en=enum("type")),
            fld("voltage_kv", "number", "Line voltage in kilovolts (VOLTAGE). -999999 and non-positive placeholders -> null.",
                unit="kV", mn=vmin, mx=vmax),
            fld("volt_class", "string", "HIFLD voltage class bucket (VOLT_CLASS). 'NOT AVAILABLE' -> null.",
                en=enum("volt_class")),
            fld("inferred", "boolean", "Whether attributes (voltage) were inferred by HIFLD (INFERRED Y/N)."),
            fld("sub_1", "string", "Origin substation name (SUB_1). Placeholders -> null."),
            fld("sub_2", "string", "Destination substation name (SUB_2). Placeholders -> null."),
            fld("naics_desc", "string", "NAICS description (NAICS_DESC).", en=enum("naics_desc")),
            fld("source", "string", "Data source reference (SOURCE), often a URL or imagery citation."),
            fld("sourcedate", "date", "Data source publication date (SOURCEDATE, UTC date of epoch ms)."),
            fld("val_method", "string", "Validation method (VAL_METHOD).", en=enum("val_method")),
            fld("val_date", "date", "Validation date (VAL_DATE, UTC date of epoch ms)."),
            fld("shape_length_mi", "number",
                "Geodesic length of the delivered geometry on the WGS84 ellipsoid (Vincenty), full line not clipped, 2 dp.",
                unit="mi", mn=lmin, mx=lmax, null=False),
            fld("distance_mi", "number",
                "Haversine distance (R=3958.8 mi) from Westminster High School (33.7538,-118.0111) to the nearest vertex, 1 dp.",
                unit="mi", mn=dmin, mx=dmax, null=False),
            fld("vertex_count", "integer", "Number of vertices in the delivered geometry (all parts).",
                mn=cmin, mx=cmax, null=False),
        ]),
    ])
    os.makedirs(os.path.dirname(SCHEMA_JSON), exist_ok=True)
    with open(SCHEMA_JSON, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(schema, fh, indent=2, ensure_ascii=False, allow_nan=False)
        fh.write("\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--refresh", action="store_true", help="re-download raw data even if cached")
    ap.add_argument("--allow-fallback", action="store_true",
                    help="if the primary (Living Atlas archive) source fails, try the older GeoPlatform copy")
    ap.add_argument("--allow-shrink", action="store_true",
                    help="accept a download below the row-count floor (%d, or %d%% of the previous download)"
                         % (MIN_RAW_IN_BBOX, SHRINK_RATIO * 100))
    args = ap.parse_args()
    try:
        meta = acquire(args.refresh, args.allow_fallback, args.allow_shrink)
        rows, geoms, stats = build(meta)
        if not rows:
            raise RuntimeError("no rows produced")
        if stats["raw_in_bbox"] < MIN_RAW_IN_BBOX and not args.allow_shrink:
            raise RuntimeError("only %d raw features in bbox (< floor %d); outputs not written "
                               "(pass --allow-shrink to accept)" % (stats["raw_in_bbox"], MIN_RAW_IN_BBOX))
        write_csv(rows)
        write_geojson(rows, geoms)
        write_schema(meta, rows)
    except Exception as e:  # noqa: BLE001
        log("ERROR: %s" % e)
        return 1
    vc = Counter(r["volt_class"] or "(null)" for r in rows)
    log("stats: " + json.dumps(stats, sort_keys=True))
    log("volt_class: " + json.dumps(dict(sorted(vc.items())), sort_keys=True))
    print("%s: source=%s raw_in_bbox=%d kept=%d dropped_geom=%d dropped_dup=%d (by volt_class: %s)" % (
        DATASET, meta["source_key"], stats.get("raw_in_bbox", 0), stats["kept"],
        stats.get("dropped_empty_geometry", 0) + stats.get("dropped_zero_length", 0),
        stats.get("dropped_duplicate_id", 0),
        ", ".join("%s=%d" % kv for kv in sorted(vc.items()))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
