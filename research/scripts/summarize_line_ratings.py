"""Builds research/data/line_ratings/summary.json from the hourly CSVs written by line_rating.py.

For every line_rating_<year>_<key>.csv it reports:
  hours, static_rating_A
  median_conservative_dlr_vs_static           median of dlr_conservative_vs_static
  pct_hours_conservative_dlr_above_static     % hours with ratio > 1
  pct_hours_conservative_dlr_ge_1_25x_static  % hours with ratio >= 1.25
  pct_hours_below_static                      % hours with ratio < 1
  median_aar_vs_static                        median of aar_A / static_A (Order 881 AAR: day/night sun, see line_rating.py)
  median_wind_gain_over_aar                   median of dlr_conservative_A / aar_A
  summer_4to8pm_median_wind_gain_over_aar     same, Jul-Sep, hours 16:00-19:00 local
  hottest_hour, hottest_temp_c                first hour with the year's max temperature
  hottest_hour_dlr_vs_static                  dlr_conservative_vs_static at that hour
Medians are the upper middle value (sorted[n // 2]), as in line_rating.py. The vs-static ratios and
percentages are recomputed unrounded from the CSV's weather columns with line_rating.ampacity, so they
match what line_rating.py prints; the wind-gain and hottest-hour fields use the CSV's rounded columns.

Usage: python summarize_line_ratings.py <year> <ratings_dir> <out_json>
"""
import csv, glob, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from line_rating import AAR_WIND, STATIC, aar_sun, ampacity  # noqa: E402


def med(xs):
    s = sorted(xs)
    return round(s[len(s) // 2], 2)


def summarize(path):
    rows = list(csv.DictReader(open(path)))
    n = len(rows)
    static = ampacity(STATIC["ta"], STATIC["wind"], STATIC["sun"], STATIC["angle"])
    w = [(float(r["temp_c"]), float(r["wind_ms"]), float(r["sun_wm2"])) for r in rows]
    ratio = [ampacity(ta, ws * 0.5, sun, 45.0) / static for ta, ws, sun in w]
    aar = [ampacity(ta, AAR_WIND, aar_sun(sun), 90.0) / static for ta, ws, sun in w]
    gain = [float(r["dlr_conservative_A"]) / float(r["aar_A"]) for r in rows]
    summer = [g for g, r in zip(gain, rows) if int(r["time"][5:7]) in (7, 8, 9) and 16 <= int(r["time"][11:13]) <= 19]
    hot = max(rows, key=lambda r: float(r["temp_c"]))
    return {
        "hours": n, "static_rating_A": int(rows[0]["static_A"]),
        "median_conservative_dlr_vs_static": med(ratio),
        "pct_hours_conservative_dlr_above_static": round(100 * sum(x > 1 for x in ratio) / n, 1),
        "pct_hours_conservative_dlr_ge_1_25x_static": round(100 * sum(x >= 1.25 for x in ratio) / n, 1),
        "pct_hours_below_static": round(100 * sum(x < 1 for x in ratio) / n, 1),
        "median_aar_vs_static": med(aar),
        "median_wind_gain_over_aar": med(gain),
        "summer_4to8pm_median_wind_gain_over_aar": med(summer),
        "hottest_hour": hot["time"],
        "hottest_temp_c": float(hot["temp_c"]),
        "hottest_hour_dlr_vs_static": float(hot["dlr_conservative_vs_static"]),
    }


def main(year, src, dst):
    prefix = f"line_rating_{year}_"
    out = {}
    for path in sorted(glob.glob(os.path.join(src, prefix + "*.csv"))):
        out[os.path.basename(path)[len(prefix):-4]] = summarize(path)
    with open(dst, "w") as f:
        json.dump(out, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
