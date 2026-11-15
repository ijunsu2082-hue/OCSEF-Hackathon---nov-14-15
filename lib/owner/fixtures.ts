/**
 * Six owner-plan fixtures from docs/INFRASTRUCTURE-CASES.md.
 *
 * Every value is a SYNTHETIC scenario input copied from that doc (not a project
 * fact or estimate). Sector is stated explicitly on every case; the two
 * electric cases run through the PR #2 scan adapter with a synthetic scan so
 * their risk comes from lib/scan/risk.ts. Non-grid cases never touch the scan.
 */

import { planInputFromPr2Scan, type OptionInput, type PlanInput, type PlanMilestone, type Pr2ScanResultLike } from "./planInput";
import type { Evidence, Fact, FactValue, OptionKind, PlanTarget, Sector, StageId, GateId } from "./planTypes";
import { createLifecycle, type LifecycleConfig, type LifecycleEvent, type LifecycleState } from "./lifecycle";
import { PROCEDURES, RULE_IDS, gatingOf, preconditionCodes, procedureByCode, topologicalOrder } from "./procedures";

/** Fixed clock for all fixtures. */
export const FIXTURE_AS_OF = "2026-11-01T00:00:00.000Z";

export interface CaseExpectation {
  sector: Sector;
  /** Title of the named evidence task the sparse case must produce. */
  namedEvidenceTask: string;
  /** Case options A/B/C that must appear. */
  caseOptionIds: string[];
  /** Baseline milestone dates (from the doc) that must appear in deadlines. */
  milestoneDates: Record<string, string>;
  /** Expected-results statements (from the doc) that must appear in the acceptance task's evidence. */
  acceptanceIncludes: string[];
  /** Doc disruption: milestone moves and their baseline "from" dates. */
  disruption: { when: string; reason: string; moves: { id: string; from: string; to: string }[] };
  /** Electric cases must rank their top two risks over all six risk.ts factors. */
  sixFactorRisk: boolean;
}

export interface OwnerCase {
  id: string;
  title: string;
  input: PlanInput;
  expect: CaseExpectation;
}

// ---------------------------------------------------------------- helpers

const docEvidence = (caseId: string, section: string): Evidence => ({
  id: `e.case.${caseId}`,
  kind: "document",
  title: `INFRASTRUCTURE-CASES.md: ${section} (synthetic scenario inputs)`,
  source: { publisher: "GridSentinel docs", locator: `docs/INFRASTRUCTURE-CASES.md#${section.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` },
  retrievedAt: FIXTURE_AS_OF,
  freshness: "unknown",
  provenance: "user_assertion",
});

function fact(caseId: string, subject: string, predicate: string, value: FactValue, unit?: string): Fact {
  return { id: `f.${subject}.${predicate}`, subject, predicate, value, ...(unit ? { unit } : {}), provenance: "user_assertion", evidence: [`e.case.${caseId}`], asOf: FIXTURE_AS_OF };
}

function option(caseId: string, letter: string, kind: OptionKind, title: string, tradeoffs: string, a: [string, FactValue, string?][], addresses?: string[]): OptionInput {
  const id = `o.case.${letter}`;
  return { id, kind, title: `Option ${letter}: ${title}`, tradeoffs, assumptions: a.map(([p, v, u]) => fact(caseId, id, p, v, u)), ...(addresses ? { addresses } : {}) };
}

function ms(id: string, title: string, due: string, stage: StageId, taskId: string | null, caseId: string, gate?: GateId): PlanMilestone {
  return { id, title, due, stage, ...(gate ? { gate } : {}), taskId, evidence: [`e.case.${caseId}`] };
}

const unknownData = (key: string, reason = "Not yet collected (synthetic case start).") => ({ key, available: { state: "unknown" as const, reason } });

function caseInput(caseId: string, section: string, target: PlanTarget, scope: string, rest: Partial<PlanInput>): PlanInput {
  return {
    schema: "gridsentinel.plan-input/1",
    target,
    stage: "feasibility",
    scope,
    origin: "fixture",
    synthetic: true,
    facts: [],
    evidence: [docEvidence(caseId, section)],
    gridRisk: null,
    sectorRisks: [],
    sustainability: [],
    data: [],
    options: [],
    provisionalOption: null,
    milestones: [],
    targetDate: null,
    acceptanceCriteria: [],
    ...rest,
  };
}

/** Merge fixture-declared case fields over a scan-adapter PlanInput. */
function overlay(base: PlanInput, caseId: string, section: string, rest: Partial<PlanInput>): PlanInput {
  return {
    ...base,
    origin: "fixture",
    synthetic: true,
    ...rest,
    facts: [...base.facts, ...(rest.facts ?? [])],
    evidence: [...base.evidence, docEvidence(caseId, section)],
    data: [...base.data.filter((d) => !(rest.data ?? []).some((r) => r.key === d.key)), ...(rest.data ?? [])],
    sustainability: [...(rest.sustainability ?? []), ...base.sustainability],
  };
}

const FUELS = ["solar", "battery", "natural_gas", "wind", "hydro", "biogas", "oil", "other_gas", "waste_heat", "other"] as const;

function syntheticScan(p: {
  lat: number; lon: number; radius: number; label: string;
  mw: Partial<Record<(typeof FUELS)[number], number>>; age: number; plannedRetire: number;
  subs: number; hvSubs: number; lineMiles: number; hottestRatio: number;
  heatCases: number; retiredEventMw: number;
}): Pr2ScanResultLike {
  const mw = Object.fromEntries(FUELS.map((f) => [f, p.mw[f] ?? 0])) as Record<(typeof FUELS)[number], number>;
  const nameplate = FUELS.reduce((s, f) => s + mw[f], 0);
  const renewable = mw.solar + mw.wind + mw.hydro + mw.biogas;
  const fossil = mw.natural_gas + mw.oil + mw.other_gas;
  return {
    area: { lat: p.lat, lon: p.lon, radius_mi: p.radius },
    area_label: `${p.label} (synthetic fixture scan)`,
    inside_coverage: true,
    lines: Array.from({ length: Math.max(1, Math.round(p.lineMiles / 10)) }, () => ({})),
    cases: Array.from({ length: p.heatCases }, (_, i) => ({
      id: `syn-heat-${i}`, title: `Synthetic heat event ${i + 1}`, category: "Heat",
      location: { name: p.label, lat: p.lat, lon: p.lon, distance_mi: 1 },
      one_liner: "Synthetic", problem: "Synthetic", fix: "Synthetic", shock_line: "Synthetic", stats: [], team_bullets: [],
    })),
    events: p.retiredEventMw > 0
      ? [{ kind: "retired", plant_name: "Synthetic retired unit", technology: "Natural Gas Steam Turbine", fuel: "natural_gas", mw: p.retiredEventMw, year: 2020, lat: p.lat, lon: p.lon }]
      : [],
    totals: {
      plant_count: 6, nameplate_mw: nameplate, mw_by_source: mw, renewable_mw: renewable, storage_mw: mw.battery, fossil_mw: fossil,
      renewable_pct: nameplate > 0 ? Math.round((renewable / nameplate) * 1000) / 10 : 0,
      cap_weighted_age: p.age, oldest: { name: "Synthetic oldest unit", year: 1970 },
      planned_retirement_mw: p.plannedRetire, retired_mw: p.retiredEventMw, proposed_mw: 0, proposed_storage_mw: 0,
      line_miles: p.lineMiles, line_miles_by_kv: { "500+": 0, "200-499": p.lineMiles / 2, "100-199": p.lineMiles / 4, "<100": p.lineMiles / 4, unknown: 0 },
      substation_count: p.subs, hv_substation_count: p.hvSubs,
      evening_cover_pct: mw.solar > 0 ? Math.round((mw.battery / mw.solar) * 1000) / 10 : null,
    },
    risk: { score: 0, level: "LOW", factors: [] },
    rating_site: {
      key: "synthetic", name: `${p.label} rating site (synthetic)`, lat: p.lat, lon: p.lon,
      median_conservative_dlr_vs_static: 1.2, pct_hours_conservative_dlr_above_static: 80, summer_4to8pm_median_wind_gain_over_aar: 1.1,
      hottest_hour: "2025-09-06T15:00", hottest_temp_c: 41, hottest_hour_dlr_vs_static: p.hottestRatio, distance_mi: 2,
    },
    upgrade_ideas: [],
  };
}

// ---------------------------------------------------------------- 1. Westminster microgrid

function westminsterMicrogrid(): OwnerCase {
  const id = "microgrid";
  const section = "Westminster critical-facility microgrid";
  const scan = syntheticScan({
    lat: 33.7538, lon: -118.0111, radius: 2, label: "Westminster",
    mw: { natural_gas: 1300, solar: 260, battery: 180, other: 60 }, age: 31, plannedRetire: 400,
    subs: 14, hvSubs: 2, lineMiles: 120, hottestRatio: 0.95, heatCases: 1, retiredEventMw: 300,
  });
  const base = planInputFromPr2Scan(scan, { sector: "electric", scannedAt: FIXTURE_AS_OF, label: "Westminster EOC microgrid (synthetic)" });
  const input = overlay(base, id, section, {
    scope: "Municipal emergency operations facility: 500 kW peak, 2.4 GWh/yr, 48-hour 300 kW critical load (synthetic).",
    sectorRisks: [
      { id: "r.case.no_islanding", title: "No islanding: 48-hour, 14.4 MWh critical load has no backup path", detail: "Existing service has no islanding capability (synthetic baseline).", score: 80, heatwaveScore: 90, factors: { critical_load_kw: 300, critical_energy_mwh: 14.4, islanding: 0 }, evidence: [`e.case.${id}`] },
    ],
    sustainability: [
      { id: "s.case.grid_import", title: "Cut grid import from 2.4 to 1.65 GWh/yr with PV + storage (Option B)", detail: "Emissions proxy 900 → 620 tCO2e at an illustrative 0.375 kg/kWh (413/825 tCO2e at 0.25/0.50). Not a utility forecast; verify with metered import.", score: 70, evidence: [`e.case.${id}`] },
    ],
    data: [unknownData("interval_meter"), unknownData("one_line"), unknownData("utility_requirements")],
    options: [
      option(id, "A", "replacement", "500 kW / 1 MWh battery and controls, no new generation", "Lowest first cost; short outage cover.", [["capital_cost", 2_400_000, "USD"], ["critical_load_duration", 3, "h"], ["annual_grid_energy", 2.4, "GWh"], ["emissions_proxy", 900, "tCO2e"]]),
      option(id, "B", "replacement", "400 kW PV, 1 MW / 4 MWh battery, islanding and controls", "Balanced resilience and bill impact; weather-dependent.", [["capital_cost", 6_800_000, "USD"], ["critical_load_duration", 12, "h"], ["annual_grid_energy", 1.65, "GWh"], ["emissions_proxy", 620, "tCO2e"]]),
      option(id, "C", "replacement", "400 kW PV, 1 MW / 8 MWh battery, islanding, critical-load transfer", "Highest resilience; space, cost and replacement burden. Select only with a validated 48-hour load profile.", [["capital_cost", 9_600_000, "USD"], ["critical_load_duration", 24, "h"], ["annual_grid_energy", 1.45, "GWh"], ["emissions_proxy", 540, "tCO2e"]]),
    ],
    provisionalOption: "o.case.B",
    milestones: [
      ms("ms.load_audit", "Load logging and critical-load audit", "2027-01-15", "feasibility", "t.evidence.interval_meter", id),
      ms("ms.site_fire", "Geotechnical/roof and fire access review", "2027-03-01", "site_control", "t.land.site_control", id, "M2"),
      ms("ms.utility_preapp", "Utility pre-application / interconnection study", "2027-04-15", "permits", "t.permits.applicability", id),
      ms("ms.funding", "Funding award and council appropriation", "2027-06-01", "capital", "t.cap.funding", id, "M3"),
      ms("ms.design", "Design package", "2027-08-01", "engineering", "t.eng.design", id),
      ms("ms.permits", "Permits and utility agreement", "2027-10-01", "permits", "t.permits.dossier", id, "M4"),
      ms("ms.equipment", "Equipment delivery", "2028-03-01", "construction", "t.const.mobilize", id),
      ms("ms.energize", "Energization", "2028-06-01", "commissioning", "t.turn.commission", id),
      ms("ms.acceptance", "Acceptance and emergency exercise", "2028-06-15", "commissioning", "t.turn.accept", id, "M7"),
    ],
    acceptanceCriteria: [
      "Acceptance test demonstrates black start, transfer, stable 300 kW critical bus, and 24-hour battery-only run for C (or measured tested runtime against selected design)",
      "Metered annual grid import for B is at most 1.65 GWh under stated baseline/weather assumptions",
      "Do not claim 48 hours from nameplate capacity alone",
    ],
  });
  return {
    id, title: section, input,
    expect: {
      sector: "electric", namedEvidenceTask: "Obtain interval meter data", caseOptionIds: ["o.case.A", "o.case.B", "o.case.C"],
      milestoneDates: { "ms.load_audit": "2027-01-15", "ms.funding": "2027-06-01", "ms.permits": "2027-10-01", "ms.energize": "2028-06-01", "ms.acceptance": "2028-06-15" },
      acceptanceIncludes: ["black start, transfer, stable 300 kW critical bus", "1.65 GWh", "nameplate capacity alone"],
      disruption: { when: "2028-05-01", reason: "Switchgear lead time slips 16 weeks", moves: [{ id: "ms.energize", from: "2028-06-01", to: "2028-09-21" }, { id: "ms.acceptance", from: "2028-06-15", to: "2028-10-05" }] },
      sixFactorRisk: true,
    },
  };
}

// ---------------------------------------------------------------- 2. Substation expansion

function substationExpansion(): OwnerCase {
  const id = "substation";
  const section = "Synthetic substation expansion";
  const scan = syntheticScan({
    lat: 33.98945, lon: -117.41573, radius: 5, label: "Synthetic substation area",
    mw: { natural_gas: 600, solar: 400, battery: 100, wind: 50 }, age: 22, plannedRetire: 150,
    subs: 6, hvSubs: 1, lineMiles: 80, hottestRatio: 0.9, heatCases: 2, retiredEventMw: 0,
  });
  const base = planInputFromPr2Scan(scan, { sector: "electric", scannedAt: FIXTURE_AS_OF, label: "Synthetic distribution substation" });
  const input = overlay(base, id, section, {
    scope: "Synthetic distribution substation: 18,000 accounts, 24 MW summer peak vs 30 MVA firm, 2.0%/yr growth.",
    sectorRisks: [
      { id: "r.case.firm_capacity", title: "Firm capacity reaches the 90% planning trigger in 2029", detail: "24 MW peak on 30 MVA firm (80%), 2.0%/yr growth; base forecast 29 MW in 2030 (synthetic).", score: 75, heatwaveScore: 88, factors: { loading_pct: 80, growth_pct_per_yr: 2, trigger_year: 2029 }, evidence: [`e.case.${id}`] },
      { id: "r.case.n1", title: "Single-transformer contingency serves only 15 of 24 MW", detail: "One transformer contingency capable of 15 MW (synthetic).", score: 70, heatwaveScore: 80, factors: { contingency_mw: 15, peak_mw: 24 }, evidence: [`e.case.${id}`] },
    ],
    sustainability: [
      { id: "s.case.managed_load", title: "Use managed load and storage to defer firm-capacity build (Option B)", detail: "B adds 6 MW/24 MWh storage and managed load; at 2 h duration it covers only first peak hours and is not firm. Track losses and SAIDI.", score: 55, evidence: [`e.case.${id}`] },
    ],
    data: [{ key: "interval_meter", available: { state: "not_applicable", reason: "Feeder-level planning uses substation load history, not a customer meter." } }, unknownData("load_history_15min"), unknownData("n1_study"), unknownData("one_line")],
    options: [
      option(id, "A", "replacement", "Transformer replacement/addition, +20 MVA in 2029", "Lowest cost; at 3% growth reaches 90% by 2031.", [["capital_cost", 18_000_000, "USD"], ["added_capacity", 20, "MVA"], ["in_service_year", 2029]]),
      option(id, "B", "replacement", "Reconductor feeders plus 6 MW/24 MWh storage and managed load", "Buys time; dispatch and replacement risk; not firm if storage is 2 h.", [["capital_cost", 26_000_000, "USD"], ["firm_equivalent", 10, "MW"], ["in_service_year", 2028]]),
      option(id, "C", "replacement", "New 40 MVA substation and two feeders", "Strongest N-1 and expansion; highest cost.", [["capital_cost", 52_000_000, "USD"], ["added_capacity", 35, "MVA"], ["in_service_year", 2030]]),
    ],
    provisionalOption: "o.case.A",
    milestones: [
      ms("ms.forecast", "Load forecast and contingency study", "2027-02-01", "feasibility", "t.evidence.n1_study", id),
      ms("ms.land", "Land and route control", "2027-04-01", "site_control", "t.land.site_control", id, "M2"),
      ms("ms.env", "Environmental screening", "2027-06-01", "permits", "t.permits.applicability", id),
      ms("ms.filing", "Regulator filing", "2027-09-01", "permits", "t.permits.dossier", id, "M4"),
      ms("ms.funding", "Funding approval", "2027-12-01", "capital", "t.cap.funding", id, "M3"),
      ms("ms.order", "Long-lead transformer order", "2028-01-15", "procurement", "t.proc.award", id, "M5"),
      ms("ms.construction", "Construction window opens", "2029-05-01", "construction", "t.const.mobilize", id),
      ms("ms.inservice", "In-service (Option A)", "2029-10-01", "commissioning", "t.turn.accept", id, "M7"),
    ],
    acceptanceCriteria: [
      "Post-project N-1 load serving at least forecast peak plus approved reserve",
      "SCADA logs confirm alarms and switching",
      "Annual peak loading stays below 90% through 2032 under base growth",
    ],
  });
  return {
    id, title: section, input,
    expect: {
      sector: "electric", namedEvidenceTask: "Obtain 15-minute load history", caseOptionIds: ["o.case.A", "o.case.B", "o.case.C"],
      milestoneDates: { "ms.forecast": "2027-02-01", "ms.filing": "2027-09-01", "ms.funding": "2027-12-01", "ms.order": "2028-01-15", "ms.inservice": "2029-10-01" },
      acceptanceIncludes: ["N-1 load serving", "SCADA logs confirm alarms and switching", "below 90% through 2032"],
      disruption: { when: "2029-08-15", reason: "Transformer factory test failure delays delivery 20 weeks", moves: [{ id: "ms.inservice", from: "2029-10-01", to: "2030-02-20" }] },
      sixFactorRisk: true,
    },
  };
}

// ---------------------------------------------------------------- 3. Water main renewal

function waterMain(): OwnerCase {
  const id = "water_main";
  const section = "Synthetic water main renewal";
  const input = caseInput(id, section, { lat: 34.1, lon: -117.9, radius_miles: 3, sector: "water", label: "Synthetic 300 mm trunk main" },
    "Synthetic 8 km, 300 mm ductile-iron trunk, 55 years old; 2,800 customers and hospital branch.", {
      facts: [fact(id, "trunk_main", "length", 8, "km"), fact(id, "trunk_main", "age", 55, "years"), fact(id, "trunk_main", "non_revenue_water", 18, "%")],
      sectorRisks: [
        { id: "r.case.breaks", title: "Break rate 1.75/km-yr on a 55-year trunk main", detail: "14 breaks in 5 years over 8 km (synthetic).", score: 80, heatwaveScore: 85, factors: { breaks_5yr: 14, break_rate_km_yr: 1.75, age_years: 55 }, evidence: [`e.case.${id}`] },
        { id: "r.case.hospital", title: "Hospital branch and 2,800 customers exposed to outage", detail: "Pressure 55–80 psi; hospital minimum 40 psi at peak (synthetic).", score: 72, heatwaveScore: 86, factors: { customers: 2800, min_pressure_psi: 55 }, evidence: [`e.case.${id}`] },
      ],
      sustainability: [
        { id: "s.case.nrw", title: "Cut zone non-revenue water from 18% toward 12%", detail: "Lower losses reduce treatment and pumping energy; verify with meter balance.", score: 60, evidence: [`e.case.${id}`] },
      ],
      data: [unknownData("break_records"), unknownData("pressure_loggers"), unknownData("condition_survey"), unknownData("hydraulic_model")],
      options: [
        option(id, "A", "repair", "Spot repair", "Lowest disruption now; leaves high-consequence segments.", [["capital_cost", 1_200_000, "USD"], ["delivery_years", 2, "years"], ["expected_break_rate", 1.2, "breaks/km-yr"]]),
        option(id, "B", "replacement", "Line 6 km and replace 2 km", "Balanced; avoided-repair benefit halves at 50% lower break frequency.", [["capital_cost", 8_000_000, "USD"], ["delivery_years", 3, "years"], ["expected_break_rate", 0.4, "breaks/km-yr"]]),
        option(id, "C", "replacement", "Full 8 km replacement with parallel feed and service renewal", "Redundancy and longest life; most excavation and capital.", [["capital_cost", 13_500_000, "USD"], ["delivery_years", 4, "years"], ["expected_break_rate", 0.15, "breaks/km-yr"]]),
      ],
      provisionalOption: "o.case.B",
      milestones: [
        ms("ms.survey", "CCTV/acoustic leak and condition survey", "2027-03-01", "feasibility", "t.evidence.condition_survey", id),
        ms("ms.potholing", "Utility coordination and potholing", "2027-05-01", "site_control", "t.land.site_control", id, "M2"),
        ms("ms.design_permit", "Design and permit", "2027-09-01", "permits", "t.permits.dossier", id, "M4"),
        ms("ms.funding", "Funding decision", "2027-11-15", "capital", "t.cap.funding", id, "M3"),
        ms("ms.procurement", "Procurement", "2028-01-15", "procurement", "t.proc.award", id, "M5"),
        ms("ms.hospital_bypass", "Hospital bypass test before construction", "2028-05-01", "construction", "t.const.mobilize", id),
        ms("ms.segment2", "Segment 2 shutdown", "2028-08-01", "construction", null, id),
        ms("ms.acceptance", "Disinfection and pressure acceptance", "2029-12-01", "commissioning", "t.turn.accept", id, "M7"),
      ],
      acceptanceCriteria: [
        "Within 24 months of full build, break rate at most 0.25/km-year over rolling 3 years",
        "Zone loss at most 12%",
        "Hospital minimum pressure at least 40 psi during peak demand",
      ],
    });
  return {
    id, title: section, input,
    expect: {
      sector: "water", namedEvidenceTask: "Obtain geocoded break records", caseOptionIds: ["o.case.A", "o.case.B", "o.case.C"],
      milestoneDates: { "ms.survey": "2027-03-01", "ms.funding": "2027-11-15", "ms.segment2": "2028-08-01", "ms.acceptance": "2029-12-01" },
      acceptanceIncludes: ["0.25/km-year", "Zone loss at most 12%", "40 psi"],
      disruption: { when: "2028-07-10", reason: "Contaminated soil adds 10 weeks", moves: [{ id: "ms.segment2", from: "2028-08-01", to: "2028-10-10" }] },
      sixFactorRisk: false,
    },
  };
}

// ---------------------------------------------------------------- 4. Wastewater plant upgrade

function wastewaterPlant(): OwnerCase {
  const id = "wastewater";
  const section = "Synthetic wastewater plant upgrade";
  const input = caseInput(id, section, { lat: 33.65, lon: -117.95, radius_miles: 1, sector: "wastewater", label: "Synthetic 20 MGD activated-sludge plant" },
    "Synthetic 20 MGD plant; 15 MGD average, 19 MGD peak month; TN 10 / TP 1.0 mg/L limits; blowers 8.5 GWh/yr.", {
      facts: [fact(id, "plant", "blower_energy", 8.5, "GWh/yr"), fact(id, "plant", "permit_tn_limit", 10, "mg/L"), fact(id, "plant", "permit_tp_limit", 1.0, "mg/L")],
      sectorRisks: [
        { id: "r.case.bypass", title: "Single headworks screen train: 6-hour bypass exposure on failure", detail: "No standby screen (synthetic).", score: 78, heatwaveScore: 80, factors: { screen_trains: 1, bypass_hours: 6 }, evidence: [`e.case.${id}`] },
        { id: "r.case.nutrient_margin", title: "Peak-month 19 of 20 MGD leaves thin nutrient permit margin", detail: "TN 10 / TP 1.0 mg/L limits at 95% hydraulic loading (synthetic).", score: 70, heatwaveScore: 82, factors: { peak_month_mgd: 19, capacity_mgd: 20 }, evidence: [`e.case.${id}`] },
      ],
      sustainability: [
        { id: "s.case.aeration", title: "Cut aeration energy 15–35% from the 8.5 GWh/yr blower load", detail: "A 15%, B 25%, C 35% (synthetic); energy price ±30% moves savings value ±30%.", score: 75, evidence: [`e.case.${id}`] },
      ],
      data: [unknownData("influent_characterization"), unknownData("blower_power"), { key: "permit_history", available: true, evidence: [`e.case.${id}`] }],
      options: [
        option(id, "A", "replacement", "Blower/VFD replacement", "15% energy reduction; no added redundancy.", [["capital_cost", 9_000_000, "USD"], ["aeration_energy_reduction", 15, "%"]]),
        option(id, "B", "replacement", "Blower/VFD plus nutrient retrofit and standby screen", "25% energy reduction and permit margin.", [["capital_cost", 28_000_000, "USD"], ["aeration_energy_reduction", 25, "%"]]),
        option(id, "C", "replacement", "B plus sidestream treatment and two-train headworks", "35% energy reduction, strongest resilience; highest lifecycle and training cost.", [["capital_cost", 41_000_000, "USD"], ["aeration_energy_reduction", 35, "%"]]),
      ],
      provisionalOption: "o.case.B",
      milestones: [
        ms("ms.influent", "12-month influent characterization ends", "2027-04-30", "feasibility", "t.evidence.influent_characterization", id),
        ms("ms.pilot", "Process pilot", "2027-09-01", "feasibility", "t.dev.alternatives", id, "M1"),
        ms("ms.reg_concept", "Regulator concept review", "2027-11-01", "permits", "t.permits.applicability", id),
        ms("ms.funding", "Funding award", "2028-02-01", "capital", "t.cap.funding", id, "M3"),
        ms("ms.design", "Design and electrical study", "2028-06-01", "engineering", "t.eng.design", id),
        ms("ms.shutdown", "Shutdown window", "2029-05-01", "construction", "t.const.mobilize", id),
        ms("ms.startup", "Process startup", "2029-06-01", "commissioning", "t.turn.commission", id),
        ms("ms.performance", "Performance demonstration", "2029-09-01", "commissioning", "t.turn.accept", id, "M7"),
      ],
      acceptanceCriteria: [
        "12 consecutive months of compliant effluent",
        "95th-percentile TN at most 8 mg/L and TP at most 0.8 mg/L",
        "Specific energy at most 1.7 kWh/1,000 gal at comparable flow/load",
      ],
    });
  return {
    id, title: section, input,
    expect: {
      sector: "wastewater", namedEvidenceTask: "Obtain 12-month influent characterization", caseOptionIds: ["o.case.A", "o.case.B", "o.case.C"],
      milestoneDates: { "ms.influent": "2027-04-30", "ms.pilot": "2027-09-01", "ms.funding": "2028-02-01", "ms.startup": "2029-06-01", "ms.performance": "2029-09-01" },
      acceptanceIncludes: ["12 consecutive months of compliant effluent", "TN at most 8 mg/L", "1.7 kWh/1,000 gal"],
      disruption: { when: "2029-05-15", reason: "Switchgear fault extends outage 5 weeks", moves: [{ id: "ms.startup", from: "2029-06-01", to: "2029-07-06" }, { id: "ms.performance", from: "2029-09-01", to: "2029-10-15" }] },
      sixFactorRisk: false,
    },
  };
}

// ---------------------------------------------------------------- 5. Bridge rehabilitation

function bridgeRehab(): OwnerCase {
  const id = "bridge";
  const section = "Synthetic bridge rehabilitation";
  const input = caseInput(id, section, { lat: 33.8, lon: -118.2, radius_miles: 1, sector: "transport", label: "Synthetic 45 m two-lane bridge" },
    "Synthetic 45 m two-lane bridge; deck 4/9, superstructure 6/9; 22,000 vehicles/day, 8% heavy.", {
      facts: [fact(id, "bridge", "deck_rating", 4, "/9"), fact(id, "bridge", "superstructure_rating", 6, "/9"), fact(id, "bridge", "aadt", 22000, "vehicles/day")],
      sectorRisks: [
        { id: "r.case.posting", title: "Load posting required within 18 months; deck rated 4/9", detail: "Absent intervention (synthetic).", score: 82, heatwaveScore: 86, factors: { deck_rating: 4, months_to_posting: 18, heavy_vehicle_pct: 8 }, evidence: [`e.case.${id}`] },
        { id: "r.case.detour", title: "Closure detour adds 11 km for 22,000 vehicles/day", detail: "Emergency services and freight affected (synthetic).", score: 60, factors: { detour_km: 11, aadt: 22000 }, evidence: [`e.case.${id}`] },
      ],
      sustainability: [
        { id: "s.case.embodied", title: "Rehabilitate (Option B) to limit embodied carbon; recycle steel and reuse concrete", detail: "C has the largest detour and embodied-carbon impact; retired steel recycled after coating controls.", score: 50, evidence: [`e.case.${id}`] },
      ],
      data: [unknownData("inspection_load_rating"), { key: "traffic_counts", available: true, evidence: [`e.case.${id}`] }, unknownData("scour_assessment")],
      options: [
        option(id, "A", "repair", "Patch deck and maintain posting", "Minimal closure; load restriction remains.", [["capital_cost", 2_000_000, "USD"], ["life_extension", 4, "years"]]),
        option(id, "B", "replacement", "Deck overlay, bearing/joint replacement and selective strengthening", "20-year extension; benefit-cost falls at lower delay valuation.", [["capital_cost", 9_000_000, "USD"], ["life_extension", 20, "years"]]),
        option(id, "C", "replacement", "Full superstructure replacement", "75-year planning life; largest detour and embodied carbon.", [["capital_cost", 24_000_000, "USD"], ["planning_life", 75, "years"]]),
      ],
      provisionalOption: "o.case.B",
      milestones: [
        ms("ms.inspection", "Hands-on inspection and load rating", "2027-04-01", "feasibility", "t.evidence.inspection_load_rating", id),
        ms("ms.geotech", "Geotech and utilities", "2027-06-01", "site_control", "t.land.site_control", id, "M2"),
        ms("ms.env", "Environmental clearance", "2027-09-01", "permits", "t.permits.applicability", id),
        ms("ms.funding", "Funding", "2027-12-01", "capital", "t.cap.funding", id, "M3"),
        ms("ms.final_design", "Final design", "2028-03-01", "engineering", "t.eng.design", id),
        ms("ms.procurement", "Procurement", "2028-05-01", "procurement", "t.proc.award", id, "M5"),
        ms("ms.closure_plan", "Closure plan and emergency detour approval", "2028-08-01", "construction", "t.const.mobilize", id),
        ms("ms.reopen", "Reopen to traffic", "2028-11-01", "construction", "t.const.complete", id, "M6"),
      ],
      acceptanceCriteria: [
        "Load rating meets legal design vehicle with no posting",
        "Deck rating at least 7/9 after acceptance",
        "Closure hours at most 2 days/year excluding planned maintenance",
      ],
    });
  return {
    id, title: section, input,
    expect: {
      sector: "transport", namedEvidenceTask: "Obtain hands-on inspection and load rating", caseOptionIds: ["o.case.A", "o.case.B", "o.case.C"],
      milestoneDates: { "ms.inspection": "2027-04-01", "ms.funding": "2027-12-01", "ms.procurement": "2028-05-01", "ms.reopen": "2028-11-01" },
      acceptanceIncludes: ["legal design vehicle with no posting", "7/9", "2 days/year"],
      disruption: { when: "2028-09-04", reason: "Hidden girder corrosion adds 8 weeks", moves: [{ id: "ms.reopen", from: "2028-11-01", to: "2028-12-27" }] },
      sixFactorRisk: false,
    },
  };
}

// ---------------------------------------------------------------- 6. Rural fiber

function ruralFiber(): OwnerCase {
  const id = "fiber";
  const section = "Synthetic rural fiber build";
  const input = caseInput(id, section, { lat: 35.2, lon: -118.6, radius_miles: 40, sector: "telecom", label: "Synthetic 120 km rural fiber route" },
    "Synthetic 120 km rural route; 1,600 premises; 35% at ≥25/3 Mbps; 12 anchor sites; single 1 Gbps backhaul at 99.0%.", {
      facts: [fact(id, "route", "premises", 1600, "premises"), fact(id, "route", "served_25_3_pct", 35, "%"), fact(id, "route", "backhaul_availability", 99.0, "%")],
      sectorRisks: [
        { id: "r.case.coverage", title: "Only 35% of 1,600 premises can get ≥25/3 Mbps", detail: "12 public-safety/anchor sites on the route (synthetic).", score: 78, factors: { premises: 1600, served_pct: 35, anchor_sites: 12 }, evidence: [`e.case.${id}`] },
        { id: "r.case.backhaul", title: "Single 1 Gbps backhaul path at 99.0% availability", detail: "No diverse route; hut power and cooling are single points (synthetic).", score: 72, heatwaveScore: 84, factors: { backhaul_paths: 1, availability_pct: 99.0 }, evidence: [`e.case.${id}`] },
      ],
      sustainability: [
        { id: "s.case.passive_plant", title: "Long-life passive fiber plant with certified e-waste retirement", detail: "Passive plant 30–40-year planning life; electronics replaced at year 7–10 via certified e-waste channel.", score: 45, evidence: [`e.case.${id}`] },
      ],
      data: [unknownData("eligibility_map"), unknownData("speed_tests"), unknownData("pole_loading")],
      options: [
        option(id, "A", "replacement", "Fixed wireless plus 10 km fiber backhaul", "Fastest/lowest cost; spectrum and line-of-sight limits.", [["capital_cost", 7_000_000, "USD"], ["premises_100_20_pct", 75, "%"]]),
        option(id, "B", "replacement", "120 km fiber backbone and 35 km distribution", "Balances coverage and capital; revenue weakens at 35% take rate.", [["capital_cost", 18_000_000, "USD"], ["premises_gbps_ready_pct", 95, "%"]]),
        option(id, "C", "replacement", "Full fiber to all serviceable premises with dual diverse backhaul", "Resilience and capacity; more easements and make-ready.", [["capital_cost", 31_000_000, "USD"], ["premises_serviceable_pct", 99, "%"]]),
      ],
      provisionalOption: "o.case.B",
      milestones: [
        ms("ms.survey", "Route survey and demand validation", "2027-02-01", "feasibility", "t.evidence.eligibility_map", id),
        ms("ms.pole_road", "Pole/road applications", "2027-06-01", "permits", "t.permits.applicability", id),
        ms("ms.easements", "Easements", "2027-09-01", "site_control", "t.land.site_control", id, "M2"),
        ms("ms.grant", "Grant award", "2027-12-01", "capital", "t.cap.funding", id, "M3"),
        ms("ms.make_ready", "Make-ready complete", "2028-04-01", "construction", "t.const.mobilize", id),
        ms("ms.west_route", "West route build", "2028-07-01", "construction", null, id),
        ms("ms.launch", "Acceptance and service launch", "2029-01-15", "commissioning", "t.turn.accept", id, "M7"),
      ],
      acceptanceCriteria: [
        "95% of target premises serviceable at ≥1 Gbps-ready fiber path for B",
        "Each anchor site passes throughput/latency and failover test",
        "Report subscriptions separately from serviceability",
      ],
    });
  return {
    id, title: section, input,
    expect: {
      sector: "telecom", namedEvidenceTask: "Obtain address-level eligibility map", caseOptionIds: ["o.case.A", "o.case.B", "o.case.C"],
      milestoneDates: { "ms.survey": "2027-02-01", "ms.grant": "2027-12-01", "ms.west_route": "2028-07-01", "ms.launch": "2029-01-15" },
      acceptanceIncludes: ["95% of target premises", "failover test", "subscriptions separately from serviceability"],
      disruption: { when: "2028-06-01", reason: "Pole make-ready delayed 14 weeks", moves: [{ id: "ms.west_route", from: "2028-07-01", to: "2028-10-07" }, { id: "ms.launch", from: "2029-01-15", to: "2029-04-15" }] },
      sixFactorRisk: false,
    },
  };
}

/** The six cases, in doc order. Built fresh on each call so tests cannot share mutable state. */
export function ownerCases(): OwnerCase[] {
  return [westminsterMicrogrid(), substationExpansion(), waterMain(), wastewaterPlant(), bridgeRehab(), ruralFiber()];
}

// ---------------------------------------------------------------- expected-outcome assertions

export interface CheckRow { caseId: string; criterion: string; pass: boolean; detail: string }

type Built = ReturnType<typeof import("./ownerPlan").buildOwnerPlan>;
type Build = typeof import("./ownerPlan").buildOwnerPlan;
type Reforecast = typeof import("./ownerPlan").reforecastMilestones;

const REQUIRED_OPTION_KINDS: OptionKind[] = ["repair", "operating_change", "replacement", "defer", "do_nothing"];
const KIND_ORDER = { risk: 0, sustainability: 1, gap: 2 } as const;

function taskComplete(p: Built): string[] {
  const ids = new Set(p.tasks.map((t) => t.id));
  const bad: string[] = [];
  for (const t of p.tasks) {
    const roots = t.id.startsWith("t.evidence.") || t.id.startsWith("t.refresh.") || t.id === "t.heat.interim" || t.id === "t.dev.need";
    if (!t.role) bad.push(`${t.id}: no role`);
    if (!t.output) bad.push(`${t.id}: no deliverable`);
    if (t.evidence.length === 0) bad.push(`${t.id}: no acceptance evidence`);
    if (!t.recovery) bad.push(`${t.id}: no recovery`);
    if (!t.due) bad.push(`${t.id}: no due date`);
    if (!roots && t.dependsOn.length === 0) bad.push(`${t.id}: no prerequisite`);
    for (const d of t.dependsOn) if (!ids.has(d)) bad.push(`${t.id}: unknown prerequisite ${d}`);
  }
  return bad;
}

/**
 * Heat-sensitive findings for one case: sector risks whose heatwaveScore differs
 * from the baseline score, and the grid heat factor when its heatwave score
 * differs. Under heatwave each must carry its heatwave score (baseline its
 * baseline score) and the risk findings must re-score or re-order. A case with
 * none passes as explicitly "not applicable", never on task order alone.
 */
export function heatFindingsCheck(input: PlanInput, hb: Built, hh: Built): { applies: boolean; pass: boolean; detail: string } {
  const sector = input.sectorRisks.filter((r) => r.heatwaveScore !== undefined && r.heatwaveScore !== r.score);
  const gb = input.gridRisk?.baseline.factors.find((f) => f.key === "heat");
  const gh = input.gridRisk?.heatwave.factors.find((f) => f.key === "heat");
  const grid = gb && gh && gb.score !== gh.score ? { b: gb.score, h: gh.score } : null;
  if (sector.length === 0 && !grid) {
    return { applies: false, pass: true, detail: "not applicable: no finding has a heatwave score distinct from baseline and no grid heat factor change" };
  }
  const bad: string[] = [];
  const moved: string[] = [];
  for (const r of sector) {
    const fb = hb.findings.find((f) => f.id === r.id);
    const fh = hh.findings.find((f) => f.id === r.id);
    if (fb?.score !== r.score || fh?.score !== r.heatwaveScore || !fh?.detail.includes(`Heatwave score ${r.heatwaveScore} (baseline ${r.score})`)) {
      bad.push(`${r.id} ${fb?.score ?? "absent"}→${fh?.score ?? "absent"} (want ${r.score}→${r.heatwaveScore})`);
    } else moved.push(`${r.id} ${r.score}→${r.heatwaveScore}`);
  }
  if (grid) {
    const fb = hb.findings.find((f) => f.id === "r.grid.heat");
    const fh = hh.findings.find((f) => f.id === "r.grid.heat");
    if ((fb && fb.score !== grid.b) || (fh && fh.score !== grid.h) || (!fb && !fh)) {
      bad.push(`r.grid.heat ${fb?.score ?? "absent"}→${fh?.score ?? "absent"} (want ${grid.b}→${grid.h})`);
    } else moved.push(`r.grid.heat ${fb?.score ?? "-"}→${fh?.score ?? "-"}`);
  }
  const sig = (p: Built) => p.findings.filter((f) => f.kind === "risk").map((f) => `${f.id}:${f.score ?? ""}`).join(",");
  const changed = sig(hb) !== sig(hh);
  if (!changed) bad.push("risk findings identical under heatwave");
  return { applies: true, pass: bad.length === 0, detail: bad.length ? `FAIL ${bad.join("; ")}` : `re-scored ${moved.join(", ")}` };
}

/** Evaluate one case's doc-derived expectations. `build`/`reforecast` are injected to keep this module free of a planner import cycle. */
export function evaluateCase(c: OwnerCase, build: Build, reforecast: Reforecast): CheckRow[] {
  const rows: CheckRow[] = [];
  const row = (criterion: string, pass: boolean, detail: string) => rows.push({ caseId: c.id, criterion, pass, detail });
  const base = build(c.input, { scenario: "baseline", asOf: FIXTURE_AS_OF });
  const e = c.expect;

  row("sector explicit", base.target.sector === e.sector && c.input.target.sector === e.sector, `target.sector=${base.target.sector}`);

  const kinds = base.findings.map((f) => KIND_ORDER[f.kind]);
  const ordered = kinds.every((k, i) => i === 0 || kinds[i - 1] <= k);
  row("findings risk→sustainability→gap", ordered && base.findings.filter((f) => f.kind === "risk").length >= 2, base.findings.map((f) => f.kind[0]).join(""));

  const top2 = base.findings.filter((f) => f.kind === "risk").slice(0, 2);
  if (e.sixFactorRisk) {
    const risk = c.input.gridRisk?.baseline;
    const keys = (risk?.factors ?? []).map((f) => f.key).sort().join(",");
    const ok = !!risk && risk.factors.length === 6 && top2.every((f) => Object.keys(f.factors ?? {}).sort().join(",") === keys)
      && top2.every((f) => f.id.startsWith("r.grid."));
    row("top two risks use six weighted risk.ts factors", ok, `${top2.map((f) => f.id).join(", ")} over [${keys}]`);
  } else {
    const ok = top2.length === 2 && top2.every((f) => !f.id.startsWith("r.grid.") && Object.keys(f.factors ?? {}).length > 0)
      && base.facts.some((f) => f.id === "f.risk.grid_factors" && typeof f.value === "object");
    row("top two risks from sector evidence (grid factors not applicable)", ok, top2.map((f) => f.id).join(", "));
  }

  row("sustainability opportunity", base.findings.some((f) => f.kind === "sustainability"), base.findings.filter((f) => f.kind === "sustainability").map((f) => f.id).join(", "));

  const named = base.tasks.find((t) => t.title === e.namedEvidenceTask);
  row("sparse data → named evidence task", !!named && named.id.startsWith("t.evidence."), named ? named.id : `missing "${e.namedEvidenceTask}"`);

  const optKinds = new Set(base.options.map((o) => o.kind));
  row("options: repair, operating change, replacement, defer, do-nothing", REQUIRED_OPTION_KINDS.every((k) => optKinds.has(k)), [...optKinds].join(","));
  const caseOpts = e.caseOptionIds.every((id) => base.options.some((o) => o.id === id && o.assumptions.some((a) => a.predicate === "capital_cost" && typeof a.value === "number")));
  row("case options A/B/C with quantitative assumptions", caseOpts, e.caseOptionIds.join(","));

  const bad = taskComplete(base);
  row("every task: owner role, prerequisite, deliverable, acceptance evidence, recovery", bad.length === 0, bad.length ? bad.slice(0, 3).join("; ") : `${base.tasks.length} tasks`);

  const gatesOk = Object.entries(e.milestoneDates).every(([id, d]) => base.deadlines.some((x) => x.kind.startsWith(`milestone:${id}`) && x.due === d));
  const chainOk = base.tasks.every((t) => t.dependsOn.every((d) => {
    const dep = base.tasks.find((x) => x.id === d)!;
    return dep.due! <= isoAdd(FIXTURE_AS_OF, t.offsetDays);
  }));
  row("dated gates back-scheduled (deadlines + predecessor order)", gatesOk && chainOk && base.scheduleMode === "back", `anchor ${base.scheduleAnchor}`);

  const accept = base.tasks.find((t) => t.id === "t.turn.accept" || t.gate === "M7");
  const acceptText = (accept?.evidence ?? []).join(" | ");
  row("doc expected results in acceptance evidence", e.acceptanceIncludes.every((s) => acceptText.includes(s)), accept ? accept.id : "no acceptance task");

  const moved = reforecast(c.input, e.disruption.moves.map((m) => ({ id: m.id, to: m.to, reason: e.disruption.reason })));
  const dp = build(moved, { scenario: "baseline", asOf: FIXTURE_AS_OF });
  const dOk = e.disruption.moves.every((m) => {
    const dl = dp.deadlines.find((x) => x.kind.startsWith(`milestone:${m.id}`));
    const baseFact = dp.facts.find((f) => f.id === `f.milestone.${m.id}.baseline`);
    const fc = dp.facts.find((f) => f.id === `f.milestone.${m.id}.forecast`);
    const ms = c.input.milestones.find((x) => x.id === m.id)!;
    const taskOk = !ms.taskId || dp.tasks.find((t) => t.id === ms.taskId)?.due === m.to;
    return dl?.due === m.to && baseFact?.value === m.from && fc?.value === m.to && fc.supersedes === baseFact.id && taskOk && ms.due === m.from;
  });
  // Non-circular part: the reforecast must propagate. Predecessor order holds in the disrupted plan, and every
  // task downstream of a moved milestone task that is not itself date-constrained shifts by the same slip.
  const dChain = dp.tasks.every((t) => t.dependsOn.every((d) => dp.tasks.find((x) => x.id === d)!.due! <= isoAdd(FIXTURE_AS_OF, t.offsetDays)));
  const lastMove = [...e.disruption.moves].sort((a, b) => (a.to < b.to ? 1 : -1))[0];
  const lastTask = c.input.milestones.find((x) => x.id === lastMove.id)!.taskId;
  let propagated = true;
  if (lastTask) {
    const slip = dayNum(lastMove.to) - dayNum(lastMove.from);
    const down = base.tasks.filter((t) => t.dependsOn.includes(lastTask));
    propagated = down.length > 0 && down.every((t) => dayNum(dp.tasks.find((x) => x.id === t.id)!.due!) - dayNum(t.due!) === slip);
  }
  row("disruption reforecast moves gates, keeps baseline, propagates downstream", dOk && dChain && propagated, e.disruption.moves.map((m) => `${m.id} ${m.from}→${m.to}`).join("; ") + (lastTask ? ` (downstream of ${lastTask} shifted)` : " (informational milestone)"));

  const named2 = named?.id ?? "t.dev.need";
  const edits = { planKey: (base.draft.planKey), tasks: { [named2]: { owner: "A. Owner", status: "in_progress" as const, notes: "kept" }, "t.heat.interim": { owner: "Heat lead" } } };
  const hb = build(c.input, { scenario: "baseline", asOf: FIXTURE_AS_OF, edits });
  const hh = build(c.input, { scenario: "heatwave", asOf: FIXTURE_AS_OF, edits });
  const orderB = hb.findings.map((f) => `${f.id}:${f.score ?? ""}`).join(",") + "|" + hb.nextTaskId;
  const orderH = hh.findings.map((f) => `${f.id}:${f.score ?? ""}`).join(",") + "|" + hh.nextTaskId;
  const editKeptB = hb.tasks.find((t) => t.id === named2)?.owner === "A. Owner" && hb.draft.orphaned.some((o) => o.taskId === "t.heat.interim" && o.edit.owner === "Heat lead");
  const editKeptH = hh.tasks.find((t) => t.id === named2)?.owner === "A. Owner" && hh.tasks.find((t) => t.id === "t.heat.interim")?.owner === "Heat lead" && hh.draft.orphaned.length === 0;
  const heat = heatFindingsCheck(c.input, hb, hh);
  row("heatwave re-prioritizes without erasing edits", orderB !== orderH && hh.nextTaskId === "t.heat.interim" && editKeptB && editKeptH && heat.pass, `next ${hb.nextTaskId} → ${hh.nextTaskId}`);
  row("heatwave re-scores/re-orders heat-sensitive findings", heat.pass, heat.detail);

  const again = build(c.input, { scenario: "baseline", asOf: FIXTURE_AS_OF });
  row("deterministic output hash", again.outputHash === base.outputHash && again.inputsHash === base.inputsHash, base.outputHash.slice(0, 16));
  return rows;
}

function dayNum(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)!;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

function isoAdd(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- lifecycle liveness logs

/**
 * Fully completed lifecycle event logs for the Westminster microgrid and the
 * substation expansion (SYNTHETIC records shaped by docs/INFRASTRUCTURE-CASES.md).
 * One batch per gate, in M0..M9 order; each batch records exactly what that gate
 * checks: domain records, sign-offs, and every *required* catalog step at the gate
 * (plus any not-yet-completed unconditional catalog preconditions of those steps,
 * so completions never precede their preconditions). Conditional steps are left
 * alone (no trigger is active; evaluation-required triggers are recorded as not
 * active with a basis) and non-gating steps are never completed, so a pass proves
 * neither is needed. Used by the liveness test and scripts/verify-owner-lifecycle.ts.
 */
export const LIVENESS_CONFIG: LifecycleConfig = {
  roles: {
    triage: ["triage"], sponsor: ["investment"], compliance: ["compliance"], verifier: ["permit_verifier"],
    land: ["land_legal"], finance: ["finance"], signatory: ["signatory"], contracting: ["contracting"],
    waiverAuth: ["waiver"], design: ["design_authority"], quality: ["quality"], cx: ["cx_authority"],
    ownerRep: ["owner_rep"], custodian: ["records"], analyst: [],
  },
  authority: {
    triage: ["triage"], decision: ["investment"], applicabilityReviewer: ["compliance"], instrumentVerifier: ["permit_verifier"],
    landRights: ["land_legal"], budget: ["finance"], submission: ["signatory"], award: ["contracting"], waiver: ["waiver"],
    conditionReviewer: ["compliance"], designAuthority: ["design_authority"], ncrDisposition: ["quality"], testReviewer: ["cx_authority"],
    gateSignoff: { M6: ["owner_rep"], M7: ["cx_authority"], M9: ["records"] },
  },
  requiredAwardApprovals: ["technical", "finance", "legal"],
};

export interface LivenessBatch { gate: GateId; asOf: string; events: LifecycleEvent[]; completedCodes: string[] }
export interface LivenessCase { caseId: string; title: string; initial: LifecycleState; batches: LivenessBatch[] }

type EventBody = LifecycleEvent extends infer E ? (E extends LifecycleEvent ? Omit<E, "id" | "at" | "actor"> : never) : never;

interface LivenessSpec {
  caseId: string; title: string; owner: string; nextAction: string;
  dates: Record<GateId, string>;
  option: { id: string; label: string; others: { id: string; label: string }[] };
  parcels: string[];
  budget: number; funding: { id: string; provider: string; kind: "capital" | "loan" | "rate_base" | "grant" | "other"; amount: number }[];
  instruments: { id: string; requirement: string; authority: string; activity: string; phase: string; jurisdictionId: string; expiresAt: string }[];
  condition: { id: string; sourceRecordId: string; text: string; authority: string; dueAt: string };
  pkg: { id: string; scope: string; license: string; supplier: string; equipment: { id: string; model: string; leadTimeDays: number } };
  constructionTest: string; commissioningTest: string;
  asset: { id: string; type: string; custodian: string };
  /** M8 retirement closure path: a linked decommissioning case, or RET-01 recorded in this case. */
  closure: "linked_case" | "ret01";
}

const LIVENESS_SPECS: Record<"microgrid" | "substation", LivenessSpec> = {
  microgrid: {
    caseId: "case-microgrid", title: "Westminster critical-facility microgrid (synthetic)", owner: "City facilities manager",
    nextAction: "Interval-meter load logging and critical-load audit",
    dates: { M0: "2026-12-02", M1: "2027-02-01", M2: "2027-03-01", M3: "2027-06-01", M4: "2027-10-01", M5: "2027-11-20", M6: "2028-05-20", M7: "2028-06-15", M8: "2043-01-10", M9: "2045-06-01" },
    option: { id: "B", label: "400 kW PV, 1 MW / 4 MWh battery, islanding and controls", others: [{ id: "A", label: "Battery and controls only" }, { id: "C", label: "PV, 8 MWh battery, critical-load transfer" }] },
    parcels: ["APN-195-01"],
    budget: 6_800_000, funding: [{ id: "fs-capital", provider: "City capital plan", kind: "capital", amount: 3_000_000 }, { id: "fs-loan", provider: "State resilience loan (synthetic)", kind: "loan", amount: 3_800_000 }],
    instruments: [{ id: "auth-bld", requirement: "Building and electrical permit", authority: "City of Westminster", activity: "install", phase: "construction", jurisdictionId: "westminster", expiresAt: "2029-10-01" }],
    condition: { id: "cond-fire", sourceRecordId: "auth-bld", text: "Fire department battery-room inspection before energization", authority: "Fire authority", dueAt: "2028-05-31" },
    pkg: { id: "pkg-epc", scope: "Microgrid EPC incl. switchgear", license: "C-10 electrical", supplier: "sup-epc", equipment: { id: "eq-swgr", model: "SWGR-1200A", leadTimeDays: 120 } },
    constructionTest: "battery-enclosure-insulation", commissioningTest: "islanding-transfer",
    asset: { id: "asset-bess", type: "BESS 1 MW / 4 MWh with 400 kW PV", custodian: "City facilities operations" },
    closure: "linked_case",
  },
  substation: {
    caseId: "case-substation", title: "Synthetic distribution substation expansion", owner: "Distribution planning manager",
    nextAction: "15-minute load history and N-1 contingency study",
    dates: { M0: "2026-12-05", M1: "2027-02-01", M2: "2027-04-01", M3: "2027-12-01", M4: "2027-12-15", M5: "2028-01-15", M6: "2029-09-01", M7: "2029-10-01", M8: "2068-01-10", M9: "2070-06-01" },
    option: { id: "A", label: "Transformer replacement/addition, +20 MVA", others: [{ id: "B", label: "Reconductor plus storage and managed load" }, { id: "C", label: "New 40 MVA substation" }] },
    parcels: ["APN-SUB-01", "ROW-FEEDER-02"],
    budget: 18_000_000, funding: [{ id: "fs-ratebase", provider: "Approved rate-base capital (synthetic)", kind: "rate_base", amount: 18_000_000 }],
    instruments: [
      { id: "auth-env", requirement: "Environmental screening determination", authority: "State environmental agency", activity: "site work", phase: "construction", jurisdictionId: "state", expiresAt: "2031-01-01" },
      { id: "auth-reg", requirement: "Regulator approval of substation filing", authority: "Utility regulator", activity: "build", phase: "construction", jurisdictionId: "state-puc", expiresAt: "2031-01-01" },
    ],
    condition: { id: "cond-oil", sourceRecordId: "auth-env", text: "Transformer oil containment inspection before energization", authority: "State environmental agency", dueAt: "2029-09-30" },
    pkg: { id: "pkg-xfmr", scope: "Substation transformer supply and install", license: "C-10 electrical", supplier: "sup-xfmr", equipment: { id: "eq-xfmr", model: "XFMR-28MVA", leadTimeDays: 420 } },
    constructionTest: "xfmr-insulation-resistance", commissioningTest: "n1-transfer-scada",
    asset: { id: "asset-xfmr", type: "Distribution transformer bank (+20 MVA)", custodian: "Substation operations" },
    closure: "ret01",
  },
};

export const LIVENESS_CASE_IDS = Object.keys(LIVENESS_SPECS) as (keyof typeof LIVENESS_SPECS)[];

export function completedLifecycleCase(id: keyof typeof LIVENESS_SPECS): LivenessCase {
  const sp = LIVENESS_SPECS[id];
  const initial = createLifecycle({ caseId: sp.caseId, title: sp.title, sector: "electric", config: LIVENESS_CONFIG });
  const done = new Set<string>();
  const order = topologicalOrder();
  let n = 0;
  const batches: LivenessBatch[] = [];
  for (const gate of ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9"] as GateId[]) {
    const at = `${sp.dates[gate]}T12:00:00Z`;
    const events: LifecycleEvent[] = [];
    const add = (actor: string, body: EventBody) => events.push({ ...(body as object), id: `${sp.caseId}.${String(++n).padStart(3, "0")}`, at, actor } as LifecycleEvent);
    const evidence = (eid: string, title: string) => add("analyst", { type: "evidence_recorded", evidence: { id: eid, kind: "document", title, source: { publisher: "synthetic liveness fixture" }, retrievedAt: at, freshness: "fresh", provenance: "owner_verified" } });
    const e = (what: string) => `ev.${id}.${gate}.${what}`;
    switch (gate) {
      case "M0":
        evidence(e("intake"), "Intake report");
        add("triage", { type: "intake_accepted", owner: sp.owner, urgency: "routine", nextAction: sp.nextAction, nextActionDate: `${sp.dates.M1}T00:00:00Z`, sourceEvidence: [e("intake")] });
        for (const t of Object.keys(RULE_IDS).filter((k) => RULE_IDS[k].evaluationRequired)) {
          add("triage", { type: "trigger_evaluated", trigger: t, active: false, basis: "Intake urgency recorded as routine", evidence: [e("intake")] });
        }
        break;
      case "M1":
        evidence(e("appraisal"), "Option appraisal and decision record");
        add("sponsor", { type: "decision_recorded", decision: {
          id: `dec-${id}-m1`, gate: "M1", kind: "alternative", question: "Preferred alternative", owner: "sponsor",
          alternatives: [{ id: sp.option.id, label: sp.option.label, viable: true }, ...sp.option.others.map((o) => ({ ...o, viable: true }))],
          outcome: "proceed", rationale: `Option ${sp.option.id} selected under the approved appraisal frame`, weights: { resilience: 0.5, cost: 0.5 }, assumptions: [],
          evidence: [e("appraisal")], decidedAt: at, revisitAt: null,
        } });
        add("sponsor", { type: "decision_signed", decisionId: `dec-${id}-m1`, version: 1 });
        break;
      case "M2":
        sp.parcels.forEach((parcel, i) => {
          evidence(e(`rights-${i}`), `Executed instrument for ${parcel}`);
          add("land", { type: "land_record_added", record: { id: `lr-${id}-${i}`, parcel, instrument: "executed", evidence: [] } });
          add("land", { type: "land_rights_accepted", recordId: `lr-${id}-${i}`, evidence: [e(`rights-${i}`)] });
        });
        break;
      case "M3":
        evidence(e("budget"), "Budget approval minutes");
        add("finance", { type: "budget_approved", budget: { id: `bud-${id}`, amount: sp.budget, currency: "USD", residualGap: null } });
        for (const f of sp.funding) {
          evidence(e(f.id), `${f.provider} commitment`);
          add("finance", { type: "funding_source_recorded", source: { id: f.id, provider: f.provider, kind: f.kind, amount: f.amount, currency: "USD", status: "committed", evidence: [e(f.id)] } });
        }
        break;
      case "M4":
        add("design", { type: "baseline_recorded", baseline: { id: `bl-${id}-design`, kind: "design", version: 1, content: { option: sp.option.id }, createdAt: at, supersedes: null } });
        for (const a of sp.instruments) {
          add("compliance", { type: "authorization_identified", authorization: { id: a.id, requirement: a.requirement, authority: a.authority, activity: a.activity, phase: a.phase, jurisdictionId: a.jurisdictionId } });
          add("compliance", { type: "authorization_applicability_set", authorizationId: a.id, applicability: "confirmed applicable", basis: `${a.authority} source reviewed` });
          for (const st of ["in preparation", "submitted", "under review"] as const) add("compliance", { type: "authorization_external_changed", authorizationId: a.id, state: st, evidence: [] });
          evidence(e(a.id), `${a.requirement} (issued instrument)`);
          add("verifier", { type: "authorization_external_changed", authorizationId: a.id, state: "issued", evidence: [e(a.id)], issuedAt: at, expiresAt: `${a.expiresAt}T00:00:00Z` });
        }
        add("compliance", { type: "condition_recorded", condition: { id: sp.condition.id, sourceRecordId: sp.condition.sourceRecordId, text: sp.condition.text, authority: sp.condition.authority, responsibleParty: sp.owner, dueAt: `${sp.condition.dueAt}T00:00:00Z`, trigger: null, blocksGates: ["M6"] } });
        break;
      case "M5": {
        const p = sp.pkg;
        evidence(e("license"), `${p.supplier} ${p.license} license`);
        add("contracting", { type: "supplier_registered", supplier: { id: p.supplier, name: p.supplier, licenses: [{ class: p.license, jurisdictionId: "CA", expiresAt: `${sp.dates.M7}T00:00:00Z`, evidenceId: e("license") }] } });
        evidence(e("availability"), `${p.equipment.model} availability confirmation`);
        add("contracting", { type: "procurement_package_created", package: { id: p.id, scope: p.scope, requiredLicense: { class: p.license, jurisdictionId: "CA" }, equipment: [{ id: p.equipment.id, model: p.equipment.model, supplierId: p.supplier, longLead: true, availability: "available", leadTimeDays: p.equipment.leadTimeDays, evidence: [e("availability")] }] } });
        for (const k of LIVENESS_CONFIG.requiredAwardApprovals) add("contracting", { type: "procurement_approval_recorded", packageId: p.id, kind: k });
        add("contracting", { type: "procurement_awarded", packageId: p.id, supplierId: p.supplier });
        evidence(e("contract"), "Executed contract");
        add("signatory", { type: "contract_executed", packageId: p.id, evidence: [e("contract")] });
        break;
      }
      case "M6":
        evidence(e("test"), `${sp.constructionTest} record`);
        add("cx", { type: "test_result_recorded", result: { id: `T-${id}-c1`, testId: sp.constructionTest, stage: "construction", critical: true, outcome: "pass", executedAt: at, executor: "Contractor QA", witness: "Owner engineer", reviewedBy: "cx", retestOf: null, observed: "within criterion", evidence: [e("test")], deferral: null } });
        evidence(e("condition"), `${sp.condition.text} (inspection report)`);
        add("compliance", { type: "condition_status_changed", conditionId: sp.condition.id, status: "evidence_submitted", evidence: [e("condition")] });
        add("compliance", { type: "condition_status_changed", conditionId: sp.condition.id, status: "verified", evidence: [] });
        add("compliance", { type: "condition_closed", conditionId: sp.condition.id });
        evidence(e("completion"), "Construction completion record");
        add("ownerRep", { type: "gate_signoff", gate: "M6", evidence: [e("completion")] });
        break;
      case "M7":
        add("ownerRep", { type: "asset_registered", asset: { id: sp.asset.id, assetType: sp.asset.type, baselineId: `bl-${id}-design` } });
        add("ownerRep", { type: "asset_custodian_assigned", assetId: sp.asset.id, custodian: sp.asset.custodian });
        add("ownerRep", { type: "asset_status_changed", assetId: sp.asset.id, status: "validated" });
        add("ownerRep", { type: "asset_status_changed", assetId: sp.asset.id, status: "in_service" });
        evidence(e("test"), `${sp.commissioningTest} record`);
        add("cx", { type: "test_result_recorded", result: { id: `T-${id}-x1`, testId: sp.commissioningTest, stage: "commissioning", critical: true, outcome: "pass", executedAt: at, executor: "Commissioning agent", witness: "Operations", reviewedBy: "cx", retestOf: null, observed: "within criterion", evidence: [e("test")], deferral: null } });
        evidence(e("acceptance"), "Commissioning acceptance");
        add("cx", { type: "gate_signoff", gate: "M7", evidence: [e("acceptance")] });
        break;
      case "M8":
        evidence(e("condition"), "End-of-life condition assessment");
        add("sponsor", { type: "decision_recorded", decision: {
          id: `dec-${id}-m8`, gate: "M8", kind: "retirement", question: "Retire at end of life", owner: "asset manager",
          alternatives: [{ id: "retire", label: "Retire and restore site", viable: true }], outcome: "stop",
          rationale: "Condition and cost trend favour retirement over renewal", weights: {}, assumptions: [], evidence: [e("condition")], decidedAt: at, revisitAt: null,
        } });
        add("sponsor", { type: "decision_signed", decisionId: `dec-${id}-m8`, version: 1 });
        if (sp.closure === "linked_case") add("sponsor", { type: "linked_case_opened", link: { caseId: `${sp.caseId}-decom`, relation: "decommissioning", fromBaselineId: null, trigger: `dec-${id}-m8`, reason: "Stage 11 decommissioning and closure" } });
        break;
      case "M9":
        add("ownerRep", { type: "asset_status_changed", assetId: sp.asset.id, status: "retired" });
        for (const a of sp.instruments) add("compliance", { type: "authorization_external_changed", authorizationId: a.id, state: "closed", evidence: [] });
        evidence(e("archive"), "Final status certificate and archive manifest");
        add("custodian", { type: "gate_signoff", gate: "M9", evidence: [e("archive")] });
        break;
    }
    // Required catalog steps at this gate, preceded by any outstanding unconditional catalog preconditions.
    const need = new Set<string>();
    const pull = (code: string) => {
      if (done.has(code) || need.has(code)) return;
      need.add(code);
      for (const p of preconditionCodes(procedureByCode(code)!, false)) pull(p);
    };
    for (const step of PROCEDURES) if (step.gate === gate && gatingOf(step) === "required") pull(step.code);
    if (gate === "M8" && sp.closure === "ret01") pull("RET-01"); // closure path documented in this case
    const codes = order.filter((c) => need.has(c));
    if (codes.length) evidence(e("procedures"), `Accepted procedure evidence at ${gate}`);
    for (const code of codes) {
      add("ownerRep", { type: "procedure_step_completed", code, evidence: [e("procedures")] });
      done.add(code);
    }
    batches.push({ gate, asOf: at, events, completedCodes: codes });
  }
  return { caseId: sp.caseId, title: sp.title, initial, batches };
}
