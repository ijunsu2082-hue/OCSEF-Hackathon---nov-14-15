import type { DailyRating, LineRatingNow, ScanResult } from "../scan/types";

export type TriState = "yes" | "no" | "unknown";
export type RuleStatus = "pass" | "fail" | "unknown";
export type CandidateKind = "intervention" | "funding" | "authorization";
export type Confidence = "high" | "medium" | "low";

export interface Provenance {
  source: string;
  url?: string;
  observedAt: string;
  method: "scan" | "live" | "historical" | "official-program" | "scenario";
}
export interface OwnerRule {
  id: string;
  label: string;
  description: string;
  /** Required owner-confirmed facts; absence remains unknown. */
  required: string[];
  evidence: string[];
}
export interface OwnerTask {
  id: string;
  title: string;
  role: string;
  dependsOn: string[];
  offsetDays: number;
  inputs: string[];
  output: string;
  evidence: string[];
  recovery: string;
}
export interface OwnerCandidate {
  id: string;
  kind: CandidateKind;
  title: string;
  summary: string;
  tradeoff: string;
  evidence: string[];
  provenance: Provenance[];
  confidence: Confidence;
  /** 0..1 screening confidence; never a probability of approval or success. */
  confidenceScore: number;
  /** Screening relevance from observed area metrics, 0..100; not an approval score. */
  usefulness: number;
  rules: OwnerRule[];
  dependencies: string[];
  tasks: OwnerTask[];
}
export interface OwnerFinding {
  id: string;
  title: string;
  evidence: string[];
  kind: "risk" | "sustainability" | "gap";
  optionIds: string[];
}
export interface FundingCandidate extends OwnerCandidate {
  kind: "funding";
  url: string;
  status: "open" | "upcoming" | "closed" | "monitor";
  deadline: string | null;
  applicability: string;
}
export interface AuthorizationTrack extends OwnerCandidate {
  kind: "authorization";
  authority: string;
}
export interface LifecycleStage {
  id: string;
  title: string;
  description: string;
  gate: string;
  evidence: string[];
  owner: string;
  tasks: OwnerTask[];
}
export interface OwnerPlan {
  generatedAt: string;
  area: ScanResult["area"];
  areaLabel: string;
  confidence: Confidence;
  confidenceScore: number;
  provenance: Provenance[];
  findings: OwnerFinding[];
  interventions: OwnerCandidate[];
  funding: FundingCandidate[];
  authorizations: AuthorizationTrack[];
  lifecycle: LifecycleStage[];
  rules: OwnerRule[];
  /** Highest weighted area scan risks. Weights and scores are screening inputs, not probabilities. */
  topRisks: Array<{ key: string; label: string; score: number; weight: number; weightedScore: number; evidence: string }>;
  sustainability: { summary: string; evidence: string[]; caveat: string };
  nextStep: { title: string; owner: string; timing: string; rationale: string };
  decisionComparison: Array<{ option: "defer" | "operate"; summary: string; tradeoff: string; evidence: string[] }>;
  confidenceGap: { score: number; gap: number; evidenceAvailable: number; evidenceExpected: number; missing: string[]; meaning: string };
}
export interface RuleEvaluation {
  ruleId: string;
  status: RuleStatus;
  answer: TriState;
  missing: string[];
}
export interface RuleEvaluationResult {
  candidateId: string | null;
  evaluations: RuleEvaluation[];
  /** null while any required owner fact is unknown; false when a fact is explicitly unmet. */
  ready: boolean | null;
}

const nowIso = () => new Date().toISOString();
const canonical = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export function candidateId(kind: CandidateKind, slug: string): string {
  return `${kind}:${canonical(slug)}`;
}
const ruleId = (slug: string) => `rule:${canonical(slug)}`;

function rule(slug: string, label: string, description: string, required: string[], evidence: string[] = []): OwnerRule {
  return { id: ruleId(slug), label, description, required, evidence };
}
function task(id: string, title: string, role: string, dependsOn: string[], offsetDays: number, inputs: string[], output: string, evidence: string[], recovery: string): OwnerTask {
  return { id, title, role, dependsOn, offsetDays, inputs, output, evidence, recovery };
}
function provenance(source: string, method: Provenance["method"], observedAt: string, url?: string): Provenance {
  return { source, method, observedAt, ...(url ? { url } : {}) };
}

const INTERVENTION_SPECS = [
  { slug: "microgrid-storage", title: "Critical-load microgrid and storage", summary: "Assess a grid-connected microgrid with islandable storage for identified critical loads.", tradeoff: "Resilience benefit depends on critical-load definition, duration, interconnection, and operating cost.", rules: ["critical-loads", "islanding-approval", "site-control"], tasks: ["define-loads", "screen-interconnection", "size-storage"] },
  { slug: "dynamic-line-rating", title: "Dynamic line rating pilot", summary: "Validate weather-informed operating limits on the highest-value corridor before relying on additional transfer capacity.", tradeoff: "Rating uplift is weather- and line-specific; protection and operating procedures remain controlling.", rules: ["line-identity", "utility-approval", "engineering-study"], tasks: ["confirm-line", "validate-sensors", "operator-pilot"] },
  { slug: "substation-capacity", title: "Substation capacity and protection study", summary: "Study transformer headroom, contingency performance, protection, and a staged capacity upgrade.", tradeoff: "A mapped substation does not establish spare capacity or an upgrade need; utility study is required.", rules: ["asset-owner", "load-forecast", "contingency-study"], tasks: ["confirm-owner", "obtain-load-data", "study-contingency"] },
  { slug: "feeder-hardening", title: "Feeder hardening and sectionalizing", summary: "Evaluate targeted conductor, switching, vegetation, and protection improvements against outage exposure.", tradeoff: "Screening geometry cannot establish outage cause, safety clearance, or cost effectiveness.", rules: ["circuit-confirmation", "outage-evidence", "utility-approval"], tasks: ["confirm-circuit", "review-outages", "select-hardening"] },
  { slug: "renewables-storage", title: "Renewables plus storage integration", summary: "Assess local renewable generation, storage, and controls as one dispatchable resilience option.", tradeoff: "Interconnection, resource profile, load match, fire code, and replacement reserves govern feasibility.", rules: ["load-profile", "site-control", "interconnection-study"], tasks: ["collect-load-profile", "screen-site", "model-dispatch"] },
] as const;

const FUNDING_SPECS: Omit<FundingCandidate, "evidence" | "provenance" | "confidence" | "confidenceScore" | "usefulness" | "rules" | "dependencies" | "tasks">[] = [
  { id: candidateId("funding", "cec-deba-gfo-26-503"), kind: "funding", title: "CEC Distributed Electricity Backup Assets (GFO-26-503)", summary: "Current competitive California solicitation for distributed energy resources supporting grid reliability.", tradeoff: "Solicitation requirements and eligible applicant/project types control; screening match is not eligibility.", url: "https://www.energy.ca.gov/solicitations/2026-10/gfo-26-503-distributed-electricity-backup-assets-program-distributed-energy", status: "open", deadline: null, applicability: "Potentially relevant to California backup-generation or DER projects. Confirm the current solicitation, applicant class, eligible technologies, and deadline in the official notice." },
  { id: candidateId("funding", "doe-grid-resilience-state-tribal-formula"), kind: "funding", title: "DOE Grid Resilience State and Tribal Formula Grants (FY25/FY26)", summary: "Federal formula allocations flow through states and Tribes, not a direct open grant for most local project owners.", tradeoff: "A California local entity would need to confirm state subaward pathway and current eligibility; formula allocation window is not an owner application window.", url: "https://www.energy.gov/oe/grid-resilience-state-and-tribal-formula-grants-program", status: "upcoming", deadline: "2027-02-17", applicability: "DOE lists an FY25/FY26 allocation request period through 2027-02-17 for eligible existing state/Tribal grant recipients. Local owner participation depends on state or Tribal program rules." },
  { id: candidateId("funding", "doe-grip"), kind: "funding", title: "DOE Grid Resilience and Innovation Partnerships (GRIP)", summary: "DOE resilience and innovation program; check for later rounds or partner roles in selected projects.", tradeoff: "Prior announced rounds are not evidence of a currently open solicitation or an award opportunity.", url: "https://www.energy.gov/oe/grid-resilience-and-innovation-partnerships-grip", status: "monitor", deadline: null, applicability: "Program historically includes broad domestic entity eligibility, but no current application window is asserted here. Confirm a live FOA and topic fit." },
  { id: candidateId("funding", "cec-cerri"), kind: "funding", title: "CEC Community Energy Reliability and Resilience Investment (CERRI)", summary: "California grid hardening and community resilience funding program; monitor official solicitations.", tradeoff: "Program existence and federal funding do not imply an open application period or local eligibility.", url: "https://www.energy.ca.gov/programs-and-topics/programs/community-energy-reliability-and-resilience-investment-cerri-program", status: "monitor", deadline: null, applicability: "Potential fit for California community resilience projects only when an applicable competitive solicitation is open and the applicant/project meets its terms." },
  { id: candidateId("funding", "cec-gfo-26-501"), kind: "funding", title: "CEC GFO-26-501 climate- and wildfire-resilient electricity research", summary: "Specific California solicitation for open data and modeling work related to a climate- and wildfire-resilient electricity system.", tradeoff: "Research solicitation; do not treat as construction capital. Confirm status and dates in the official notice.", url: "https://www.energy.ca.gov/solicitations/2026-08/gfo-26-501-innovations-open-data-and-modeling-climate-and-wildfire-resilient", status: "monitor", deadline: null, applicability: "Only potentially relevant to eligible research teams and a matching research scope. Current submission window was not confirmed; verify official notice." },
];

const AUTH_SPECS: Omit<AuthorizationTrack, "evidence" | "provenance" | "confidence" | "confidenceScore" | "usefulness" | "rules" | "dependencies" | "tasks">[] = [
  { id: candidateId("authorization", "utility-interconnection"), kind: "authorization", title: "Utility and grid-operator review", summary: "Confirm asset ownership, available capacity, interconnection pathway, protection, and operating authority.", tradeoff: "Utility review does not replace permits or owner approvals.", authority: "Serving electric utility and applicable grid operator" },
  { id: candidateId("authorization", "land-use-permits"), kind: "authorization", title: "Site, land-use, and construction permits", summary: "Identify jurisdiction, site rights, environmental review, building/electrical permits, and construction conditions.", tradeoff: "Jurisdiction and permit scope depend on project location and design; no permit status is assumed.", authority: "Local authority having jurisdiction, landowner, and applicable state/federal agencies" },
  { id: candidateId("authorization", "funding-agreements"), kind: "authorization", title: "Funding and agreement approvals", summary: "Validate applicant eligibility, match, procurement, labor, reporting, and award terms before commitment.", tradeoff: "Funding leads are not awards; obligations may persist through closeout and post-award monitoring.", authority: "Funding administrator and project owner" },
];

const LIFECYCLE: LifecycleStage[] = [
  { id: "screen", title: "Screen and define", description: "Confirm asset, owner, need, baseline, alternatives, and decision authority.", gate: "Owner accepts a documented problem statement and screening assumptions.", evidence: ["asset inventory", "baseline date and units", "owner and decision authority"], owner: "Asset owner", tasks: [task("lifecycle:screen", "confirm asset and baseline", "Asset owner", [], 0, ["scan evidence", "owner records"], "approved problem statement", ["asset inventory", "baseline date and units"], "Reopen screening when asset identity or need changes.")] },
  { id: "develop", title: "Develop and authorize", description: "Complete studies, design basis, site control, permits, funding, procurement plan, and risk review.", gate: "Required approvals and funding authority are recorded before commitment.", evidence: ["engineering basis", "permit register", "funding authorization", "risk and dependency log"], owner: "Project sponsor", tasks: [task("lifecycle:develop", "complete design and approval basis", "Project sponsor", ["lifecycle:screen"], 30, ["problem statement", "owner-confirmed project scope"], "authorized basis and funding decision", ["engineering basis", "permit register", "funding authorization"], "Keep procurement blocked until required authorization is documented.")] },
  { id: "procure", title: "Procure and deliver", description: "Award compliant contracts, verify contractor credentials, manage submittals, construction, safety, and changes.", gate: "Accepted construction records and resolved critical defects.", evidence: ["procurement record", "licenses and insurance", "inspection and change records"], owner: "Delivery manager", tasks: [task("lifecycle:procure", "procure and control delivery", "Delivery manager", ["lifecycle:develop"], 60, ["authorized basis", "procurement conditions"], "accepted construction record", ["procurement record", "licenses and insurance", "inspection and change records"], "Pause work for failed credentials, safety issue, or unapproved change.")] },
  { id: "commission", title: "Commission and hand over", description: "Test performance and safety, close punch items, train operators, and transfer controlled records.", gate: "Commissioning acceptance, operating procedures, and named next owner are approved.", evidence: ["test results", "as-builts", "operator training", "acceptance and warranty records"], owner: "Owner representative", tasks: [task("lifecycle:commission", "test, accept, and hand over", "Owner representative", ["lifecycle:procure"], 240, ["completed asset", "commissioning plan"], "accepted handover package", ["test results", "as-builts", "training", "warranty"], "Track failed tests as open defects; do not mark handover accepted.")] },
  { id: "operate", title: "Operate and renew", description: "Maintain, inspect, monitor performance, manage incidents, renew permits, and reserve for replacement.", gate: "Periodic condition and performance reviews assign actions, dates, and accountable owners.", evidence: ["maintenance log", "condition data", "permit renewals", "replacement reserve"], owner: "Operations lead", tasks: [task("lifecycle:operate", "operate and plan renewal", "Operations lead", ["lifecycle:commission"], 365, ["handover package", "O&M plan"], "condition review and renewal plan", ["maintenance log", "condition data", "permit renewals", "replacement reserve"], "Escalate safety, performance, funding, or permit variance to asset owner.")] },
  { id: "retire", title: "Retire or replace", description: "Plan safe isolation, disposal or reuse, environmental closure, record updates, and successor service.", gate: "Decommissioning obligations are closed and asset register records the disposition.", evidence: ["retirement trigger", "isolation and disposal records", "restoration and closeout"], owner: "Asset owner", tasks: [task("lifecycle:retire", "retire or replace and close records", "Asset owner", ["lifecycle:operate"], 3650, ["condition and renewal records", "decommissioning plan"], "closed asset disposition", ["retirement trigger", "isolation and disposal records", "restoration and closeout"], "Keep asset active in records until isolation, restoration, and closeout are evidenced.")] },
];

function makeInterventions(result: ScanResult, live: LineRatingNow | null, daily: DailyRating[] | null, at: string): OwnerCandidate[] {
  const scanSource = provenance("Area Scan inventory and screening metrics", "scan", at);
  const weatherSource = live ? provenance(`Current line-rating weather (${live.weather.source})`, "live", live.weather.time) : null;
  const historicSource = daily?.length ? provenance(`Historical daily conservative line ratings (${daily.length} days supplied)`, "historical", daily[daily.length - 1].date) : null;
  return INTERVENTION_SPECS.map((spec) => {
    const rules = spec.rules.map((slug) => rule(`${spec.slug}-${slug}`, slug.replaceAll("-", " "), `Owner confirmation required: ${slug.replaceAll("-", " ")}.`, [slug]));
    const baseEvidence = [
      `Scan area: ${result.area_label}; radius ${result.area.radius_mi} mi.`,
      `${result.totals.line_miles.toFixed(1)} line-mi, ${result.totals.substation_count} mapped substations, ${result.totals.nameplate_mw.toFixed(1)} MW mapped generation within scan area.`,
    ];
    const extra = spec.slug === "dynamic-line-rating" && live
      ? [`Current conservative/static ratio ${live.ratio.toFixed(2)} (${live.extra_pct.toFixed(1)}%); this is weather-specific screening, not an authorized rating.`]
      : spec.slug === "dynamic-line-rating" && daily?.length
        ? [`${daily.length} daily records supplied; latest ${daily[daily.length - 1].date}. Historical observations do not establish a current safe operating limit.`]
        : spec.slug === "substation-capacity"
          ? [`${result.totals.hv_substation_count} mapped substations at or above 200 kV; map presence does not establish capacity.`]
          : spec.slug === "renewables-storage"
            ? [`Mapped renewable capacity ${result.totals.renewable_mw.toFixed(1)} MW and storage ${result.totals.storage_mw.toFixed(1)} MW; these totals are screening estimates.`]
            : [];
    const ids = spec.tasks.map((id) => `task:${spec.slug}:${id}`);
    const tasks = spec.tasks.map((slug, index) => task(ids[index], slug.replaceAll("-", " "), index === 0 ? "Owner" : "Engineer", index ? [ids[index - 1]] : [], index * 14, ["owner-confirmed asset and project inputs"], `${slug.replaceAll("-", " ")} decision record`, [...baseEvidence, ...extra], "Record blocker, assign a responsible owner and review date, then revise scope."));
    const riskWeighted = result.risk.factors.reduce((sum, factor) => sum + Math.max(0, Math.min(100, factor.score)) * Math.max(0, factor.weight), 0);
    const heatRisk = result.risk.factors.filter((factor) => /heat|temperature|wildfire|fire/i.test(`${factor.key} ${factor.label}`)).reduce((sum, factor) => sum + Math.max(0, factor.score) * Math.max(0, factor.weight), 0);
    const currentHeat = live?.weather.source === "open-meteo-live" && live.weather.temp_c >= 35 ? 10 : 0;
    const numericEvidenceCount = [result.totals.line_miles > 0, result.totals.substation_count > 0, result.totals.nameplate_mw > 0, Boolean(live), Boolean(daily?.length)].filter(Boolean).length;
    const usefulness = Math.round(Math.max(0, Math.min(100,
      (spec.slug === "microgrid-storage" ? riskWeighted + heatRisk + currentHeat : 0) +
      (spec.slug === "dynamic-line-rating" ? Math.min(35, result.totals.line_miles) + Math.min(35, Math.max(0, (live?.extra_pct ?? (daily?.length ? 10 : 0)))) : 0) +
      (spec.slug === "substation-capacity" ? 15 + 15 * result.totals.hv_substation_count : 0) +
      (spec.slug === "feeder-hardening" ? riskWeighted + heatRisk : 0) +
      (spec.slug === "renewables-storage" ? Math.min(45, result.totals.renewable_mw) + Math.min(30, result.totals.storage_mw) + (result.totals.evening_cover_pct ?? 0) / 2 : 0) +
      numericEvidenceCount * 2,
    )));
    const confidenceScore = Math.max(0.1, Math.min(0.65, 0.15 + numericEvidenceCount * 0.07 + (live?.weather.source === "open-meteo-live" ? 0.08 : 0)));
    return {
      id: candidateId("intervention", spec.slug), kind: "intervention", title: spec.title, summary: spec.summary, tradeoff: spec.tradeoff,
      evidence: [...baseEvidence, ...extra], provenance: [scanSource, ...(weatherSource ? [weatherSource] : []), ...(historicSource ? [historicSource] : [])],
      confidence: confidenceScore >= 0.45 ? "medium" : "low", confidenceScore, usefulness, rules, dependencies: [], tasks,
    };
  });
}

function makeFunding(at: string): FundingCandidate[] {
  return FUNDING_SPECS.map((item) => ({
    ...item,
    evidence: [item.applicability, `Official program page checked ${at.slice(0, 10)}; recheck at time of application.`],
    provenance: [provenance("Official program or solicitation page", "official-program", at, item.url)],
    confidence: "low", confidenceScore: 0.25, usefulness: item.status === "open" ? 55 : item.status === "upcoming" ? 45 : 20,
    rules: [rule(`funding-${canonical(item.id)}`, "Confirm live notice and applicant fit", "Check the official notice, applicant category, project scope, cost share, deadline, and current status.", ["notice-verified", "applicant-fit", "deadline-verified"])],
    dependencies: [], tasks: [
      task(`task:${canonical(item.id)}:confirm-notice`, "confirm current notice and window", "Funding lead", [], 0, ["official program page"], "dated notice and deadline record", [item.url], "If closed or withdrawn, mark unavailable and search the official index for a replacement."),
      task(`task:${canonical(item.id)}:confirm-fit`, "confirm applicant and project fit", "Owner grants lead", [`task:${canonical(item.id)}:confirm-notice`], 7, ["applicant type", "project scope"], "documented fit or mismatch", [item.url], "Record ineligibility or unknown details; do not infer eligibility."),
      task(`task:${canonical(item.id)}:prepare-file`, "prepare internal application decision file", "Owner grants lead", [`task:${canonical(item.id)}:confirm-fit`], 21, ["verified notice", "verified fit", "cost and match evidence"], "go/no-go and approved internal package", [item.url], "Do not submit without required authority, match approval, and final official requirements."),
      task(`task:${canonical(item.id)}:closeout`, "track award duties through closeout", "Award manager", [`task:${canonical(item.id)}:prepare-file`], 365, ["award agreement", "procurement and reporting plan"], "award closeout record", [item.url], "Escalate missed conditions and retain audit records through required retention."),
    ],
  }));
}
function makeAuthorizations(at: string): AuthorizationTrack[] {
  return AUTH_SPECS.map((item) => ({
    ...item,
    evidence: ["Track is a checklist; no agency approval, permit, interconnection, or agreement status is asserted."],
    provenance: [provenance("Infrastructure lifecycle procedures", "scenario", at)], confidence: "low", confidenceScore: 0.2, usefulness: 60,
    rules: [rule(`authorization-${canonical(item.id)}`, "Confirm authority and disposition", "Name the authority, applicable pathway, required submission, status, conditions, and renewal/closeout duty.", ["authority-identified", "pathway-confirmed", "conditions-tracked"])],
    dependencies: [], tasks: [
      task(`task:${canonical(item.id)}:identify`, "identify authority and pathway", "Project sponsor", [], 0, ["project location", "asset and scope"], "authority and pathway record", [], "Escalate jurisdiction uncertainty to counsel or responsible authority."),
      task(`task:${canonical(item.id)}:dossier`, "prepare review dossier", "Project sponsor", [`task:${canonical(item.id)}:identify`], 14, ["design basis", "site rights", "required studies"], "complete review dossier", [], "Record missing prerequisites and responsible owner; do not represent an application as approved."),
      task(`task:${canonical(item.id)}:decision`, "track decision and conditions", "Project sponsor", [`task:${canonical(item.id)}:dossier`], 45, ["submitted dossier", "authority response"], "decision and conditions register", [], "Keep pending, rejected, and conditional decisions visible; assign each condition."),
      task(`task:${canonical(item.id)}:renew`, "track changes, renewal, and closeout", "Asset owner", [`task:${canonical(item.id)}:decision`], 365, ["decision", "conditions", "asset change record"], "renewal or closeout record", [], "Reassess on scope or ownership change; close obligations only with evidence."),
    ],
  }));
}

export function buildOwnerPlan(result: ScanResult, live: LineRatingNow | null, daily: DailyRating[] | null): OwnerPlan {
  const at = nowIso();
  const interventions = makeInterventions(result, live, daily, at);
  const findings: OwnerFinding[] = [
    { id: "finding:grid-capacity", title: "Grid capacity requires owner studies", evidence: [`${result.totals.line_miles.toFixed(1)} mapped line-mi and ${result.totals.substation_count} mapped substations in the scan.`, "Mapped infrastructure is not a capacity or condition assessment."], kind: "gap", optionIds: [interventions[1].id, interventions[2].id, interventions[3].id] },
    { id: "finding:resilience", title: "Resilience options need a defined critical load", evidence: [`${result.totals.renewable_mw.toFixed(1)} MW renewable and ${result.totals.storage_mw.toFixed(1)} MW storage mapped in scan area.`, "No facility-level critical-load profile or outage duration was supplied."], kind: "risk", optionIds: [interventions[0].id, interventions[4].id] },
    { id: "finding:clean-energy", title: "Local clean-energy integration opportunity", evidence: [`Renewable share of mapped nameplate: ${result.totals.renewable_pct.toFixed(1)}%.`], kind: "sustainability", optionIds: [interventions[4].id] },
  ];
  const rules = [...interventions.flatMap((candidate) => candidate.rules), ...makeFunding(at).flatMap((candidate) => candidate.rules), ...makeAuthorizations(at).flatMap((candidate) => candidate.rules)];
  const riskDenominator = result.risk.factors.reduce((sum, factor) => sum + Math.max(0, factor.weight), 0) || 1;
  const topRisks = result.risk.factors.map((factor) => ({
    key: factor.key, label: factor.label, score: factor.score, weight: factor.weight / riskDenominator,
    weightedScore: Math.round(factor.score * factor.weight / riskDenominator * 100) / 100, evidence: factor.detail,
  })).sort((a, b) => b.weightedScore - a.weightedScore).slice(0, 2);
  const evidenceChecks = [
    { label: "mapped generation inventory", present: result.plants.length > 0 },
    { label: "mapped line geometry", present: result.lines.length > 0 },
    { label: "mapped substation inventory", present: result.substations.length > 0 },
    { label: "current local weather observation", present: live?.weather.source === "open-meteo-live" },
    { label: "historical line-rating observations", present: Boolean(daily?.length) },
    { label: "owner-confirmed load, asset condition, and authority", present: false },
  ];
  const evidenceAvailable = evidenceChecks.filter((item) => item.present).length;
  const evidenceExpected = evidenceChecks.length;
  const plan: OwnerPlan = {
    generatedAt: at, area: result.area, areaLabel: result.area_label, confidence: live?.weather.source === "open-meteo-live" || daily?.length ? "medium" : "low",
    confidenceScore: Math.max(0.15, Math.min(0.7, 0.25 + (result.plants.length > 0 ? 0.15 : 0) + (result.lines.length > 0 ? 0.15 : 0) + (result.substations.length > 0 ? 0.1 : 0) + (live?.weather.source === "open-meteo-live" ? 0.05 : 0))),
    provenance: [provenance("Deterministic Area Scan", "scan", at), ...(live ? [provenance(`Live weather: ${live.weather.source}`, "live", live.weather.time)] : []), ...(daily?.length ? [provenance("Historical rating records", "historical", daily[daily.length - 1].date)] : [])],
    findings, interventions, funding: makeFunding(at), authorizations: makeAuthorizations(at), lifecycle: LIFECYCLE, rules,
    topRisks,
    sustainability: {
      summary: `Area scan maps ${result.totals.renewable_mw.toFixed(1)} MW renewable generation (${result.totals.renewable_pct.toFixed(1)}% of mapped nameplate) and ${result.totals.storage_mw.toFixed(1)} MW storage.`,
      evidence: [`Renewable mix: ${result.totals.mw_by_source.solar.toFixed(1)} MW solar, ${result.totals.mw_by_source.wind.toFixed(1)} MW wind, ${result.totals.mw_by_source.hydro.toFixed(1)} MW hydro, ${result.totals.mw_by_source.biogas.toFixed(1)} MW biogas.`, `Storage-to-solar ratio: ${result.totals.evening_cover_pct === null ? "unknown (no mapped solar)" : `${result.totals.evening_cover_pct.toFixed(1)}%`}.`],
      caveat: "Mapped nameplate capacity does not establish dispatch, delivered energy, emissions avoided, interconnection, or project feasibility.",
    },
    nextStep: {
      title: "Confirm the highest-priority asset and operating need with its owner, then request the relevant interval/load and condition records.",
      owner: "Asset owner and utility planning contact", timing: "Before design or funding commitment",
      rationale: "The scan identifies mapped infrastructure and weighted area risks; it does not establish asset ownership, a constraint, or an authorized operating limit.",
    },
    decisionComparison: [
      { option: "defer", summary: "Defer capital commitment while validating the need and funding window.", tradeoff: "Avoids premature spend; leaves the screened exposure unmitigated during the review period.", evidence: ["No owner-confirmed business case, design, or application eligibility is supplied.", ...(topRisks[0] ? [`Highest weighted scan risk: ${topRisks[0].label} (${topRisks[0].weightedScore.toFixed(2)} weighted points).`] : [])] },
      { option: "operate", summary: "Continue current operations under existing approved limits while collecting evidence and completing studies.", tradeoff: "Preserves current authority and service; does not add capacity or resilience and must not exceed approved limits.", evidence: ["Existing operating authority and limits were not provided; verify them with the asset owner and operator.", "No proposed intervention should be treated as approved or operational from this screen."] },
    ],
    confidenceGap: {
      score: Math.round(evidenceAvailable / evidenceExpected * 100), gap: Math.round((1 - evidenceAvailable / evidenceExpected) * 100),
      evidenceAvailable, evidenceExpected, missing: evidenceChecks.filter((item) => !item.present).map((item) => item.label),
      meaning: "Evidence coverage is a completeness score, not a probability of project success, eligibility, approval, or safety.",
    },
  };
  const errors = validateOwnerPlan(plan);
  if (errors.length) throw new Error(`Invalid owner plan: ${errors.join("; ")}`);
  return plan;
}

/** Evaluate evidence completeness for one option; this is not eligibility, recommendation, or approval. */
export function evaluateRules(plan: OwnerPlan, answers: Record<string, TriState>, selectedCandidateId?: string): RuleEvaluationResult {
  const candidates = [...plan.interventions, ...plan.funding, ...plan.authorizations];
  const selected = selectedCandidateId ? candidates.find((candidate) => candidate.id === selectedCandidateId) : null;
  const scopedRules = selectedCandidateId ? selected?.rules ?? [] : plan.rules;
  const evaluations = scopedRules.map((r) => {
    const answer = answers[r.id] ?? "unknown";
    const missing = answer === "yes" ? [] : [...r.required];
    const status: RuleStatus = answer === "yes" ? "pass" : answer === "no" ? "fail" : "unknown";
    return { ruleId: r.id, answer, status, missing };
  });
  const ready = evaluations.some((item) => item.status === "fail") ? false : evaluations.every((item) => item.status === "pass") ? true : null;
  return { candidateId: selectedCandidateId ?? null, evaluations, ready };
}

/** Validate stable IDs, references, task dependencies, rule uniqueness, and DAG acyclicity. */
export function validateOwnerPlan(plan: OwnerPlan): string[] {
  const errors: string[] = [];
  const candidates = [...plan.interventions, ...plan.funding, ...plan.authorizations];
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) errors.push(`duplicate candidate id ${candidate.id}`);
    ids.add(candidate.id);
    for (const dependency of candidate.dependencies) if (!ids.has(dependency) && !candidates.some((x) => x.id === dependency)) errors.push(`${candidate.id} has unknown dependency ${dependency}`);
    const taskIds = new Set(candidate.tasks.map((item) => item.id));
    if (taskIds.size !== candidate.tasks.length) errors.push(`${candidate.id} has duplicate task ids`);
    const edges = new Map(candidate.tasks.map((item) => [item.id, item.dependsOn]));
    for (const item of candidate.tasks) for (const dep of item.dependsOn) if (!taskIds.has(dep)) errors.push(`${item.id} has unknown task dependency ${dep}`);
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      visiting.add(id);
      for (const dep of edges.get(id) ?? []) if (!visit(dep)) return false;
      visiting.delete(id); visited.add(id); return true;
    };
    for (const id of taskIds) if (!visit(id)) { errors.push(`${candidate.id} task dependencies contain a cycle`); break; }
  }
  if (plan.interventions.length !== 5) errors.push("expected exactly five grid interventions");
  if (plan.funding.length !== 5) errors.push("expected exactly five funding candidates");
  if (plan.authorizations.length !== 3) errors.push("expected exactly three authorization tracks");
  const ruleIds = plan.rules.map((item) => item.id);
  if (new Set(ruleIds).size !== ruleIds.length) errors.push("duplicate rule id");
  for (const finding of plan.findings) for (const option of finding.optionIds) if (!ids.has(option)) errors.push(`${finding.id} references unknown option ${option}`);
  const allTaskIds = new Set<string>();
  for (const candidate of candidates) for (const item of candidate.tasks) {
    if (allTaskIds.has(item.id)) errors.push(`duplicate task id ${item.id}`);
    allTaskIds.add(item.id);
  }
  const globalEdges = new Map<string, string[]>();
  for (const candidate of candidates) for (const item of candidate.tasks) globalEdges.set(item.id, item.dependsOn);
  for (const stage of plan.lifecycle) for (const item of stage.tasks) {
    if (allTaskIds.has(item.id) || globalEdges.has(item.id)) errors.push(`duplicate task id ${item.id}`);
    globalEdges.set(item.id, item.dependsOn);
  }
  for (const [id, deps] of globalEdges) for (const dep of deps) if (!globalEdges.has(dep)) errors.push(`${id} has unknown global dependency ${dep}`);
  const visiting = new Set<string>(), visited = new Set<string>();
  const visitGlobal = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dep of globalEdges.get(id) ?? []) if (!visitGlobal(dep)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  for (const id of globalEdges.keys()) if (!visitGlobal(id)) { errors.push("owner plan task dependencies contain a cross-module cycle"); break; }
  return errors;
}

export type OwnerPlanFixtureId = "westminster-critical-microgrid" | "substation-expansion" | "water-main-renewal" | "wastewater-treatment-upgrade" | "bridge-rehabilitation" | "rural-fiber";
export type FixtureLifecyclePhase = "screen" | "fund-permit" | "procure" | "deliver-commission" | "operate-renew" | "retire";
export interface FixtureLifecycleTask {
  id: string; phase: FixtureLifecyclePhase; title: string; owner: string; prerequisites: string[];
  dependsOn: string[]; deliverable: string; evidence: string[]; recovery: string;
}
export interface OwnerPlanFixture {
  id: OwnerPlanFixtureId; sector: "electric" | "water" | "wastewater" | "transport" | "telecom"; title: string; synthetic: true;
  objective: string; topRisks: string[]; sustainabilityEvidence: string[]; nextStep: string;
  defer: string; operate: string; confidenceScore: number; confidenceGap: number; missingEvidence: string[]; notes: string[];
  lifecycle: FixtureLifecycleTask[];
}
/** Full synthetic decision fixtures. Sector-specific facts never come from the electrical scan. */
const FIXTURE_SUMMARIES: Omit<OwnerPlanFixture, "lifecycle">[] = [
  { id: "westminster-critical-microgrid", sector: "electric", title: "Westminster critical-facility microgrid", synthetic: true, objective: "Maintain critical facility service through defined grid outages.", topRisks: ["Unconfirmed critical-load profile and islanding duration", "Interconnection and protection approval not established"], sustainabilityEvidence: ["Pair local renewable generation with storage only after hourly load and resource matching."], nextStep: "Request interval load and outage-duration records from the facility owner.", defer: "Delay capital selection until resilience need and site control are confirmed.", operate: "Continue within utility-approved limits while studying backup configuration.", confidenceScore: 32, confidenceGap: 68, missingEvidence: ["critical loads", "outage duration", "site control", "interconnection study"], notes: ["Synthetic scenario; not an actual facility recommendation."] },
  { id: "substation-expansion", sector: "electric", title: "Substation expansion", synthetic: true, objective: "Resolve an owner-confirmed transformer or contingency constraint.", topRisks: ["Capacity and contingency headroom are unknown", "Load forecast and equipment condition are absent"], sustainabilityEvidence: ["Evaluate non-wires alternatives and efficiency before sizing new equipment."], nextStep: "Obtain utility asset condition, peak loading, and contingency study records.", defer: "Hold expansion commitment until planning study identifies a need and alternatives.", operate: "Operate on current approved settings and limits; do not assume spare capacity.", confidenceScore: 28, confidenceGap: 72, missingEvidence: ["asset owner", "load forecast", "contingency study", "condition assessment"], notes: ["Synthetic scenario; mapped presence does not establish capacity."] },
  { id: "water-main-renewal", sector: "water", title: "Water main renewal", synthetic: true, objective: "Prioritize renewal using break history, condition, and service criticality.", topRisks: ["Failure likelihood and consequence are unverified", "Hydraulic redundancy and isolation points are unknown"], sustainabilityEvidence: ["Compare leakage reduction and pumping energy after hydraulic model validation."], nextStep: "Request utility break history, condition survey, and hydraulic model.", defer: "Defer replacement ranking until asset and failure records are reconciled.", operate: "Continue inspection and emergency response under existing water safety procedures.", confidenceScore: 18, confidenceGap: 82, missingEvidence: ["pipe age/material", "break history", "hydraulic model", "critical customers"], notes: ["Water-sector facts are not inferred from the electrical scan."] },
  { id: "wastewater-treatment-upgrade", sector: "wastewater", title: "Wastewater treatment upgrade", synthetic: true, objective: "Meet documented process, permit, and resilience requirements.", topRisks: ["Permit limits and process capacity are unknown", "Backup power and discharge risks are unverified"], sustainabilityEvidence: ["Assess energy recovery and aeration efficiency against measured plant energy use."], nextStep: "Collect permit, process, energy, and backup-power records from the operator.", defer: "Avoid design commitment before permit and process requirements are confirmed.", operate: "Maintain current permit-compliant operating procedures and alarm response.", confidenceScore: 20, confidenceGap: 80, missingEvidence: ["permit conditions", "process loading", "condition assessment", "backup power test"], notes: ["Wastewater facts are not inferred from the electrical scan; permit and process conditions require owner inputs."] },
  { id: "bridge-rehabilitation", sector: "transport", title: "Bridge rehabilitation", synthetic: true, objective: "Address verified condition and load-rating needs while maintaining safe access.", topRisks: ["Structural condition and load rating are not supplied", "Detour and construction impacts are unassessed"], sustainabilityEvidence: ["Compare rehabilitation life extension and embodied materials with replacement alternatives."], nextStep: "Obtain latest inspection, load rating, and detour analysis from the bridge authority.", defer: "Defer scope selection until inspection severity and funding authority are confirmed.", operate: "Keep posted restrictions and inspection schedule under the bridge owner’s control.", confidenceScore: 22, confidenceGap: 78, missingEvidence: ["inspection report", "load rating", "traffic counts", "detour plan"], notes: ["Transportation facts are not inferred from the electrical scan; condition and load rating require authority records."] },
  { id: "rural-fiber", sector: "telecom", title: "Rural fiber", synthetic: true, objective: "Close verified coverage gaps with maintainable route and backhaul design.", topRisks: ["Coverage gap and demand are not measured", "Route rights, backhaul, and power resilience are unknown"], sustainabilityEvidence: ["Evaluate shared conduit and efficient network equipment where lifecycle and reliability support it."], nextStep: "Validate serviceability map, demand, route rights, and backhaul options with the provider.", defer: "Hold construction commitment until coverage and permitting are verified.", operate: "Continue current service and outage support while route options are validated.", confidenceScore: 16, confidenceGap: 84, missingEvidence: ["coverage map", "demand forecast", "route rights", "backhaul design"], notes: ["Telecom facts are not inferred from the electrical scan; coverage and route facts require provider records."] },
];

type FixtureTaskSpec = Omit<FixtureLifecycleTask, "id" | "dependsOn">;
const FIXTURE_TASKS: Record<OwnerPlanFixtureId, FixtureTaskSpec[]> = {
  "westminster-critical-microgrid": [
    { phase: "screen", title: "Verify critical loads and outage duration", owner: "Facility energy manager", prerequisites: ["Owner access to interval meter and emergency-load schedule"], deliverable: "Approved critical-load baseline and resilience objective", evidence: ["15-minute meter data", "critical-load inventory", "outage history"], recovery: "If load data or decision authority is missing, keep design unscoped and assign a data owner." },
    { phase: "fund-permit", title: "Secure funding path and interconnection / permit basis", owner: "Project sponsor and utility planner", prerequisites: ["Approved screening baseline", "Site control"], deliverable: "Dated funding decision, Rule 21 pathway, and permit register", evidence: ["Live funding notice", "utility study request", "city permit determination"], recovery: "If funding window is missed or utility/permit pathway is uncertain, pause commitment and reschedule only after written confirmation." },
    { phase: "procure", title: "Procure qualified storage and microgrid controls", owner: "Procurement lead", prerequisites: ["Approved design basis", "Funding authority", "Interconnection conditions"], deliverable: "Compliant award and approved equipment submittals", evidence: ["Competitive procurement record", "contractor license", "battery and inverter certifications"], recovery: "Reject unlicensed bids or equipment that misses protection, fire-code, or interconnection requirements; rebid before mobilization." },
    { phase: "deliver-commission", title: "Install and demonstrate island / resynchronization sequence", owner: "Commissioning agent", prerequisites: ["Accepted equipment", "Approved switching and safety plan"], deliverable: "Signed acceptance and witnessed test report", evidence: ["As-builts", "protection settings", "black-start and island test", "training records"], recovery: "Failed commissioning blocks acceptance and energization; correct defects, retest, and retain open punch items." },
    { phase: "operate-renew", title: "Operate storage and renew operating approvals", owner: "Facility operations lead", prerequisites: ["Accepted commissioning package", "Trained operators"], deliverable: "Annual O&M review, tested procedures, and renewal calendar", evidence: ["Battery health logs", "alarm / incident log", "permit and interconnection renewals"], recovery: "If tests, equipment health, or permit renewal lapse, use approved backup procedures and notify the authority before returning to service." },
    { phase: "retire", title: "Isolate and close battery / controls disposition", owner: "Asset owner", prerequisites: ["Approved retirement trigger", "Hazardous-material and utility isolation plan"], deliverable: "Closed disposition and restored site record", evidence: ["Isolation certificate", "battery recycling manifest", "site restoration and asset-register update"], recovery: "Keep equipment in the asset register until safe isolation, compliant recycling, and site closeout are verified." },
  ],
  "substation-expansion": [
    { phase: "screen", title: "Confirm transformer constraint and load forecast", owner: "Utility planning engineer", prerequisites: ["Asset identity and owner confirmation"], deliverable: "Validated peak-load and contingency problem statement", evidence: ["SCADA loading", "condition assessment", "forecast and contingency study"], recovery: "If load or equipment evidence does not confirm a constraint, close the expansion screen and compare non-wires options." },
    { phase: "fund-permit", title: "Approve capital, land, and regulatory pathway", owner: "Utility project sponsor", prerequisites: ["Study-confirmed need", "Alternatives analysis"], deliverable: "Funded project authorization and permit / land register", evidence: ["Capital approval", "site rights", "environmental and construction permits"], recovery: "If funding approval or a required permit is missed, hold notice-to-proceed and refresh schedule and estimate." },
    { phase: "procure", title: "Award transformer and protection package", owner: "Utility procurement lead", prerequisites: ["Approved equipment specification", "Site and permit readiness"], deliverable: "Executed compliant contract and accepted submittals", evidence: ["Bid evaluation", "manufacturer qualification", "transformer and relay data sheets"], recovery: "Reject equipment failing ratings, delivery tests, or approved vendor requirements; secure a compliant replacement before installation." },
    { phase: "deliver-commission", title: "Construct, test protection, and energize", owner: "Construction manager and commissioning engineer", prerequisites: ["Accepted equipment", "Approved outage / switching plan"], deliverable: "Energization authorization and signed test dossier", evidence: ["Inspection records", "relay injection tests", "oil / factory test results", "as-builts"], recovery: "Do not energize on failed protection or equipment tests; correct, retest, and obtain operator release." },
    { phase: "operate-renew", title: "Monitor loading, condition, and maintenance renewals", owner: "Substation operations lead", prerequisites: ["Accepted commissioning dossier"], deliverable: "Condition-based maintenance and renewal plan", evidence: ["Thermal / dissolved-gas monitoring", "inspection logs", "maintenance and permit calendar"], recovery: "Escalate abnormal condition and missed maintenance; apply approved operating limit until equipment is cleared." },
    { phase: "retire", title: "De-energize and dispose or redeploy equipment", owner: "Asset owner", prerequisites: ["Replacement in service or approved retirement plan"], deliverable: "Closed work order and updated asset register", evidence: ["Isolation / grounding record", "oil disposal manifest", "site restoration"], recovery: "Keep asset active until isolation, regulated-material disposition, and closeout are signed." },
  ],
  "water-main-renewal": [
    { phase: "screen", title: "Rank pipe segments using failures and condition", owner: "Water utility asset manager", prerequisites: ["Verified pipe inventory and service area"], deliverable: "Prioritized renewal segment and hydraulic baseline", evidence: ["Break history", "material / age records", "pressure and customer criticality"], recovery: "If asset identity or break records conflict, inspect and reconcile before ranking." },
    { phase: "fund-permit", title: "Secure grant / capital path and excavation permits", owner: "Water capital-program manager", prerequisites: ["Approved segment priority", "Hydraulic continuity plan"], deliverable: "Funding decision, right-of-way and street-work permits", evidence: ["Current funding notice", "city encroachment permits", "environmental review"], recovery: "If the application window or street permit is missed, defer award and maintain leak response until a valid path is secured." },
    { phase: "procure", title: "Award pipe, fittings, and construction contract", owner: "Water procurement lead", prerequisites: ["Approved materials specification", "Permit conditions and budget"], deliverable: "Executed contract with accepted pipe and joint submittals", evidence: ["Procurement record", "contractor credentials", "pressure-class and potable-water certifications"], recovery: "Reject unqualified contractor or nonconforming pipe/fittings; replace submittal before excavation." },
    { phase: "deliver-commission", title: "Install, disinfect, pressure-test, and return to service", owner: "Resident engineer", prerequisites: ["Approved traffic and isolation plan", "Accepted materials"], deliverable: "Accepted segment and service restoration record", evidence: ["Inspection log", "pressure / leakage test", "disinfection and bacteriological results"], recovery: "Failed pressure or water-quality test blocks service acceptance; repair, flush, retest, and notify affected customers." },
    { phase: "operate-renew", title: "Track leakage, valve exercising, and renewal triggers", owner: "Water operations lead", prerequisites: ["Accepted as-builts and valve map"], deliverable: "Updated condition and renewal schedule", evidence: ["Leak / outage log", "valve exercise record", "pressure and water-quality monitoring"], recovery: "If monitoring or inspection lapses, restore the schedule and use conservative isolation / response procedures until verified." },
    { phase: "retire", title: "Abandon or remove replaced pipe safely", owner: "Water asset owner", prerequisites: ["New main accepted and customers transferred"], deliverable: "Closed abandonment permit and GIS asset update", evidence: ["Isolation and abandonment record", "disposal manifest", "restoration inspection"], recovery: "Do not mark retired until the old main is isolated, abandoned per permit, and mapped as inactive." },
  ],
  "wastewater-treatment-upgrade": [
    { phase: "screen", title: "Confirm process bottleneck and permit limits", owner: "Treatment plant process engineer", prerequisites: ["Operator access to flow, loading, and permit records"], deliverable: "Approved process basis and compliance gap statement", evidence: ["Influent / effluent trends", "permit limits", "equipment condition and backup-power test"], recovery: "If process or compliance need is unverified, retain existing permit controls and collect representative samples." },
    { phase: "fund-permit", title: "Secure funding, discharge review, and construction permits", owner: "Plant manager and grants lead", prerequisites: ["Documented process need", "Constructability and bypass plan"], deliverable: "Funding decision and permit modification / construction approvals", evidence: ["Live grant notice", "NPDES review", "building and environmental permits"], recovery: "If funding or permit approval is missed, do not begin process changes; maintain current compliant operation and reapply or rescope." },
    { phase: "procure", title: "Buy treatment equipment and award installation", owner: "Procurement officer", prerequisites: ["Approved process design", "Permit conditions in specifications"], deliverable: "Executed procurement and compliant equipment submittals", evidence: ["Bid record", "vendor credentials", "materials and control-system certifications"], recovery: "Reject equipment that cannot meet permit/design requirements or lacks qualified service support; correct the package before award." },
    { phase: "deliver-commission", title: "Install, validate process performance, and hand over", owner: "Commissioning engineer", prerequisites: ["Accepted equipment", "Approved bypass and startup plan"], deliverable: "Signed process acceptance and operator handover", evidence: ["Functional tests", "effluent sampling", "alarm / backup-power test", "training"], recovery: "Failed performance or effluent tests block acceptance; restore prior process mode, correct defects, and repeat the required test period." },
    { phase: "operate-renew", title: "Maintain process assets and renew discharge obligations", owner: "Wastewater operations lead", prerequisites: ["Accepted performance baseline and O&M manuals"], deliverable: "Maintenance, sampling, and permit-renewal calendar", evidence: ["Compliance monitoring reports", "maintenance records", "permit renewal docket"], recovery: "Escalate missed sampling, maintenance, or renewal deadlines immediately; follow permit notifications and corrective-action rules." },
    { phase: "retire", title: "Decommission replaced process equipment", owner: "Plant asset owner", prerequisites: ["Replacement accepted and process safely transferred"], deliverable: "Closed equipment disposition and site records", evidence: ["Lockout / isolation", "residuals / chemical disposal records", "asset-register update"], recovery: "Keep old equipment in service records until isolation, regulated residual disposal, and environmental closeout are documented." },
  ],
  "bridge-rehabilitation": [
    { phase: "screen", title: "Validate inspection findings and load rating", owner: "Bridge program engineer", prerequisites: ["Bridge ID and authority record match"], deliverable: "Approved condition, load-rating, and detour basis", evidence: ["Inspection report", "load rating", "traffic counts", "scour / seismic records"], recovery: "If inspection or rating is missing or conflicting, obtain a current inspection and maintain posted restrictions." },
    { phase: "fund-permit", title: "Secure transportation funding and waterway / traffic permits", owner: "Transportation grants manager", prerequisites: ["Approved rehabilitation scope and detour plan"], deliverable: "Funding authorization and permit / public-notice register", evidence: ["Current grant notice", "environmental clearance", "road closure and waterway permits"], recovery: "If award or permit is delayed, defer mobilization and retain restrictions/inspection frequency until approvals are in force." },
    { phase: "procure", title: "Award qualified bridge contractor and materials", owner: "Public works procurement lead", prerequisites: ["Approved plans and specifications", "Funding and permit conditions"], deliverable: "Compliant contract and accepted product submittals", evidence: ["Bid tabulation", "contractor licenses / bonds", "steel / concrete certificates"], recovery: "Reject lapsed credentials, failed material tests, or nonconforming submittals; rebid or replace before work starts." },
    { phase: "deliver-commission", title: "Rehabilitate, inspect, and reopen by approved load rating", owner: "Resident bridge engineer", prerequisites: ["Accepted materials", "Traffic control and safety plans"], deliverable: "Engineer acceptance and posted operating condition", evidence: ["Inspection hold points", "material tests", "load test / rating update", "as-builts"], recovery: "Failed inspection or load test keeps restrictions in place; repair, reinspect, update rating, then obtain authority release." },
    { phase: "operate-renew", title: "Inspect, maintain, and renew operating restrictions", owner: "Bridge maintenance manager", prerequisites: ["Accepted rehabilitation and updated inventory"], deliverable: "Inspection and maintenance schedule with renewal triggers", evidence: ["Routine / underwater inspections", "repair log", "permit and traffic-control renewals"], recovery: "If inspection or permit renewal is missed, notify the bridge authority and apply its conservative restrictions until current." },
    { phase: "retire", title: "Replace or decommission bridge safely", owner: "Bridge owner", prerequisites: ["Replacement route / successor service plan"], deliverable: "Closed demolition and restoration record", evidence: ["Closure and utility-clearance records", "debris disposition", "waterway / site restoration"], recovery: "Keep bridge on the active inventory until closure, safe demolition, environmental restoration, and record updates are complete." },
  ],
  "rural-fiber": [
    { phase: "screen", title: "Confirm coverage gap, demand, and backhaul", owner: "Network planning lead", prerequisites: ["Provider serviceability and route records"], deliverable: "Validated coverage / demand case and route alternatives", evidence: ["Address-level coverage map", "demand forecast", "backhaul capacity and route survey"], recovery: "If demand or route data is incomplete, do not size construction; survey and reconcile provider records." },
    { phase: "fund-permit", title: "Secure broadband funding and right-of-way approvals", owner: "Broadband program manager", prerequisites: ["Validated service gap", "Route rights and match plan"], deliverable: "Funding decision, pole attachment / ROW agreements, and permits", evidence: ["Live grant notice", "utility pole approvals", "local excavation permits"], recovery: "If grant deadline or route permission is missed, defer construction and maintain service with current arrangements until reauthorized." },
    { phase: "procure", title: "Award qualified fiber construction and electronics", owner: "Telecom procurement lead", prerequisites: ["Approved route design", "Permit conditions and backhaul agreement"], deliverable: "Executed contract and accepted cable / electronics submittals", evidence: ["Procurement record", "contractor safety credentials", "fiber and powered-equipment certifications"], recovery: "Reject expired credentials or equipment failing optical, environmental, or interoperability specs; replace before deployment." },
    { phase: "deliver-commission", title: "Build route, splice, test, and activate service", owner: "Network delivery manager", prerequisites: ["Accepted equipment", "Approved traffic and utility locate plans"], deliverable: "Accepted route, tested optical budget, and service handoff", evidence: ["As-built route", "splice loss / OTDR tests", "backhaul failover and customer turn-up"], recovery: "Failed optical or failover tests block activation; repair splices/equipment and repeat end-to-end acceptance." },
    { phase: "operate-renew", title: "Monitor service, repair outages, renew easements", owner: "Network operations lead", prerequisites: ["Accepted as-builts and escalation contacts"], deliverable: "O&M and easement renewal register", evidence: ["Availability / outage log", "preventive maintenance", "ROW and pole-agreement renewals"], recovery: "If monitoring or rights renewal lapses, escalate to provider/landowner and restore service or legal access before resuming expansion." },
    { phase: "retire", title: "Remove or reuse obsolete route equipment", owner: "Network asset owner", prerequisites: ["Replacement service active and customers migrated"], deliverable: "Closed retirement and e-waste disposition", evidence: ["Customer migration record", "cable / electronics recycling manifest", "route and asset-register update"], recovery: "Keep assets active until customer migration, safe power isolation, e-waste disposition, and easement closeout are verified." },
  ],
};
const FIXTURE_PHASES: FixtureLifecyclePhase[] = ["screen", "fund-permit", "procure", "deliver-commission", "operate-renew", "retire"];
function buildFixtureTasks(fixtureId: OwnerPlanFixtureId): FixtureLifecycleTask[] {
  const specs = FIXTURE_TASKS[fixtureId];
  if (specs.length !== FIXTURE_PHASES.length || specs.some((spec, index) => spec.phase !== FIXTURE_PHASES[index])) throw new Error(`Invalid fixture lifecycle: ${fixtureId}`);
  return specs.map((spec, index) => {
    const id = `fixture:${fixtureId}:${spec.phase}`;
    return { ...spec, id, dependsOn: index === 0 ? [] : [`fixture:${fixtureId}:${FIXTURE_PHASES[index - 1]}`] };
  });
}
export const OWNER_PLAN_FIXTURES: OwnerPlanFixture[] = FIXTURE_SUMMARIES.map((fixture) => ({ ...fixture, lifecycle: buildFixtureTasks(fixture.id) }));
export function getOwnerPlanFixture(id: OwnerPlanFixtureId): OwnerPlanFixture {
  const fixture = OWNER_PLAN_FIXTURES.find((item) => item.id === id);
  if (!fixture) throw new Error(`Unknown owner plan fixture: ${id}`);
  return structuredClone(fixture);
}
