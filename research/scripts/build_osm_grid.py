"""Convert raw Overpass JSON (OpenStreetMap power features) into Leaflet-ready GeoJSON.

Usage: python build_osm_grid.py <osm_lines.json> <osm_substations_plants.json> <out-dir>
Outputs:
  transmission_lines_westminster100mi.geojson  power=line ways with voltage_kv (max of tagged voltages), operator, cables
  substations_westminster100mi.geojson         substations as points (centroid of the outline), voltage_kv, name, operator
  osm_plants_westminster100mi.geojson          power=plant as points with source and output tags
Data (c) OpenStreetMap contributors, ODbL. Coverage of voltage/operator tags is incomplete.
"""
import json, sys


def kv(tag):
    vals = []
    for part in str(tag or "").replace(",", ";").split(";"):
        try:
            vals.append(float(part.strip()) / 1000)
        except ValueError:
            pass
    return max(vals) if vals else None


def centroid(el):
    if el.get("type") == "node":
        return [el["lon"], el["lat"]]
    if "center" in el:
        return [el["center"]["lon"], el["center"]["lat"]]
    pts = el.get("geometry") or []
    if not pts and "bounds" in el:
        b = el["bounds"]
        return [(b["minlon"] + b["maxlon"]) / 2, (b["minlat"] + b["maxlat"]) / 2]
    if not pts:
        return None
    return [sum(p["lon"] for p in pts) / len(pts), sum(p["lat"] for p in pts) / len(pts)]


def fc(features, note):
    return {"type": "FeatureCollection", "metadata": {"source": "OpenStreetMap via Overpass API", "license": "ODbL",
            "center_westminster_hs": [33.7538, -118.0111], "radius_mi": 100, "note": note}, "features": features}


def main(lines_path, subs_path, out):
    lines = json.load(open(lines_path))["elements"]
    feats = []
    for el in lines:
        if el.get("type") != "way" or not el.get("geometry"):
            continue
        t = el.get("tags", {})
        v = kv(t.get("voltage"))
        if v is not None and v < 69:
            continue  # keep >= 69 kV (and untagged) so the layer stays light
        feats.append({"type": "Feature",
                      "geometry": {"type": "LineString", "coordinates": [[round(p["lon"], 5), round(p["lat"], 5)] for p in el["geometry"]]},
                      "properties": {"osm_id": el["id"], "voltage_kv": v, "operator": t.get("operator"),
                                     "name": t.get("name"), "cables": t.get("cables"), "circuits": t.get("circuits"),
                                     "line": t.get("line")}})
    json.dump(fc(feats, "power=line ways >= 69 kV or untagged; voltage_kv is the highest tagged voltage"), open(f"{out}/transmission_lines_westminster100mi.geojson", "w"))
    by_kv = {}
    for f in feats:
        k = f["properties"]["voltage_kv"]
        b = "unknown" if k is None else ("500+" if k >= 500 else "200-499" if k >= 200 else "100-199" if k >= 100 else "<100")
        by_kv[b] = by_kv.get(b, 0) + 1
    print("lines:", len(feats), by_kv)

    els = json.load(open(subs_path))["elements"]
    subs, plants = [], []
    for el in els:
        t = el.get("tags", {})
        c = centroid(el)
        if not c:
            continue
        props = {"osm_id": f'{el["type"]}/{el["id"]}', "name": t.get("name"), "operator": t.get("operator")}
        if t.get("power") == "substation":
            props.update({"voltage_kv": kv(t.get("voltage")), "substation": t.get("substation")})
            subs.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(c[0], 5), round(c[1], 5)]}, "properties": props})
        elif t.get("power") == "plant":
            props.update({"source": t.get("plant:source"), "method": t.get("plant:method"), "output": t.get("plant:output:electricity"),
                          "start_date": t.get("start_date")})
            plants.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(c[0], 5), round(c[1], 5)]}, "properties": props})
    json.dump(fc(subs, "power=substation, point = outline centroid"), open(f"{out}/substations_westminster100mi.geojson", "w"))
    json.dump(fc(plants, "power=plant; prefer EIA-860 plants file for MW/age"), open(f"{out}/osm_plants_westminster100mi.geojson", "w"))
    print("substations:", len(subs), " plants:", len(plants), " named substations:", sum(1 for s in subs if s["properties"]["name"]))


if __name__ == "__main__":
    main(*sys.argv[1:4])
