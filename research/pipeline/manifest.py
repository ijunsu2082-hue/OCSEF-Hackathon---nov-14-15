"""Write research/manifest.json describing every dataset.

Deterministic: the only time-dependent value is generated_at, which is passed in on the
command line (null when omitted). Same inputs -> byte-identical manifest.

    python -m pipeline manifest [--generated-at 2026-11-14]
    python -m pipeline manifest --check     # exit 1 if manifest.json is stale

--check rebuilds the manifest in memory (keeping the recorded generated_at) and fails
if any recorded file sha256 / byte count, file list, row count or validation result
differs from what is on disk now.
"""

import json
from typing import Any, Dict, List, Optional

from .common import (
    BBOX,
    CENTER_LAT,
    CENTER_LON,
    EARTH_RADIUS_MI,
    RADIUS_MI,
    Paths,
    atomic_write_bytes,
    dump_json,
    resolve_files,
    sha256_file,
)
from .validate import Report, validate_all

MANIFEST_VERSION = 1


def _file_entry(paths: Paths, role: str, path) -> Dict[str, Any]:
    return {
        "role": role,
        "path": paths.rel(path),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def build_manifest(paths: Paths, generated_at: Optional[str] = None,
                   report: Optional[Report] = None) -> Dict[str, Any]:
    if report is None:
        report = validate_all(paths)
    datasets = []
    for name in sorted(report.results):
        res = report.results[name]
        schema = res.schema or {}
        files = []
        if res.schema is not None:
            csv_path, geo_path, note_path = resolve_files(paths, name, res.schema)
        else:
            csv_path, geo_path, note_path = paths.csv(name), paths.geojson(name), paths.note(name)
        for role, p in (
            ("schema", paths.schema(name)),
            ("csv", csv_path),
            ("geojson", geo_path),
            ("notes", note_path),
        ):
            if p is not None and p.exists():
                files.append(_file_entry(paths, role, p))
        source = schema.get("source") if isinstance(schema.get("source"), dict) else {}
        datasets.append({
            "dataset": name,
            "primary_key": schema.get("primary_key"),
            "geometry_type": schema.get("geometry_type"),
            "source": source,
            "vintage": source.get("vintage"),
            "row_count": res.row_count,
            "csv_rows": res.csv_rows,
            "feature_count": res.feature_count,
            "files": files,
            "validation": {
                "status": res.status,
                "errors": len(res.errors),
                "warnings": len(res.warnings),
                "error_codes": res.codes("error"),
                "warning_codes": res.codes("warning"),
            },
        })
    return {
        "manifest_version": MANIFEST_VERSION,
        "generated_at": generated_at,
        "region": {
            "name": "100 mi radius around Westminster High School, Westminster CA",
            "center": {"lat": CENTER_LAT, "lon": CENTER_LON},
            "radius_mi": RADIUS_MI,
            "earth_radius_mi": EARTH_RADIUS_MI,
            "bbox": BBOX,
        },
        "validation_ok": report.ok,
        "datasets": datasets,
    }


def _file_index(manifest: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    out = {}
    for ds in manifest.get("datasets") or []:
        for f in ds.get("files") or []:
            if isinstance(f, dict) and "path" in f:
                out[f["path"]] = f
    return out


def check(paths: Paths) -> List[str]:
    """Return a list of differences between manifest.json and a fresh rebuild (empty = current)."""
    if not paths.manifest.exists():
        return ["%s does not exist" % paths.rel(paths.manifest)]
    try:
        recorded = json.loads(paths.manifest.read_text(encoding="utf-8"))
    except ValueError as exc:
        return ["%s is not valid JSON: %s" % (paths.rel(paths.manifest), exc)]
    if not isinstance(recorded, dict):
        return ["%s is not a JSON object" % paths.rel(paths.manifest)]
    fresh = build_manifest(paths, recorded.get("generated_at"))
    diffs: List[str] = []
    old_files, new_files = _file_index(recorded), _file_index(fresh)
    for path in sorted(set(old_files) | set(new_files)):
        old, new = old_files.get(path), new_files.get(path)
        if old is None:
            diffs.append("%s: on disk but not in manifest" % path)
        elif new is None:
            diffs.append("%s: in manifest but no longer present" % path)
        else:
            for k in ("bytes", "sha256", "role"):
                if old.get(k) != new.get(k):
                    diffs.append("%s: %s recorded %r, now %r" % (path, k, old.get(k), new.get(k)))
    if not diffs and dump_json(recorded) != dump_json(fresh):
        old_ds = {d.get("dataset"): d for d in recorded.get("datasets") or [] if isinstance(d, dict)}
        for d in fresh["datasets"]:
            o = old_ds.get(d["dataset"])
            if o != d:
                diffs.append("dataset %s: entry differs (rows / validation / source)" % d["dataset"])
        if set(old_ds) != {d["dataset"] for d in fresh["datasets"]}:
            diffs.append("dataset list differs")
        if not diffs:
            diffs.append("manifest content differs from a fresh rebuild")
    return diffs


def main(paths: Paths, generated_at: Optional[str] = None, check_only: bool = False) -> int:
    if check_only:
        diffs = check(paths)
        for d in diffs:
            print("manifest: STALE %s" % d)
        print("manifest: %s %s" % (paths.rel(paths.manifest), "is stale (%d difference(s)); regenerate with "
                                   "`python -m pipeline manifest --generated-at ...`" % len(diffs) if diffs
                                   else "is current"))
        return 1 if diffs else 0
    report = validate_all(paths)
    manifest = build_manifest(paths, generated_at, report)
    atomic_write_bytes(paths.manifest, dump_json(manifest))
    print("manifest: wrote %s (%d dataset(s), validation %s)"
          % (paths.rel(paths.manifest), len(manifest["datasets"]), "ok" if report.ok else "FAILED"))
    return 0
