# GridSentinel physical grid model

Status: implemented, type-clean and numerically verified on 2026-11-14.
Scope: additive physics layer for municipality load, infrastructure buildout,
grid stability, voltage, thermal, reliability, emissions and economics.
Owner files: `lib/physics/`, `scripts/verify-physics.ts`, this document.

This document is the formula and contract reference. It is written so that the
ETL session can map source tables into the input interfaces without reading the
implementation, and so a reviewer can recompute every displayed number by hand.

---

## 1. What this layer is

The original repository models a 100-mile, 11-site regional energy balance. It
answers "how much energy, from where, at what cost". It does not answer:

- does the distribution feeder stay inside voltage limits?
- which branch or transformer is thermally overloaded, and for how many hours?
- how much energy is lost in conductors?
- what happens to frequency if the largest infeed trips?
- does a new data center, housing tract or solar farm actually fit?
- what does the buildout cost per added peak MW?

`lib/physics` adds those answers as a deterministic, pure-TypeScript,
quasi-static positive-sequence model. It is additive: it does not edit the
frozen `lib/types.ts`, `lib/simulation.ts` or `lib/grid.ts` contracts.

```
source data ──► MunicipalityScenario ──► runMunicipality() ──► MunicipalityResult
                       │                        │
                       │                        ├─ stats (annual or design day)
                       │                        ├─ hourly[] (optional)
                       │                        └─ peak snapshot
                       │
                       └─ buildMunicipality() filters buildouts by year and
                          creates new buses/branches before the first hour
```

---

## 2. Unit conventions (read this first)

| Symbol | Meaning | Unit |
| --- | --- | --- |
| `s_mva`, `S` | three-phase apparent power | MVA |
| `v_kv`, `V` | line-to-line RMS voltage | kV |
| `p_mw`, `q_mvar` | active / reactive power | MW / Mvar |
| `i`, `I` | current | A in results, kA in per-unit helpers |
| `E` | energy | MWh |
| `f` | frequency | Hz |
| `T`, `θ` | temperature | °C unless a formula explicitly uses K |
| `impedance` | R, X, Z | ohm (Ω) |

Invariants:

1. `s_mva` is **always** three-phase. `v_kv` is **always** line-to-line RMS.
   This is why every current equation divides by `√3 · V_LL`.
2. Positive load = consumption. Positive DER = injection. Positive battery =
   discharge. Charging is negative DER and appears as extra load.
3. A `RadialNetwork` must be a tree with one voltage base. Meshed or
   disconnected networks throw rather than return a plausible number.
4. Each voltage level is its own radial network. A transformer between levels
   is not solved as a branch; the substation aggregates the feeder slacks.

---

## 3. Per-unit bases (`units.ts`)

```
Z_base = V_LL² / S_3φ                     [Ω]
I_base = S_3φ / (√3 · V_LL)               [kA]
Y_base = S_3φ / V_LL²                     [S]
Z_pu   = Z_ohm / Z_base
```

Three-phase power and current:

```
S = √3 · V_LL · I                         [MVA, kV, kA]
I = |S| / (√3 · V_LL)                     [kA]
pf = P / |S|,   Q = P · tan(acos(pf))
```

Complex arithmetic is explicit (`cx`, `cAdd`, `cMul`, `cDiv`, `cConj`,
`cAbs`, `cArg`). No external math library is used.

Energy and emissions:

```
E_MWh = P_MW · hours
tonnes CO₂ = E_MWh · intensity_gCO₂_per_kWh / 1000
```

The `/1000` works because `1 g/kWh = 1 kg/MWh` and `1 t = 1000 kg`.

Temperature helpers use `K = °C + 273.15`. Air density is
`ρ = P / (287.05 · T_K)`.

---

## 4. Conductors and branch impedance (`network.ts`)

Screening conductor library (`CONDUCTORS`):

| id | label | R25 Ω/mi | GMR ft | dia in | ampacity A | Tmax °C |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `acsr-4-0-penguin` | 4/0 ACSR Penguin | 0.445 | 0.0085 | 0.563 | 340 | 100 |
| `acsr-336-linnet` | 336.4 kcmil ACSR Linnet | 0.306 | 0.0244 | 0.721 | 530 | 100 |
| `acsr-477-hawk` | 477 kcmil ACSR Hawk | 0.216 | 0.0287 | 0.858 | 660 | 100 |
| `acsr-795-drake` | 795 kcmil ACSR Drake | 0.128 | 0.0375 | 1.108 | 900 | 100 |
| `acsr-1590-falcon` | 1590 kcmil ACSR Falcon | 0.0645 | 0.0522 | 1.545 | 1200 | 100 |
| `aaac-500` | 500 kcmil AAAC | 0.214 | 0.0308 | 0.858 | 640 | 90 |

Ampacities are screening values at 75 °C conductor, 40 °C ambient, 0.61 m/s
wind. They are not a substitute for the utility's as-built schedule.

Impedance per mile:

```
R = R25 / (circuits · bundle)                              [Ω/mi]
GMR_bundle = (GMR · d^(bundle−1))^(1/bundle)                [ft]
GMD = D                          (equilateral)
GMD = 1.26 · D                   (flat)
X = 0.2794 · log10(GMD / GMR_bundle) / circuits             [Ω/mi at 60 Hz]
Z = (R + jX) · length_mi
```

`0.2794 = 2π · 60 · (unit conversion)` for feet and miles. Default phase
spacing: 6 ft below 35 kV, 12 ft below 100 kV, 20 ft below 200 kV, 25 ft below
300 kV, otherwise 35 ft.

Thermal rating:

```
S_rating = √3 · V_LL · ampacity · circuits · bundle / 1000   [MVA]
ambient correction = √clamp((Tmax − Tamb) / (Tmax − 40), 0.25, 1.25)
S_rating *= ambient correction
```

An explicit `branch.rating_mva` overrides the ampacity-derived rating.

---

## 5. Radial power flow (`radialPowerFlow`)

Balanced backward-forward sweep for a tree:

```
base: S_base = options.s_base_mva ?? max(1, 1.5 · ΣP_load)
      Z_base = V_LL² / S_base

at each bus i:
  ZIP scale  z_i = cp + cc·|V_i| + ci·|V_i|²
  net load   S_i = (P_load·z_i − P_der) + j(Q_load·z_i − Q_der)
  injection  I_i = conj(S_i / V_i)              [pu]

backward (leaves → root):
  I_branch = I_child + Σ I_downstream

forward (root → leaves):
  V_child = V_parent − Z_branch · I_branch

repeat until max |ΔV| < tolerance (default 1e-9 pu, max 100 iterations)
```

After convergence, for each branch:

```
flow_pu   = V_from · conj(I_branch)
flow_MVA  = |flow_pu| · S_base
loss_pu   = |I_branch|² · Z_branch
loss_MW   = Re(loss_pu) · S_base
loss_Mvar = Im(loss_pu) · S_base
I_A       = |I_branch| · S_base / (√3 · V_LL) · 1000
loading % = flow_MVA / S_rating · 100
drop %    = (|V_from| − |V_to|) / |V_from| · 100
```

The slack bus is held at 1.0 pu. Source impedance is used only for
short-circuit strength; adding it to the sweep would double-count the slack.

If the sweep does not converge, `converged = false` and the last iterate is
returned. Callers must treat that as voltage collapse, not as a valid operating
point. The municipality engine counts it as both a violation hour and an
infeasible hour.

---

## 6. Exact two-bus solution (`solveTwoBus`)

For a constant-power load `S = P + jQ` behind `Z = R + jX`, with the receiving
end as angle reference:

```
a = R·P + X·Q
b = X·P − R·Q

V_s = V_r + (a + jb) / V_r
|V_s|² = V_r² + 2a + (a² + b²)/V_r²
```

With `|V_s| = 1 pu` and `u = V_r²`:

```
u² + (2a − 1)u + (a² + b²) = 0
u = [(1 − 2a) + √((1 − 2a)² − 4(a² + b²))] / 2     (high-voltage root)
```

`feasible = false` when the discriminant is negative (past the P-V nose).

Losses and current:

```
I_pu = |S_pu| / V_r
P_loss = I_pu² · R_pu · S_base
Q_loss = I_pu² · X_pu · S_base
I_A = |S| / (√3 · V_r · V_LL) · 1000
```

Nose of the P-V curve (discriminant = 0):

```
a_nose = 1/4 − b²
V_critical = √((1 − 2·a_nose) / 2)
```

The per-unit base cancels out of `a` and `b`; any consistent base gives the same
physical voltage. This is why the solver can choose `S_base = max(1, |S|)`
without changing the answer.

`voltageCollapseMargin` scales the load by `λ`, binary-searches the largest
feasible `λ`, and reports:

```
margin % = 100 · (1 − 1/λ_max)
```

If no nose is found inside the scan window it reports the window limit rather
than inventing a bound.

---

## 7. Short circuit and hosting capacity

Three-phase bolted fault at a bus:

```
Z_cum = Z_source + Σ Z_branch(slack → bus)       [pu]
I_pu  = 1 / |Z_cum|
I_kA  = I_pu · S_base / (√3 · V_LL)
MVA_f = √3 · V_LL · I_kA
SCR   = MVA_f / load_MW
```

`sourceImpedanceFromScr(scr, xOverR)` converts a source SCR into `R + jX`.
This is a planning screen; protection studies need sequence networks,
transformer connections and breaker duty.

DER hosting capacity binary-searches the largest single-bus injection that keeps
`V_min`, `V_max`, branch loading and reverse flow inside limits. It uses a full
converged power flow each step, not a linear hosting curve.

---

## 8. Transformer thermal model (`thermal.ts`)

IEEE C57.91 screening form. Inputs are the transformer spec; the state carries
top-oil temperature, hot-spot temperature and equivalent aging years.

```
K = load_MVA / rating_MVA
R = load_loss_pct / no_load_loss_pct          (≥ 1)

Δθ_TO,ult = Δθ_TO,R · ((K²R + 1)/(R + 1))^n
Δθ_HS,ult = Δθ_HS,R · K^(2m)

θ_TO(t+dt) = θ_TO(t) + (T_amb + Δθ_TO,ult − θ_TO(t)) · (1 − e^(−dt/τ_oil))
θ_HS       = θ_TO + Δθ_HS,ult                 (winding treated as quasi-steady)
```

Cooling exponents:

| class | n | m |
| --- | ---: | ---: |
| ONAN | 0.8 | 0.8 |
| ONAF | 0.9 | 0.8 |
| OFAF | 1.0 | 0.8 |
| ODAF | 1.0 | 0.8 |

Insulation aging (Arrhenius, 110 °C reference):

```
F_aging = exp(15000/383 − 15000/(θ_HS + 273.15))
equivalent_aging_years += F_aging · dt_hours / 8760
loss_of_life % = equivalent_aging_years / design_life_years · 100
remaining_life = max(0, design_life_years − equivalent_aging_years)
```

`15000/383` is the 110 °C reference in kelvin (383 K, as used by the standard
screening constant). At exactly 110 °C the aging factor is 1.0.

Thermal bands:

| band | condition |
| --- | --- |
| `critical` | hot-spot ≥ 140 °C or top-oil ≥ 110 °C |
| `high` | hot-spot ≥ 120 °C or top-oil ≥ 100 °C |
| `watch` | hot-spot ≥ 110 °C or top-oil ≥ 90 °C |
| `ok` | otherwise |

Defaults: 8 % impedance, 0.2 % no-load loss, 0.8 % load loss, ONAN,
55 K top-oil rise, 23 K hot-spot rise, 180 min oil time constant, 4 min winding
time constant, 35-year design life.

---

## 9. Conductor heat balance (`thermal.ts`)

Steady state:

```
I²·R(T_c) + q_s = q_c + q_r

R(T) = R25 · (1 + α·(T − 25)) / 1609.344          [Ω/m]
q_c  = π·D·h·(T_c − T_amb),  h = 5.7 + 3.8·v      [W/m]
q_r  = π·D·ε·σ·(K(T_c)⁴ − K(T_amb)⁴)
q_s  = α_s·G·D
D = diameter_in · 0.0254                           [m]
σ = 5.670374419e-8 W/(m²·K⁴)
```

Defaults `α_s = ε = 0.5`. The temperature is found by bisection on
`[T_amb, 300 °C]`; if the heat balance is still positive at 300 °C the result is
flagged `runaway`.

Ampacity at `T_max`:

```
I_max = √((q_c + q_r − q_s) / R(T_max))
```

Sag-risk bands are `T_c/T_max`: `< 0.82 ok`, `≥ 0.82 watch`, `≥ 0.92 high`,
`≥ 1.0 critical`. Actual sag needs span, tension and creep data.

This is a screening form of IEEE 738, not the full forced-convection
correlation. It errs toward a warmer conductor in low wind.

---

## 10. Frequency dynamics (`dynamics.ts`)

Single aggregated control area. Stored kinetic energy:

```
E_inertia = Σ H_i · MVA_i                  [MW·s]
H_sys     = E_inertia / Σ MVA_i            [s]
```

Default `H` (MW·s/MVA): gas CC 6, gas steam 5, hydro 3, nuclear 6, other 4;
wind, solar and battery 0 unless synthetic inertia is explicitly specified.

Initial ROCOF after loss of infeed:

```
ROCOF = −ΔP / (2 · E_inertia) · f₀        [Hz/s], f₀ = 60
```

Swing equation integrated with explicit Euler at `dt` (default 0.01 s, clamped
0.001–0.1 s):

```
2H · dΔf/dt = −ΔP + P_gov + P_ffr + P_shed − D·Δf
```

All powers are per-unit on the system MVA base; `D` defaults to 1 pu/pu.
Responses are first-order lags toward droop targets:

```
P_gov,target = clamp(−Δf / droop, 0, reserve_MW / S_sys)
P_ffr,target = clamp(bess_gain · (−Δf) · f₀ / S_sys, 0, bess_MW / S_sys)

P_gov += (P_gov,target − P_gov)·(1 − e^(−dt/τ_gov))
P_ffr += (P_ffr,target − P_ffr)·(1 − e^(−dt/τ_ffr))
```

Defaults: 5 % droop, 2.5 s governor lag, 10 % governor reserve, 0.2 s battery
lag, battery gain = full output at 0.5 Hz.

UFLS stages latch in descending frequency order. Default ladder is 10 % of
served load at 59.3, 58.9 and 58.5 Hz.

Long-run frequency:

```
Δf_ss = −(ΔP/S_sys) / (D + min(1/droop, reserve/S_sys))
f_ss  = f₀ · (1 + Δf_ss)
```

Stability bands and score:

| screen | ok | watch | high | critical |
| --- | --- | --- | --- | --- |
| `|ROCOF|` Hz/s | < 0.5 | ≥ 0.5 | ≥ 1.0 | ≥ 1.5 |
| nadir Hz | ≥ 59.0 | < 59.0 | < 58.0 | < 57.0 |
| `H_sys` s | ≥ 4.0 | < 4.0 | < 2.5 | < 1.5 |
| SCR | ≥ 5 | < 5 | < 3 | < 2 |

`score = 100 · Σ(weight · band_rank) / (3 · Σweight)` with weights
ROCOF 0.3, nadir 0.3, inertia 0.2, stiffness 0.2. `binding` names the worst
screen. The score is a screening index, not a probability of blackout.

---

## 11. Load and weather (`load.ts`)

### Sector shape

Six 24-hour shapes (`residential`, `commercial`, `industrial`, `municipal`,
`data_center`, `agricultural`) normalized so the maximum is 1.0.

```
P(hour) = peak_MW · shape(hour) · weatherMultiplier(T_amb)
Q       = P · tan(acos(pf))
```

### Weather sensitivity

```
cooling = clamp((T_amb − T_bal,c) / (T_des,c − T_bal,c), 0, 1.8)
heating = clamp((T_bal,h − T_amb) / (T_bal,h − T_des,h), 0, 1.8)
mult    = clamp(1 + hvac_share · (cooling + heating − 1), 0.15, 2.5)
```

Defaults: cooling balance 18 °C / design 38 °C; heating balance 15 °C / design
2 °C. `SECTOR_HVAC_SHARE` defaults: residential 0.45, commercial 0.40,
industrial 0.15, municipal 0.30, data center 0.06, agricultural 0.20.

Annual energy is the hour-by-hour sum of `P`.

### Solar geometry and PV

```
declination δ = 23.45° · sin(2π(284 + n)/365)
hour angle ω = 15° · (solar_hour − 12)
sin(alt) = sinφ sinδ + cosφ cosδ cosω
cos(az)  = (sinδ − sin(alt) sinφ) / (cos(alt) cosφ), flipped west of noon
AM       = 1 / sin(alt)
GHI_clear = 1367 · sin(alt) · 0.7^(AM^0.678)
```

Erbs diffuse fraction splits GHI into DHI and DNI, then isotropic sky:

```
DNI = (GHI − DHI) / sin(alt)
cosθ = sin(alt)cosβ + cos(alt)sinβ·cos(γ_sun − γ_panel)
POA = DNI·max(0, cosθ) + DHI·(1 + cosβ)/2 + GHI·ρ·(1 − cosβ)/2
```

PV cell and output:

```
T_cell = T_amb + (NOCT − 20)/800 · POA
DC = capacity_DC · (POA/1000) · (1 + γ·(T_cell − 25)) · (1 − soiling)
AC = min(capacity_DC / DC_AC_ratio, DC · η_inverter)
```

Defaults: DC/AC 1.25, tilt 25°, azimuth 180° (south), γ = −0.0035/°C, NOCT
45 °C, soiling 2 %, inverter 97 %, albedo 0.2. `clipping` is true when the
unclipped AC output exceeds the inverter rating.

### Wind

Cubic between cut-in and rated, flat between rated and cut-out:

```
0                                      v < cut_in
0                                      v ≥ cut_out
capacity                               cut_in ≤ rated ≤ v < cut_out
capacity · (v³ − v_in³)/(v_rated³ − v_in³)   otherwise
```

Defaults: cut-in 3 m/s, rated 12 m/s, cut-out 25 m/s.

### Battery

```
η_oneway = √(η_round_trip)
max_discharge = min(P, max(0, (SOC − SOC_min)·η_oneway)/dt)
max_charge    = min(P, max(0, SOC_max − SOC)/(η_oneway·dt))
actual        = clamp(request, −max_charge, max_discharge)
SOC_next      = SOC − actual·dt/η_oneway          (actual ≥ 0)
SOC_next      = SOC + |actual|·η_oneway·dt        (actual < 0)
```

Defaults: 88 % round trip, SOC 10–95 %, initial 50 %. Dispatch hours are a
scenario input; the default is discharge 17–21 and charge 9–15.

### Weather scenarios

If `weather.hourly` is supplied, it wins and must cover
`start_hour + hours`. A 24-hour request uses a synthetic design day; a longer
request uses a synthetic 8760-hour year:

```
seasonal = annual_amplitude · cos(2π(day − 200)/365)
diurnal  = diurnal_amplitude · sin(2π(hour − 9)/24)
T_amb    = annual_mean + seasonal + diurnal
wind     = wind_mean + wind_amplitude · sin(2π(day + hour/24 − 40)/365)
GHI      = clear_sky_GHI(lat, day, hour) · clearness
```

This is deterministic and data-free, not a TMY file. Supplying `hourly` is the
path to historical or forecast weather.

---

## 12. Economics (`economics.ts`)

All values are nominal dollars, deterministic, no tax or financing model.

```
CRF(r,n) = r(1+r)^n / ((1+r)^n − 1),   CRF(0,n) = 1/n
LCOE     = (CRF·capex + annual O&M) / annual MWh
NPV      = Σ_t cashflow_t / (1+r)^t
IRR      = r where NPV(r) = 0 (bisection)
payback  = capex / annual savings
```

Cost helpers:

```
loss cost       = loss_MWh · loss_value_$/MWh
unserved cost   = unserved_MWh · VOLL_$/MWh
carbon cost     = tonnes · carbon_price_$/t
municipal LCOE  = (annual supply cost + CRF·grid capex) / delivered MWh
cost per MW     = interconnection capex / added peak MW
capacity value  = firm MW · (1 + reserve margin) · $/MW-year
```

Defaults: 7 % discount, 25 years, $145/MWh energy, $145/MWh losses, $12,000/MWh
VOLL, $51/t CO₂, 2 % O&M escalation, 2.5 % energy escalation.

---

## 13. Municipality engine (`municipality.ts`)

### 13.1 Input contract

`MunicipalityScenario` contains:

- `substation`: HV/LV, transformer spec, optional source short-circuit MVA.
- `feeders[]`: slack bus, buses, branches, loads, solar, wind, batteries,
  customer counts, optional phase split.
- `buildouts[]`: project kind, feeder, parent bus, optional `new_bus`
  (connection miles, conductor, circuits, phase spacing), peak MW, power
  factor, sector, energize year, capex, O&M, optional DER.
- `weather`: synthetic parameters or an explicit hourly series.
- `grid_carbon_intensity_gco2_kwh`, optional energy price and economics.
- optional `generation[]` inertia fleet, `source_mix`, `ffr_mw`, reliability
  assumptions, battery dispatch.

`SimulationOptions`:

| option | meaning |
| --- | --- |
| `hours` | 24 for design day, 8760 for annual (default 8760) |
| `start_hour` | offset into the weather series |
| `year` | buildout year filter (default `base_year`) |
| `include_buildouts` | default true |
| `compare_baseline` | run the no-buildout case, default true |
| `voltage_min_pu` / `voltage_max_pu` | default 0.95 / 1.05 |
| `record_hourly` | include `hourly[]` in the result |
| `compute_hosting` | default true; set false for fast design-day runs |

### 13.2 Topology build

`buildMunicipality(scenario, year, includeBuildouts)`:

1. Keep projects with `energize_year <= year` when buildouts are included.
2. Copy each feeder's buses, branches, loads and DER lists.
3. For an active project with `new_bus`, create the bus and a branch from the
   project's tap bus. The branch id is `bo-<project.id>`; the conductor,
   circuits and phase spacing come from `new_bus`.
4. Attach the project load and optional solar/wind/battery to the new bus (or
   the existing tap bus).
5. Set feeder base `S_base = max(1, 1.5 · total_peak_MW)`.
6. Compute path miles from the slack to every bus by BFS; reliability uses them.

A 2026 study and a 2032 study therefore have genuinely different trees, not
just different load multipliers.

### 13.3 Hourly loop

For each hour:

1. Resolve each load (`loadAt`), solar (`solarAt`), wind (`windPower`) and
   battery step (`bessStep`).
2. Run `radialPowerFlow` on each feeder at its fixed `S_base`.
3. Accumulate feeder load, losses, peak load, min/max voltage, max branch
   loading, violation hours, infeasible hours, overloaded-branch hours and
   per-bus annual energy.
4. Sum slack MW/Mvar across feeders, step the substation transformer thermal
   state by one hour, and update peak thermal values.
5. Accumulate total load, losses, voltage and emissions. Capture the peak-load
   hour (`peak` snapshot) if it is the highest so far.
6. If `record_hourly`, push a row with load, solar, wind, battery, losses,
   minimum voltage, maximum loading and transformer hot-spot.

After the loop, hosting capacity is computed at each feeder's worst bus using
the peak-hour network unless `compute_hosting: false`.

The baseline run (when enabled) rebuilds the same year without buildouts and
runs the same loop. Buildout deltas are therefore modeled, not estimated.

### 13.4 Output statistics — exact definitions

`MunicipalityStats.hours` tells you the window. A 24-hour run reports daily
energy in fields named `annual_*`; the label means "over the simulated window".

| Stat | Definition |
| --- | --- |
| `demand.peak_mw` | max hourly Σ bus load |
| `demand.min_mw` | min hourly Σ bus load |
| `demand.average_mw` | Σ hourly load / hours |
| `demand.load_factor` | average / peak |
| `demand.annual_mwh` | Σ hourly load (MWh over the window) |
| `demand.existing_peak_mw` | baseline peak if modeled, else peak − Σ active buildout peak |
| `demand.buildout_peak_mw` | peak − baseline peak if modeled, else min(peak, Σ active buildout peak) |
| `demand.growth_pct` | (peak − existing) / existing · 100 |
| `voltage.min_pu` / `max_pu` | min/max bus voltage over all feeders and hours |
| `voltage.max_drop_pct` | max(1 − min voltage) · 100 |
| `voltage.violation_hours` | hours where any feeder is nonconverged, outside V limits, or > 100 % loading |
| `voltage.infeasible_hours` | hours where any power flow did not converge |
| `voltage.unbalance_pct` | load-weighted max phase deviation from ⅓ over buses that declare `phase_split`; undeclared buses are balanced (0 deviation) |
| `losses.annual_mwh` | Σ hourly conductor losses |
| `losses.pct` | losses / delivered load · 100 |
| `losses.peak_mw` | max hourly losses |
| `losses.cost_usd` | losses · loss value |
| `reliability.saidi_min` | Σ λ·repair_hours·60·customers / total customers |
| `reliability.saifi` | Σ λ·customers / total customers |
| `reliability.unserved_mwh` | Σ λ·repair_hours·bus_average_MW |
| `reliability.customer_hours` | Σ λ·repair_hours·customers |
| `reliability.worst_bus` | bus with the largest unserved-energy contribution |
| `thermal.transformer_peak_loading_pct` | max hourly |S_slack| / transformer rating · 100 |
| `thermal.transformer_hotspot_max_c` | max hot-spot over the window |
| `thermal.transformer_top_oil_max_c` | max top-oil over the window |
| `thermal.transformer_loss_of_life_pct` | equivalent aging / design life · 100 |
| `thermal.transformer_remaining_life_years` | design life − equivalent aging, floored at 0 |
| `thermal.line_peak_temp_c` | hottest branch conductor at the peak hour |
| `thermal.line_overload_hours` | sum over hours of branches with loading > 100 % |
| `stability.inertia_mws` | Σ H·MVA of online sources |
| `stability.h_sys_s` | inertia / system MVA |
| `stability.synchronous_share_pct` | synchronous MVA / online MVA · 100 |
| `stability.scr` | fault MVA at the substation / peak load |
| `stability.fault_mva` | transformer rating / (Z_source + Z_transformer) |
| `stability.contingency_mw` | clamp(max(1, 0.1·peak, 0.8·largest unit), 1, 0.8·peak) |
| `stability.rocof_hz_s` | initial ROCOF for the contingency |
| `stability.nadir_hz` | minimum simulated frequency |
| `stability.steady_state_hz` | governor/damping steady state |
| `stability.ufls_shed_mw` | UFLS load shed during the event |
| `stability.pv_margin_pct` | smallest two-bus P-V margin across feeder worst buses |
| `stability.critical_voltage_pu` | nose voltage for that corridor |
| `stability.score` / `band` / `binding` | combined screen from §10 |
| `emissions.co2_tons` | grid imports · carbon intensity / 1000 |
| `emissions.intensity_gco2_kwh` | CO₂ / delivered load · 1000 |
| `economics.annual_energy_cost_usd` | grid imports · energy price |
| `economics.annual_loss_cost_usd` | losses · loss value |
| `economics.lcoe_usd_mwh` | (energy cost + O&M + CRF·buildout capex) / delivered MWh |
| `economics.buildout_capex_usd` | Σ active project capex |
| `economics.annual_om_usd` | Σ active project O&M |
| `economics.cost_per_added_mw` | buildout capex / max(0.1, peak − existing peak) |
| `economics.annual_unserved_cost_usd` | unserved MWh · VOLL |
| `capacity.substation_mva` | transformer rating |
| `capacity.peak_loading_pct` | transformer peak loading |
| `capacity.headroom_mw` | max(0, 0.95·rating − peak) |
| `capacity.hosting_capacity_mw` | Σ feeder worst-bus DER hosting capacity |
| `feeders[].loss_pct` | feeder losses / feeder delivered energy · 100 |
| `feeders[].worst_bus` | lowest-voltage bus at the last hour evaluated |

Reliability:

```
λ_bus = failure_rate_per_mi_year · path_miles · permanent_fault_fraction
```

Defaults: 0.12 failures/mi-year, 4.5 h repair, 70 % permanent, targets
SAIDI 120 min and SAIFI 1.5.

Buildout row (`BuildoutStats`):

| Field | Definition |
| --- | --- |
| `status` | `active` when the project is in `built.activeBuildouts`, else `planned` |
| `peak_mw` | modeled peak for active projects, nameplate for planned |
| `annual_mwh` | project load integrated over the simulated weather window |
| `capex_usd`, `annual_om_usd` | project inputs |
| `cost_per_added_mw` | capex / max(0.1, project peak) |
| `connection_miles` | `new_bus.connection_length_mi` or 0 |
| `voltage_impact_pu` | modeled peak bus voltage (with buildout) − baseline peak bus voltage |
| `feeder_loading_impact_pct` | modeled feeder max loading − baseline feeder max loading |

The peak snapshot (`MunicipalityResult.peak`) contains the peak hour index,
ambient temperature, load, min/max voltage, max branch loading, transformer
loading, per-feeder voltage range, per-bus voltage and per-bus load.

### 13.5 Identifiers

- Branch ids must be unique within a feeder. Buildout branches use
  `bo-<project.id>`.
- Bus ids must be unique **across all feeders** because the peak snapshot and
  buildout deltas index buses by id. This is a UI contract, not a physics
  requirement of `radialPowerFlow`.
- Buildout bus ids must not collide with existing buses; the builder throws.

---

## 14. Verification

```
npm run verify:physics
```

`scripts/verify-physics.ts` runs 61 numeric assertions and exits non-zero on a
disagreement. Coverage:

1. Per-unit `Z_base`, `I_base`, three-phase current.
2. Conductor R, X, Z_pu against the printed formula.
3. Exact two-bus voltage and current.
4. Radial sweep against the exact two-bus solution; losses `I²R`; slack
   balance.
5. P-V margin and hosting-capacity bounds.
6. Transformer rated rises, load scaling, conductor heat balance.
7. ROCOF, inertia, synchronous share.
8. Load weather multiplier, P and Q; PV clipping and cell temperature; wind
   curve; battery SOC.
9. CRF, LCOE, NPV, IRR, payback.
10. End-to-end 24-hour municipality run, planned vs active buildout, baseline
    delta, stability band, finite-value tree.
11. End-to-end 8760-hour run with calibration and hosting capacity.

Expected values are derived from the formulas, not rounded display values.
Tolerances are documented in the assertions.

Run the type checker with:

```
npm run typecheck
```

The physics modules are clean under `strict: true`. The repository still has
pre-existing unrelated errors in `components/evidence/EvidenceProvider.tsx`,
`components/shell/MapCanvas.tsx`, `components/shell/Workspace.tsx`,
`lib/grid.ts` and `lib/gridAssets.ts`; they are not caused by this layer.

---

## 15. Screening limitations (contractual honesty)

These are deliberate boundaries, not hidden assumptions:

1. **Balanced positive sequence only.** No unbalanced phase load flow,
   harmonics, electromagnetic transients, or negative/zero sequence.
   `unbalance_pct` is a declared A/B/C split screen, not a solved unbalanced
   network.
2. **Radial only.** Meshed networks throw. A loop must be opened or modeled as
   a separate study.
3. **One voltage base per radial network.** Transformer between voltage levels
   is aggregated at the substation slack, not solved as a branch.
4. **Quasi-static.** Each hour is a steady state. No electro-mechanical
   transient inside the power flow; frequency is a separate aggregated swing
   study.
5. **Constant-power / ZIP loads.** Induction motors, protection, and voltage
   collapse dynamics are not modeled beyond the P-V nose screen.
6. **Screening conductor library.** Ampacity is not the utility's as-built
   rating; explicit `rating_mva` should be supplied when known.
7. **Conductor heat balance is a screening form of IEEE 738.** It does not
   implement the full forced-convection correlation or span sag.
8. **Transformer thermal is a single-duplicate C57.91 screen.** No top-oil
   harmonic, pump/fan staging, DGA, or ambient forecast.
9. **Frequency is one aggregated control area.** No inter-area modes, no
   inverter control interactions, no governor deadband or boiler dynamics.
10. **Synthetic weather is deterministic, not TMY.** Supply `hourly` for
    historical or forecast weather.
11. **Solar is isotropic-sky, no shading or snow.** Wind is a cubic curve, no
    wake or availability model.
12. **Reliability is a failure-rate screen.** No switching, reclosing,
    protection coordination, or restoration optimization.
13. **Economics is a deterministic screening model.** Nominal dollars, no tax,
    financing, depreciation, or incentives.
14. **Hosting capacity is single-bus and evaluated at the worst bus.** It is
    not a simultaneous multi-DER optimization.
15. **`annual_*` names describe the simulated window.** A 24-hour run yields
    daily energy in those fields; read `stats.hours` before comparing runs.
16. **Peak snapshot is the highest-load hour,** not necessarily the highest
    stress hour. Voltage/thermal extremes may occur at another hour and are
    captured in the min/max accumulators.

---

## 16. How the ETL session should consume this

Recommended table shape (one row per entity, ids preserved):

```
municipalities(id, name, state, population, base_year, latitude_deg,
               grid_carbon_intensity_gco2_kwh, grid_energy_price_usd_per_mwh)
substations(id, municipality_id, hv_kv, lv_kv, transformer_id, source_sc_mva)
transformers(id, rating_mva, impedance_pct, no_load_loss_pct, load_loss_pct,
             cooling, rated_top_oil_rise_k, rated_hotspot_rise_k,
             tau_oil_min, tau_winding_min, design_life_years)
feeders(id, municipality_id, name, voltage_kv, slack_bus_id)
buses(id, feeder_id, name, base_kv, customers, phase_a, phase_b, phase_c)
branches(id, feeder_id, from_bus, to_bus, voltage_kv, length_mi, conductor,
         circuits, bundle_count, phase_spacing_ft, arrangement, rating_mva)
loads(id, bus_id, sector, peak_mw, power_factor, hvac_share,
      cooling_balance_c, cooling_design_c, heating_balance_c, heating_design_c,
      annual_mwh)
solar(id, bus_id, capacity_mw_dc, dc_ac_ratio, tilt_deg, azimuth_deg,
      temp_coeff_per_c, noct_c, soiling_loss_pct, inverter_eff)
wind(id, bus_id, capacity_mw, cut_in_mps, rated_mps, cut_out_mps)
batteries(id, bus_id, power_mw, energy_mwh, round_trip_eff,
          soc_min_pct, soc_max_pct, initial_soc_pct)
buildouts(id, name, kind, feeder_id, bus_id, new_bus_id, peak_mw,
          power_factor, sector, energize_year, capex_usd, annual_om_usd)
weather_hourly(municipality_id, hour_index, ambient_c, wind_mps, solar_w_m2)
```

Mapping rules:

- `branches.from_bus` / `to_bus` are symmetric for the solver; direction is
  inferred from the slack.
- `loads.annual_mwh`, when present, is used only on full-year runs to scale
  the peak so simulated annual energy matches the source.
- `buildouts.new_bus_id` points at a `buses` row with a
  `connection_length_mi`; if absent, the load attaches to `bus_id`.
- Keep bus ids globally unique.
- Keep each feeder a tree. Validate with `buildMunicipality`/`radialPowerFlow`
  during ETL; a cycle throws immediately.
- Pass the same `weather_hourly` slice to both the buildout and baseline runs
  so deltas are apples-to-apples.
- Persist `stats`, the optional `hourly[]`, and `peak` separately; `stats` is
  the dashboard contract, `hourly[]` is the time-series contract.

Minimal call:

```ts
import { runMunicipality, type MunicipalityScenario } from "@/lib/physics";

const scenario: MunicipalityScenario = buildScenarioFromEtlRows(rows);

const designDay = runMunicipality(scenario, {
  hours: 24,
  year: 2030,
  record_hourly: true,
  compute_hosting: false,
});

const annual = runMunicipality(scenario, {
  hours: 8760,
  year: 2030,
  compare_baseline: true,
});
```

Design-day runs are for the live view (fast, 24 power flows). Annual runs are
for planning and include weather calibration and hosting capacity. Both return
the same `MunicipalityStats` shape, so the UI does not branch on mode; it reads
`stats.hours`.

---

## 17. Formula provenance and calibration

| Model | Basis |
| --- | --- |
| Per-unit and three-phase current | standard symmetrical-component / per-unit practice |
| Conductor R, X | published conductor tables; geometric reactance formula at 60 Hz |
| Radial sweep | backward-forward distribution load flow for a tree |
| Two-bus and P-V nose | exact constant-power quadratic, no small-angle approximation |
| Transformer thermal and aging | IEEE C57.91 screening clauses 7 and 8 |
| Conductor heat balance | IEEE 738-style steady-state balance, simplified convection |
| Frequency | swing equation with aggregated droop, FFR and UFLS |
| Solar | NOAA-style position, Meinel clear sky, Erbs diffuse split, isotropic POA |
| Wind | standard cubic turbine curve |
| Economics | CRF, LCOE, NPV, IRR, simple/discounted payback |
| Reliability | failure-rate × path-miles screen (SAIDI/SAIFI form) |

Every constant that is a convention rather than a physical law is exposed in
the scenario or in a `DEFAULT_*` object. Nothing is fitted to a specific city;
the model is calibrated by the inputs the ETL supplies.
