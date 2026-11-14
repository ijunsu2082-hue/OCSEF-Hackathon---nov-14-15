#!/usr/bin/env python
"""Fetch EIA Form 860 (annual, final) and build regional plant / generator datasets.

Outputs (all paths relative to research/):
  raw/eia860/eia860YYYY.zip + raw/eia860/SOURCE.json   (raw download, never committed)
  clean/eia860_plants.csv                              (PK plant_code)
  clean/eia860_generators.csv                          (PK plant_code, generator_id)
  layers/eia860_plants.geojson                         (Point layer, superset of lib/gridLayers.ts PlantProperties)
  schemas/eia860_plants.schema.json
  schemas/eia860_generators.schema.json
  schemas/eia860_plants_layer.schema.json             (describes layers/eia860_plants.geojson)

Region: haversine distance <= 100 mi from Westminster High School (33.7538, -118.0111).

Usage:  python scripts/fetch_eia860.py [--refresh]
  --refresh  re-download the zip even if a cached copy exists.

Idempotent and deterministic: same raw zip -> byte-identical outputs.
Diagnostics go to stderr; a one-line row-count summary goes to stdout.
"""
import argparse
import csv
import datetime
import hashlib
import io
import json
import math
import os
import re
import sys
import zipfile
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPORT_YEAR = 2025
ZIP_NAME = "eia860{}.zip".format(REPORT_YEAR)
ZIP_URL = "https://www.eia.gov/electricity/data/eia860/xls/" + ZIP_NAME
LANDING_URL = "https://www.eia.gov/electricity/data/eia860/"
VINTAGE = "{} final (released 2026-09-10)".format(REPORT_YEAR)
SOURCE_NAME = "U.S. EIA Form EIA-860 Annual Electric Generator Report"

CENTER_LAT = 33.7538
CENTER_LON = -118.0111
RADIUS_MI = 100.0
EARTH_RADIUS_MI = 3958.8
# The 100-mi circle only contains California land (plus ocean / Baja California, for which
# EIA-860 has no plants). A plant whose coordinates fall in the circle but whose reported
# state is elsewhere is a geocoding error in EIA's data and is dropped (logged).
REGION_STATES = {"CA"}

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.dirname(HERE)
REPO = os.path.dirname(RESEARCH)
RAW_DIR = os.path.join(RESEARCH, "raw", "eia860")
CLEAN_DIR = os.path.join(RESEARCH, "clean")
LAYER_DIR = os.path.join(RESEARCH, "layers")
SCHEMA_DIR = os.path.join(RESEARCH, "schemas")
PUBLIC_PLANTS = os.path.join(REPO, "public", "layers", "plants.geojson")

PLANT_XLSX = "2___Plant_Y{}.xlsx".format(REPORT_YEAR)
GEN_XLSX = "3_1_Generator_Y{}.xlsx".format(REPORT_YEAR)

SOURCE_CATEGORIES = [
    "natural_gas", "solar", "battery", "wind", "hydro", "biogas", "other_gas",
    "waste_heat", "oil", "nuclear", "geothermal", "coal", "biomass", "other",
]

# EIA-860 energy source codes -> source_category (see LayoutY2025.xlsx, "Energy Source Codes").
ENERGY_SOURCE_MAP = {
    # natural gas
    "NG": "natural_gas",
    # solar / wind / hydro / storage
    "SUN": "solar",
    "WND": "wind",
    "WAT": "hydro",
    "MWH": "battery",
    # biogas (gaseous biomass)
    "LFG": "biogas", "OBG": "biogas",
    # other gases
    "OG": "other_gas", "BFG": "other_gas", "PG": "other_gas", "SGP": "other_gas", "H2": "other_gas",
    # waste heat / purchased steam
    "WH": "waste_heat", "PUR": "waste_heat",
    # petroleum
    "DFO": "oil", "RFO": "oil", "JF": "oil", "KER": "oil", "WO": "oil", "PC": "oil",
    # nuclear / geothermal
    "NUC": "nuclear",
    "GEO": "geothermal",
    # coal
    "BIT": "coal", "SUB": "coal", "LIG": "coal", "ANT": "coal", "RC": "coal", "WC": "coal",
    "SC": "coal", "SGC": "coal",
    # solid / liquid biomass and biogenic waste
    "WDS": "biomass", "WDL": "biomass", "BLQ": "biomass", "AB": "biomass", "OBS": "biomass",
    "OBL": "biomass", "SLW": "biomass", "MSW": "biomass", "MSB": "biomass",
    # everything else
    "MSN": "other", "TDF": "other", "OTH": "other",
}

GROUP_ORDER = {"operable": 0, "proposed": 1, "retired": 2}


def log(msg: str) -> None:
    sys.stderr.write(msg + "\n")


class PipelineError(Exception):
    pass


# ---------------------------------------------------------------------------
# Download + provenance
# ---------------------------------------------------------------------------

def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_raw(refresh: bool) -> str:
    os.makedirs(RAW_DIR, exist_ok=True)
    zip_path = os.path.join(RAW_DIR, ZIP_NAME)
    downloaded = False
    if refresh or not os.path.exists(zip_path):
        log("downloading " + ZIP_URL)
        resp = requests.get(ZIP_URL, timeout=300, headers={"User-Agent": "Mozilla/5.0 (research data pipeline)"})
        if resp.status_code != 200:
            raise PipelineError("download failed: HTTP {} for {}".format(resp.status_code, ZIP_URL))
        tmp = zip_path + ".part"
        with open(tmp, "wb") as fh:
            fh.write(resp.content)
        if not zipfile.is_zipfile(tmp):
            os.remove(tmp)
            raise PipelineError("downloaded file is not a zip archive")
        os.replace(tmp, zip_path)
        downloaded = True
    else:
        log("using cached " + zip_path)

    digest = sha256_file(zip_path)
    src_path = os.path.join(RAW_DIR, "SOURCE.json")
    existing = None
    if os.path.exists(src_path):
        with open(src_path, encoding="utf-8") as fh:
            try:
                existing = json.load(fh)
            except ValueError:
                existing = None
    if downloaded or existing is None or existing.get("sha256") != digest:
        retrieved = datetime.date.today().isoformat()
        if existing is not None and existing.get("sha256") == digest:
            retrieved = existing.get("retrieved", retrieved)
        meta = {
            "source": SOURCE_NAME,
            "landing_page": LANDING_URL,
            "url": ZIP_URL,
            "file": ZIP_NAME,
            "bytes": os.path.getsize(zip_path),
            "sha256": digest,
            "retrieved": retrieved,
            "vintage": VINTAGE,
            "notes": "Latest FINAL annual release at retrieval time. A {} early-release file "
                     "(eia860{}ER.zip) also existed on the landing page and was NOT used; the "
                     "next early release ({} data) is scheduled for June 2027.".format(
                         REPORT_YEAR, REPORT_YEAR, REPORT_YEAR + 1),
        }
        with open(src_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(meta, indent=2, sort_keys=True) + "\n")
    return zip_path


# ---------------------------------------------------------------------------
# Excel parsing helpers
# ---------------------------------------------------------------------------

_WS = re.compile(r"\s+")


def clean_str(v: Any) -> Optional[str]:
    """Normalize EIA blanks (' ', '.', '') and NaN to None; collapse whitespace."""
    if v is None:
        return None
    if isinstance(v, float):
        if math.isnan(v):
            return None
        if v.is_integer():
            return str(int(v))
        return repr(v)
    if isinstance(v, (int,)) and not isinstance(v, bool):
        return str(v)
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()[:10]
    s = _WS.sub(" ", str(v)).strip()
    if s in ("", "."):
        return None
    return s


# Address placeholders EIA uses for proposed sites; nulled in street_address and city only
# (case-insensitive exact match, after whitespace normalisation).
ADDRESS_PLACEHOLDERS = {"N/A", "NA", "TBD", "TBA"}


def clean_addr(v: Any) -> Optional[str]:
    s = clean_str(v)
    if s is not None and s.upper() in ADDRESS_PLACEHOLDERS:
        return None
    return s


def to_float(v: Any) -> Optional[float]:
    s = clean_str(v) if not isinstance(v, (int, float)) or isinstance(v, bool) else v
    if s is None:
        return None
    if isinstance(s, (int, float)):
        f = float(s)
    else:
        try:
            f = float(s.replace(",", ""))
        except ValueError:
            return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def to_int(v: Any) -> Optional[int]:
    f = to_float(v)
    if f is None:
        return None
    if not f.is_integer():
        raise PipelineError("expected integer, got {!r}".format(v))
    return int(f)


def read_sheet(book: bytes, sheet: str, fname: str) -> pd.DataFrame:
    # Row 1 is a title ("2025 Form EIA-860 Data - Schedule ..."), row 2 is the header.
    title = pd.read_excel(io.BytesIO(book), sheet_name=sheet, header=None, nrows=1,
                          dtype=object, engine="openpyxl").iloc[0, 0]
    if not (isinstance(title, str) and title.startswith("{} Form EIA-860".format(REPORT_YEAR))):
        raise PipelineError("{}:{} unexpected title row {!r}".format(fname, sheet, title))
    df = pd.read_excel(io.BytesIO(book), sheet_name=sheet, skiprows=1, dtype=object,
                       keep_default_na=False, engine="openpyxl")
    df.columns = [clean_str(c) for c in df.columns]
    if "Plant Code" not in df.columns:
        raise PipelineError("{}:{} header row not found (no 'Plant Code')".format(fname, sheet))
    codes = pd.to_numeric(df["Plant Code"], errors="coerce")
    n_drop = int(codes.isna().sum())
    df = df[codes.notna()].copy()
    log("{}:{} rows={} dropped_non_data_rows={}".format(fname, sheet, len(df), n_drop))
    return df


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

def haversine_mi(lat: float, lon: float) -> float:
    p1, p2 = math.radians(CENTER_LAT), math.radians(lat)
    dphi = p2 - p1
    dl = math.radians(lon - CENTER_LON)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(min(1.0, math.sqrt(a)))


def rmw(x: Optional[float]) -> Optional[float]:
    """Round an MW quantity (sums) to 3 decimals to remove float noise."""
    if x is None:
        return None
    return round(x + 0.0, 3)


# ---------------------------------------------------------------------------
# Field definitions (drive schema, CSV writing and validation)
# ---------------------------------------------------------------------------

def F(name, typ, nullable, desc, unit=None, enum=None, mn=None, mx=None):
    return {"name": name, "type": typ, "nullable": nullable, "description": desc,
            "unit": unit, "enum": enum, "min": mn, "max": mx}


PLANT_FIELDS = [
    F("plant_code", "integer", False, "EIA plant code (ORISPL); primary key.", mn=1),
    F("plant_name", "string", False, "Plant name as reported on EIA-860 Schedule 2."),
    F("utility_id", "integer", True, "EIA utility ID of the reporting operator."),
    F("utility_name", "string", True, "Operating utility name."),
    F("street_address", "string", True, "Plant street address. Placeholders 'N/A', 'NA', 'TBD' and 'TBA' "
      "(used for proposed sites) -> null."),
    F("city", "string", True, "Plant city. Placeholders 'N/A', 'NA', 'TBD' and 'TBA' -> null."),
    F("county", "string", True, "Plant county."),
    F("state", "string", True, "Two-letter state code."),
    F("zip", "string", True, "5-digit ZIP code (string, zero-padded)."),
    F("latitude", "number", False, "Plant latitude (WGS84), 6 decimals.", "degrees", mn=-90, mx=90),
    F("longitude", "number", False, "Plant longitude (WGS84), 6 decimals.", "degrees", mn=-180, mx=180),
    F("distance_mi", "number", False, "Haversine distance from the region center, 1 decimal.", "mi", mn=0, mx=RADIUS_MI),
    F("nerc_region", "string", True, "NERC region code."),
    F("balancing_authority_code", "string", True, "Balancing authority code (e.g. CISO, LDWP, IID)."),
    F("balancing_authority_name", "string", True, "Balancing authority name."),
    F("sector_name", "string", True, "EIA sector name (e.g. Electric Utility, IPP Non-CHP)."),
    F("grid_voltage_kv", "number", True, "Primary grid interconnection voltage.", "kV", mn=0),
    F("primary_source", "string", True, "source_category with the most operable nameplate MW (null if no operable generators).", enum=SOURCE_CATEGORIES),
    F("nameplate_mw", "number", False, "Sum of nameplate capacity of operable generators.", "MW", mn=0),
    F("summer_capacity_mw", "number", False, "Sum of net summer capacity of operable generators (blanks count as 0).", "MW", mn=0),
    F("winter_capacity_mw", "number", False, "Sum of net winter capacity of operable generators (blanks count as 0).", "MW", mn=0),
    F("operable_generator_count", "integer", False, "Number of operable generators (status OP/SB/OS/OA).", mn=0),
    F("proposed_generator_count", "integer", False, "Number of proposed generators.", mn=0),
    F("proposed_mw", "number", False, "Sum of nameplate capacity of proposed generators.", "MW", mn=0),
    F("planned_retirement_mw", "number", False, "Nameplate MW of operable generators that report a planned retirement year.", "MW", mn=0),
    F("oldest_operating_year", "integer", True, "Earliest operating year among operable generators.", "year"),
    F("newest_operating_year", "integer", True, "Latest operating year among operable generators.", "year"),
    F("capacity_weighted_year", "integer", True, "Nameplate-weighted mean operating year of operable generators, rounded.", "year"),
    F("capacity_weighted_age_years", "number", True, "Nameplate-weighted mean age of operable generators relative to report year {}, 1 decimal.".format(REPORT_YEAR), "years", mn=0),
    F("technologies", "string", True, "Pipe-joined, sorted unique EIA technology names of operable generators."),
]

GEN_FIELDS = [
    F("plant_code", "integer", False, "EIA plant code; part of primary key.", mn=1),
    F("generator_id", "string", False, "EIA generator ID (string); part of primary key."),
    F("status_group", "string", False, "Which EIA-860 3_1 sheet the generator came from.", enum=["operable", "proposed", "retired"]),
    F("status_code", "string", False, "EIA status code (OP, SB, OS, OA, P, L, T, U, V, TS, OT, RE).",
      enum=["OA", "OP", "OS", "SB", "L", "OT", "P", "T", "TS", "U", "V", "RE"]),
    F("technology", "string", True, "EIA technology description."),
    F("prime_mover", "string", True, "EIA prime mover code (e.g. CT, CA, PV, BA, WT, HY)."),
    F("energy_source_1", "string", True, "Primary EIA energy source code."),
    F("energy_source_2", "string", True, "Secondary EIA energy source code."),
    F("source_category", "string", False, "energy_source_1 mapped to a coarse category.", enum=SOURCE_CATEGORIES),
    F("nameplate_mw", "number", True, "Generator nameplate capacity.", "MW", mn=0),
    F("summer_capacity_mw", "number", True, "Net summer capacity.", "MW"),
    F("winter_capacity_mw", "number", True, "Net winter capacity.", "MW"),
    F("operating_year", "integer", True, "Year of commercial operation; for proposed units the current expected in-service year.", "year"),
    F("operating_month", "integer", True, "Month of commercial operation; for proposed units the current expected in-service month.", "month", mn=1, mx=12),
    F("planned_retirement_year", "integer", True, "Planned retirement year (operable units only).", "year"),
    F("planned_retirement_month", "integer", True, "Planned retirement month (operable units only).", "month", mn=1, mx=12),
    F("retirement_year", "integer", True, "Actual retirement year (retired units only).", "year"),
    F("latitude", "number", False, "Plant latitude (from Schedule 2), 6 decimals.", "degrees", mn=-90, mx=90),
    F("longitude", "number", False, "Plant longitude (from Schedule 2), 6 decimals.", "degrees", mn=-180, mx=180),
    F("distance_mi", "number", False, "Haversine distance of the plant from the region center, 1 decimal.", "mi", mn=0, mx=RADIUS_MI),
]

LAYER_FIELDS = [
    F("plant_code", "integer", False, "EIA plant code; primary key.", mn=1),
    F("plant_name", "string", False, "Plant name."),
    F("utility_name", "string", False, "Operating utility name ('' never emitted; falls back to 'Unknown utility' if EIA blank)."),
    F("distance_mi", "number", False, "Haversine distance from region center, 1 decimal.", "mi", mn=0, mx=RADIUS_MI),
    F("nameplate_mw", "number", False, "Operable nameplate capacity.", "MW", mn=0),
    F("mw_by_source", "object", False, "Map source_category -> operable nameplate MW (keys sorted; only non-zero categories)."),
    F("oldest_year", "integer", True, "Earliest operating year of operable generators.", "year"),
    F("newest_year", "integer", True, "Latest operating year of operable generators.", "year"),
    F("planned_retirement_mw", "number", False, "Operable MW with a planned retirement year.", "MW", mn=0),
    F("generator_count", "integer", False, "Number of operable generators.", mn=1),
    F("primary_source", "string", False, "source_category with the most operable MW.", enum=SOURCE_CATEGORIES),
    F("technologies", "array", False, "Sorted unique EIA technology names of operable generators."),
    F("capacity_weighted_age_years", "number", True, "Nameplate-weighted mean age relative to {}, 1 decimal.".format(REPORT_YEAR), "years", mn=0),
    F("capacity_weighted_year", "integer", True, "Nameplate-weighted mean operating year, rounded.", "year"),
    F("county", "string", True, "Plant county."),
    F("city", "string", True, "Plant city. Placeholders 'N/A', 'NA', 'TBD' and 'TBA' -> null."),
    F("state", "string", True, "Two-letter state code."),
    F("balancing_authority", "string", True, "Balancing authority code."),
    F("sector", "string", True, "EIA sector name."),
    F("grid_voltage_kv", "number", True, "Primary grid interconnection voltage.", "kV", mn=0),
    F("utility_id", "integer", True, "EIA utility ID."),
    F("summer_capacity_mw", "number", False, "Operable net summer capacity.", "MW", mn=0),
    F("winter_capacity_mw", "number", False, "Operable net winter capacity.", "MW", mn=0),
    F("proposed_mw", "number", False, "Proposed nameplate MW at this plant.", "MW", mn=0),
]


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

OPERABLE_COLS = {"operating_year": "Operating Year", "operating_month": "Operating Month",
                 "planned_retirement_year": "Planned Retirement Year",
                 "planned_retirement_month": "Planned Retirement Month"}


def build(zip_path: str) -> Tuple[List[dict], List[dict], Dict[str, Any]]:
    stats = {}  # type: Dict[str, Any]
    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
        for need in (PLANT_XLSX, GEN_XLSX):
            if need not in names:
                raise PipelineError("{} missing from {}".format(need, ZIP_NAME))
        plant_book = zf.read(PLANT_XLSX)
        gen_book = zf.read(GEN_XLSX)

    # ---- plants -----------------------------------------------------------
    pdf = read_sheet(plant_book, "Plant", PLANT_XLSX)
    plants = {}  # type: Dict[int, dict]
    missing_coords = 0
    missing_coords_ca = 0
    state_mismatch = []  # type: List[int]
    for rec in pdf.to_dict("records"):
        code = to_int(rec["Plant Code"])
        lat = to_float(rec["Latitude"])
        lon = to_float(rec["Longitude"])
        if lat is None or lon is None or lat == 0 or lon == 0:
            missing_coords += 1
            if clean_str(rec.get("State")) == "CA":
                missing_coords_ca += 1
            continue
        d = haversine_mi(lat, lon)
        if d > RADIUS_MI:
            continue
        if clean_str(rec["State"]) not in REGION_STATES:
            state_mismatch.append(code)
            log("dropping plant {} ({}, state={}, county={}): coordinates ({}, {}) inside region "
                "but reported state is outside it".format(code, clean_str(rec["Plant Name"]),
                                                            clean_str(rec["State"]), clean_str(rec["County"]), lat, lon))
            continue
        if code in plants:
            raise PipelineError("duplicate plant code {} in Schedule 2".format(code))
        z = clean_str(rec["Zip"])
        if z is not None and z.isdigit():
            z = z.zfill(5)
        plants[code] = {
            "plant_code": code,
            "plant_name": clean_str(rec["Plant Name"]),
            "utility_id": to_int(rec["Utility ID"]),
            "utility_name": clean_str(rec["Utility Name"]),
            "street_address": clean_addr(rec["Street Address"]),
            "city": clean_addr(rec["City"]),
            "county": clean_str(rec["County"]),
            "state": clean_str(rec["State"]),
            "zip": z,
            "latitude": round(lat, 6),
            "longitude": round(lon, 6),
            "distance_mi": round(d, 1),
            "nerc_region": clean_str(rec["NERC Region"]),
            "balancing_authority_code": clean_str(rec["Balancing Authority Code"]),
            "balancing_authority_name": clean_str(rec["Balancing Authority Name"]),
            "sector_name": clean_str(rec["Sector Name"]),
            "grid_voltage_kv": to_float(rec["Grid Voltage (kV)"]),
        }
    stats["plants_dropped_missing_or_zero_coords_national"] = missing_coords
    stats["plants_dropped_missing_or_zero_coords_ca"] = missing_coords_ca
    stats["plants_dropped_state_mismatch"] = state_mismatch
    log("plants: dropped {} with missing/zero coords nationally ({} in CA); {} within {} mi".format(
        missing_coords, missing_coords_ca, len(plants), RADIUS_MI))

    # ---- generators -------------------------------------------------------
    gens = {}  # type: Dict[Tuple[int, str], dict]
    canceled = 0
    orphan = 0
    dupes = 0
    unmapped = {}  # type: Dict[str, int]
    sheets = [("Operable", "operable"), ("Proposed", "proposed"), ("Retired and Canceled", "retired")]
    for sheet, group in sheets:
        gdf = read_sheet(gen_book, sheet, GEN_XLSX)
        for rec in gdf.to_dict("records"):
            code = to_int(rec["Plant Code"])
            if code not in plants:
                continue
            status = clean_str(rec["Status"])
            if group == "retired" and status in ("CN", "IP"):
                # CN = canceled, IP = planned unit indefinitely postponed / no longer planned
                canceled += 1
                continue
            gid = clean_str(rec["Generator ID"])
            if gid is None:
                raise PipelineError("blank generator id at plant {}".format(code))
            es1 = clean_str(rec["Energy Source 1"])
            cat = ENERGY_SOURCE_MAP.get(es1 or "", "other")
            if es1 is not None and es1 not in ENERGY_SOURCE_MAP:
                unmapped[es1] = unmapped.get(es1, 0) + 1
            p = plants[code]
            g = {
                "plant_code": code,
                "generator_id": gid,
                "status_group": group,
                "status_code": status,
                "technology": clean_str(rec["Technology"]),
                "prime_mover": clean_str(rec["Prime Mover"]),
                "energy_source_1": es1,
                "energy_source_2": clean_str(rec["Energy Source 2"]),
                "source_category": cat,
                "nameplate_mw": to_float(rec["Nameplate Capacity (MW)"]),
                "summer_capacity_mw": to_float(rec["Summer Capacity (MW)"]),
                "winter_capacity_mw": to_float(rec["Winter Capacity (MW)"]),
                "operating_year": None,
                "operating_month": None,
                "planned_retirement_year": None,
                "planned_retirement_month": None,
                "retirement_year": None,
                "latitude": p["latitude"],
                "longitude": p["longitude"],
                "distance_mi": p["distance_mi"],
            }
            if group == "operable":
                for k, col in OPERABLE_COLS.items():
                    g[k] = to_int(rec[col])
            elif group == "proposed":
                g["operating_year"] = to_int(rec["Current Year"])
                g["operating_month"] = to_int(rec["Current Month"])
            else:
                g["operating_year"] = to_int(rec["Operating Year"])
                g["operating_month"] = to_int(rec["Operating Month"])
                g["retirement_year"] = to_int(rec["Retirement Year"])
            key = (code, gid)
            if key in gens:
                dupes += 1
                prev = gens[key]
                log("duplicate generator key {} in {} and {}; keeping {}".format(
                    key, prev["status_group"], group,
                    min((prev["status_group"], group), key=lambda s: GROUP_ORDER[s])))
                if GROUP_ORDER[group] >= GROUP_ORDER[prev["status_group"]]:
                    continue
            gens[key] = g
    if unmapped:
        log("WARNING unmapped energy source codes -> 'other': {}".format(sorted(unmapped.items())))
    stats["canceled_generators_dropped"] = canceled  # CN + IP
    stats["duplicate_generator_keys"] = dupes
    stats["unmapped_energy_codes"] = sorted(unmapped)
    log("generators: {} kept, {} canceled dropped, {} duplicate keys".format(len(gens), canceled, dupes))

    # ---- plant aggregates -------------------------------------------------
    by_plant = {}  # type: Dict[int, List[dict]]
    for g in gens.values():
        by_plant.setdefault(g["plant_code"], []).append(g)

    for code, p in plants.items():
        gl = by_plant.get(code, [])
        op = [g for g in gl if g["status_group"] == "operable"]
        pr = [g for g in gl if g["status_group"] == "proposed"]
        mw_by_source = {}  # type: Dict[str, float]
        for g in op:
            mw_by_source[g["source_category"]] = mw_by_source.get(g["source_category"], 0.0) + (g["nameplate_mw"] or 0.0)
        mw_by_source = {k: rmw(v) for k, v in sorted(mw_by_source.items()) if rmw(v) and rmw(v) > 0}
        if op:
            if mw_by_source:
                # ties (e.g. 500 MW solar + 500 MW battery) go to the generating source, not storage
                primary = sorted(mw_by_source.items(),
                                 key=lambda kv: (-kv[1], kv[0] == "battery", kv[0]))[0][0]
            else:
                primary = sorted(g["source_category"] for g in op)[0]
        else:
            primary = None
        years = [g["operating_year"] for g in op if g["operating_year"] is not None]
        wsum = sum((g["nameplate_mw"] or 0.0) for g in op if g["operating_year"] is not None)
        if wsum > 0:
            wyear = sum((g["nameplate_mw"] or 0.0) * g["operating_year"] for g in op
                        if g["operating_year"] is not None) / wsum
            age = round(max(0.0, REPORT_YEAR - wyear), 1) + 0.0
            cwy = int(math.floor(wyear + 0.5))
        else:
            age = None
            cwy = None
        techs = sorted({g["technology"] for g in op if g["technology"]})
        p.update({
            "primary_source": primary,
            "nameplate_mw": rmw(sum(g["nameplate_mw"] or 0.0 for g in op)),
            "summer_capacity_mw": rmw(sum(g["summer_capacity_mw"] or 0.0 for g in op)),
            "winter_capacity_mw": rmw(sum(g["winter_capacity_mw"] or 0.0 for g in op)),
            "operable_generator_count": len(op),
            "proposed_generator_count": len(pr),
            "proposed_mw": rmw(sum(g["nameplate_mw"] or 0.0 for g in pr)),
            "planned_retirement_mw": rmw(sum(g["nameplate_mw"] or 0.0 for g in op
                                             if g["planned_retirement_year"] is not None)),
            "oldest_operating_year": min(years) if years else None,
            "newest_operating_year": max(years) if years else None,
            "capacity_weighted_year": cwy,
            "capacity_weighted_age_years": age,
            "technologies": "|".join(techs) if techs else None,
            "_mw_by_source": mw_by_source,
            "_techs": techs,
        })

    plant_rows = [plants[k] for k in sorted(plants)]
    gen_rows = [gens[k] for k in sorted(gens)]
    return plant_rows, gen_rows, stats


# ---------------------------------------------------------------------------
# Serialization + validation
# ---------------------------------------------------------------------------

def num_out(v: float) -> Any:
    """JSON/CSV number: integral floats become ints (no trailing .0)."""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def fmt_csv(v: Any, typ: str) -> str:
    if v is None:
        return ""
    if typ == "integer":
        return str(int(v))
    if typ == "number":
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            raise PipelineError("non-finite number")
        return str(num_out(float(v)))
    if typ == "boolean":
        return "true" if v else "false"
    s = _WS.sub(" ", str(v)).strip()
    return s


def validate(rows: List[dict], fields: List[dict], pk: List[str], label: str) -> None:
    seen = set()
    for r in rows:
        key = tuple(r.get(k) for k in pk)
        if any(k is None for k in key):
            raise PipelineError("{}: null primary key {}".format(label, key))
        if key in seen:
            raise PipelineError("{}: duplicate primary key {}".format(label, key))
        seen.add(key)
        for f in fields:
            v = r.get(f["name"])
            if v is None:
                if not f["nullable"]:
                    raise PipelineError("{}: {} null for {}".format(label, f["name"], key))
                continue
            if f["type"] == "integer" and not (isinstance(v, int) and not isinstance(v, bool)):
                raise PipelineError("{}: {}={!r} not integer for {}".format(label, f["name"], v, key))
            if f["type"] == "number":
                if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
                    raise PipelineError("{}: {}={!r} not a finite number for {}".format(label, f["name"], v, key))
            if f["type"] == "string" and not isinstance(v, str):
                raise PipelineError("{}: {}={!r} not string for {}".format(label, f["name"], v, key))
            if f["type"] == "array" and not isinstance(v, list):
                raise PipelineError("{}: {} not array".format(label, f["name"]))
            if f["type"] == "object" and not isinstance(v, dict):
                raise PipelineError("{}: {} not object".format(label, f["name"]))
            if f["enum"] is not None and v not in f["enum"]:
                raise PipelineError("{}: {}={!r} not in enum for {}".format(label, f["name"], v, key))
            if f["min"] is not None and v < f["min"]:
                raise PipelineError("{}: {}={!r} < min for {}".format(label, f["name"], v, key))
            if f["max"] is not None and v > f["max"]:
                raise PipelineError("{}: {}={!r} > max for {}".format(label, f["name"], v, key))
    if [tuple(r[k] for k in pk) for r in rows] != sorted(seen):
        raise PipelineError("{}: rows not sorted by primary key".format(label))


def write_csv(path: str, rows: List[dict], fields: List[dict]) -> None:
    names = [f["name"] for f in fields]
    if len(set(names)) != len(names):
        raise PipelineError("duplicate column names in " + path)
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
    w.writerow(names)
    for r in rows:
        w.writerow([fmt_csv(r.get(f["name"]), f["type"]) for f in fields])
    write_text(path, buf.getvalue())


def write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp, path)


def write_schema(dataset: str, pk: List[str], geom: Optional[str], fields: List[dict]) -> None:
    doc = {
        "dataset": dataset,
        "primary_key": pk,
        "geometry_type": geom,
        "source": {"name": SOURCE_NAME, "url": ZIP_URL, "vintage": VINTAGE},
        "fields": fields,
    }
    write_text(os.path.join(SCHEMA_DIR, dataset + ".schema.json"),
               json.dumps(doc, indent=2, ensure_ascii=False, allow_nan=False) + "\n")


def layer_features(plant_rows: List[dict]) -> List[dict]:
    feats = []
    for p in plant_rows:
        if p["operable_generator_count"] == 0:
            continue
        props = {
            "plant_code": p["plant_code"],
            "plant_name": p["plant_name"],
            "utility_name": p["utility_name"] if p["utility_name"] else "Unknown utility",
            "distance_mi": p["distance_mi"],
            "nameplate_mw": num_out(p["nameplate_mw"]),
            "mw_by_source": {k: num_out(v) for k, v in p["_mw_by_source"].items()},
            "oldest_year": p["oldest_operating_year"],
            "newest_year": p["newest_operating_year"],
            "planned_retirement_mw": num_out(p["planned_retirement_mw"]),
            "generator_count": p["operable_generator_count"],
            "primary_source": p["primary_source"],
            "technologies": list(p["_techs"]),
            "capacity_weighted_age_years": p["capacity_weighted_age_years"],
            "capacity_weighted_year": p["capacity_weighted_year"],
            "county": p["county"],
            "city": p["city"],
            "state": p["state"],
            "balancing_authority": p["balancing_authority_code"],
            "sector": p["sector_name"],
            "grid_voltage_kv": num_out(p["grid_voltage_kv"]) if p["grid_voltage_kv"] is not None else None,
            "utility_id": p["utility_id"],
            "summer_capacity_mw": num_out(p["summer_capacity_mw"]),
            "winter_capacity_mw": num_out(p["winter_capacity_mw"]),
            "proposed_mw": num_out(p["proposed_mw"]),
        }
        if list(props) != [f["name"] for f in LAYER_FIELDS]:
            raise PipelineError("layer property order mismatch with LAYER_FIELDS")
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [p["longitude"], p["latitude"]]},
            "properties": props,
        })
    return feats


def compare_public(feats: List[dict]) -> Dict[str, Any]:
    if not os.path.exists(PUBLIC_PLANTS):
        return {}
    with open(PUBLIC_PLANTS, encoding="utf-8") as fh:
        old = json.load(fh)
    old_codes = {f["properties"]["plant_code"] for f in old["features"]}
    new_codes = {f["properties"]["plant_code"] for f in feats}
    return {
        "public_count": len(old_codes),
        "new_count": len(new_codes),
        "added": sorted(new_codes - old_codes),
        "removed": sorted(old_codes - new_codes),
    }


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--refresh", action="store_true", help="re-download the raw zip")
    args = ap.parse_args(argv)
    try:
        zip_path = ensure_raw(args.refresh)
        plant_rows, gen_rows, stats = build(zip_path)

        validate(plant_rows, PLANT_FIELDS, ["plant_code"], "eia860_plants")
        validate(gen_rows, GEN_FIELDS, ["plant_code", "generator_id"], "eia860_generators")
        feats = layer_features(plant_rows)
        validate([f["properties"] for f in feats], LAYER_FIELDS, ["plant_code"], "eia860_plants_layer")

        write_csv(os.path.join(CLEAN_DIR, "eia860_plants.csv"), plant_rows, PLANT_FIELDS)
        write_csv(os.path.join(CLEAN_DIR, "eia860_generators.csv"), gen_rows, GEN_FIELDS)
        fc = {
            "type": "FeatureCollection",
            "metadata": {
                "source": "{} {} ({})".format(SOURCE_NAME, VINTAGE, ZIP_URL),
                "center": [CENTER_LAT, CENTER_LON],
                "radius_mi": RADIUS_MI,
                "dataset": "eia860_plants",
                "schema": "research/schemas/eia860_plants_layer.schema.json",
            },
            "features": feats,
        }
        write_text(os.path.join(LAYER_DIR, "eia860_plants.geojson"),
                   json.dumps(fc, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n")
        write_schema("eia860_plants", ["plant_code"], None, PLANT_FIELDS)
        write_schema("eia860_generators", ["plant_code", "generator_id"], None, GEN_FIELDS)
        write_schema("eia860_plants_layer", ["plant_code"], "Point", LAYER_FIELDS)

        delta = compare_public(feats)
        if delta:
            log("vs public/layers/plants.geojson: public={} new={} added={} removed={}".format(
                delta["public_count"], delta["new_count"], len(delta["added"]), len(delta["removed"])))
            log("  added codes: {}".format(delta["added"]))
            log("  removed codes: {}".format(delta["removed"]))
        groups = {}  # type: Dict[str, int]
        for g in gen_rows:
            groups[g["status_group"]] = groups.get(g["status_group"], 0) + 1
        print("eia860 {}: plants={} layer_features={} generators={} (operable={} proposed={} retired={}) "
              "dropped_no_coords={} dropped_state_mismatch={} canceled_dropped={}".format(
                  REPORT_YEAR, len(plant_rows), len(feats), len(gen_rows), groups.get("operable", 0),
                  groups.get("proposed", 0), groups.get("retired", 0),
                  stats["plants_dropped_missing_or_zero_coords_national"],
                  len(stats["plants_dropped_state_mismatch"]),
                  stats["canceled_generators_dropped"]))
        return 0
    except (PipelineError, OSError, KeyError, ValueError, requests.RequestException, zipfile.BadZipFile) as exc:
        log("ERROR: {}: {}".format(type(exc).__name__, exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
