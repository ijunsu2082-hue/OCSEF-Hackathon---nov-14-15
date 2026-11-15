"""Copy validated research layers into public/layers/. DRY RUN unless --publish.

* --publish copies research/layers/<dataset>.geojson to NEW names only:
  eia860_plants, hifld_transmission, hifld_substations, hifld_power_plants (.geojson).
* --replace-plants (with --publish) additionally replaces public/layers/plants.geojson
  with eia860_plants.geojson, but only if compat.py passes for PlantProperties. The
  features are re-ordered by nameplate_mw descending (then plant_code), the order the
  app draws markers in, so small plants stay on top; research/layers keeps primary-key
  order. The old file is backed up to research/backup/ first; every write is atomic
  (temp + os.replace).
* transmission.geojson and substations.geojson are never written.

Nothing is copied if any layer that would be published fails validation.
"""

import json
from pathlib import Path
from typing import Any, List, Tuple

from . import compat
from .common import Paths, atomic_write_bytes, load_json_file, sha256_bytes, sha256_file
from .validate import validate_all

PUBLISH_MAP = [
    ("eia860_plants", "eia860_plants.geojson"),
    ("hifld_power_plants", "hifld_power_plants.geojson"),
    ("hifld_substations", "hifld_substations.geojson"),
    ("hifld_transmission", "hifld_transmission.geojson"),
]
NEW_NAMES = {dest for _, dest in PUBLISH_MAP}
PLANTS_DEST = "plants.geojson"
PLANTS_SOURCE_DATASET = "eia860_plants"
PROTECTED = {"transmission.geojson", "substations.geojson", "niche_cases.json"}


class PublishError(RuntimeError):
    pass


def assert_allowed(dest_name: str, replace_plants: bool) -> None:
    if dest_name in PROTECTED:
        raise PublishError("refusing to write protected file %s" % dest_name)
    if dest_name in NEW_NAMES:
        return
    if dest_name == PLANTS_DEST and replace_plants:
        return
    raise PublishError("refusing to write %s (not an allowed publish target)" % dest_name)


def backup_file(paths: Paths, dest: Path) -> Path:
    """Copy dest to research/backup/<stem>.<sha12><suffix>; verify; return the path."""
    data = dest.read_bytes()
    digest = sha256_bytes(data)
    target = paths.backup / ("%s.%s%s" % (dest.stem, digest[:12], dest.suffix))
    if not target.exists() or sha256_file(target) != digest:
        atomic_write_bytes(target, data)
    if sha256_file(target) != digest:
        raise PublishError("backup verification failed for %s" % dest)
    return target


def plants_payload(src: Path) -> Tuple[Any, bytes]:
    """eia860_plants layer re-ordered for the app: nameplate_mw descending, then plant_code.

    Serialised deterministically (compact, UTF-8, trailing LF)."""
    doc, bad = load_json_file(src)
    if bad:
        raise PublishError("%s contains NaN/Infinity" % src)
    feats = list(doc.get("features") or [])
    feats.sort(key=lambda f: (-f["properties"]["nameplate_mw"], f["properties"]["plant_code"]))
    doc["features"] = feats
    text = json.dumps(doc, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n"
    return doc, text.encode("utf-8")


def target_bytes(src: Path, dest: Path) -> bytes:
    if dest.name == PLANTS_DEST:
        return plants_payload(src)[1]
    return src.read_bytes()


def write_target(paths: Paths, src: Path, dest: Path, replace_plants: bool) -> str:
    assert_allowed(dest.name, replace_plants)
    data = target_bytes(src, dest)
    if dest.exists():
        if dest.read_bytes() == data:
            return "unchanged"
        bk = backup_file(paths, dest)
        atomic_write_bytes(dest, data)
        return "replaced (backup %s)" % paths.rel(bk)
    atomic_write_bytes(dest, data)
    return "created"


def _owners(report, src: Path) -> List[str]:
    """Datasets whose validated GeoJSON is src, plus a same-stem tabular twin."""
    target = src.resolve()
    stem = src.name[: -len(".geojson")]
    names = [n for n, r in sorted(report.results.items()) if r.geo_path is not None and r.geo_path.resolve() == target]
    if names and stem in report.results and stem not in names:
        names.append(stem)
    return names


def plan(paths: Paths, replace_plants: bool) -> Tuple[List[Tuple[Path, Path]], List[str], List[str]]:
    """Return (copies, errors, notes) without touching anything."""
    errors: List[str] = []
    notes: List[str] = []
    copies: List[Tuple[Path, Path]] = []
    report = validate_all(paths)
    publishable = set()
    for stem, dest_name in PUBLISH_MAP:
        src = paths.geojson(stem)
        if not src.exists():
            notes.append("skip %s: %s not found" % (dest_name, paths.rel(src)))
            continue
        owners = _owners(report, src)
        if not owners:
            errors.append("%s exists but no schema validates it" % paths.rel(src))
            continue
        failed = [o for o in owners if report.results[o].errors]
        if failed:
            errors.append("%s failed validation (%s); run `python -m pipeline validate`"
                          % (paths.rel(src), ", ".join(failed)))
            continue
        shape = compat.shape_for_dataset(stem)
        if shape:
            c = compat.check_file(src, shape)
            notes.append("info %s vs %s: %s" % (paths.rel(src), compat.SHAPES[shape]["interface"],
                                                 "compatible" if c.ok else
                                                 "NOT compatible (%d error(s)); new name only, app unaffected"
                                                 % len(c.errors)))
        publishable.add(stem)
        copies.append((src, paths.public_layers / dest_name))
    if replace_plants:
        src = paths.geojson(PLANTS_SOURCE_DATASET)
        if PLANTS_SOURCE_DATASET not in publishable:
            errors.append("--replace-plants: %s missing or not valid" % paths.rel(src))
        else:
            dest = paths.public_layers / PLANTS_DEST
            try:
                doc, _ = plants_payload(src)
            except (OSError, ValueError, KeyError, TypeError, PublishError) as exc:
                errors.append("--replace-plants: cannot re-order %s: %s" % (paths.rel(src), exc))
                return copies, errors, notes
            c = compat.check_doc(doc, "plant", against=dest)
            for line in c.format().splitlines():
                notes.append("compat " + line.strip())
            if not c.ok:
                errors.append("--replace-plants: %s is not compatible with PlantProperties" % paths.rel(src))
            else:
                copies.append((src, dest))
    for _, dest in copies:
        assert_allowed(dest.name, replace_plants)
    return copies, errors, notes


def main(paths: Paths, do_publish: bool = False, replace_plants: bool = False) -> int:
    mode = "PUBLISH" if do_publish else "DRY RUN"
    if replace_plants and not do_publish:
        print("publish: --replace-plants has no effect without --publish (reporting only)")
    try:
        copies, errors, notes = plan(paths, replace_plants)
    except PublishError as exc:
        print("publish: ERROR %s" % exc)
        return 1
    for n in notes:
        print("publish: %s" % n)
    for e in errors:
        print("publish: ERROR %s" % e)
    if errors:
        print("publish: %s aborted, nothing written (%d error(s))" % (mode, len(errors)))
        return 1
    for src, dest in copies:
        if not do_publish:
            state = "would update" if dest.exists() else "would create"
            print("publish: %s %s <- %s" % (state, dest, paths.rel(src)))
            continue
        try:
            outcome = write_target(paths, src, dest, replace_plants)
        except (PublishError, OSError) as exc:
            print("publish: ERROR writing %s: %s" % (dest, exc))
            return 1
        print("publish: %s %s <- %s" % (outcome, dest, paths.rel(src)))
    print("publish: %s complete, %d target(s)%s" % (mode, len(copies), "" if do_publish else " (nothing written)"))
    return 0
