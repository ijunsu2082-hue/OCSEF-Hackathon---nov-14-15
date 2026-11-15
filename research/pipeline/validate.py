"""Schema-driven validator for research/clean/*.csv and research/layers/*.geojson.

Every dataset is discovered from research/schemas/<dataset>.schema.json. The schema's
"fields" list describes the CSV columns (and the GeoJSON properties unless an optional
"geojson_fields" list is given). Issues are errors (contract violations; exit 1) or
warnings (reported, never fatal).

    python -m pipeline validate [--dataset NAME ...] [--json report.json]
"""

import csv
import datetime as _dt
import io
import json
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .common import (
    ALLOWED_GEOMETRIES,
    COORD_DECIMALS,
    FIELD_TYPES,
    RADIUS_MI,
    REFERENCE_RULES,
    REGION_TOLERANCE_MI,
    SANE_LAT,
    SANE_LON,
    SNAKE_RE,
    Paths,
    discover_datasets,
    distance_to_center_mi,
    geometry_types_of,
    load_json_file,
    normalize_key,
    resolve_files,
)

ERROR = "error"
WARNING = "warning"
INFO = "info"

# Cell values that are a leaked null / sentinel rather than real data. Compared
# case-insensitively after stripping. Empty string is the only valid null.
NULL_TOKENS = {
    "nan", "none", "null", "nat", "<na>", "#n/a", "n/a", "-", "not available",
    "unknown", "tbd", "tba",
    "-999999", "-999999.0", "inf", "-inf", "infinity", "-infinity",
}
SENTINEL_NUMBERS = {-999999.0}

# CSV latitude/longitude vs self-reported distance_mi: the producer rounds the
# distance (computed from unrounded coordinates) to 1 decimal.
DISTANCE_TOLERANCE_MI = 0.051
# CSV latitude/longitude vs GeoJSON Point coordinates (both rounded to 6 dp).
COORD_TOLERANCE_DEG = 1e-6
# CSV value vs GeoJSON property value for numbers.
NUMBER_TOLERANCE = 1e-9

# Cross-field sanity rules applied to any dataset that has both columns:
# (lower column, upper column, level, note). Known source errors are warnings so the
# count stays visible on every run without failing it.
CROSS_FIELD_RULES = [
    ("min_volt_kv", "max_volt_kv", "warning", "known HIFLD source error, kept as-is"),
]

INT_RE = re.compile(r"^-?(?:0|[1-9]\d*)$")
NUM_RE = re.compile(r"^-?\d+(?:\.\d+)?$")
NUM_EXP_RE = re.compile(r"^-?\d+(?:\.\d+)?[eE][-+]?\d+$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
BAD_WS_RE = re.compile(r"\s{2,}|[\t\n\r\f\v ]")

MAX_EXAMPLES = 5


# ---- Issue collection --------------------------------------------------------


class DatasetResult:
    def __init__(self, dataset: str):
        self.dataset = dataset
        self.issues: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        self.csv_rows: Optional[int] = None
        self.feature_count: Optional[int] = None
        self.schema: Optional[Dict[str, Any]] = None
        # column name -> list of typed values (CSV preferred, else GeoJSON props)
        self.columns: Dict[str, List[Any]] = {}
        self.csv_keys: Optional[List[tuple]] = None
        self.geo_keys: Optional[List[tuple]] = None
        self.csv_path: Optional[Path] = None
        self.geo_path: Optional[Path] = None
        # primary key -> typed CSV row (first occurrence), for twin comparisons
        self.csv_records: Dict[tuple, Dict[str, Any]] = {}
        # primary key -> (typed GeoJSON properties, Point [lon, lat] or None)
        self.geo_records: Dict[tuple, Tuple[Dict[str, Any], Optional[Tuple[float, float]]]] = {}

    def add(self, level: str, code: str, message: str, example: Optional[str] = None) -> None:
        key = (level, code, message)
        entry = self.issues.get(key)
        if entry is None:
            entry = {"level": level, "code": code, "message": message, "count": 0, "examples": []}
            self.issues[key] = entry
        entry["count"] += 1
        if example is not None and len(entry["examples"]) < MAX_EXAMPLES:
            entry["examples"].append(example)

    def _of(self, level: str) -> List[Dict[str, Any]]:
        return [e for e in self.issues.values() if e["level"] == level]

    @property
    def errors(self) -> List[Dict[str, Any]]:
        return self._of(ERROR)

    @property
    def warnings(self) -> List[Dict[str, Any]]:
        return self._of(WARNING)

    @property
    def infos(self) -> List[Dict[str, Any]]:
        return self._of(INFO)

    def codes(self, level: Optional[str] = None) -> List[str]:
        return sorted({e["code"] for e in self.issues.values() if level is None or e["level"] == level})

    @property
    def status(self) -> str:
        if self.errors:
            return "fail"
        if self.warnings:
            return "warn"
        return "pass"

    @property
    def row_count(self) -> Optional[int]:
        return self.csv_rows if self.csv_rows is not None else self.feature_count

    def to_dict(self) -> Dict[str, Any]:
        return {
            "dataset": self.dataset,
            "status": self.status,
            "csv_rows": self.csv_rows,
            "feature_count": self.feature_count,
            "errors": self.errors,
            "warnings": self.warnings,
            "infos": self.infos,
        }


class Report:
    def __init__(self):
        self.results: Dict[str, DatasetResult] = {}
        self.global_errors: List[str] = []

    @property
    def ok(self) -> bool:
        return not self.global_errors and all(not r.errors for r in self.results.values())

    def error_count(self) -> int:
        return len(self.global_errors) + sum(len(r.errors) for r in self.results.values())

    def warning_count(self) -> int:
        return sum(len(r.warnings) for r in self.results.values())

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "global_errors": self.global_errors,
            "datasets": [self.results[k].to_dict() for k in sorted(self.results)],
        }

    def format(self) -> str:
        lines = []
        for g in self.global_errors:
            lines.append("ERROR %s" % g)
        for name in sorted(self.results):
            r = self.results[name]
            lines.append(
                "%s %s (csv_rows=%s, features=%s) errors=%d warnings=%d"
                % (r.status.upper(), name, _fmt(r.csv_rows), _fmt(r.feature_count), len(r.errors), len(r.warnings))
            )
            for e in r.errors + r.warnings + r.infos:
                ex = ""
                if e["examples"]:
                    ex = " e.g. " + "; ".join(e["examples"])
                lines.append("  %-7s [%s] %s (x%d)%s" % (e["level"], e["code"], e["message"], e["count"], ex))
        lines.append(
            "validate: %d dataset(s), %d error(s), %d warning(s) -> %s"
            % (len(self.results), self.error_count(), self.warning_count(), "OK" if self.ok else "FAIL")
        )
        return "\n".join(lines)


def _fmt(v: Optional[int]) -> str:
    return "-" if v is None else str(v)


# ---- Schema checks -----------------------------------------------------------


def check_schema(schema: Any, dataset: str, res: DatasetResult) -> bool:
    """Validate the schema document itself. Returns False if unusable."""
    if not isinstance(schema, dict):
        res.add(ERROR, "schema.shape", "schema is not a JSON object")
        return False
    usable = True
    if schema.get("dataset") != dataset:
        res.add(ERROR, "schema.dataset", "schema 'dataset' must equal file name stem %r" % dataset,
                repr(schema.get("dataset")))
    src = schema.get("source")
    if not isinstance(src, dict) or not all(k in src for k in ("name", "url", "vintage")):
        res.add(ERROR, "schema.source", "schema 'source' must be an object with name, url, vintage")
    gts = geometry_types_of(schema) if "geometry_type" in schema else None
    if "geometry_type" not in schema:
        res.add(ERROR, "schema.geometry_type", "schema missing 'geometry_type' (use null for tabular)")
    elif gts is not None:
        for g in gts:
            if g not in ALLOWED_GEOMETRIES:
                res.add(ERROR, "schema.geometry_type", "geometry_type %r not in %s" % (g, list(ALLOWED_GEOMETRIES)))
    for key in ("fields", "geojson_fields"):
        if key == "geojson_fields" and key not in schema:
            continue
        fields = schema.get(key)
        if not isinstance(fields, list) or not fields:
            res.add(ERROR, "schema.fields", "schema %r must be a non-empty list" % key)
            usable = False
            continue
        names = []
        for f in fields:
            if not isinstance(f, dict) or "name" not in f or "type" not in f:
                res.add(ERROR, "schema.fields", "%s entry missing name/type" % key, repr(f)[:80])
                usable = False
                continue
            names.append(f["name"])
            if f["type"] not in FIELD_TYPES:
                res.add(ERROR, "schema.fields", "%s.%s has invalid type" % (key, f["name"]), repr(f["type"]))
                usable = False
            if not SNAKE_RE.match(str(f["name"])):
                res.add(ERROR, "schema.fields", "%s name is not snake_case" % key, repr(f["name"]))
            for req in ("nullable", "description", "unit", "enum", "min", "max"):
                if req not in f:
                    res.add(ERROR, "schema.fields", "%s entry missing key %r" % (key, req), f["name"])
            if "nullable" in f and not isinstance(f["nullable"], bool):
                res.add(ERROR, "schema.fields", "%s.%s nullable must be boolean" % (key, f["name"]))
            if f.get("enum") is not None and not isinstance(f.get("enum"), list):
                res.add(ERROR, "schema.fields", "%s.%s enum must be a list or null" % (key, f["name"]))
        dups = [n for n, c in Counter(names).items() if c > 1]
        if dups:
            res.add(ERROR, "schema.fields", "duplicate field names in %s" % key, ", ".join(map(str, dups)))
            usable = False
    pk = schema.get("primary_key")
    if not isinstance(pk, list) or not pk:
        res.add(ERROR, "schema.primary_key", "primary_key must be a non-empty list")
        usable = False
    elif isinstance(schema.get("fields"), list):
        names = {f.get("name") for f in schema["fields"] if isinstance(f, dict)}
        for col in pk:
            if col not in names:
                res.add(ERROR, "schema.primary_key", "primary_key column not in fields", repr(col))
                usable = False
    if usable and gts is not None:
        gfields = _geo_fields(schema)
        gnames = [f["name"] for f in gfields]
        for col in pk:
            if col not in gnames:
                res.add(ERROR, "schema.primary_key", "primary_key column not in geojson properties", repr(col))
                usable = False
        if "distance_mi" not in gnames:
            res.add(ERROR, "schema.fields", "spatial dataset must have a distance_mi property")
    return usable


def _geo_fields(schema: Dict[str, Any]) -> List[Dict[str, Any]]:
    return schema["geojson_fields"] if isinstance(schema.get("geojson_fields"), list) else schema["fields"]


# ---- Value checks ------------------------------------------------------------


def _is_null_token(s: str) -> bool:
    return s.strip().lower() in NULL_TOKENS


def _whitespace_bad(s: str) -> bool:
    return s != s.strip() or bool(BAD_WS_RE.search(s))


def parse_csv_cell(field: Dict[str, Any], raw: str, res: DatasetResult, where: str) -> Any:
    """Parse one CSV cell per field type. Returns typed value or None (null/invalid)."""
    name = field["name"]
    ftype = field["type"]
    if raw == "":
        if not field.get("nullable", False):
            res.add(ERROR, "value.nullable", "null in non-nullable column %r" % name, where)
        return None
    if _is_null_token(raw):
        res.add(ERROR, "value.null_token", "forbidden null token in column %r" % name, "%s=%r" % (where, raw))
        return None
    if _whitespace_bad(raw):
        res.add(ERROR, "value.whitespace", "untrimmed/uncollapsed whitespace in column %r" % name,
                "%s=%r" % (where, raw[:60]))
    value: Any = None
    if ftype == "integer":
        if INT_RE.match(raw):
            value = int(raw)
        else:
            res.add(ERROR, "value.type", "not a plain integer in column %r" % name, "%s=%r" % (where, raw))
            return None
    elif ftype == "number":
        if NUM_RE.match(raw):
            value = float(raw)
        elif NUM_EXP_RE.match(raw):
            value = float(raw)
            res.add(WARNING, "value.format", "exponent notation in number column %r" % name, "%s=%r" % (where, raw))
        else:
            res.add(ERROR, "value.type", "not a plain number in column %r" % name, "%s=%r" % (where, raw))
            return None
    elif ftype == "boolean":
        if raw in ("true", "false"):
            value = raw == "true"
        else:
            res.add(ERROR, "value.type", "boolean must be true/false in column %r" % name, "%s=%r" % (where, raw))
            return None
    elif ftype == "date":
        if not _valid_date(raw):
            res.add(ERROR, "value.type", "not an ISO YYYY-MM-DD date in column %r" % name, "%s=%r" % (where, raw))
            return None
        value = raw
    elif ftype in ("array", "object"):
        want = list if ftype == "array" else dict
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        if isinstance(parsed, want):
            value = parsed
        else:
            res.add(WARNING, "value.format", "%s column %r is not JSON-encoded" % (ftype, name),
                    "%s=%r" % (where, raw[:60]))
            value = raw
    else:
        value = raw
    _check_constraints(field, value, res, where)
    return value


def check_json_value(field: Dict[str, Any], value: Any, res: DatasetResult, where: str) -> Any:
    """Check a GeoJSON property value against its field definition."""
    name = field["name"]
    ftype = field["type"]
    if value is None:
        if not field.get("nullable", False):
            res.add(ERROR, "value.nullable", "null in non-nullable property %r" % name, where)
        return None
    ok = True
    if ftype == "string" or ftype == "date":
        ok = isinstance(value, str)
        if ok:
            if value == "":
                res.add(ERROR, "value.null_token", "empty string in property %r (use null)" % name, where)
                return None
            if _is_null_token(value):
                res.add(ERROR, "value.null_token", "forbidden null token in property %r" % name,
                        "%s=%r" % (where, value))
                return None
            if _whitespace_bad(value):
                res.add(ERROR, "value.whitespace", "untrimmed/uncollapsed whitespace in property %r" % name,
                        "%s=%r" % (where, value[:60]))
            if ftype == "date" and not _valid_date(value):
                res.add(ERROR, "value.type", "not an ISO YYYY-MM-DD date in property %r" % name,
                        "%s=%r" % (where, value))
                return None
    elif ftype == "integer":
        ok = isinstance(value, int) and not isinstance(value, bool)
    elif ftype == "number":
        ok = isinstance(value, (int, float)) and not isinstance(value, bool)
        if ok and not math.isfinite(value):
            res.add(ERROR, "value.nonfinite", "non-finite number in property %r" % name, where)
            return None
    elif ftype == "boolean":
        ok = isinstance(value, bool)
    elif ftype == "array":
        ok = isinstance(value, list)
        if ok:
            _check_nested(value, name, res, where)
    elif ftype == "object":
        ok = isinstance(value, dict)
        if ok:
            _check_nested(value, name, res, where)
    if not ok:
        res.add(ERROR, "value.type", "property %r is not JSON %s" % (name, ftype),
                "%s=%r" % (where, value if not isinstance(value, str) else value[:40]))
        return None
    _check_constraints(field, value, res, where)
    return value


def _check_nested(value: Any, name: str, res: DatasetResult, where: str) -> None:
    stack = [value]
    while stack:
        v = stack.pop()
        if isinstance(v, float) and not math.isfinite(v):
            res.add(ERROR, "value.nonfinite", "non-finite number inside property %r" % name, where)
        elif isinstance(v, str) and (_is_null_token(v) or _whitespace_bad(v) or v == ""):
            res.add(ERROR, "value.null_token", "null token / bad whitespace inside property %r" % name,
                    "%s=%r" % (where, v))
        elif isinstance(v, list):
            stack.extend(v)
        elif isinstance(v, dict):
            stack.extend(v.values())


def _check_constraints(field: Dict[str, Any], value: Any, res: DatasetResult, where: str) -> None:
    name = field["name"]
    enum = field.get("enum")
    if enum is not None and isinstance(enum, list) and not isinstance(value, (list, dict)):
        if value not in enum:
            res.add(ERROR, "value.enum", "value not in enum for %r" % name, "%s=%r" % (where, value))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if float(value) in SENTINEL_NUMBERS:
            res.add(ERROR, "value.null_token", "sentinel -999999 in %r" % name, where)
            return
        lo, hi = field.get("min"), field.get("max")
        if isinstance(lo, (int, float)) and value < lo:
            res.add(ERROR, "value.range", "%r below min %s" % (name, lo), "%s=%r" % (where, value))
        if isinstance(hi, (int, float)) and value > hi:
            res.add(ERROR, "value.range", "%r above max %s" % (name, hi), "%s=%r" % (where, value))
    elif field.get("type") == "date" and isinstance(value, str):
        lo, hi = field.get("min"), field.get("max")
        if isinstance(lo, str) and value < lo:
            res.add(ERROR, "value.range", "%r before min %s" % (name, lo), "%s=%r" % (where, value))
        if isinstance(hi, str) and value > hi:
            res.add(ERROR, "value.range", "%r after max %s" % (name, hi), "%s=%r" % (where, value))


def _valid_date(s: str) -> bool:
    if not DATE_RE.match(s):
        return False
    try:
        _dt.date.fromisoformat(s)
    except ValueError:
        return False
    return True


def check_keys(keys: List[Optional[tuple]], res: DatasetResult, label: str) -> List[tuple]:
    """PK unique, non-null and strictly ascending. Returns the non-null keys."""
    good = []
    for i, k in enumerate(keys):
        if k is None or any(v is None for v in k):
            res.add(ERROR, "pk.null", "null/invalid primary key in %s" % label, "row %d" % (i + 1))
        else:
            good.append(k)
    dups = [k for k, c in Counter(good).items() if c > 1]
    for k in dups[:MAX_EXAMPLES]:
        res.add(ERROR, "pk.duplicate", "duplicate primary key in %s" % label, repr(k))
    if len(dups) > MAX_EXAMPLES:
        res.add(ERROR, "pk.duplicate", "duplicate primary key in %s" % label, "... %d more" % (len(dups) - MAX_EXAMPLES))
    prev = None
    for i, k in enumerate(keys):
        if k is None or any(v is None for v in k):
            continue
        if prev is not None:
            try:
                out_of_order = k < prev
            except TypeError:
                out_of_order = True
            if out_of_order:
                res.add(ERROR, "pk.unsorted", "%s not sorted ascending by primary key" % label,
                        "row %d %r after %r" % (i + 1, k, prev))
        prev = k
    return good


# ---- CSV ---------------------------------------------------------------------


def validate_csv(path: Path, schema: Dict[str, Any], res: DatasetResult) -> None:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        res.add(ERROR, "csv.bom", "CSV starts with a UTF-8 BOM")
        raw = raw[3:]
    if b"\r" in raw:
        res.add(ERROR, "csv.crlf", "CSV contains CR characters (LF line endings only)",
                "%d CR byte(s)" % raw.count(b"\r"))
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        res.add(ERROR, "csv.encoding", "CSV is not valid UTF-8", str(exc)[:80])
        text = raw.decode("utf-8", errors="replace")
    if text and not text.endswith("\n"):
        res.add(WARNING, "csv.newline", "CSV does not end with a newline")
    try:
        rows = list(csv.reader(io.StringIO(text, newline=""), strict=True))
    except csv.Error as exc:
        res.add(ERROR, "csv.parse", "CSV failed to parse", str(exc)[:80])
        return
    if not rows:
        res.add(ERROR, "csv.empty", "CSV is empty")
        res.csv_rows = 0
        return
    header, body = rows[0], rows[1:]
    fields = schema["fields"]
    expected = [f["name"] for f in fields]
    bad_names = [h for h in header if not SNAKE_RE.match(h)]
    if bad_names:
        res.add(ERROR, "csv.header", "header names not snake_case (index column?)", ", ".join(map(repr, bad_names[:5])))
    dup_names = [h for h, c in Counter(header).items() if c > 1]
    if dup_names:
        res.add(ERROR, "csv.header", "duplicate header names", ", ".join(dup_names))
    res.csv_rows = len(body)
    if header != expected:
        missing = [n for n in expected if n not in header]
        extra = [n for n in header if n not in expected]
        detail = "missing=%s extra=%s" % (missing, extra) if (missing or extra) else "same names, different order"
        res.add(ERROR, "csv.header", "header does not match schema fields (in order)", detail)
        return
    if not body:
        res.add(ERROR, "csv.empty", "CSV has a header but no data rows")
    pk = schema["primary_key"]
    pk_idx = [expected.index(c) for c in pk]
    cols: Dict[str, List[Any]] = {n: [] for n in expected}
    keys: List[Optional[tuple]] = []
    for i, row in enumerate(body):
        line = i + 2
        if len(row) != len(expected):
            res.add(ERROR, "csv.row_width", "row has wrong number of columns", "line %d: %d cols" % (line, len(row)))
            keys.append(None)
            continue
        typed = []
        for f, cell in zip(fields, row):
            typed.append(parse_csv_cell(f, cell, res, "line %d" % line))
        for n, v in zip(expected, typed):
            cols[n].append(v)
        key = tuple(typed[j] for j in pk_idx)
        keys.append(key)
        record = dict(zip(expected, typed))
        record["__line__"] = line
        if all(v is not None for v in key):
            res.csv_records.setdefault(key, record)
        _check_csv_location(record, res, "line %d" % line)
        _check_cross_fields(record, res, "line %d" % line)
    res.csv_keys = check_keys(keys, res, "CSV")
    res.columns = cols


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _check_csv_location(record: Dict[str, Any], res: DatasetResult, where: str) -> None:
    """CSV latitude/longitude must be inside the region and agree with distance_mi."""
    if "latitude" not in record or "longitude" not in record:
        return
    lat, lon = record["latitude"], record["longitude"]
    if not (_is_num(lat) and _is_num(lon)):
        return
    if not (SANE_LON[0] <= lon <= SANE_LON[1] and SANE_LAT[0] <= lat <= SANE_LAT[1]):
        res.add(ERROR, "csv.bounds", "CSV latitude/longitude outside lon %s lat %s (swapped?)" % (SANE_LON, SANE_LAT),
                "%s: lat=%r lon=%r" % (where, lat, lon))
    d = distance_to_center_mi(lon, lat)
    if d > RADIUS_MI + REGION_TOLERANCE_MI:
        res.add(ERROR, "csv.region", "CSV latitude/longitude not within %.0f mi of center" % RADIUS_MI,
                "%s: %.2f mi" % (where, d))
    dist = record.get("distance_mi")
    if _is_num(dist) and abs(dist - d) > DISTANCE_TOLERANCE_MI:
        res.add(ERROR, "csv.distance", "distance_mi disagrees with CSV latitude/longitude",
                "%s: %r vs computed %.3f" % (where, dist, d))


def _check_cross_fields(record: Dict[str, Any], res: DatasetResult, where: str) -> None:
    for lo_col, hi_col, level, note in CROSS_FIELD_RULES:
        lo, hi = record.get(lo_col), record.get(hi_col)
        if _is_num(lo) and _is_num(hi) and lo > hi:
            res.add(level, "value.cross_field", "%s > %s (%s)" % (lo_col, hi_col, note),
                    "%s: %s=%r %s=%r" % (where, lo_col, lo, hi_col, hi))


# ---- GeoJSON -----------------------------------------------------------------


def _iter_positions(geom_type: str, coords: Any) -> Optional[List[Any]]:
    """Flatten coordinates into a list of positions; None if the nesting is wrong."""
    if geom_type == "Point":
        return [coords]
    if geom_type == "LineString":
        if not isinstance(coords, list) or len(coords) < 2:
            return None
        return list(coords)
    if geom_type == "MultiLineString":
        if not isinstance(coords, list) or not coords:
            return None
        out = []
        for part in coords:
            if not isinstance(part, list) or len(part) < 2:
                return None
            out.extend(part)
        return out
    return None


def _decimals_ok(v: float, places: int) -> bool:
    return round(v, places) == v


def validate_geojson(path: Path, schema: Dict[str, Any], res: DatasetResult) -> None:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        res.add(ERROR, "geo.bom", "GeoJSON starts with a UTF-8 BOM")
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        res.add(ERROR, "geo.encoding", "GeoJSON is not valid UTF-8", str(exc)[:80])
        return
    try:
        doc, bad_consts = load_json_file(path)
    except ValueError as exc:
        res.add(ERROR, "geo.json", "GeoJSON is not valid JSON", str(exc)[:80])
        return
    for c in sorted(set(bad_consts)):
        res.add(ERROR, "geo.nonfinite", "non-standard JSON constant (NaN/Infinity) present", c)
    if not isinstance(doc, dict) or doc.get("type") != "FeatureCollection":
        res.add(ERROR, "geo.collection", "top level is not a FeatureCollection")
        return
    if "crs" in doc:
        res.add(WARNING, "geo.crs", "RFC7946 drops the 'crs' member; WGS84 is implied")
    feats = doc.get("features")
    if not isinstance(feats, list):
        res.add(ERROR, "geo.collection", "'features' is not a list")
        return
    res.feature_count = len(feats)
    if not feats:
        res.add(ERROR, "geo.empty", "FeatureCollection has no features")
    allowed = geometry_types_of(schema) or []
    gfields = _geo_fields(schema)
    gnames = [f["name"] for f in gfields]
    gset = set(gnames)
    pk = schema["primary_key"]
    cols: Dict[str, List[Any]] = {n: [] for n in gnames}
    keys: List[Optional[tuple]] = []
    for i, feat in enumerate(feats):
        where = "feature %d" % i
        if not isinstance(feat, dict) or feat.get("type") != "Feature":
            res.add(ERROR, "geo.feature", "item is not a Feature", where)
            keys.append(None)
            continue
        props = feat.get("properties")
        if not isinstance(props, dict):
            res.add(ERROR, "geo.properties", "properties is not an object", where)
            keys.append(None)
            continue
        pk_where = where
        if all(c in props for c in pk):
            pk_where = "%s (%s)" % (where, ",".join("%s=%r" % (c, props[c]) for c in pk))
        # geometry
        nearest = _check_geometry(feat.get("geometry"), allowed, res, pk_where)
        # properties
        keys_now = list(props.keys())
        if set(keys_now) != gset:
            missing = [n for n in gnames if n not in props]
            extra = [n for n in keys_now if n not in gset]
            res.add(ERROR, "geo.properties", "property keys do not match schema fields",
                    "%s missing=%s extra=%s" % (where, missing[:5], extra[:5]))
        elif keys_now != gnames:
            res.add(WARNING, "geo.property_order", "property key order differs from schema field order", where)
        typed = {}
        for f in gfields:
            if f["name"] in props:
                typed[f["name"]] = check_json_value(f, props[f["name"]], res, pk_where)
            else:
                typed[f["name"]] = None
        for n in gnames:
            cols[n].append(typed.get(n))
        key = tuple(typed.get(c) for c in pk)
        keys.append(key)
        if all(v is not None for v in key) and key not in res.geo_records:
            res.geo_records[key] = (typed, _point_lonlat(feat.get("geometry")))
        # distance_mi consistency
        dist = props.get("distance_mi")
        if "distance_mi" in gset and isinstance(dist, (int, float)) and not isinstance(dist, bool):
            if math.isfinite(dist) and not _decimals_ok(float(dist), 1):
                res.add(ERROR, "geo.distance", "distance_mi not rounded to 1 decimal", "%s=%r" % (pk_where, dist))
            if nearest is not None and math.isfinite(dist) and abs(dist - nearest) > 0.2:
                res.add(ERROR, "geo.distance", "distance_mi disagrees with geometry",
                        "%s: %.1f vs computed %.2f" % (pk_where, dist, nearest))
    res.geo_keys = check_keys(keys, res, "GeoJSON")
    if not res.columns:
        res.columns = cols
    else:
        for n, v in cols.items():
            res.columns.setdefault(n, v)


def _point_lonlat(geom: Any) -> Optional[Tuple[float, float]]:
    if not isinstance(geom, dict) or geom.get("type") != "Point":
        return None
    pos = geom.get("coordinates")
    if isinstance(pos, list) and len(pos) == 2 and all(_is_num(v) for v in pos):
        return float(pos[0]), float(pos[1])
    return None


def _check_geometry(geom: Any, allowed: List[str], res: DatasetResult, where: str) -> Optional[float]:
    """Validate geometry; returns min distance to center (mi) or None if invalid."""
    if not isinstance(geom, dict):
        res.add(ERROR, "geo.geometry", "geometry is null or not an object", where)
        return None
    gtype = geom.get("type")
    if gtype not in ALLOWED_GEOMETRIES:
        res.add(ERROR, "geo.geometry_type", "geometry type not allowed", "%s: %r" % (where, gtype))
        return None
    if allowed and gtype not in allowed:
        res.add(ERROR, "geo.geometry_type", "geometry type does not match schema %s" % "|".join(allowed),
                "%s: %s" % (where, gtype))
    positions = _iter_positions(gtype, geom.get("coordinates"))
    if positions is None:
        res.add(ERROR, "geo.geometry", "malformed coordinates for %s" % gtype, where)
        return None
    nearest = None
    for pos in positions:
        if not isinstance(pos, list) or len(pos) != 2 or not all(
            isinstance(v, (int, float)) and not isinstance(v, bool) for v in pos
        ):
            res.add(ERROR, "geo.geometry", "position must be [lon, lat] numbers", "%s: %r" % (where, pos))
            continue
        lon, lat = float(pos[0]), float(pos[1])
        if not (math.isfinite(lon) and math.isfinite(lat)):
            res.add(ERROR, "geo.nonfinite", "non-finite coordinate", where)
            continue
        if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
            res.add(ERROR, "geo.bounds", "coordinate outside WGS84 range", "%s: [%r, %r]" % (where, lon, lat))
            continue
        if not (SANE_LON[0] <= lon <= SANE_LON[1] and SANE_LAT[0] <= lat <= SANE_LAT[1]):
            if gtype == "Point":
                res.add(ERROR, "geo.bounds", "coordinate outside lon %s lat %s (swapped?)" % (SANE_LON, SANE_LAT),
                        "%s: [%r, %r]" % (where, lon, lat))
                continue
            # Lines are kept unclipped when any vertex is in range, so a long line may
            # legitimately leave the sanity box; flag it but do not fail.
            res.add(WARNING, "geo.bounds_line", "line vertex outside lon %s lat %s (unclipped line)"
                    % (SANE_LON, SANE_LAT), "%s: [%r, %r]" % (where, lon, lat))
        if not (_decimals_ok(lon, COORD_DECIMALS) and _decimals_ok(lat, COORD_DECIMALS)):
            res.add(ERROR, "geo.precision", "coordinate not rounded to %d decimals" % COORD_DECIMALS,
                    "%s: [%r, %r]" % (where, lon, lat))
        d = distance_to_center_mi(lon, lat)
        nearest = d if nearest is None else min(nearest, d)
    if nearest is None:
        return None
    if nearest > RADIUS_MI + REGION_TOLERANCE_MI:
        what = "point" if gtype == "Point" else "no vertex"
        res.add(ERROR, "geo.region", "%s within %.0f mi of center" % (what, RADIUS_MI),
                "%s: %.2f mi" % (where, nearest))
    return nearest


# ---- Dataset + cross-dataset -------------------------------------------------


def _load_schema(paths: Paths, dataset: str) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    try:
        schema, bad = load_json_file(paths.schema(dataset))
    except (OSError, ValueError) as exc:
        return None, [str(exc)[:80]]
    return (schema if isinstance(schema, dict) else None), (["NaN/Infinity constant"] if bad else [])


def claimed_layers(paths: Paths, datasets: List[str]) -> Dict[Path, str]:
    """Map resolved GeoJSON path -> dataset that describes it (spatial schemas only)."""
    claims: Dict[Path, str] = {}
    for name in datasets:
        schema, _ = _load_schema(paths, name)
        if schema is None:
            continue
        _, geo, _ = resolve_files(paths, name, schema)
        if geo is not None:
            claims.setdefault(geo.resolve(), name)
    return claims


def validate_dataset(paths: Paths, dataset: str, claims: Optional[Dict[Path, str]] = None) -> DatasetResult:
    res = DatasetResult(dataset)
    schema, problems = _load_schema(paths, dataset)
    if schema is None and problems:
        res.add(ERROR, "schema.json", "schema file unreadable / invalid JSON", problems[0])
        return res
    if problems:
        res.add(ERROR, "schema.json", "schema contains NaN/Infinity")
    if not check_schema(schema, dataset, res):
        return res
    res.schema = schema
    csv_path, geo_path, note_path = resolve_files(paths, dataset, schema)
    default_geo = paths.geojson(dataset)
    has_csv = csv_path.exists()
    has_geo = geo_path is not None and geo_path.exists()
    res.csv_path = csv_path if has_csv else None
    res.geo_path = geo_path if has_geo else None
    if not has_csv and not has_geo:
        res.add(ERROR, "file.missing", "neither clean CSV nor GeoJSON layer exists",
                "%s / %s" % (paths.rel(csv_path), paths.rel(geo_path or default_geo)))
        return res
    if geo_path is not None and not has_geo:
        res.add(ERROR, "file.missing", "schema has geometry_type but GeoJSON layer is missing", paths.rel(geo_path))
    if geo_path is None and default_geo.exists():
        owner = (claims or {}).get(default_geo.resolve())
        if owner is None:
            res.add(ERROR, "file.unexpected",
                    "GeoJSON exists but schema geometry_type is null and no other schema describes it",
                    paths.rel(default_geo))
        else:
            res.add(INFO, "file.layer", "GeoJSON twin validated by schema %r" % owner, paths.rel(default_geo))
    if "geojson_fields" in schema and not has_csv:
        res.add(WARNING, "schema.fields", "geojson_fields given but no CSV exists; 'fields' is unused")
    if has_csv:
        validate_csv(csv_path, schema, res)
    if has_geo:
        validate_geojson(geo_path, schema, res)
    if res.csv_keys is not None and res.geo_keys is not None:
        compare_keysets(res, res.csv_keys, res.csv_rows, res.geo_keys, res.feature_count, "CSV", "GeoJSON")
        compare_twin_values(res, res, res, schema["fields"], _geo_fields(schema), "CSV")
    if not note_path.exists():
        res.add(WARNING, "notes.missing", "no notes file", paths.rel(note_path))
    return res


def compare_keysets(res: DatasetResult, a_keys: List[tuple], a_n: Optional[int], b_keys: List[tuple],
                    b_n: Optional[int], a_label: str, b_label: str) -> None:
    if a_n != b_n:
        res.add(ERROR, "geo.csv_mismatch", "%s row count != %s feature count" % (a_label, b_label),
                "%s vs %s" % (a_n, b_n))
    aset, bset = set(a_keys), set(b_keys)
    if aset != bset:
        only_a = sorted(aset - bset, key=repr)[:3]
        only_b = sorted(bset - aset, key=repr)[:3]
        res.add(ERROR, "geo.csv_mismatch", "%s and %s primary key sets differ" % (a_label, b_label),
                "only_%s=%s only_%s=%s (%d vs %d keys)" % (a_label.lower(), only_a, b_label.lower(), only_b,
                                                          len(aset), len(bset)))


def check_twins(paths: Paths, results: Dict[str, DatasetResult]) -> None:
    """A spatial schema whose layer is layers/<other>.geojson must agree with <other>'s CSV."""
    for name in sorted(results):
        r = results[name]
        if r.geo_path is None or r.geo_keys is None:
            continue
        stem = r.geo_path.name[: -len(".geojson")]
        if stem == name or stem not in results:
            continue
        twin = results[stem]
        if twin.csv_keys is None:
            continue
        if [c for c in (twin.schema or {}).get("primary_key", [])] != (r.schema or {}).get("primary_key"):
            r.add(WARNING, "geo.csv_mismatch", "primary_key differs from CSV twin %r; agreement not checked" % stem)
            continue
        # A separately-schema'd layer may be a filtered subset (e.g. operating plants only),
        # so require GeoJSON keys within the CSV twin and report the difference.
        cset, gset = set(twin.csv_keys), set(r.geo_keys)
        extra = sorted(gset - cset, key=repr)
        if extra:
            r.add(ERROR, "geo.csv_mismatch", "GeoJSON primary keys missing from CSV twin %r (%d)" % (stem, len(extra)),
                  ", ".join(map(repr, extra[:MAX_EXAMPLES])))
        if len(cset) != len(gset):
            r.add(INFO, "geo.subset", "GeoJSON has %d of %d rows of CSV twin %r" % (len(gset), len(cset), stem))
        compare_twin_values(r, twin, r, (twin.schema or {}).get("fields") or [], _geo_fields(r.schema or {}),
                            "CSV twin %r" % stem)


_NUMERIC_TYPES = ("integer", "number")


def _same_value(a: Any, b: Any) -> bool:
    if _is_num(a) and _is_num(b):
        return abs(float(a) - float(b)) <= NUMBER_TOLERANCE
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    return a == b


def compare_twin_values(res: DatasetResult, csv_res: DatasetResult, geo_res: DatasetResult,
                        csv_fields: List[Dict[str, Any]], geo_fields: List[Dict[str, Any]], label: str) -> None:
    """Per primary key, GeoJSON property values and Point coordinates must equal the CSV row.

    Only fields present in both with compatible types are compared (a CSV string vs a
    GeoJSON array, e.g. pipe-joined vs JSON list, is a deliberate encoding difference).
    A null CSV value may become a fallback value in a non-nullable GeoJSON property.
    """
    if not csv_res.csv_records or not geo_res.geo_records:
        return
    ctypes = {f["name"]: f.get("type") for f in csv_fields if isinstance(f, dict) and "name" in f}
    gfields = {f["name"]: f for f in geo_fields if isinstance(f, dict) and "name" in f}
    common = []
    for name, ctype in ctypes.items():
        gf = gfields.get(name)
        if gf is None:
            continue
        gtype = gf.get("type")
        if ctype == gtype or (ctype in _NUMERIC_TYPES and gtype in _NUMERIC_TYPES):
            common.append((name, bool(gf.get("nullable", False))))
    has_coords = "latitude" in ctypes and "longitude" in ctypes
    for key in sorted(geo_res.geo_records, key=repr):
        crow = csv_res.csv_records.get(key)
        if crow is None:
            continue
        props, lonlat = geo_res.geo_records[key]
        where = "pk=%s (line %s)" % (",".join(map(repr, key)), crow.get("__line__"))
        for name, g_nullable in common:
            cv, gv = crow.get(name), props.get(name)
            if cv is None and gv is not None and not g_nullable:
                continue
            if not _same_value(cv, gv):
                res.add(ERROR, "geo.csv_mismatch", "GeoJSON property %r differs from %s" % (name, label),
                        "%s: csv=%r geojson=%r" % (where, cv, gv))
        if has_coords and lonlat is not None:
            clat, clon = crow.get("latitude"), crow.get("longitude")
            if _is_num(clat) and _is_num(clon) and (
                abs(lonlat[0] - clon) > COORD_TOLERANCE_DEG or abs(lonlat[1] - clat) > COORD_TOLERANCE_DEG
            ):
                res.add(ERROR, "geo.csv_mismatch", "GeoJSON point coordinates differ from %s latitude/longitude" % label,
                        "%s: csv=[%r, %r] geojson=[%r, %r]" % (where, clon, clat, lonlat[0], lonlat[1]))


def _reference_rules(results: Dict[str, DatasetResult]) -> List[Tuple[str, str, str, str, str]]:
    rules = list(REFERENCE_RULES)
    for name in sorted(results):
        schema = results[name].schema or {}
        for ref in schema.get("references") or []:
            if isinstance(ref, dict) and {"field", "dataset", "target_field"} <= set(ref):
                sev = "rate" if ref.get("severity") in ("rate", "warning") else "error"
                rules.append((name, ref["field"], ref["dataset"], ref["target_field"], sev))
    return rules


def check_references(results: Dict[str, DatasetResult]) -> None:
    for src, sfield, dst, dfield, sev in _reference_rules(results):
        if src not in results:
            continue
        sres = results[src]
        if sres.schema is None:
            continue
        if dst not in results or results[dst].schema is None:
            sres.add(WARNING, "ref.unchecked", "cannot check %s.%s -> %s.%s (target dataset missing)"
                     % (src, sfield, dst, dfield))
            continue
        if sfield not in sres.columns:
            sres.add(WARNING, "ref.unchecked", "field %r not present; cannot check reference to %s" % (sfield, dst))
            continue
        if dfield not in results[dst].columns:
            sres.add(WARNING, "ref.unchecked", "target field %s.%s not present" % (dst, dfield))
            continue
        target = {normalize_key(v) for v in results[dst].columns[dfield]} - {None}
        values = [normalize_key(v) for v in sres.columns[sfield]]
        values = [v for v in values if v is not None]
        missing = [v for v in values if v not in target]
        if sev == "error":
            if missing:
                uniq = sorted(set(missing), key=repr)
                sres.add(ERROR, "ref.missing", "%s.%s values not found in %s.%s (%d rows)"
                         % (src, sfield, dst, dfield, len(missing)), ", ".join(map(repr, uniq[:MAX_EXAMPLES])))
        else:
            total = len(values)
            matched = total - len(missing)
            rate = (100.0 * matched / total) if total else 0.0
            level = INFO if total and not missing else WARNING
            sres.add(level, "ref.match_rate", "%s.%s -> %s.%s match rate %d/%d (%.1f%%)"
                     % (src, sfield, dst, dfield, matched, total, rate))


def validate_all(paths: Paths, datasets: Optional[List[str]] = None) -> Report:
    report = Report()
    names = discover_datasets(paths)
    if datasets:
        unknown = [d for d in datasets if d not in names]
        for d in unknown:
            report.global_errors.append("unknown dataset %r (no %s)" % (d, paths.rel(paths.schema(d))))
        names = [n for n in names if n in datasets]
    if not names and not report.global_errors:
        report.global_errors.append("no datasets found in %s" % paths.rel(paths.schemas))
    all_names = discover_datasets(paths)
    claims = claimed_layers(paths, all_names)
    for name in names:
        report.results[name] = validate_dataset(paths, name, claims)
    check_twins(paths, report.results)
    check_references(report.results)
    if not datasets:
        for rel in unclaimed_files(paths, all_names):
            report.global_errors.append("[file.unexpected] %s is not described by any schema" % rel)
    return report


# Map layers the app already ships from research/scripts/ (build_eia_plants.py,
# build_osm_grid.py). They predate this pipeline and have no schema here, so they
# are not "unexpected"; publish.py never overwrites them without --replace-plants.
APP_LAYERS = frozenset({"plants.geojson", "substations.geojson", "transmission.geojson"})


def unclaimed_files(paths: Paths, datasets: List[str]) -> List[str]:
    """clean/*.csv and layers/*.geojson that no schema's resolve_files() points at,
    minus the app-owned layers in APP_LAYERS."""
    claimed = set()
    for name in datasets:
        schema, _ = _load_schema(paths, name)
        if schema is None:
            continue
        csv_path, geo_path, _ = resolve_files(paths, name, schema)
        claimed.add(csv_path.resolve())
        if geo_path is not None:
            claimed.add(geo_path.resolve())
    found = []
    for folder, pattern in ((paths.clean, "*.csv"), (paths.layers, "*.geojson")):
        if folder.is_dir():
            found.extend(sorted(folder.glob(pattern)))
    return [paths.rel(p) for p in found
            if p.resolve() not in claimed
            and not (p.parent.resolve() == paths.layers.resolve() and p.name in APP_LAYERS)]


def main(paths: Paths, datasets: Optional[List[str]] = None, json_out: Optional[str] = None) -> int:
    report = validate_all(paths, datasets)
    print(report.format())
    if json_out:
        from .common import atomic_write_bytes, dump_json

        atomic_write_bytes(Path(json_out), dump_json(report.to_dict()))
    return 0 if report.ok else 1
