# Current Option Draft review and recorded approval

[WP-2421 milestone57](../work-packages/WP-2421.md) combines the
[actual current Draft and policy assessment](./current-option-set-draft-policy.md)
with the [owning independent approval provenance query](./current-independent-publishing-approval.md).
It prepares a stable review intent and later verifies the recorded approval of
that same intent against current sources. This is an internal public-contract
composition; complete validation and ordinary submit/approve/publish pages remain
separate repository work.

## Stable review intent

Catalog's closed binding contains Tenant, Brand, OptionSet, current Draft version,
aggregate revision, source/content/configuration/graph digests, policy reference,
policy version/content digest, actual current policy publication reference,
original intent digest and proposed activation instant. Canonical parsing and
safe detached data reject accessors, extra fields, malformed identifiers and
invalid revisions. The review digest covers all these pins. Any change requires
new review evidence; a rollback restoring identical policy content still has a
new publication reference and invalidates the previous review binding.

Transient observation, lease and assessment timestamps are excluded from this
stable snapshot. Later current observations can therefore match the same review
intent. They cannot extend its original approval or validation deadlines. The
pure builder establishes identity only; clients cannot qualify a graph by
constructing a valid binding.

## Actual current acquisition

The API directly constructs the existing current Draft/policy source and owning
Publishing store. Preparation derives every content and policy pin from those
current owner reads under the caller's transaction. It accepts the existing
closed original assessment request, not a graph, policy or approval body. A
HardError or Indeterminate assessment may be prepared for reporting, but cannot
consume an approval.

Consumption accepts only that original assessment request, expected review
lifecycle and expected binding digest. Current limited content and mechanical
checks must pass and the newly derived stable digest must match. The owning
independent approval query selects the same OptionSet family, Draft version,
CATALOG_OPTION_SET configuration, CATALOG_OPTION_SET_PUBLICATION purpose and
review digest. Its required recorded validation declarations are fixed by the
server: CURRENT_REFERENCES, PUBLISHING_POLICY, RULE_SATISFIABILITY and SCOPE_TOPOLOGY.
Independent approval is checked separately, avoiding a circular requirement that
pre-approval validation must already have an approval.

These declarations must match exactly, and cannot be weakened by a client. A
recorded Pass is still a recorded declaration, not a fresh execution of all four
checks. The stronger owning query verifies exact original Draft/review/approval
records, independent recorded User identities, intent hashes, Audit provenance,
validation and approval evidence and their original exclusive windows.

## Permission, transaction and recovery fences

Current User authority holds catalog.manage, catalog.option_set.publish, the
publication purpose and all ten declared approval fields before and after work.
It receives the original caller transaction and derived current binding. Source
SQL uses the captured query bound to that same connection. Clock and authority
methods are captured; replacing them cannot substitute a new provider. Backward
clock movement, replaced query methods, caught recursive entry, repeated or
missing callback and changed completion result poison admission for the caller
UoW.

The window starts at the original assessment observation, is at most30 seconds,
and expires exclusively at the earliest original root/policy lease, current
approval field lease or original validation/approval evidence deadline. Reading
again only shortens this window. After tentative work the source holds fields
again, rereads owning approval, compares stable approval provenance and original
expiry, then holds fields again. A shortened post-callback minimum refuses rather than
returning a result carrying the old longer deadline. The enclosing current policy and Draft sources
perform their own final rereads. Any refusal requires the caller to roll back its
outer transaction. Existing original mutation recovery remains owned by its
writer; this read source never issues a new mutation or rewrites original intent.

## Output and remaining admission

The immutable result contains the stable binding, minimal recorded approval or
null for preparation, limited assessment decision, original observation and
exclusive validUntil, plus a digest. Full content, policy prose, Audit payloads,
Media and price data are not emitted. Recorded independence can be Verified;
currentValidation, referenceEligibility and eligibility remain NotEvaluated,
and publishValidation remains Incomplete.

This source does not satisfy all five checks of the
[full Option content seal](./option-set-content-seal-writer.md). Actual complete
Media/Inventory/Recipe and per-binding references, current scope/topology,
current Published child resolution, complete Product content admission and normal
review/approval/release UI remain repository work. System activation must
reacquire current sources and current authorization rather than reuse a stored
approval as complete current qualification. No normal runtime endpoint, DDL,
permission asset, owning private SQL, Event, module dependency or policy decision
is changed here.

## Verification boundary

Focused tests use explicitly synthetic current-owner protocols for stable
identity, drift, limited-check refusal, current authorization, exclusive expiry,
late provenance drift, callback behavior and poisoned recursion. The existing
fourth isolated Publishing SQL case retains every earlier assertion and adds an
actual typed policy allowing the existing synthetic full Draft, then an actual
separate owning content review and independently approved lifecycle. Preparation
and consumption use actual current Catalog and Publishing owner reads on one
transaction. Positive reads preserve all ten table snapshots.

Wrong binding/intent, schema-only validation and same-Actor approval refuse.
Nine separately reached late cases cover approval/read/policy fields, a shortened
post-callback field lease, original
evidence expiry, backward time, approval head, Draft revision and policy head.
Every case first performs a real tentative Publishing/Audit write; the Draft
revision case also performs a controlled current-root update. Refusal rolls back
exact Catalog, Publishing, Audit, Audit-chain and Outbox state. Actors, authority
providers and declared business validation outcomes are synthetic; the owning
storage, current provenance, SQL locks, rereads and rollback execute locally.
This is not normal HTTP/browser evidence, live IAM, full current qualification,
System activation, Store/UAT/formal release or project completion.
