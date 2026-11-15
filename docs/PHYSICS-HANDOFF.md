# Physics layer — handoff and restore guide

Date: 2026-11-14
Branch: `main`
Repository: `C:\Users\austi\OneDrive\Documents\GitHub\OCSEF-Hackathon---nov-14-15`
HEAD at handoff: `f7c8cf5` ("Restore the tail of MapView that the previous commit captured truncated.")
Physics snapshot commit: `80fbefe` ("Snapshot the app, evidence, physics and research work for a parallel session.")

This file records what was built, what is complete, what is not, where every
file lives, and how to restore or hand the work to the ETL session.

---

## 1. One-paragraph summary

A pure-TypeScript, deterministic physical grid model was added under
`lib/physics/`. It solves balanced radial AC power flow, exact two-bus voltage
drop, P-V collapse margin, short-circuit strength, DER hosting capacity,
transformer thermal aging, conductor heat balance, frequency dynamics with
governor/FFR/UFLS, weather-driven load, solar and wind profiles, battery state
of charge, project economics, and a municipality/buildout time-series engine.
The engine runs a 24-hour design day or an 8760-hour weather year, builds a
different network per buildout year, and returns every municipality and
buildout statistic the UI needs. A 61-assertion verification script passes.

The existing frozen contracts (`lib/types.ts`, `lib/simulation.ts`,
`lib/grid.ts`) were **not** modified. The physics layer is additive.

---

## 2. Work completed

### 2.1 Physics primitives

| File | Contents |
| --- | --- |
| `lib/physics/units.ts` | constants, complex math, per-unit bases, three-phase power/current, energy, CO₂, temperature, interpolation, rounding |
| `lib/physics/network.ts` | conductor library and impedance, radial backward-forward power flow, exact two-bus solution, P-V collapse margin, short circuit, hosting capacity, feeder summary |
| `lib/physics/thermal.ts` | IEEE C57.91-style transformer top-oil/hot-spot/aging, conductor heat balance and ampacity, sag-risk bands |
| `lib/physics/dynamics.ts` | inertia, ROCOF, swing-equation frequency event, governor droop, battery FFR, UFLS, stability bands and score |
| `lib/physics/load.ts` | sector shapes, weather multiplier, synthetic day/year, solar position/clear-sky/POA/PV, wind curve, battery state machine |
| `lib/physics/economics.ts` | CRF, LCOE, NPV, IRR, payback, loss/unserved/carbon costs, upgrade economics, capacity value |

### 2.2 Municipality contract and engine

| File | Contents |
| --- | --- |
| `lib/physics/municipalityTypes.ts` | additive input contract (`MunicipalityScenario`, feeders, buses, buildouts) and every output stat type (`MunicipalityStats`, `BuildoutStats`, `PeakSnapshot`, etc.) |
| `lib/physics/municipality.ts` | topology builder, weather runner, hourly power-flow/thermal loop, reliability, stability, buildout stats, annual/design-day composition, public `runMunicipality()` |
| `lib/physics/index.ts` | single public import surface re-exporting all modules |

### 2.3 Verification and documentation

| File | Contents |
| --- | --- |
| `scripts/verify-physics.ts` | 61 numeric assertions: per-unit, conductor, two-bus, radial cross-check, P-V, hosting, transformer, conductor thermal, ROCOF/inertia, load/solar/wind/battery, economics, 24-hour municipality, 8760-hour municipality |
| `package.json` | added `"verify:physics": "tsx scripts/verify-physics.ts"` |
| `docs/GRID-MODEL.md` | full formula reference, unit conventions, stat definitions, assumptions, limitations, ETL consumption guide |
| `docs/PHYSICS-HANDOFF.md` | this file |

### 2.4 Fixes made during final validation

- `builtBusSpecs` now returns `{ buses, solar_mw, wind_mw, battery_mw }`, so
  hourly rows report real solar/wind/battery instead of placeholders.
- `line_overload_hours` now sums per-hour overloaded branch counts instead of
  multiplying by zero.
- Buildout status simplified to the active set (`active` / `planned`).
- `peakLineTemperature` uses the voltage-appropriate default conductor.
- `peakUnbalance` now includes buildout buses in the load denominator and
  treats undeclared buses as balanced.
- Removed unused parameters/variables and stale imports.
- Verified `lib/physics/*` has zero TypeScript errors under `strict: true`.

---

## 3. Current status

### Working and verified

- `npm run verify:physics` → **61 passed, 0 failed**.
- 24-hour design-day run on a synthetic municipality with one feeder, two
  buses, residential/commercial load, solar and a data-center buildout.
- 8760-hour annual run with weather calibration and hosting capacity.
- Buildout lifecycle: planned in 2026, active in 2028, with a modeled peak and
  voltage/loading delta against the no-buildout baseline.
- All returned statistics are finite (recursive finite-value assertion).

### Type-check status

- `lib/physics/*` is clean.
- `npm run typecheck` still reports **pre-existing, unrelated** errors in:
  - `components/evidence/EvidenceProvider.tsx` (union narrowing of `claim`/`depth`)
  - `components/shell/MapCanvas.tsx` (`utilization_pct` not on `EnergyProfile`)
  - `components/shell/Workspace.tsx` (default import mismatch)
  - `lib/grid.ts` (missing `pathways` in `PhaseState` partials)
  - `lib/gridAssets.ts` (`string | null | undefined` mismatch)
- These were not touched. Do not conflate them with the physics layer.

### Not done / deliberately left open

- No UI wiring yet. The physics layer is a library; the dashboard still reads
  the existing energy model. Wiring is a separate task.
- No real utility data ingestion. The ETL session should map source rows into
  `MunicipalityScenario` (schema in `docs/GRID-MODEL.md` §16).
- No unbalanced load flow, harmonics, transients, protection coordination, or
  full IEEE 738. These are documented limitations, not defects.
- No commit was made for the newest files. See §5.

---

## 4. File map

```
lib/physics/
  units.ts                 constants, complex math, per-unit, energy, temperature
  network.ts               conductors, radial power flow, two-bus, P-V, SC, hosting
  thermal.ts               transformer C57.91 screen, conductor heat balance
  dynamics.ts              inertia, ROCOF, swing equation, UFLS, stability bands
  load.ts                  sector shapes, weather, solar, wind, battery
  economics.ts             CRF, LCOE, NPV, IRR, payback, cost helpers
  municipalityTypes.ts     input/output contract for the municipality engine
  municipality.ts          topology builder + annual/design-day engine
  index.ts                 public re-export surface

scripts/
  verify-physics.ts        numeric verification harness

docs/
  GRID-MODEL.md            formula reference and ETL consumption guide
  PHYSICS-HANDOFF.md       this handoff/restore guide
```

Tracked at `80fbefe` but modified in the working tree:

- `lib/physics/load.ts` — adds `design_high_c` / `design_low_c` to
  `WeatherScenario` (3 lines).
- `lib/physics/municipalityTypes.ts` — adds `PeakSnapshot.bus_load_mw` and
  `BuiltFeeder.s_base_mva` (2 lines).

Untracked at handoff:

- `lib/physics/municipality.ts`
- `lib/physics/index.ts`
- `scripts/verify-physics.ts`
- `docs/GRID-MODEL.md`
- `docs/PHYSICS-HANDOFF.md`

Everything else in `git status` (app, components, evidence, research, scan,
basemaps, grid assets) belongs to the parallel session. Do not sweep it into a
physics commit unless that is explicitly intended.

---

## 5. How to restore or move the work

### Option A — keep the working tree (current state)

Nothing was deleted. The files are on disk exactly as verified. Run:

```powershell
cd C:\Users\austi\OneDrive\Documents\GitHub\OCSEF-Hackathon---nov-14-15
npm install
npm run verify:physics
npm run typecheck
```

`verify:physics` is the fastest proof that the layer is intact.

### Option B — commit only the physics work

Stage the physics files explicitly so the parallel session's work is untouched:

```powershell
git add lib/physics/units.ts `
        lib/physics/network.ts `
        lib/physics/thermal.ts `
        lib/physics/dynamics.ts `
        lib/physics/load.ts `
        lib/physics/economics.ts `
        lib/physics/municipalityTypes.ts `
        lib/physics/municipality.ts `
        lib/physics/index.ts `
        scripts/verify-physics.ts `
        docs/GRID-MODEL.md `
        docs/PHYSICS-HANDOFF.md `
        package.json
git commit -m "Add deterministic municipal grid physics and buildout engine"
```

`package.json` may also contain another session's evidence scripts; if so,
stage only the `verify:physics` line with `git add -p package.json`.

### Option C — recover the earlier snapshot

The reusable primitives were captured in `80fbefe`:

```powershell
git show --stat 80fbefe
git checkout 80fbefe -- lib/physics/units.ts lib/physics/network.ts `
  lib/physics/thermal.ts lib/physics/dynamics.ts lib/physics/load.ts `
  lib/physics/economics.ts lib/physics/municipalityTypes.ts
```

Do **not** check out the whole commit; it includes unrelated app/evidence work.
`municipality.ts`, `index.ts`, `scripts/` and `docs/` are newer than `80fbefe`
and cannot be recovered from that commit. They must come from the working tree
or a commit made with Option B.

### Option D — merge with a parallel session / worktree

1. Commit the physics files (Option B) on this branch.
2. In the other worktree, merge or cherry-pick that commit.
3. Resolve any `package.json` script conflict by keeping both the evidence
   scripts and `verify:physics`.
4. Run `npm run verify:physics` and `npm run typecheck` in the merged tree.
5. If bus ids collide across the two specs, keep them globally unique or the
   peak snapshot/buildout deltas will index the wrong bus.

Access from application code:

```ts
import {
  runMunicipality,
  buildMunicipality,
  radialPowerFlow,
  frequencyEvent,
  type MunicipalityScenario,
  type MunicipalityResult,
} from "@/lib/physics";
```

The `@/` alias is already configured in `tsconfig.json` (`./*`).

---

## 6. What the ETL session should do next

1. **Map source rows to `MunicipalityScenario`** using the table shape in
   `docs/GRID-MODEL.md` §16. Preserve ids.
2. **Validate topology during ETL.** Call `buildMunicipality` once per
   municipality/year. A cycle or mixed voltage base throws immediately, which
   is the intended fail-fast behavior.
3. **Choose a run mode per view.**
   - Live/real-time: `runMunicipality(scenario, { hours: 24, record_hourly:
     true, compute_hosting: false })`.
   - Planning/annual: `runMunicipality(scenario, { hours: 8760,
     compare_baseline: true })`.
4. **Persist three objects separately:** `stats` (dashboard aggregate),
   `hourly[]` (charts), `peak` (map snapshot).
5. **Calibrate with real annual energy.** Put `annual_mwh` on each `LoadSpec`;
   a full-year run scales the peak so simulated annual energy matches the
   source. Design-day runs intentionally do not calibrate.
6. **Feed real weather when available.** Supply `weather.hourly` with at least
   `start_hour + hours` points. Otherwise the deterministic synthetic year is
   used.
7. **Treat the peak snapshot as the max-load hour**, not the max-stress hour.
   Use `stats.voltage`, `stats.thermal` and `stats.feeders` for extremes.
8. **Keep the UI contract honest.** Read `stats.hours` before labeling a field
   "annual"; a 24-hour run reports daily energy.

---

## 7. Quick verification checklist

```powershell
# 1. Are the files present?
Get-ChildItem lib\physics, scripts, docs

# 2. Do the formulas agree?
npm run verify:physics        # expect: 61 checks passed, 0 failed

# 3. Is the physics layer type-clean?
.\node_modules\.bin\tsc.cmd --noEmit 2>&1 | Select-String "lib/physics"
# expect: no output

# 4. Did anything unrelated regress?
npm run typecheck
# expect: only the pre-existing errors listed in §3
```

---

## 8. Key invariants to preserve in any merge

- `s_mva` is three-phase; `v_kv` is line-to-line RMS.
- Positive load consumes; positive DER injects; positive battery discharges.
- One voltage base per radial network; each level is a separate tree.
- Meshed or disconnected networks must throw, never return a number.
- Bus ids are globally unique; branch ids are unique within a feeder.
- `runMunicipality` is deterministic: same scenario + same options = same
  result. No wall clock, no random sampling.
- `lib/types.ts` remains frozen. Extend through `lib/physics/municipalityTypes.ts`.
- Do not silently accept `converged: false`; count it as a violation.
