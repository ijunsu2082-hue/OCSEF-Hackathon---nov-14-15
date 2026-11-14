"""Name unnamed OSM substations from the California Energy Commission (CEC) substation list.

Input:
  research/layers/substations.geojson  (OSM, from build_osm_grid.py)
  a CEC substation GeoJSON (public ArcGIS copy of "California Electrical Substations":
  https://services.arcgis.com/OCBQIMs6mxgHZEQ0/arcgis/rest/services/California_Electrical_Substations/FeatureServer/0)

Output:
  research/layers/substation_names.json  {osm_id: {name, owner, kv_class, cec_id, distance_m}}
  (scripts/sync-layers.mjs copies it to public/layers/)

Rules:
  - only CEC stations with Status Operational / Low kV / null
  - pairs within 200 m, assigned one-to-one, closest pair first. Named OSM substations take part
    in the assignment (a CEC point that is closest to an already-named OSM substation is that
    station, so it names nothing else), but only unnamed OSM substations receive a name.
  - a pair is skipped (it names nothing and uses up neither side) when the OSM voltage_kv is
    set and lies more than 1 kV outside the CEC kv_class, or the OSM operator is set and
    does not match the CEC owner after alias mapping (SCE, SDG&E, LADWP, IID, PG&E)
  - placeholder CEC names (blank, N.N., Unknown) are skipped
  - "54" / "Sta. 54" -> "Station 54"; a leading "Sta. X" -> "Station X"; acronyms MWD, SCE,
    LADWP, SDG&E, PG&E, IID are restored to capitals; otherwise append " Substation" unless
    the name already says Substation / Station / Sta. / Switchyard / Switching.

Run: python3 research/scripts/match_substation_names.py <cec_subs.geojson>
"""
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OSM = ROOT / "research" / "layers" / "substations.geojson"
OUT = ROOT / "research" / "layers" / "substation_names.json"
MAX_M = 200.0
KEEP_STATUS = {"Operational", "Low kV", None}
PLACEHOLDER = re.compile(r"^(n\.?\s*n\.?|unknown|none|tbd|-+)?$", re.I)
NUMERIC = re.compile(r"^(?:sta\.?\s*)?(\d+)$", re.I)
HAS_KIND = re.compile(r"\b(substation|station|switchyard|switching)\b|\bsta\.", re.I)
LEADING_STA = re.compile(r"^sta\.\s*", re.I)
ACRONYM = re.compile(r"(?<![A-Za-z])(mwd|sce|ladwp|sdg&e|pg&e|iid)(?![A-Za-z])", re.I)
KV_RANGE = re.compile(r"(\d+(?:\.\d+)?)\s*kV(?:\s*to\s*(\d+(?:\.\d+)?)\s*kV)?", re.I)
KV_TOL = 1.0
CEC_OWNERS = {"SCE", "SDG&E", "LADWP", "IID", "PG&E"}
# OSM operator text -> CEC owner code (lower-cased, punctuation-stripped keys)
OPERATOR_ALIAS = [
    ("SCE", re.compile(r"^(sce|southern california edison|so ?cal edison)\b")),
    ("SDG&E", re.compile(r"^(sdg ?& ?e|sdge|san d(ie|ei)go gas (&|and) electric)\b")),
    ("LADWP", re.compile(r"^(ladwp|los angeles department (of )?(water )?and power)\b")),
    ("IID", re.compile(r"^(iid|imperial irrigation district)\b")),
    ("PG&E", re.compile(r"^(pg ?& ?e|pge|pacific gas (&|and) electric)\b")),
]


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def display_name(raw):
    """CEC name -> label, or None for placeholders."""
    if raw is None:
        return None
    n = " ".join(str(raw).split())
    if PLACEHOLDER.match(n):
        return None
    m = NUMERIC.match(n)
    if m:
        return f"Station {m.group(1)}"
    n = LEADING_STA.sub("Station ", n)
    n = ACRONYM.sub(lambda a: a.group(1).upper(), n)
    if HAS_KIND.search(n):
        return n
    return f"{n} Substation"


def kv_bounds(kv_class):
    """CEC kv_class ("33kV to 92kV", "500 kV DC") -> (lo, hi) in kV, or None."""
    m = KV_RANGE.search(kv_class or "")
    if not m:
        return None
    lo = float(m.group(1))
    return lo, float(m.group(2) or lo)


def operator_code(operator):
    """OSM operator -> one of CEC_OWNERS, or "Other" for any other utility/company."""
    t = " ".join(re.sub(r"[^a-z0-9& ]", " ", operator.lower()).split())
    for code, rx in OPERATOR_ALIAS:
        if rx.match(t):
            return code
    return "Other"


def conflict(s, c):
    """Reason the OSM substation s and CEC station c disagree, or None."""
    b = kv_bounds(c["kv_class"])
    if s["kv"] is not None and b and not (b[0] - KV_TOL <= s["kv"] <= b[1] + KV_TOL):
        return "voltage"
    if s["operator"] and c["owner"]:
        osm = operator_code(s["operator"])
        cec = c["owner"] if c["owner"] in CEC_OWNERS else "Other"
        if osm != cec:
            return "operator"
    return None


def main(cec_path):
    osm = json.loads(OSM.read_text())["features"]
    cec = json.loads(Path(cec_path).read_text())["features"]

    subs = []
    for f in osm:
        if (f.get("geometry") or {}).get("type") != "Point":
            continue
        lon, lat = f["geometry"]["coordinates"]
        p = f["properties"]
        subs.append({"id": str(p["osm_id"]), "named": bool(p.get("name")), "lat": lat, "lon": lon,
                     "kv": p.get("voltage_kv"), "operator": p.get("operator")})

    stations = []
    skipped_status = skipped_placeholder = 0
    for f in cec:
        p = f["properties"]
        if p.get("Status") not in KEEP_STATUS:
            skipped_status += 1
            continue
        if (f.get("geometry") or {}).get("type") != "Point":
            continue
        name = display_name(p.get("Substation_Name"))
        if name is None:
            skipped_placeholder += 1
            continue
        lon, lat = f["geometry"]["coordinates"]
        stations.append({"name": name, "raw": p.get("Substation_Name"), "owner": p.get("Owner"),
                         "kv_class": p.get("Highest_kV"), "cec_id": p.get("Substation_ID"),
                         "lat": lat, "lon": lon})

    # all pairs within MAX_M (coarse lat/lon prefilter; 0.003 deg > 200 m at these latitudes)
    pairs = []
    for i, c in enumerate(stations):
        for j, s in enumerate(subs):
            if abs(c["lat"] - s["lat"]) > 0.003 or abs(c["lon"] - s["lon"]) > 0.003:
                continue
            d = haversine_m(c["lat"], c["lon"], s["lat"], s["lon"])
            if d <= MAX_M:
                pairs.append((d, i, j))
    pairs.sort()

    used_c, used_s, out = set(), set(), {}
    skipped_conflict = {"voltage": 0, "operator": 0}
    for d, i, j in pairs:
        if i in used_c or j in used_s:
            continue
        why = conflict(subs[j], stations[i])
        if why:
            skipped_conflict[why] += 1
            continue
        used_c.add(i)
        used_s.add(j)
        s, c = subs[j], stations[i]
        if s["named"]:
            continue
        out[s["id"]] = {"name": c["name"], "owner": c["owner"], "kv_class": c["kv_class"],
                        "cec_id": c["cec_id"], "distance_m": round(d, 1)}

    out = dict(sorted(out.items()))
    OUT.write_text(json.dumps(out, indent=1) + "\n")

    named_before = sum(s["named"] for s in subs)
    print(f"OSM substations: {len(subs)}, named before: {named_before}, unnamed: {len(subs) - named_before}")
    print(f"CEC stations used: {len(stations)} (skipped status {skipped_status}, placeholder names {skipped_placeholder})")
    print(f"pairs skipped for conflicts: voltage {skipped_conflict['voltage']}, operator {skipped_conflict['operator']}")
    print(f"named from CEC list: {len(out)}; named after: {named_before + len(out)} of {len(subs)}")
    ds = sorted(v["distance_m"] for v in out.values())
    if ds:
        print(f"distance m: median {ds[len(ds) // 2]}, max {ds[-1]}")
    print(f"wrote {OUT}")
    print("examples:")
    for k, v in list(out.items())[:: max(1, len(out) // 20)][:20]:
        print(f"  {k:22s} {v['name']:36s} {v['owner'] or '':7s} {v['kv_class'] or '':15s} {v['distance_m']} m")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
