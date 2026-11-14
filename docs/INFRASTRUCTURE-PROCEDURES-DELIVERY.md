# Infrastructure delivery procedures: procurement through closure

**Purpose.** Practitioner procedure catalog for lifecycle stages 7–11 in [INFRASTRUCTURE-WORKFLOWS.md](INFRASTRUCTURE-WORKFLOWS.md). It specifies implementable records, approvals, evidence, exceptions, and acceptance. It does not replace owner policy, contract terms, engineering judgment, or jurisdiction-specific requirements. Configure authorities, criteria, deadlines, retention, and vocabulary from owner-approved sources. Never infer legal compliance or technical safety from form completion.

**Stable traceability IDs.** PROC-* maps to workflow row 7; CONST-* to row 8; TURN-* to row 9; OPS-* to row 10; RET-* to row 11. IDs identify procedures and may be referenced by product requirements and training.

## 1. Shared record and control rules

Every record stores immutable ID/type, case and asset/package IDs, title, owner/team, status, timestamps, source/effective dates as applicable, sensitivity/access class, due date, linked predecessor/successor, evidence and decision references, version, and audit history. Preserve submitted and superseded versions, original field observations, failed tests, rejected options, and approvals.

Evidence fields: evidence ID, title/type, issuer/author, received or observed date, effective period, source system/file reference, version/hash if available, related asset/contract/work/requirement/decision, reviewer, verification status, limitation/confidence, sensitivity, retention class. Statuses distinguish draft, received, reviewed, accepted, rejected, superseded, stale. A link is not proof that source is current or accessible; record access and last-check time.

Decision fields: decision ID, question/options, recommendation, authority and delegation basis, date, rationale, conditions, evidence, scope, follow-up owner/date, dissent/reservation if recorded, and superseded decision link. Work items store owner, due date, dependency, evidence required, reviewer, blocker, escalation, status. Deferred or waived items need approver, rationale, limits, risk owner, interim control, review/expiry date. Keep gate definitions and versions configurable.

Roles to configure: procurement lead, evaluator, procurement reviewer, contracting authority, construction manager, owner engineer, safety/quality authority, commissioning lead, executor/witness/reviewer, operating acceptance authority, operations custodian, finance/payment approver, asset/investment authority, records custodian. Record role-at-time-of-action and delegation. Restrict bid, personnel, incident, security, land and operating data by need-to-know. Record access and recusals.

Keep decisions separate:
1. Technical turnover/readiness.
2. Commissioning or operational acceptance and custody.
3. Contractual substantial/final completion under contract.
4. Invoice/payment authorization against contract and verified basis.
5. Beneficial use/service start under owner-defined authority.
Each has independent evidence, authority, date, scope, conditions. None auto-approves another.

## 2. Procurement and contracting (PROC; workflow row 7)

### PROC-01 — Strategy, package, readiness
**Trigger/owner:** Delivery need, defined package boundaries and funding/authorization path. Procurement lead owns; engineering, finance, counsel, safety/quality, operations, sponsor contribute.

Plan fields: case/package ID; scope/exclusions and version; deliverables/interfaces; design maturity and assumptions; estimate, currency, base date, confidence/contingency basis; funding status; schedule/long-lead items; market approach and source; risks; evaluation method and criteria; required submissions; conflict/declaration controls per policy; confidentiality/access; contract form/version source; issue route; approvals. Readiness checklist confirms scope owner/version, interface and site constraints, credible funding path, evaluation criteria frozen before issue, roles assigned, deadline/timezone/receipt method set, Q&A/addenda route, access controls, and approvals.

Procurement lead recommends issue; configured authority approves. Block issue on configured missing prerequisites unless authorized exception has rationale, risk, approver, scope and review date. Changes after issue require controlled addendum or cancellation/reissue. Evidence: approved plan, package baseline, approval, issue timestamp/channel/recipients. Acceptance: all required fields and issue authority recorded.

### PROC-02 — Solicitation and bid receipt
Keep issue/addendum versions, release time, distribution, acknowledgements, question/cutoff, approved answers and recipients. Submission receipt fields: bidder, time/timezone, channel, package version, file manifest, integrity check, receipt operator, confidentiality, withdrawal/correction/late status, secure storage link. Keep original immutable and sealed from evaluators until configured release; log opening event/attendees.

Procurement custodian verifies receipt; never silently alter/discard or cure. Late, corrupted, duplicate, withdrawn, misdirected bid goes to authority with governing source and decision. Evidence: original bid, receipt, addenda/Q&A, opening and exception records. Acceptance: each bid dispositioned; authorized evaluators see correct version only.

### PROC-03 — Evaluation and recommendation
Freeze criteria/weights and solicitation version. Record evaluator assignment, declaration/recusal, instructions, independent score, moderation method. Per criterion: ID/version, score or configured pass/unknown, evaluator, rationale, evidence/page, clarification request/answer/approval, uncertainty, moderation change and reason. Separate responsiveness review from scored evaluation where configured. Any permitted normalization/arithmetic correction records formula, inputs, reviewer and authorization. Do not add criteria after issue or auto-decide eligibility.

Recommendation includes comparative summary, price basis/exclusions, schedule, technical fit, risks, exceptions, clarification, ranking under approved method, funding fit, dissent and route. Procurement review validates process; evaluators recommend; authorized body decides. Conflict triggers access pause, recusal and reassignment. Protest/challenge preserves record, links claims/response and follows owner hold path. No acceptable bid routes to documented reissue or approved alternative, never default award. Acceptance: result reproducible from saved inputs and method.

### PROC-04 — Award and contract execution
Award form: package/solicitation version, selected supplier, scope/value/currency/tax basis, funding and budget, evaluation result, exceptions/conditions, authority/delegation, rationale/date, hold status, next steps. Award is not signed contract. Execution record: parties/legal entities; ID and signed version; effective date as instrument states; scope, price/ceiling, schedule/milestones, deliverables, contacts, invoice/payment milestones, submittals, warranty/service, change/claims notices, interfaces, closeout duties, applicable data/security/records terms if present, source for each term. Keep draft distinct from executed. Log notices where owner process requires. Acceptance: authorized decision, approvals, executed evidence and notice dispositions. Transition obligation matrix to PROC-05.

### PROC-05 — Obligations, delivery, invoice/payment
Obligation row: ID, clause/reference, owner/vendor, due date/trigger, required evidence, reviewer/approval role, status, acceptance date, payment line, dependency, exception/waiver. Submittal register tracks revision, review, comments and resubmission. “Reviewed” is not “approved for construction” unless exact disposition recorded.

Delivery receipt: item/quantity/serial/lot, dates, condition, inspection, discrepancy, custody/location, accept/partial/reject authority, repair action, asset link. Progress quantities require measured basis.

Invoice form: invoice ID/date/period/currency/amount/tax; contract and approved changes; milestone/schedule-of-values line; claimed and accepted quantities with evidence; prior/cumulative amount; contractual credits/retention; disputed amount/reason; reviewer; budget check; finance authorization; payment reference/date/status. Contract role verifies entitlement; finance authorizes under owner controls. Reconcile changes, prevent duplicate claims, segregate disputed lines. Payment is not turnover or beneficial use, and does not imply acceptance of defect unless explicit contract decision says so.

Missing submittal, rejection, delay, vendor failure, supply issue, claim, disputed invoice or budget gap becomes issue with source, notice dates as contract states, impact, owner, response, interim control and forecast. System does not calculate legal rights. Acceptance: obligation status visible; invoice ties to contract plus executed changes and accepted basis, or disputed lines are held separately.

### PROC-06 — Change, claim and closeout
Change fields: requestor/date/reason; affected scope/drawings/requirements; alternatives; quality/safety/permit/land/operations impacts; schedule basis; cost/currency/base date/funding; risk; vendor proposal; independent review; affected obligations; disposition; authority; signed change; revised baseline. Statuses distinguish proposed, analyzed, rejected, approved pending execution, executed, implemented, verified, closed. RFI, field direction, forecast or submittal does not change contract absent authorized execution. Emergency direction uses configured authority and retrospective record; no silent bypass.

Claim record: notice received, contract reference, event/timeline, asserted entitlement/amount as vendor claim, owner position, evidence, deadline source, counsel review, status/resolution, decision authority. Keep allegation separate from accepted liability.

Closeout checklist: deliverables accepted/dispositioned; quantities/invoices reconciled; change and claim registers reconciled; warranties/service contacts indexed; spares, manuals/as-builts, training, defects/punch obligations, required closeout evidence, access/data removal tasks, turnover links, final status. Contract authority and finance decide closeout/final payment independently. Open obligations stay visible.

## 3. Construction (CONST; workflow row 8)

### CONST-01 — Mobilization readiness
Construction manager owns after authorized gate and executed package. Record package/work breakdown; approved drawing/spec versions; contract/changes; land/access evidence; owner-configured permits/conditions; logistics/emergency contacts; contractor staffing and submittals; inspection/test plan and witness/hold points; safety/environmental evidence; materials/long-leads; outages/interfaces; schedule/lookahead; community/public impacts; cost baseline; document/photo conventions; turnover boundary; stop/restart authority.

Construction manager recommends, owner-authorized role accepts readiness. Missing critical access, design, interface or configured prerequisite blocks affected work unless exception specifies scope, controls, approver, owner and expiry. Evidence: readiness disposition, baselines, named leads, authorizations.

### CONST-02 — Daily field records and progress
Daily form: project/package/location/date/shift/timezone/reporter; crews/hours/equipment; activities tied to work breakdown/drawing; quantity and measurement basis; planned/actual; deliveries; weather/source; interfaces/outages; safety/environment observations; inspection/test, RFI/submittal; delay cause marked reported or verified; instructions; geotagged/time-stamped photos; constraints; next shift. Weekly lookahead captures prerequisite, access, inspection/witness, material, interface and owner. Minutes distinguish decisions from discussion and include action/owner/date.

Contractor reports; owner lead verifies quantities and progress. Keep contractor-reported and owner-verified values separate; retain source, baseline version, variance/confidence. Percent complete cites quantity or approved weighting method. No subjective percent becomes payment evidence without authorized basis. Missing report is explicit exception.

### CONST-03 — Inspection, test, NCR and corrective action
Inspection/test record: ID; asset/location; requirement, drawing revision and criterion source; type; responsible person; date/time; instrument/calibration evidence if owner requires; conditions, coverage/sample; measured values/units/raw file; result (pass/fail/inconclusive/not performed); witness; reviewer; deviation; retest link. Never populate actual result from plan.

NCR: discovery/person/location; requirement/evidence; extent/affected lots; containment; impact assessment authority; work hold/release decision; root-cause owner; proposed disposition; engineering/quality review; approval; corrective action and due date; verification/closure evidence; recurrence link. “Use as-is” requires explicit owner/contract authority; do not label nonconforming work compliant. Failed/ambiguous test, missed witness, instrument issue or systemic defect triggers evidence preservation, affected-boundary assessment, hold/release authority and repair/retest. Corrective action reopens if verification fails.

### CONST-04 — RFI and submittal
RFI: ID, question, drawing/spec version, location, reason, proposed resolution/alternatives, cost/schedule/quality/safety/permit/land/operations impact, needed-by date, requester/response owner, response evidence/status/limits, change link. Answer clarifies only within delegated scope; baseline impact routes through CONST-05/PROC-06. Preserve every version.

Submittal: contract obligation, vendor doc/revision, equipment, planned/actual submission, reviewer/sequence, disposition (approved, approved with comments, revise/resubmit, rejected, received only), limits/comments, linked records. Superseded revision never shown as current.

### CONST-05 — Change, delay, outage/interface
Record origin, baseline(s), reason, alternatives, quantities, cost forecast/commitment/payment distinctions, schedule impact and basis, funding, risk, permit/land/interface/operations review, approval route, decision, signed change, implementation and verification. Link contract change PROC-06. Update baseline only after authorized decision. Outage/interface request includes affected system/party, window, operating authority, dependencies, controls, decision and recovery plan; product does not issue operating commands.

Discovery, weather, access loss, incident, substitution, delay or overrun opens issue with affected work, authority, evidence, forecast, contract-source notice date and restart conditions. Pause only affected work when authorized; forecast is not approved scope.

### CONST-06 — Completion and punch
Contractor submits scope, as-builts, quality/test records, NCRs, punch, permits/restoration as configured, quantities, training and certifications required by contract. Owner verifies evidence/walkdown. Punch fields: ID/location/system, description/photo, owner-configured class, impact/rationale, interim control, responsible party/due date, criterion/source, retest/reinspection, verifier, closure evidence, status, approving authority for carryover.

Keep contractual substantial/final completion, construction completion, turnover readiness, payment milestone and beneficial use separate. Row 8 M6 passes only when configured scope installed, critical inspection/test evidence present, open items dispositioned, approved changes reflected, and authorized owner records completion. M6 alone does not authorize operation, payment or service start.

## 4. Commissioning and handover (TURN; workflow row 9)

### TURN-01 — Boundary, plan, readiness
Plan identifies commissioning authority, asset/system boundaries and interfaces; tests, requirements/criteria sources and revisions; prerequisites; executor/witness/reviewer; instruments/calibration requirements configured by owner; sequence; safety/environment prerequisites; outage/energization/return-to-service authority; defect taxonomy; retest/deferred test process; training, data capture and archive.

Per-system readiness checks construction walkdown, current drawings/submittals, installation/inspection evidence, NCR/defect disposition, interfaces, approved scripts, equipment, assigned people, operations witness, owner-defined emergency controls, configuration/backups and access. Record pass/conditional/fail, scope and limits. Conditional gate names interim controls, owner, expiry and prohibited/permitted scope.

### TURN-02 — Test execution and retest
Test record: unique ID/version; boundary; script steps; criterion/source; expected result; executor/date/time; witness; preconditions; tools/instruments and calibration evidence if required; configuration baseline; conditions; raw result; observed values/units; pass/fail/inconclusive/not run; deviation; reviewer; defects; retest-of reference. Expected and observed stay distinct. Failed test remains failed; retest is a new linked record. Deferred test stays outstanding with owner, due date, interim risk/control and approver. It never displays as passed.

Switching, energization, live-system action and return-to-service follow owner command/authorization process. Record authorization reference, authority, prerequisites and time. Product does not issue commands by default.

### TURN-03 — Defect and conditional acceptance
Defect record links test/location/boundary, impact, owner-defined severity, assessor, containment/operating limits, owner/vendor, repair, due/review date, retest and closure authority. Risk acceptance is separate; unresolved defect cannot become “pass.” Conditional acceptance states allowed scope, limits, exclusions, controls, monitoring, custodian, expiry, closure evidence and authorized approver. If owner has no conditional pathway, gate fails. Expired condition alerts/escalates; no auto-renewal.

### TURN-04 — Dossier and operations capability
Dossier index includes asset IDs/boundaries; requirements-to-tests matrix; approved tests/exceptions; as-builts/redlines; equipment IDs/hierarchy; configuration/software/firmware/backup; operating/emergency procedures; maintenance tasks/interval sources/skills/tools; spares; manuals/warranties/contracts; training; permit/agreement and open conditions; safety/environment records; punch/NCR and controls; access/security handoff; telemetry links/freshness; custodian; manifest/archive.

Each required item status: accepted, missing, not applicable with rationale, pending or exception approved. Check link access, file versions, asset identity, instrument source, superseded markers. Training record captures material/version, trainer, attendee/role, date, system and evidence. Spares record part/source, quantity, condition, location/custodian, inventory ID and receipt. Receipt does not prove competence or adequacy.

### TURN-05 — Separate acceptance and service entry
Use independent records for:
- Technical turnover readiness: scope, dossier, test/defect disposition, remaining work.
- Commissioning acceptance: boundary, criteria/evidence, exceptions, operating limits, authority/date.
- Operations handover: custodian, assets, procedures, maintenance plan, training, spares, access, open actions and acknowledgment.
- Beneficial use/service start: owner-defined basis, scope, effective date/time, authority, conditions/evidence.
- Contract completion/payment milestone: clause and acceptance evidence, routed to PROC-05/06.

No one form infers another status. Conditional approval records limits, owner and expiry. Row 9 M7 requires owner-defined commissioning acceptance, named custodian, exceptions dispositioned. Receiving custodian acknowledges dossier and responsibilities; reject missing records with owner/action. Archive manifest, decisions, baseline, open actions and access rules. Keep failed tests and superseded data.

## 5. Operations and renewal (OPS; workflow row 10)

### OPS-01 — Asset baseline and recurring plan
Asset fields: stable ID, hierarchy/location, type/model/serial, owner/operator/custodian, status and in-service decision basis, commissioning baseline, configuration, criticality per owner taxonomy, interfaces, source/confidence, warranty/contract/permit links, maintenance/procedure references, telemetry/work-system source and freshness. Reconcile duplicate or mismatched identity before linking events.

Plan/task fields: task ID/asset; authoritative source and requirement; owner-defined interval/trigger; due/window; skills/tools/spares; procedure version; responsible role/vendor; evidence expected; escalation; verifier; last/next due and calculation basis. System may calculate from owner-set rules; it must not invent legal or engineering intervals.

Work order: ID/asset/request source/scope/priority per owner; safety authorization and outage reference if needed; assigned role/vendor; dates; procedure; parts/hours/quantities; findings/measurements/photos; follow-up defect; reviewer; cost; evidence; linked event/warranty. Closure means evidence reviewed, not that asset is normal.

### OPS-02 — Inspection, maintenance, event/incident
Execution records plan, asset, performer/date, procedure/version, conditions, values/units, instrument/source, result, defect/risk, action, verifier, next-due basis. Distinguish not due, not performed, inaccessible, deferred, completed, reviewed.

Event record: event/detection time and source; affected asset and identity confidence; reported facts vs analysis; status as supplied by authorized source/time; impact; response authority/reference (no command by default); immediate action; notifications; evidence; investigation owner; cause; corrective actions; owner-configured reporting obligations; recovery verification; closure decision/lessons. Restrict sensitive details. Link work orders, tests, notices and renewal cases.

Imported/telemetry data records source, last sync, event and ingestion timestamps, coverage/gaps, mapping confidence, units/version, errors. Stale/missing is explicit; never infer real-time safety/compliance from stale feed.

### OPS-03 — Warranty, service and compliance renewals
Obligation calendar row: instrument ID/version, issuer/source, owner, asset/site, effective/start/end or trigger as documented, renewal/notice date copied from source, owner-configured lead time, submission evidence, reviewer/signatory, cost/funding, dependencies, status, reminder/escalation, source-verification date. Include warranty, service agreement, license, permit, land instrument, grant condition, reporting, inspection and other owner-configured obligations.

At horizon: verify instrument/source; confirm applicability/operator; enumerate conditions, reports, fees, monitoring; assign technical/finance/counsel reviewers; open renewal case; capture gaps; version draft; approve/sign; submit and retain receipt; track questions/responses; record issuance/denial/amendment and conditions/effective dates; update calendar/asset; notify custodian; preserve prior version as superseded. Warranty claim tracks discovery/date, coverage clause, notice route/deadline source, vendor response, repair, dispute, recovery and history. Claim does not extend warranty absent evidence.

Denied/pending/missed renewal, operator change, disputed coverage, breach, missing report or funding gap escalates to accountable owner. Record source, impact, contingency, operating restriction decision by owner, interim control, alternate path and review date. Pending application never implies continued authorization.

### OPS-04 — Condition and lifecycle renewal
Assessment: date/boundary/method/source/assessor; evidence; owner-defined rating and basis; uncertainty/gaps; failure modes/consequences/risk owner; maintenance history; performance/reliability/cost trend; remaining-life range only with assumptions; obligations; options/recommendation/next review. Preserve model/version; unvalidated score cannot trigger safety classification.

Business case compares maintain, repair, refurbish, upgrade, replace, transfer, retire. Record service objective, scope/interfaces, risks, cost range/currency/base date/confidence, lifecycle cost, funding status, schedule, land/permit/community dependencies, operational transition, procurement, assumptions, source evidence, reviewers and decision authority. Recommendation differs from investment approval; approved work opens linked lifecycle case and preserves prior asset baseline.

Rank backlog only by owner-defined criteria; expose basis and overrides. Deferral needs authority, risk, interim control, due/review trigger. Routine operation remains open until renewal/upgrade, transfer or retirement. Overdue maintenance/renewal appears in owner view; event evidence links to asset; freshness visible; upgrade preserves old baseline.

## 6. Decommissioning and closure (RET; workflow row 11)

### RET-01 — Assessment and approval
Trigger: end-of-life, replacement, transfer, obsolescence, uneconomic operation or owner decision. Asset owner leads; operations, engineering, safety/environment, finance, land, counsel, vendors, records contribute.

Assessment fields: asset/status; reason/source; alternatives including continued operation/repair/transfer; affected service/users; replacement/dependencies; transition; risk and residual monitoring; contracts/warranties/grants/permits/land; data/access; material handling per owner policy; restoration; cost/funding; notice owners; records/retention/hold; shutdown authority/sequence; uncertainty. Authorized asset/investment authority approves, rejects, defers or conditions with scope, rationale, prerequisites, service transition, budget, notice owner, allowed actions and review date. Link successor case. No shutdown from draft or forecast.

### RET-02 — Transition and shutdown/transfer
Plan: sequence/system boundary; service continuity and notices; replacement readiness; operating authority; roles; land/vendor; owner-procedure isolation reference; environment/safety assessment; permit/notice; data backup/export/access revocation; outage window; contingency; evidence; approvals; stop/restart criteria. Designated operations authority executes controlled procedures; product records evidence and issues no equipment command.

Execution record: planned/actual date, scope, authorization, executor/witness, preconditions, state/source before/after, work, unexpected conditions/incidents, hold, service confirmation, custody, access action, approvals/follow-up. Replacement delay, service need, unsafe/contaminated condition, ownership dispute or residual duty holds affected action and assigns owner/review date. Physical shutdown is not closure.

### RET-03 — Disposition, restoration, obligations and finance
Disposition: item/material/asset, quantity/condition, owner, configured disposition, source/basis where applicable, recipient/carrier/facility, date, chain-of-custody/receipt, approval, costs/proceeds, required environment evidence and residual risk. Do not infer compliant handling without reviewer/evidence.

Obligation matrix covers every contract, grant, permit/license, land/access, service/warranty, interface and work item: status closed/transferred/continuing/disputed/not-applicable with rationale/open; source/authority; action/effective date; receiving owner acceptance; evidence; residual risk; review date. Include restoration/monitoring. Blank is never closed.

Financial/contract closeout records commitments, invoices/claims/retention per contract, proceeds, grant reconciliation, accounting reference, variance, finance/contract approver, reservations. Treat accounting/tax disposition as owner-reviewed; remove vendor/data access via owner task.

### RET-04 — Archive and final status
Certificate: asset IDs, former owner/operator, status/scope/effective date/basis, successor service link, obligations, contract/finance, physical disposition/restoration, data/access, archive manifest/location/access/retention source, residual risk/monitoring owner and due, open actions, approver, records custodian acceptance.

Custodian checks index, integrity/access, current vs superseded, owner retention/hold source, sensitive permissions and retrieval. Never delete records to close. Open hold/obligation keeps case open unless authorized exception names rationale, custodian, risk/control and review date.

Row 11 M9 passes only when asset status, service transition, obligations, contracts, records, residual risks and archive have accepted dispositions. Open obligation blocks unless authorized waiver. Archived evidence stays searchable under configured access/retention. Lessons learned record variance, incident/claim patterns and control changes.

## 7. Exceptions and reports

Common exception record: ID/procedure/asset/package; detected date/source; description/scope; owner-defined severity and assessor; immediate action/hold decision and authority; evidence; service/quality/cost/schedule/compliance impact; owner/due; interim controls; escalation; disposition; approver/source; verification; residual risk; review/expiry. Sensitive incident detail stays restricted.

Notifications for due dates, expiring instruments, failed tests, rejected evidence, stale sync, overdue work, decisions, blockers, variance. Log recipient/channel/time/sent-failed/retry/link/escalation-rule version. Failed delivery is exception. Timelines/channels owner-configured.

Reports expose source date and filters: procurement aging/bid exceptions; obligations, changes, claims and disputed invoices; construction progress basis, inspections/NCR/punch; dossier completeness, failures/deferred tests and independent acceptance/payment/service dates; maintenance/renewal overdue and data freshness; retirement obligations/residual risk/archive. Export dossier with index, current/superseded markers, decisions, access note and audit manifest.

## 8. Example linked records

Illustrative fictional set; dates/criteria are examples, not requirements. Case CASE-204; asset ASSET-PUMP-17; package PKG-MECH-03; contract CON-88; system SYS-PUMP-17.

| ID | Record | Example disposition |
|---|---|---|
| PROC-01-204 | Procurement plan | Scope SOW-3; estimate basis and funding status recorded; criteria EVAL-2 frozen; issue approval DEC-11. |
| PROC-02-204 | Solicitation | RFP-3 released 2026-04-10 09:00 PT; deadline 2026-05-01 16:00 PT; 2 addenda; 3 sealed receipts and manifests. |
| PROC-03-204 | Evaluation | 3 evaluators; recusal/reassignment logged; clarifications linked; reviewer reproduces scores; recommendation DEC-14. |
| PROC-04-204 | Award/execution | Award decision 2026-06-03; signed CON-88 v1 reviewed 2026-06-08; effective date copied from instrument. |
| PROC-05-204 | Invoice | INV-17 disputed $8,000 line pending quantity evidence; finance has not approved disputed amount. |
| CONST-01-204 | Readiness | Access, DWG-31 r4, ITP-8, outage approval linked; one approved, expiring training exception. |
| CONST-02-204 | Field report | 2026-08-12; measured 14 units; contractor reports 60%, owner verifies 54%; basis and variance retained. |
| CONST-03-204 | NCR/test | NCR-5 gasket mismatch contained; TEST-8 failed retained; repair authority recorded; TEST-9 retest passed. |
| PROC-06-204 | Change | CHG-4 $12,000 forecast request rejected; no contract baseline change or charge authorized. |
| CONST-06-204 | Completion | Installed scope accepted for construction milestone 2026-09-04; punch P-3 open with owner/date; separate contract basis. No payment/service inference. |
| TURN-01-204 | Readiness | Boundary SYS-PUMP-17; CP-6; manual pending; conditional limits, owner and review date recorded. |
| TURN-02-204 | Tests | TEST-9 pass; TEST-10 deferred with risk/control/owner/date; not shown as passed. |
| TURN-04-204 | Dossier | DWG-31 r5, training attendance, spare receipt, warranty source, MP-4; 9/10 complete, one approved exception. |
| TURN-05-204 | Decisions | Technical turnover accepted 2026-09-10; conditional custodian acknowledgment same date; beneficial-use decision absent; invoice disputed separately. |
| OPS-01-204 | Asset/plan | Baseline AB-1; MP-4 task due 2026-10-10 per owner plan; telemetry last sync timestamp recorded. |
| OPS-03-204 | Renewal | Warranty date transcribed from CON-88; owner-set lead time/reminder; reminder receipt logged; no auto-extension. |
| OPS-04-204 | Assessment | Insufficient trend data; no remaining-life estimate; data owner/review date assigned; 2028 planning case opened. |
| RET-01/04-204 | Retirement | No retirement inferred from study; eventual M9 waits for disposition, transferred monitoring owner, archive and evidence. |

## 9. Product acceptance criteria

- Procedure IDs are assignable, searchable, linkable, exportable and auditable; records/statuses/templates/authorities/gates are tenant-configurable and versioned.
- Draft, submitted, reviewed, accepted, rejected, deferred, waived and superseded are distinct; history remains.
- Authority explicit; no invented legal eligibility, engineering criteria, statutory dates or signature.
- Bid access restricted; criteria freeze before issue; award waits for configured approvals.
- Contract, authorized changes, claims, delivery, accepted quantities, invoice and payment reconcile yet remain distinct.
- Field logs trace scope/location/baseline; failed inspections, NCR and corrective actions remain visible; only approved changes revise baseline.
- Tests preserve expected/observed and failed/retest history; deferred tests never pass.
- Turnover, commissioning, operations custody, contract completion, payment and beneficial use are independent decisions.
- Dossier completeness measurable; asset, task, warranty, manual, training and exceptions have named receiving owners.
- Maintenance/renewal dates show source/basis/freshness/owner/overdue/escalation; stale data cannot imply safe or compliant state.
- Renewal/upgrade preserves old baseline and links lifecycle case.
- Retirement cannot close with open obligations/archive gaps/residual risks except authorized waiver naming custodian, control and review date.
- Failed notifications visible; export includes audit manifest and current/superseded status.

## 10. Source map

Workflow triggers, roles, gates, evidence and original acceptance tests: [INFRASTRUCTURE-WORKFLOWS.md](INFRASTRUCTURE-WORKFLOWS.md), rows 7–11. Shared case, evidence, audit, authority and configurable-rule conventions: same file, “Product contract,” “Shared case and evidence model,” and “Cross-stage notifications and reporting.” This catalog expands product behavior; legal, safety, engineering, contract, retention, procurement and finance requirements must come from owner-approved authoritative sources and responsible reviewers.

