# Current Option Draft Pricing reference metadata

[WP-2421 milestone55](../work-packages/WP-2421.md) composes the
[current owning full Draft graph](./current-option-set-draft-graph.md) with the
existing Pricing complete configuration source. It reuses the accepted
PricingConfigurationReferenceV1 generation-backed shared barrier, complete
Price Book/Option Price/Promotion reads and final field/generation checks.
A new single-family source, table lock or static Pricing mapping is unnecessary.

## Ownership and request

Server options capture Tenant, Brand, User Actor, monotonic clock, Catalog current
read authority and all four Pricing current scope/field authorities. The
closed request supplies graphRequest, pricingRequest and activationAt. The
first pins the expected actual current Draft/version/revision/three digests and
finite original observation window. The second is the accepted opaque Catalog
lifecycle Pricing request: Brand, Actor, operation and intent digest/purpose.
Foreign Brand/Actor, accessors, client graph/mapping/Ready and stale selectors refuse.

The API derives Option/pricing pins from actual full content, retaining every
referenced Option, including disabled or Archived entries. An unresolved trigger
still refuses through the existing current graph source. It binds the Pricing
source to a captured facade of the same outer SQL connection. Current authorities
receive the original caller transaction identity; the owning Pricing repository
alone queries Pricing private assets. Complete Pricing field permissions remain
required even when no Draft pricing references exist.

## Metadata classification

Pricing's additive public match function parses the complete owning source and
exact minimal current-root pins. It distinguishes missing rule/version, wrong
Option identity, historical version, non-Published lifecycle, inactive observed
period and proposed activation outside the half-open effective interval.
Only an exact matching current head with stored Published/effective metadata
produces CurrentPublishedMetadata. Any other match status produces HardError.
Every pinned referenced Option is checked, irrespective of a feasible selection.

PassForMetadata is limited to those facts. The source stores per-Binding/SKU/
scope/channel/order type identities; a Set-level rule pin cannot establish their
actual Product Binding membership, amount correctness, scope applicability,
Tax, current admission, approved Pricing governance or financial/sale eligibility.
Those remain NotEvaluated. A stored Published label or complete rows do not
supply the missing full qualification. Empty pins still acquire the owning
complete source and its permissions; they do not waive the other seal checks.

## Continuity and output

The original Draft observation/window and Pricing operation/intent remain fixed.
The result expires at the earliest original root/read lease or the oldest
complete Pricing source observation plus five seconds, exclusive. Captured
clock/query methods, monotonic samples, one callback/completed result identity,
recursion poisoning and final deadline checks remain mandatory. Proposed
activation must be at or after trusted assessment time; it is never silently
retimed. Future actual activation must acquire all sources again.

The inner Pricing holder rechecks every family field permission and its actual
source generation after tentative work. The outer Catalog source then rereads
current root provenance/digests. Either owner changing within the caller's own
transaction refuses; a shared barrier does not make own writes invisible.
The caller must abort the outer UoW on refusal and scope provider/transaction
facades to one authorized request. Results freeze server Tenant/Brand, minimal
assessment/pins/statuses and source/intent/observation digests; no full graph,
prose, amounts, Media data, logs, URLs or normal endpoint is introduced.

## Evidence boundary

Focused match and API tests use synthetic sources/holder protocols. An additive
block in the existing complete Pricing SQL scenario creates an actual full Option
Draft through its owning writer and seeds controlled Pricing metadata through
existing isolated fixtures. It then acquires actual current Draft and complete
Pricing sources together, verifies metadata/current pins and no-write state,
and reaches six late refusal probes. Controlled root mutation and relevant
Pricing root updates SELECT-observe source-generation change before refusal;
outer rollback restores exact twelve-table Catalog/Pricing/Audit-chain/Outbox
state. Final root-field probes omit Pricing drift so one failure cannot mask
another owner check. Existing SQL assertions remain unchanged.

SQL source storage, root provenance, generation/barriers and rollback are actual
local execution. Actors, field holders, referenced business facts and stored
Published Pricing seed are explicitly synthetic. This does not establish actual
Pricing approval/applicability, qualified full Option/Product publication,
ordinary HTTP/browser UI, Store activation, production IAM/UAT or project completion.
No migration, production ACL, Event, Module dependency or runtime route changes.
