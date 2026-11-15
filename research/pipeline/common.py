"""Shared constants, paths and helpers for the research data pipeline."""

import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---- Region (shared data contract) -----------------------------------------

CENTER_LAT = 33.7538
CENTER_LON = -118.0111
RADIUS_MI = 100.0
EARTH_RADIUS_MI = 3958.8
# Coordinates are rounded to 6 decimals after the producer filtered on the
# unrounded value, so allow a hair of slack at the boundary.
REGION_TOLERANCE_MI = 0.01
# Server-side query box used by fetchers (exact haversine filter applies after).
BBOX = {"lon_min": -119.76, "lon_max": -116.26, "lat_min": 32.29, "lat_max": 35.21}
# Hard sanity bounds: every coordinate must fall in here (catches lat/lon swaps).
SANE_LON = (-125.0, -110.0)
SANE_LAT = (30.0, 40.0)
COORD_DECIMALS = 6

FIELD_TYPES = ("string", "integer", "number", "boolean", "date", "array", "object")
ALLOWED_GEOMETRIES = ("Point", "LineString", "MultiLineString")
SNAKE_RE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")

# Cross-dataset referential rules: (source dataset, source field, target dataset,
# target field, severity). "error" means every non-null source value must exist
# in the target; "rate" means report the match rate as a warning/info only.
# Schemas may add more via an optional "references" list.
REFERENCE_RULES = [
    ("eia860_generators", "plant_code", "eia860_plants", "plant_code", "error"),
    ("hifld_power_plants", "eia_plant_code", "eia860_plants", "plant_code", "rate"),
]


class Paths:
    """All filesystem locations, rooted at the research/ directory."""

    def __init__(self, research_dir: Optional[Path] = None, public_layers: Optional[Path] = None):
        root = Path(research_dir) if research_dir else Path(__file__).resolve().parent.parent
        self.research = root.resolve()
        self.schemas = self.research / "schemas"
        self.clean = self.research / "clean"
        self.layers = self.research / "layers"
        self.notes = self.research / "notes"
        self.scripts = self.research / "scripts"
        self.raw = self.research / "raw"
        self.backup = self.research / "backup"
        self.manifest = self.research / "manifest.json"
        if public_layers is not None:
            self.public_layers = Path(public_layers).resolve()
        else:
            self.public_layers = self.research.parent / "public" / "layers"

    def csv(self, dataset: str) -> Path:
        return self.clean / (dataset + ".csv")

    def geojson(self, dataset: str) -> Path:
        return self.layers / (dataset + ".geojson")

    def schema(self, dataset: str) -> Path:
        return self.schemas / (dataset + ".schema.json")

    def note(self, dataset: str) -> Path:
        return self.notes / (dataset + ".md")

    def rel(self, path: Path) -> str:
        """POSIX path relative to research/ (stable across machines)."""
        try:
            return Path(path).resolve().relative_to(self.research).as_posix()
        except ValueError:
            return Path(path).as_posix()


def discover_datasets(paths: Paths) -> List[str]:
    if not paths.schemas.is_dir():
        return []
    names = []
    for p in paths.schemas.glob("*.schema.json"):
        names.append(p.name[: -len(".schema.json")])
    return sorted(names)


# ---- Geometry ----------------------------------------------------------------


def haversine_mi(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(min(1.0, math.sqrt(a)))


def distance_to_center_mi(lon: float, lat: float) -> float:
    return haversine_mi(CENTER_LAT, CENTER_LON, lat, lon)


# ---- Files -------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


DEFAULT_FILE_MODE = 0o644


def atomic_write_bytes(dest: Path, data: bytes) -> None:
    """Write via a temp file in the same directory, fsync, then os.replace.

    mkstemp creates the temp file 0600; the result keeps the mode of the file it
    replaces, or gets 0644 when new, so a web server running as another user can read it.
    """
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(dest.parent), prefix="." + dest.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        mode = (os.stat(str(dest)).st_mode & 0o777) if dest.exists() else DEFAULT_FILE_MODE
        os.chmod(tmp, mode)
        os.replace(tmp, str(dest))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def dump_json(obj: Any) -> bytes:
    """Deterministic JSON text (2-space indent, UTF-8, trailing LF)."""
    return (json.dumps(obj, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")


def load_json_file(path: Path) -> Tuple[Any, List[str]]:
    """Parse JSON, recording (not accepting) NaN/Infinity constants.

    Returns (obj, list_of_bad_constants). Bad constants are replaced by float('nan')
    so later finiteness checks also flag their location.
    """
    bad: List[str] = []

    def _const(name: str) -> float:
        bad.append(name)
        return float("nan")

    raw = Path(path).read_bytes()
    text = raw.decode("utf-8-sig")
    return json.loads(text, parse_constant=_const), bad


def normalize_key(value: Any) -> Any:
    """Normalize an id for cross-dataset comparison (400, 400.0 and "400" match)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isfinite(value) and value.is_integer():
            return int(value)
        return value
    s = str(value).strip()
    if s == "":
        return None
    if re.fullmatch(r"-?\d+", s):
        return int(s)
    if re.fullmatch(r"-?\d+\.0+", s):
        return int(float(s))
    return s


def geometry_types_of(schema: Dict[str, Any]) -> Optional[List[str]]:
    """Schema geometry_type -> list of allowed types ("A|B" or list supported)."""
    gt = schema.get("geometry_type")
    if gt is None:
        return None
    if isinstance(gt, list):
        return [str(x) for x in gt]
    return [t.strip() for t in str(gt).split("|") if t.strip()]


LAYER_SUFFIX = "_layer"


def resolve_files(paths: Paths, dataset: str, schema: Dict[str, Any]) -> Tuple[Path, Optional[Path], Path]:
    """Return (csv_path, geojson_path or None, notes_path) for a dataset.

    Default: clean/<dataset>.csv and layers/<dataset>.geojson. A schema may override
    with "csv_file" / "geojson_file" (relative to research/). Convenience convention:
    a spatial schema named "<base>_layer" with no layers/<base>_layer.geojson describes
    layers/<base>.geojson (the GeoJSON twin of tabular dataset <base>).
    """
    if isinstance(schema.get("csv_file"), str):
        csv_path = paths.research / schema["csv_file"]
    else:
        csv_path = paths.csv(dataset)
    geo_path: Optional[Path] = None
    if schema.get("geometry_type") is not None:
        if isinstance(schema.get("geojson_file"), str):
            geo_path = paths.research / schema["geojson_file"]
        else:
            geo_path = paths.geojson(dataset)
            if dataset.endswith(LAYER_SUFFIX) and not geo_path.exists():
                geo_path = paths.geojson(dataset[: -len(LAYER_SUFFIX)])
    note = paths.note(dataset)
    if not note.exists() and dataset.endswith(LAYER_SUFFIX):
        base_note = paths.note(dataset[: -len(LAYER_SUFFIX)])
        if base_note.exists():
            note = base_note
    return csv_path, geo_path, note
