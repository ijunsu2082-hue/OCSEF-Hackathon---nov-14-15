# Evidence report — Westminster 100-Mile Radius

- Bundle: `bnd_a25b91fa15ffa1d3`
- Schema: `gridsentinel.evidence/1`
- Generated: 2026-11-14T20:06:35.610Z
- Verification: **PASS**
- Claims: 378 (3 observed, 108 derived, 267 modeled, 0 inferred)
- Snapshots: 5
- Registry: `reg_e0d89c6e51d4a36b60732129891bb0ae839bf9054f54d7d6f2f5ef2121089a0b`

## Sources

| id | publisher | authority | license | endpoint |
| --- | --- | --- | --- | --- |
| `census-geocoder` | United States Census Bureau | primary | Public domain (US Census Bureau) | `https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x={x}&y={y}&benchmark=Public_AR_Current&vintage=Current_Current&format=json` |
| `eia-860` | U.S. Energy Information Administration | primary | Public domain (US Government work) | `https://www.eia.gov/electricity/data/eia860/xls/eia860{year}.zip` |
| `epa-egrid` | U.S. Environmental Protection Agency | primary | Public domain (US Government work) | `https://www.epa.gov/egrid/download-data` |
| `osm-overpass` | OpenStreetMap contributors | secondary | ODbL-1.0 | `https://overpass-api.de/api/interpreter` |
| `gs-layer-plants` | GridSentinel | derived | Internal artifact — see upstream license and caveats | `public/layers/plants.geojson` |
| `gs-layer-transmission` | GridSentinel / OpenStreetMap contributors | derived | ODbL-1.0 (upstream OpenStreetMap) | `public/layers/transmission.geojson` |
| `gs-layer-substations` | GridSentinel / OpenStreetMap contributors | derived | ODbL-1.0 (upstream OpenStreetMap) | `public/layers/substations.geojson` |
| `gs-seed-nodes` | GridSentinel | modeled | Internal curated dataset | `data/nodes.json` |
| `operator-records` | Site operator / permitting agency | primary | Publisher terms — quote and link, do not redistribute | `research/captures/{source_id}/{file}` |

## Snapshots

| id | source | retrieved | bytes | sha256 | path |
| --- | --- | --- | ---: | --- | --- |
| `snp_15d8e679f3e73655` | `gs-layer-substations` | 2026-11-14T19:30:20.804Z | 289175 | `4665ca2638bba408…` | `public/layers/substations.geojson` |
| `snp_45695c9371df821b` | `gs-seed-nodes` | 2026-11-14T19:30:20.804Z | 17877 | `64fb92bae3098d12…` | `data/nodes.json` |
| `snp_87a511a4b9a35769` | `gs-layer-plants` | 2026-11-14T19:30:20.804Z | 451190 | `c3359701a2c638bc…` | `public/layers/plants.geojson` |
| `snp_c73d46c411bb1ef3` | `gs-layer-transmission` | 2026-11-14T19:30:20.804Z | 2760667 | `d76220b9d62723c3…` | `public/layers/transmission.geojson` |
| `snp_d1a03c227bb18d0c` | `census-geocoder` | 2026-11-14T19:30:20.804Z | 4757 | `ebdf6b7bb14c7c3a…` | `research/fixtures/census/westminster-hs.geographies.json` |

## Disclosures

- **caution** Every nameplate MW, utilization and motor efficiency on the 11 load centers is modelled. None is an operator-published meter reading. The UI labels those claims MODELED.
- **caution** Carbon intensity and source mix are modelled for the serving grid zone. A live eGRID/ISO capture is the next evidence upgrade.
- **caution** Capex, savings and payback are screening estimates. They exclude incentives, escalation, financing and site-specific engineering.
- **info** Generation, transmission and substation layers are radius-clipped in-repo artifacts. The snapshot hash proves which artifact was counted; upstream row locators are not preserved.
- **info** OpenStreetMap coverage is community-maintained and incomplete. Counts are lower bounds on mapped features, not asset inventories.

## Verification

- ✓ schema — gridsentinel.evidence/1
- ✓ registry — 9 sources
- ✓ snapshots — 5 snapshots
- ✓ claim shape — 378 claims
- ✓ derivations — recomputed
- ✓ confidence — capped
- ✓ conflicts — 378 active claims
- ✓ unresolved — 0 open
- ✓ bundle id — bnd_a25b91fa15ffa1d3

