# HIZED PRODUCT BLUEPRINT

*Confidential — Product and implementation specification*

## Hized — Product Blueprint

Consultancy-led data integration, performance management and self-serve analytics platform

### Purpose

This specification is designed to be handed to an AI software builder, technical co-founder, development agency or internal engineering team. It defines what Hized is, how its products fit together, what should be built first, and how success will be judged.

### Document summary

| | |
|---|---|
| Company | Hized |
| Primary product | Hized Pulse |
| Data integration product | Hized Connect |
| Self-serve dashboard product | Hized Canvas |
| Go-to-market | Consultancy-led implementation with recurring platform fees |
| Document status | Build-ready product definition — Version 2.4 |

### Changes since v1.0

- **Hized Field removed.** Travel/route-optimisation was speculative and not represented anywhere in the go-to-market material; it added scope without a validated buyer.
- **Hized Canvas added.** The self-serve, build-your-own-dashboard layer on top of Pulse's governed data — already live in the marketing site's four-pillar story (Connect · Pulse · Canvas · Compass) — is now a first-class product in this spec.
- **Reference architecture updated (section 9.1).** The platform will be built on Next.js with a tenant-isolated Postgres database (Row-Level Security keyed on TenantId), rather than the ASP.NET Core / Azure SQL / Microsoft Entra ID stack originally proposed, to move faster pre-pilot.

### Changes since v1.1

- **Section 7, Hized Platform Administration, added.** Previously the Platform Super Admin persona was named once (section 3.2, "manage tenants, platform configuration, support access and system health") with no functional-scope section of its own — unlike Pulse, Connect and Canvas, which each get one. It now does.
- **Reference architecture (section 9.1) corrected to Neon + Better Auth + Cloudflare R2.** V1.1 specified Supabase (Postgres + Auth + Storage bundled). The build moved to Neon (Postgres) once in progress — free tier, database branching included free — which has no bundled Auth or Storage, so those became independent choices: Better Auth (self-hosted on the same Postgres, no per-user vendor cost) and Cloudflare R2 (zero egress fees). Tenant isolation is still Postgres Row-Level Security keyed on TenantId; the session mechanism that feeds it changed from Supabase's `auth.uid()` to an application-set session variable, since Neon has no equivalent built in.

### Changes since v1.2

- **Security invariants made explicit.** Invitation acceptance requires possession of the high-entropy invitation token, not merely knowledge of the invited email address; an existing authenticated user can use a valid token to join an additional tenant.
- **Hierarchy temporal semantics clarified.** Effective-date ranges are half-open (`valid_from` inclusive, `valid_to` exclusive), organisation trees must remain acyclic, and Phase 0 interactive edits/deactivations take effect immediately. Initial imports may establish a past `valid_from`; scheduled or backdated reorganisations require a dedicated workflow before they are exposed.
- **Audit guarantees strengthened.** A privileged mutation and its audit event must commit atomically, and a cross-tenant platform-admin read must not return data unless its corresponding audit event can be written.
- **Database trust boundary clarified.** Tenant session context cannot exist without a verified user identity; privileged database functions use fixed search paths and explicit role grants rather than PostgreSQL's implicit `PUBLIC` execution.
- **Delivery safety clarified.** Database integration tests run only against an explicitly dedicated CI database branch, and production deployment follows required CI checks on a protected main branch.

### Changes since v1.3

- **Demo data delivery made progressive.** EPIC-01 seeds two isolated tenant shells and an installation/service organisation hierarchy without inventing schemas for later products. Connect, Pulse and Canvas extend that same synthetic story with jobs and pipeline health, KPIs and target/freshness states, and a promoted board as their owning epics land.
- **Environment separation made operationally explicit.** Development and CI database-mutating tests must use Neon branches separate from production; a production demo seed is an explicit release operation, not a test fixture.
- **Tenant context is membership-bound in RLS.** The server still resolves identity and membership before setting session context, but ordinary tenant reads also require that the session user has active access to the selected tenant, so a future server-side context-pairing defect fails closed at the database boundary.

### Changes since v1.4

- **Tenant entry and switching clarified.** After signup or login, an authenticated user is resolved to their active organisation memberships before entering a tenant. A single membership may open directly; multiple memberships require an organisation chooser. Canonical production navigation uses `*.hized.app`; development and preview deployments may use a path-based routing fallback, but both paths must pass the same membership check and RLS context gate.

### Changes since v1.5

- **SharePoint-hosted Excel is a first-class file source.** Hized Connect must monitor selected Excel workbooks or folders in SharePoint Online / OneDrive for Business, including live Microsoft Forms response workbooks that can change several times per day. Ingestion is revision-aware and idempotent: duplicate notifications and retries never duplicate data, while each genuinely changed workbook revision remains traceable to its source item, modification time, Graph version metadata and content hash.

### Changes since v1.6

- **Major CRM sources share a first-class incremental adapter contract.** Salesforce and Zendesk are initial supported CRM adapters, with HubSpot and Dynamics 365 able to use the same discovery, extraction, pagination, checkpoint, retry and deletion contract. Salesforce supports the existing operational pattern of querying new/modified records over a rolling lookback (24 hours by default) and idempotently upserting by record ID, strengthened with a persisted high-water mark so delayed jobs cannot create gaps.

### Changes since v1.7

- **The SME multi-source and Custom ETL boundary is explicit.** A tenant can operate several ordinary connectors and pipelines at once because small and mid-sized companies normally spread operational truth across finance, CRM, service, workforce and recurring spreadsheets. Hized Connect does not need a universal self-serve join canvas for MVP: reusable governed transformations reconcile those feeds. Sources or business rules outside the standard adapters are delivered as paid, Hized-managed Custom ETL work, but must still use the same tenant isolation, secrets, lineage, validation and run-monitoring contracts as packaged connectors.

### Changes since v1.8

- **Microsoft connector authentication and observation semantics clarified.** SharePoint/OneDrive uses multi-tenant delegated Microsoft OAuth with offline access, encrypted refresh-token storage and a stable callback; Graph access remains limited to the connected account and selected Hized sources. Delta reports current drive state rather than guaranteeing recoverable content for every edit between polls, so revision history records every content revision Hized actually observes. A cumulative Forms workbook still captures intervening responses on the next upsert even when several edits occurred between observations.

### Changes since v1.9

- **The platform production domain is `hized.app`.** The apex hosts shared authentication and OAuth callbacks; tenant applications use `*.hized.app`. `hized.com` remains the separate marketing site.
- **Connect is analyst-operated and adapter-neutral.** Company administrators authorise organisational connections and secrets; authorised analysts configure repeatable pipelines through a guided source, fields, load, validation, schedule and review flow. Salesforce and Zendesk are reference implementations of CRM/API adapter patterns, not an exhaustive connector promise.
- **Hized-managed SQL is the default analytical destination.** CSV, Excel, Forms, SharePoint, CRM and API data are source deliveries into tenant-isolated governed storage. A customer does not need to operate SQL Server to use Hized; customer-owned SQL/warehouse extraction and paid Custom ETL remain supported integration options.

### Changes since v2.0

- **Pulse and Canvas are company-wide products, not admin-only tools.** Every active tenant member can enter Pulse and Canvas. What they can do is determined by their feature role; what data they can see is independently constrained by their assigned organisation scope and approved subject-area/metric permissions.
- **Company Admin owns access setup.** Company Admins invite users and assign each member a role, status and primary organisation scope. A company-root scope provides company-wide visibility; division, function, department, region, site, team or employee scopes limit the user to that branch. The existing database model can hold additional scopes for later dotted-line access.
- **Division is an explicit hierarchy node.** Organisation structures can model divisions directly rather than overloading function or department. The existing `employee` application role is presented to customers as **End user**; this is a product label, not a separate permission role.
- **Tenant branding is Company Admin configuration.** A company can apply its logo, accessible brand colours and an approved typography choice across its tenant shell, Pulse and Canvas. Branding is tenant-scoped, previewable and resettable; it cannot inject arbitrary CSS/scripts, obscure security/status colours or alter another tenant or the Hized Platform Administration surface.

### Changes since v2.1

- **The authenticated tenant entry is a product hub.** After organisation selection, users land on Home rather than being dropped into Pulse. Home shows Pulse, Connect and Canvas, their company-level availability and any separate role limitation, with direct entry to available areas.
- **Commercial entitlements are server-enforced.** Hized Platform Administration controls whether each tenant product is active, on trial or locked. Company Admins configure an enabled product but cannot self-enable a product the company has not purchased. Locked products remain discoverable with a lock and a marketing “Find out more” route; typed URLs, server actions, OAuth callbacks and background jobs must enforce the same entitlement.
- **Tenant Settings is a platform capability, not an upsell module.** Organisation structure, users/access, branding and audit live behind one Settings landing. Role checks still govern each setting, independently from product subscription access.

### Changes since v2.2

- **Automated performance-report delivery is a governed platform capability.** Authorised users can schedule published Pulse reports and Canvas boards for daily, weekly, monthly or calendar-based email delivery. Secure application links are the default; optional PDF or spreadsheet-compatible artefacts preserve the selected reporting period, filters, definition versions and data-freshness state.
- **Every recipient receives only their own permitted view.** Scheduled content is resolved independently for each active tenant member at send time using that recipient's current tenant membership, role, organisation scope, metric and dataset permissions. A schedule owner or report creator's wider access is never inherited by an email, attachment or link. External email recipients are deferred beyond MVP.
- **Connect incidents use the same delivery service.** Company Admins and Analysts can configure tenant-scoped notifications for pipeline failure, warning, stale source, schema drift, unusual or missing volume, retry exhaustion and recovery. The service deduplicates incidents, records delivery attempts, supports suppression, acknowledgement and escalation, and never includes credentials or sensitive row data in an email subject or body.

### Changes since v2.3

- **Pulse and Canvas share one governed visual grammar.** A saved view contains layout, presentation and references to approved KPI definitions; it never stores or copies resolved customer data. Pulse uses Company Admin/Analyst-published tenant templates, while Canvas lets every entitled active member start privately and share a published board.
- **A broad initial visual catalogue is explicit.** The first renderer covers KPI, line, area, column, horizontal bar, target-attainment, donut, gauge, funnel, heatmap, exact table, text, line-and-column, waterfall, treemap, radar, scatter and bullet visuals. Visual choice is constrained by semantic compatibility so catalogue breadth does not create misleading analysis.
- **Sharing never transfers data authority.** Pulse templates and Canvas boards resolve under the current viewer's tenant, membership, role, organisation scope and approved KPI access on every render. Named-user, role, organisation-area and whole-tenant grants may control access to a board, but are additional to—not substitutes for—underlying data permissions.
- **Geospatial views require governed geography.** Maps remain an MVP requirement, but are enabled only after the governed dimension model supplies validated geographic identifiers or coordinates. Hized must not infer locations from labels or plot arbitrary organisation positions merely to claim map support.

## 1. Product definition and positioning

### 1.1 Product vision

Hized gives a company one governed view of performance, from board-level outcomes down to departments, teams and individual employees. It connects fragmented operational systems, standardises business metrics and presents role-specific dashboards, alerts and scheduled reports.

**North-star statement**

Hized turns disconnected business data into a living performance system that tells every level of the organisation what is happening, why it matters and where action is required.

### 1.2 The problem Hized solves

- **Fragmented data:** Finance, CRM, workforce, customer, operations and spreadsheet data sit in separate systems.
- **Conflicting metrics:** Departments calculate the same KPI differently, creating arguments instead of decisions.
- **Reporting dependency:** Managers wait for analysts to rebuild recurring reports and answer routine questions.
- **No performance cascade:** Executives see totals, but cannot consistently drill into the region, team or employee driving the result.
- **Weak operational action:** Dashboards describe the past but rarely connect exceptions to owners, targets and follow-up actions.
- **Expensive data tooling:** Mid-sized organisations struggle to justify separate ETL, warehouse, BI and data-observability products.

### 1.3 Product positioning

Hized should initially be sold as a consulting implementation supported by proprietary software. The client buys an outcome — a trusted company performance hub — rather than a generic dashboard licence.

| | |
|---|---|
| What Hized is | A consultancy-led performance platform combining integration, data modelling, dashboards, KPI governance, alerts and continuous improvement. |
| What Hized is not | A replacement for the client's CRM, ERP, finance system or specialist operational applications. |
| Primary buyer | Managing Director, COO, CFO, Head of Operations, Transformation Director or Data/BI leader. |
| Ideal early client | A 50–1,000 employee organisation with multiple systems, recurring spreadsheet reporting and limited internal data engineering capacity. |
| Core promise | One version of performance, delivered to each user at the right organisational level. |

## 2. Product suite and commercial model

### 2.1 Hized Connect

Hized Connect is the managed ETL and data-quality layer. It extracts data from source systems, validates it, transforms it into consistent structures and loads it into the Hized data foundation. It provides scheduling, retries, logging, schema-drift handling and operational monitoring.

### 2.2 Hized Pulse

Hized Pulse is the client-facing performance hub. It provides executive scorecards, departmental dashboards, team and employee views, drill-down analysis, targets, alerts, scheduled reporting and a governed KPI catalogue.

### 2.3 Hized Canvas

Hized Canvas is the self-serve exploration layer built on the same governed data foundation as Hized Pulse. It lets authorised users build their own charts, tables and boards without waiting on IT or an analyst, while staying constrained to approved datasets and KPI definitions — freedom to explore without forking the single source of truth.

### 2.4 Hized Advisory

Hized Advisory wraps the technology in discovery, data design, KPI definition, implementation, training and ongoing performance improvement. Consultancy revenue funds product development while each implementation strengthens reusable connectors, models and industry templates.

### 2.5 Commercial packaging

| Module | Primary users | Core outcomes | Illustrative KPIs |
|---|---|---|---|
| Discovery and design | Executive sponsor, process owners | KPI inventory, source assessment, hierarchy design, implementation plan | Fixed discovery fee |
| Implementation | Client project team | Connect sources, create data model, configure dashboards, train users | One-off project fee |
| Managed platform | All users | Hosting, refreshes, monitoring, support, updates and backups | Monthly recurring fee |
| Performance advisory | Executive and operational leaders | Monthly review, new insights, metric refinement and improvement actions | Monthly retainer |
| Custom ETL and development | Selected clients | Unusual source extraction, multi-source reconciliation, bespoke business rules, new connectors, modules or workflows | Scoped professional services plus an optional managed-support uplift |

### 2.6 Product entry and entitlements

The tenant Home page is the stable post-login entry point. It presents the product suite without conflating three different decisions: whether the company subscribes to a product, whether the member's feature role can operate it, and which organisation-scoped data that member may see.

| ID | Requirement | Priority | Acceptance signal |
|---|---|---|---|
| SUITE-001 | Land an authenticated tenant member on a responsive Home product hub after organisation resolution. | Must | A single-tenant login and tenant-root visit open Home; the user can enter each available product or Settings without guessing routes. |
| SUITE-002 | Store one explicit `active`, `trial` or `locked` entitlement per tenant product. | Must | Entitlements are tenant-isolated by RLS; Hized Platform Admin can change them in the selected tenant context and Company Admin cannot grant paid access. |
| SUITE-003 | Enforce locked products on every execution path, not only in navigation. | Must | A locked product cannot be used through a typed URL, server action, OAuth callback, API or scheduled job. |
| SUITE-004 | Keep locked products discoverable with a clear commercial next step. | Should | Home displays a lock, “Not included” and a “Find out more” link without presenting a role restriction as a billing problem. |
| SUITE-005 | Consolidate tenant configuration behind Settings. | Must | Organisation, users/access, branding and audit are reachable from one landing, and each destination retains its role gate. |

Settings is not a separately billable product. Pulse and Canvas remain company-wide once entitled; their data and actions are still constrained by role, organisation scope and metric/subject permissions. Connect may be commercially active for a tenant while its configuration surface remains restricted to Company Admins and Analysts.

## 3. Users, organisational hierarchy and permissions

### 3.1 Multi-layer performance requirement

The organisational hierarchy is a first-class data structure. Dashboards must not be isolated copies for each role. The same governed KPI should aggregate and filter through the hierarchy so that users can move from company results to the responsible division, department, region, manager, team and employee.

| ID | Requirement | Priority | Acceptance signal |
|---|---|---|---|
| ORG-001 | Support an arbitrary, acyclic organisation tree with company, division, function, department, region/site, manager, team and employee nodes. | Must | An administrator can create, move and deactivate nodes without code changes, and a node cannot be moved beneath itself or a descendant. |
| ORG-002 | Associate users, employees, targets, KPIs and source records with one or more organisation nodes. | Must | A metric can be filtered and aggregated at each hierarchy level. |
| ORG-003 | Allow authorised users to drill from an aggregate result into lower levels and supporting records. | Must | An executive can move from company to region to team to employee where permitted. |
| ORG-004 | Support effective dates for hierarchy changes using half-open intervals (`valid_from <= date < valid_to`). | Should | Historical results remain attributed to exactly one correct structure for the selected period; the effective-date boundary never exposes both old and new scope paths. |
| ORG-005 | Permit dotted-line or cross-functional membership. | Could | An employee can belong to a home team and an additional project or matrix group. |

### 3.2 Core personas

| Module | Primary users | Core outcomes | Illustrative KPIs |
|---|---|---|---|
| Platform Super Admin | Hized internal team | Manage tenants, platform configuration, support access and system health — see section 7 | Tenant count, connector health, usage |
| Company Admin | Client data/IT owner | Manage users, roles, hierarchy, branding, connectors and KPI catalogue | Refresh status, adoption, access reviews |
| Executive | Board and senior leadership | Understand company health, strategic targets, risks and exceptions | Revenue, profit, cash, customer, workforce, delivery |
| Functional Leader | Head of department or region | Manage performance, capacity and root causes within a defined scope | Department outcomes, teams, forecasts, risks |
| Manager / Team Leader | Operational people manager | Run daily or weekly performance and coach teams | Backlog, productivity, quality, attendance, SLA |
| End user (`employee` role) | Individual contributor | See approved personal or team goals, output, quality and trend within their assigned scope | Personal target attainment and quality measures |
| Analyst | Client or Hized analyst | Explore governed data, build self-serve dashboards in Hized Canvas and validate metrics | Dataset usage, query performance, data quality |

### 3.3 Access control model

- Every active tenant member can enter Hized Pulse and Hized Canvas; neither product is reserved for administrators.
- Company Admins configure invitations, membership status, feature role and organisation scope. Suspending a membership removes tenant access without deleting its audit history.
- Role-based access controls define which features and actions a user can use. The initial tenant roles are Company Admin, Executive, Functional Leader, Manager, End user (`employee`) and Analyst.
- Organisation scope independently defines which rows and hierarchy branches a user can see. A company-root assignment grants whole-company scope; a lower node limits the user to that node and its descendants.
- Every non-admin member must have a primary scope. Company Admins are tenant-wide by definition and do not rely on a scope row for access.
- Dashboard and module permissions define which subject areas are visible.
- Column and metric restrictions protect salary, HR, health, disciplinary and commercially sensitive data.
- Employee-facing views must only expose approved metrics and comparisons.
- All permission changes, exports and sensitive drill-through actions must be audited.
- Invitation tokens are bearer secrets: possession of the invited email address alone never grants signup or tenant membership. Existing authenticated users can accept a valid invitation into an additional tenant without creating a second identity.

### 3.4 Tenant branding

Company Admins can make the client-facing tenant feel like their organisation while Hized retains safe, legible product structure. This is tenant customisation, not an arbitrary white-label code surface.

| ID | Requirement | Priority | Acceptance signal |
|---|---|---|---|
| BRAND-001 | Upload a tenant logo for the authenticated shell, Pulse and Canvas, with a text-name fallback. | Must | A valid PNG or WebP logo is stored in Hized-managed object storage and appears only in that tenant; unsafe or oversized files are rejected. SVG may follow only with explicit sanitisation. |
| BRAND-002 | Configure primary and accent colours through validated colour fields. | Must | A preview shows the applied theme, text/background combinations retain agreed accessible contrast, and semantic success/warning/error colours remain distinguishable. |
| BRAND-003 | Choose typography from a curated, locally hosted set of readable families. | Should | The selected heading/body family loads without a third-party tracking request or layout-breaking arbitrary font/CSS input. |
| BRAND-004 | Preview, publish and reset branding, with each published change audited. | Must | Users see only the latest published tenant theme; an admin can restore Hized defaults and the audit log records actor and changed fields. |

Brand settings never change authentication, authorisation or row visibility. The Hized Platform Administration surface remains Hized-branded so support operators always know they are outside a client tenant.

## 4. Hized Pulse functional scope

### 4.1 Home and company pulse

- Pulse is available to every active tenant member. Its landing content, drill paths and underlying records must respect both the member's role and current organisation scope.
- Role-aware landing page with the user's most important KPIs, alerts, saved views and recent reports.
- Company health summary built from configurable weighted KPI groups; the score must show its components and never be a black box.
- Target versus actual, period comparison, trend direction, confidence or freshness indicator and owner for each KPI.
- Executive summary highlighting changes, risks, opportunities and metrics requiring attention.
- Data freshness banner showing when each underlying source was last successfully refreshed.

*Note: Pulse presents governed, role-aware dashboard templates curated for each level of the hierarchy. Ad hoc and self-serve exploration on the same underlying datasets is Hized Canvas's job — see section 6.*

### 4.2 Dashboard and visualisation capabilities

| ID | Requirement | Priority | Acceptance signal |
|---|---|---|---|
| PULSE-001 | Provide responsive dashboards with KPI cards, trend/area/combo charts, categorical and proportional charts, tables, heatmaps, gauges, funnels, waterfall, treemap, radar, scatter, bullet, governed maps and text panels. | Must | A user can view dashboards on desktop and mobile without clipped or unreadable content; every chart has an accessible label and explicit no-data state. |
| PULSE-002 | Support global and widget-level filters including date, organisation, geography, product, customer and custom dimensions. | Must | Filters consistently update all compatible widgets. |
| PULSE-003 | Allow authorised creators to add, resize, reorder and configure widgets. | Should | Dashboard layouts persist per tenant and optionally per user. |
| PULSE-004 | Support drill-down, drill-through and inspect-data actions. | Must | Users can trace an aggregate result to contributing segments and permitted records. |
| PULSE-005 | Allow comparison with target, prior period, prior year, forecast and benchmark. | Must | Comparison bases are explicit and reusable across widgets. |
| PULSE-006 | Provide export to CSV, Excel-compatible files, image and PDF report formats subject to permission. | Should | Exports preserve active filters and are recorded in the audit log. |
| PULSE-007 | Allow authorised users to schedule a published Pulse report for themselves or permitted tenant recipients. | Must | Daily, weekly, monthly and calendar-based schedules preserve the report period and filters, use the tenant time zone, and create an auditable delivery record. |
| PULSE-008 | Resolve scheduled report content separately under every recipient's current access at send time. | Must | A recipient never receives a metric, row, organisation branch or attachment that they could not open directly in Pulse at the time of delivery. |

**Visual configuration contract:** creators choose a governed question, data shape (current selected area, visible child-area comparison or trend), compatible approved KPIs and responsive size. The platform may reject combinations whose units or cardinality would make a visual misleading. All visual types use a shared renderer and data contract across Pulse, Canvas, browser views and future scheduled artefacts; product-specific forks are not permitted. A table or inspect-data path remains available where a graphic alone would hide exact values. Saved layouts contain identifiers and configuration only, and are always re-resolved through the current viewer's RLS context.

### 4.3 KPI catalogue and scorecards

Every important metric should be represented as a governed KPI definition rather than embedded independently inside each visual. The KPI catalogue is the contract between the business, Hized Connect, Hized Pulse and Hized Canvas.

- Name, plain-English definition and business purpose.
- Owner, reviewer and applicable organisation levels.
- Formula or calculation reference.
- Data source, refresh cadence and expected latency.
- Unit, formatting, favourable direction and threshold bands.
- Target method: fixed, period-specific, inherited or employee-specific.
- Permitted dimensions and drill paths.
- Validity dates, version history and approval status.

### 4.4 Performance modules

| Module | Primary users | Core outcomes | Illustrative KPIs |
|---|---|---|---|
| Executive | Executives and board | Company health, strategic priorities and cross-functional exceptions | Revenue, margin, cash, growth, NPS, delivery, absence |
| Sales | Sales leadership and teams | Pipeline visibility, conversion, activity and forecast accuracy | Leads, conversion, win rate, pipeline, revenue, target |
| Customer Care | Service leadership and agents | Demand, service levels, quality and customer outcomes | Volume, answer rate, SLA, AHT, FCR, CSAT, NPS, backlog |
| Operations | COO, regional and team leaders | Throughput, capacity, ageing, quality and bottlenecks | Jobs, cycle time, utilisation, rework, backlog, first-time completion |
| Finance | CFO and budget owners | Financial performance, variance, liquidity and working capital | Revenue, gross margin, EBITDA, cash, debtors, budget variance |
| People | HR and approved managers | Workforce capacity, attendance, retention and hiring | Headcount, absence, turnover, vacancies, overtime, training |
| Marketing | Marketing and sales | Campaign efficiency and lead generation | Spend, leads, CAC, conversion, attribution, ROI |
| IT / Service | IT and business owners | Availability, incidents, tickets and service performance | Uptime, incidents, SLA, MTTR, change failure rate |

### 4.5 Targets, commentary and actions

- Targets may be set at company, department, team or employee level and may roll up or inherit.
- Users can add period commentary to a KPI, with author, timestamp and edit history.
- Exceptions can be assigned to an owner with due date, status and evidence link.
- Monthly and weekly performance packs should retain a frozen snapshot and commentary trail.
- Optional approval workflow enables managers to submit and executives to sign off a reporting period.

### 4.6 Alerts and scheduled reporting

- Threshold alerts: actual crosses a configured limit.
- Target alerts: metric is outside an allowed variance from target.
- Trend alerts: sustained deterioration or unusual rate of change.
- Data alerts: refresh failure, stale data, schema drift or missing volume.
- Scheduled reports: daily, weekly, monthly or calendar-based delivery from a published Pulse report or Canvas board. Tenant time zone, reporting period, active filters, governed definition versions and data freshness are explicit in every generated pack.
- A member may subscribe themselves to content they can view. Company Admins and Analysts may configure organisational schedules for active tenant members within the schedule owner's administration scope; recipient sets may be named members or dynamic role/organisation groups resolved at execution time.
- Secure authenticated links are the default email call to action. Optional PDF and spreadsheet-compatible attachments are generated per recipient only when the underlying report permits that export; attachment size and sensitivity policies may force link-only delivery.
- The scheduler rechecks product entitlement, membership status, role, organisation scope, dataset/metric access and report publication status for every recipient at send time. It skips unauthorised recipients with a reason in the delivery ledger rather than falling back to the schedule creator's view.
- Email subjects and preview text contain no sensitive row-level data. Opening a secure link rechecks current authorisation; a frozen attachment is an auditable export and follows retention controls.
- Channels: in-app and transactional email for MVP; Teams, Slack, SMS and push can follow through the same event/delivery contract.
- Alert deduplication, acknowledgement, quiet hours, suppression windows, retries with backoff, recovery messages and severity-based escalation rules.
- Every send has an idempotency key, recipient, content/snapshot reference, template version, provider outcome and timestamps. Retries cannot create duplicate report or incident emails.

## 5. Hized Connect ETL scope

### 5.1 Purpose

Hized Connect provides a repeatable, observable route from client systems to a trusted analytical model. The MVP prioritises reliable CSV/Excel and SharePoint ingestion plus reusable database and API/CRM adapter patterns chosen by early-customer evidence, rather than promising a large named connector marketplace.

### 5.2 Connector framework

| ID | Requirement | Priority | Acceptance signal |
|---|---|---|---|
| CONN-001 | Create and securely store connector configurations per tenant. | Must | Credentials are encrypted and never displayed after saving. |
| CONN-002 | Support SQL Server and Azure SQL read-only extraction. | Must | A connection can test, browse permitted tables/views and execute configured extracts. |
| CONN-003 | Support CSV and Excel file ingestion from upload or managed folder. | Must | Files can be mapped, validated and loaded with a repeatable schema. |
| CONN-004 | Provide a generic REST API connector with pagination, authentication and rate-limit handling. | Should | An administrator can configure a common JSON API without custom code. |
| CONN-005 | Provide a connector SDK or adapter interface. | Should | New sources can be added without modifying the core orchestration engine. |
| CONN-006 | Monitor selected Excel files or folders in SharePoint Online / OneDrive for Business, including Microsoft Forms response workbooks. | Must | Every changed content revision observed by Hized creates a distinct, traceable source revision and pipeline run without duplicate ingestion from retries or repeated notifications; cumulative Forms responses are not lost when several edits occur between polls. |
| CONN-007 | Provide a reusable CRM/API adapter contract, with Salesforce and Zendesk as reference implementations and HubSpot, Dynamics 365 or other sources able to use the same orchestration. | Must | An authorised operator can discover supported objects/resources, select fields, test access and run an incremental extract through the same pipeline monitoring surface; the product does not imply that only named examples are supported. |
| CONN-008 | Persist source-specific incremental checkpoints with an optional overlap window and idempotent upsert key. | Must | A delayed, failed or retried CRM run neither misses records nor duplicates previously loaded records; checkpoints advance only after a successful complete run. |
| CONN-009 | Support several connectors and pipelines per tenant without implying that every feed must be combined. | Must | A company can ingest finance, CRM, service and spreadsheet feeds independently, then select only the sources needed by each governed dataset/KPI. |
| CONN-010 | Provide a Hized-managed Custom ETL delivery path for unsupported sources and bespoke cross-source rules. | Should | A custom implementation is commercially distinguishable from standard Connect, versioned and supportable, but its credentials, source batches, validations, retries, lineage and run health remain visible through the ordinary Connect operating surface. |
| CONN-011 | Send configurable operational notifications for pipeline failure, warning, stale source, schema drift, unusual or missing volume, retry exhaustion and recovery. | Must | Company Admins and Analysts can select tenant members and severity rules; duplicate retries produce one incident thread, a recovery closes it, and every attempted in-app/email delivery is auditable. |

### 5.3 Pipeline capabilities

Connections and pipelines are separate concepts. A Company Admin authorises a connection and its credentials. A Company Admin or Analyst can then configure one or more pipelines over permitted source objects/files without seeing stored secrets. The guided setup sequence is source selection, schema discovery, field mapping/types, load behaviour and keys, validation, schedule/test, then an audited versioned save. This is configuration-first rather than a drag-and-drop ETL canvas.

- Full and incremental extraction using watermark columns, timestamps, IDs or source change tracking.
- Salesforce defaults to `SystemModstamp` (or the platform replication fallback where unavailable), a stable record ID upsert key, and a configurable rolling overlap such as the previous 24 hours. Small extracts can use REST pagination; high-volume extracts can use Bulk API 2.0 without changing downstream run semantics.
- Zendesk uses cursor-based incremental exports where supported, persists the final `after_cursor` only when `end_of_stream` is reached, retains deletion state, and honours endpoint rate-limit / retry headers.
- Configurable schedules with tenant time zone support.
- Idempotent loads and safe retry behaviour.
- SharePoint/OneDrive change tracking uses stable drive/item identifiers and a persisted delta cursor; change notifications may trigger faster reconciliation but never replace the delta scan. Downloaded content is hashed so repeated Graph notifications, retries and metadata-only changes cannot duplicate a load.
- Microsoft authorization uses the OAuth authorization-code flow with PKCE and offline access. Refresh tokens are authenticated-encrypted in application code before Postgres, bound to their tenant and connector, never returned to the browser, and re-encrypted when Microsoft rotates them. OAuth client secrets and encryption keys live only in the deployment secret store.
- SharePoint/OneDrive polling must be configurable frequently enough for the source's operating rhythm (for example every 15–60 minutes for an actively updated Forms workbook). Graph delta exposes the latest observed drive state; Hized must not claim it captured an intermediate workbook content revision that was never downloaded.
- Cumulative Forms workbooks support a configured stable response key and upsert semantics, so re-reading the latest workbook adds or updates responses rather than appending the full sheet again.
- Raw landing, staging and curated transformation layers.
- Hized-managed tenant-isolated SQL is the standard landing/curated destination for every adapter. A source workbook or form remains a delivery mechanism, not the long-term reporting database; a customer-owned SQL Server or warehouse is optional rather than a prerequisite.
- Data type mapping, column renaming, filtering, joins, calculated fields and deduplication.
- Validation rules for nulls, uniqueness, ranges, accepted values, referential integrity and row-count variance.
- Quarantine area for rejected rows with reason codes and reprocessing.
- Schema-drift detection for new, removed or changed columns.
- Pipeline logs, run status, duration, rows extracted/loaded/rejected and source watermark.
- Notifications for failures, warnings, stale pipelines and unusual data volumes.
- Operational notifications identify the connector/pipeline, environment, severity, first/last observed time and a secure run-detail link, but never disclose stored credentials or sensitive source rows in the subject or message body.
- Repeated events for the same pipeline incident are deduplicated during a configurable cooldown. Retry exhaustion can escalate; the first successful healthy run after an incident emits a recovery event and closes the incident.

### 5.4 Operational screens

- Connector inventory and status.
- Pipeline list with last run, next run, duration, row counts and health.
- Run detail with step-level logs and error messages.
- Validation results and quarantined records.
- Schema comparison and approved drift actions.
- Rerun, resume, cancel and backfill actions subject to permission.
- Data freshness and lineage surfaced into Hized Pulse.
- Source-revision history shows the SharePoint/OneDrive item, source modification time, discovered time, Graph version metadata and content hash used by each run.

**MVP constraint:** Do not attempt to become a full visual data-engineering studio in the first release. Configuration-first pipelines, reusable transformations and excellent observability are more valuable than a complex drag-and-drop canvas *(this refers to Connect's pipeline-building UI, not the Hized Canvas dashboard product below)*.

### 5.5 Standard Connect vs Custom ETL

- **Standard Connect** covers packaged file, database, SharePoint and reusable SaaS/API adapter patterns plus configuration that can be safely repeated across customers. Named products such as Salesforce and Zendesk demonstrate those patterns; priority follows real customer demand.
- **Custom ETL** covers unsupported/legacy systems, unusual authentication or pagination, client-specific matching rules, and transformations that reconcile several systems using business knowledge discovered during implementation.
- Custom ETL is a paid managed-service deliverable, not an ungoverned code bypass. Custom jobs run through the same pipeline/run tables and operational screens, and never receive a broad database or RLS exemption.
- Repeated custom work should graduate into a reusable adapter or transformation template only after it is proven across customers. The platform should not promise a connector marketplace before that evidence exists.
- The MVP needs the shared adapter/run contract and a clear service offer; it does **not** need self-service custom-code execution, arbitrary customer scripts or a complete quoting/billing workflow inside the application.

## 6. Hized Canvas — self-serve dashboards

### 6.1 Product intent

Where Pulse is the governed backbone — curated templates, approved KPIs, role-aware defaults — Canvas is the open workshop. It extends the same trusted, tenant-scoped datasets to any authorised user who wants to answer a question Pulse doesn't already show, without waiting on an analyst or a release cycle.

### 6.2 Core capabilities

- Drag-and-build charts, tables and boards from the governed datasets and KPI catalogue.
- Personal boards (private to the creator) and shared boards (visible to chosen users, teams or the whole tenant).
- Duplicate an existing board — personal or shared — as a starting point for a new view.
- Add locally scoped calculated fields and filters for a single board, clearly distinguished from governed KPIs.
- Promote a calculated field or board layout from Canvas into the governed KPI catalogue, subject to Company Admin review.

### 6.3 Requirements

| ID | Requirement | Priority | Acceptance signal |
|---|---|---|---|
| CANVAS-001 | Authorised users can create personal boards composed of existing governed datasets and fields. | Must | A user can build and save a board without developer involvement. |
| CANVAS-002 | Users can add locally scoped calculated fields and filters that do not modify the governed KPI catalogue. | Should | Local calculations are visually labelled as personal/unverified and cannot silently override an approved KPI. |
| CANVAS-003 | Boards can be shared with defined users, teams or the whole tenant, with view/edit permission separate from underlying dataset permissions. | Must | A shared board respects the viewer's own row-level and column-level security, not the creator's. |
| CANVAS-004 | Users can duplicate an existing board as a starting point for a new one. | Should | Duplication preserves lineage back to the datasets and KPIs it draws from. |
| CANVAS-005 | A Company Admin can promote a Canvas calculated field or board into the governed KPI catalogue / dashboard template set. | Should | A promoted field becomes a versioned, owned KPI definition, and boards built from it before promotion still reconcile. |
| CANVAS-006 | Canvas usage (boards created, shared, viewed, most-used datasets) is visible to administrators. | Could | An admin can see adoption and identify which self-serve boards are candidates for promotion into Pulse. |
| CANVAS-007 | Allow authorised users to schedule a published Canvas board through the shared report-delivery service. | Must | Each recipient's render honours that recipient's current board, dataset, field, row and export permissions; inaccessible widgets are never rendered using the creator's access. |

### 6.4 Governance guardrail

Canvas trades control for speed by design — that is its value. The non-negotiable constraint is that every board it produces is composed from the same governed, tenant-scoped datasets Pulse uses. Canvas can visualise and locally calculate; it must never let a user silently redefine or fork an approved KPI's meaning. The only way a Canvas calculation becomes an organisation-wide number is explicit promotion into the governed catalogue (CANVAS-005).

## 7. Hized Platform Administration

### 7.1 Product intent

Company Admin (section 3.2) manages one tenant, from inside it. Platform Super Admin is Hized's own internal team operating the entire multi-tenant estate from outside every tenant — provisioning new clients, watching cross-tenant health, and providing support without that support becoming an unaudited backdoor into client data. This is never sold to clients; it is how Hized runs the platform, and its own credibility depends on the audit guarantee in section 7.4 being real, not aspirational.

### 7.2 Core capabilities

- Tenant lifecycle: create, configure, suspend and offboard tenants.
- A cross-tenant list view: every tenant, its status, plan/tier and basic health at a glance — the "one screen" a platform admin starts a day from.
- Cross-tenant support access, scoped and time-boxed, with every view or action logged distinguishably from ordinary tenant activity.
- System-wide operational health once Hized Connect exists: aggregated pipeline failures, stale data and error rates across all tenants, so Hized catches a problem before the client reports it.
- Usage and adoption visibility per tenant (active users, Pulse vs Canvas usage) to support account management and renewal conversations.
- Platform-level configuration: feature flags that can be scoped to specific tenants (e.g. early access to a new capability) without a deployment.

### 7.3 Requirements

| ID | Requirement | Priority | Acceptance signal |
|---|---|---|---|
| PLATFORM-001 | Create and configure a new tenant (name, slug, branding, time zone) without code changes. | Must | A platform admin provisions a tenant end to end through the UI. |
| PLATFORM-002 | View a list of all tenants with status, creation date and basic health indicators. | Must | The tenant list loads and reflects current state, not a stale snapshot. |
| PLATFORM-003 | Every cross-tenant view or action by a platform admin is written to an immutable audit log, distinguishable from ordinary tenant-scoped activity. | Must | An auditor can see exactly which tenants a given platform admin accessed, when, and what they did. |
| PLATFORM-004 | Suspend or offboard a tenant, including the data retention/deletion workflow required by section 8.3. | Should | A suspended tenant's users cannot sign in; an offboarded tenant's data follows the retention policy, not ad hoc deletion. |
| PLATFORM-005 | Aggregate cross-tenant operational health (pipeline failures, stale data, error rates) once Hized Connect exists. | Should | A platform admin sees which tenants have active data-quality warnings without visiting each tenant individually. |
| PLATFORM-006 | "View as" a specific tenant or role for support troubleshooting, fully audited and time-boxed. | Could | A support session records actor, target tenant/user, start and end time, and cannot silently outlast a defined window. |
| PLATFORM-007 | Manage feature flags scoped to specific tenants. | Could | A flag change takes effect for the intended tenant(s) without a deployment. |

### 7.4 Governance guardrail

Platform Super Admin's reach is the single most powerful access level in the system — it is also the one clients have to trust blindly, since they can't see it working. Every RLS policy branch that grants a platform admin cross-tenant access (see section 9.2) must have a corresponding audit-log write; there is no "quiet" bypass path. A privileged mutation and its audit event commit in one database transaction, and a cross-tenant read must not return data if its audit event cannot be written. PLATFORM-006 ("view as") is explicitly the highest-risk capability here and should not be built casually — it needs its own time-boxing and audit design before it ships, not just a role check.

### 7.5 Explicitly out of scope for MVP

- Billing and invoicing UI (handled outside the product initially).
- PLATFORM-006 ("view as" impersonation) until there is a validated support need for it.
- PLATFORM-005 (cross-tenant health aggregation) until Hized Connect exists — there is nothing to aggregate before then.

## 8. Data model and KPI governance

### 8.1 Core platform entities

| Module | Primary users | Core outcomes | Illustrative KPIs |
|---|---|---|---|
| Tenant | Platform isolation | Company identity, settings, branding, time zone, financial year | TenantId |
| User and Role | Authentication and permissions | User profile, role assignments, feature permissions | UserId, RoleId |
| Organisation Node | Performance hierarchy | Company, department, region, team, employee scope | OrgNodeId, ParentOrgNodeId |
| Employee / Worker | People attribution | Employment identity, manager, team, skills, active dates | EmployeeId |
| Data Source / Connector | Integration configuration | Source type, credentials reference, status and owner | ConnectorId |
| Pipeline / Run | ETL orchestration | Schedule, steps, watermark, status, counts and errors | PipelineId, RunId |
| Dataset / Field | Analytical metadata | Curated model, schema, dimensions and measures | DatasetId, FieldId |
| KPI Definition | Governed metric | Definition, formula, owner, thresholds, dimensions and validity | KpiId |
| KPI Value | Calculated result | Period, organisation scope, actual, target and comparison | KpiValueId |
| Dashboard / Widget | Pulse presentation | Layout, filters, visual configuration and access | DashboardId, WidgetId |
| Canvas Board / Local Field | Self-serve presentation | User-composed layout, personal calculated fields, sharing scope and promotion status | BoardId, LocalFieldId |
| Alert / Incident | Exception management | Rule, event, severity, deduplication key, acknowledgement, escalation and recovery state | AlertRuleId, IncidentId, AlertEventId |
| Report Schedule / Snapshot | Automated performance delivery | Pulse report or Canvas board, cadence, time zone, period/filter contract, recipient selector and frozen artefact metadata | ReportScheduleId, ReportSnapshotId |
| Notification Delivery | Reliable channel delivery | Recipient, channel, template version, idempotency key, attempt/provider outcome, suppression and retention state | DeliveryId |
| Recipient Preference | Member notification control | Channel preference, quiet hours, severity and self-subscriptions within administrator-required minimums | NotificationPreferenceId |
| Comment / Action | Performance follow-up | Narrative, owner, due date, status and evidence | ActionId |

### 8.2 Semantic layer rules

- Business definitions are separated from visual configuration.
- All fact records must carry TenantId and sufficient organisation keys for security and aggregation.
- Dates should support UTC storage plus tenant-local reporting.
- Measures declare aggregation behaviour: sum, average, distinct count, ratio, snapshot or semi-additive.
- Ratios must be recomputed from numerator and denominator at the selected aggregation level rather than averaged.
- Slowly changing dimensions or effective dates preserve historical hierarchy and attribute changes.
- KPI versions must be traceable so a changed definition does not silently rewrite approved historical reports.
- Hized Canvas may compose new visual layouts and locally scoped calculated fields from governed datasets, but must never redefine an approved KPI definition without going through promotion (section 6.3, CANVAS-005).

### 8.3 Example KPI contract

| | |
|---|---|
| Name | First-time completion rate |
| Definition | Percentage of completed installation jobs that did not require a repeat visit within the defined quality window. |
| Formula | Eligible jobs completed first time / all eligible completed jobs. |
| Owner | Head of Field Operations |
| Favourable direction | Higher is better |
| Default scope | Company, region, team and installer |
| Dimensions | Date, region, team, installer, job type and product |
| Refresh | Daily by 07:00 tenant local time |
| Thresholds | Green >= 92%; amber 88%–91.99%; red < 88% |
| Security | Employee sees own value; managers see assigned hierarchy; executives see all. |

## 9. Reference architecture and security

### 9.1 Recommended implementation stack

| | |
|---|---|
| Web application | Next.js with React and TypeScript; responsive component library; server-rendered authenticated shell. |
| Backend API | Next.js Route Handlers / Server Actions as the application layer, organised into clear domain modules for the MVP rather than a separate service. |
| Operational database | Neon Postgres for tenants, users, metadata, configuration, audit and workflow state, with tenant isolation enforced by Row-Level Security policies keyed on TenantId. |
| Analytical storage | Neon Postgres (curated schemas) initially; architecture should permit a dedicated warehouse (e.g. Snowflake, BigQuery, ClickHouse) later as volume grows. |
| Background processing | Scheduled workers/background jobs for connectors, transformations, scheduled jobs and notifications. |
| Cache / queue | A managed queue for asynchronous jobs and notifications; add a cache layer only once performance requires it. |
| Object storage | Cloudflare R2 (S3-compatible, zero egress fees) for source files, exports and report artefacts. |
| Transactional email | Provider-neutral email adapter with domain authentication, bounce/suppression handling and no coupling to marketing-email workflows. |
| Authentication | Better Auth (email/password, magic link, OAuth), self-hosted on the same Neon database, for the MVP; SSO/Entra federation added as a paid connector for enterprise tenants that require it. |
| Deployment | Vercel for the web application; Neon-managed database branching for environments; separate development, staging and production environments with automated CI/CD. |
| Observability | Structured logging and error tracking (e.g. Sentry) integrated into the Next.js app and background workers. |

**Architecture choice:** Use a modular monolith first. Preserve boundaries for Identity, Tenancy, Organisation, Connectors, Pipelines, Semantic Metrics, Dashboards, Canvas, Alerts and Platform Administration as clear code-level domains within the Next.js app, but avoid premature microservices.

**Delivery boundary:** CI uses a separate, disposable Neon branch with distinct owner and RLS-enforcing runtime credentials. Migration/integration jobs must fail closed unless that branch is explicitly configured as safe to mutate. Production deploys from a protected main branch only after required lint, typecheck, build, migration and isolation-test checks have passed; deployment credentials and database URLs remain in their respective managed secret stores.

### 9.2 Multi-tenancy

- Every request and persisted record is tenant-scoped.
- Signup and login land on an authenticated organisation-resolution step rather than assuming a tenant from the apex hostname. Single-membership users may continue directly; multi-membership users can explicitly choose or switch organisation.
- Tenant subdomains are the canonical production URL. A development/preview path fallback is permitted only as routing metadata and must be revalidated against the caller's active membership exactly like a hostname-derived slug.
- Tenant isolation is enforced primarily through Postgres Row-Level Security policies keyed on TenantId, not solely through application-layer checks. The session context those policies read is set by trusted server-side code once per request, immediately after verifying the caller's identity — not derived from anything client-supplied.
- For early clients, use a shared application with strong logical isolation; support dedicated infrastructure (a separate database) as an enterprise option.
- No client can enumerate or infer another tenant's users, data, identifiers, exports or logs.
- Background report and notification jobs must establish tenant and recipient identity before reading content. A report is rendered once per recipient under that recipient's current RLS/application permissions, never once under the creator and reused across recipients.
- Support tenant-specific branding, time zone, financial calendar, retention, data residency and feature flags.
- Create automated tests specifically designed to detect cross-tenant access failures.
- Reject any attempt to set tenant session context without a verified user identity. Client-supplied routing headers, tenant IDs or profile IDs are never accepted as proof of authorization.
- Treat every `SECURITY DEFINER` function as a privileged internal API: use a fixed/empty search path, schema-qualify referenced objects, revoke execution from `PUBLIC`, and grant only the minimum runtime role that requires it.

### 9.3 Security requirements

- Encryption in transit and at rest.
- Secrets stored in a managed secret vault, never application configuration or logs.
- Least-privilege, read-only source connections wherever possible.
- MFA and SSO for privileged users.
- Immutable audit events for authentication, permissions, exports, connector changes and sensitive data access.
- Automated attachments are treated as sensitive exports: generation, delivery, download/expiry and retention are auditable, and provider metadata must not contain report data.
- Invitation signup and acceptance are authorized by a single-use, expiring, high-entropy token bound to the invited email. The raw token is never stored.
- Row policies and column privileges work together: self-service profile updates cannot alter identity linkage, staff status or other authorization attributes.
- Rate limiting, input validation, secure file scanning and protection against injection and cross-site attacks.
- Backup, point-in-time recovery and tested restoration procedures.
- Data retention and deletion workflows, including tenant offboarding.
- Privacy impact assessment for employee-level data.
- Production email requires a verified sending domain with SPF and DKIM plus an appropriate DMARC policy, bounce/complaint suppression and unsubscribe/preference behaviour where legally applicable. Platform transactional delivery remains separate from marketing consent and campaigns.

### 9.4 Non-functional requirements

| ID | Requirement | Priority | Acceptance signal |
|---|---|---|---|
| NFR-001 | Common dashboard pages should become interactive within 3 seconds under normal tenant load. | Must | Performance tests cover representative dashboard datasets. |
| NFR-002 | Long-running extracts, exports and jobs execute asynchronously. | Must | The UI remains responsive and shows job progress/status. |
| NFR-003 | The application supports keyboard navigation, accessible labels and WCAG-aligned contrast. | Must | Automated and manual accessibility checks pass agreed criteria. |
| NFR-004 | All date, time, number and currency formatting is tenant-localised. | Must | A tenant can choose locale, time zone and financial-year start. |
| NFR-005 | Configuration changes are versioned and auditable. | Should | An administrator can identify who changed a KPI, dashboard, board or pipeline and when. |
| NFR-006 | Critical services provide health checks and actionable monitoring. | Must | Support can distinguish application, source, pipeline and data-quality incidents. |

## 10. Core workflows and user stories

### 10.1 Tenant onboarding

1. Hized creates the tenant and nominates a Company Admin.
2. The Company Admin configures branding, time zone, financial calendar and authentication.
3. Hized imports or builds the organisation hierarchy.
4. An administrator creates the first source connector and tests read access.
5. Hized Connect profiles the source and configures the first pipeline.
6. Hized and the client approve KPI definitions and target rules.
7. Hized Pulse publishes an executive dashboard and one operational drill path.
8. Users are assigned roles and organisation scopes.
9. Refresh monitoring, alerts and scheduled reports are activated.
10. The implementation moves into a managed-service and improvement cycle.

### 10.2 Representative user stories

| ID | Requirement | Priority | Acceptance signal |
|---|---|---|---|
| US-EXEC-01 | As an executive, I want to see company health and the largest exceptions so that I know where leadership attention is required. | Must | The home view shows target variance, trends, owners and drill paths. |
| US-MGR-01 | As a regional manager, I want to compare teams using the same KPI definitions so that I can identify coaching and capacity needs. | Must | The dashboard is automatically scoped to the manager's region. |
| US-TL-01 | As a team leader, I want daily employee performance and supporting workload detail so that I can run an operational huddle. | Must | Employee visibility follows approved permissions and active hierarchy. |
| US-EMP-01 | As an employee, I want to view my approved targets and trend so that I understand my performance. | Should | The employee cannot access colleagues' restricted data. |
| US-ADMIN-01 | As an administrator, I want to define a KPI once and reuse it across dashboards so that reports remain consistent. | Must | Definition, formula, thresholds, owner and version are stored centrally. |
| US-DATA-01 | As a data owner, I want failed or stale pipelines to generate actionable alerts so that users do not unknowingly rely on outdated data. | Must | The dashboard displays freshness and pipeline incident status. |
| US-CANVAS-01 | As an analyst, I want to build my own dashboard from governed datasets without waiting on engineering so that I can answer a one-off question quickly. | Should | The analyst can create, save and share a board using only approved datasets and fields, without altering any governed KPI. |
| US-REPORT-01 | As a manager, I want my weekly Pulse or Canvas pack delivered automatically so that the performance rhythm does not depend on somebody exporting it manually. | Must | The scheduled email arrives in the tenant time zone with the intended period/filters, and its content is rendered under the recipient's current access. |
| US-DATA-02 | As an analyst, I want an ETL failure followed by a recovery notification so that I can act quickly without receiving duplicate noise from every retry. | Must | One deduplicated incident records delivery attempts, escalation and the healthy recovery event. |
| US-PLATADMIN-01 | As a platform admin, I want to provision a new tenant and see its health alongside every other tenant so that I can run Hized's whole client base from one place. | Must | A new tenant is created via the platform admin UI, and immediately appears in the cross-tenant list with the same health indicators as existing tenants. |

### 10.3 Example cross-layer drill journey

1. Executive sees installation completion below target nationally.
2. Executive drills to regions and identifies the West region as the main variance.
3. Regional view shows one team with low first-time completion.
4. Team view shows repeat visits concentrated in two job types.
5. Manager opens the permitted employee and job detail, assigns an action and adds commentary.
6. The next weekly pack retains the original variance, action owner and updated outcome.

## 11. MVP definition and delivery roadmap

### 11.1 MVP objective

**MVP outcome:** A real client can connect SQL Server or upload structured files, define an organisation hierarchy and governed KPIs, publish role-aware dashboards, drill from executive to team/employee level, build their own Canvas boards on the same data, monitor refreshes and receive scheduled exception alerts — provisioned and supported by Hized through the Platform Administration surface (section 7), not direct database access.

### 11.2 MVP in scope

- Multi-tenant tenant and user administration, including platform-admin-driven tenant provisioning (PLATFORM-001/002).
- Authentication plus role and organisation-scope permissions.
- Organisation hierarchy with effective dates and employee assignments.
- Manual CSV/Excel ingestion; monitored SharePoint Online / OneDrive Excel sources including Forms response workbooks; SQL Server/Azure SQL extraction where customers already have it; and reusable CRM/API adapters selected by pilot demand. Salesforce and Zendesk are reference implementations, while HubSpot, Dynamics 365 and other systems use the same contract.
- Multiple independent sources per tenant and Hized-delivered Custom ETL for unsupported sources or bespoke reconciliation, without an MVP promise of self-service arbitrary code.
- Scheduled full and watermark-based incremental pipelines.
- Raw, staging and curated structures with run logs and validation results.
- KPI catalogue with definitions, targets, thresholds and versions.
- Executive, department, team and employee dashboard templates (Pulse).
- Self-serve board building on governed datasets (Canvas), including sharing and promotion to the governed catalogue.
- Core visual widgets, filters, drill-down and permitted record detail.
- In-app and transactional email alerts for KPI thresholds and Connect failures, warnings, stale sources, schema drift, volume anomalies, retry exhaustion and recovery, with deduplication and delivery history.
- Automated daily, weekly, monthly and calendar-based delivery of published Pulse reports and Canvas boards to active tenant members, using secure links and permission-controlled PDF or spreadsheet-compatible artefacts.
- Branding, audit log (including platform-admin cross-tenant access — PLATFORM-003), basic support tools and operational monitoring.

### 11.3 Explicitly out of scope for MVP

- Large marketplace of packaged SaaS connectors.
- Full no-code visual transformation canvas for Connect pipeline building *(distinct from the Hized Canvas dashboard product, which is in scope)*.
- Customer-authored or uploaded executable ETL code; bespoke work is Hized-managed and passes the same review, deployment and monitoring controls as standard adapters.
- Native mobile applications.
- Natural-language analytics or autonomous AI decision making.
- Complex planning, budgeting and write-back workflows.
- Community marketplace, white-label reseller management and public embedding.
- Platform-admin "view as" impersonation (PLATFORM-006) and cross-tenant health aggregation (PLATFORM-005) — see section 7.5.

### 11.4 Delivery phases

| Module | Primary users | Core outcomes | Illustrative KPIs |
|---|---|---|---|
| Phase 0 — Product foundation | 2–4 weeks of build scope | Design system, tenancy, auth, organisation model, environments, CI/CD | Demonstrable secure shell |
| Phase 1 — Connect | First vertical slice | SQL/file ingestion, schedules, runs, validation, logs and curated table | Reliable refresh into governed storage |
| Phase 2 — Pulse | First customer-visible value | KPI catalogue, hierarchy filtering, dashboards, drill and targets | Executive-to-team performance journey |
| Phase 3 — Canvas | Self-serve adoption | Board builder, sharing, local calculated fields and promotion workflow into the governed catalogue | Self-serve adoption rate, boards created, promoted KPIs |
| Phase 4 — Operate | Production readiness | Alerts, reports, audit, support screens, backups, performance and accessibility | Pilot-ready managed service |
| Phase 5 — Expand | After pilot evidence | More connectors, templates, actions, forecasting and employee self-service | Repeatable client implementations |

Platform Administration (section 7) is not its own phase — PLATFORM-001/002/003 (tenant provisioning, tenant list, audit trail) are foundational and belong in Phase 0 alongside tenancy itself; PLATFORM-004 belongs wherever tenant offboarding is first needed; PLATFORM-005/006/007 are explicitly deferred past MVP (section 7.5).

### 11.5 Suggested pilot

Use a field-service, customer-care, logistics, energy, construction or installation business with three to five source systems and a clear management hierarchy. The pilot should include one executive dashboard, one operational function, one team-to-employee drill path, at least one self-serve Canvas board, and at least one automated data-quality alert.

## 12. Acceptance criteria and quality standards

### 12.1 Product-level acceptance

1. A tenant administrator can configure a client without developer database edits.
2. A source can be connected using encrypted credentials and least-privilege access.
3. A failed pipeline cannot silently present stale data as current.
4. A KPI has one reusable definition and produces consistent results across hierarchy levels.
5. An executive can drill from company to permitted lower-level performance using a continuous path.
6. A manager only sees assigned organisation scope and approved employee metrics.
7. An employee cannot access another employee's restricted performance records.
8. Dashboard exports and scheduled reports preserve the intended filters and reporting period.
9. All privileged configuration changes and sensitive exports appear in the audit log.
10. The platform can onboard a second tenant without copying or branching application code.
11. A Canvas board built by one user cannot expose data the viewer isn't otherwise permitted to see.
12. A platform admin can provision and view every tenant, and every one of those cross-tenant actions is independently visible in the audit log — not just the client-facing audit trail.
13. Knowing an invited email address without the matching raw invitation token cannot create an account or membership; the same valid token can be consumed by the matching already-authenticated user to join another tenant.
14. A scheduled Pulse or Canvas delivery is resolved separately for each recipient and cannot expose data, filters, organisation scopes or exports that recipient could not access directly at send time.
15. Repeated ETL retries produce one deduplicated incident notification flow, with auditable attempts, escalation when configured and an explicit recovery after the next healthy run.

### 12.2 Definition of done for each feature

- Functional acceptance criteria implemented and tested.
- Authorisation and cross-tenant tests included.
- Loading, empty, error, no-access and stale-data states designed.
- Audit and observability events included where relevant.
- Privileged mutations and their audit events are transactionally atomic; privileged reads fail closed if their audit event cannot be recorded.
- Keyboard and screen-reader behaviour considered.
- Responsive layout verified at desktop, tablet and mobile widths.
- Database migration, rollback and seed/demo data supplied.
- User-facing configuration and administrator notes documented.

### 12.3 Demo data requirement

The codebase should contain a synthetic demonstration tenant representing an installation and service business. It should include regions, teams, employees, jobs, sales, customer service and finance KPIs. Synthetic data must clearly demonstrate target variance, hierarchy drill-down, stale data, a deduplicated ETL warning/recovery notification, at least one promoted Canvas board and one recipient-safe scheduled report delivery.

This requirement is delivered progressively by the epic that owns each schema. EPIC-01 supplies two isolated tenant shells plus the installation/service organisation hierarchy (regions, teams and synthetic employees). EPIC-04/05 add jobs, ingestion and the warning run; EPIC-06/07/08 add governed sales, customer-service and finance KPIs with drill-down, target variance and stale-data states; EPIC-12 adds the promoted Canvas board. Earlier phases must not create placeholder production tables merely to make the final demo appear complete.

## 13. AI build handoff prompt and backlog

### 13.1 Master prompt for an AI software builder

> You are the lead product engineer for Hized. Build a production-minded, multi-tenant business performance platform using this specification as the source of truth.
>
> **Primary products:**
> 1. Hized Connect — connector, ETL, validation, monitoring and curated data layer.
> 2. Hized Pulse — role-aware dashboards and governed KPI management from executive to employee level.
> 3. Hized Canvas — self-serve dashboard and board-building layer on the same governed datasets as Pulse; ship a working MVP alongside Pulse, not merely an extension point.
>
> Alongside these, **Hized Platform Administration** (section 7) is not a client-facing product but is foundational build scope — it's how Hized itself provisions and supports every tenant, and its audit guarantee (section 7.4) is what makes the multi-tenancy promise in section 9.2 credible rather than aspirational.
>
> **Build principles:**
> - Deliver vertical slices that work end to end.
> - Use a modular monolith before microservices.
> - Enforce tenant isolation and organisation-scope security in every query — Postgres Row-Level Security is the primary guard, not just application code.
> - Store KPI definitions centrally; do not hide business logic inside UI widgets, including Canvas boards.
> - Make data freshness and pipeline health visible.
> - Use background jobs for extraction, exports, reports and optimisation.
> - Include migrations, tests, synthetic demo data, seed users and operational documentation.
> - Never implement a feature without loading, empty, error, permission and stale-data states.
>
> **MVP build order:**
> - A. Repository, environments, design system, authentication and tenancy.
> - B. Organisation hierarchy, users, roles and row-level scope.
> - C. Platform admin tenant provisioning, cross-tenant list and audit trail (PLATFORM-001/002/003).
> - D. SQL Server plus CSV/Excel connectors, pipeline scheduling, run logging and validation.
> - E. Curated dataset metadata and KPI catalogue.
> - F. Executive-to-employee dashboards, filters, targets, drill-through and Canvas self-serve board building.
> - G. Alerts, scheduled reports, audit and production hardening.
>
> **For each iteration:**
> - Restate the selected epic and assumptions.
> - Produce the database migration and domain model first.
> - Implement API contracts and authorisation.
> - Implement UI and all states.
> - Add unit, integration and end-to-end tests.
> - Provide run instructions and a concise change log.
> - Do not start the next epic until the current acceptance criteria pass.

### 13.2 Initial engineering epics

| ID | Requirement | Priority | Acceptance signal |
|---|---|---|---|
| EPIC-01 | Platform shell, tenancy, environments and design system. | Must | Two demo tenants are isolated and deployable through CI/CD. |
| EPIC-02 | Authentication, user management, roles and organisation scopes. | Must | Authorisation tests cover executive, manager and employee journeys. |
| EPIC-03 | Organisation hierarchy and effective-dated assignments. | Must | Historic and current hierarchy filters return expected results. |
| EPIC-04 | Connector framework with SQL Server, file/SharePoint and CRM adapters (Salesforce and Zendesk first). | Must | Connections can be tested, objects/files can be discovered, and secrets remain protected. |
| EPIC-05 | Pipeline orchestration, incremental extraction, validation and run monitoring. | Must | A failed or warning run is visible and alertable. |
| EPIC-06 | Dataset metadata and governed KPI catalogue. | Must | A KPI is defined once and reused in multiple dashboards. |
| EPIC-07 | Dashboard runtime, filter context and core widgets. | Must | A dashboard loads real curated data with responsive states. |
| EPIC-08 | Hierarchy drill-down and row-level employee security. | Must | Executive, manager and employee views return different permitted scopes. |
| EPIC-09 | Targets, commentary, actions and period snapshots. | Should | Performance review history is retained. |
| EPIC-10 | Shared alerts, incident handling, scheduled Pulse/Canvas reports, exports and notification centre. | Must | Selected tenant members receive recipient-safe performance packs and deduplicated ETL incident/recovery messages; delivery attempts, suppression and exports are auditable. |
| EPIC-11 | Audit, support tooling, monitoring, backup and pilot hardening. | Must | Operational runbook and recovery checks are complete. |
| EPIC-12 | Hized Canvas self-serve board builder, local calculated fields and promotion-to-catalogue workflow. | Should | Analysts can build, save and share a board using only governed datasets; a promoted board's calculated field becomes a versioned KPI. |
| EPIC-13 | Platform Administration: tenant provisioning, cross-tenant list, and platform-admin audit trail distinguishable from tenant-level audit. | Must | A platform admin creates a tenant end to end and every cross-tenant view/action is independently auditable (PLATFORM-001/002/003). |

### 13.3 Repository structure recommendation

```
/apps
  /web              Next.js user and admin application
  /worker           background pipeline and notification workers
/domains
  /identity
  /tenancy
  /organisation
  /connectors
  /pipelines
  /semantic-metrics
  /dashboards
  /canvas
  /alerts
  /platform-admin
/packages
  /ui
  /contracts
  /testing
/infrastructure
  /database
  /deploy
/docs
  /architecture
  /runbooks
  /product
```

### 13.4 Product decisions still requiring validation

- Exact early-client industry focus and first reusable dashboard template.
- Shared analytical database versus database-per-tenant options at different commercial tiers.
- Whether Canvas board promotion (CANVAS-005) requires Company Admin approval only, or also a Hized-side review during the pilot phase.
- Level of client self-configuration versus Hized-managed configuration in the first two years.
- Pricing model: per tenant, per user, per connector, data volume, managed service tier or hybrid.
- Exact scope and timing of PLATFORM-005 (cross-tenant health aggregation) and PLATFORM-006 ("view as" impersonation) — both explicitly deferred past MVP (section 7.5), but not yet scheduled into a specific phase.

**Resolved since v1.0:** Reference architecture is Next.js + a tenant-isolated Postgres database (RLS-based tenant isolation) + Vercel, not the ASP.NET Core / Azure SQL / Microsoft Entra ID stack originally proposed in section 9.1.

**Resolved since v1.1:** The Postgres/Auth/Storage stack is Neon + Better Auth + Cloudflare R2 (section 9.1), not Supabase — changed once the build was in progress; Supabase bundles Auth and Storage with its Postgres offering, Neon does not, so those two became independent choices favouring zero cost until a tenant is paying.

### Closing product statement

Hized is a consultancy-led data performance platform. Hized Connect creates the trusted data foundation. Hized Pulse turns that foundation into governed, role-aware performance views from executive leadership to individual teams and employees. Hized Canvas lets any authorised user build their own views on that same trusted foundation without waiting on engineering. Hized Platform Administration is how Hized itself provisions, supports and stays accountable for every one of those tenants without becoming the weak point in its own isolation guarantee. The immediate product goal is not to build every possible dashboard; it is to prove a secure, repeatable path from fragmented source data to accountable business performance.

*END OF PRODUCT BLUEPRINT*
