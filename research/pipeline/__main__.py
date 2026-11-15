"""CLI: python -m pipeline {fetch,validate,manifest,publish,compat,all}

Run from research/ with PYTHONPATH=. (paths are resolved from this package's location,
so the working directory does not change what gets read or written).
"""

import argparse
import subprocess
import sys
from typing import List, Optional

from . import compat, manifest, publish, validate
from .common import Paths


def run_fetch(paths: Paths, refresh: bool = False) -> int:
    scripts = sorted(paths.scripts.glob("fetch_*.py")) if paths.scripts.is_dir() else []
    if not scripts:
        print("fetch: no research/scripts/fetch_*.py found; nothing to run")
        return 0
    failed = []
    for script in scripts:
        cmd = [sys.executable, str(script)] + (["--refresh"] if refresh else [])
        print("fetch: running %s%s" % (paths.rel(script), " --refresh" if refresh else ""), flush=True)
        rc = subprocess.call(cmd, cwd=str(paths.research))
        if rc != 0:
            print("fetch: FAILED %s (exit %d)" % (paths.rel(script), rc), flush=True)
            failed.append(script.name)
    print("fetch: %d script(s), %d failed%s" % (len(scripts), len(failed), (": " + ", ".join(failed)) if failed else ""))
    return 1 if failed else 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m pipeline", description=__doc__)
    p.add_argument("--research-dir", default=None, help="override research/ root (tests)")
    p.add_argument("--public-dir", default=None, help="override public/layers/ (tests)")
    sub = p.add_subparsers(dest="cmd")
    sub.required = True

    f = sub.add_parser("fetch", help="run every research/scripts/fetch_*.py")
    f.add_argument("--refresh", action="store_true", help="pass --refresh to fetchers (re-download)")

    v = sub.add_parser("validate", help="validate datasets against their schemas")
    v.add_argument("--dataset", action="append", default=None, help="limit to dataset (repeatable)")
    v.add_argument("--json", dest="json_out", default=None, help="also write a JSON report here")

    m = sub.add_parser("manifest", help="write research/manifest.json")
    m.add_argument("--generated-at", default=None, help="timestamp recorded in the manifest")
    m.add_argument("--check", action="store_true",
                   help="do not write; exit 1 if manifest.json differs from a fresh rebuild")

    pb = sub.add_parser("publish", help="copy layers to public/layers (dry run by default)")
    pb.add_argument("--publish", action="store_true", help="actually write files")
    pb.add_argument("--replace-plants", action="store_true", help="also replace public/layers/plants.geojson")

    c = sub.add_parser("compat", help="check a geojson against an app TypeScript shape")
    c.add_argument("file")
    c.add_argument("--shape", required=True, choices=sorted(compat.SHAPES))
    c.add_argument("--against", default=None, help="existing file to compare feature counts with")

    a = sub.add_parser("all", help="fetch -> validate -> manifest -> publish (dry run unless --publish)")
    a.add_argument("--refresh", action="store_true")
    a.add_argument("--generated-at", default=None)
    a.add_argument("--publish", action="store_true")
    a.add_argument("--replace-plants", action="store_true")
    a.add_argument("--skip-fetch", action="store_true", help="validate existing outputs only")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    paths = Paths(args.research_dir, args.public_dir)
    if args.cmd == "fetch":
        return run_fetch(paths, args.refresh)
    if args.cmd == "validate":
        return validate.main(paths, args.dataset, args.json_out)
    if args.cmd == "manifest":
        return manifest.main(paths, args.generated_at, args.check)
    if args.cmd == "publish":
        return publish.main(paths, args.publish, args.replace_plants)
    if args.cmd == "compat":
        return compat.main(args.file, args.shape, args.against)
    if args.cmd == "all":
        if not args.skip_fetch:
            rc = run_fetch(paths, args.refresh)
            if rc:
                return rc
        rc = validate.main(paths)
        # The manifest records validation status, so write it even on failure.
        manifest.main(paths, args.generated_at)
        if rc:
            print("all: validation failed; not publishing")
            return rc
        return publish.main(paths, args.publish, args.replace_plants)
    return 2


if __name__ == "__main__":
    sys.exit(main())
