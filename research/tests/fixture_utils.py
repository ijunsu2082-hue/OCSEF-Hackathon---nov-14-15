"""Shared helpers for the pipeline tests (not a test module)."""

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

RESEARCH = Path(__file__).resolve().parents[1]
if str(RESEARCH) not in sys.path:
    sys.path.insert(0, str(RESEARCH))

from pipeline.common import Paths, distance_to_center_mi  # noqa: E402
from pipeline.validate import validate_all  # noqa: E402

GOOD = Path(__file__).resolve().parent / "fixtures" / "good"


class TempResearch(unittest.TestCase):
    """Each test gets a private copy of the good fixture tree plus a fake public/layers."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.research = self.root / "research"
        shutil.copytree(str(GOOD), str(self.research))
        self.public = self.root / "public" / "layers"
        self.public.mkdir(parents=True)
        self.paths = Paths(self.research, self.public)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # -- file helpers --
    def path(self, rel: str) -> Path:
        return self.research / rel

    def read(self, rel: str) -> bytes:
        return self.path(rel).read_bytes()

    def write(self, rel: str, data) -> None:
        p = self.path(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, str):
            data = data.encode("utf-8")
        p.write_bytes(data)

    def replace(self, rel: str, old: str, new: str, count: int = 1) -> None:
        text = self.read(rel).decode("utf-8")
        self.assertIn(old, text, "fixture text to replace not found in %s" % rel)
        self.write(rel, text.replace(old, new, count))

    def load(self, rel: str):
        return json.loads(self.read(rel).decode("utf-8"))

    def dump(self, rel: str, obj) -> None:
        self.write(rel, json.dumps(obj, indent=2) + "\n")

    # -- validation helpers --
    def report(self):
        return validate_all(self.paths)

    def errors(self, dataset: str):
        return self.report().results[dataset].codes("error")

    def assertFailsWith(self, dataset: str, code: str) -> None:
        rep = self.report()
        res = rep.results[dataset]
        self.assertFalse(rep.ok, "expected validation to fail")
        self.assertIn(code, res.codes("error"), rep.format())


def app_plant_feature(code: int, lon: float, lat: float) -> dict:
    """A feature satisfying the app's PlantProperties interface."""
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "plant_code": code,
            "plant_name": "Plant %d" % code,
            "utility_name": "Utility",
            "distance_mi": round(distance_to_center_mi(lon, lat), 1),
            "nameplate_mw": 50.0,
            "mw_by_source": {"solar": 50.0},
            "oldest_year": 2015,
            "newest_year": None,
            "planned_retirement_mw": 0.0,
            "generator_count": 1,
            "primary_source": "solar",
            "technologies": ["Solar Photovoltaic"],
            "capacity_weighted_age_years": None,
        },
    }


APP_PLANT_FIELDS = [
    ("plant_code", "integer", False), ("plant_name", "string", False), ("utility_name", "string", False),
    ("distance_mi", "number", False), ("nameplate_mw", "number", False), ("mw_by_source", "object", False),
    ("oldest_year", "integer", True), ("newest_year", "integer", True), ("planned_retirement_mw", "number", False),
    ("generator_count", "integer", False), ("primary_source", "string", False), ("technologies", "array", False),
    ("capacity_weighted_age_years", "number", True),
]


def make_app_plants_dataset(t: TempResearch) -> None:
    """Replace the fixture's eia860_plants with a GeoJSON-only, app-compatible version."""
    fields = [{"name": n, "type": ty, "nullable": nl, "description": n, "unit": None, "enum": None,
               "min": None, "max": None} for n, ty, nl in APP_PLANT_FIELDS]
    t.dump("schemas/eia860_plants.schema.json", {
        "dataset": "eia860_plants", "primary_key": ["plant_code"], "geometry_type": "Point",
        "source": {"name": "fixture", "url": "https://example.invalid", "vintage": "2025"},
        "fields": fields,
    })
    t.path("clean/eia860_plants.csv").unlink()
    t.dump("layers/eia860_plants.geojson", {"type": "FeatureCollection", "features": [
        app_plant_feature(400, -118.09913, 33.764741),
        app_plant_feature(56000, -118.25, 34.05),
    ]})
