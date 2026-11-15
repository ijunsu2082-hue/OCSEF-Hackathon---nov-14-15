"""Build power-plant datasets within 100 miles of Westminster High School, CA from EIA-860 (2025 annual).

Usage: python build_eia_plants.py <path-to-eia8602025.zip> <out-dir>
Outputs:
  plants_westminster100mi.geojson / .csv   one row per plant (operating generators aggregated)
  generators_westminster100mi.csv          one row per operating generator
  retired_generators_westminster100mi.csv  generators retired (useful for "spare socket" sites)
  proposed_generators_westminster100mi.csv generators planned / under construction
"""
import csv, io, json, math, sys, zipfile
import openpyxl

CENTER = (33.7538, -118.0111)  # Westminster High School
RADIUS_MI = 100.0
DATA_YEAR = 2025


def miles(lat1, lon1, lat2, lon2):
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def read_sheet(zf, name_part, sheet=None):
    member = next(n for n in zf.namelist() if name_part in n and n.endswith(".xlsx"))
    wb = openpyxl.load_workbook(io.BytesIO(zf.read(member)), read_only=True, data_only=True)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    header = None
    for row in rows:
        if row and "Plant Code" in [str(c).strip() if c is not None else "" for c in row]:
            header = [str(c).strip() if c is not None else "" for c in row]
            break
    out = []
    for row in rows:
        if row is None or row[0] is None:
            continue
        d = dict(zip(header, row))
        if d.get("Plant Code") in (None, ""):
            continue
        out.append(d)
    return out


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


FUEL_GROUP = {
    "SUN": "solar", "WND": "wind", "WAT": "hydro", "NUC": "nuclear", "NG": "natural_gas",
    "MWH": "battery", "GEO": "geothermal", "LFG": "biogas", "OBG": "biogas", "AB": "biomass",
    "WDS": "biomass", "MSW": "biomass", "OBS": "biomass", "DFO": "oil", "RFO": "oil", "JF": "oil",
    "KER": "oil", "SUB": "coal", "BIT": "coal", "PC": "other", "OTH": "other", "OG": "other_gas",
    "BFG": "other_gas", "PUR": "other", "WH": "waste_heat", "BLQ": "biomass",
}


def main(zip_path, out_dir):
    zf = zipfile.ZipFile(zip_path)
    plants = read_sheet(zf, "2___Plant")
    near = {}
    for p in plants:
        lat, lon = num(p.get("Latitude")), num(p.get("Longitude"))
        if lat is None or lon is None:
            continue
        d = miles(CENTER[0], CENTER[1], lat, lon)
        if d <= RADIUS_MI:
            near[p["Plant Code"]] = {
                "plant_code": p["Plant Code"], "plant_name": p.get("Plant Name"),
                "utility_name": p.get("Utility Name"), "lat": lat, "lon": lon,
                "distance_mi": round(d, 1), "county": p.get("County"), "city": p.get("City"),
                "balancing_authority": p.get("Balancing Authority Code"),
                "sector": p.get("Sector Name"), "grid_voltage_kv": p.get("Grid Voltage (kV)"),
            }

    def gens(sheet):
        return [g for g in read_sheet(zf, "3_1_Generator", sheet) if g["Plant Code"] in near]

    operable, retired, proposed = gens("Operable"), gens("Retired and Canceled"), gens("Proposed")

    gen_cols = ["Plant Code", "Plant Name", "Generator ID", "Technology", "Prime Mover", "Energy Source 1",
                "Nameplate Capacity (MW)", "Summer Capacity (MW)", "Operating Year", "Planned Retirement Year",
                "Status", "Retirement Year", "Current Year", "Effective Year"]

    def dump(rows, fname):
        cols = [c for c in gen_cols if rows and c in rows[0]]
        with open(f"{out_dir}/{fname}", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(cols + ["lat", "lon", "distance_mi"])
            for g in rows:
                p = near[g["Plant Code"]]
                w.writerow([g.get(c) for c in cols] + [p["lat"], p["lon"], p["distance_mi"]])

    dump(operable, "generators_westminster100mi.csv")
    dump(retired, "retired_generators_westminster100mi.csv")
    dump(proposed, "proposed_generators_westminster100mi.csv")

    agg = {}
    for g in operable:
        p = near[g["Plant Code"]]
        a = agg.setdefault(g["Plant Code"], {**p, "nameplate_mw": 0.0, "mw_by_source": {}, "techs": set(),
                                              "oldest_year": None, "newest_year": None, "_yr_mw": 0.0,
                                              "planned_retirement_mw": 0.0, "generator_count": 0})
        mw = num(g.get("Nameplate Capacity (MW)")) or 0.0
        yr = num(g.get("Operating Year"))
        src = FUEL_GROUP.get(str(g.get("Energy Source 1")), "other")
        a["nameplate_mw"] += mw
        a["mw_by_source"][src] = a["mw_by_source"].get(src, 0.0) + mw
        a["techs"].add(str(g.get("Technology")))
        a["generator_count"] += 1
        if yr:
            a["oldest_year"] = int(yr) if a["oldest_year"] is None else min(a["oldest_year"], int(yr))
            a["newest_year"] = int(yr) if a["newest_year"] is None else max(a["newest_year"], int(yr))
            a["_yr_mw"] += yr * mw
        if num(g.get("Planned Retirement Year")):
            a["planned_retirement_mw"] += mw

    features, rows = [], []
    for a in sorted(agg.values(), key=lambda x: -x["nameplate_mw"]):
        mw = a["nameplate_mw"]
        avg_year = round(a["_yr_mw"] / mw) if mw else a["oldest_year"]
        primary = max(a["mw_by_source"], key=a["mw_by_source"].get) if a["mw_by_source"] else "other"
        props = {k: v for k, v in a.items() if not k.startswith("_") and k not in ("lat", "lon", "techs")}
        props.update({
            "nameplate_mw": round(mw, 1), "primary_source": primary,
            "mw_by_source": {k: round(v, 1) for k, v in a["mw_by_source"].items()},
            "technologies": sorted(a["techs"]), "capacity_weighted_year": avg_year,
            "capacity_weighted_age_years": (DATA_YEAR - avg_year) if avg_year else None,
            "planned_retirement_mw": round(a["planned_retirement_mw"], 1),
        })
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [a["lon"], a["lat"]]},
                         "properties": props})
        rows.append({**props, "lat": a["lat"], "lon": a["lon"],
                     "mw_by_source": json.dumps(props["mw_by_source"]), "technologies": "; ".join(props["technologies"])})

    with open(f"{out_dir}/plants_westminster100mi.geojson", "w") as f:
        json.dump({"type": "FeatureCollection",
                   "metadata": {"source": f"EIA-860 {DATA_YEAR} annual (https://www.eia.gov/electricity/data/eia860/)",
                                "center": CENTER, "radius_mi": RADIUS_MI},
                   "features": features}, f)
    with open(f"{out_dir}/plants_westminster100mi.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)

    tot = sum(r["nameplate_mw"] for r in rows)
    by = {}
    for r in features:
        for k, v in r["properties"]["mw_by_source"].items():
            by[k] = by.get(k, 0) + v
    print(f"plants within {RADIUS_MI} mi: {len(rows)}  operating MW: {tot:,.0f}")
    print("MW by source:", {k: round(v) for k, v in sorted(by.items(), key=lambda kv: -kv[1])})
    print(f"operating generators: {len(operable)}  retired/canceled: {len(retired)}  proposed: {len(proposed)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
