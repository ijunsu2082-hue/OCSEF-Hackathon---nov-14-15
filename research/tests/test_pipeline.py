import contextlib
import io
import json
import os
import stat
import unittest

from fixture_utils import TempResearch, app_plant_feature, make_app_plants_dataset

from pipeline import compat, manifest, publish
from pipeline.__main__ import main as cli_main
from pipeline.common import sha256_file


def quiet(fn, *args, **kwargs):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = fn(*args, **kwargs)
    return rc, buf.getvalue()


class Compat(TempResearch):
    def test_app_plant_shape_passes(self):
        doc = {"type": "FeatureCollection", "features": [app_plant_feature(1, -118.0, 33.7)]}
        res = compat.check_collection(doc, "plant")
        self.assertTrue(res.ok, res.format())

    def test_missing_and_wrong_types_fail(self):
        f = app_plant_feature(1, -118.0, 33.7)
        del f["properties"]["mw_by_source"]
        f["properties"]["technologies"] = "Solar"
        f["properties"]["oldest_year"] = "2015"
        res = compat.check_collection({"type": "FeatureCollection", "features": [f]}, "plant")
        self.assertFalse(res.ok)
        joined = "\n".join(res.errors)
        for key in ("mw_by_source", "technologies", "oldest_year"):
            self.assertIn(key, joined)

    def test_research_fixture_is_not_plant_compatible(self):
        res = compat.check_file(self.path("layers/eia860_plants.geojson"), "plant")
        self.assertFalse(res.ok)

    def test_transmission_requires_linestring(self):
        res = compat.check_file(self.path("layers/hifld_transmission.geojson"), "transmission")
        self.assertFalse(res.ok)  # no osm_id and one MultiLineString

    def test_substation_shape(self):
        doc = {"type": "FeatureCollection", "features": [{
            "type": "Feature", "geometry": {"type": "Point", "coordinates": [-118.0, 33.7]},
            "properties": {"osm_id": "node/1", "name": None, "operator": None, "voltage_kv": 230, "substation": None}}]}
        self.assertTrue(compat.check_collection(doc, "substation").ok)
        doc["features"][0]["properties"]["osm_id"] = 1
        self.assertFalse(compat.check_collection(doc, "substation").ok)


class Manifest(TempResearch):
    def test_manifest_contents_and_determinism(self):
        rc, _ = quiet(manifest.main, self.paths, "2026-11-14")
        self.assertEqual(rc, 0)
        first = self.paths.manifest.read_bytes()
        quiet(manifest.main, self.paths, "2026-11-14")
        self.assertEqual(first, self.paths.manifest.read_bytes())
        self.assertTrue(first.endswith(b"\n") and b"\r" not in first)
        m = json.loads(first)
        self.assertEqual(m["generated_at"], "2026-11-14")
        self.assertTrue(m["validation_ok"])
        ds = {d["dataset"]: d for d in m["datasets"]}
        self.assertEqual(sorted(ds), ["eia860_generators", "eia860_plants", "hifld_power_plants", "hifld_transmission"])
        plants = ds["eia860_plants"]
        self.assertEqual(plants["row_count"], 3)
        self.assertEqual(plants["primary_key"], ["plant_code"])
        self.assertEqual(plants["vintage"], "2025")
        roles = {f["role"]: f for f in plants["files"]}
        self.assertEqual(sorted(roles), ["csv", "geojson", "notes", "schema"])
        self.assertEqual(roles["csv"]["path"], "clean/eia860_plants.csv")
        self.assertEqual(roles["csv"]["sha256"], sha256_file(self.path("clean/eia860_plants.csv")))
        self.assertEqual(plants["validation"]["status"], "pass")
        self.assertEqual(ds["hifld_power_plants"]["validation"]["status"], "warn")

    def test_manifest_check_detects_stale_entries(self):
        quiet(manifest.main, self.paths, "2026-11-14")
        rc, out = quiet(manifest.main, self.paths, None, True)
        self.assertEqual(rc, 0, out)
        self.assertIn("is current", out)
        schema = self.path("schemas/hifld_power_plants.schema.json")
        # Rewritten after the manifest was generated (what happened to this schema in the real tree).
        obj = json.loads(schema.read_text())
        obj["fields"][0]["description"] += " (edited)"
        schema.write_text(json.dumps(obj, indent=2) + "\n")
        rc, out = quiet(manifest.main, self.paths, None, True)
        self.assertEqual(rc, 1, out)
        self.assertIn("schemas/hifld_power_plants.schema.json", out)
        self.assertIn("sha256", out)

    def test_manifest_check_cli_and_missing_manifest(self):
        argv = ["--research-dir", str(self.research), "--public-dir", str(self.public), "manifest", "--check"]
        rc, out = quiet(cli_main, argv)
        self.assertEqual(rc, 1, out)  # no manifest yet
        quiet(cli_main, ["--research-dir", str(self.research), "--public-dir", str(self.public),
                         "manifest", "--generated-at", "2026-11-14"])
        rc, out = quiet(cli_main, argv)
        self.assertEqual(rc, 0, out)
        self.assertEqual(json.loads(self.paths.manifest.read_text())["generated_at"], "2026-11-14")

    def test_manifest_file_mode(self):
        quiet(manifest.main, self.paths, "2026-11-14")
        self.assertEqual(stat.S_IMODE(os.stat(str(self.paths.manifest)).st_mode), 0o644)

    def test_manifest_records_failure(self):
        self.write("clean/eia860_plants.csv", b"\xef\xbb\xbf" + self.read("clean/eia860_plants.csv"))
        quiet(manifest.main, self.paths, None)
        m = json.loads(self.paths.manifest.read_text())
        self.assertIsNone(m["generated_at"])
        self.assertFalse(m["validation_ok"])
        plants = [d for d in m["datasets"] if d["dataset"] == "eia860_plants"][0]
        self.assertEqual(plants["validation"]["status"], "fail")
        self.assertIn("csv.bom", plants["validation"]["error_codes"])


class Publish(TempResearch):
    def test_dry_run_writes_nothing(self):
        (self.public / "plants.geojson").write_text("OLD")
        rc, out = quiet(publish.main, self.paths, False, True)
        self.assertEqual(rc, 1, out)  # fixture plants layer is not PlantProperties-compatible
        rc, out = quiet(publish.main, self.paths, False, False)
        self.assertEqual(rc, 0, out)
        self.assertIn("would create", out)
        self.assertEqual(sorted(p.name for p in self.public.iterdir()), ["plants.geojson"])
        self.assertFalse(self.paths.backup.exists())

    def test_publish_new_names_only(self):
        for name in ("plants.geojson", "transmission.geojson", "substations.geojson"):
            (self.public / name).write_text("ORIGINAL " + name)
        rc, out = quiet(publish.main, self.paths, True, False)
        self.assertEqual(rc, 0, out)
        for name in ("plants.geojson", "transmission.geojson", "substations.geojson"):
            self.assertEqual((self.public / name).read_text(), "ORIGINAL " + name)
        for name in ("eia860_plants.geojson", "hifld_transmission.geojson", "hifld_power_plants.geojson"):
            self.assertEqual((self.public / name).read_bytes(), self.read("layers/" + name))
        self.assertFalse((self.public / "hifld_substations.geojson").exists())
        self.assertEqual([p for p in self.public.iterdir() if p.name.endswith(".tmp")], [])
        rc, out = quiet(publish.main, self.paths, True, False)
        self.assertIn("unchanged", out)

    def test_replace_plants_refused_when_incompatible(self):
        (self.public / "plants.geojson").write_text("ORIGINAL")
        rc, out = quiet(publish.main, self.paths, True, True)
        self.assertEqual(rc, 1, out)
        self.assertEqual((self.public / "plants.geojson").read_text(), "ORIGINAL")
        self.assertFalse((self.public / "eia860_plants.geojson").exists(), "nothing written on abort")

    def test_replace_plants_with_backup(self):
        make_app_plants_dataset(self)
        (self.public / "plants.geojson").write_text("ORIGINAL")
        (self.public / "transmission.geojson").write_text("T")
        rc, out = quiet(publish.main, self.paths, True, True)
        self.assertEqual(rc, 0, out)
        expected = publish.plants_payload(self.path("layers/eia860_plants.geojson"))[1]
        self.assertEqual((self.public / "plants.geojson").read_bytes(), expected)
        backups = list(self.paths.backup.glob("plants.*.geojson"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), "ORIGINAL")
        self.assertEqual((self.public / "transmission.geojson").read_text(), "T")

    def test_replace_plants_orders_by_nameplate_descending(self):
        make_app_plants_dataset(self)
        obj = self.load("layers/eia860_plants.geojson")
        obj["features"][0]["properties"]["nameplate_mw"] = 10.0     # plant 400: small
        obj["features"][1]["properties"]["nameplate_mw"] = 900.0    # plant 56000: big
        self.dump("layers/eia860_plants.geojson", obj)
        rc, out = quiet(publish.main, self.paths, True, True)
        self.assertEqual(rc, 0, out)
        published = json.loads((self.public / "plants.geojson").read_text())
        self.assertEqual([f["properties"]["plant_code"] for f in published["features"]], [56000, 400])
        # research layer keeps primary-key order; the new-name copy is verbatim
        self.assertEqual([f["properties"]["plant_code"] for f in self.load("layers/eia860_plants.geojson")["features"]],
                         [400, 56000])
        self.assertEqual((self.public / "eia860_plants.geojson").read_bytes(), self.read("layers/eia860_plants.geojson"))
        rc, out = quiet(publish.main, self.paths, True, True)
        self.assertIn("unchanged %s" % (self.public.resolve() / "plants.geojson"), out)

    def test_compat_warns_on_draw_order_change(self):
        old = {"type": "FeatureCollection", "features": [app_plant_feature(1, -118.0, 33.7),
                                                         app_plant_feature(2, -118.1, 33.8)]}
        old["features"][0]["properties"]["nameplate_mw"] = 500.0
        (self.public / "plants.geojson").write_text(json.dumps(old))
        new = json.loads(json.dumps(old))
        new["features"].reverse()
        res = compat.check_doc(new, "plant", against=self.public / "plants.geojson")
        self.assertTrue(res.ok, res.format())
        self.assertTrue(any("nameplate_mw descending" in w for w in res.warnings), res.format())
        res = compat.check_doc(old, "plant", against=self.public / "plants.geojson")
        self.assertFalse(any("order" in w for w in res.warnings), res.format())

    def test_published_files_are_world_readable(self):
        make_app_plants_dataset(self)
        (self.public / "plants.geojson").write_text("ORIGINAL")
        os.chmod(str(self.public / "plants.geojson"), 0o644)
        rc, out = quiet(publish.main, self.paths, True, True)
        self.assertEqual(rc, 0, out)
        for p in self.public.iterdir():
            self.assertEqual(stat.S_IMODE(os.stat(str(p)).st_mode), 0o644, p.name)

    def test_validation_failure_blocks_publish(self):
        self.write("clean/eia860_plants.csv", self.read("clean/eia860_plants.csv").replace(b"\n", b"\r\n"))
        rc, out = quiet(publish.main, self.paths, True, False)
        self.assertEqual(rc, 1, out)
        self.assertEqual(list(self.public.iterdir()), [])

    def test_guard_refuses_protected_names(self):
        for name in ("transmission.geojson", "substations.geojson", "anything.geojson"):
            with self.assertRaises(publish.PublishError):
                publish.assert_allowed(name, True)
        with self.assertRaises(publish.PublishError):
            publish.assert_allowed("plants.geojson", False)
        publish.assert_allowed("plants.geojson", True)
        publish.assert_allowed("hifld_substations.geojson", False)


class Cli(TempResearch):
    def run_cli(self, *args):
        return quiet(cli_main, ["--research-dir", str(self.research), "--public-dir", str(self.public)] + list(args))

    def test_validate_exit_codes(self):
        rc, out = self.run_cli("validate")
        self.assertEqual(rc, 0, out)
        self.write("clean/eia860_plants.csv", b"\xef\xbb\xbf" + self.read("clean/eia860_plants.csv"))
        rc, out = self.run_cli("validate", "--json", str(self.root / "report.json"))
        self.assertEqual(rc, 1, out)
        self.assertFalse(json.loads((self.root / "report.json").read_text())["ok"])

    def test_fetch_runs_scripts_and_fails_on_failure(self):
        scripts = self.path("scripts")
        scripts.mkdir()
        (scripts / "fetch_ok.py").write_text("print('ok: 1 rows')\n")
        rc, out = self.run_cli("fetch")
        self.assertEqual(rc, 0, out)
        (scripts / "fetch_zbad.py").write_text("import sys\nsys.exit(3)\n")
        rc, out = self.run_cli("fetch")
        self.assertEqual(rc, 1, out)
        self.assertIn("fetch_zbad.py", out)

    def test_all_dry_run(self):
        rc, out = self.run_cli("all", "--skip-fetch", "--generated-at", "2026-11-14")
        self.assertEqual(rc, 0, out)
        self.assertTrue(self.paths.manifest.exists())
        self.assertEqual(list(self.public.iterdir()), [])

    def test_compat_cli(self):
        rc, _ = self.run_cli("compat", str(self.path("layers/eia860_plants.geojson")), "--shape", "plant")
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()

