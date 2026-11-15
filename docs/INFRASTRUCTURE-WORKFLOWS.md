# GridSentinel infrastructure lifecycle workflows

**Purpose.** Product specification for a universal owner lifecycle workspace. Track an infrastructure initiative from first intake through retirement, with accountable people, evidence, decisions, dates, and linked records. This is a workflow/product model; each owner must configure its own governing requirements and approvals.

Related: [Infrastructure lifecycle](./INFRASTRUCTURE-LIFECYCLE.md) · [Infrastructure cases](./INFRASTRUCTURE-CASES.md).

Workflow friction guide: [experienced-staff journeys, reuse, bulk work, handoffs, safeguards, and acceptance](./INFRASTRUCTURE-FRICTION.md) · [Area Scan UI preview](./infrastructure-workflow-preview.html).

Procedure manuals: [Development (intake, feasibility, land, engineering)](./INFRASTRUCTURE-PROCEDURES-DEVELOPMENT.md) · [Authorizations](./INFRASTRUCTURE-PROCEDURES-AUTHORIZATIONS.md) · [Delivery](./INFRASTRUCTURE-PROCEDURES-DELIVERY.md).

## Product contract

- A **case** is the durable container. It has a unique ID, asset/site/region links, initiative type, lifecycle stage, accountable owner, status, risk, dates, and evidence index.
- A **work item** is an assigned action with assignee, due date, dependencies, status, and completion evidence. A **decision** records question, options, recommendation, decision authority, rationale, conditions, date, and evidence.
- Every object has creator, created/updated timestamps, source, visibility, version, and audit history. Preserve superseded documents; never silently replace evidence.
- State changes require configured roles and required fields/evidence. Store blocked, waived, not-applicable, and pending states with reason and approver. “Complete” means evidence accepted by the named owner, not a claim of external approval.
- Shared shell: lifecycle board, case workspace, stage checklist, dependency/milestone timeline, decision log, evidence/documents, people/organizations, risks/issues, activity/audit. Global search and filters by owner, stage, region, asset, due date, blocker, funding, and status.
- MVP screens: portfolio board; case overview; stage workspace; decision/evidence drawer; organization/contact directory; document register; approvals inbox; reporting/export. Each stage workspace uses configurable templates, not hard-coded jurisdiction rules.
- Cross-cutting acceptance: authorized users can create/edit/assign; unauthorized users cannot approve restricted decisions; all transitions retain actor/time/rationale; evidence links resolve and show version/status; filters and exports respect access controls; overdue/blocked work is visible; reopening preserves close history.

## Lifecycle map and parallel work

`Intake → Feasibility → Land engagement → Capital & financing → Permits, licenses & agreements → Engineering → Procurement → Construction → Commissioning → Operations & renewal → Decommissioning`

Branches run in parallel when prerequisites allow: feasibility alternatives and preliminary land screening; financing plan and grant search; permit applicability review and engineering development; long-lead procurement planning and design; operations readiness and commissioning planning. Configure gates to local policy. Default milestones: M0 intake accepted; M1 preferred alternative; M2 site/control path; M3 funded/authorized; M4 design and external approvals ready; M5 notice-to-proceed readiness; M6 substantial construction complete; M7 accepted in service; M8 renewal/retirement decision; M9 retired and records archived. Gate decisions record conditions and carry-forward actions.

## Shared case and evidence model

Case fields: ID, title, description, owner organization/team/person, sponsor, initiative/asset type, existing asset IDs, candidate sites/geometry, service territory, lifecycle stage/status, priority, strategic objective, communities/stakeholders, cost range/currency/base date, schedule range, risk rating and basis, data confidence, funding status, next milestone/date, blockers, tags, linked cases, sensitivity/access class.

Evidence fields: ID, title/type, issuer/author, date, received date, version, file/URL, related stage/work item/decision, source, reviewer, review status, expiry/review date, confidentiality, supersedes, notes, checksum where supported. Documents support templates, upload/link, metadata capture, version comparison, review/accept/reject, export manifest, and retention policy configured by owner.

Common actors: project sponsor; lifecycle/case manager; asset owner; planning/engineering leads; finance/grants lead; land/community engagement lead; procurement; construction manager; operations/maintenance; safety/environmental/compliance reviewers; counsel/authorized signatories; external applicants, agencies, utilities, vendors, contractors, landholders, and affected communities. Roles are configurable, scoped by organization/case, and separated where owner policy requires.

## 1. Intake and emergency intake

**Trigger / actors.** New need, observed condition, customer/community request, outage/hazard, strategic program, or emergency report. Reporter, dispatcher/on-call lead, asset owner, case manager.

**Implement.** `New case` form supports standard and emergency paths. Required: reporter/contact or anonymous flag, time/source, location/asset (map pin and uncertain location), observed need/event, affected service/population if known, urgency, immediate actions taken, attachments, privacy flag. Emergency path adds incident link, callback channel, current status, responsible on-call role, next update time, and handoff log; show owner-configured escalation contacts and an explicit “not dispatch/911” notice where appropriate. Deduplicate suggestions by asset/location/time without auto-merging. Triage inbox supports assign, request details, link duplicate, accept, defer, or reject with reason.

**Decision rights / evidence.** Duty/triage role accepts and sets severity; asset owner confirms asset relationship; case manager owns lifecycle after acceptance. Evidence: original report, location/source, triage rationale, assignment and acknowledgement, incident/handoff references.

**Dependencies / exceptions.** Unknown location, no asset match, anonymous reporter, conflicting reports, after-hours, immediate danger, duplicate, sensitive personal data. Emergency cases may advance to response coordination while normal required details remain incomplete; mark missing data and owner.

**Completion / acceptance.** M0 when accepted, owner assigned, urgency and next action/date set, and source evidence retained. Test: submit normal and emergency cases; required validation differs; duplicate is linked not destroyed; on-call assignment and acknowledgement appear in history; unauthorized reporter cannot view restricted case.

## 2. Feasibility and alternatives

**Trigger / actors.** Accepted need or emergency stabilization follow-up. Sponsor, planning, engineering, operations, finance, environmental/community reviewers.

**Implement.** Alternatives workspace creates baseline/do-nothing, candidate options, and hybrid options. Capture service objective, demand/load assumptions, site/route, capacity, reliability/resilience, constructability, schedule, lifecycle cost range, operating needs, impacts, constraints, dependencies, uncertainty, data sources, and scoring weights. Compare side-by-side; retain assumptions and model/version. Upload screening studies and record data gaps. Decision page supports shortlist/preferred/no-go with rationale, dissent, conditions, approver, and revisit date.

**Decision rights / evidence.** Sponsor or configured investment authority selects preferred path; technical leads attest discipline inputs. Evidence: need statement, alternatives analysis, assumptions/data register, risk/impact review, decision record.

**Dependencies / exceptions.** Incomplete data, changing demand, infeasible sites, emergency interim option, no viable option, study required. Permit provisional recommendation with confidence and conditions; no fabricated precision.

**Completion / acceptance.** M1 when objective, at least one viable alternative or documented no-go, key risks/unknowns, and authorized decision recorded. Test: changing weight or assumption creates a new version; no-go closes with rationale; provisional choice exposes unresolved studies and dependencies.

## 3. Land engagement and site control

**Trigger / actors.** Candidate site/route identified; runs beside feasibility and approvals planning. Land lead, sponsor, survey/engineering, community liaison, landholder/agent, counsel.

**Implement.** Parcel/route map and engagement log. Fields: parcel/owner reference, contact preference, relationship/status, access needs, proposed instrument type (configurable), area/route, valuation basis, constraints/easements, survey/title/environmental diligence status, offer/response dates, negotiation owner, confidentiality, next action. Templates: first-contact brief, meeting notes, access request, nonbinding term sheet/LOI draft, diligence checklist, negotiation summary, signature routing cover sheet. Clearly label drafts and require authorized review/signature outside or through configured signing integration. Track community outreach separately from property negotiation.

**Decision rights / evidence.** Authorized land/signatory role approves commitments; land lead records engagement; counsel reviews configured instruments. Evidence: map/parcels, contact/meeting log, diligence findings, executed instruments or documented lack of control, approvals.

**Dependencies / exceptions.** Multiple owners, unknown ownership, restricted access, refusal, sensitive location, route change, no contact, negotiated terms. No land control inferred from outreach or draft; alternatives branch reopens if site unavailable.

**Completion / acceptance.** Site-control milestone satisfied by owner-configured evidence status, or explicitly waived/at-risk by authorized decision. Test: draft cannot display as executed; parcel changes invalidate affected review links; access permissions protect sensitive terms.

## 4. Capital and financing

**Trigger / actors.** Alternative selected for development; finance plan proceeds alongside grant search. Sponsor, finance lead, treasury, asset owner, investment authority, lenders/partners as applicable.

**Implement.** Sources-and-uses ledger: source/use, amount range, currency, base year, eligibility/conditions, status, responsible party, commitment date, cash timing, match/repayment/contingency assumptions, evidence. Model project phases, capital and lifecycle costs, funding gap, sensitivity, affordability, and draw schedule. Separate identified, applied, conditional, awarded/committed, and received amounts. Approval workflow for budget version and funding plan. Templates: business case, sources-and-uses, financing assumptions, funding-gap memo, authorization record.

**Decision rights / evidence.** Finance validates figures; authorized body approves budget/borrowing/commitment per owner policy. Evidence: estimates, model version, approval minutes/authorization, executed commitment documents, draw/receipt records.

**Dependencies / exceptions.** Cost escalation, delayed award, match gap, co-funding conditions, currency/base date mismatch, contingent financing. Reforecast creates version and variance; do not count pending funds as available.

**Completion / acceptance.** M3 requires approved budget and a credible, status-labeled funding path plus explicit residual gap/conditions. Test: pending application does not enter committed total; changing cost base flags incomparable estimates; approval and superseded budget remain auditable.

## 5. Grants, incentives, permits, licenses, agreements

### 5A. Grants and incentives

**Trigger / actors.** Feasible option and funding need; opportunity discovery can run in parallel with land and early design. Grants lead, finance, technical writers, sponsor, authorized applicant/signatory, partner/subrecipient as relevant.

**Implement.** Opportunity pipeline records program/source URL, sponsor, notice/version, deadlines/time zone, applicant/partner eligibility (unverified/verified/unknown), geography/technology, allowable-use questions, award range, match/ cost-share terms as stated by source, required registrations/forms, internal owner, go/no-go date, decision, and source snapshot. Qualification checklist links each criterion to evidence and reviewer; do not auto-assert eligibility. Application workspace has requirement matrix, narrative sections, budget/justification, work plan, milestones, partner letters/commitments, certifications, attachments, owner/reviewer, due date, validation state, submission receipt/confirmation, and versioned export package. Templates: opportunity brief, eligibility question log, go/no-go memo, narrative outline, budget justification, partner request, compliance/conditions register, progress/final report schedule, closeout checklist. Post-award workspace converts award conditions and reporting dates into owned tasks; track amendments, draw requests, performance reports, financial reports, monitoring requests, closeout status, and retained evidence. Example flow follows Grants.gov applicant Quick Start for account/workspace/application submission and Grants Management guidance for post-award administration; confirm each live program's current instructions at source: [Applicant Quick Start Guide](https://www.grants.gov/quick-start-guide/applicants), [Grants Management](https://www.grants.gov/learn-grants/grant-careers/grants-management.html).

**Decision rights / evidence.** Grants lead recommends; authorized applicant/signatory approves and submits; award terms govern post-award responsibilities as recorded by owner. Evidence: dated notice and source, eligibility review, approved application package, submission receipt, award/denial notice, executed acceptance/conditions, reporting/draw receipts, closeout acceptance.

**Dependencies / exceptions.** Registration pending, partner missing, deadline change, ineligible/uncertain criterion, no award, award below request, restricted costs, match unavailable, amendment/extension. Block submission when required owner-defined validations fail; allow “submitted with exception” only if authorized and documented. Calendar deadlines with time zone and reminders.

**Completion / acceptance.** Application branch closes with submitted receipt or documented no-go/decline; awarded branch closes only when conditions, reporting, financial reconciliation, and closeout evidence are accepted by grant owner. Test: package is versioned; submission timestamp/receipt is required; award status differs from application; late/missed report flags escalation; source links and reporting tasks persist.

### 5B. Permits, licenses, and agreements

**Trigger / actors.** Candidate site/route and concept exist; applicability assessment starts early, detailed packages proceed with design. Permitting coordinator, technical disciplines, environmental/community reviewers, counsel/signatories, agency/utility counterparties.

**Implement.** Requirements register is configurable and jurisdiction/program neutral: requirement name/source, applicability status and basis, responsible authority/counterparty, applicant, trigger/prerequisites, submission package, reviewer, status, dates, conditions, expiration/renewal, dependencies, evidence. Distinguish “not assessed,” “potentially applicable,” “confirmed applicable,” “not applicable with rationale,” “submitted,” “issued/executed,” “denied,” “expired.” Track agreements (utility/interconnection, access, service, host/community, construction interfaces) with parties, draft/negotiation/execution state, obligations, dates, owner, and linked conditions. Templates: applicability memo, agency/counterparty meeting record, application index, response tracker, commitments/conditions matrix, agreement issue list, signature routing sheet, expiry calendar. No automatic legal determination; provide configurable checklist and source citation.

**Decision rights / evidence.** Discipline lead provides inputs; authorized compliance/counsel role accepts applicability basis; authorized signatory executes agreement; external authority issues permit. Evidence: source/version, determination rationale, submitted package/receipt, issued instrument or signed agreement, conditions and evidence of discharge, amendments/expiry.

**Dependencies / exceptions.** Unknown jurisdiction, agency consultation, redesign, appeal/dispute, conditional issuance, multiple authorities, third-party agreement, lapse. Unknown stays open; changes to site/design flag impacted determinations; conditions become tasks before relevant gate.

**Completion / acceptance.** M4 requirement set has an owner-reviewed disposition for every identified item; required instruments are recorded with conditions and dates before configured work authorization. Test: not-applicable needs rationale/reviewer; expired instrument alerts; design/site change flags linked items; only authorized role marks external issuance evidenced.

## 6. Engineering continuity

**Trigger / actors.** Preferred alternative; concept studies start early; design matures through procurement/construction and as-built handover. Engineering manager, discipline engineers, asset owner, operations, safety, quality, external designers.

**Implement.** Versioned requirements and design basis: functional/performance needs, interfaces, assumptions, site constraints, standards references selected by owner, calculations/model versions, drawings, equipment schedules, hazards, reliability/maintainability, cybersecurity/data needs, review comments, approvals, design maturity, change requests. Maintain traceability from need and permit/land condition to requirement, drawing/specification, test, and as-built record. Review gates configurable (concept/30/60/90/IFC or owner-defined); record reviewers, comments, disposition, open deviations, and release status. Templates: design basis, interface register, calculation/drawing register, design review minutes, RFI, technical query, change notice, redline/as-built index.

**Decision rights / evidence.** Design authority approves release per owner delegation; discipline leads sign their review; asset owner/operations accepts maintainability inputs. Evidence: approved revisions, review dispositions, calculations, requirements trace, change authorization, as-built set.

**Dependencies / exceptions.** Survey or data gaps, vendor substitution, design change, unresolved comments, interface mismatch, urgent field change. Baseline remains immutable; assess schedule/cost/permit/procurement impacts; field deviations require disposition and as-built update.

**Completion / acceptance.** Design release gate requires required reviews closed or formally dispositioned and linked risks/conditions owned. Test: superseded drawing remains retrievable; a changed interface flags downstream items; unapproved revision cannot be shown as released.

## 7. Procurement and contracting

**Trigger / actors.** Defined packages and funding/authorization path; procurement strategy can start before final design. Procurement lead, engineering, finance, counsel, safety/quality, bidders/vendors, contract authority.

**Implement.** Package plan: scope, estimate/budget, market strategy, schedule, interfaces, evaluation criteria, conflicts/declarations where owner policy requires, required approvals, bidder list/access, addenda, questions, bid receipt, evaluation scores/comments, recommendation, award, contract obligations, insurance/quality submittals, delivery dates, long-lead status, change orders, claims/issues. Templates: procurement plan, request package/statement of work, bid evaluation, negotiation record, award recommendation, contract obligations matrix, purchase order, vendor submittal register, change order.

**Decision rights / evidence.** Evaluators score; procurement validates process; authorized contracting officer/body awards and signs per owner rules. Evidence: issued package/addenda, bids, evaluation, approval, signed contract/order, required submittals, delivery/acceptance records.

**Dependencies / exceptions.** Sole source, no bids, protest, vendor failure, supply delay, redesign, budget change, confidential bids. Restrict bid visibility; exception path records basis and approver; delivery variance updates schedule and risk.

**Completion / acceptance.** Package ready for construction when authorization, executed scope/contract, interfaces, submittals and delivery plan are recorded. Test: evaluation access is role-limited; award cannot precede configured approvals; change order updates forecast and audit trail.

## 8. Construction

**Trigger / actors.** M5 authorization/readiness and contracted package. Construction manager, owner engineer, contractor, safety/quality, land/environmental coordinators, operations, inspectors as applicable.

**Implement.** Work breakdown and schedule; site/logistics/access; daily/weekly progress; quantities and percent complete with basis; safety/quality observations and corrective actions; inspections/tests; RFIs/submittals; nonconformance/deviation; change orders; cost commitments/forecast; permit/land condition obligations; outage/interface requests; photo/document logs; punch list. Templates: mobilization readiness, lookahead, daily report, meeting minutes, inspection/test record, RFI, nonconformance, change request, substantial completion, punch list.

**Decision rights / evidence.** Contractor reports; owner construction lead verifies progress; designated quality/engineering authority dispositions work; authorized contract role approves change. Evidence: dated logs/photos, inspection/test records, approved changes, quantities, redlines, corrective action closure, completion certification as defined by contract.

**Dependencies / exceptions.** Weather, access loss, incident, defect, discovery, material delay, design change, change in scope. Pause affected work, record responsible authority and safe restart evidence according to owner procedures; escalate schedule/cost forecast.

**Completion / acceptance.** M6 when configured scope is installed, open items are classified/owned, critical test/inspection evidence present, and completion status accepted by authorized owner. Test: unresolved critical nonconformance blocks gate; approved change revises baseline; field record links to drawing and contract package.

## 9. Commissioning and handover

**Trigger / actors.** Construction reaches turnover readiness. Commissioning lead, engineering, contractor/vendor, operations, safety, asset data/IT, owner acceptance authority.

**Implement.** Commissioning plan links system boundaries, prerequisites, test scripts, instruments/calibration evidence if required by owner, acceptance criteria, witnesses, results, defects, retests, energization/operational authorization workflow, training, spares, manuals, warranties, asset register, maintenance plans, emergency procedures, configuration backups, as-builts. Templates: turnover dossier index, readiness certificate, test procedure/result, defect log, training attendance, asset data handover, operational acceptance, lessons learned.

**Decision rights / evidence.** Test owners execute; commissioning authority reviews; operations accepts handover; energization/return-to-service authority follows owner process. Evidence: approved test results, resolved/accepted defects, training/asset records, manuals/as-builts, signed handover and acceptance decision.

**Dependencies / exceptions.** Failed test, incomplete documentation, deferred test, conditional acceptance, missing training/spares. Record risk, temporary controls, owner, due date, re-test; do not represent deferred tests as passed.

**Completion / acceptance.** M7 requires owner-defined commissioning acceptance and named operational custodian, with all exceptions dispositioned. Test: failed result cannot satisfy pass criterion; retest creates new result; handover package completeness is measurable and exportable.

## 10. Operations and renewal

**Trigger / actors.** Accepted asset enters service; recurring inspections, events, performance, contract/warranty expiry, or renewal horizon. Operations owner, maintenance planner, control/dispatch roles as configured, asset manager, finance, vendors, case manager.

**Implement.** Asset hierarchy and operational baseline; operating limits/procedures linked from owner sources; telemetry/inspection/event links; maintenance plan/work orders; outage/degradation and incident cases; performance/reliability/cost trends; warranty/service agreement obligations; risk and condition reviews; renewal forecast; change control for upgrades. Templates: operations handover checklist, inspection/maintenance plan, event review, condition assessment, renewal business case, warranty claim, operating procedure review. Integrate existing work-management/SCADA systems through links or APIs; GridSentinel is not a control command surface by default.

**Decision rights / evidence.** Operations authority manages operation under its procedures; asset manager recommends renewal; funding/investment authority approves replacement/upgrade. Evidence: inspections/work orders, performance records, event review, renewal assessment/decision, completed upgrades and updated baseline.

**Dependencies / exceptions.** Missing telemetry, asset identity mismatch, abnormal event, warranty dispute, maintenance backlog, change of operator, renewed license/contract. Flag data freshness; incident spins linked case; critical risk escalates via owner-configured channel; no inferred real-time safety state from stale data.

**Completion / acceptance.** Routine operations remain open until renewal, transfer, or retirement decision; renewal creates linked lifecycle case. Test: overdue maintenance/renewal appears in owner view; events link to asset and evidence; stale source is visibly timestamped; upgrade preserves prior asset baseline.

## 11. Decommissioning and closure

**Trigger / actors.** End-of-life, replacement, transfer, obsolescence, uneconomic operation, or owner decision. Asset owner, operations, engineering, environment/safety, finance, land, counsel, vendors, records custodian.

**Implement.** Retirement case captures reason, alternatives, affected services/parties, replacement/transition dependencies, shutdown sequence owner, isolation/transfer responsibilities, contracts and permits to close/transfer, land restoration/disposition obligations, waste/material handling records as owner-configured, data/system access retirement, asset register updates, financial closeout, records retention, residual risks and ongoing monitoring. Templates: retirement business case, stakeholder notice log, shutdown/transfer plan, obligations checklist, disposition/receipt record, restoration evidence, contract closeout, final asset status certificate, lessons learned.

**Decision rights / evidence.** Authorized asset/investment authority approves retirement; designated operations authority executes shutdown/transfer; records custodian accepts archive. Evidence: approved decision, completion/transfer records, obligations disposition, updated inventory, financial/contract closeout, final evidence manifest.

**Dependencies / exceptions.** Replacement delay, continuing service need, contaminated/unsafe condition, disputed ownership, residual obligation, records hold. Keep case open with custodian and review date; pause only affected tasks; do not equate physical shutdown with completed retirement.

**Completion / acceptance.** M9 when asset status, service transition, obligations, contracts, records, residual risks, and evidence archive have named accepted dispositions. Test: open obligation prevents closure unless authorized waiver with rationale; retirement links replacement case; archived documents remain searchable under configured access/retention.

## Cross-stage notifications and reporting

Configurable reminders for assignments, due dates, deadlines, expiring instruments, stale evidence, decision requests, blocked dependencies, and milestone changes. Each notification records recipient, channel, sent/failed state, and link; escalation rules are owner-defined. Portfolio reports: stage aging, milestone variance, blocker/decision queue, cost/funding status by confidence, grant deadlines/reports, permit/condition obligations, evidence completeness, exceptions, and forecast. Every aggregate exposes its source date, filters, and underlying cases. Export case dossier with index, current/superseded distinction, decisions, approvals, and audit manifest.

## Delivery sequence

1. **Foundation:** case/evidence/work-item/decision models; roles; audit; portfolio and case shell; intake and triage.
2. **Planning:** alternatives, milestone/dependency engine, land engagement, shared document register.
3. **Capital and external obligations:** financing, grant pipeline/application/reporting, configurable permit/agreement register and calendars.
4. **Delivery:** engineering baselines/change traceability, procurement package and approvals, construction progress/quality/change.
5. **Handover and stewardship:** commissioning gates, asset/operations handover, maintenance/renewal cases, retirement/archive.
6. **Integrations and reporting:** identity, file storage/e-signature, finance/grant/work management, map/asset systems, notifications, export APIs. Keep external integrations optional and record sync freshness/errors.

Build each slice as a thin end-to-end workflow: create case, assign role, attach versioned evidence, record decision, advance gate, and report state. Gate definitions, templates, vocabulary, retention, deadlines, delegation, and escalation are tenant-configurable. Avoid hard-coded statutory timelines, eligibility judgments, engineering thresholds, or signatures; cite the owner-configured authoritative source and retain reviewer decision.
