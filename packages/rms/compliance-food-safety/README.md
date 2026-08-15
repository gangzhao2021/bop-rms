# `compliance-food-safety`

## Identity and responsibility

- Module Name: `compliance-food-safety`
- Package Name: `@rms/compliance-food-safety`
- Layer / Domain: `RMS / Compliance and Food Safety`
- Phase / owning Work Package: `Later / WP-2170–2176`
- Owner role: `Compliance and Food Safety Engineering Owner`
- Status: `active contracts, runtime-inactive adapters`
- Responsibility: closed Compliance Dashboard query policy, rebuildable operational summaries and
  versioned Compliance Case, Inspection, Finding, Corrective Action, monitoring, Permit,
  Qualification, Allergen Control, Food Safety Incident, Traceability, containment, Verification,
  restricted Evidence Set and Regulatory Notification contracts.
- Explicit non-goals: source Compliance Case/Record persistence and Product, Recipe, Supplier,
  Inventory, Kitchen, Device, Workforce or Order facts and commands.

## Public contract

`createComplianceDashboardService` exposes `compliance_dashboard_v1`. It requires a current
workforce Tenant Context, Actor, purpose, `compliance.dashboard.view` decision and exact
Tenant/Brand/optional Store scope. The response pins generated/source-as-of instants, projection
version, freshness/completeness, closed signal kind and Finding Severity, derived due state and
decimal-string Evidence coverage. Only opaque owning Case/Record references cross the contract.

Private source records, narratives, contacts, health/allergy facts, authority payloads, raw Evidence
and navigation URLs are not public contracts.

`createComplianceCaseService` exposes optimistic-concurrency and idempotent Case commands. Case
revisions preserve canonical Type, Severity, Lifecycle, owner, UTC/IANA deadline, stable related
scope snapshots and Requirement Versions. Containment records only owner-issued operational Action
outcomes; Regulatory Notification records never infer submission. Critical closure requires current,
complete and independent gate evidence. Canonical Section 40.29 Case and Notification Events are
registered in the Event Catalog; no generic transition or unaccepted event is published.

`createComplianceInspectionActionService` adds Case-versioned, append-only Inspection corrections,
stable Findings and Case-owned Corrective Actions. Checklist and Requirement Versions remain pinned;
Critical Findings emit explicit escalation; Hard Requirements cannot be accepted as risk; completion
does not imply Verification; and high-risk Actions require a distinct verifier. Operational work and
Evidence bytes remain outside the contract.

`createComplianceMonitoringService` appends exact-decimal Temperature Readings, controlled Manual
corrections, Temperature Excursion revisions and Cleaning/Sanitation revisions. Missing/Device Fault
never fabricates a measurement; Excursions do not decide Inventory disposition; Cleaning completion
does not imply Verification; and out-of-requirement chemical snapshots require Safety Review.

`createComplianceQualificationService` preserves immutable Permit and Employee Qualification
records plus Compliance assessments of Procurement-owned Supplier and Device-owned Device source
records. It records exact owner versions, expiry and Verification facts; requests Renewal Tasks and
eligibility changes only through explicit ports; and never mutates Identity, Membership, Supplier,
Offering, Purchase Order, Device routing or Store operation.

`createComplianceAllergenIncidentService` pins Catalog/Recipe-owned allergen source versions and
exact configuration digests without creating an absence claim. It appends controlled Review and
restricted Food Safety Incident revisions, validates exact Case scope, emits only committed failure
or report facts, and requests Catalog availability / Ordering-Payment admission blocks solely
through an idempotent owner port. Medical narrative, Customer notes and Payment facts never enter
the public contract.

`createComplianceTraceabilityService` runs bounded forward/backward queries against an approved
owner/BI projection and pins Run ID, exact seed/scope/period, source-as-of and projection version.
The graph accepts only canonical owner/reference relationships; incomplete segments are explicit
Gaps and cannot claim completeness. Customer nodes remain Restricted. Pin, restricted Case export
and Recall opening are separately authorized/audited owner-port operations that return only opaque
Evidence Set, artifact and Recall outcome references; the service never copies the transaction
chain, exports bytes/URLs or implements Recall lifecycle.

## Dependencies

- Allowed synchronous dependencies: `@bop/audit` safe Audit validation, `@bop/permission` Tenant
  Context revalidation and public `@bop/tenant` contract types.
- Allowed asynchronous dependencies: owner-authorized summary snapshots through the source port.
- Forbidden dependencies: foreign repositories/tables, private module paths, source Domain writes,
  Provider SDKs and unrestricted content.
- Failure/degradation behavior: deny or malformed/unavailable/cross-scope source fails closed;
  partial and stale snapshots remain explicit and never imply compliance.

## Data ownership and lifecycle

- Owned objects: rebuildable Compliance Dashboard query policy, Compliance Case Aggregate contract,
  immutable Inspection/Finding/Corrective Action, Temperature/Excursion, Cleaning, Permit,
  Employee Qualification, Allergen Review and Food Safety Incident revisions, Supplier/Device
  assessment records, immutable restricted Trace Evidence Sets, Containment outcomes and Regulatory
  Notification records. Trace chain facts remain owned by their source Domains/projection.
- Write owner: `@rms/compliance-food-safety`; business outcomes remain owner-issued references.
- Scope: Tenant plus Brand and optional Store, revalidated at query execution.
- Money: not accepted.
- Time: canonical UTC instants; due state is derived at the pinned observation instant.
- Concurrency/idempotency/audit: exact expected aggregate version, intent digest and atomic Audit;
  no history rewrite.
- Classification: internal opaque references/codes and aggregate counts only; no PII, health,
  allergy, incident narrative, credentials or raw Evidence.
- Correction: rebuild from corrected owner summaries; never edit a source fact.

## Persistence and eventing

Persistence is not implemented because Section 50 grants no Compliance schema or migration
namespace. Section 40.29 authorizes the bounded Case, Finding, Corrective Action, Temperature,
Cleaning, License, Employee Qualification, Allergen Control, Food Safety Incident and Regulatory
Notification Events registered through WP-2175; runtime publication remains inactive until an
accepted durable adapter exists. WP-2176 adds no Event; Trace queries and export/Recall requests use
explicit ports.

## Security and privacy

Authorization, purpose and exact scope are mandatory. Payloads are exact-field parsed, bounded and
reject extra/restricted fields, duplicate references, invented topology, hidden Gaps, future
observations, cross-scope facts and impossible Evidence counts. Customer source identity and
artifact bytes/URLs never enter the Trace UI contract. Logs, URLs, analytics and fixtures may not
contain restricted facts; tests use synthetic opaque identifiers only.

## Operations

- Configuration: none.
- Health/readiness: runtime adapters remain unconfigured and therefore unavailable.
- Logs/metrics/traces: stable outcome codes only; references are not metric dimensions.
- Failure/recovery/disable: fail closed or display explicit stale/partial/unavailable state.

## Development and verification

```bash
pnpm --filter @rms/compliance-food-safety test
pnpm --filter @rms/compliance-food-safety typecheck
pnpm verify
```

Tests cover authorization, scope isolation, exact parsing, stable severity/due sorting, Evidence
math, Case lifecycle/concurrency/idempotency, append-only Inspection correction, Finding escalation,
Corrective Action completion/independent Verification, independent closure, owning-Domain
containment, Temperature correction/offline semantics, Excursion disposition boundaries, Cleaning
chemical/verification controls, Permit/Qualification owner boundaries, expiry, renewal and
eligibility outcomes, Allergen source invalidation / no-absence semantics, restricted Incident
Case binding and owner block outcomes, canonical forward/backward Trace topology, explicit Gaps,
restricted Customer nodes, Evidence pin/export and Recall delegation, Regulatory Notification,
filtering, stale/partial presentation and restricted-field rejection.

## Decisions and follow-up

- Authority: Handoff Sections 40, 46.6, 48.5, 50 and 88.16.
- External Evidence: real Cases, Requirements, licenses, Findings, actions, Evidence, deadlines,
  regulators and legal interpretations remain unavailable and unclaimed.
- Revisit trigger: a later accepted WP authorizes Compliance persistence/runtime adapters.
- Next allowed Work Package: WP-2177.
