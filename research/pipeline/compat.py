"""Check a GeoJSON layer against the TypeScript shapes the app consumes.

Encodes PlantProperties / TransmissionProperties / SubstationProperties and the
Plant/Transmission/SubstationFeature geometry types from lib/gridLayers.ts. Extra
properties are allowed (TypeScript structural typing); missing required keys or wrong
JS types are errors. Run before anything replaces a file under public/layers/.

    python -m pipeline compat FILE --shape {plant,transmission,substation} [--against OLD]
"""

import math
from pathlib import Path
from typing import Any, Dict, List, Optional

from .common import load_json_file

# JS type tokens: "number", "string", "null", "string[]", "record<string,number>".
# (key, allowed JS types, optional?) -- mirrors lib/gridLayers.ts exactly.
SHAPES: Dict[str, Dict[str, Any]] = {
    "plant": {
        "interface": "PlantProperties",
        "geometry": "Point",
        "fields": [
            ("plant_code", ("number",), False),
            ("plant_name", ("string",), False),
            ("utility_name", ("string",), False),
            ("distance_mi", ("number",), False),
            ("nameplate_mw", ("number",), False),
            ("mw_by_source", ("record<string,number>",), False),
            ("oldest_year", ("number", "null"), False),
            ("newest_year", ("number", "null"), False),
            ("planned_retirement_mw", ("number",), False),
            ("generator_count", ("number",), False),
            ("primary_source", ("string",), False),
            ("technologies", ("string[]",), False),
            ("capacity_weighted_age_years", ("number", "null"), False),
        ],
    },
    "transmission": {
        "interface": "TransmissionProperties",
        "geometry": "LineString",
        "fields": [
            ("osm_id", ("number",), False),
            ("voltage_kv", ("number", "null"), False),
            ("operator", ("string", "null"), False),
            ("name", ("string", "null"), False),
            ("cables", ("string", "null"), True),
            ("circuits", ("string", "null"), True),
        ],
    },
    "substation": {
        "interface": "SubstationProperties",
        "geometry": "Point",
        "fields": [
            ("osm_id", ("string",), False),
            ("name", ("string", "null"), False),
            ("operator", ("string", "null"), False),
            ("voltage_kv", ("number", "null"), False),
            ("substation", ("string", "null"), False),
        ],
    },
}

# PlantSource literal members; other strings are legal (`| string`) but render as "other".
KNOWN_PLANT_SOURCES = {
    "natural_gas", "solar", "battery", "wind", "hydro", "biogas", "other_gas", "waste_heat", "oil",
}


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _matches(v: Any, token: str) -> bool:
    if token == "number":
        return _is_number(v)
    if token == "string":
        return isinstance(v, str)
    if token == "null":
        return v is None
    if token == "string[]":
        return isinstance(v, list) and all(isinstance(x, str) for x in v)
    if token == "record<string,number>":
        return isinstance(v, dict) and all(isinstance(k, str) and _is_number(x) for k, x in v.items())
    raise ValueError("unknown JS type token %r" % token)


def _position_ok(pos: Any) -> bool:
    return isinstance(pos, list) and len(pos) == 2 and all(_is_number(x) for x in pos)


class CompatResult:
    def __init__(self, shape: str):
        self.shape = shape
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.feature_count = 0
        self._seen: Dict[str, int] = {}

    def err(self, key: str, msg: str) -> None:
        n = self._seen.get(key, 0)
        self._seen[key] = n + 1
        if n < 5:
            self.errors.append(msg)
        elif n == 5:
            self.errors.append("... further %s errors suppressed" % key)

    @property
    def ok(self) -> bool:
        return not self.errors

    def format(self) -> str:
        head = "%s %s (%d features): %d error(s), %d warning(s)" % (
            "COMPAT-OK" if self.ok else "COMPAT-FAIL",
            SHAPES[self.shape]["interface"],
            self.feature_count,
            len(self.errors),
            len(self.warnings),
        )
        lines = [head] + ["  error   " + e for e in self.errors] + ["  warning " + w for w in self.warnings]
        return "\n".join(lines)


def check_collection(doc: Any, shape: str, bad_constants: Optional[List[str]] = None) -> CompatResult:
    spec = SHAPES[shape]
    res = CompatResult(shape)
    for c in bad_constants or []:
        res.err("json", "JSON contains %s (JSON.parse will throw)" % c)
    if not isinstance(doc, dict) or doc.get("type") != "FeatureCollection":
        res.err("collection", "top level must be {type: 'FeatureCollection'}")
        return res
    feats = doc.get("features")
    if not isinstance(feats, list):
        res.err("collection", "'features' must be an array")
        return res
    res.feature_count = len(feats)
    if not feats:
        res.err("collection", "no features")
    unknown_sources = set()
    for i, f in enumerate(feats):
        where = "feature %d" % i
        if not isinstance(f, dict) or f.get("type") != "Feature":
            res.err("feature", "%s: type must be 'Feature'" % where)
            continue
        geom = f.get("geometry")
        if not isinstance(geom, dict) or geom.get("type") != spec["geometry"]:
            res.err("geometry", "%s: geometry.type must be %s, got %r"
                    % (where, spec["geometry"], geom.get("type") if isinstance(geom, dict) else geom))
        else:
            coords = geom.get("coordinates")
            if spec["geometry"] == "Point":
                if not _position_ok(coords):
                    res.err("coords", "%s: coordinates must be [number, number]" % where)
            else:
                if not (isinstance(coords, list) and len(coords) >= 2 and all(_position_ok(p) for p in coords)):
                    res.err("coords", "%s: coordinates must be [number, number][] (>= 2)" % where)
        props = f.get("properties")
        if not isinstance(props, dict):
            res.err("properties", "%s: properties must be an object" % where)
            continue
        for key, types, optional in spec["fields"]:
            if key not in props:
                if not optional:
                    res.err("missing:" + key, "%s: missing required property %r" % (where, key))
                continue
            if not any(_matches(props[key], t) for t in types):
                res.err("type:" + key, "%s: %s must be %s, got %r"
                        % (where, key, " | ".join(types), props[key] if not isinstance(props[key], str) else props[key][:40]))
        if shape == "plant" and isinstance(props.get("primary_source"), str):
            if props["primary_source"] not in KNOWN_PLANT_SOURCES:
                unknown_sources.add(props["primary_source"])
    if unknown_sources:
        res.warnings.append("primary_source values outside PlantSource literals (render as 'other'): %s"
                            % ", ".join(sorted(unknown_sources)))
    return res


def check_file(path: Path, shape: str, against: Optional[Path] = None) -> CompatResult:
    try:
        doc, bad = load_json_file(path)
    except (OSError, ValueError) as exc:
        res = CompatResult(shape)
        res.err("json", "cannot read %s: %s" % (path, exc))
        return res
    return check_doc(doc, shape, against, bad)


def check_doc(doc: Any, shape: str, against: Optional[Path] = None,
              bad_constants: Optional[List[str]] = None) -> CompatResult:
    """check_collection plus the comparisons against the file it would replace."""
    res = check_collection(doc, shape, bad_constants)
    if against is not None and Path(against).exists():
        compare_counts(res, Path(against))
        if shape == "plant":
            compare_order(res, doc, Path(against))
    return res


def is_nameplate_descending(doc: Any) -> bool:
    """True when features are in non-increasing nameplate_mw order (app draw order)."""
    try:
        values = [f["properties"]["nameplate_mw"] for f in doc["features"]]
    except (KeyError, TypeError):
        return False
    if not all(_is_number(v) for v in values):
        return False
    return all(a >= b for a, b in zip(values, values[1:]))


def compare_order(res: CompatResult, doc: Any, old_path: Path) -> None:
    """The app draws plant markers in feature order; the current file is sorted by
    nameplate_mw descending so small plants stay on top and hoverable."""
    try:
        old, _ = load_json_file(old_path)
    except (OSError, ValueError):
        return
    if not isinstance(old, dict) or len(old.get("features") or []) < 2:
        return
    if is_nameplate_descending(old) and not is_nameplate_descending(doc):
        res.warnings.append("feature order: %s is sorted by nameplate_mw descending (small markers drawn on top) "
                            "but the candidate is not" % old_path.name)


def compare_counts(res: CompatResult, old_path: Path) -> None:
    """Warn when a replacement changes the feature count drastically."""
    try:
        old, _ = load_json_file(old_path)
        old_n = len(old.get("features") or [])
    except (OSError, ValueError, AttributeError):
        return
    if old_n and abs(res.feature_count - old_n) / float(old_n) > 0.5:
        res.warnings.append("feature count changes %d -> %d (>50%%) versus %s" % (old_n, res.feature_count, old_path.name))


def main(path: str, shape: str, against: Optional[str] = None) -> int:
    res = check_file(Path(path), shape, Path(against) if against else None)
    print(res.format())
    return 0 if res.ok else 1


def shape_for_dataset(dataset: str) -> Optional[str]:
    """Which app shape a research layer is closest to (for informational checks)."""
    if dataset.endswith("plants"):
        return "plant"
    if dataset.endswith("transmission"):
        return "transmission"
    if dataset.endswith("substations"):
        return "substation"
    return None
