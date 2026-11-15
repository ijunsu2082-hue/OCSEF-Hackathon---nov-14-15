# GridSentinel Evidence Framework — specification, state, and operating guide

**Status:** complete and verified for `westminster-100mi`.
**Bundle:** `public/evidence/westminster-100mi.json` · `bnd_a25b91fa15ffa1d3`
**Claims:** 378 — 3 observed · 108 derived · 267 modeled · 0 inferred
**Snapshots:** 5 · **Sources:** 9 registered · **Unresolved:** 0
**Last verification:** `npm run evidence:verify:files` → PASS (5/5 snapshots rehashed, 267 locators re-resolved)

This document is the contract for how a number gets on screen, how it is cited, how it is
verified, how to rebuild it, and how to extend it to another region. It is written so a new
session can pick the work up from the repository alone.

---

## 1. Why this exists

The product shows claims about real places: a facility draws 21.6 MW, a region emits
427,329 t CO₂/yr, an upgrade pays back in 5.46 years. Those numbers previously lived in
seed JSON with no way to tell which were measured, which were computed, and which were
modelled. That is not shippable for a decision tool.

The evidence framework makes every displayed number one of exactly four things, attaches
the exact bytes and JSON Pointer that justify it (or the exact formula and inputs that
produce it), and fails the build if the claim cannot be reproduced. The UI reads the claim,
not a parallel literal, so the screen and the audit cannot drift.

**Non-negotiable rules**

1. Exactly four claim methods: `observed`, `derived`, `modeled`, `inferred`. There is no
   fifth category and no free-text source field.
2. An LLM may never author a measured fact. `inferred` is restricted to predicates that
   explicitly allow it, must be `low` confidence, must carry an accepted escalation record,
   and is forbidden for every physical measurement in this profile (nameplate, draw,
   carbon intensity, emissions, counts).
3. Bundles may not introduce code. Derivations can only name formulas in the closed
   registry; predicates and parsers are closed registries too.
4. A conflict is never averaged or silently chosen. The bundle stores a deterministic
   resolution record (winner + losers + rule + time + note).
5. Verification is fail-closed: a claim that cannot be re-hashed, re-parsed, re-resolved or
   re-evaluated makes `ok: false`. The UI is forbidden from presenting that bundle as
   evidence.
6. IDs are content hashes. They exclude timestamps and wall-clock values, so a re-capture of
   identical bytes produces identical citation anchors.
7. The default build is offline and deterministic. Every input is committed. Live fetching
   is opt-in and is not on the build path.

---

## 2. Current state (what is finished)

| Area | State |
| --- | --- |
| Evidence contract | `lib/evidence/schema.ts` — claim/source/snapshot/bundle types, `gridsentinel.evidence/1` |
| Canonical IDs | `lib/evidence/canonical.ts` — SHA-256 over canonical JSON; claim/snapshot/bundle/registry digests |
| Predicate registry | `lib/evidence/predicates.ts` — closed list, per-predicate unit, type, range, allowed methods, inference gate |
| Formula registry | `lib/evidence/formulas.ts` — 14 formulas, domain math reuses `lib/risk.ts` / `lib/simulation.ts` semantics |
| Verifier | `lib/evidence/verify.ts` — pure, fail-closed; re-hashes IDs, re-evaluates derivations, re-applies conflicts |
| File verifier | `research/verify-files.ts` — re-hashes snapshots, re-runs parsers, re-resolves JSON Pointers |
| Research pipeline | `research/` — profile → snapshots → claims → conflict resolution → verification → bundle |
| CLI | `research/cli.ts` — `build`, `verify`, `discover`, `report`, `hash`, `sources`, `profiles` |
| Region profile | `research/profiles/westminster-100mi.json` |
| Captured sources | Census geocoder fixture + 3 in-repo layers + seed dataset (5 snapshots) |
| Generated bundle | `public/evidence/westminster-100mi.json` (verified) |
| UI citations | `components/evidence/*` — provider, inline `Cite`, `ClaimValue`, overlay, Evidence tab |
| Shell wiring | `app/page.tsx` loads the bundle server-side; `Workspace` provides it; drawer has an **Evidence** tab |
| Inline citations | Control bar KPIs, analyzer header metrics, telemetry metrics + source mix, Process facility ranking |
| Styles | `app/globals.css` — citation chips, overlay card, method badges, verification/source/disclosure blocks |
| Scripts | `package.json` — build/verify/discover/report/hash/sources/profiles + `typecheck` |
| Build verification | `NEXT_DIST_DIR=build-verify npm run build` passed (isolated from concurrent dev servers) |

### Region KPIs proven by the bundle

| Predicate | Value | Method |
| --- | ---: | --- |
| `region.kpi_total_draw_mw` | 147.0877 MW | derived (sum of facility baselines) |
| `region.kpi_total_nameplate_mw` | 206.4 MW | derived |
| `region.kpi_total_annual_mwh` | 1,288,488 MWh | derived |
| `region.kpi_total_annual_co2_tons` | 427,329 t | derived |
| `region.kpi_carbon_intensity_gco2_kwh` | 331.7 gCO₂/kWh | derived (draw-weighted mean) |
| `region.facility_count` | 11 | derived (`artifact.count` on the seed) |
| `region.plant_count` | 697 | derived (`artifact.count` on EIA-860 layer) |
| `region.transmission_feature_count` | 5,331 | derived (`artifact.count`) |
| `region.substation_feature_count` | 1,271 | derived (`artifact.count`) |
| `region.county_name` | Orange County | observed (Census fixture) |
| `facility.risk_score` (Hyperion) | 72.3 | derived (`energy.risk_score`) |
| `facility.upgrade.payback_years` (Hyperion) | 5.46 | derived |

The 3 observed claims are the Census state FIPS, county FIPS and county name. Everything
electrical is modelled from the curated seed, and the UI says so.

---

## 3. Architecture

```
research/profiles/<region>.json          scope, anchor, as-of year, model bases, disclosures
        │
        ├── fixtures/ + <file>.meta.json  captured HTTP bytes (committed)
        ├── public/layers/*.geojson       in-repo derived artifacts
        └── data/nodes.json               curated seed dataset
                    │
                    ▼
research/snapshot.ts ── hash bytes ──► SourceSnapshot (content-addressed)
                    │
research/parsers.ts ── parse ────────► record_count + parsed data
                    │
research/build.ts ── observed/modeled/derived claim builders ──► Claim[]
                    │
research/resolve.ts ── deterministic conflicts ──► resolutions + active winners
                    │
lib/evidence/verify.ts ── pure verification ──► VerificationReport
                    │
                    ▼
public/evidence/<region>.json  ──► app/page.tsx (server) ──► EvidenceProvider (client)
                                                              ├── <Cite> / <ClaimValue>
                                                              ├── citation overlay
                                                              └── <EvidenceTab>
```

Read-side helpers (`lib/evidence/citation.ts`) are browser-safe and dependency-free. The
server loader (`lib/evidence/load.ts`) reads the bundle once per region and caches it.

---

## 4. Contracts

### 4.1 Claim

```ts
interface Claim {
  id: string;                 // clm_<16 hex> content hash
  subject: string;            // "facility:node-la-05" | "region:westminster-100mi"
  predicate: string;          // registered id, never free text
  value: string | number | boolean | null;
  unit: string | null;        // must equal the predicate's canonical unit
  method: "observed" | "derived" | "modeled" | "inferred";
  confidence: "high" | "medium" | "low";
  source_id: string | null;
  snapshot_id: string | null;
  locator: string | null;     // RFC 6901 JSON Pointer into the snapshot
  retrieved_at: string | null;
  derivation: Derivation | null;
  basis: string | null;       // required for modeled; reasoning for inferred
  caveats: string[];
  escalation: EscalationRecord | null;
  runtime?: boolean;          // browser-only, never persisted
}
```

**Provenance rules enforced by the verifier**

| Method | Required | Forbidden |
| --- | --- | --- |
| `observed` | registered source + snapshot + locator + retrieval time | derivation, basis |
| `derived` | registered formula + exact inputs; `artifact.count` needs a snapshot | source/locator (except `artifact.count`) |
| `modeled` | non-empty model basis; known source/snapshot when present | derivation |
| `inferred` | accepted escalation, low confidence, source, locator, basis | physical-measurement predicates |

### 4.2 Derivation

A derivation names a formula and binds claim ids to input names:

```ts
interface Derivation {
  formula_id: string;   // one of the 14 registered formulas
  inputs: { claim_id: string; as: string }[];
  params: Record<string, string | number | boolean | null>;
  expression: string;   // display-only; must match the registry template
  rounding: number;     // must equal the formula's declared rounding
}
```

The verifier resolves every input claim, detects cycles, re-evaluates the formula and
compares at the declared rounding. It also checks that the input name set exactly matches
the formula's required inputs (or `min_inputs` for variadic formulas) and that required
params are present.

### 4.3 Source and snapshot

A `SourceDefinition` is a publisher plus a retrieval contract: id, title, publisher,
homepage, license, authority (`primary` / `secondary` / `derived` / `modeled`), access kind,
endpoint template, docs, determinism flag, freshness cadence and max age, and caveats.

A `SourceSnapshot` is one immutable retrieval: content-addressed id, source id, URL,
method, request digest, retrieval time, HTTP status/content-type/etag/last-modified, byte
count, SHA-256, repo-relative cache path, parser id/version, record count, notes.

Snapshot id = hash of `{source_id, url, method, request_digest, sha256}`. Timestamps are not
part of it.

### 4.4 Bundle

`EvidenceBundle` holds schema, bundle id, region, generated-at metadata, registry digest,
sources, snapshots, claims, conflict resolutions, unresolved items, disclosures,
verification report and stats. The bundle id hashes the region, sources, snapshots, claims
and resolutions — **not** `generated_at` or `verification.verified_at`.

### 4.5 Confidence ceilings

| Method | Max confidence |
| --- | --- |
| `observed` | high for `primary`, medium for `secondary`, low otherwise |
| `derived` | weakest input confidence; no inputs → high for `primary`, else medium |
| `modeled` | medium |
| `inferred` | low |

A claim may declare lower confidence than the ceiling, never higher.

### 4.6 Conflict resolution

Claims are grouped by `subject + predicate`. If only one distinct value exists, the
deterministic rank chooses the display claim: higher confidence → stronger authority →
most recent retrieval → lexicographic id. If distinct values exist, the bundle must carry
a `ConflictResolution` covering exactly the non-winning claims; otherwise verification
fails with `CONFLICT_UNRESOLVED`.

---

## 5. Registries

### 5.1 Sources — `research/registry.ts`

| id | Publisher | Authority | Access |
| --- | --- | --- | --- |
| `census-geocoder` | US Census Bureau | primary | REST |
| `eia-860` | US EIA | primary | bulk |
| `epa-egrid` | US EPA | primary | bulk |
| `osm-overpass` | OpenStreetMap contributors | secondary | Overpass |
| `gs-layer-plants` | GridSentinel (EIA-860 subset) | derived | in-repo layer |
| `gs-layer-transmission` | GridSentinel / OSM | derived | in-repo layer |
| `gs-layer-substations` | GridSentinel / OSM | derived | in-repo layer |
| `gs-seed-nodes` | GridSentinel curated | modeled | seed |
| `operator-records` | Operator / agency | primary | manual capture |

The registry is hashed into every bundle (`registry_digest`). Changing an entry invalidates
existing bundles on the next verification run.

### 5.2 Predicates — `lib/evidence/predicates.ts`

Closed list covering facility identity (`name`, `type`, `operator`, coordinates, year),
electrical state (`nameplate_draw_mw`, `utilization_pct`, `motor_efficiency_rating`,
`baseline_draw_mw`, `peak_draw_mw`), carbon (`grid_zone`,
`carbon_intensity_gco2_kwh`, five source-mix shares), computed energy (`annual_mwh`,
`annual_co2_tons`, `homes_equivalent`, `risk_score`), live/scenario values
(`live_*`), upgrade economics, and region identity/counts/KPIs.

Each predicate declares `subject_prefix`, `value_type`, `unit`, optional range/enum,
`allowed_methods`, and `allow_inferred`. Physical measurements set `allow_inferred: false`.

### 5.3 Formulas — `lib/evidence/formulas.ts`

| id | Expression | Rounding |
| --- | --- | ---: |
| `artifact.count` | `snapshot.record_count` | 0 |
| `energy.baseline_draw_mw` | `nameplate_mw × utilization_pct ÷ 100` | 4 |
| `energy.age_years` | `as_of_year − year_built` | 0 |
| `energy.annual_mwh` | `draw_mw × 24 × 365` | 0 |
| `energy.annual_co2_tons` | `annual_mwh × 1000 × gCO2/kWh ÷ 1,000,000` | 1 |
| `energy.homes_equivalent` | `annual_mwh ÷ 10.5` | 0 |
| `energy.heatwave_draw_mw` | `min(utilization × 1.35, 105) ÷ 100 × nameplate × 1.45` | 3 |
| `energy.heatwave_ci` | `carbon_intensity × 1.25` | 1 |
| `energy.risk_score` | `40×fossil + 25×CI + 20×inefficiency + 15×age` | 1 |
| `upgrade.capex_usd` | `solar_mw × $/MW + (vfd ? vfd_capex : 0)` | 0 |
| `upgrade.savings_usd` | `solar_mw × $/MW-yr + (vfd ? vfd_savings : 0)` | 0 |
| `upgrade.payback_years` | `capex ÷ savings` (null when ≤ 0) | 2 |
| `region.sum` | `Σ inputs` at `decimals` | param |
| `region.weighted_mean` | `Σ(value×weight) ÷ Σ(weight)` at `decimals` | param |

`energy.risk_score` calls `lib/risk.ts`; the upgrade and energy formulas mirror the pure
math in the app. There is no second copy of the risk formula.

### 5.4 Parsers — `research/parsers.ts`

`geojson.features`, `json.array`, `json.overpass.elements`, `json.census.geographies`,
`json.object`, `text.lines`. Each returns parsed data and a record count. The verifier
re-runs the declared parser and requires the recorded count to match.

---

## 6. Build pipeline

`npx tsx research/cli.ts build --profile westminster-100mi` (or `npm run evidence:build`):

1. Load the profile; reject an unknown schema.
2. Resolve every referenced source from the closed registry.
3. **Region identity:** load each committed fixture with its `.meta.json`, hash the bytes,
   parse, and bind each configured locator to an `observed` claim.
4. **Scope config:** radius and anchor coordinates become `modeled` claims with an explicit
   basis ("scope fixed by the profile, not a measurement").
5. **Layer counts:** hash each in-repo GeoJSON, parse it, and emit `artifact.count`
   derivations (`region.plant_count`, transmission and substation counts).
6. **Facility count:** `artifact.count` over the seed feature collection.
7. **Seed facilities:** every field is a `modeled` claim with a JSON Pointer into
   `data/nodes.json`, the registered source and the profile's model basis (identity,
   electrical, carbon, economics, upgrade).
8. **Facility derivations:** age, baseline draw, annual MWh, annual CO₂, homes equivalent,
   risk score, capex, savings, payback. Each binds claim ids through the formula registry.
9. **Seed-vs-derived consistency:** if the seed's pre-computed capex or savings disagrees
   with the derivation by more than $0.50, an `unresolved` conflict is recorded instead of
   picking one.
10. **Region rollups:** sums of nameplate, baseline draw, annual MWh and annual CO₂; a
    draw-weighted mean carbon intensity.
11. **Deduplicate and sort** claims deterministically by subject, predicate, id.
12. **Resolve conflicts** deterministically; produce resolution records.
13. **Verify the assembled bundle**; any error aborts the build before writing.
14. Write pretty-printed JSON to the profile output path.

The build performs no network I/O.

---

## 7. Verification

### 7.1 Structural verification — `lib/evidence/verify.ts`

Runs in Node and in the browser (`indexBundle` calls it once). It checks:

- schema string, region, array shapes;
- unique source ids and required source fields;
- `registry_digest` matches the hash of the sources in the bundle;
- unique snapshot ids, source ownership, SHA-256 shape, recomputed snapshot id, timestamps,
  paths, byte counts, parser presence, freshness;
- unique claim ids, claim shape, registered predicate, subject prefix, allowed method,
  inference gate, value type/range/enum, unit;
- method-specific provenance rules (observed/derived/modeled/inferred);
- recomputed claim id;
- every derivation: known formula, input existence, acyclicity, exact input name set,
  required params, rounding match, recomputed value, expression drift;
- confidence ceiling;
- conflict grouping, resolution coverage, orphan resolutions, manual notes, resolution times;
- unresolved items (strict mode treats any as an error);
- disclosure ids and text;
- recomputed bundle id;
- stats consistency (warnings only).

Return value: `{report, active}` where `active` is the winner per `subject + predicate`.
The UI uses `active`, so a losing claim never renders.

### 7.2 File verification — `research/verify-files.ts`

`npm run evidence:verify:files` additionally:

- reads every snapshot from `cache_path` and re-hashes it against the recorded SHA-256;
- re-runs the declared parser and requires the recorded `record_count`;
- re-resolves every claim's JSON Pointer and requires the value to match.

It also verifies freshness using each source's `max_age_days`. In `--strict` mode freshness
warnings and unresolved items become errors.

Expected output:

```
bundle bnd_a25b91fa15ffa1d3 (westminster-100mi)
claims 378 · snapshots 5 · strict=true
files: 5/5 snapshots rehashed, 267 locators re-resolved
  ok   schema — gridsentinel.evidence/1
  ok   registry — 9 sources
  ok   snapshots — 5 snapshots
  ok   claim shape — 378 claims
  ok   derivations — recomputed
  ok   confidence — capped
  ok   conflicts — 378 active claims
  ok   unresolved — 0 open
  ok   bundle id — bnd_a25b91fa15ffa1d3
verified: every claim reproduced from its recorded evidence
```

### 7.3 What verification does **not** prove

- It does not prove the upstream publisher was right.
- It does not prove a curated seed value is the operator's meter reading.
- It does not prove OSM completeness.
- It does not resolve a stale capture into fresh data; it only reports staleness.

Those limits are the `disclosures` block and each source's `caveats`.

---

## 8. UI: how citations work

### 8.1 Server load

`app/page.tsx` is a server component. It calls `loadEvidenceBundle(region.id)`
(`lib/evidence/load.ts`), which reads `public/evidence/<region>.json` and caches it. A
missing bundle is not fatal: the app renders, and the Evidence tab says the dataset is
unverified.

### 8.2 Provider

`<EvidenceProvider bundle={...}>` (`components/evidence/EvidenceProvider.tsx`):

- builds a `ClaimIndex` by running the pure verifier;
- exposes `claim(subject, predicate)`, source codes (`S1`, `S2`, …), and the overlay;
- renders the citation dialog at the root so any chip can open it.

### 8.3 Inline primitives — `components/evidence/Citations.tsx`

- `<Cite subject predicate />` resolves the pair. If absent while a bundle is loaded it
  renders a red `?` marker saying no verified claim exists — it never drops the citation
  silently.
- `<Cite claim />` renders a known claim.
- `<ClaimValue subject predicate />` renders **the claim's value**, not a call-site
  literal, then the chip. Display and evidence cannot drift.
- `<MethodBadge />` and `<ScenarioTag />` label method and interactive scenarios.
- Chips are coloured by method: observed teal, derived blue, modeled amber, inferred
  violet. Clicking opens the overlay.

### 8.4 Overlay

The overlay shows: predicate label, method + confidence, value + unit, source
(publisher/license/authority), retrieval date, JSON Pointer, snapshot id + SHA-256 + byte
count + path, model basis (for modeled), the formula expression and full input chain (for
derived), caveats, claim id, and any escalation record.

### 8.5 Where citations are mounted

| Surface | Cites |
| --- | --- |
| `ControlBar` KPIs | region draw, region carbon intensity, region annual CO₂ |
| `AnalyzerDrawer` header | facility baseline draw, carbon intensity, annual CO₂ |
| `TelemetryTab` | annual energy, annual CO₂, homes equivalent, motor efficiency, nameplate, each source-mix share |
| `ProcessTab` ranking | facility risk score, recommended solar MW |
| `EvidenceTab` | verification stats, every facility/region claim, sources, snapshots, disclosures |

When the heatwave is active, KPI/telemetry/header citations become a **scenario** tag
instead of a stale claim chip, because the displayed number is a runtime transform, not the
stored baseline.

### 8.6 Evidence tab

Opened from the drawer tabs. It renders four panels:

1. **Verification** — pass/fail, claim counts, bundle id, registry digest, first errors.
2. **Load-center evidence** — every active claim for `facility:<id>` with value, method,
   source code and a clickable citation.
3. **Region evidence** — every active claim for `region:<id>`.
4. **Sources** — each registered source, authority, license, endpoint, snapshots (hash,
   bytes, date, path) and caveats.
5. **Disclosures** — what the model does not prove.

---

## 9. Repository map

| Path | Role |
| --- | --- |
| `lib/evidence/schema.ts` | Evidence contract and types |
| `lib/evidence/canonical.ts` | Canonical JSON, SHA-256, content-addressed ids |
| `lib/evidence/sha256.ts` | Browser-safe SHA-256 |
| `lib/evidence/predicates.ts` | Closed predicate registry |
| `lib/evidence/formulas.ts` | Closed formula registry; reuses domain math |
| `lib/evidence/verify.ts` | Pure, fail-closed verifier |
| `lib/evidence/citation.ts` | Read-side helpers (`facilitySubject`, `regionSubject`, index, chains, labels) |
| `lib/evidence/runtime.ts` | Browser-only runtime claims built from cited inputs |
| `lib/evidence/load.ts` | Server bundle loader with cache |
| `components/evidence/EvidenceProvider.tsx` | Context, index, overlay |
| `components/evidence/Citations.tsx` | `Cite`, `ClaimValue`, `MethodBadge`, `ScenarioTag` |
| `components/evidence/EvidenceTab.tsx` | Verification/source/claim/disclosure tab |
| `research/cli.ts` | CLI entry point |
| `research/build.ts` | Profile → bundle |
| `research/claims.ts` | Claim constructors (`observedClaim`, `modeledClaim`, `derivedClaim`) |
| `research/registry.ts` | Source registry |
| `research/profiles/*.json` | Region scope, model bases, fixtures, layers, disclosures |
| `research/snapshot.ts` | Fixture/artifact/live snapshot construction and replay |
| `research/parsers.ts` | Parsers and JSON Pointer resolver |
| `research/resolve.ts` | Deterministic conflict resolution |
| `research/verify-files.ts` | File-level verification |
| `research/tools/capture.mjs` | Capture one HTTP response into the fixture store |
| `research/fixtures/**` | Committed captured bytes + `.meta.json` |
| `public/evidence/*.json` | Generated, verified bundles |
| `research/queries/*.overpassql` | Overpass query sources used for captures |

---

## 10. Commands

```bash
npm install                 # once; installs tsx in devDependencies
npm run typecheck           # tsc --noEmit
npm run evidence:build      # build the Westminster bundle (offline)
npm run evidence:verify     # structural verification
npm run evidence:verify:files   # + re-hash snapshots, re-resolve locators, strict
npm run evidence:report     # write research/reports/westminster-100mi.md
npm run evidence:hash -- --file data/nodes.json
npm run evidence:sources    # print the registry + digest
npm run evidence:profiles   # print the resolved profile
npm run evidence:discover -- --center 33.7538,-118.0111 --radius 5 --offline <fixture>
npm run dev                 # http://localhost:3000
npm run build               # production build
```

Equivalent direct form:

```bash
npx tsx research/cli.ts build  --profile westminster-100mi
npx tsx research/cli.ts verify --bundle public/evidence/westminster-100mi.json --files --strict
npx tsx research/cli.ts discover --center 33.7538,-118.0111 --radius 5
```

### Verified build under concurrent dev servers

This checkout may have several `next dev` processes and another `next build` writing the
default `build-out/`. Use an isolated dist directory for a verification build:

```bash
# PowerShell
$env:NEXT_DIST_DIR="build-verify"; npm run build

# cmd
set NEXT_DIST_DIR=build-verify && npm run build
```

Delete `build-verify/` afterwards. `next.config.ts` pins `distDir` to `build-out` by default
because OneDrive intermittently drops files inside dot-directories.

---

## 11. Restore and access

### 11.1 If the bundle is missing

Generate it:

```bash
npm run evidence:build
npm run evidence:verify:files
```

The app still runs without it. The Evidence tab will say "No evidence bundle is loaded";
inline citations render nothing, and nothing is presented as verified.

### 11.2 If the UI citations are missing

Check these four files are present and wired:

1. `app/page.tsx` calls `loadEvidenceBundle` and passes `evidence` to `<Workspace>`.
2. `components/shell/Workspace.tsx` wraps the shell in `<EvidenceProvider>` and renders
   `<EvidenceTab>` for the `evidence` tab.
3. `components/shell/AnalyzerDrawer.tsx` includes the `evidence` tab in `TABS`.
4. `components/ui/kit.tsx` `Stat` accepts `cite`.

### 11.3 If the verification fails

Read the failing check, then:

- `CLAIM_ID` / `BUNDLE_ID` / `SNAPSHOT_ID` → the content changed; rebuild rather than
  hand-editing the bundle.
- `DERIVATION_MISMATCH` → a formula or an input changed; inspect
  `claim.derivation.formula_id` and the chain in the Evidence tab.
- `SNAPSHOT_REPLAY` / `SNAPSHOT_STALE` → the fixture bytes changed or the source is older
  than its `max_age_days`; re-capture with `research/tools/capture.mjs`.
- `LOCATOR_MISMATCH` / `LOCATOR_MISSING` → the upstream schema moved; update the profile's
  locator and rebuild.
- `CONFLICT_UNRESOLVED` → add an explicit resolution or fix the conflicting evidence.

Never edit `public/evidence/*.json` by hand. It is generated.

### 11.4 Access from a fresh session

```
Start here:  research/README.md
Contract:    lib/evidence/schema.ts
Pipeline:    research/build.ts
CLI:         research/cli.ts
Profile:     research/profiles/westminster-100mi.json
Bundle:      public/evidence/westminster-100mi.json
UI:          components/evidence/
```

No environment variables are required. No network is required to build or verify.

---

## 12. Extending to another region

1. Copy `research/profiles/westminster-100mi.json` to `<region>.json`.
2. Set `id`, `name`, `state`, `center`, `radius_miles`, `bounds`, `grid_zone`,
   `as_of_year`, `captured_at`, `output` (`public/evidence/<region>.json`).
3. Point `seed.path` at the region's seed GeoJSON and keep the model-basis text honest.
4. Add fixtures (Census geocode of the anchor, eGRID subregion, ISO mix) with captured
   bytes + `.meta.json` and JSON Pointer locators.
5. Add layer counts if the region has radius-clipped layers.
6. Rewrite `disclosures` for the new region. Do not copy claims that do not apply.
7. `npx tsx research/cli.ts build --profile <region>`
8. `npx tsx research/cli.ts verify --bundle public/evidence/<region>.json --files --strict`
9. Point `app/page.tsx` at the new region id, or load multiple bundles and select at runtime.
10. The profile appears automatically in `evidence:profiles`.

The build is region-agnostic: it derives counts, sums and weighted means from whatever
the seed contains. Facility ids and predicates are stable, so citations follow the data.

---

## 13. Extension rules

### Add a source

1. Add a `SourceDefinition` to `research/registry.ts` with publisher, license, authority,
   endpoint, docs, determinism, freshness and caveats.
2. Capture a fixture with `research/tools/capture.mjs` or drop an in-repo artifact.
3. Reference it from a profile fixture/layer and rebuild.
4. `registry_digest` changes; old bundles fail verification until rebuilt. That is intended.

### Add a predicate

1. Add an entry to `lib/evidence/predicates.ts` with subject prefix, value type, unit,
   range/enum, allowed methods and `allow_inferred`.
2. Use it from `research/build.ts` or a new builder.
3. Rebuild and verify.

### Add a formula

1. Add a `FormulaDefinition` to `lib/evidence/formulas.ts`: id, display expression, exact
   input names (or `"any"` + `min_inputs`), required params, rounding, pure evaluator.
2. Reuse an existing pure function where one exists; do not duplicate domain math.
3. Rebuild and verify.

### Add a parser

1. Add a `ParserDefinition` to `research/parsers.ts` returning `{data, recordCount}`.
2. Reference it from a snapshot configuration.
3. `verify --files` will re-run it over the exact bytes.

### Add an LLM escalation (not implemented)

The schema has an `EscalationRecord` and the verifier already enforces the rules. A future
`research/escalate.ts` should:

1. Only consider `unresolved` items whose predicate has `allow_inferred`.
2. Send the candidate claims and their cited locators to a provider (e.g. Groq).
3. Parse a structured verdict; accept only if it chooses among cited candidates and gives a
   reason.
4. Store `provider`, `model`, `prompt_sha256`, `response_sha256`, `at`, `verdict`, `reason`.
5. Emit an `inferred` claim at `low` confidence with source + locator + basis.
6. Never allow escalation to override a physical measurement, and never let it run during
   the deterministic build.

Until that exists, `inferred` remains unused and the disclosures say so.

---

## 14. Known limitations and honest gaps

| Limitation | Effect | Next step |
| --- | --- | --- |
| Electrical ratings are modelled from the curated seed | `facility.nameplate_draw_mw`, utilization, efficiency and economics are `modeled` | Capture operator interval data / audited permits and add `observed` claims |
| Carbon intensity is modelled for `US-CAL-CAMX` | Region KPIs are modelled, not a live eGRID/ISO signal | Capture eGRID subregion + ISO fuel mix fixtures |
| Layer counts are radius-clipped in-repo subsets | `region.plant_count` etc. are counts of the artifact, not national totals | Preserve upstream row locators in future extracts |
| OSM is community-maintained | Counts are lower bounds on mapped features | Add completeness caveat (already present) |
| Live Overpass is unreliable here | `discover` live mode can return 502/timeout; captures are committed instead | Retry with backoff; commit a discovery fixture |
| Build CLI has no `--refresh` flag yet | `fetchLive` exists but is only exercised by `discover` | Expose `--refresh` and re-capture fixtures deliberately |
| No LLM escalation module | `inferred` is unused | Implement `research/escalate.ts` behind the rules in §13 |
| Bundle is loaded per process | A dev server may cache an old bundle | Restart `npm run dev` after rebuilding |
| Concurrent sessions share the checkout | `next build` can collide on `build-out/` | Use `NEXT_DIST_DIR=build-verify` for verification builds |

---

## 15. Acceptance checklist

- [x] Four methods only; physical measurements cannot be inferred.
- [x] Closed predicate, formula and parser registries.
- [x] Content-addressed claim/snapshot/bundle ids; timestamps excluded.
- [x] Offline deterministic build from committed fixtures and artifacts.
- [x] Structural verifier re-hashes ids, re-evaluates derivations, enforces confidence and
      conflicts.
- [x] File verifier re-hashes snapshots and re-resolves every JSON Pointer.
- [x] Strict verification passes with 0 unresolved items.
- [x] UI resolves numbers through claims; missing claims render a visible marker.
- [x] Evidence tab exposes verification, claims, sources, snapshots and disclosures.
- [x] Scenario values are tagged instead of citing a stale baseline.
- [x] `npm run build` passes in an isolated dist directory.
- [x] Spec documents state, commands, restore paths and limitations.

> Dataset provenance and reproduction commands live in [README.md](README.md).
