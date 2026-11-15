import unittest

from fixture_utils import TempResearch

from pipeline.common import haversine_mi
from pipeline.validate import validate_all

CSV = "clean/eia860_plants.csv"
GEO = "layers/eia860_plants.geojson"
GEN = "clean/eia860_generators.csv"
LINES = "layers/hifld_transmission.geojson"
HPP = "layers/hifld_power_plants.geojson"
HAYNES_ROW = "400,Haynes,Los Angeles Department of Water & Power,true,1962-01-01,OP,1739.1,33.764741,-118.09913,5.1\n"


class GoodFixture(TempResearch):
    def test_good_fixture_passes(self):
        rep = self.report()
        self.assertTrue(rep.ok, rep.format())
        self.assertEqual(sorted(rep.results),
                         ["eia860_generators", "eia860_plants", "hifld_power_plants", "hifld_transmission"])
        self.assertEqual(rep.results["eia860_plants"].csv_rows, 3)
        self.assertEqual(rep.results["eia860_plants"].feature_count, 3)

    def test_match_rate_is_warning_not_error(self):
        res = self.report().results["hifld_power_plants"]
        self.assertEqual(res.errors, [])
        self.assertIn("ref.match_rate", res.codes("warning"))

    def test_haversine_reference_value(self):
        # Westminster HS -> Haynes generating station, ~5.1 mi.
        self.assertAlmostEqual(haversine_mi(33.7538, -118.0111, 33.764741, -118.09913), 5.1, delta=0.05)


class CsvFailures(TempResearch):
    def test_duplicate_pk(self):
        self.replace(CSV, HAYNES_ROW, HAYNES_ROW + HAYNES_ROW)
        self.assertFailsWith("eia860_plants", "pk.duplicate")

    def test_unsorted(self):
        text = self.read(CSV).decode()
        header, *rows = text.strip("\n").split("\n")
        self.write(CSV, "\n".join([header, rows[1], rows[0], rows[2]]) + "\n")
        self.assertFailsWith("eia860_plants", "pk.unsorted")

    def test_nan_token(self):
        self.replace(CSV, ",1739.1,", ",nan,")
        self.assertFailsWith("eia860_plants", "value.null_token")

    def test_other_null_tokens(self):
        original = self.read(CSV)
        for token in ("None", "NULL", "NaN", "-999999", "NOT AVAILABLE", "NaT", "<NA>",
                      "N/A", "n/a", "UNKNOWN", "Unknown", "TBD", "TBA"):
            with self.subTest(token=token):
                self.write(CSV, original)
                self.replace(CSV, "Los Angeles Department of Water & Power", token)
                self.assertFailsWith("eia860_plants", "value.null_token")

    def test_bom(self):
        self.write(CSV, b"\xef\xbb\xbf" + self.read(CSV))
        self.assertFailsWith("eia860_plants", "csv.bom")

    def test_crlf(self):
        self.write(CSV, self.read(CSV).replace(b"\n", b"\r\n"))
        self.assertFailsWith("eia860_plants", "csv.crlf")

    def test_header_mismatch(self):
        self.replace(CSV, "plant_name,", "name,")
        self.assertFailsWith("eia860_plants", "csv.header")

    def test_header_order_mismatch(self):
        text = self.read(CSV).decode()
        self.write(CSV, text.replace("latitude,longitude", "longitude,latitude", 1))
        self.assertFailsWith("eia860_plants", "csv.header")

    def test_integer_with_trailing_zero(self):
        self.replace(GEN, "400,1,222.5,1962", "400,1,222.5,1962.0")
        self.assertFailsWith("eia860_generators", "value.type")

    def test_thousands_separator(self):
        self.replace(CSV, ",1739.1,", ',"1,739.1",')
        self.assertFailsWith("eia860_plants", "value.type")

    def test_whitespace(self):
        self.replace(CSV, "Haynes", "Haynes  Station")
        self.assertFailsWith("eia860_plants", "value.whitespace")

    def test_boolean_and_date_and_enum(self):
        self.replace(CSV, ",true,1962-01-01,OP,", ",True,1962-13-01,XX,")
        codes = self.errors("eia860_plants")
        self.assertIn("value.type", codes)
        self.assertIn("value.enum", codes)

    def test_non_nullable_empty(self):
        self.replace(CSV, ",Haynes,", ",,")
        self.assertFailsWith("eia860_plants", "value.nullable")

    def test_min_max(self):
        self.replace(CSV, ",1739.1,", ",-5,")
        self.assertFailsWith("eia860_plants", "value.range")

    def test_referential_integrity(self):
        self.replace(GEN, "56000,BAT1", "56001,BAT1")
        self.assertFailsWith("eia860_generators", "ref.missing")

    def test_csv_row_outside_region(self):
        # GeoJSON untouched: the CSV latitude alone moves Haynes ~190 mi north.
        self.replace(CSV, ",33.764741,-118.09913,5.1", ",36.5,-118.09913,5.1")
        codes = self.errors("eia860_plants")
        self.assertIn("csv.region", codes)
        self.assertIn("csv.distance", codes)

    def test_csv_wrong_distance(self):
        self.replace(CSV, ",33.764741,-118.09913,5.1", ",33.764741,-118.09913,7.3")
        self.assertFailsWith("eia860_plants", "csv.distance")

    def test_csv_distance_within_rounding_passes(self):
        # 5.1 is the rounded value of ~5.06; 5.1 vs computed stays under 0.051.
        res = self.report().results["eia860_plants"]
        self.assertNotIn("csv.distance", res.codes("error"))

    def test_unknown_word_inside_value_is_fine(self):
        self.replace(CSV, ",Haynes,", ",UNKNOWN301234,")
        self.replace(GEO, '"Haynes"', '"UNKNOWN301234"')
        rep = self.report()
        self.assertTrue(rep.ok, rep.format())


class GeoFailures(TempResearch):
    def test_out_of_region_point(self):
        obj = self.load(HPP)
        obj["features"][2]["geometry"]["coordinates"] = [-121.4944, 38.5816]  # Sacramento, ~360 mi
        self.dump(HPP, obj)
        self.assertFailsWith("hifld_power_plants", "geo.region")

    def test_line_with_no_vertex_in_region(self):
        obj = self.load(LINES)
        obj["features"][0]["geometry"]["coordinates"] = [[-121.5, 38.5], [-121.4, 38.6]]
        self.dump(LINES, obj)
        self.assertFailsWith("hifld_transmission", "geo.region")

    def test_line_leaving_sanity_box_is_only_a_warning(self):
        obj = self.load(LINES)
        obj["features"][0]["geometry"]["coordinates"].append([-121.1, 45.6])
        self.dump(LINES, obj)
        res = self.report().results["hifld_transmission"]
        self.assertEqual(res.codes("error"), [], res.errors)
        self.assertIn("geo.bounds_line", res.codes("warning"))

    def test_point_outside_sanity_box(self):
        obj = self.load(HPP)
        obj["features"][0]["geometry"]["coordinates"] = [33.764741, -118.09913]  # swapped
        self.dump(HPP, obj)
        self.assertFailsWith("hifld_power_plants", "geo.bounds")

    def test_nan_coordinate(self):
        self.replace(GEO, "-118.09913,", "NaN,")
        self.assertFailsWith("eia860_plants", "geo.nonfinite")

    def test_precision(self):
        self.replace(GEO, "-118.09913,", "-118.0991301,")
        self.assertFailsWith("eia860_plants", "geo.precision")

    def test_geometry_type_mismatch(self):
        obj = self.load(HPP)
        obj["features"][0]["geometry"] = {"type": "LineString",
                                          "coordinates": [[-118.09913, 33.764741], [-118.0, 33.7]]}
        self.dump(HPP, obj)
        self.assertFailsWith("hifld_power_plants", "geo.geometry_type")

    def test_null_geometry(self):
        obj = self.load(HPP)
        obj["features"][0]["geometry"] = None
        self.dump(HPP, obj)
        self.assertFailsWith("hifld_power_plants", "geo.geometry")

    def test_property_keys_mismatch(self):
        obj = self.load(GEO)
        obj["features"][0]["properties"]["extra"] = 1
        self.dump(GEO, obj)
        self.assertFailsWith("eia860_plants", "geo.properties")

    def test_unsorted_features(self):
        obj = self.load(HPP)
        obj["features"].reverse()
        self.dump(HPP, obj)
        self.assertFailsWith("hifld_power_plants", "pk.unsorted")

    def test_distance_disagrees(self):
        obj = self.load(HPP)
        obj["features"][0]["properties"]["distance_mi"] = 50.0
        self.dump(HPP, obj)
        self.assertFailsWith("hifld_power_plants", "geo.distance")

    def test_csv_geojson_coordinate_disagreement(self):
        # 0.001 deg (~0.06 mi): inside the distance_mi tolerance, so only the twin check sees it.
        obj = self.load(GEO)
        obj["features"][0]["geometry"]["coordinates"] = [-118.10013, 33.764741]
        self.dump(GEO, obj)
        rep = self.report()
        res = rep.results["eia860_plants"]
        self.assertIn("geo.csv_mismatch", res.codes("error"), rep.format())
        self.assertNotIn("geo.distance", res.codes("error"))
        self.assertTrue(any("coordinates" in e["message"] for e in res.errors))

    def test_csv_geojson_property_value_disagreement(self):
        for prop, value in (("plant_name", "Haynes Generating Station"), ("nameplate_mw", 1739.2)):
            with self.subTest(prop=prop):
                obj = self.load(GEO)
                original = self.read(GEO)
                obj["features"][0]["properties"][prop] = value
                self.dump(GEO, obj)
                rep = self.report()
                res = rep.results["eia860_plants"]
                self.assertIn("geo.csv_mismatch", res.codes("error"), rep.format())
                self.assertTrue(any(prop in e["message"] for e in res.errors))
                self.write(GEO, original)

    def test_csv_geojson_pk_disagreement(self):
        obj = self.load(GEO)
        obj["features"].pop()
        self.dump(GEO, obj)
        self.assertFailsWith("eia860_plants", "geo.csv_mismatch")

    def test_integer_property_written_as_float(self):
        obj = self.load(HPP)
        obj["features"][0]["properties"]["eia_plant_code"] = 400.0
        self.dump(HPP, obj)
        self.assertFailsWith("hifld_power_plants", "value.type")


class LayerTwin(TempResearch):
    """eia860_plants (tabular) + eia860_plants_layer (spatial) describing layers/eia860_plants.geojson."""

    def setUp(self):
        super().setUp()
        schema = self.load("schemas/eia860_plants.schema.json")
        layer = dict(schema, dataset="eia860_plants_layer", fields=schema["geojson_fields"])
        del layer["geojson_fields"]
        self.dump("schemas/eia860_plants_layer.schema.json", layer)
        del schema["geojson_fields"]
        schema["geometry_type"] = None
        self.dump("schemas/eia860_plants.schema.json", schema)

    def test_twin_passes_and_subset_allowed(self):
        obj = self.load(GEO)
        obj["features"].pop(1)
        self.dump(GEO, obj)
        rep = self.report()
        self.assertTrue(rep.ok, rep.format())
        self.assertIn("geo.subset", rep.results["eia860_plants_layer"].codes("info"))

    def test_twin_key_not_in_csv_fails(self):
        obj = self.load(GEO)
        obj["features"][2]["properties"]["plant_code"] = 99999
        self.dump(GEO, obj)
        self.assertFailsWith("eia860_plants_layer", "geo.csv_mismatch")

    def test_unclaimed_geojson_with_null_geometry_fails(self):
        self.path("schemas/eia860_plants_layer.schema.json").unlink()
        self.assertFailsWith("eia860_plants", "file.unexpected")

    def test_twin_property_value_disagreement(self):
        obj = self.load(GEO)
        obj["features"][2]["properties"]["nameplate_mw"] = 101.0
        self.dump(GEO, obj)
        self.assertFailsWith("eia860_plants_layer", "geo.csv_mismatch")

    def test_twin_coordinate_disagreement(self):
        obj = self.load(GEO)
        obj["features"][0]["geometry"]["coordinates"] = [-118.09914, 33.764741]
        self.dump(GEO, obj)
        self.assertFailsWith("eia860_plants_layer", "geo.csv_mismatch")

    def test_tabular_only_csv_outside_region(self):
        # eia860_plants is tabular here; nothing but the CSV region check can catch this.
        self.replace(CSV, ",33.85,-117.9,9.2", ",36.5,-117.9,9.2")
        codes = self.errors("eia860_plants")
        self.assertIn("csv.region", codes)


class SchemaAndFiles(TempResearch):
    def test_unclaimed_csv_is_an_error(self):
        self.write("clean/mystery.csv", self.read(CSV))
        rep = self.report()
        self.assertFalse(rep.ok)
        self.assertTrue(any("file.unexpected" in g and "clean/mystery.csv" in g for g in rep.global_errors),
                        rep.format())

    def test_unclaimed_geojson_is_an_error(self):
        self.write("layers/mystery.geojson", self.read(HPP))
        rep = self.report()
        self.assertFalse(rep.ok)
        self.assertTrue(any("layers/mystery.geojson" in g for g in rep.global_errors), rep.format())

    def test_app_owned_layers_are_not_unexpected(self):
        for name in ("plants.geojson", "substations.geojson", "transmission.geojson"):
            self.write("layers/" + name, self.read(HPP))
        rep = self.report()
        self.assertFalse(any("file.unexpected" in g for g in rep.global_errors), rep.format())

    def test_schema_field_missing_key_is_an_error(self):
        for key in ("description", "unit", "enum", "nullable", "min", "max"):
            with self.subTest(key=key):
                original = self.read("schemas/eia860_generators.schema.json")
                schema = self.load("schemas/eia860_generators.schema.json")
                del schema["fields"][1][key]
                self.dump("schemas/eia860_generators.schema.json", schema)
                self.assertFailsWith("eia860_generators", "schema.fields")
                self.write("schemas/eia860_generators.schema.json", original)


class CrossField(TempResearch):
    def test_min_volt_above_max_volt_is_a_warning(self):
        schema = self.load("schemas/eia860_generators.schema.json")
        for name in ("max_volt_kv", "min_volt_kv"):
            schema["fields"].append({"name": name, "type": "number", "nullable": True, "description": name,
                                     "unit": "kV", "enum": None, "min": 0, "max": None})
        self.dump("schemas/eia860_generators.schema.json", schema)
        lines = self.read(GEN).decode().strip("\n").split("\n")
        lines[0] += ",max_volt_kv,min_volt_kv"
        lines[1] += ",16,66"
        for i in range(2, len(lines)):
            lines[i] += ",230,115"
        self.write(GEN, "\n".join(lines) + "\n")
        rep = self.report()
        res = rep.results["eia860_generators"]
        self.assertTrue(rep.ok, rep.format())
        self.assertIn("value.cross_field", res.codes("warning"))


class Discovery(TempResearch):
    def test_no_datasets_is_an_error(self):
        for p in self.path("schemas").glob("*.json"):
            p.unlink()
        self.assertFalse(validate_all(self.paths).ok)

    def test_missing_files(self):
        self.path(LINES).unlink()
        self.assertFailsWith("hifld_transmission", "file.missing")


if __name__ == "__main__":
    unittest.main()
