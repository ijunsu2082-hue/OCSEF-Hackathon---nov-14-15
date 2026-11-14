"""Hourly line-rating model for "The Wire That Breathes" (simplified IEEE Std 738 steady-state heat balance).

For each hour of real weather (2025 in the app; 2024 kept) it computes how many amps a standard conductor could carry:
  static_A        worst-case fixed rating: 40 C air, 0.61 m/s (2 ft/s) wind, 1000 W/m2 sun, all year
  aar_A           ambient-adjusted rating, as FERC Order 881 defines it: real air temp + day/night sun only
                  (daytime = worst-case 1000 W/m2, night = 0; "day" = any measured sun > 0), wind fixed at 0.61 m/s 90 deg
  dlr_A           dynamic line rating: real temp + real sun + real wind (wind at 45 deg to the line)
  dlr_conservative_A  same, but wind speed halved (sheltering / uncertainty margin)

Conductor: ACSR 795 kcmil "Drake" (very common on 115-230 kV lines), max conductor temp 75 C.
This is a screening model for a demo, NOT an operating rating: real ratings use line-specific
conductor, clearance surveys and at-line sensors. Weather is Open-Meteo reanalysis at 10 m height.

Usage: python line_rating.py <weather_csv> <out_csv>   (prints a JSON summary)
"""
import csv, json, math, sys

D = 0.02814          # conductor diameter, m (Drake)
R25, R75 = 7.283e-5, 8.688e-5   # ohm/m AC resistance at 25 C and 75 C
TC = 75.0            # max conductor temperature, C
EPS, ALPHA = 0.8, 0.8
ELEV = 100.0         # m, typical coastal/inland basin
STATIC = dict(ta=40.0, wind=0.61, sun=1000.0, angle=90.0)
AAR_WIND = 0.61


def aar_sun(sun):
    """Order 881 AARs use day/night solar, not measured sun: worst-case sun by day, none at night."""
    return STATIC["sun"] if sun > 0 else 0.0


def r_at(tc):
    return R25 + (R75 - R25) * (tc - 25) / 50


def ampacity(ta, wind, sun, angle_deg, tc=TC):
    tf = (tc + ta) / 2
    mu = 1.458e-6 * (tf + 273) ** 1.5 / (tf + 383.4)
    rho = (1.293 - 1.525e-4 * ELEV + 6.379e-9 * ELEV ** 2) / (1 + 0.00367 * tf)
    kf = 2.424e-2 + 7.477e-5 * tf - 4.407e-9 * tf ** 2
    phi = math.radians(angle_deg)
    k_ang = 1.194 - math.cos(phi) + 0.194 * math.cos(2 * phi) + 0.368 * math.sin(2 * phi)
    dt = tc - ta
    if dt <= 0:
        return 0.0
    nre = D * rho * max(wind, 0.0) / mu
    qc1 = (1.01 + 1.35 * nre ** 0.52) * kf * k_ang * dt
    qc2 = 0.754 * nre ** 0.6 * kf * k_ang * dt
    qcn = 3.645 * rho ** 0.5 * D ** 0.75 * dt ** 1.25
    qc = max(qc1, qc2, qcn)
    qr = 17.8 * D * EPS * (((tc + 273) / 100) ** 4 - ((ta + 273) / 100) ** 4)
    qs = ALPHA * max(sun, 0.0) * D
    net = qc + qr - qs
    return math.sqrt(net / r_at(tc)) if net > 0 else 0.0


def main(src, dst):
    with open(src) as f:
        lines = f.read().splitlines()
    start = next(i for i, l in enumerate(lines) if l.startswith("time,"))
    rows = list(csv.DictReader(lines[start:]))
    static = ampacity(STATIC["ta"], STATIC["wind"], STATIC["sun"], STATIC["angle"])
    out, ratios, aar_ratios = [], [], []
    for r in rows:
        try:
            ta = float(r["temperature_2m (°C)"]); ws = float(r["wind_speed_10m (m/s)"])
            sun = float(r["shortwave_radiation (W/m²)"])
        except (ValueError, KeyError):
            continue
        aar = ampacity(ta, AAR_WIND, aar_sun(sun), 90.0)
        dlr = ampacity(ta, ws, sun, 45.0)
        dlrc = ampacity(ta, ws * 0.5, sun, 45.0)
        out.append([r["time"], ta, ws, sun, round(static), round(aar), round(dlr), round(dlrc),
                    round(dlr / static, 3), round(dlrc / static, 3)])
        ratios.append(dlrc / static); aar_ratios.append(aar / static)
    with open(dst, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "temp_c", "wind_ms", "sun_wm2", "static_A", "aar_A", "dlr_A", "dlr_conservative_A",
                    "dlr_vs_static", "dlr_conservative_vs_static"])
        w.writerows(out)
    s = sorted(ratios); n = len(s)
    summ = {
        "hours": n, "static_rating_A": round(static),
        "median_conservative_dlr_vs_static": round(s[n // 2], 2),
        "pct_hours_conservative_dlr_above_static": round(100 * sum(x > 1 for x in s) / n, 1),
        "pct_hours_conservative_dlr_ge_1_25x_static": round(100 * sum(x >= 1.25 for x in s) / n, 1),
        "pct_hours_below_static": round(100 * sum(x < 1 for x in s) / n, 1),
        "median_aar_vs_static": round(sorted(aar_ratios)[n // 2], 2),
    }
    print(json.dumps(summ))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
