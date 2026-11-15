# Platform reference — what the enterprise tools actually ship

**Companion to** [`docs/COMPETITIVE-TEARDOWN.md`](./COMPETITIVE-TEARDOWN.md) and [`docs/FEATURE-BACKLOG.md`](./FEATURE-BACKLOG.md).
Status: research reference, 2026-11-14. No application code changed by this document.

This file exists because the first teardown named the platforms but did not give enough **actual product information**: which named screens exist, what data goes in, which standards are supported, how the product is deployed, what public records show about price and schedule, and what the vendor does *not* publish. Every claim is tagged:

| Tag | Meaning |
|---|---|
| **[DOC]** | Vendor technical documentation, datasheet, help centre, or API reference |
| **[PROC]** | Public procurement, council, or regulatory filing with figures/dates |
| **[MKT]** | Vendor marketing or customer story; capability claim, not independently verified |
| **[3P]** | Third-party/analyst/industry comparison |
| **[UNV]** | Could not verify; treat as an open question, not a fact |

A missing protocol in a public datasheet is **not proof the product lacks it**. It means the vendor has not published it, and a buyer must ask.

---

## 1. The landscape in one table

| Platform | Owner | Category | Deployment (documented) | Public price evidence | Core modules |
|---|---|---|---|---|---|
| **Spectrum Power ADMS + Gridscale X** | Siemens | ADMS/EMS + cloud grid apps | On-prem real-time core + cloud SaaS browser clients **[DOC]** | Quote-only; SaaS entitlement tiers by SDP count **[DOC]** | SCADA, GDIM, FLOC, FISR, VVC, DSSE, DSPF, OFR, STLS, SCC, TCM, CM, OM, D-OTS |
| **GridOS / Smallworld / AEMS / DERMS / SmartSignal** | GE Vernova | ADMS/EMS/GIS/APM | Hybrid cloud/on-prem/edge; Smallworld cloud-native roadmap **[DOC]** | Quote-only **[UNV]** | ADMS, AEMS, WAMS, DERMS, Connect, Smallworld GNM, Visual Intelligence, SmartSignal |
| **EcoStruxure ADMS / Grid Operation / ArcFM** | Schneider Electric | ADMS/GIS/OMS | On-prem, cloud, Azure PaaS **[DOC]** | Austin Energy: $9.907 M 5-yr, $17.5 M NTE 8-yr **[PROC]** | SCADA, OMS, switching, FLISR, VVO, DMS, EMS, DLR, contingency, ArcFM |
| **PI System / PI Vision / CONNECT** | AVEVA | Historian + visualization | On-prem, cloud, edge **[DOC]** | Quote-only; Flex credits / tag subscriptions **[DOC]** | PI Server, PI AF, PI Vision, PI Web API, PI Integrator, Edge Data Store |
| **SurvalentONE ADMS** | Survalent | SCADA/OMS/DMS | On-prem/cloud **[MKT]** | Burlington Electric $391 k licences + $447 k implementation **[PROC]** | SCADA, OMS, DMS, NTP, FLISR, Polaris, GeoBridge |
| **monarch / ADMS** | AspenTech (OSI) | EMS/ADMS | On-prem or AWS/Azure; Express bundle **[MKT]** | Denton: $3.8 M six-year NTE **[PROC]** | SCADA, CHRONUS, eMap, GMS, EMS, OMS, DPF, DSE, FLISR, OFR, OTS, DERMS |
| **HxGN NetWorks / InService** | Hexagon | GIS + OMS/ADMS | On-prem/cloud **[MKT]** | Quote-only **[UNV]** | NetWorks Core/Utilities/Web/Mobile, InService, EAM |
| **ArcGIS Utility Network** | Esri | Geospatial network model | Enterprise/cloud **[DOC]** | Quote-only **[DOC]** | Trace, subnetworks, network diagrams, branch versioning, validation |
| **OpenUtilities** | Bentley | Utility GIS/design | Desktop + ProjectWise/iTwin **[DOC]** | Map from $4,702/yr; Substation from $11,824/yr **[DOC]** | Designer, Map, Substation, Analysis (PSS SINCAL), LDE |
| **IQGeo** | IQGeo | Network/field management | SaaS/private cloud/on-prem (edition-dependent) **[DOC]** | Quote-only **[UNV]** | Platform, Anywhere, Network Manager, Workflow Manager, Inspection |
| **Trimble Unity** | Trimble | Field/work management | SaaS **[DOC]** | Denton: $184,590/yr list, $1.099 M 5-yr NTE **[PROC]** | Construct, Maintain, Permit, Field, Cityworks/AgileAssets |
| **Foundry / PSIP** | Palantir | Integration/analytics/workflow | Cloud **[DOC]** | Quote-only **[UNV]** | Foundry, Workshop, Slate, Contour, Maps; PG&E PSIP, SCE notifications |

---

## 2. ADMS / EMS / GIS profiles

### 2.1 Siemens — Spectrum Power ADMS + Gridscale X

**Named applications [DOC].** Spectrum Power ADMS is grouped into *Monitor & Operate*, *Analyze & Optimize* and *Track & Restore*: **SCADA, GDIM** (GIS Data Import Management), **FLOC** (fault location), **FISR** (fault isolation and service restoration), **VVC** (volt/var control), **DSSE** (distribution state estimation), **DSPF** (distribution power flow), **OFR** (optimal feeder reconfiguration), **STLS** (short-term load scheduler), **SCC** (short-circuit calculation), **TCM** (trouble call management), **CM** (crew management), **OM** (outage management including storm), Analytics, and **D-OTS** (operator training simulator). The operator UI is the **Spectrum Power HUD**, with 2D/3D geospatial and schematic views, substation/feeder auto-displays, and web clients.

**Data in/out [DOC].** In: SCADA telemetry; GIS as the network-definition source master; AMI/smart-meter data; customer calls/IVR; weather forecast; crew/WFM; MDM (EnergyIP / Gridscale X MDM). Out: switching procedures, crew dispatch proposals, outage predictions, reliability indices, CIM exchange with TSOs, analytics (feeder imbalance, sensor anomalies, SF6/ventilator condition). Gridscale X cloud modules require the customer to supply an end-to-end model and API-compliant streams.

**Standards [DOC].** CIM **IEC 61968** compatibility; Siemens Adapter Framework for SAP/GIS/AM/CRM/CIS/WFM/MDM/planning/IVR; **ICCP** and **DNP3** are supported product functions with dedicated courses. Gridscale X LV Management says it builds its model "in compliance with CIM standards" and integrates IoT/standard control protocols; Dynamic Line Rating imports CIM-based equipment/geo data and exposes a REST API. IEC 61970 (as distinct from 61968), IEC 61850, OPC UA, MultiSpeak, IEEE 2030.5 and OpenADR are **not documented** in the ADMS collateral retrieved **[UNV]**.

**Deployment and commercial reality [DOC].** Spectrum Power is the on-prem real-time core; Gridscale X is a separate cloud/SaaS layer with browser-only HTML5 front ends. Published SaaS entitlement tiers: **300,000 / 600,000 / 1,200,000 included SDPs**, plus +50,000 SDP packages. Flexibility Manager adds "Modeled Flexibility" (25 MW included), and its Tier 2/3 are marked **"Not Released."** No currency amounts → quote-only.

**Documented limitations [DOC].** Cloud services are desktop/notebook browser only; the customer owns model data quality, API streams, cross-border transfer, backup and archiving.

**What to steal.** Model versioning with a read API (Network Model Manager); a **coverage/confidence** view per area (LV Insights); a **switching proposal preview** and overload-resolution pathway (LV Management); **flexibility vs. capex** comparison (Flexibility Manager). Do not copy SCADA/control claims.

### 2.2 GE Vernova — GridOS, Smallworld, AEMS, DERMS, SmartSignal

**Product structure [DOC].** GridOS is a platform + application suite with a Zero Trust model, a **federated grid data fabric**, an application suite and a **hybrid cloud architecture**. Named applications: **GridOS ADMS** (DMS + OMS + built-in DERMS), **GridOS for Distribution** (bundle including visual intelligence), **GridOS AEMS** (EMS/WAMS/analytics), **GridOS DDLR**, **GridOS WAMS**, **GridOS Forecasting**, **GridOS Visual Intelligence**, **GridOS DERMS** (Program Manager, Gateway, Operations, Forecasting), **GridOS Connect** (integration/event broker), and **Smallworld GNM**.

**What the operator sees [MKT].** The Alabama Power story names an **ADMS Viewer with "fault location halos"**, OMS dispatch and FISR. SmartSignal produces **residuals** (actual vs. predicted normal), prioritized diagnostic alerts, apparent cause and **time-to-action**; it is APM, not ADMS.

**Data in/out [DOC/MKT].** In: SCADA/telemetry, AMI last-gasp/first-breath, GIS model, CRM, weather, markets. Out: switching/FLISR actions, outage predictions and ETRs, DER dispatch, load/DER forecasts, dynamic line ratings, WAMS analytics, CMI/SAIDI/SAIFI reporting. GridOS Connect links AMI, GIS, CRM and ADMS with Kubernetes and event rate limiting.

**Standards [DOC].** OpenADR and IEEE 2030.5 for DERMS; a Gateway "certified to IEEE 2030.5." "Open standards and documented APIs" on the data fabric. GE's public ADMS/AEMS pages do **not** publish a CIM 61970/61968, DNP3, IEC 61850, ICCP/TASE.2, OPC UA or MultiSpeak matrix **[UNV]** — the largest documentation gap in this set.

**Deployment and commercial reality [DOC/MKT].** Hybrid: on-prem, cloud or edge; microservices; Smallworld GNM in production on AWS/GCP/Azure, with GNM 5.1–5.2 as cloud-native Kubernetes and 5.3 adding VMDS Cloud/PostgreSQL. GridOS for Distribution launched **Feb 2026**. Alabama Power began ADMS in **2010**; GE claims **112 million customer-minutes of interruption avoided in 2025**. SmartSignal is offered on-prem or as a cloud subscription. Quote-only.

**Documented limitation [MKT].** GE's own deck calls legacy grid software "fork-lift upgrades — not fast enough"; Smallworld customers face staged GNM 5.1 → 5.3 → GridOS upgrades.

**What to steal.** N-1 contingency and restoration (AEMS); FLISR sequence and damage checklist (ADMS); **residual health + time-to-action** (SmartSignal); **visual risk → work order → crew** (Visual Intelligence); DER program status and forecasting. Do not copy WAMS/PMU or state-estimation claims.

### 2.3 Schneider Electric — EcoStruxure ADMS / Grid Operation / ArcFM

**Named screens [DOC/MKT].** **Grid Operation** presents a single pane of glass with **geographic, schematic, substation and auto-generated** network views, real-time topology with dynamic symbols, temporary elements, advanced tracing, summaries (carried-by, abnormal, event), trending and dashboards, plus a **Field Client** mobile app. Modules: **SCADA** (scalable FEP, smart alarm, built-in protocol analyser, templatized RTU commissioning), **OMS** (switching, crew, storm management, **ETR engine**, damage assessment, outage prediction from calls/AMI/SCADA), **Switching Management**, **Load Shedding**, **VVO (EVR)**, **FLISR / Automatic FLISR**, **DMS**, **EMS** (look-ahead, fault analysis, voltage stability), **Dynamic Line Rating**, **Contingency Analysis**, **Network Reconfiguration**, **Load Relief**, **AMI Integration**, **LV Network Model**, **GOAT** automated testing and **SEGO** substation SCADA. ArcFM: **Pro, Design, Mobile, Web, Enterprise**.

**Data in/out [DOC].** In: SCADA; **ArcFM/Esri Utility Network** GIS (GDB and UNM); AMI/MDM; customer calls/IVR; CRM; AVL; weather. Out: switching orders, crew dispatch, proactive notifications, reliability indices, CIM network export, **ArcFM Data Extractor to ADMS via CIM-XML**, native **OSIsoft PI** integration.

**Standards [DOC].** IEC 61850, DNP3, IEC 60870-5-101/104; **MultiSpeak** and **IEC/CIM** interfaces for AMI/MDM, AVL, CRM/IVR, notifications, GIS and SCADA; **CIM-XML** in/out; native PI. The offer brochure lists "standard communication protocols (**except IEC 61850 and MQTT**)" as baseline, with IEC 61850 and MQTT sold as **add-ons** — a concrete packaging limitation. IEEE 2030.5/OpenADR/OPC UA are not stated for Grid Operation/ADMS; DERMS is separate.

**Deployment and public price [DOC/PROC].** On-prem or cloud; standalone OMS, standalone SCADA, or SCADA+OMS; Azure PaaS managed cloud. City of Austin (Sept 2026) authorizes Austin Energy's ADMS upgrade/maintenance as sole source: **5-year initial term $9,907,000**, options **$1,306,600**, **$1,371,585**, **$4,914,815**, total **not-to-exceed $17,500,000 over 8 years**. Version cadence: ADMS **3.10** January 2024 (mainstream support to January 2034), **3.11** February 2026 (support to February 2036); **3.7 support ends July 2026**.

**Documented limitations [DOC].** IEC 61850/MQTT are add-ons; legacy ArcFM is marked **Discontinued** in favour of the XI series; **"ArcFM UN is not a separate data model"** — it is configuration/modeling guidance on Esri Utility Network, not a migration bridge.

**What to steal.** ETR engine, storm/crew board, damage assessment; **design package** (scope, BOM, cost, permits) from ArcFM Designer; CIM-XML model exchange; MultiSpeak as the co-op integration path. Do not copy the full ADMS tiering.

### 2.4 AVEVA — PI System / PI AF / PI Vision / CONNECT

**Named screens [DOC].** PI Vision web client: **Home Page**, **Display** with **Monitor/Operations** and **Design** modes, **Asset Pane** (AF elements/attributes and PI Points), **Events Pane**; symbols include trend, table, gauge, **time-series table**, symbol collections, contextual navigation, multi-state visual alarms, and **event comparison/Gantt** views. **PI System Explorer** for AF databases/templates/analyses/event frames; **PI DataLink** for Excel; **PI Web API**, **PI Vision API**, **PI Integrator**, **Edge Data Store**, **CONNECT**.

**Data in/out [DOC].** PI Interfaces: OPC DA/HDA, Modbus, DNP3, RDBMS, PI-to-PI, Perfmon, SNMP. PI Connectors: **OPC UA**, **IEC 61850**, **IEC 60870-5-104**, BACnet, MQTT Sparkplug, CygNet, HART-IP, EtherNet/IP, Wonderware, PCS 7. Adapters: OPC UA, **DNP3 with TLS**, Modbus TCP, BACnet, MQTT, RDBMS. Out: displays, PI Web API REST, OMF streams to CONNECT/Data Hub/Edge, Excel, display export. **No CIM, MultiSpeak, IEEE 2030.5 or OpenADR interface** is documented — PI is a historian/context layer, not an ADMS bus.

**Deployment and licensing [DOC].** On-prem PI Server plus cloud services and Edge Data Store; PI Vision is an IIS web app + SQL Server (Azure SQL/Amazon RDS supported from 2025). Commercial model: **AVEVA Flex credits** or perpetual; per-server subscriptions or an **Aggregate Tag** subscription; a Capacity (Non-Reporting) aggregate tier that forbids uncapped tag licences and cannot be downgraded mid-term.

**Documented limitations [DOC].** "Named User – publisher" can create/edit/save displays; "Named User – explorer" can view/interact but **cannot save**. Blob is not supported; AF attribute types Guid, Attribute, Element, File and Array are not supported; String/DateTime/Boolean/Enumeration are not supported by Calculated Data. PI Vision API imports/exports **display metadata only**, not symbol definitions. Calculations are resource-intensive and an admin can restrict them; trend interpolation may miss outliers at high density. Sizing is published only to **500 concurrent clients**.

**What to steal.** The **asset hierarchy** (AF-style context path on every number), trend/event/Gantt cards, named-user roles, and the "publisher vs. explorer" permission model. Do not copy PI as a grid model.

### 2.5 Survalent — SurvalentONE ADMS

**Modules [MKT].** Unified SCADA + OMS + DMS on one model/database; **SmartVU** map/UI; **Network Topology Processor** (energized/de-energized sections, next upline/downline device); **FLISR + Loss of Voltage** (automatic or semi-automatic, creates switch orders, checks adjacent feeder/DER capacity); **Polaris** field app (tablets/laptops, AVL, tags, tickets/jobs, damage reports, **offline capture**); **GeoBridge** browser GIS import/validation (Intergraph, NISC, Milsoft).

**Integrations [MKT].** MultiSpeak AMI/AVL, IEC 61850, DNP3/ICCP, DB transcription (Oracle/SQL Server/Sybase/Access), Excel add-in, ArcGIS Utility Network import via GIS Wizard/GeoBridge.

**Public price and schedule [PROC].** Burlington Electric (VT): Platform $127,190 + GIS $16,773 + DMS $144,950 + OMS $102,150 = **$391,063 licences**; implementation **$447,379**; annual M&S **$61,558**. Idaho Falls Power: **$697,725** + 10% contingency + 5-year maintenance **$215,140** = **$982,637**. Naperville: **$2,250,021 NTE**, six-year term. Ocala: 7-month schedule (GIS import + FLISR; customer GIS clean-up on the critical path). ICE Costa Rica: phased 6-month SCADA + 12-month OMS + 6-month DMS/DERMS.

**Limitations [PROC/MKT].** Capability is staged by data readiness; Phase 1 apps need no connectivity, but FLISR/DPF/DSE/contingency require a network model. Ocala deferred OMS/advanced ADMS "pending the Utility Network rollout in FY27."

**What to steal.** The explicit **data-readiness staging** and the **offline field app**; switch-order generation that checks adjacent capacity; honest implementation schedules.

### 2.6 AspenTech OSI — monarch / ADMS

**Modules [MKT].** monarch SCADA, **CHRONUS** historian, **eMap** distribution network model, GMS, EMS, OMS, Continua (gas), and the ADMS suite: **DNOM, DTP** (distribution topology processing), **DPF, short circuit, DSE, VVC/VVO, FLISR, OFR, switch-order management, OMS, operator training simulator, STLF, load shed, historian, DERMS**.

**Model/tracing [MKT].** Connectivity/topology handled by DNOM + DTP and mirrored in OMS; **eMap** is the distribution model in at least one live account (GRU). Model integration is commonly routed through **Cimphony Network Model Management** between GIS and ADMS, validating GIS against a CIM format; Esri Utility Network extraction via a partner.

**Deployment and price [MKT/PROC].** On-prem or cloud-hosted (AWS/Azure); **monarch/SCADA Express** is a factory-tested bundle (SCADA + historian + web UI on a redundant server pair) for small/mid utilities. Denton Municipal Electric awarded OSI ADMS **$3,800,000 six-year not-to-exceed**, replacing an OMS.

**Limitations [UNV].** No public technical/API documentation or limitation list; DOE/ANL guidance warns buyers to demand go-live references rather than accept vendor assurances.

**What to steal.** The **Express** packaging idea (a pre-integrated small-utility bundle) and the CIM validation layer between GIS and ADMS.

### 2.7 Hexagon — HxGN NetWorks / InService

**Naming and modules [MKT].** G/Technology was rebranded **HxGN NetWorks** in July 2022: **NetWorks Core, Utilities, Comms, Web, Mobile**, plus **HxGN InService** (OMS/ADMS: FLOC, power flow, state estimation, switching, tagging, CAD, mobile) and **HxGN EAM**.

**Tracing and versioning [MKT].** Connectivity is **logical, stored in a DB connectivity table**, not geometric, so traces do not wait for topology builds and can include proposed/design features. Vendor-cited timings: ~6 s simple trace, ~28 s complex trace with report (2016 blog, not independently verified). Temporal/historical network views ("the network six months or a year ago") and design vs. as-built states; versioning was a customer requirement at SnoPUD.

**Integrations and scale claims [MKT].** Bi-directional **CIM** data flow (Ghana ECG), InService imports topology/attributes from NetWorks and selected third-party GIS; SCADA/AMI/IVR, SAP, ETAP/Siemens analysis embedded in the map view; rules-driven design QA/QC. Tested with **35 M network features + 12 M landbase** in one Oracle DB; **44 M access points** at SnoPUD — vendor claims.

**Pricing/limitations [UNV].** No public NetWorks/InService price; formal docs behind a customer portal, so no public "known limitations" list. Performance depends on DB tuning/indexes/statistics.

**What to steal.** **Temporal network views** and design-vs-as-built as a first-class state; logical connectivity for instant traces. Do not repeat the unverified trace timings.

### 2.8 Esri — ArcGIS Utility Network

**Services/screens [DOC].** Utility Network service (trace, validate topology, update subnetworks), Network Diagram service, Version Management service, Validation service; in ArcGIS Pro the **Utility Network** ribbon, **Trace** tool, **Subnetwork** management and network diagrams. The dataset is a geodatabase controller dataset with domain networks, tiers and subnetwork definitions; subnetwork controllers create circuits/zones/trunk lines.

**Trace types [DOC].** Connected, Subnetwork, Subnetwork controllers, **Upstream/Downstream**, **Isolation**, Loops, Shortest path, Path, Circuit (telecom). Subnetwork-definition traces work only on traditional domain networks; network traces work on both traditional and telecom.

**Versioning [DOC].** Single-user deployment is **not versioned**; enterprise requires **branch versioning** before publishing; branch versions are editable only through feature services; branch versioning is required for archiving. Asset groups/types via `ASSETTYPE` subtypes; connectivity, containment and structural-attachment associations; connectivity/feature restriction rules; terminals.

**Licensing/limitations [DOC].** Requires ArcGIS Pro Standard/Advanced; access via Professional/Professional+ user types or the **Advanced Editing user type extension** (Enterprise 11.2+). File-GDB UN needs no user type but cannot be published. Trace results are **not guaranteed if dirty areas exist**; validate first. Direct SQL read/write is not supported. Strict UN v4–v7 ↔ Pro/Enterprise compatibility matrix. No public list price.

**What to steal.** The **trace taxonomy** (especially isolation and upstream/downstream), branch versioning and validation-before-trust. These map directly onto our graph and evidence model.

### 2.9 Bentley — OpenUtilities

**Modules [DOC].** **OpenUtilities Designer** (Workflow Manager, Design Editor, Job Processor), **OpenUtilities Map**, **OpenUtilities Substation**, **OpenUtilities Analysis** (Siemens PSS SINCAL), **LDE** (Life Data Exchange) for external GIS.

**Tracing [DOC].** **Network Trace** dialog (Electric > Utilities > Network Trace): flow and conduit traces, connected, upstream/downstream, shortest/multiple/redundant path, pre-defined or user stop criteria, **Network Trace API**, individual/composite/cumulative reports.

**Editing/work orders [DOC/MKT].** Short-transaction, two-tier multi-user editing on Oracle Spatial/SQL Server Spatial/PostGIS (no long-transaction versioning documented); ProjectWise/iTwin for document and change management. Configurable workflow engine; create/assign/approve work orders standalone or via two-way message connection to a work-management system; posts costs/schedules to SAP/Maximo.

**Data model/integration [DOC].** Pre-built Electric Industry Standard Data Model (extensible/replaceable); ArcGIS services, WFS, file GDB, FME; hydraulic modelling (WaterGEMS/SewerGEMS/EPANET); SPIDAcalc. **No CIM/IEC 61968 support found** in Bentley docs **[UNV]**.

**Price/limitations [DOC].** Map from **$4,702/yr** (12-month Virtuoso subscription); Substation from **$11,824/yr**; Designer "request pricing." Desktop/MicroStation application — no SCADA/OMS/ADMS. Smallworld LDE link requires **TICS, deprecated at Smallworld Core 4.3**, so only Smallworld 3.1–5.0 Classic/AF are supported.

**What to steal.** The **Network Trace API** and the design-to-work-order message pattern; the explicit data-model replaceability. Do not treat it as an ADMS.

### 2.10 IQGeo

**Modules [DOC].** Platform 7.5, **Anywhere 7.5** (offline tablet with SQLite + tile files), Network Manager Telecom 3.7 / Electric 2.9 / Gas 1.3, Workflow Manager 4.4, Comsof Fiber, Network Quoting 1.8, Capture 3.2, Inspection & Survey 6.1, Orchestration Manager, NetLux AI.

**Tracing/versioning [DOC].** Trace upstream, downstream or both; trace-to-distance using OTDR (fiber) and EWL (copper); networks configured via network definitions. **Design versioning** keeps designs separate from as-built with a design boundary and status (Designing → Construction ready → published); you can view all versions plus as-built in a "future view"; tracing works inside the design.

**Field/work orders [MKT].** Workflow Manager creates geospatial tasks/work orders linked to network location **and connectivity**, mobile-updatable, with configurable ticket mapping for Maximo/SAP; offline sync via update packages.

**Data/deployment [DOC].** Platform DB stores managed vs. replicated features; ETLs for **Esri (geometric network and Utility Network including connectivity), GE Smallworld, Synchronoss**; FME write-back; JS/Python/REST APIs. IQGeo-managed SaaS on AWS, private cloud or on-prem — **on-prem/private cloud only on Enterprise edition**; Insight and Professional are IQGeo-hosted only.

**Pricing/limitations [UNV/3P].** Quote-only, annual in advance; no public per-user price. Replicated (externally mastered) data is not authoritative in IQGeo; third-party analysis flags long-transaction versioning as less prominent, not vendor-confirmed. Not an OMS/ADMS/SCADA.

**What to steal.** **Design status** and "future view"; offline field sync; the managed-vs-replicated data distinction.

### 2.11 Trimble Unity

**Modules [DOC].** Unity Construct, Maintain, Permit, Field; powered by Cityworks, AgileAssets and Unity Work Management.

**Tracing/field [DOC].** A **Utility Network Layer** service resource enables tracing; per asset type you set terminal (downstream/upstream/isolation) and pick Downstream/Upstream/Isolation trace configs. **In Unity Field, UN tracing tools are not supported**; no asset-type definitions/filters, map image layers or MMPK; Cityworks mobile apps do not support UN; editing UN requires Mobile Worker + ArcGIS Advanced Editing extension.

**Price [PROC].** Denton TX: Unity Maintain Elite, 150 users, **$184,590/yr list, $156,901.50 net Year 1**, 5-year NTE **$1,099,000**. Seguin TX: Unity Suite seat $8,000 + Maintain Elite 120 users $140,640 → **$108,416.96 net Year 1**. Beaverton OR: **$120,230.40 Year 1 for 205 users**, implementation by Woolpert **$169,635**, 5-year total **$1,003,844**.

**What to steal.** Transparent per-user economics and the field-first inspection/permit workflow. Do not expect desktop-grade tracing in the field app.

---

## 3. Adjacent categories with concrete detail

### 3.1 Asset health / APM

| Product | Inputs | Outputs / math | What to steal |
|---|---|---|---|
| **IBM Maximo Health** | RUL, open work orders, open service requests, condition/SCADA/meter data, maintenance history | Health %; **`risk = ((100 − health)/100) × criticality`** (criticality 1–5); custom contributor formulas with best/worst normalization | The two-axis formula; work-order count as a health input |
| **GE SmartSignal** | Historian tags, digital-twin blueprints, failure-mode libraries | Residuals, prioritized alerts, apparent cause, time-to-action; sensor-health checks | Expected-vs-actual residual; "time to limit" |
| **C3 AI Reliability** | Historian, work orders, asset hierarchy, documents, P&IDs, parts | ML anomaly risk, failure-mode classification, time-to-failure with confidence, **evidence package**, auto work orders | Evidence package per alert |
| **Siemens Senseye** | Condition telemetry | RUL, predictive maintenance | RUL framing |
| **Augury** | Vibration/ultrasound | Fault-mode diagnostics | Fault-specific recommendation |
| **Uptake** | Industrial asset data | Health, work prioritization | "Fix this first" queue |
| **Bentley AssetWise** | Inspection, risk, reliability | Linear-asset inspection records | Inspection lifecycle |

### 3.2 Wildfire / PSPS / vegetation

| Product | Data in | Output / method | What to steal |
|---|---|---|---|
| **Technosylva FireSight/FireRisk** | WRF 2 km hourly forecasts, fuels, live/dead fuel moisture, asset GIS, outage history | Fire-spread simulations from ignitions every ≤100 m; **expected risk = POF × consequence**; **RAIL = POF × POI × consequence**; 0–1 composite; percentiles | Three-factor risk; percentile display; screening disclaimer |
| **Neara** | GIS, LiDAR, imagery, engineering specs, pole libraries, inspections, weather | 3D pole/span loading, sag/sway, blow-in/fall-in/grow-in, clearance violations, ignition risk, SAIDI/SAIFI, **risk removed per $** | Risk-removed-per-dollar ranking |
| **AiDash CRIS/IVMS** | ~20 years weather, outage history, asset data, 4×/day weather, satellite vegetation | Daily risk maps, 72 h–7 day fire-weather/outage forecasts, customer notifications, **surgical PSPS**, criticality score | Forecast horizon; surgical de-energization |
| **LiveEO Treeline** | Stereo satellite, LiDAR, patrol data, elevation, GIS/WFM | Grow-in/fall-in/overhang/hazard trees, species/health/height, span/feeder/system risk tiers, work orders | Span-level risk tier |
| **Overstory** | Sub-30 cm imagery, tri-stereo heights, tree segmentation, terrain, utility standards | 3D risk (horizontal + vertical proximity), hazard-tree score, outage/ignition likelihood, SAIDI forecast, work ranking | Proximity scoring; per-utility risk matrix |
| **Gridware Gridscope** | Pole sensors: vibration, acoustics, tilt, temperature, voltage/E-field, GPS | Fault type/location/severity, ignition-risk alerts, equipment health, **de-energized line monitoring** | "Dead line" state |
| **LineVision LineRate/LineHealth** | CFD wind, weather, tower anemometers, LiDAR/EMF sag/temperature | Real-time DLR, 240 h forecast, emergency ratings, conductor temperature, annealing/remaining strength, end of life | DLR vs. static; remaining life |
| **Pano AI** | 4K cameras, satellite, 911 feeds, GIS, weather | Human-verified incident alerts, triangulated GPS, live video, asset proximity; **no ignition probability or asset health index** | Verified incident feed; skip if no cameras |

**PSPS consequence math (public).** SDG&E publishes multipliers: critical facilities/infrastructure 20 safety / 10 financial / 30 reliability; medical baseline 5/1/1; other customers 1. Liberty publishes `PSPS Safety Multiplier = (30 × MBL + 30 × CFI + other customers) / customer count`, weighted customers = multiplier × total, `EF = 1.5e-9 EF/CMI × weighted customers`, reliability consequence = customer count × 18 h average duration. CPUC post-event reporting requires customers notified/de-energized/cancelled, **MBL and CFI de-energized**, counties/tribes/circuits, and census-tract post-season data.

### 3.3 Distribution planning, interconnection and flexibility

| Product | Data in | Screens/outputs | Public commercial detail | Limitations |
|---|---|---|---|---|
| **Kevala** | Circuit GIS/ratings, CYME/Synergi/PSLF models, AMI, parcel/county, Census, weather, queue | "Search the Grid" map, parcel siting, hosting-capacity maps, interconnection cost/upgrade estimates, locational carbon, DER portal, CSV/KML/GeoJSON; **PrISM** siting metrics | Cloud SaaS, quote-only; private API | Planning/analysis only; no SCADA write-back; model quality depends on utility data |
| **GridUnity** | Interconnection applications (generation + load), study inputs/results, payments, milestones, communications | Applicant portal + staff dashboard, completeness/compliance checks, cluster-study workflow, cost allocation, audit trail (FERC Order 2023) | AWS, NIST 800-171 + SOC 2; quote-only | Process/orchestration, does not solve power flow |
| **Pearl Street (SUGAR/Interconnect)** | Transmission planning models, queue data, cost inputs | Solved power flow, thermal violations, upgrades, mitigation validation, cost allocation per MISO guide, injection-capacity maps | Commercial SaaS; free baseline capacity maps to subscribers | Transmission/BES focus; steady-state only; benchmark acceptance gate |
| **Camus Energy** | SCADA, GIS/network model, switch state, AMI, CIS, DERMS, DER telemetry | Unified grid dashboard to meter, feeder loading, backfeed alerts, day-ahead/nowcast forecasts, operating envelopes, FlexConnect limits | Subscription + setup; EBCE $70 k year 1 ($50 k service + $20 k setup), $50 k/yr renewals, $170 k/3 yr | Not an ADMS; needs AMI+GIS; small/mid utility focus |
| **Survalent / OSI / Hexagon / Esri** | See profiles | Queue is usually an external workflow, not core ADMS | — | — |

### 3.4 Water-energy (our actual asset class)

| Product | Data in | Outputs / method | Price/access | Limitations |
|---|---|---|---|---|
| **Xylem Vue (GoAigua)** | SCADA/PLC, IoT, AMI/AMR, GIS, CMMS/CRM/ERP/BIM, LIMS, models; 120+ protocols incl. OPC-UA/DA, MQTT, wM-Bus, NB-IoT/LoRa | Smart Water Engine (master data, IoT core, GIS, data science) + Service Operation Center, synoptics, alarms, BI; leak detection, plant optimization, work orders. Trier: ANN 24 h demand forecast at 15 min, reschedules pumps/tank filling against local generation | Cloud/customer cloud; quote-only | Water domain; energy = pumping/tariff optimization, not electric M&V; heavy integration |
| **Autodesk InfoWorks WS Pro / InfoWater Pro** | GIS/CAD/DB, **EPANET .inp**, meter/land-use demand, telemetry | Hydraulics/quality, fire flow, flushing, shutdown, surge, criticality, leakage, scenarios, cloud runs + Info360 dashboards | **$10,000/yr per user** ($834/mo annual) or $1,250 monthly; Flex tokens | Engineering desktop, not operations; real-time needs IW Live/Info360; no M&V/tariff engine |
| **Bentley WaterGEMS** | GIS/CAD/shapefiles/SDE, DEM/TIN, meters, **SCADAConnect via OPC** | Hydraulics/quality/fire flow, thematic maps, **pump energy and cost per scenario**, Energy Management aggregation, Darwin Scheduler/Calibrator/Designer | Desktop/subscription; no public price | Per-seat desktop; GA runtime grows with network; uncalibrated models; no M&V layer |
| **EPA EPANET 2.2** | `.inp` sections (junctions, reservoirs, tanks, pipes, pumps, valves, patterns, curves, controls, rules, energy, times, quality, reactions, sources, options, report) | Extended-period hydraulics/quality, Hazen-Williams/Darcy-Weisbach/Chezy-Manning, DDA + PDA, tank overflow, rule controls, **pumping energy and cost** (price, pattern, efficiency curve, demand charge) | **Free, public domain, MIT-licensed**; toolkit/API | Does **not optimize** schedules; default DDA; no native GIS/SCADA/real-time layer |
| **EnergyCAP** | Utility bills for any commodity, interval data, meter/site hierarchy, emissions factors | Bill audits, budgets, calendarization, benchmarking, outlier detection, chargebacks, GL export, GHG Scope 1–3, M&V (IPMVP B/C) | GSA: base **$8,949.62/yr** (0–250 m), $12,108.31 (500 m), $24,216.62 (2,000 m) ≈ **$12/meter/yr** at scale; add-ons; Bill CAPture ≈ $3.13/transaction | Monthly bill-cycle unless interval bought; statistical M&V, not physics/grid-aware |

### 3.5 Benchmarking, incentives and M&V

- **ENERGY STAR Portfolio Manager** — free API but EPA approval + property sharing; 1–100 score for eligible property types; comparability caveat.
- **DSIRE** — public incentive search; API is paid.
- **OpenEEmeter / CalTRACK** — open-source normalized savings; the honest way to **verify** an upgrade rather than only predict it.
- **NREL SAM / PVWatts / ATB** — PV production, project finance, technology costs; free keys/downloads.
- **IPMVP** — the vocabulary for Option B (retrofit isolation) and Option C (whole-building) M&V; EnergyCAP supports both.

---

## 4. Standards: three layers, not one "protocol"

The usual integration failure is mixing an **information model**, a **message/API**, and a **wire protocol**. They solve different problems.

| Standard | Layer | Scope / granularity | Role in a grid analytics product |
|---|---|---|---|
| **IEC 61970 (CIM 301, CGMES 61970-600-1)** | Abstract UML **information model** | Transmission/system-wide equipment, topology, terminals, measurements; planning and operations models | Network model import/export (RDF/CGMES XML), node-breaker topology, power-flow case assembly |
| **IEC 61968 (CIM 61968-11, messages 61968-9)** | CIM **extensions + message profiles** | Distribution network, assets, work, GIS, customer, meter data | Distribution model + AMI/MDM and work/asset messages over an ESB |
| **MultiSpeak v5** | **XML schemas + WSDL web services** (~40 endpoints, 670+ messages) | Distribution utilities/co-ops: AMI, SCADA/DMS, OMS, GIS, engineering, DR, work | Pragmatic North-American integration bus; 800+ utilities in 21 countries |
| **IEEE 2030.5 (SEP2)** | **Application protocol**: REST/HTTP/TLS, XML | Single DER / "fleet as one DER": monitoring/control, pricing, DR, EV; CSIP is the California Rule 21 profile | Device/fleet DER control and telemetry |
| **OpenADR (2.0a/b, 3.0; IEC 62746-10-1)** | **Message exchange** VTN↔VEN | Program/aggregator level; no device model, no control-strategy assumption | Price/event/envelope signals to aggregators, buildings, charge-point operators |
| **DNP3 / IEEE 1815** | **SCADA telemetry protocol** | Individual points/tags, timestamps, events, controls | Real-time point ingestion from RTUs/feeder devices; 1815.2 adds a DER point profile |
| **IEC 61850** | **Substation automation**: data model + SCL + MMS/GOOSE/SV | Logical nodes/devices, protection and control; narrower but deeper than CIM | High-fidelity substation/IED data, protection and control; model can map to CIM |
| **OPC UA (IEC 62541)** | **Industrial information exchange**: sessions, type system, services, pub/sub | Vendor-neutral semantic plumbing; not grid-specific | Historian/SCADA/PLC bridge |

**Practical implications.**

1. **Never pick one "protocol."** Use CIM/CGMES for the network model, 61968-11 + MultiSpeak for distribution/enterprise objects, DNP3/OPC UA/61850 for telemetry, 2030.5 + OpenADR at the DER edge.
2. **MultiSpeak vs. 61968 is a market question.** Co-ops and municipals overwhelmingly speak MultiSpeak; IEC publishes a 61968 harmonization mapping precisely because of the split.
3. **2030.5 vs. OpenADR.** 2030.5 is device/DER-level, certificate-chained, CSIP-certified; OpenADR is program/aggregator-level with no device model. An operating-envelope product needs both: OpenADR for commercial relationships, 2030.5/CSIP for the inverter.
4. **CIM is a model, not a wire format.** It needs a communications protocol; Camus's MISO deck says this explicitly.
5. **MVP effort ranking:** DNP3/OPC UA (weeks) < 2030.5/CSIP (weeks–months, certification) < MultiSpeak (months, per endpoint) < CIM/61968 full profiles (quarters, mapping) < IEC 61850 (SCL tooling).

### 4.1 Vendor-attested standards matrix

| | CIM 61968/61970 | MultiSpeak | 2030.5 / OpenADR | DNP3 | IEC 61850 | OPC UA | GIS / PI |
|---|---|---|---|---|---|---|---|
| **Siemens** Spectrum Power | 61968 ✅ (61970 not stated) | — | — | ✅ | — | — | GIS as model source; CIM exchange with TSOs |
| **GE** GridOS/DERMS | — | — | ✅ DERMS OpenADR + 2030.5-certified Gateway | — | — | — | Smallworld ↔ ADMS; Connect AMI/GIS/CRM |
| **Schneider** Grid Operation/ADMS | ✅ CIM + CIM-XML in/out | ✅ | — (DERMS separate) | ✅ | ✅ add-on | — | Native ArcFM; native PI |
| **AVEVA** PI/PI Vision | — | — | — | ✅ | ✅ | ✅ | PI AF is the asset model |
| **Survalent** | — (UN import) | ✅ | — | ✅ | ✅ | — | ArcGIS UN via GeoBridge |
| **OSI** monarch | ✅ via Cimphony | — | — | — | — | — | Esri UN via partner |
| **Hexagon** NetWorks/InService | ✅ (Ghana ECG) | — | — | — | — | — | Bi-directional CIM; third-party GIS |
| **Esri** Utility Network | — (UN model) | — | — | — | — | — | Native GIS; branch versioning |

Legend: ✅ documented; — not found in the cited public material. A dash is not proof of absence.

---

## 5. Capability matrix (documented, not aspirational)

`●` documented core, `◐` partial/add-on/adjacent, `○` not found in cited material.

| Capability | Siemens | GE | Schneider | AVEVA | Survalent | OSI | Hexagon | Esri | Bentley | IQGeo | Trimble |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Network model / GIS | ● | ● | ● | ○ | ● | ● | ● | ● | ● | ● | ◐ |
| Tracing / connectivity | ● | ● | ● | ○ | ● | ● | ● | ● | ● | ● | ◐ |
| SCADA | ● | ● | ● | ◐ | ● | ● | ◐ | ○ | ○ | ○ | ○ |
| OMS / outage | ● | ● | ● | ○ | ● | ● | ● | ○ | ○ | ○ | ◐ |
| FLISR | ● | ● | ● | ○ | ● | ● | ◐ | ○ | ○ | ○ | ○ |
| Power flow / state estimation | ● | ● | ● | ○ | ● | ● | ◐ | ○ | ● | ○ | ○ |
| DERMS / 2030.5 | ◐ | ● | ● | ○ | ◐ | ◐ | ○ | ○ | ○ | ○ | ○ |
| Hosting capacity | ◐ | ◐ | ● | ○ | ○ | ○ | ○ | ○ | ◐ | ○ | ○ |
| Work orders / field | ◐ | ● | ● | ○ | ● | ◐ | ● | ◐ | ● | ● | ● |
| PSPS / wildfire workflow | ○ | ○ | ◐ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| CIM 61968 | ● | ◐ | ● | ○ | ◐ | ● | ● | ◐ | ○ | ◐ | ◐ |
| MultiSpeak | ○ | ○ | ● | ○ | ● | ◐ | ◐ | ○ | ○ | ○ | ○ |

**Palantir Foundry** is not in the ADMS matrix on purpose: it is the integration/analytics/workflow layer. Documented strengths are PSPS scope, situation report, EDGIS trace, notification campaigns, risk cubes, transformer investigation and work planning — with no SCADA/FLISR/DER dispatch.

**Caveat:** the matrix is built from the public material cited in §9. A `○` means "not found", not "does not exist"; a `●` means "documented", not "best in class."

---

## 6. What public documentation does not disclose

| Gap | Platforms | Consequence for a buyer or a competitor |
|---|---|---|
| List prices | Siemens Spectrum/Gridscale X, GE GridOS/SmartSignal, AVEVA PI, Esri UN, OSI monarch, Hexagon, IQGeo | Only procurement records (Schneider, Survalent, OSI, Trimble, EnergyCAP, Autodesk) give real numbers |
| Risk-score weights | Neara, AiDash, LiveEO, Overstory, Gridware, C3, SmartSignal | Only Maximo, FEMA NRI and Technosylva publish reproducible math |
| Full protocol matrix | GE ADMS/AEMS, Siemens 61970/61850/OPC UA | Integration risk sits with the buyer; demand a protocol matrix in the RFP |
| Implementation duration | Most vendors | Survalent's public records are the exception (7–24 months); others quote-only |
| Customer/MBL counts | PSPS vendors | Utilities treat them as confidential; census-tract workbooks are the closest public proxy |
| Model-versioning detail | Survalent, OSI, Bentley | Ask for branch/version semantics, not "GIS sync" |
| Field-app parity | Trimble, Esri | Desktop tracing often does not exist in the mobile app |
| Hosting-capacity method | Kevala, GridUnity, Pearl Street | Capability is documented; the exact algorithm is not |

**How to use this in a pitch:** saying "the enterprise tools do not publish their weights either" is not a defense. The right move is to publish **ours**, show the decomposition, and label the assumptions. That is a genuine differentiator, not a parity claim.

---

## 7. What this means for Mapergy

### 7.1 Positioning

We are a **system of insight**, not a system of record or control. The defensible sentence:

> "Mapergy is the first-day screening layer over public grid, census and asset data: what is here, who is exposed, what breaks first, and what to fund — with every number traceable to a source or a named model."

### 7.2 Integration roadmap (honest)

| Priority | Integration | Why | Effort | What we can claim |
|---|---|---|---|---|
| 1 | **CIM/CGMES subset import** (equipment, terminals, connectivity) | The only vendor-neutral network-model path; matches Esri/Siemens/Schneider language | M | "Reads a CIM subset; not a certified CIM adapter" |
| 2 | **MultiSpeak** for co-op/municipal data (AMI, OMS, GIS) | The practical North-American bus for small utilities | M | "MultiSpeak-shaped adapter" |
| 3 | **IEEE 2030.5 / OpenADR** for DER signals | Needed for any flexibility/queue story | M–L | "Signal preview, not certified CSIP" |
| 4 | **DNP3 / OPC UA** telemetry | The only path to live data; historian bridge | M | "Read-only telemetry demo" |
| 5 | **PI AF-style hierarchy** | Makes every number contextual | S | "Asset hierarchy" |
| 6 | **ACS/CEJST/FHSZ snapshots** | Consequence and equity, not just MW | S–M | "Modeled service area; public data" |

### 7.3 What to mock vs. build

| Mock (clearly labeled) | Build (real) |
|---|---|
| SCADA live points | Graph traversal, N-1, hosting capacity |
| Customer billing/MBL records | Census block-group allocation |
| Utility switching orders | Switching **proposal preview** with overload check |
| Cluster study approval | Hosting-capacity screening + queue snapshot |
| Crew dispatch | Case/work-order state machine |
| Market bids/settlements | Price exposure and demand-charge estimate |
| LiDAR/vegetation ML | FHSZ + OSM corridor proximity |

### 7.4 The one-sentence answer to each platform

- **Siemens/GE/Schneider:** "You are the system of record and control; we are the screening layer that tells a city which of your assets matter first."
- **AVEVA PI:** "You contextualize telemetry; we contextualize public risk when there is no telemetry."
- **Palantir:** "You integrate 50 systems for a utility; we integrate the public 10 for a city that has no Foundry."
- **Esri:** "You own the authoritative geometry; we consume a lightweight trace and add consequence."
- **Kevala/GridUnity/Pearl Street:** "You do the study; we do the first-day screen and the public-facing story."

---

## 8. Feature dictionary

| Term | Meaning |
|---|---|
| **ADMS** | Advanced Distribution Management System: SCADA + DMS + OMS (+ DERMS) on a common model |
| **DMS** | Distribution Management System: monitoring, switching, power flow, optimization |
| **OMS** | Outage Management System: trouble calls, outage prediction, crews, restoration |
| **EMS / AEMS** | (Advanced) Energy Management System: transmission/generation monitoring, state estimation, contingency |
| **WAMS / PMU** | Wide-Area Monitoring System / phasor measurement unit; high-rate synchrophasor data |
| **SCADA** | Supervisory control and data acquisition; telemetry + control |
| **FLISR / FISR** | Fault location, isolation and service restoration |
| **VVO / VVC** | Volt/VAR optimization/control |
| **DERMS** | Distributed Energy Resource Management System |
| **DSO** | Distribution System Operator; the entity coordinating DER on the distribution grid |
| **Hosting capacity** | Maximum DER injection a feeder/bus can accept without violating limits |
| **Interconnection queue** | The backlog of generation/load requests awaiting study and approval |
| **CIM / CGMES** | Common Information Model / Common Grid Model Exchange Specification (IEC 61970/61968) |
| **MultiSpeak** | XML/WSDL integration standard for North American distribution utilities |
| **IEEE 2030.5 / CSIP** | DER application protocol / California Rule 21 certification profile |
| **OpenADR** | Demand-response/pricing signal exchange between VTN and VEN |
| **DNP3** | SCADA telemetry protocol (IEEE 1815) |
| **IEC 61850** | Substation automation data model + SCL + MMS/GOOSE/SV |
| **OPC UA** | Industrial information-exchange framework (IEC 62541) |
| **PI AF** | AVEVA PI Asset Framework: asset/template hierarchy over time-series data |
| **State estimation** | Reconstruct the most likely network state from redundant measurements |
| **N-1 contingency** | Screen the loss of any single element; N-1-1 adds a second |
| **Short circuit / SCR** | Fault current / short-circuit ratio; grid strength |
| **DLR** | Dynamic line rating: real-time thermal rating from weather/conductor conditions |
| **Annealing** | Permanent loss of conductor strength from sustained high temperature |
| **UFLS** | Under-frequency load shedding |
| **ROCOF** | Rate of change of frequency |
| **SAIDI / SAIFI / CAIDI / MAIFI / CEMI** | Reliability indices: duration, frequency, average duration, momentary interruptions, event magnitude |
| **ETR** | Estimated time of restoration |
| **PSPS** | Public Safety Power Shutoff |
| **WUI** | Wildland–urban interface |
| **FHSZ** | Fire Hazard Severity Zone (CAL FIRE); hazard, not risk |
| **POF / POI** | Probability of failure / probability of ignition given failure |
| **RAIL** | Risk of ignition × likelihood, a Technosylva composite |
| **EAL** | Expected annual loss (FEMA NRI) |
| **VOLL** | Value of lost load |
| **LCOE / NPV / IRR / CRF** | Levelized cost of energy / net present value / internal rate of return / capital recovery factor |
| **M&V / IPMVP** | Measurement and verification / International Performance Measurement and Verification Protocol |
| **DAC** | Disadvantaged community (CEJST / CalEnviroScreen / SB 535) |
| **MBL / CFI** | Medical baseline / critical facilities and infrastructure (CPUC PSPS reporting) |
| **EAM** | Enterprise asset management |
| **GIS / UN** | Geographic information system / Esri Utility Network |
| **SDP** | Siemens "service delivery point" entitlement unit for Gridscale X |

---

## 9. Sources

**Siemens**

- Spectrum Power ADMS module catalogue — https://assets.new.siemens.com/siemens/assets/api/uuid:6be45822-9bad-4f93-ac98-d4fbee5d622f/interactive-pdf-for-ADMS-modules.pdf
- Spectrum Power ADMS brochure — https://assets.new.siemens.com/siemens/assets/api/uuid:0148130a-e4da-42ac-8d33-106e7c8b6f81/spectrum-power-messaging-webpage-simsmi2203-adms-brochure.pdf
- Gridscale X Cloud Services documentation — https://assets.ctfassets.net/17si5cpawjzf/48a9K31FBBItCfBQNkemfV/da8a9fedab262efa9e88156489c72c23/Documentation-Gridscale-X-Cloud-Services.pdf
- Gridscale X LV Management documentation — https://assets.new.siemens.com/siemens/assets/api/uuid:69ff33dc-1491-4b33-80f0-26b3563607b1/Specific-Documentation-for-Gridscale-X-LV-Management-V-2025-08_original.pdf
- Gridscale X Flexibility Manager documentation — https://assets.new.siemens.com/siemens/assets/api/uuid:4b28fe39-2e95-4126-99ab-6ffec1511274/Documentation-Flexibility-Manager_original.pdf
- Gridscale X Dynamic Line Rating sheet — https://assets.new.siemens.com/siemens/assets/api/uuid:b2d1449f-35ae-4d69-b5ef-c90842e27ac9/Gridscale-X-Dynamic-Line-Rating-Product-Sheet_original.pdf
- Spectrum Power 7 course catalogue (ICCP/DNP3) — https://assets.new.siemens.com/siemens/assets/api/uuid:0932aa14-880e-4a1f-88ca-1a20c8b53353/spectrumpower-7-course-catalogue-en.pdf
- Elvia / Gridscale X LV Insights — https://www.siemens.com/en-us/content/elvia-future-proofing-distribution-grid-management

**GE Vernova**

- GridOS platform — https://www.gevernova.com/software/products/gridos
- GridOS for Distribution — https://www.gevernova.com/software/products/gridos-for-distribution
- GridOS ADMS — https://www.gevernova.com/software/products/gridos/advanced-distribution-management-system
- GridOS AEMS — https://www.gevernova.com/software/products/gridos/advanced-energy-management-system
- GridOS DERMS — https://www.gevernova.com/software/products/gridos/distributed-energy-resources-management-system
- Smallworld GNM — https://www.gevernova.com/software/products/geospatial-network-management-smallworld-gis
- SmartSignal brochure — https://www.gevernova.com/software/sites/default/files/2024-10/brochure-ai-powered-predictive-analytics-smartsignal.pdf
- GridOS Visual Intelligence paper — https://www.gevernova.com/software/sites/default/files/2026-07/gridos_vi-solution-paper.pdf
- Alabama Power / GridOS ADMS — https://www.gevernova.com/software/customer-stories/alabama-power-leverages-oms-recover-power-grid-disruption
- GridOS for Distribution launch — https://www.gevernova.com/news/press-releases/ge-vernova-launches-gridos-distribution-industrys

**Schneider Electric**

- EcoStruxure ADMS applications — https://www.se.com/us/en/work/solutions/for-business/electric-utilities/advanced-distribution-management-system-adms
- EcoStruxure Grid Operation — https://www.se.com/us/en/product-range/152949461-ecostruxure-grid-operation/
- Grid Operation / ADMS offer brochure — https://download.se.com/files?p_Doc_Ref=998-19574741_GMA-GB&p_enDocType=Brochure
- GridOps brochure — https://catalogartifact.azureedge.net/publicartifacts/869296.ecostruxure_grid_ops-f7da02db-bc8e-4dbf-b528-670703a08a07/Artifacts/Documents/Gridopsbrochure.pdf
- EcoStruxure DERMS — https://www.se.com/us/en/product-range/89571422-ecostruxure-derms
- ArcFM XI — https://www.se.com/us/en/work/solutions/for-business/electric-utilities/geographic-information-systems-gis-arcfm
- ADMS end-of-life schedule — https://smartgrid.schneider-electric.com/s/adms-eol-schedule
- Austin Energy ADMS contract — https://services.austintexas.gov/edims/document.cfm?id=480561
- Azure PaaS announcement — https://www.se.com/us/en/about-us/newsroom/news/press-releases/schneider-electric-announces-grid-operations-platform-as-a-service-on-microsoft-azure-62868a26ab776d5e64349792

**AVEVA**

- PI Vision documentation — https://docs.aveva.com/bundle/pi-vision/page/1025963.html
- PI Vision datasheet — https://www.aveva.com/content/dam/aveva/documents/perspectives/datasheets/Datasheet_PIVision.pdf
- PI connectors index — https://docs.aveva.com/bundle/overview-of-pi-connectors/page/1010254.html
- PI Data Infrastructure service description — https://www.aveva.com/content/dam/aveva/documents/legal/service-documents/AVEVA-PI-Data-Infrastructure.pdf
- PI System software schedule — https://www.aveva.com/content/dam/aveva/documents/legal/policies/AVEVA-Software-Schedule-PI-System-v1-5-June-2026.pdf
- PI Vision API reference — https://docs.aveva.com/bundle/pi-vision-api-reference/page/overview.html

**Survalent / OSI / Hexagon / Esri / Bentley / IQGeo / Trimble**

- SurvalentONE ADMS — https://www.survalent.com/products/survalentone-adms
- Survalent Network Topology Processor — https://www.survalent.com/network-topology-processor
- Survalent FLISR — https://www.survalent.com/flisr-loss-of-voltage
- Survalent Polaris — https://www.survalent.com/products/outage-management-system-oms/polaris
- Survalent interfaces — https://www.survalent.com/products/interfaces-and-protocols
- Burlington Electric Survalent packet — https://www.burlingtonelectric.com/wp-content/uploads/12.13.2023-BEC-Packet_R-1.pdf
- Idaho Falls Survalent agenda — https://swagit-attachments.granicus.com/uploads/video/agenda_file/272833/9-28_IdahoFallsCC.pdf
- OSI ADMS brochure — https://www.aspentech.com/-/media/aspentech/home/resources/brochure/pdfs/fy22/q4/at-07837_adms_brochure.pdf
- OSI Cimphony/Ameren case — https://home.aspentech.com/-/media/aspentech/home/resources/case-study/pdfs/fy26/q2/at-4621_dgm_ameren_case-study_v9.pdf
- Denton OSI award — https://denton-tx.legistar.com/gateway.aspx?ID=08136626-f91b-4c5e-92cf-98443eb98fff.pdf&M=F
- Hexagon NetWorks rebrand — https://hexagon.com/company/newsroom/press-releases/2022/hexagon-announces-hxgn-networks-rebrands-utilities-and-communications-offerings
- Hexagon InService sheet — https://bynder.hexagon.com/m/7a1cb3338143352c/original/Hexagon_SIG_HxGN_InService_product_sheet_EN_A4.pdf
- Esri Utility Network trace types — https://doc.esri.com/en/arcgis-pro/latest/help/data/utility-network/utility-network-trace-types.html
- Esri Utility Network FAQ — https://doc.esri.com/en/arcgis-pro/latest/help/data/utility-network/faq.html
- Bentley OpenUtilities Designer readme — https://docs.bentley.com/LiveContent/web/OpenUtilities%20Designer-v2025/ReadMe/en/topics/OpenUtilitiesDesigner-readme/readme.html
- Bentley Network Trace — https://docs.bentley.com/LiveContent/web/OpenUtilities%20Designer-v2024/Help/en/topics/168610/GUID-A24BD8B0-DEF1-4A86-B78F-C2A15C1E8F71.html
- IQGeo documentation — https://docs.iqgeo.com/
- IQGeo design versioning — https://video.iqgeo.com/demo-design-versioning
- Trimble Unity — https://assetlifecycle.trimble.com/en/products/software/unity
- Trimble Unity Field UN limitations — https://help.unity.trimble.com/Field/PDF/TrimbleUnityFieldForMaintain.pdf
- Denton Trimble contract — https://denton-tx.legistar.com/View.ashx?G=A1619B3C-1B45-4681-B45C-0B3DA512F5D1&GUID=85EF3DD5-F300-4077-BF04-2F1D9DD97350&ID=16049431&M=F

**Palantir / PSPS / risk math**

- PG&E PSPS annex (PSIP, 50+ sources) — https://www.pge.com/assets/pge/docs/outages-and-safety/outage-preparedness-and-support/emer-3106m-psps-annex-to-cerp-v9.pdf
- Palantir PSPS scoping — https://palantir.com/docs/foundry/use-case-examples/public-safety-power-shutoff-psps-scoping
- Palantir transformer failure — https://palantir.com/docs/foundry/use-case-examples/preventing-transformer-failure-via-alerting-and-investigation-support
- SCE Palantir/EONS filing — https://efiling.energysafety.ca.gov/eFiling/Getfile.aspx?fileid=54290&shareable=true
- IBM Maximo default scores — https://www.ibm.com/docs/en/mhmpmh-and-p-u/cd?topic=using-default-scores
- Technosylva composite metrics — https://helpcenter.technosylva.com/wfa-firesight/using-composite-risk-metrics
- PacifiCorp wildfire risk filing — https://efiling.energysafety.ca.gov/eFiling/Getfile.aspx?docket=2023-2025-WMP-DRs&fileid=57829&shareable=true
- SDG&E PSPS consequence multipliers — https://www.sdge.com/sites/default/files/regulatory/JW%20-%20Appendix%20C%20-%20SDGE%202020-2022%20WMP%20Update%20(2022).pdf
- Liberty PSPS safety multiplier — https://california.libertyutilities.com/uploads/Liberty_2026-2028%20Base-WMP_R1.pdf
- FEMA NRI technical documentation — https://www.fema.gov/sites/default/files/documents/fema_national-risk-index_technical-documentation_0.pdf
- CAL FIRE FHSZ — https://osfm.fire.ca.gov/what-we-do/community-wildfire-preparedness-and-mitigation/fire-hazard-severity-zones
- CEJST technical documentation — https://dblew8dgr6ajz.cloudfront.net/data-versions/2.0/data/score/downloadable/cejst-technical-support-document.pdf

**Planning / interconnection / water / M&V / standards**

- Kevala platform — https://www.kevala.com/platform
- Kevala PrISM — https://www.kevala.com/solutions/predictive-interconnection-siting-metrics
- GridUnity ILCM — https://gridunity.com/ilcm-for-utilities
- FERC interconnection workshop (CAISO GRIP) — https://www.ferc.gov/libraries/pdf.js/web/viewer.html?file=https%3A%2F%2Fwww.ferc.gov%2Fsites%2Fdefault%2Ffiles%2F2025-07%2FFERC%2520Workshop%25202025_07_08_%2520Brian%2527s%2520Presentation%2520-%2520FINAL%2520.pdf
- Pearl Street / MISO benchmark — https://cdn.misoenergy.org/MISO%20Benchmarking%20of%20Pearl%20Street%20SUGAR697461.pdf
- Camus ODMS — https://www.camus.energy/odms
- Camus EBCE agreement — https://avaenergy.org/wp-content/uploads/2022/03/Consent_Item_7_-_Camus_Agreement_mkwbeb.pdf
- Xylem Vue platform — https://www.xylem.com/en-us/brand/xylem-vue/platform
- Xylem Vue / Trier case — https://www.xylem.com/en-029/resources/case-studies/stadtwerke-trier-ai-aided-energy-optimization-for-daily-energy-balancing
- Autodesk InfoWater Pro buy page — https://www.autodesk.com/products/infowater-pro/buy
- Bentley WaterGEMS datasheet — https://www.bentley.com/wp-content/uploads/pds-openflows-watergems-ltr-en-lr.pdf
- Bentley SCADAConnect — https://docs.bentley.com/LiveContent/web/Bentley%20WaterGEMS%20Help%20SS6-v1/en/80019.html
- EPA EPANET — https://www.epa.gov/water-research/epanet
- EPANET 2.2 manual — https://usepa.github.io/EPANET2.2/
- EnergyCAP GSA catalogue — https://www.gsaadvantage.gov/ref_text/GS35F231CA/0ZFLD6.3V5Y7U_GS-35F-231CA_ENERGYCAPLLCGS35F231CAGSACATALOG.PDF
- EnergyCAP M&V — https://www.energycap.com/resource/measurement-and-verification
- IEC 61970-301 — https://webstore.iec.ch/en/publication/62698
- IEC 61968-11 — https://webstore.iec.ch/en/publication/6199
- MultiSpeak specification — https://www.multispeak.org/multispeak-specification
- IEEE 2030.5 — https://standards.ieee.org/ieee/2030.5/11216
- OpenADR FAQ — https://www.openadr.org/faq
- DNP3 overview — https://www.dnp.org/About/Overview-of-DNP3-Protocol
- NEMA IEC 61850 vs. DNP3 — https://www.nema.org/docs/default-source/distribution-automation-toolkit-library/expanding-the-adoption-of-iec-61850.pdf
- OPC UA open62541 introduction — https://open62541.org/doc/v1.5.2
- DOE/ORNL standards landscape — https://info.ornl.gov/sites/publications/Files/Pub210821.pdf
- DOE/ANL ADMS procurement guidance — https://publications.anl.gov/anlpubs/2017/04/134871.pdf
