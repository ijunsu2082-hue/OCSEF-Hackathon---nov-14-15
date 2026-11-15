# Infrastructure workflow friction guide

Companion to [Infrastructure lifecycle workflows](./INFRASTRUCTURE-WORKFLOWS.md). This guide turns the lifecycle specification into low-friction staff journeys. Keep the case as the durable record; let staff reuse verified facts and evidence instead of re-entering them. All examples assume owner-configured roles, gates, retention, and authoritative sources. The system organizes work and records decisions; it does not make engineering, legal, safety, eligibility, or statutory decisions.

Preview: [Infrastructure workflow preview](./infrastructure-workflow-preview.html).

## Default path and shared interaction rules

Start experienced staff at **My work** (due, blocked, awaiting decision, recently changed) with a persistent **Search / open case** and **New case** action. Portfolio and lifecycle board remain one click away. From a case, open the active stage directly; show the next decision, missing evidence, owner, due date, and dependencies before the full history. Intake is the default only for new work. Deep links from an asset, grant, permit, document, or notification land on the relevant case subsection and retain the return path.

Reuse case identity, parties, site/asset, approved baselines, contacts, source references, and already accepted evidence through linked references. Display origin, owner, version, accepted date, freshness, and access state. Copying creates a new version with provenance; linking preserves the source. Never silently treat stale, superseded, inaccessible, or unreviewed material as current. Allow bulk assign, date shift, status update, export, and import preview for homogeneous rows; show per-row validation and partial success, and preserve an audit entry for each changed record. Spreadsheet import maps columns, previews create/update/skip decisions, flags duplicate keys and invalid values, and supports downloadable error rows. Field use supports queued notes/photos/files and timestamps for later sync; show pending/synced/conflict state and never imply an offline decision is authoritative until reconciled.

Every handoff names a receiving role/person, what is being handed over, evidence included, unresolved items, and acknowledgement state. Sender remains visible until accepted or reassigned. Exceptions are explicit states (blocked, pending external party, unknown, waived, not applicable, rejected, sync conflict), with reason, owner, next review date, and safe next action. Users see why an action is unavailable and who can resolve it. Decision rights come from configured roles: preparers can prepare, reviewers can accept within delegated scope, authorized authorities approve/submit/waive, external parties issue their own instruments. The UI never converts a recommendation, checklist, or inferred status into approval.

## Procedure map

Each ID points to an existing procedure in the workflow specification. Use the same case, evidence, decision, and work-item records across the row; no parallel form or shadow register is needed.

| ID / existing procedure | Fast path and reuse | Bulk, field, import, handoff, exception, visible state | Safeguard and measurable acceptance |
|---|---|---|---|
| I1 Intake and emergency intake | Create from **New case** or duplicate a similar case as a draft; carry forward only explicitly selected site, contact, and evidence references. Emergency shortcut captures minimum safe facts and pages configured duty owner. | Bulk-create from approved intake sheet with row preview; field staff can save timestamped notes/photos offline. Route triage to named owner; show `triage needed`, `urgent`, `duplicate candidate`, or `incomplete`. | Only configured authority sets emergency response or accepts triage. A sample intake can be created, assigned, searched, and linked to evidence without leaving the case; urgent item is visible in My work immediately. |
| F1 Feasibility and alternatives | Open case with intake facts prefilled; compare options in a shared decision record, reusing linked studies and assumptions with source/date. | Import alternatives and criteria with units/source columns; field observations attach to option and location. Handoff states reviewer and unresolved assumptions; unknown inputs remain visible. | Authorized reviewer accepts assumptions and authority selects option. Every scored criterion traces to a source or marked assumption; selected option decision remains linked to later design. |
| L1 Land engagement and site control | Select candidate parcel/route and reuse map, owner/contact, and prior correspondence by link. Capture new outreach as dated interaction, not repeated narrative. | Bulk load parcel/contact register with duplicate preview; offline site visit notes sync with author/time. Route each negotiation item to owner; display access/consent/option/closing state and pending party. | Authorized land/legal roles accept rights evidence; no inferred consent or ownership. Sample parcel can be followed from contact to documented rights or explicit unresolved status with provenance. |
| C1 Capital and financing | Start from selected option and linked estimate; carry amount, currency, basis date, confidence, and funding assumptions into funding plan. | Import cost lines and funding sources with reconciliation totals; field progress can submit cost evidence for review. Handoff finance reviewer with variance and open assumptions. | Finance/investment authority approves forecast or commitment. Portfolio total reconciles to source lines and each forecast exposes as-of date and confidence. |
| G1 Grants and incentives | Open opportunity from source notice; reuse organization profile, approved project description, budget lines, and prior accepted attachments by reference. Application version snapshots the exact submitted package. | Bulk-load opportunities/report dates; import validates required fields and deadlines/time zones. Show registration/partner/award/report states separately. Grants lead prepares; authorized applicant signs/submits; receipts return to case. | No automated eligibility claim; decision and submission remain with authorized roles. Submission requires owner-configured checks, immutable package version, timestamp and receipt; post-award tasks retain condition/source links. |
| P1 Permits, licenses, agreements | Start applicability review from site/design version; reuse jurisdiction and source references, but prompt for impact review when design/site changes. | Bulk import instrument/condition rows with per-row owner and expiry validation; field inspection evidence links to condition. Route external response to responsible coordinator; show unknown, submitted, issued, expired distinctly. | Authorized compliance role accepts applicability; external issuance needs instrument evidence. Every identified item has reviewer disposition; expiry and design changes visibly flag linked work. |
| E1 Engineering continuity | Open current baseline and its change history; create revision by branching, link inputs and mark superseded artifacts instead of re-uploading. | Bulk register drawings/documents with revision checks; field redlines/photo notes retain location, author, and sync state. Handoff package names receiving discipline and review status. | Design authority approves baseline; no unstamped field note becomes approved design. Reviewer can locate current and prior revision, change rationale, and affected decisions in one case. |
| R1 Procurement and contracting | Build package from approved scope, baseline, budget, and applicable conditions; reuse requirements by linked version. | Bulk import bid/evaluation rows with confidentiality-aware access and validation; field receipt records delivery evidence. Handoff procurement/legal/technical reviewers in configured order; show clarification, exception, and award states. | Only delegated authority approves award or contract execution. Evaluation provenance and approvals are retained; package cannot appear awarded before recorded authority decision and executed evidence where configured. |
| B1 Construction | Open from awarded package and approved baseline; carry schedule, quality plan, conditions, and contacts forward as linked references. | Bulk progress/inspection import supports row-level errors and source timestamp; field photos/observations queue offline. Assign issue to contractor/owner with acknowledgement; show blocked work, pending inspection, and change request separately. | Site/quality authority accepts evidence and approved change control governs baseline updates. Sample issue links location, action, evidence, owner, and closure; rejected sync or inspection is not shown complete. |
| H1 Commissioning and handover | Generate turnover checklist from configured asset/contract/permit records; pull approved tests, manuals, warranties, and open items by reference. | Bulk asset/point import previews identifiers and duplicates; field test results retain instrument/operator/time and sync status. Receiving operations accepts by item or records exception and owner. | Commissioning authority accepts tests; operations authority acknowledges custody. No handover completion while configured critical item lacks accepted evidence or authorized disposition; accepted package has a searchable manifest. |
| O1 Operations and renewal | Enter asset workspace from portfolio, work queue, or asset link; reuse commissioning baseline, warranty, and maintenance schedule with freshness labels. | Import inspection/work-order history with asset-key matching preview; field capture queues observations and attachments. Route event to operations owner and renewal candidate to asset manager; stale telemetry is visibly stale. | Operations authority directs work under its procedures; renewal funding needs configured authority. Overdue work appears in owner view; event links evidence; stale source shows timestamp; renewal preserves prior baseline. |
| D1 Decommissioning and closure | Create retirement from asset page; prefill inventory, obligations, contracts, service dependencies, and records links, each with source/version. | Bulk disposition checklist import exposes unmatched obligations; field receipt/restoration evidence can sync later. Handoff shutdown/transfer to named operations authority and archive to records custodian; show hold, residual risk, or replacement delay. | Authorized investment/asset role approves retirement; operations executes; custodian accepts archive. Physical shutdown alone cannot close case; every configured obligation has accepted disposition or authorized waiver and final searchable manifest. |

## Cross-stage workflow improvements

## Practitioner procedure coverage

The catalog rows above summarize lifecycle areas; this index covers each stable procedure in the three linked practitioner manuals. Each entry names the interaction improvement and its guard. Shared defaults, evidence provenance, role checks, and sync rules in the opening section apply throughout. IDs and titles are copied from the manuals; update this index if a manual changes.

### Development manual

| ID | Friction reduction and safeguard |
|---|---|
| DEV-01 — Register need or event | Quick-create from asset/location captures source and reporter; dedupe suggestions never auto-merge. |
| DEV-02 — Emergency coordination and stabilization record | Duty view captures timeline and coordination owner fast; tracker explicitly does not direct operations or replace incident command. |
| DEV-03 — Triage and establish service baseline | Reuse asset/service history and mark unknowns inline; authorized triage role owns priority and baseline acceptance. |
| DEV-04 — Define need and appraisal frame | Clone appraisal frame with linked assumptions and sources; sponsor approves scope and criteria before comparison. |
| DEV-05 — Build, compare, and select alternatives | Compare alternatives side by side from shared inputs; decision authority selects and records rationale, not an algorithm. |
| DEV-06 — Maintain dependency and decision readiness | One dependency/decision queue rolls forward open items; each dependency has owner, due/review date, and evidence before marked resolved. |
| DEV-07 — Screen site, parcel, and route | Import/map candidate parcels with source date and duplicate check; screen is preliminary and cannot establish rights or approval. |
| DEV-08 — Engage landholders and negotiate control path | Reuse contact and correspondence log; sensitive negotiation access is restricted and only authorized evidence marks control secured. |
| DEV-09 — Community consultation and commitment tracking | Log engagement once and link issues/commitments to cases; distinguish received comment from accepted commitment and keep owner/review date. |
| DEV-10 — Establish design basis and requirements baseline | Carry approved need and constraints into versioned basis; design authority accepts each baseline and its source assumptions. |
| DEV-11 — Progress design reviews and control revisions | Review by discipline with change impact links; only delegated design authority promotes revision to current. |
| DEV-12 — Long-lead early-release gate | Assemble readiness evidence and outstanding risks in one release view; named authority explicitly accepts exposure before release. |
| DEV-13 — Plan service continuity, cutover, and return to service | Reuse current asset state, dependencies, and contacts in a cutover package; tracker records readiness and actuals but never supplies operating instructions or go command. |

### Authorizations manual

| ID | Friction reduction and safeguard |
|---|---|
| CAP-01 — Capital plan and sources-and-uses | Reuse selected option and estimate lines; finance authority accepts plan and basis date. |
| CAP-02 — Cost baseline, funding allocations, and affordability | Import allocation rows with totals and row errors; preserve source currency/basis and require reviewer acceptance of affordability. |
| CAP-03 — Multi-year appropriations and authorization | Timeline shows year-by-year request/authorization without duplicate entry; only authorized body records appropriation decision. |
| CAP-04 — Cash flow, draw, reimbursement, and reforecast | Link invoices, eligible costs, draw, and receipts; finance reviewer reconciles before marking reimbursed or forecast current. |
| GR-01 — Opportunity discovery, qualification, and go/no-go | Capture notice version/deadline once and reuse org profile; eligibility remains evidence-backed reviewer assessment. |
| GR-02 — Application readiness, assembly, review, and submission | Requirement matrix assembles a versioned export and reuses accepted attachments; signatory owns submission and receipt. |
| GR-03 — Award acceptance, conditions, and cost control | Convert award conditions to owned tasks and reuse approved budget; authorized applicant accepts terms, system does not infer allowability. |
| GR-04 — Monitoring, amendments, disputes, and closeout | Calendar reports and link correspondence/evidence; grant owner retains submission, dispute, and closeout decisions. |
| PER-01 — Authority and instrument identification | Reuse jurisdiction/source registry and agency contacts; unknown authority remains open for coordinator review. |
| PER-02 — Applicability and verification by activity, phase, jurisdiction | Compare activities against versioned source and design phase; authorized reviewer records rationale, never auto-determination. |
| PER-03 — Dossier preparation, submission, review, issuance | Reuse linked evidence in indexed dossier and track receipt/response; only external instrument evidence changes state to issued. |
| PER-04 — Conditions, renewals, changes, disputes, closeout | Condition change flags linked tasks and dates; owner accepts discharge, renewal, or documented unresolved disposition. |
| AGR-01 — Agreements and commitments | Issue list reuses parties, obligations, and related permits; authorized signatory alone records execution and amendments. |

### Delivery manual

| ID | Friction reduction and safeguard |
|---|---|
| PROC-01 — Strategy, package, readiness | Assemble linked scope, baseline, budget, and obligations; delegated procurement authority accepts readiness. |
| PROC-02 — Solicitation and bid receipt | Bulk-register bidder questions and sealed receipt metadata; maintain configured confidentiality and immutable receipt time. |
| PROC-03 — Evaluation and recommendation | Reuse criteria and score sheets with evaluator-level provenance; recommendation remains distinct from award decision. |
| PROC-04 — Award and contract execution | Route approval and execution packet with version comparison; only authorized signatories execute, then attach final instrument. |
| PROC-05 — Obligations, delivery, invoice/payment | Link deliverable acceptance to invoice and payment status; contract owner accepts, finance authorizes payment. |
| PROC-06 — Change, claim and closeout | Show change/claim impacts against baseline and open obligations; authorized roles decide entitlement and closeout. |
| CONST-01 — Mobilization readiness | One checklist reuses award, permits, and safety evidence; site authority confirms configured hold points before mobilization. |
| CONST-02 — Daily field records and progress | Mobile daily log queues offline with timestamp/location and bulk import; supervisor accepts reconciled record, not device sync alone. |
| CONST-03 — Inspection, test, NCR and corrective action | Link inspection, nonconformance, fix, and retest in one thread; qualified reviewer accepts evidence and disposition. |
| CONST-04 — RFI and submittal | Route each request against drawing/revision and due date; only authorized discipline reviewer accepts response for design use. |
| CONST-05 — Change, delay, outage/interface | Capture notice once and link schedule/cost/service impacts; authorized change and operations authorities decide separately. |
| CONST-06 — Completion and punch | Bulk punch import shows duplicates and owners; close each item on accepted evidence, preserve exceptions and partial completion. |
| TURN-01 — Boundary, plan, readiness | Generate boundary/readiness pack from asset and interface records; commissioning authority accepts scope and prerequisites. |
| TURN-02 — Test execution and retest | Attach results to test step and instrument/version; qualified witness/reviewer accepts result and retest link. |
| TURN-03 — Defect and conditional acceptance | Show defect severity, workaround, owner, and expiry/review date; authorized authority accepts conditional status with rationale. |
| TURN-04 — Dossier and operations capability | Assemble searchable dossier and training/capability evidence by reference; receiving operations identifies gaps before acceptance. |
| TURN-05 — Separate acceptance and service entry | Present construction, commissioning, and service-entry decisions separately; operations authority controls entry and its evidence. |
| OPS-01 — Asset baseline and recurring plan | Import asset keys with match preview and reuse turnover baseline; asset owner accepts identity and recurring plan. |
| OPS-02 — Inspection, maintenance, event/incident | Link field record, work order, and event without duplicate transcription; operational authority controls response and stale telemetry is labeled. |
| OPS-03 — Warranty, service and compliance renewals | Expiry queue links terms and evidence; contract/compliance owner confirms renewal or lapse, no automatic compliance claim. |
| OPS-04 — Condition and lifecycle renewal | Reuse condition history and expose confidence/as-of date; asset manager recommends and investment authority decides funding. |
| RET-01 — Assessment and approval | Prefill service, obligations, alternatives, and replacement links; designated authority approves retirement, not physical status alone. |
| RET-02 — Transition and shutdown/transfer | Assign sequenced tasks and receiving-party acknowledgement; operations authority alone directs shutdown/transfer under local plan. |
| RET-03 — Disposition, restoration, obligations and finance | Reconcile obligation checklist, receipts, restoration, and finance in one view; owners accept evidence or authority documents waiver. |
| RET-04 — Archive and final status | Generate final manifest and unresolved-item review; records custodian accepts archive before authorized owner closes status. |

- **Decision inbox:** group by requested authority and due date; show question, recommendation, evidence gaps, delegation, and one-click open to context. Approve, return, or defer records rationale and actor; defer requires next owner/date, not a forced comment ritual.
- **Portfolio actions:** multi-select only when records share an allowed action and validation context. Preview affected cases, skip invalid rows with reasons, and export an outcome log. Do not bulk approve, waive, submit, or close unless owner configuration explicitly grants that action and per-item evidence remains recorded.
- **Handoff:** provide a concise package link with accepted evidence, current version, decisions, open risks, and next actions. Acknowledgement can accept, return with reason, or reassign; until then ownership stays apparent.
- **Notifications:** link directly to the exact work item or decision; deduplicate reminders and let owners tune cadence/escalation. Report sent/failed state and source date. A notification is not evidence of receipt or approval.
- **Accessible state:** pair color with text and icon; use plain labels, keyboard-accessible tables, filter chips, and downloadable records. Preserve local draft when validation fails; explain the failed field inline.

## Acceptance measures and assumptions

Treat the following as pilot measures, not imposed service levels. Baseline each measure with staff on representative cases; compare median time and error rate before/after, stratified by case complexity and user role. Target: routine case open-to-next-action in at most 2 navigations; repeated approved facts are not retyped; handoff ownership and acknowledgement are visible on every sampled transfer; imports report all created/updated/skipped/failed rows; each decision and evidence item has actor, date, source, and version; stale/offline/conflicted data cannot display as accepted current evidence. Confirm with a sample of at least five cases per lifecycle area where available, recording exceptions rather than hiding them. Adjust thresholds after baseline; no throughput target overrides required review or decision rights.

Assumptions: staff have authenticated role-based access; owners supply their templates, authoritative sources, retention/access rules, decision delegations, and emergency channels; external systems may be unavailable and integrations optional; offline synchronization is eventual and must reconcile conflicts; source systems remain authoritative for external issuance and operational control. Configure only the fields, alerts, and gates needed by the owner. A local example is illustrative and does not establish a universal legal or safety rule.
