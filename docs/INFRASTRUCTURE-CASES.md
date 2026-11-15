# GridSentinel infrastructure owner cases

Worked cases for infrastructure owners. Values marked **synthetic** are scenario inputs, not reported project facts or estimates. Dates are scenario dates. Each case follows the portfolio, delivery, disruption, operations, and retirement logic in [Infrastructure Lifecycle](INFRASTRUCTURE-LIFECYCLE.md).

## Westminster critical-facility microgrid

**Status and baseline.** Conditional Westminster, California scenario; all facility loads, costs, dates, and performance values below are synthetic. Assume a municipal emergency operations facility with 500 kW peak demand, 2.4 GWh annual use, and 48-hour critical-load requirement of 300 kW average (14.4 MWh). Existing service has no islanding capability. The City’s Development Engineering page establishes the local engineering/development review context, but does not establish this facility, project scope, or approval path: [Westminster Public Works—Engineering Division](https://www.westminster-ca.gov/departments/public-works/engineering-division/development-engineering). SCE’s Solar Billing Plan and business interconnection/backup-system pages are relevant utility program and interconnection references only; applicability, eligibility, export treatment, equipment rules, and timing must be confirmed for this customer and design: [Solar Billing Plan](https://www.sce.com/factsheet/solar-billing-plan), [Grid interconnections and backup systems](https://www.sce.com/business/smart-energy-solar/solar-for-business/grid-interconnections/backup-systems).

**Actors.** City facilities owner; emergency management operator; City engineering/building reviewers; SCE; microgrid designer/EPC; battery and inverter vendors; fire authority; commissioning agent.

**Options (synthetic screening, 2026 USD).**

| Option | Scope | Capital | Critical-load duration | Annual grid energy / emissions proxy* | Main tradeoff |
|---|---|---:|---:|---:|---|
| A | 500 kW / 1 MWh battery, controls, no new generation | $2.4M | ~3 h at 300 kW | 2.4 GWh / 900 tCO2e | Lowest first cost; short outage cover |
| B | 400 kW PV, 1 MW / 4 MWh battery, islanding and controls | $6.8M | ~12 h battery-only; longer with solar | 1.65 GWh / 620 tCO2e | Balanced resilience and bill impact; weather-dependent |
| C | 400 kW PV, 1 MW / 8 MWh battery, islanding, critical-load transfer | $9.6M | ~24 h battery-only; target 48 h with load shedding and solar | 1.45 GWh / 540 tCO2e | Highest resilience; space, cost, and replacement burden |

*Illustrative constant emissions factor 0.375 kg/kWh; not a utility forecast. Sensitivity: at 0.25/0.50 kg/kWh, B’s proxy is 413/825 tCO2e; a 20% battery cost increase adds about $0.5M to B and $0.8M to C. A 20% lower solar yield reduces annual PV production by roughly 70 MWh and worsens economics; it does not change battery-only duration. If critical load rises 25%, 8 MWh runtime falls from 24 h to about 19 h before losses/reserve. Select C only if a validated 48-hour emergency load profile and outage-value case justify incremental cost.

**Dependencies, funding, approvals, evidence.** Scenario sequence: Jan 15, 2027 load logging and critical-load audit; Mar 1, geotechnical/roof and fire access review; Apr 15, utility pre-application/interconnection study; Jun 1, funding award and council appropriation; Aug 1, 2027 design package; Oct 1, permits and utility agreement; Mar 1, 2028 equipment delivery; Jun 1, commissioning. Candidate funding is synthetic City capital plus a competitive resilience/energy grant; no award is assumed. Evidence gate: interval-meter data, one-line diagram, protected circuit list, outage duration assumptions, structural/fire basis, tariff interval data, utility written interconnection requirements, cost quote, and signed funding notice. City and utility review labels above are planning assumptions, not confirmed Westminster process commitments.

**Disruption and gate movement.** Assume switchgear lead time slips 16 weeks on May 1, 2028. Energization moves Jun 1 → Sep 21, 2028; acceptance and emergency exercise move Jun 15 → Oct 5. Impacted gates: utility witness test, islanding test, 48-hour operational exercise, grant closeout. Temporary diesel rental is a contingency only, not counted as permanent resilience; require fuel, emissions, and permitting review before use.

**Operations and end of life.** Facilities team owns monthly visual/alarms checks; vendor performs quarterly controls review and annual islanding test; emergency management runs annual load-shed exercise. Record availability, kWh shifted, runtime, failed starts, and maintenance. Budget inverter/control renewal at year 12 and battery replacement at year 12–15, subject to warranted usable capacity and cycle data. At retirement, isolate/verify zero energy, reuse only after safety/condition review, route batteries through permitted recycling, and retire utility interconnection and fire records.

**Verifiable expected results.** Acceptance test demonstrates black start, transfer, stable 300 kW critical bus, and 24-hour battery-only run for C (or measured tested runtime against selected design); annual exercise plus irradiance and load logs supports the 48-hour solar-plus-load-shed target. Metered annual grid import target for B is ≤1.65 GWh under stated baseline/weather assumptions. Publish variance against baseline and retain test logs; do not claim 48 hours from nameplate capacity alone.

## Synthetic substation expansion

**Baseline.** Synthetic distribution substation serving 18,000 accounts; 24 MW summer peak against 30 MVA firm capacity (80% loading), 2.0% annual peak growth, one transformer contingency capable of 15 MW. Planning trigger is firm capacity reaching 90% in 2029. All authority, tariff, and cost assumptions are synthetic.

**Actors.** Utility asset owner/planner; system operator; regulator; landowner; environmental/permitting agencies; equipment suppliers; communities; interconnecting generators and large loads.

**Options (synthetic).** A: transformer replacement/addition, $18M, +20 MVA in 2029; B: reconductor feeders plus 6 MW/24 MWh storage and managed load, $26M, +10 MW firm-equivalent by 2028; C: new 40 MVA substation and two feeders, $52M, +35 MVA in 2030. Base forecast reaches 29 MW in 2030. At 1% growth, A is sufficient through 2034; at 3%, A reaches 90% by 2031 and C’s headroom is preferred. If storage duration falls to 2h or dispatch is unavailable during peak, B contributes only 6 MW for the first peak hours and cannot replace firm capacity. A is lowest cost; C provides strongest N-1 capacity and expansion option; B buys time but adds dispatch and replacement risk.

**Dependencies/evidence.** Synthetic dates: load forecast and contingency study due Feb 1, 2027; land and route control Apr 1; environmental screening Jun 1; regulator filing Sep 1; funding approval Dec 1; long-lead transformer order Jan 15, 2028; construction window May–Nov 2029. Evidence: 15-minute load history, feeder thermal model, fault duty, N-1 study, land title/options, environmental survey, vendor quote, regulator order and funding authorization. Funding assumed utility rate-base subject to approval; not secured.

**Disruption.** Transformer factory test failure discovered Aug 15, 2029 delays delivery 20 weeks. A’s in-service date shifts Oct 1, 2029 → Feb 20, 2030; peak-capacity gate and two planned large-load connections move. Temporary operating limit: defer discretionary load connections and use contracted demand response; quantify customer impact weekly.

**Operations/end-of-life.** Utility dispatch/maintenance owns relay tests, oil/DGA sampling, thermal scans, protection coordination, and annual contingency drills. Track peak loading, forced outages, losses, and feeder SAIDI contribution. Replace protection/control systems at year 15 and transformers based on condition, typically planned around year 40 in this synthetic model. De-energize, drain/handle oil under applicable rules, reclaim/recycle metals, remediate site, and close permits.

**Expected results.** Demonstrate post-project N-1 load serving ≥ forecast peak plus approved reserve; SCADA logs confirm alarms and switching; annual peak loading stays below 90% through 2032 under base growth. Re-run forecast annually; report trigger crossing and connection deferrals.

## Synthetic water main renewal

**Baseline.** Synthetic 8 km, 300 mm ductile-iron trunk; 55 years old; 14 breaks in prior 5 years (1.75 breaks/km-year); 18% non-revenue water in pressure zone; 2,800 customers and hospital branch affected by outage. Pressure 55–80 psi. No local project facts implied.

**Actors.** Water utility owner/operations; street/traffic authority; health regulator; contractor; residents/businesses; hospital; environmental reviewer; funding agency.

**Options (synthetic).** A: spot repair, $1.2M, 2-year delivery, expected 1.2 breaks/km-year; B: line 6 km and replace 2 km, $8M, 3-year delivery, 0.4 breaks/km-year; C: full 8 km replacement with parallel feed and service renewal, $13.5M, 4-year delivery, 0.15 breaks/km-year. At 50% lower break frequency than assumed, B’s avoided repair benefit halves and A may win on 10-year NPV; at 2x breaks, C saves more service interruptions. A has lowest disruption now but leaves high consequence segments; C offers redundancy and longest life but more excavation/capital.

**Dependencies/evidence.** Synthetic gates: CCTV/acoustic leak and condition survey Mar 1, 2027; utility coordination and potholing May 1; design/permit Sep 1; funding decision Nov 15; procurement Jan 15, 2028; hospital bypass test before May 1 construction; disinfection and pressure acceptance by Dec 1, 2029. Funding assumed municipal water capital plus synthetic low-interest loan, contingent on eligibility. Evidence: break records/geocodes, pressure logger data, hydraulic model, pipe material survey, contamination sampling, traffic plan, bid tab, funding commitment, regulator-approved sampling plan.

**Disruption.** Contaminated soil encounter Jul 10, 2028 adds 10 weeks. Segment 2 shutdown moves Aug 1 → Oct 10; hospital bypass gate and surface restoration shift accordingly. Maintain two independent feeds to hospital; issue boil-water notices only if sampling/regulator requires. Log outage minutes and affected accounts.

**Operations/end-of-life.** Utility performs annual valve exercising, flushing, hydrant flow tests, leak survey, and pressure/quality review; maintain GIS as-builts and isolation maps. Track breaks, water loss, pressure excursions, complaints, and service minutes. Renew valves at year 30, pipe at design-life/condition trigger (synthetic 80-year planning life). Retired pipe is cleaned, tested for reuse where permitted, otherwise recycled/disposed under material rules; restore street and close permits.

**Expected results.** Within 24 months of full build, break rate ≤0.25/km-year over rolling 3 years, zone loss ≤12%, hospital minimum pressure ≥40 psi during peak demand. Verify with work orders, meter balance, and pressure loggers; adjust for drought restrictions and customer growth.

## Synthetic wastewater plant upgrade

**Baseline.** Synthetic 20 MGD activated-sludge plant; average flow 15 MGD, peak-month 19 MGD; permit limit 10 mg/L total nitrogen, 1.0 mg/L phosphorus; blower system uses 8.5 GWh/year; single headworks screen train creates a 6-hour bypass exposure during failure.

**Actors.** Utility wastewater owner; plant operator; environmental regulator; electrical utility; engineering consultant; equipment vendors; receiving-water stakeholders; grant/loan administrator.

**Options (synthetic).** A: blower/VFD replacement, $9M, 15% aeration energy reduction, no added process redundancy; B: blower/VFD plus nutrient process retrofit and standby screen, $28M, 25% energy reduction and permit margin; C: B plus sidestream treatment and two-train headworks, $41M, 35% energy reduction and strongest resilience. If influent nitrogen load is 20% below baseline, B’s process capacity is underused and A’s payback improves; at 20% above, C avoids a permit-capacity gap. Energy price ±30% changes energy-savings value ±30%; C reduces operational risk most but has highest lifecycle and operator-training cost.

**Dependencies/evidence.** Synthetic schedule: 12-month influent characterization ends Apr 30, 2027; process pilot Sep 1; regulator concept review Nov 1; funding award Feb 1, 2028; design and electrical study Jun 1; shutdown window May 2029; performance demonstration Sep 1. Funding is synthetic state revolving loan and energy grant, neither awarded. Evidence: daily flow/load lab data, permit history, blower power curves, process model, pilot results, electrical short-circuit study, bypass plan, regulator correspondence, accepted bids.

**Disruption.** Switchgear fault during planned shutdown on May 15, 2029 extends outage 5 weeks. Process startup gate moves Jun 1 → Jul 6 and performance sampling Sep 1 → Oct 15. Maintain temporary aeration, standby generator, and bypass controls; any discharge remains subject to regulator approval and notification.

**Operations/end-of-life.** Certified operators own daily process and effluent checks; maintenance team logs vibration, kWh/MG, sludge age, alarms, and standby tests. Calibrate probes monthly, verify permit samples per approved schedule, exercise standby assets quarterly. Replace drives at year 15 and blowers at year 20–25 by condition. Drain, clean, and characterize retired equipment; recover motors/metals, dispose of process-contact materials under applicable requirements, update permit asset records.

**Expected results.** 12 consecutive months of compliant effluent, 95th-percentile TN ≤8 mg/L and TP ≤0.8 mg/L, specific energy ≤1.7 kWh/1,000 gal at comparable flow/load. Verify lab chain of custody and plant meters; normalize for influent and wet-weather flow.

## Synthetic bridge rehabilitation

**Baseline.** Synthetic 45 m, two-lane bridge; deck condition rating 4/9, superstructure 6/9; 22,000 vehicles/day including 8% heavy vehicles; load posting required within 18 months absent intervention. Detour adds 11 km.

**Actors.** Transport asset owner; bridge engineer; road authority; rail/river operator as applicable; contractor; freight and transit operators; environmental/permitting bodies; emergency services.

**Options (synthetic).** A: patch deck and maintain posting, $2M, 4-year extension; B: deck overlay, bearing/joint replacement and selective strengthening, $9M, 20-year extension; C: full superstructure replacement, $24M, 75-year planning life. At heavy-vehicle share 12% or deterioration 2x forecast, B may need earlier strengthening; C has better whole-life capacity. At 50% lower traffic delay valuation, B’s benefit-cost ranking declines. A minimizes near-term closure but leaves load restriction; C longest life with largest detour and embodied-carbon impact.

**Dependencies/evidence.** Synthetic gates: hands-on inspection and load rating Apr 1, 2027; geotech and utilities Jun 1; environmental clearance Sep 1; funding Dec 1; final design Mar 1, 2028; procurement May 1; closure plan and emergency detour approval before Aug 1 work. Funding assumed local transport capital plus competitive grant. Evidence: inspection photos, load rating, traffic counts, scour assessment, utility locates, cultural/environmental review, detour simulation, signed funding and permit record.

**Disruption.** Hidden girder corrosion found Sep 4, 2028 adds 8 weeks engineering and fabrication. Reopen date moves Nov 1 → Dec 27; bus diversion and freight restriction gates extend. Notify emergency services and publish accessible detour map; retain daily structural monitoring and closure criteria.

**Operations/end-of-life.** Owner performs annual inspection, post-flood/scour inspection, joint drainage cleaning, and load posting review; record condition ratings, closure hours, defects, and repair costs. Plan joint replacement at year 15 and major rehabilitation at year 25–30 under B. Retired steel is recycled after hazardous coating controls; concrete is tested and reused as aggregate where permitted; close waterways and restore approaches.

**Expected results.** Load rating meets legal design vehicle with no posting; deck rating ≥7/9 after acceptance; annual inspection confirms defects within thresholds. Track closure hours ≤2 days/year excluding planned maintenance and update rating after each inspection.

## Synthetic rural fiber build

**Baseline.** Synthetic 120 km rural route; 1,600 premises; only 35% can obtain ≥25/3 Mbps service; 12 public safety/community anchor sites; long-haul backhaul has one 1 Gbps path and 99.0% availability. Last-mile median RTT 45 ms.

**Actors.** Broadband network owner; state/local road and pole authorities; electric utility; tribal/landowners where relevant; ISP/wholesale tenants; construction contractor; funding administrator; anchor institutions.

**Options (synthetic).** A: fixed wireless access plus 10 km fiber backhaul, $7M, 75% premises ≥100/20 Mbps; B: 120 km fiber backbone and 35 km distribution, $18M, 95% premises ≥1 Gbps-ready; C: full fiber to all serviceable premises, $31M, 99% premises serviceable with dual diverse backhaul. If take rate is 35% rather than 60%, B’s revenue coverage deteriorates; at 80% take rate, C’s incremental cost per subscriber improves. A is fastest/lowest cost but spectrum and line-of-sight constrain; B balances coverage and capital; C adds resilience and future capacity but requires more easements and make-ready.

**Dependencies/evidence.** Synthetic dates: route survey and demand validation Feb 1, 2027; pole/road applications Jun 1; easements Sep 1; grant award Dec 1; make-ready complete Apr 1, 2028; construction May–Nov; acceptance and service launch Jan 15, 2029. Funding assumed synthetic broadband grant plus owner match; no award assumed. Evidence: address-level eligibility map, speed tests, route/GIS, pole loading, easement signatures, environmental review, backhaul diversity diagram, grant agreement, fiber OTDR and end-to-end test reports.

**Disruption.** Pole attachment make-ready delayed 14 weeks after a utility inspection on Jun 1, 2028. West route build moves Jul 1 → Oct 7; service launch Jan 15 → Apr 15, 2029; grant milestone and anchor-site service gates move. Stage trenchless/underground segments where permitted; disclose revised coverage dates and avoid counting unserved addresses as passed.

**Operations/end-of-life.** Network owner monitors optical power, packet loss, latency, availability, and repair times continuously; inspect huts quarterly, test backup power monthly, validate route diversity annually. Track ≥99.9% backbone availability target and repair restoration by route. Replace active electronics at year 7–10; fiber passive plant planning life 30–40 years. Retire electronics through certified e-waste channel; abandon or remove cable per permits and landowner agreement; update GIS and grant asset register.

**Expected results.** At acceptance, 95% of target premises are serviceable at ≥1 Gbps-ready fiber path for B; each anchor site passes throughput/latency and failover test. Quarterly address-level availability and speed tests verify results; report subscriptions separately from serviceability.

## Cross-sector coverage matrix

| Sector | Asset families and interventions | Constraints | Model inputs | Objectives | Current case coverage / gap | Pack owner |
|---|---|---|---|---|---|---|
| Electric | Substations, feeders, microgrids, storage, protection; reinforce, island, replace | N-1, interconnection, safety, siting, lead times | Load shapes, faults, outage risk, tariffs, capacity, emissions | Reliability, resilience, cost, emissions | Microgrid + substation worked; distribution-wide coordination gap | Grid |
| Water | Sources, treatment, mains, pumps, tanks; renew, intertie, leak control | Pressure, water quality, easements, drought, shutdown | Breaks, flows, head, loss, quality, asset condition | Safe supply, service continuity, loss, lifecycle cost | Main renewal worked; source/treatment gap | Water |
| Wastewater | Collection, lift stations, treatment, outfall; rehab, expand, nutrient/energy upgrades | Permit limits, wet weather, bypass, process biology | Flow/load, power, permit, condition, receiving water | Compliance, energy, overflow risk, cost | Plant upgrade worked; collection overflow gap | Wastewater |
| Stormwater | Drains, culverts, detention, pumps, green infrastructure; resize, maintain, add storage | Rainfall uncertainty, land, downstream capacity, debris | IDF/rainfall, catchment, runoff, tide, blockage | Flood depth, damage, water quality, cost | Gap: no worked case | Stormwater |
| Transport | Bridges, roads, transit assets, signals; rehab, replace, manage demand | Load limits, traffic windows, detours, environmental permits | Condition, traffic, freight, hazard, travel time | Safety, access, lifecycle cost, emissions | Bridge case worked; network operations gap | Transport |
| Telecom | Fiber, towers, huts, backhaul, power; extend, diversify, harden | Easements, make-ready, coverage, cyber, take rate | Premises, demand, route, latency, availability, cost | Coverage, resilience, affordability, capacity | Rural fiber worked; cyber and wireless gap | Telecom |
| Gas and district energy | Mains, regulators, plants, thermal loops; leak repair, renew, convert, interconnect | Safety, emissions, thermal losses, customer transition | Pressure/temp, demand, leaks, condition, carbon | Safety, continuity, decarbonization, cost | Gap: no worked case; transition pathway needed | Energy |
| Buildings | Civic, housing, schools, hospitals; retrofit, electrify, harden, renew | Occupancy, codes, envelope, indoor air, decanting | EUI, peak load, condition, occupancy, hazards | Comfort, health, energy, resilience, cost | Critical facility microgrid touches building interface; retrofit gap | Buildings |
| Waste | Collection, transfer, landfill, organics; fleet, diversion, gas capture | Routes, contracts, contamination, methane, siting | Tonnage, composition, routes, emissions, capacity | Diversion, methane, service, cost | Gap: no worked case | Waste |
| Flood/coastal | Levees, seawalls, dunes, pumps, wetlands; elevate, defend, retreat, restore | Sea-level/rain uncertainty, habitat, equity, residual risk | Hazards, elevation, exposure, fragility, recovery | Risk reduction, access, habitat, lifecycle cost | Gap: no worked case; include managed retreat/compound risk | Resilience |

Portfolio owners should treat each case as a model input contract: preserve baseline date and units, option assumptions, sensitivity ranges, evidence provenance, gate dates, operating obligations, replacement reserve, and retirement condition. Central lifecycle definitions and stage gates live in [INFRASTRUCTURE-LIFECYCLE.md](INFRASTRUCTURE-LIFECYCLE.md).
