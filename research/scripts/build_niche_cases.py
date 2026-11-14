"""Render research-agent output (cases.json) into research/NICHE_CASES.md and research/layers/niche_cases.json.

Usage (from repo root): python3 research/scripts/build_niche_cases.py <cases.json>
cases.json = {"cases": [...], "datasets": [...]} where every case carries research_agent and dist_westminster (miles).
Cases more than 100 mi from Westminster HS stay in the .md (flagged) but are left out of the map file.
"""
import json, re, sys

CAT = {'research:1': 'Transmission', 'research:2': 'Generation', 'research:3': 'Water-Energy', 'research:4': 'Load',
       'research:5': 'Heat', 'research:6': 'Storage', 'research:7': 'Wildfire', 'research:8': 'Gas',
       'research:9': 'Distributed', 'research:10': 'Generation'}
NAMES = {'research:1': 'Transmission lines & line ratings', 'research:2': 'Retired power plants & idle grid connections',
         'research:3': 'Water-energy', 'research:4': 'Data centers & new large loads', 'research:5': 'Heat waves & peak demand',
         'research:6': 'Batteries', 'research:7': 'Wildfire, shutoffs & aging equipment', 'research:8': 'Natural gas',
         'research:9': 'Rooftop solar & microgrids', 'research:10': 'Wind, solar & repowering'}
BUL = {'output': 'output_draw', 'draw': 'output_draw', 'capacity': 'capacity', 'cycle': 'energy_cycle',
       'age': 'infra_age', 'upgrade': 'upgrade_potential'}

WIRE = {
    "id": "wire-that-breathes", "title": "The Wire That Breathes", "category": "Transmission",
    "location": {"name": "Westminster High School (weather point); applies to every overhead line in the radius",
                 "lat": 33.7538, "lon": -118.0111, "distance_mi": 0},
    "one_liner": "Power lines are rated as if every hour were a hot, windless afternoon, so most hours they could safely carry far more, and on the worst heat hours the fixed rating isn't safe enough.",
    "problem": "Most overhead lines carry a fixed static rating that assumes about 40 C air, almost no wind and full sun all year. The real limit is how hot the wire gets, which depends on the weather. Clean energy waits years for grid room while existing wires sit under-used.",
    "fix": "Rate each line hour by hour from real weather (dynamic line rating). It frees capacity on wires that already exist with no construction, and flags heat-wave hours when the fixed rating is too generous.",
    "shock_line": "The wires aren't full. We just pretend every hour is a hot, still afternoon, and on the one afternoon that really is, the fixed number isn't even safe.",
    "stats": [
        {"label": "Typical 2024 hour at Westminster HS: safe rating vs fixed rating", "value": "~1.58x", "kind": "modeled",
         "source": "research/data/line_ratings/summary.json (IEEE 738 heat balance, ACSR Drake 75 C, Open-Meteo 2024 weather, wind halved)"},
        {"label": "2024 hours where the safe rating beats the fixed rating (Westminster HS)", "value": "100%", "kind": "modeled",
         "source": "research/data/line_ratings/summary.json"},
        {"label": "Extra room from wind alone, summer 4-8 pm (beyond the temperature-only rating FERC Order 881 requires)",
         "value": "~+20% median", "kind": "modeled", "source": "research/data/line_ratings/summary.json"},
        {"label": "Downtown LA, 6 Sep 2024 1 pm (45.7 C in reanalysis): safe rating vs fixed rating",
         "value": "~0.90x (fixed rating ~10% too high)", "kind": "modeled",
         "source": "research/data/line_ratings/line_rating_2024_la_basin_downtown.csv"}],
    "team_bullets": ["capacity", "output_draw", "infra_age", "upgrade_potential", "energy_cycle"],
    "chart": {"kind": "line_rating", "data_url": "/layers/line_rating_2024_westminster_hs.csv"}}


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')[:60]


def cell(s):
    return str(s).replace('|', '/').replace('\n', ' ')


def main(path):
    d = json.load(open(path))
    allc = d['cases']
    items = [WIRE]
    for c in allc:
        if c['dist_westminster'] > 100:
            continue
        tb = []
        for k, v in BUL.items():
            if k in c['team_bullets'].lower() and v not in tb:
                tb.append(v)
        items.append({"id": slug(c['title']), "title": c['title'], "category": CAT[c['research_agent']],
                      "location": {"name": c['asset_or_event'][:140], "lat": c['lat'], "lon": c['lon'], "distance_mi": c['dist_westminster']},
                      "one_liner": c['shock_line'], "problem": c['summary'],
                      "fix": "See research/NICHE_CASES.md (map node values and upgrade potential).",
                      "shock_line": c['shock_line'],
                      "stats": [{"label": f['fact'], "value": "", "kind": "measured", "source": f['source_url']}
                                for f in c['key_facts'] if f['confidence'] == 'verified'],
                      "team_bullets": tb})
    json.dump(items, open('research/layers/niche_cases.json', 'w'), indent=1)

    L = ["# Niche Cases: real, local, sourced", "",
         "Real energy-infrastructure stories inside **100 miles of Westminster High School** (33.7538, -118.0111), found by 10 parallel research agents on 14 Nov 2026 and checked against web sources. Every fact carries its source and a confidence tag:", "",
         "- **verified**: the agent confirmed it in the cited source",
         "- **likely**: consistent with sources but not confirmed word for word",
         "- **uncertain**: do not say it on stage until someone checks it", "",
         "`research/layers/niche_cases.json` holds the in-radius cases in the app's `NicheCase` shape (README §4.7), with only **verified** facts. Distances are recomputed from Westminster HS.", "",
         "> Pick 2–3 for the demo. Before quoting any number on stage, open its source link.", "",
         "## Case 1: The Wire That Breathes (featured)", "",
         "Written up in README §4.7. Data: `research/data/line_ratings/` (hourly ratings for 7 locations, 2024) and `summary.json`. The local anchor is **The Pilot That Never Flew** below: SCE's own dynamic-line-rating pilot at Barre substation in Stanton, about 4 miles from the school, cancelled because trees blocked its radios.", ""]
    for k in NAMES:
        cs = [c for c in allc if c['research_agent'] == k]
        L += [f"## {NAMES[k]}", ""]
        if not cs:
            L += ["_No cases returned._", ""]
            continue
        for c in cs:
            flag = " ⚠️ **OUTSIDE the 100-mile radius from Westminster HS, not on the map**" if c['dist_westminster'] > 100 else ""
            L += [f"### {c['title']}{flag}", "", f"**Asset / event:** {c['asset_or_event']}  ", f"**Operator:** {c['operator']}  ",
                  f"**Location:** {c['lat']}, {c['lon']} · **{c['dist_westminster']} mi** from Westminster HS", "", c['summary'], "",
                  f"**Say on stage:** {c['shock_line']}", "", "**Facts:**", ""]
            L += [f"- [{f['confidence']}] {f['fact']} ([source]({f['source_url']}))" for f in c['key_facts']]
            L += ["", f"**Map node values:** {c['app_fields']}", "", f"**Team bullets covered:** {c['team_bullets']}", ""]
    L += ["## Datasets the researchers found", "", "| Dataset | Access | Format | Key fields | Gotchas |", "| --- | --- | --- | --- | --- |"]
    seen = set()
    for x in d['datasets']:
        key = x['url'].rstrip('/').lower()
        if key in seen:
            continue
        seen.add(key)
        L.append(f"| [{cell(x['name'])}]({x['url']}) | {cell(x['access'])} | {cell(x['format'])} | {cell(x['key_fields'])} | {cell(x['gotchas'])} |")
    open('research/NICHE_CASES.md', 'w').write("\n".join(L) + "\n")
    print(f"{len(items)} map cases (incl. Wire That Breathes), {sum(c['dist_westminster'] > 100 for c in allc)} outside radius, {len(seen)} datasets")


if __name__ == "__main__":
    main(sys.argv[1])
