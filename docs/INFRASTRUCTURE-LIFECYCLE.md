# Mapergy infrastructure lifecycle

Status: implementation specification. This document defines a screening and project-delivery system; a modeled result is not a permit, engineering opinion, utility commitment, or regulatory clearance.

Mapergy’s current app is an energy-focused regional screening prototype. Its existing contracts in `lib/types.ts`, Area Scan in `lib/scan/areaScan.ts`, physics engine under `lib/physics/`, and source-backed evidence layer under `lib/evidence/` are useful inputs, not a project-delivery data model. Keep this roadmap additive; do not silently reinterpret the frozen facility and simulation contracts.

Related contracts: [Infrastructure workflows](INFRASTRUCTURE-WORKFLOWS.md) defines the 12 modules and their user actions. [Infrastructure cases](INFRASTRUCTURE-CASES.md) defines six cases and the coverage matrix. Those documents should map every module to lifecycle entities and every case to required evidence, authority, decision, and output.

## 1. Product boundary and intake sequence

The product moves from regional screening to an owner-verified project record in three evidence stages:

1. **Area Scan (PR #2 seed):** user selects a point/polygon and scope. Return nearby candidate assets, constraints, approximate network context, coverage gaps, and sources. A scan creates a project workspace and candidate records, not confirmed assets or site control.
2. **Studies evidence (PR #1):** attach or import study findings, utility correspondence, engineering assessments, environmental/cultural studies, and source documents. Every extracted fact retains its source, locator, date, author, method, confidence, and review state.
3. **Validated candidate inventory (PR #3):** reconcile source IDs, aliases, geometry, ownership/operator, and identity. An authorized owner representative verifies asset identity, condition, site control/rights, and applicable authorities. Verification is explicit, scoped, dated, and attributable. It never means a regulator or utility has approved the project.

Manual entry is a first-class intake route at every stage. It must capture author, entered-at time, basis/source or reason unavailable, units, and review status. Do not force users to invent evidence to satisfy a required field: represent unavailable as `unknown`, `not_assessed`, or `not_applicable` with a reason. Imported public data, model output, user assertion, and owner-verified facts remain distinct.

## 2. Domain model and public interfaces

Use stable opaque IDs (UUID/ULID), UTC timestamps, explicit units, and immutable revisions. The following TypeScript shapes are conceptual public interfaces; implementations may use branded IDs and normalized tables. Never store a mutable current value without its revision and provenance.

```ts
type Id = string;
type TriState = "yes" | "no" | "unknown";
type ReviewState = "unreviewed" | "accepted" | "rejected" | "superseded";
type FactKind = "observed" | "derived" | "modeled" | "inferred" | "asserted";
interface Project { id: Id; name: string; status: ProjectStatus; geography: GeometryRef; segments: SegmentRef[]; ownerOrgId: Id; revision: number; createdAt: string; updatedAt: string }
interface SegmentRef { segmentId: Id; role: "site" | "interconnection" | "route" | "access" | "other" }
interface Asset { id: Id; projectId: Id; assetType: string; geometry: GeometryRef | null; identity: FactRef<string>; sourceIds: SourceIdentifier[]; status: "candidate" | "validated" | "rejected" | "retired"; revision: number }
interface SourceIdentifier { namespace: string; value: string; sourceId: Id; validFrom: string | null; validTo: string | null }
interface Fact<T> { id: Id; subjectId: Id; predicate: string; value: T | null; unit: string | null; kind: FactKind; validTime: TimeInterval; recordedAt: string; sourceIds: Id[]; method: string | null; confidence: number | null; review: ReviewState; reviewerId: Id | null; supersedes: Id | null; revision: number }
interface Evidence { id: Id; projectId: Id; source: SourceRef; locator: string | null; contentHash: string | null; capturedAt: string | null; publishedAt: string | null; author: string | null; access: "public" | "project" | "restricted"; redaction: RedactionState; revision: number }
interface Authority { id: Id; jurisdictionId: Id; authorityType: string; name: string; officialSourceIds: Id[]; verifiedAt: string | null; reviewerId: Id | null; review: ReviewState }
interface Authorization { id: Id; projectId: Id; actorId: Id; scope: string[]; basis: string; authorityId: Id | null; validFrom: string; validTo: string | null; status: "proposed" | "active" | "expired" | "revoked"; evidenceIds: Id[]; revision: number }
```

`ProjectStatus` should cover at least `screening`, `candidate`, `preconstruction`, `delivery`, `operating`, `retirement`, and `archived`; detailed gates belong to workflows, not a single overloaded status. `GeometryRef` identifies geometry and CRS explicitly. `TimeInterval` uses half-open validity `[from, to)`; unknown endpoints are null. A `FactRef<T>` points to a fact revision, not a copied literal.

### Facts and evidence rules

A fact separates valid time (when true in the world) from recorded time (when learned). Corrections append a superseding revision; they do not overwrite history. Derived/modelled facts store the input fact revision IDs, rule/model version, parameters, and deterministic output hash. Confidence is optional and must not be presented as probability unless calibrated. Conflicting facts coexist until adjudicated; consumers receive conflict/unknown, never arbitrary last-write-wins.

Evidence metadata and content access are separate. Keep source URL/publisher, retrieval timestamp, content hash, and stable locator where legally permitted; content may be unavailable or redacted. Redaction records actor, timestamp, reason, scope, and a retained hash where possible. Authorization is least-privilege, time-bounded, revocable, and cannot be inferred from ownership or project membership. Audit reads of restricted evidence and all authorization changes.

## 3. Multi-segment jurisdiction and rule packs

A project may include site, interconnection, transmission, access, water, and other segments crossing municipal, county, state, federal, tribal, utility-territory, and other boundaries. Resolve coverage independently per segment and authority domain. Never assign one project-wide jurisdiction by centroid or majority area. Boundary ambiguity and missing jurisdiction geometry produce `unknown` plus a coverage issue requiring review.

A rule pack is an immutable, versioned, reviewable collection of requirements and official sources:

```ts
interface RulePack { id: Id; jurisdictionId: Id; domain: string; version: string; effectiveFrom: string; effectiveTo: string | null; publishedAt: string; status: "draft" | "reviewed" | "active" | "superseded"; sourceIds: Id[]; rules: Rule[]; reviewedBy: Id | null; reviewedAt: string | null; contentHash: string }
interface Rule { id: Id; predicate: string; applicability: string; requirement: string; outcome: TriState; rationale: string | null; sourceIds: Id[]; effectiveFrom: string; effectiveTo: string | null; review: ReviewState }
interface RuleEvaluation { rulePackId: Id; ruleId: Id; projectRevision: number; outcome: TriState; inputFactIds: Id[]; evaluatedAt: string; engineVersion: string; explanation: string; missingInputs: string[] }
```

Rules may express applicability, evidence requirements, deadlines, and sequencing; they do not make legal determinations. Official sources must identify issuing authority, document/page, URL or archival locator, publication/effective dates, retrieval date, and verification status. Mark sources `verified` only after a named reviewer confirms the official source and relevant passage; record review date. Preserve prior packs and evaluations.

On source or rule changes, calculate a structured diff: added/removed/changed rules, effective-date transitions, affected projects/segments, and evaluations whose inputs or pack version changed. Mark affected evaluations stale and queue review; do not silently rewrite prior decisions. Surface `unknown` coverage when no active reviewed pack covers a segment/domain/date, and provide a coverage report with reason (no source, unresolved boundary, expired pack, pending review, or unsupported domain). Effective-date evaluation uses the relevant activity/decision date and shows the chosen date and pack version.

## 4. Decision, submission, conditions, expiry

Represent separate records for internal decision support, external submission, and imposed/accepted conditions:

- **Decision record:** question, decision owner, alternatives considered, evidence/fact/rule/model revisions, rationale, outcome (`proceed`, `hold`, `stop`, `unknown`), date, expiry/revisit trigger, and sign-off. It is a project governance record, not authority approval.
- **Submission record:** receiving authority, submission type, exact frozen package revision and attachment hashes, submitter authorization, sent/received timestamps, external reference, and response evidence. Draft, submitted, acknowledged, returned, withdrawn, and closed are distinct states. A generated package is not a submitted application.
- **Condition record:** verbatim/source-linked condition, issuing authority, applicability, responsible party, due date or trigger, evidence of satisfaction, reviewer, and status (`open`, `in_progress`, `evidence_submitted`, `verified`, `waived_by_authority`, `overdue`, `disputed`, `closed`). Only a documented authorized disposition closes or waives a condition.

Any approval, permit, study, authorization, or condition with an expiry or trigger stores it explicitly. Scheduled evaluation marks expired/approaching-expiry and identifies dependent decisions/submissions; it never extends validity. Missing expiry is `unknown`, not perpetual. Track appeal, amendment, renewal, and superseding decisions as new linked records.

## 5. Change impact, dependencies, dates, and alternatives

Fact changes propagate through a dependency graph: changed fact revision → affected derived facts/models → rule evaluations → decision records → package/submission readiness → conditions and schedule. Each edge names dependency type and recalculation policy. Recompute deterministic derived outputs; mark human-reviewed decisions and external submissions `review_required` or `potentially_affected`, never auto-approve or silently mutate their frozen snapshots. An impact preview lists old/new fact, downstream records, urgency, and reason before users accept the new project revision.

Schedule items need stable IDs, duration/calendar assumptions, predecessors, constraints, owner, evidence basis, baseline ID, forecast start/finish, actual start/finish, and status. Keep baseline snapshots immutable; reforecast creates a new schedule revision and variance against named baseline. Critical path is computed from the dependency network with calendar and constraint assumptions recorded. Dates are forecasts, not promised authority timelines; unknown external review durations remain ranges/scenarios and are labeled.

Scenario adapters isolate domain models behind versioned contracts:

```ts
interface ScenarioAdapter<I, O> { id: string; version: string; inputFactIds: Id[]; input: I; run(): O; assumptions: string[]; limitations: string[]; outputHash: string }
interface Alternative { id: Id; scenarioId: Id; label: string; decisions: Record<string, string | number | boolean>; constraintResults: ConstraintResult[]; metrics: Record<string, number | null>; provenance: Id[] }
interface PortfolioRun { id: Id; projectRevision: number; adapterVersions: Record<string, string>; alternatives: Id[]; objective: string; constraints: string[]; seed: string | null; createdAt: string; outputHash: string }
```

Adapters may wrap `lib/physics` but must normalize units, preserve inputs, expose uncertainty/limitations, and never claim certification. Alternative generation is constrained by explicit hard constraints and user-selected objectives; infeasible and unknown constraints remain visible. Portfolio results must be reproducible from project revision, fact IDs, rule/model versions, parameters, solver/version, seed, and output hash. No optimizer may quietly discard dominated, infeasible, or data-poor options without reporting its filter and reason.

## 6. Persistence, versioning, concurrency, access

Use an append-only revision/event history with transactional current projections. Every write carries `expectedRevision`; reject stale writes with a conflict response containing current revision and changed field IDs. Merge independent fact additions, but never auto-merge competing values for the same predicate and valid interval. Idempotency keys protect import, scan, submission, and model-run retries. Store immutable content-addressed snapshots for evidence and generated packages, with retention/access policy.

Tenant/project scoping applies at every query and object reference. Roles should separate viewer, analyst, owner verifier, project administrator, and submission authority; permission is capability-based and auditable. Validate authorization at action time and submission time. Encrypt restricted evidence in transit/at rest, log access, and apply redaction to exports. Public-source status does not imply redistribution rights; record license/terms and keep attribution. Backups and restore must preserve revision chains, hashes, and access metadata. Export provides a manifest with revisions, source citations, hashes, rule/model versions, and redactions.

## 7. Acceptance criteria and test strategy

Tests are contract-driven, deterministic, and cover:

- Candidate scan, manual entry, study import, source-ID reconciliation, duplicate identity, and owner verification remain distinct states.
- Fact valid-time/recorded-time behavior, supersession, conflicts, missing values, units, provenance, and reproducible derived facts.
- Segment-by-segment jurisdiction resolution, boundary ambiguity, overlapping authorities, effective-date selection, uncovered domains, rule-pack version diff, stale evaluation, and reviewer audit.
- Decision/submission/condition state transitions; frozen package hashes; expiry/renewal; unauthorized transitions rejected.
- Dependency propagation and impact preview; immutable baseline comparison; calendar-aware critical path; unknown external durations.
- Adapter determinism, unit validation, infeasible/unknown constraints, portfolio run reproducibility, and uncertainty labeling.
- Concurrent writes, stale revision conflicts, idempotent retries, access isolation, redaction in exports, and audit completeness.

Golden fixtures include multi-jurisdiction projects, conflicting owner/public facts, expired authority documents, partially covered segments, and a rule effective-date change. Assertions verify no output states that a scan/model or internal decision equals regulatory clearance. Use synthetic fixtures unless a cited source is approved for test use.

## 8. Implementation roadmap

### Phase 1 — Specification

Agree this domain vocabulary, API/event contracts, authority/source review policy, six case fixtures, 12 workflow modules, retention/access model, and explicit product boundary. Add coverage mapping from every workflow and case to interfaces, evidence gates, tests, and owner. No app behavior implied by this document.

### Phase 2 — Project foundation

Implement project/segment/asset IDs; scan-to-candidate conversion; manual entry; source identifiers and reconciliation queue; append-only facts/evidence; owner verification with scope and audit; revisions, concurrency, access control, and export manifest. Migrate by adapters around existing Area Scan and evidence outputs; do not mutate frozen energy contracts.

### Phase 3 — Preconstruction

Implement multi-segment jurisdiction resolution, reviewed rule-pack registry, coverage gaps, effective-date evaluation, rule diff/review, study evidence, decision records, scenario adapters, alternatives, reproducible portfolio runs, and schedule baselines/critical path. Start with screening and planning outputs, clearly marked as informational.

### Phase 4 — Delivery and retirement

Add frozen submission packages and receipt tracking, authority responses, condition register, expiry/renewal alerts, change-impact review, construction/commissioning evidence, operational handoff, decommissioning/retirement workflows, and durable archive/export. External submission integrations remain gated by explicit authorization and verified receiving endpoints.

### Phase 5 — Sector and geography expansion

Add sector-specific vocabularies and rule packs only with named domain review, official sources, effective-date maintenance, and test fixtures. Add geographic coverage only where boundaries and authority mappings have provenance and a stated completeness date. Publish coverage/unknown metrics and a change log; do not imply universal coverage.

## 9. Non-goals and safe language

Mapergy organizes evidence, models scenarios, tracks internal decisions, and prepares project workflows. It does not establish property rights, verify engineering adequacy, determine legal applicability, issue permits, or guarantee utility interconnection. Use phrases such as “candidate,” “screening result,” “owner-verified as of [date],” “rule-pack coverage,” and “authority response recorded.” Reserve “approved,” “permitted,” and “cleared” for a cited, current external instrument whose issuing authority and scope are shown.
