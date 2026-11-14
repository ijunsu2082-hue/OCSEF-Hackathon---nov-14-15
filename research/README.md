# research/: real-grid data and niche cases

Everything here is centered on **Westminster High School (33.7538, -118.0111), 100-mile radius**, matching the main README.

## What's here

| Path | What | Source | Real or modeled |
| --- | --- | --- | --- |
| `layers/plants.geojson` | 697 operating power plants, ≈39.5 GW (MW by fuel, in-service years, capacity-weighted age, planned retirements) | EIA-860 2025 annual | Real |
| `layers/transmission.geojson` | 5,331 power lines ≥ 69 kV (or untagged), with voltage | OpenStreetMap (ODbL) | Real geometry; tags incomplete |
| `layers/substations.geojson` | 1,271 substations (472 named), point = outline centroid, with voltage where tagged | OpenStreetMap (ODbL) | Real; tags incomplete |
| `layers/niche_cases.json` | 38 niche cards in the README §4.7 `NicheCase` shape (Wire That Breathes first) | `NICHE_CASES.md` | Verified facts only |
| `layers/line_rating_2024_westminster_hs.csv` | Hourly line rating at the school for the Wire That Breathes chart | `scripts/line_rating.py` | Modeled |
| `NICHE_CASES.md` | All niche cases with every fact, source link and confidence tag, plus the datasets they found | 10 research agents, web-checked | Sourced |
| `data/plants/` | Per-plant and per-generator CSVs, plus **retired** (421) and **proposed** (113) generators | EIA-860 2025 | Real |
| `data/line_ratings/` | Hourly 2024 static / ambient-adjusted / dynamic ratings for 7 locations + `summary.json` | `scripts/line_rating.py` | Modeled |
| `data/weather/` | Hourly 2024 temperature, wind, solar radiation for 7 locations | Open-Meteo archive (ERA5-based) | Real (reanalysis) |
| `scripts/` | Python that rebuilds every file above | | |

## Line-rating model (The Wire That Breathes)

`scripts/line_rating.py` runs a simplified IEEE Std 738 steady-state heat balance for an ACSR 795 kcmil "Drake" conductor at 75 °C (checked: 915 A at 25 °C / 0.61 m/s / full sun, against ~907 A published). For each hour it reports:

- `static_A`: fixed worst-case rating (40 °C, 0.61 m/s wind, 1000 W/m² sun), 723 A
- `aar_A`: ambient-adjusted rating (real temperature and sun, fixed wind), which FERC Order 881 requires
- `dlr_A`: dynamic rating with real wind at 45° to the line
- `dlr_conservative_A`: same with wind halved, **the number to quote**

These are screening estimates for a typical conductor, **not** utility operating ratings.

## Rebuild

```bash
python3 -m venv .venv && .venv/bin/pip install openpyxl
curl -L -A "Mozilla/5.0" -o eia8602025.zip https://www.eia.gov/electricity/data/eia860/xls/eia8602025.zip
.venv/bin/python research/scripts/build_eia_plants.py eia8602025.zip research/data/plants

# weather (repeat per point), then line ratings
curl -o research/data/weather/weather_2024_westminster_hs.csv "https://archive-api.open-meteo.com/v1/archive?latitude=33.7538&longitude=-118.0111&start_date=2024-01-01&end_date=2024-12-31&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,shortwave_radiation&wind_speed_unit=ms&timezone=America%2FLos_Angeles&format=csv"
python3 research/scripts/line_rating.py research/data/weather/weather_2024_westminster_hs.csv research/data/line_ratings/line_rating_2024_westminster_hs.csv

# OSM lines + substations (Overpass), then convert
#   query: way["power"="line"](around:160934,33.7538,-118.0111); out tags geom;
python3 research/scripts/build_osm_grid.py osm_lines.json osm_substations_plants.json research/layers
```
