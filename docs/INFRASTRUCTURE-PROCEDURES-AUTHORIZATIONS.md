# Infrastructure Procedures: Authorizations

## Purpose and scope

This document expands workflow rows 4, 5A, and 5B in [INFRASTRUCTURE-WORKFLOWS.md](INFRASTRUCTURE-WORKFLOWS.md) into practitioner procedures for capital and financing, grants and incentives, and permits, licenses, and agreements. It defines records, handoffs, decision gates, evidence, exceptions, and acceptance behavior. It is a product/workflow specification, not legal, accounting, engineering, tax, or eligibility advice. Configure rules from owner policy and the controlling instrument; retain the cited source, version, reviewer, and determination. Do not encode universal statutory deadlines, eligibility conclusions, allowable-cost decisions, or signature authority.

### Shared operating rules

1. Create a durable case ID and link every budget, opportunity, application, funding line, external requirement, instrument, condition, decision, and evidence item to that case. Cross-case records require explicit relationship type and access checks.
2. Every record has owner, responsible organization, status, effective date, last-reviewed date, source/evidence links, and audit history. Store prior versions; correction creates a superseding version, never silent overwrite.
3. Separate preparer, reviewer, approver, and external issuer where owner policy requires. A recorded internal approval never implies an external award, permit, license, or executed agreement.
4. Use `unknown`, `not assessed`, `pending`, and `not applicable` as distinct values. `Not applicable` requires basis and reviewer. A blank is incomplete, never an implicit negative.
5. Configure gate thresholds, materiality, delegation, retention, reminder cadence, and authoritative sources by organization/program/jurisdiction. UI labels must make configured policy version visible.
6. All dates include time zone or source-defined date convention. Preserve source dates and system receipt timestamps independently.

## Stable procedure index and traceability

| ID | Procedure | Source workflow |
|---|---|---|
| CAP-01 | Capital plan and sources-and-uses | 4 Capital and financing |
| CAP-02 | Cost baseline, funding allocations, and affordability | 4 Capital and financing |
| CAP-03 | Multi-year appropriations and authorization | 4 Capital and financing |
| CAP-04 | Cash flow, draw, reimbursement, and reforecast | 4 Capital and financing |
| GR-01 | Opportunity discovery, qualification, and go/no-go | 5A Grants and incentives |
| GR-02 | Application readiness, assembly, review, and submission | 5A Grants and incentives |
| GR-03 | Award acceptance, conditions, and cost control | 5A Grants and incentives |
| GR-04 | Performance/financial monitoring, amendments, closeout | 5A Grants and incentives |
| PER-01 | Authority and instrument identification; applicability/non-determination | 5B Permits, licenses, and agreements |
| PER-02 | Applicability and verification by activity, phase, and jurisdiction | 5B Permits, licenses, and agreements |
| PER-03 | Dossier preparation, submission, review, and issuance | 5B Permits, licenses, and agreements |
| PER-04 | Conditions, renewals, changes, disputes, appeals, closeout | 5B Permits, licenses, and agreements |
| AGR-01 | Agreement intake, negotiation, approval, signature, administration | 5B Permits, licenses, and agreements |
| CHG-01 | Change intake, impact screening, authorization, and record reuse | 4, 5A, 5B |
| CHG-02 | Award/subrecipient recovery, permit transfer/surrender, agreement release | 5A, 5B |

## Roles and handoff contract

Map these roles to named people and delegated authorities per case. Record delegation scope and expiry. A person may hold multiple roles only where separation policy permits.

| Role | Owns / may do | Handoff evidence |
|---|---|---|
| Sponsor / case manager | Need, scope, gate coordination, decision request | Current scope, accountable owner, requested decision/date |
| Finance preparer | Estimate, funding lines, forecasts, transaction reconciliation | Versioned model, assumptions, reconciliation and variance |
| Finance reviewer / controller | Validate arithmetic, classification, matching and cash forecast | Review checklist, exceptions, reviewer identity/date |
| Budget/appropriation authority | Approve budget and spending authority within delegated remit | Signed/minuted authorization, amount, period, conditions |
| Treasury / cash manager | Liquidity, borrowing, receipts, draw schedule | Cash forecast and financing evidence |
| Grants lead | Opportunity, application package, reports calendar | Source notice, requirement matrix, submission/receipt |
| Technical owner / cost owner | Scope, quantities, milestones, outputs, evidence | Approved scope and deliverable acceptance |
| Compliance/counsel reviewer | Review basis, obligation terms, instrument interpretation | Review note with source, scope, unresolved questions |
| Authorized applicant/signatory | Certify and submit; accept award/execute when authorized | Authority/delegation evidence, signed version, receipt |
| Permitting coordinator | Authority map, docket, package, dates, conditions | Requirement disposition and complete dossier index |
| Discipline lead | Technical applicability and design inputs | Activity/phase-specific facts, cited basis, limitations |
| External authority/counterparty | External determination, issuance, acceptance | Issued instrument, formal response, executed agreement |
| Records custodian | Archive, retention, retrieval | Manifest, retention class, access and checksum/version data |

Every handoff is a work item with sending role, receiving role, due date, requested action, linked version, status, and return reason. Receiver may accept, return with a field-level deficiency list, or mark blocked with owner and review date. Gate advancement never deletes a returned or unresolved item.

## CAP-01 — Capital plan and sources-and-uses

### Start and required inputs

Start when a preferred alternative or a candidate needing development has a cost/funding question. Sponsor opens a capital plan; finance lead owns the working model. Planning may proceed while grants are explored, but distinguish planning assumptions from authorized funds.

**Capital plan fields:** case ID; plan ID/version; title; owner; status (`draft`, `in review`, `approved`, `superseded`, `closed`); currency; price/base date; estimate class/basis; horizon; phase and fiscal/calendar period; escalation/inflation convention; contingency basis; tax treatment if owner-configured; model/source links; assumptions; sensitivity cases; preparer/reviewer/approver; approval date; residual gap; next review date.

**Funding source fields:** source ID/type; provider/program; source-specific award/commitment ID; status (`identified`, `inquiry`, `applied`, `conditional`, `awarded`, `committed`, `available`, `received`, `repaid`, `withdrawn`, `declined`); gross and net amount; currency/base date; use restrictions; match/share; repayment/security/interest terms where relevant; period of availability; conditions precedent; expected decision/commitment/receipt dates; evidence; confidence; accountable owner; last verified date. `Available` is a separately reviewed state; an application or forecast never counts as available.

**Use/cost line fields:** line ID; work-breakdown code; phase; activity/deliverable; cost category; description; quantity/unit/rate where applicable; estimate range or point estimate; currency/base date; period; cost owner; source estimate; confidence; contingency flag; eligible-use tags as source-verified claims; commitment/actual/forecast amounts; funding allocations; variance note.

### Procedure and gates

1. Finance creates version 1 and records scope boundary, estimate basis, currency, base date, timing horizon, and exclusions. Technical owners validate quantities and scope. Missing data is recorded with range, confidence, owner, and closure date.
2. Build uses by phase and period. Build sources separately. Reconcile totals, financing costs, contingency, lifecycle/operating costs, and any owner-configured reserves. Show unallocated/unsupported amounts explicitly.
3. Allocate each source to cost lines only within its documented period, eligible uses, match/share rules, and remaining balance. Each allocation records source line, cost line, amount/currency/period, restriction reference, allocation basis, preparer, reviewer, and version. Do not duplicate one dollar across concurrent sources; overlapping or prohibited funding triggers conflict review.
4. Finance reviewer checks arithmetic, price basis, sources status, restrictions, double-counting, and gap. Treasury checks timing/liquidity where required. Authority receives a decision package, not editable unreviewed assumptions.
5. Approval records approved version and scope, amount ceiling, funding conditions, delegated commitment authority, period, conditions, approver, decision date, and evidence. Revisions after approval create a new version and route again if configured materiality/authority rules trigger.

### Exceptions and UI behavior

Currency/base-date mismatch is shown as incomparable until normalized with recorded conversion/escalation method. Delayed or conditional funding remains outside committed/available totals according to configured definitions. An unresolved gap does not disappear behind a percentage funded. UI shows totals by status, phase, period, source, restriction, and confidence; each total opens its constituent lines. Surface a blocking warning for duplicate allocations, over-allocation, incompatible period, or unsupported amount. Authorized reviewer may resolve with rationale and evidence; no silent override.

### Acceptance tests

- Pending application is excluded from committed and available totals.
- One source allocated beyond its amount or period blocks approval unless an authorized exception is recorded.
- Editing estimate basis creates a version and marks prior comparisons incomparable where needed.
- Approval points to an immutable model snapshot and records approver, conditions, and evidence.
- Portfolio gap equals uses less eligible confirmed sources under configured definitions; user can inspect calculation inputs.

## CAP-02 — Cost baseline, funding allocations, and affordability

1. Technical/cost owners produce phased estimate lines with quantity, basis, date, range, confidence, exclusions, and dependencies. Finance maps lines to approved cost codes and funding restrictions.
2. Record allocation per line and period. Allow split allocations across sources only when each source permits the cost and combined amount does not exceed line forecast/actual. Allocate match as a distinct source/use relationship with required evidence and valuation basis.
3. On estimate change, compare against prior approved baseline by line, phase, total, funding source, and period. Record variance reason (`scope`, `quantity`, `rate`, `schedule`, `market`, `currency`, `risk`, `other`) and corrective action. Recalculate funding gap and affordability; route required budget amendment before commitment if owner policy requires.
4. Retain original estimate, normalization inputs, approved baseline, current forecast, and transaction actuals. Reports identify which are actual, forecast, estimate, or commitment.

**UI and exception behavior:** show baseline/forecast/actual side-by-side; filter by phase and source; drill from summarized amount to allocations. Mark orphan cost lines, unassigned funding, restricted/possibly ineligible allocations, and duplicate claimed costs. A reallocation requires reason and reviewer; it cannot rewrite prior-period history. An affordability result is labeled with assumptions and decision authority, never presented as an automated approval.

## CAP-03 — Multi-year appropriations and authorization

Appropriations, allotments, budget authority, and project commitments are distinct records. Configure local fiscal calendars and terminology; do not assume an appropriation permits a multi-year commitment or carryforward.

**Authorization fields:** authorization ID/type; approving body/official; source policy/resolution; scope/case/phase; amount and currency; fiscal year(s)/period; current-year and out-year amounts; purpose restrictions; commitment ceiling; lapse/carryforward/expiration rule as stated in source; conditions; delegated signer/commitment role; effective/approval/expiry dates; status (`draft`, `routed`, `approved`, `partially approved`, `denied`, `expired`, `superseded`); linked budget version; minutes/resolution/evidence; reviewer.

**Procedure:** finance maps forecast obligations and cash needs by fiscal year; responsible budget office confirms each year's authority and permitted commitment period from controlling records. Identify out-year planning amounts separately from enacted/approved authority. Route each year/phase to the approving authority required by configured delegation. Record partial approvals and restrictions line by line. Before contract/award acceptance, match proposed obligation schedule against active authority and delegated signing limit. Renewal/re-appropriation is a new decision linked to prior period.

**Exceptions/UI:** show authorized, allocated, committed, expended, and remaining amounts per fiscal year. Flag pending future-year authority, lapse dates, encumbrances, and proposed obligations extending beyond authority. Block commitment routing when authority is missing or scope/period/amount does not cover it; permit only a policy-authorized exception with approver, rationale, and evidence. Do not carry balances forward automatically.

**Acceptance:** out-year forecast never appears as current authority; partial approval caps commitments at approved amount; expired/lapsed period cannot be newly committed; amended authority preserves prior record and recalculates available balance from auditable transactions.

## CAP-04 — Cash flow, draw, reimbursement, and reforecast

**Cash event fields:** event ID/type (`planned outflow`, `invoice`, `advance`, `draw request`, `reimbursement request`, `receipt`, `refund`, `repayment`, `withholding`); source/use; amount/currency; service/eligible period; forecast, submitted, approved, paid, or received date; transaction reference; invoice/payment/receipt evidence; responsible party; status; reconciliation link; variance reason.

1. Finance and treasury build monthly or owner-configured period cash forecast from procurement, construction, grant schedule, debt/equity proceeds, match, and reimbursement lag assumptions. Label assumption and confidence; separate accrual/commitment view from cash view.
2. For each draw/reimbursement, create claim with source-specific line mapping, period, eligible-cost evidence, match evidence if required, amount requested, reviewer, submission date/receipt, expected receipt, and reconciliation status. This workflow tracks claims; source terms determine whether costs may be incurred before award, approval, or reimbursement. Never infer pre-award allowability. Store award-specific authorization, date window, cost categories, written approval, and limits. If unverified, flag cost as at-risk and exclude from grant-funded available totals.
3. On receipt/payment, match transaction to claim/source and cost lines. Record short-pay, rejection, holdback, exchange difference, or timing variance; assign owner and resolution date. Avoid counting submitted claims as cash received.
4. Reforecast on award/appropriation delay, invoice variance, schedule shift, cost change, rejected claim, or material assumption update. Preserve prior forecast and show impact on liquidity, gap, and milestone readiness. Route revised funding/budget approval when configured threshold is crossed.

**UI and acceptance:** timeline shows planned versus actual cash, outstanding claims, reimbursement lag, and liquidity trough. Submitted claim does not increase cash-on-hand; receipt requires transaction evidence. Rejected/short-paid claims remain visible with assigned resolution. Pre-award cost flagged at-risk until instrument-specific permission is reviewed and evidenced.

## GR-01 — Opportunity discovery, qualification, and go/no-go

### Opportunity record

Fields: opportunity ID; program/sponsor/administrator; official title and identifier; controlling notice URL/file/version/date; correction/amendment versions; source snapshot/retrieval timestamp; applicant and partner entities; geography, technology, activity, phase, and project scope; stated award range; match/cost-share terms; stated eligible/ineligible cost questions; application method/registration prerequisites; dates/time zone and source wording; questions/contact; internal lead; decision date; status (`discovered`, `screening`, `needs clarification`, `qualified for review`, `go`, `no-go`, `submitted`, `awarded`, `declined`, `closed`); related opportunities; reviewer.

### Qualification workflow

1. Grants lead captures the official notice and each amendment. Extract each criterion as a question, not a system conclusion. Record source section/page, exact scope, needed proof, owner, reviewer, answer (`meets`, `does not meet`, `uncertain`, `not assessed`), evidence, limitations, and review date.
2. Finance maps match/cost-share, reimbursement/advance, allowable-cost questions, award timing, and administrative burden to CAP records. Technical and partner owners validate scope, outputs, capacity, and commitments. Counsel/compliance reviews unresolved legal/eligibility interpretation with program source or written sponsor clarification.
3. Resolve registration prerequisites, applicant profile, authorized representatives, partner roles, and deadline capacity. For Grants.gov path, its applicant guide identifies organization registration/UEI and user roles/workspace as setup tasks; confirm current requirements for the live opportunity in the official source. It also distinguishes workspace preparation from authorized submission. [Grants.gov Applicant Quick Start](https://www.grants.gov/quick-start-guide/applicants)
4. Decision memo records fit, evidence-backed criteria, uncertainty, match source, funding/cash-flow risk, workload, conflicts with other awards, fallback if declined, and decision (`go`, `no-go`, `defer`, `seek clarification`). Sponsor recommends; delegated applicant/finance authority decides as owner policy specifies.

**Cross-program conflict check:** compare proposed cost lines, match, timing, scope, geography, outputs, exclusivity/stacking restrictions, and overlapping claims across all opportunities and committed awards. Flag possible double charging, incompatible match, conflicting milestones, cumulative caps, or exclusivity. Assign finance/compliance reviewer to resolve against each source's terms. Until resolved, hold only affected allocation/application claim; do not mark either program as a valid fallback. Fallback plan identifies alternate funding source, reduced scope, bridge authority, decision trigger/date, and responsible owner.

**Acceptance:** every criterion has answer, source, evidence or explicit uncertainty, owner, and reviewer; go/no-go includes risks and fallback; deadline timezone and amendments are preserved; system never auto-asserts eligibility.

## GR-02 — Application readiness, assembly, review, and submission

**Application fields:** application ID; opportunity/version; applicant entity; UEI/registration/profile status where applicable; authorized applicant/signatory and authority evidence; partners/subrecipients; deadline/time zone; planned submit date; workspace access; requirement matrix; narrative/budget/work-plan versions; cost-line mappings; match commitments; certification owner; attachments/index; reviewer assignments; readiness status; validation results; approval; submission version, timestamp, channel, receipt/confirmation ID; agency status and source.

**Readiness gates:**

1. **Intake complete:** notice and amendments archived; deadline and submission channel verified; application owner and signatory named; registration prerequisites assigned.
2. **Requirement matrix complete:** each requirement has source citation, section, responsible preparer, reviewer, evidence/output, due date, and state (`not started`, `draft`, `review`, `accepted`, `blocked`, `not applicable with rationale`).
3. **Budget reconciled:** narrative, work plan, schedule, budget, match, and CAP allocation reconcile. Finance signs off source-specific classifications as reviewer questions tied to notice/terms; disputed costs remain excluded or at-risk pending authorized resolution.
4. **Partner and certification ready:** letters/commitments, data permissions, certifications, internal authority and conflict checks complete. Each certification is routed to person with authority, with exact application version and timestamp.
5. **Independent completeness review:** reviewer checks required fields/forms, consistency, attachments, signatures/certifications, technical assertions, cost arithmetic, permissions, and export rendering. Return deficiencies at field level. Record waived/late exceptions only with configured authorized approver and rationale.
6. **Submission approval:** delegated applicant/signatory approves immutable final package. Submit via source-required channel; record exact version, date/time/time zone, submitter, receipt, tracking ID, validation response, and follow-up task. If channel supplies receipt later, status remains `submission pending confirmation`; no fabricated receipt.

**Status path:** `planning` → `drafting` → `internal review` → `correction requested` ↔ `internal review` → `ready for authorization` → `authorized` → `submitted pending receipt` → `submitted` → `withdrawn`, `rejected as incomplete`, `selected`, `not selected`, or `closed`. Preserve source/agency states separately from internal workflow states.

**UI:** readiness panel groups blocking versus advisory checks, owner, due date, source, and latest evidence. Versioned export manifest lists file versions and checksums where supported. Lock or mark final version read-only after authorization; any edit invalidates approval and requires re-review. Notification failures and late deadlines are explicit.

## GR-03 — Award acceptance, conditions, and cost control

Upon selection, do not treat notice of selection as executed award or spending authority. Grants lead obtains official award and terms; finance/compliance compares it to submitted request and CAP plan; authorized official accepts only within delegation.

**Award record:** award ID/instrument; sponsor; executed/current terms version; award amount and period; start/end dates; budget categories; match; payment mechanism; reporting calendar; special conditions; prior approvals/consents; subrecipient/partner terms; property/procurement/environmental or other obligations as stated in source; amendment process; closeout date/rules as recorded; contacts; authorized acceptance; source/evidence; review date.

Convert each term/condition to obligation item with exact source section, applicability to scope/entity/phase, owner, reviewer, due/trigger, evidence needed, status (`open`, `in progress`, `awaiting external`, `satisfied pending review`, `accepted`, `waived by authorized source`, `disputed`, `overdue`), consequence/risk, and escalation. Link restrictions to cost-line allocation rules. Record pre-award spending separately: allowed/not allowed/unclear only as determined from award-specific notice, written approval, or controlling terms; note covered dates/categories/limits and approver. No general assumption that costs before award are reimbursable.

Map award amount/status to CAP source lines. Adjust for reduced award, changed scope, match gap, conditions, or timing; route revised project plan and allocations. Keep requested, selected, executed, available, drawn, and received amounts distinct. If declined/reduced, activate documented fallback decision; do not silently substitute another award where source terms conflict.

**Acceptance:** signed/current terms are linked; every condition has owner and due trigger; each grant-funded cost line maps to applicable term and period; no spending-ready state without required acceptance/authority checks configured by owner.

## GR-04 — Monitoring, amendments, disputes, and closeout

### Monitoring cycle

Create a schedule from executed award terms: performance reports, financial reports, draw requests, deliverables, monitoring visits/requests, subrecipient reports, audits/findings, and closeout. For each item store source-defined due date, period covered, preparer, reviewer, authorized certifier, evidence, submission version/receipt, sponsor response, correction/revision, next date, and retention classification. Grants.gov describes post-award administration as including performance/financial reporting, monitoring of terms, resolution of audit findings, and closeout; use award-specific terms and sponsor instructions for actual duties. [Grants.gov Grants Management](https://www.grants.gov/learn-grants/grant-careers/grants-management.html)

At each period close, technical owner certifies outputs and variances; finance reconciles ledger, match, claims, receipts, and cost lines; grants lead compiles evidence; independent reviewer checks against terms; authorized certifier approves exact report version; submit and capture receipt. Track sponsor acceptance separately from submission. Late, returned, unsupported, or questioned items create exception with risk, owner, escalation, corrective action, and review date.

### Changes, disputes, and closeout

Amendment request captures reason, changed scope/budget/period/partner, affected conditions, approvals required, requested effective date, written sponsor decision, and updated version. Until approved, retain current terms and mark proposed change pending; do not rely on retroactive approval.

Dispute or finding record captures issuer, reference, amount/scope, response deadline, source term, evidence, accountable lead, counsel/finance review, response version/receipt, resolution, remaining exposure, and escalation. Preserve original finding and correspondence. An appeal or reconsideration does not automatically suspend deadlines or obligations; task owner must verify applicable process and dates from controlling instrument/source.

Closeout checklist reconciles final performance, costs, match, outstanding claims/receipts, refunds/repayments, property/equipment disposition if applicable, subrecipient closeout, findings, final reports, sponsor acceptance, remaining obligations, retention location/class, and archive manifest. Close only after reviewer accepts each item or authorized source-approved exception is recorded. Keep award open if sponsor acceptance or required disposition remains outstanding.

**Acceptance:** missed due date escalates with source-defined consequence visible; report submission is not report acceptance; amendment cannot replace executed terms before approval; closeout cannot complete with unresolved balance, finding, or condition absent documented authorized disposition; archived package shows superseded and current versions.

## PER-01 — Authority and instrument identification

### Authority map and requirement record

Start at candidate site/route and concept, then repeat when scope, activity, phase, jurisdiction, ownership, or design changes. Permitting coordinator creates requirement candidates; discipline leads provide facts; counsel/compliance reviewer accepts the determination basis; only external authority evidence can establish issuance.

**Requirement fields:** requirement ID/type; project/activity/phase; jurisdiction and geographic coverage; candidate authority/counterparty; authority source and version; source retrieval date; trigger; applicant/owner; instrument sought; prerequisite; consultation/contact; applicability state; basis and reviewer; confidence; package owner; planned/submitted/decision dates; external docket; status; dependencies; conditions; expiry/renewal; appeal/dispute; evidence links; next verification date.

Use distinct applicability states: `not assessed`, `potentially applicable`, `confirmed applicable`, `not applicable with rationale`, `non-determination—authority/source unclear`, and `superseded by change`. Use distinct external lifecycle states: `not ready`, `pre-application`, `in preparation`, `submitted`, `receipt confirmed`, `under review`, `information requested`, `issued`, `denied`, `withdrawn`, `appeal/dispute`, `expired`, `closed`. Applicability is an internal reviewed conclusion; issuance is an external event. Verification state (`unverified`, `source checked`, `authority confirmed`, `instrument verified`) is separate.

### Non-determination procedure

When jurisdiction, authority, or applicability cannot be established, keep item open as `non-determination—authority/source unclear`. Record the exact unknown, candidate sources/authorities, geography and activity examined, consultation request and response, responsible owner, due date, and planned verification. Escalate to designated counsel/compliance and permitting lead. Do not auto-close as not applicable, suppress from portfolio, or proceed through a gate that requires resolution. A scoped risk-based exception requires authorized decision-maker, rationale, limitations, affected activity/phase, expiration/revisit date, and retained evidence; it does not convert uncertainty into a legal determination.

**UI behavior:** show candidate authorities and unresolved coverage on map/list; distinguish internal assessment from external confirmation; expose source freshness and reviewer; allow no-issue disposition only with rationale, reviewer, and evidence. No hard-coded permit catalog should claim completeness.

## PER-02 — Applicability and verification by activity, phase, jurisdiction

Assess each **activity × phase × jurisdiction × instrument type** combination separately. Do not treat one project-level checkbox as covering all work. Example phases may include site investigation, design, land work, construction, energization/commissioning, operation, modification, renewal, and retirement; configure vocabulary to owner needs.

1. Define factual scope: location/geometry and ownership; activity and methods; timing/duration; equipment/materials; disturbance/emissions/discharge/connection/occupancy/use facts as relevant; project phase; thresholds/data sources; alternatives. Mark unknown facts and owner.
2. Identify candidate jurisdictions and authorities from owner-configured authoritative sources, prior instruments, counsel advice, and direct consultation. Record source/version/date, geographic coverage, and confidence. Cross-boundary work can have multiple authorities.
3. For each combination, record applicability question, source section, facts compared, result, limitations, assumptions, and reviewer. If source conflict or authority ambiguity remains, use non-determination and request clarification.
4. Separate `applicability assessment` from `verification`: verification records source checked, direct authority response or instrument evidence, checked scope/parcel/activity/phase/holder/dates, checker, and date. A determination may be assessed but not externally verified; an agency conversation does not equal issuance.
5. Site/design/activity revision triggers an impact review against linked requirements. Owner identifies affected combinations; mark prior assessment `superseded by change`, retain history, re-open work, and record whether prior instrument remains valid, needs amendment, or needs fresh authority confirmation.

**Acceptance:** every identified combination has disposition, owner, reviewer, and cited basis; `not applicable` requires explicit rationale and review; unknown geography prevents closed disposition; activity/phase change surfaces impacted records and prevents silent carry-forward.

## PER-03 — Dossier preparation, submission, review, issuance

**Dossier index fields:** requirement/instrument ID; authority; application/form/version; project/site/activity/phase covered; applicant/agent/delegation; technical reports/drawings/data; land/access rights; consultations/notices; fees if owner tracks; certifications/signature; dependencies/prerequisites; response-to-comments matrix; evidence versions; confidentiality; preparer/reviewer; validation state; export manifest.

1. Coordinator confirms applicability disposition, authority, applicant, prerequisites, current submission instructions, owner-defined work authorization gate, and applicable deadline source. If unresolved, record blocker and seek determination.
2. Discipline owners deliver required data with source, date, methods, limits, reviewer, and approved design baseline. Dossier index identifies missing/conditional materials; counsel/compliance reviews representations and commitments; authorized applicant signs only within delegation.
3. Independent completeness review checks version consistency, scope/geometry, required forms, response matrix, linked approvals, and package readability. Return field-level issues. Freeze package snapshot; submit and record channel, exact version, sender, date/time/time zone, fees/receipt if relevant, docket ID, and authority acknowledgement.
4. During review, log each authority request/comment, received date, response due date/source, responsible discipline, draft/reviewer/approval, submitted response version/receipt, and resolution. Changed design or facts initiate impact review; do not overwrite submitted package.
5. On issuance/denial, verifier checks issuer/authority, instrument number, holder, exact site/activity/phase/scope, effective and expiry dates, incorporated plans, conditions, references, appeal/reconsideration path stated in source, and authenticity/source. Authorized reviewer records verified status. Denial creates decision/appeal workflow, revised design or no-go; it cannot be marked issued by internal approval.

**UI:** dossier completeness indicator is based on configured required items, with each item inspectable; submission receipt and actual instrument are separate evidence types; issued status requires instrument verification by authorized role. Show responses and amendments chronologically.

## PER-04 — Conditions, renewals, changes, disputes, closeout

Convert every instrument condition/commitment into a linked obligation record: exact clause/reference; affected activity/phase; responsible owner and backup; prerequisite/trigger; due/frequency; deliverable/evidence; reviewer; status (`not started`, `in progress`, `awaiting authority`, `submitted`, `accepted`, `overdue`, `disputed`, `waived by issuer`, `closed`); next date; related change; escalation; source version. Conditions become gate dependencies before the configured activity can proceed. A permit record marked issued does not imply conditions are complete.

Renewal planner stores expiry/renewal window as stated by instrument, required package, lead time assumption, owner, internal target date, submission date, receipt, decision, continuity/bridge question for authorized review, and escalation. Reminders use source-derived dates plus owner-configured buffers. Renewal is a linked new workflow/version; prior instrument remains historic and is not extended automatically. When renewal timing is uncertain, show `date to verify` and block calendar confidence until checked.

For site/design/ownership/operator changes, create impact assessment covering affected permits, licenses, agreements, conditions, notifications, amendments, transfers, and closeouts. Obtain reviewer disposition per item and retain external consent/approval where required by controlling terms. Do not infer transferability.

Dispute/appeal record stores decision/condition disputed, issuing authority, notice and source, date received, stated response/appeal deadline, method, authorized representative, grounds/evidence, counsel reviewer, submissions/receipts, status, decision, and implementation tasks. Verify deadlines/process from source or qualified reviewer. Keep ordinary condition tasks active unless authorized source or reviewer documents suspension; display unresolved obligations and escalation.

Close requirement only when no remaining condition/renewal/dispute obligation applies, or authorized issuer disposition and reviewer acceptance are evidenced. Preserve notices, responses, decision, instrument history, and final archive manifest.

**Acceptance:** expired instrument generates visible alert and blocks configured gate; condition remains open until evidence accepted; appeal deadline uses cited source and timezone; renewal cannot silently extend validity; closed record with unresolved obligation is rejected unless authorized disposition is attached.

## AGR-01 — Agreements and commitments

Applies to utility/interconnection, access/easement, service, host/community, construction interface, grant/partner, and other owner-configured agreements. Agreement workflow is distinct from permit issuance, even when related.

**Agreement fields:** agreement ID/type; case/site/activity/phase; parties and legal names; capacity/authority of representatives; owner/counterparty; purpose/scope; linked permits/funding/cost lines; draft/source versions; status (`identified`, `term sheet`, `drafting`, `negotiation`, `internal review`, `approved to execute`, `executed`, `effective`, `amendment pending`, `disputed`, `expired`, `terminated`, `closed`); term/effective/expiry/renewal notice dates; conditions precedent; deliverables/services; access/operating interfaces; price/payment/escrow/security if relevant; insurance/performance obligations if relevant; data/confidentiality; change/control/assignment; default/remedies/dispute process; termination/closeout; signature authority; approval evidence; executed copy; source and reviewer.

1. Intake identifies business owner, parties, scope, dependencies, template/source, required approvals, negotiation lead, target date, and risks. Verify party names and authority evidence per owner process.
2. Maintain issue log by clause/topic, proposal, owner, counterparty response/date, risk, reviewer, resolution, and final text reference. Keep drafts immutable and distinguish working text from agreed text. Counsel/compliance reviews owner-defined terms and interfaces; technical and finance owners verify scope, cost, schedule, performance, and conditions.
3. Before execution, confirm internal approval covers exact final version, amount/term/scope, funding and appropriation, required prerequisite permits, and signatory delegation. Route each party signature; status becomes executed/effective only after required execution/effective conditions are evidenced. Internal approval is not execution.
4. Convert obligations, payment milestones, deliverables, notice periods, renewal dates, and conditions precedent into tasks linked to agreement clauses. Record counterparty receipt/acceptance and dispute evidence. Amendment uses new version and repeats review/approval/execution; prior terms remain active until effective change is verified.
5. At expiry, termination, transfer, or completion, verify surviving obligations, payments, access/asset handback, claims, records, and closure evidence. Do not close solely because term ended.

**Exceptions/UI:** unsigned, partially signed, conditional, disputed, or expired agreements remain distinct. Missing signatory authority blocks execution routing. Agreement changes highlight impacted funding, permits, design, schedule, and costs. Dashboard shows upcoming notices, unfulfilled conditions, claims/disputes, and counterparty dependencies.

**Acceptance:** executed state requires complete signature evidence and effective-date check; approved-to-execute state references exact approved text hash/version; amendments preserve old and new text and effective date; open obligation prevents closeout absent documented disposition.

## CHG-01 — Change intake, impact screening, authorization, and record reuse

Treat material change as a linked workflow across the capital plan, every affected award, permit/license, agreement, and dependent case. Common triggers include scope/site/route/phase/design changes; schedule or cost variance; changed owner/operator/partner; new activity or construction method; funding or appropriation shift; a new agency condition; missed milestone/report; nonperformance; dispute; and planned pause, transfer, termination, or retirement. Owner-configured change thresholds determine materiality. A user can log a potential change without deciding whether it is material.

**Change record fields:** change ID; originating case and linked cases; trigger/source; received/identified date; proposed and current baseline versions; change description and reason; affected sites/activities/phases/jurisdictions; cost/schedule/service impacts; initiator; change owner; urgency; status (`logged`, `screening`, `impact review`, `decision ready`, `approved`, `rejected`, `deferred`, `external approval pending`, `implemented`, `verified`, `closed`); decision authority; due/revisit dates; required reviews; evidence; related conditions/commitments; rollback/containment plan where relevant; communications; decision/version history.

### Practitioner sequence

1. **Log once, link everywhere.** Initiator records one change ID against the current baseline and attaches the initiating notice, revised drawing, cost estimate, event, or request. Case manager assigns change owner and preserves original evidence. Avoid making parallel unlinked copies in finance, grant, permit, and contract registers.
2. **Screen impact domains.** Change owner sends a compact checklist to finance, grants, permitting, technical, operations, procurement, land/community, and counsel/compliance roles as applicable. Each reviewer returns `affected`, `not affected with rationale`, or `unknown`, plus linked records and evidence. Silence is pending, not no impact. Reviewer may request only the facts needed for their domain.
3. **Build impact set.** Link affected budget versions and appropriations; sources, cost allocations, draw claims, and cash forecast; opportunity/applications/awards/report obligations/subrecipients; permit applicability records/dossiers/conditions/renewals; agreement clauses/notice periods/consents; milestones and external parties. Record evidence and owner for each link. Reuse existing records by reference when facts, site, scope, phase, source version, and validity period still match. Copy only a versioned snapshot when a receiving process requires a frozen submission. Mark changed facts stale and require revalidation; never imply that prior review automatically covers changed facts.
4. **Assess before commitment.** Finance quantifies total and period variance, funding eligibility/availability, appropriation coverage, match, liquidity, and reforecast. Grants lead checks notice/award approvals, report/draw effects, subrecipient flow-down and monitoring, and possible recovery exposure. Permitting lead checks applicability/determination, amendment/transfer/surrender/renewal needs, and condition effects. Agreement owner checks consent, notice, pricing, interface, default, assignment, and release clauses. Record unresolved questions and source citations.
5. **Route sequential gates.** Complete required technical/reviewer sign-offs, then internal budget/investment authority approval; obtain external sponsor/authority/counterparty approvals where needed; only then issue implementation authorization. The gate configuration states which approvals are prerequisites and what work may continue. Approval of a change request is not evidence of external amendment or consent. Maintain separate `internal decision` and `external decision` states.
6. **Implement with traceability.** Publish approved baseline and effective date; update affected forecast/tasks/conditions only after applicable approvals. Notify owners and counterparties per configured process, capture delivery evidence, assign resulting actions, and keep superseded records searchable. If external approval is denied or delayed, retain current baseline, hold affected action, and route alternative/no-go or staged change decision.
7. **Verify and close.** Independent reviewer confirms the implemented state matches approvals, updated source records, reconciled cost and schedule, assigned obligations, and required external receipts/instruments. Close only when every affected record has accepted disposition or authorized exception with rationale, owner, expiry/review date, and evidence.

**Low-friction interface:** one change intake form with conditional fields; suggested impacted links from shared case/site/phase/cost/organization IDs; one reviewer inbox showing only that domain's questions; one consolidated impact matrix; one decision packet/export; and automatic task generation after approval. Suggestions are prompts, not findings. Bulk acceptance is prohibited for unresolved/unknown impacts. Reuse/clone actions show original source, date, scope, and stale-field warnings before creating a snapshot.

**Failure and evidence handling:** if source evidence is missing, mark the review blocked and name a retrieval owner/date; do not synthesize source terms. If reviewers disagree, keep both positions with citations and escalate to designated authority. If a change is implemented prematurely, log actual implementation date, affected work, containment, notifications, and corrective action; preserve this as an incident/exception rather than backdating approval. Failed notifications, unacknowledged external submissions, and returned packages remain open tasks.

**Acceptance:** one change packet can show all affected records and missing reviews; unknown impact prevents closure; an approval references exact baseline and change version; external consent is separately evidenced; reused records indicate original and revalidation status; rejected/deferred changes preserve current baseline and reasons; implementation without prior gate leaves an auditable exception.

## CHG-02 — Award/subrecipient recovery, permit transfer/surrender, agreement release

This procedure handles downstream obligations after a change, withdrawal, loss of funding, partner failure, ownership transfer, or project stop. Start promptly when a potential trigger appears; assign one coordinator while each domain retains its own decision authority. Do not assume recovery, surrender, release, transfer, or waiver is available. Verify route, timing, conditions, and authority from the controlling award, instrument, agreement, or official correspondence.

### Grant award and subrecipient recovery

1. Grants lead freezes the relevant award-term version and identifies affected budget period, deliverables, claims, draw requests, subrecipients, match, property, reports, and pending amendments. Finance reconciles obligation/actual/claimed/received amounts by cost line and flags unsupported, questioned, duplicate, potentially ineligible, or unpaid costs without prematurely classifying them as recoverable.
2. For each subrecipient, record agreement/flow-down version, paid and committed balance, deliverables/reports due, property/records, open findings, and responsible contact. Issue owner-authorized request/notice using verified terms; capture exact notice, recipient, delivery/receipt, response deadline, response, and escalation. Track corrective action and monitoring evidence. No informal email or internal status change substitutes for formal amendment, suspension, termination, or recovery action when terms require formal process.
3. Grants lead and counsel/compliance determine required sponsor notice, prior approval, amendment, suspension/termination, repayment, deobligation, or recovery request based on source terms and written sponsor direction. Finance prepares amount calculation with transaction-level evidence and reviewer; authorized official approves response/claim. Record disputed amounts separately from accepted obligation, sponsor decision, collection/refund/repayment transaction, and residual exposure.
4. Keep performance and financial reporting calendar active until sponsor confirms revised schedule or closeout. Convert recovery decisions into ledger adjustments, subrecipient closure tasks, asset/property disposition, revised CAP sources/uses, and final evidence manifest. Escalate overdue sponsor response or collection per owner policy; preserve appeal/dispute routes and dates from source.

### Permit/license transfer, amendment, suspension, surrender

1. Permitting coordinator identifies affected instruments and conditions by holder, site, activity, phase, term, and authority. Verify current instrument and amendments. A proposed sale, operator change, site change, scope change, cessation, or replacement is an impact trigger; it does not establish transferability or end the obligations.
2. Discipline lead documents proposed future activity and responsible operator. Counsel/compliance reviewer checks instrument/source for transfer, notice, amendment, reapplication, suspension, surrender, termination, restoration, monitoring, and surviving obligations. Where unclear, request written authority determination; keep item in non-determination status and block closure.
3. Prepare authority-specific package: current instrument; proposed holder/operator and effective date; consent/authorization proof; scope/site comparison; condition status and evidence; successor responsibility acceptance; continuity/safety/environment/monitoring arrangements as applicable; request form and correspondence. Route internal approval and authorized signature; submit and preserve receipt/docket ID.
4. Until written external disposition is verified, retain current holder and instrument status as active/uncertain per source, keep conditions scheduled, and avoid reporting transfer/surrender as complete. On decision, verifier checks exact instrument, holder, scope, effective date, conditions, liabilities/survivors, and required follow-up; assign tasks and update asset/permit links.
5. For surrender/closure, capture authority receipt/acceptance if required, final reports/inspections, restoration or monitoring evidence, remaining conditions, retained records, and residual owner. An internal request to surrender is not an effective surrender. Keep expired, surrendered, revoked, and transferred states distinct.

### Agreement stewardship, release, and post-term duties

1. Agreement owner maintains a clause-linked obligations calendar from execution through expiry and survival period: milestones, payments, service levels, notices, renewals, insurance/security, access, data, confidentiality, claims, audit, restoration, and records as present in the executed text. Each item has accountable owner, evidence, reviewer, due date/source, and counterparty acknowledgment where required.
2. At change or approaching expiry, compare current executed version and amendments against proposed change. Identify notice windows, consent, assignment, change-control, default/cure, suspension, termination, handback, transition, payment adjustment, indemnity/claims, and surviving clauses. Counsel reviews interpretation; business/technical/finance owners assess feasibility and amounts. Log open interpretation as question, not a conclusion.
3. Route amendment, waiver, release, termination, renewal, or novation request under the exact agreement approval and signature authority. Capture proposed text, negotiation issue log, internal approvals, counterpart signature, effective date, and delivery evidence. Pending request does not amend current duties. For disputes/default, preserve notices and cure periods, assign response owner, and continue non-suspended obligations unless source or written direction establishes otherwise.
4. At handback/release, reconcile payments, deposits/security, assets/access, services/data, warranties/claims, open work, confidential materials, records retention, and surviving duties. Obtain receipt/acceptance from counterparty when required. Distinguish `term ended`, `terminated`, `released`, and `closed`; end date alone does not discharge survival clauses or unresolved claims. Assign post-term custodian and next review date for surviving obligations.

**Cross-domain acceptance:** each recovery/transfer/release record identifies controlling source and version, authority, action owner, formal submission/notice evidence, effective date or unresolved status, financial reconciliation where applicable, surviving obligations, and custodian. No award, instrument, subrecipient, or agreement can disappear from active reporting merely because project scope changed or funding stopped.

## Shared notifications, audit, and export

Generate configurable reminders for assignments, deadlines, grant reports, draw claims, appropriation periods, expiring instruments, renewal notices, unresolved authority determinations, stale source verification, conditions, decisions, and blocked dependencies. Notification record stores recipient, channel, sent/failed state, timestamp, link, and escalation. Reports expose source date, filters, status definitions, and underlying records. Case dossier export includes index, source snapshot, current and superseded versions, cost/funding reconciliation, approvals/delegations, submission/receipt, instruments/conditions, exceptions, audit log, and manifest. Access controls apply to both individual records and aggregate exports.

## Source handling

The Grants.gov links referenced by the source workflow were reachable during preparation and describe applicant setup/workspaces and general grants-management phases. They are examples of workflow resources, not substitutes for a live notice, award, agency instruction, or local controlling authority. Verify source contents and amendments when each case is handled. No jurisdiction-specific permit requirement or legal deadline is asserted here.
