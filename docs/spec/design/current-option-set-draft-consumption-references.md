# Current Option Draft consumption reference provenance

[WP-2421 milestone58](../work-packages/WP-2421.md) extends the
[current full Draft source](./current-option-set-draft-graph.md) with complete
owning Inventory configuration metadata and Recipe stored-reference metadata.
It covers exact current consumption pins in the actual Draft; full reference
qualification and normal publication remain separate work.

## Version identity decision

Accepted Option content retains one UUID versionReference for a consumption
reference. Inventory owns numeric item revisions and a unique UUID configuration
operation for each revision. An Inventory consumption pin therefore identifies
that owning operation UUID. The owner verifies its exact item, associated numeric
revision and current operation. No numeric revision is cast to a UUID. Recipe
consumption pins identify actual RecipeVersion UUIDs and must match the exact
owning Recipe and its current version.

This resolves previously unspecified software identity without changing the
stored content shape. Old mismatched pins remain unavailable; there is no inferred
replacement or automatic migration. Current metadata identity does not authorize
consumption, validate quantities or prove publication eligibility.

## Owning assessments

The additive Inventory and Recipe public functions accept closed minimal pins
and complete owning snapshots parsed by their existing public parsers. Pins
contain Brand, OptionSet/version, three actual content digests and each retained
Option's consumption owner/version reference. They reject extra fields,
accessors, malformed identifiers, duplicate Option pins, over100 pins, stale
sources and activation earlier than the current assessment. Disabled and Archived
Options remain included rather than silently dropping their references.

Inventory distinguishes missing item, missing version, wrong parent, stale
version and inactive item. Only the exact current Active configuration metadata
passes. Recipe distinguishes missing Recipe/version, wrong parent, stale version,
unpublished version and periods excluding observation or proposed activation.
Its effective period is half-open; only current Published metadata covering both
instants passes. Empty pin lists still require complete current owner acquisition
and current field authority.

Results are immutable, minimal, scoped and digested, with owning source digest,
generation, observation and original operation/intent pins. PassForMetadata means
only these checks passed. Quantity, unit conversion, current Binding/SKU/scope,
reference eligibility and overall eligibility remain NotEvaluated. Stored Active
or Published metadata does not replace these omitted current facts.

## Current source composition

The API directly constructs the existing actual full Draft source and both
owning PostgreSQL source stores. It accepts only closed original graphRequest,
Inventory request, Recipe request and activationAt; it accepts no client graph,
owner snapshot or readiness flag. Server Tenant, Brand and User identity are
fixed. Both owner requests must match that context and the same original
operation and intent digest, using the accepted owning purpose codes.

Inventory then Recipe source holders run on a captured query facade bound to the
original caller transaction. Authority receives that original transaction and
holds each owner's complete declared fields and permissions. Both holders run
even when their pin list is empty. The actual Draft supplies all pins; the API
performs no foreign private-table reads or domain classification rules.

The exclusive deadline is the earliest original Draft lease and each complete
owner observation plus five seconds. The original root window remains at most30
seconds. Clock and authority methods are captured; replaced queries, backward
time, expiry, caught recursive entry, repeated/missing callbacks and changed
completion identity refuse admission. Reading sources cannot renew the window.
After tentative work Recipe rechecks authority and generation, then Inventory,
then the enclosing Draft source rechecks current fields and root identity.
Refusal requires the caller's outer transaction to roll back.

The result contains minimal owning assessments and digests, Tenant/Brand,
original/current root observations and exclusive deadline. Full content,
quantity bodies, units, pricing and source prose are absent. It remains
Incomplete for publishValidation and NotEvaluated for eligibility.

## Evidence and remaining work

Focused tests cover current and missing/stale/wrong-parent metadata, closed
parsing, freshness and half-open periods. API tests use explicitly synthetic
owner protocols for source ordering, exact transaction authority, clocks,
permissions, generation/root drift, captured methods and poisoned recursion.

The existing isolated Recipe SQL case retains all old assertions. Its additive
consumer creates an actual complete Option Draft through the owning writer and
acquires actual Catalog, Inventory and Recipe sources. Inventory revisions and
Recipe metadata are controlled synthetic fixtures. Recipe's immutable old version
remains Draft; a new Published metadata row is appended and the current root
pointer is advanced. This is metadata setup, not an owning Recipe publication
workflow or evidence of real business qualification.

Positive reads preserve nineteen table snapshots. Eight separate late probes
perform a real tentative Catalog draft/Audit/Outbox write before denying root,
Inventory or Recipe fields, expiring the window, moving time backward, changing
the root revision or changing either owner generation by appending an Inventory
revision/operation or updating Recipe root metadata. Each probe separately
asserts completion of the tentative write and controlled mutation before the
final refusal. Exact Catalog, Inventory, Recipe, Audit, audit-chain and Outbox
state is restored by outer rollback. Actual generation triggers and source
barriers execute locally; User authority, identities and metadata are synthetic.

Complete units/conversions/quantity constraints, per-Binding/SKU/scope
applicability, current Media and Published child resolution, all five
[Option seal checks](./option-set-content-seal-writer.md), complete Product
validation and ordinary editing/review/release pages remain repository work.
[Recorded independent approval](./current-option-set-draft-approval.md) stays a
separate current source. System activation must reacquire every required source
and authorization. This milestone provides no normal HTTP/browser evidence,
live IAM, Store management, UAT, formal release or project completion.
