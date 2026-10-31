# Current Validate candidate Recipe membership

WP-2421 milestone79 connects the actual Product publication Validate candidate to
Recipe's existing public stored membership/period assessment under accepted
Handoff29.1,29.2,29.6 and the existing50/56/87/92 owning transaction rules.
It complements the [LifecycleReview composition](./current-product-recipe-binding-scope.md)
and [complete V2 measurements](./current-product-recipe-measurements.md).

Catalog's additive public `deriveCatalogProductCandidateRecipeTarget` binds the
original Validate command, expected aggregate/version and exact complete content
identity before deriving all Draft SKUs and Option binding enabled options and
inclusion/exclusion sets. Collections are sorted, copied and frozen. There is no
caller-selected SKU, static mapping or fabricated lifecycle transition. This pure
function establishes membership binding only, never current source authority.

The API directly constructs `createPostgresProductValidationCandidateSource` and
`createPostgresRecipeReferenceSourceStore` inside the caller's original transaction.
The candidate requires current `catalog.product.validate`, full candidate fields
and complete editor content; Recipe retains full Brand `recipe.manage` and its
existing reference fields/barrier. The accepted Recipe source read-purpose string
contains Lifecycle but is a source-read contract, pinned here to the original
Validate digest and operation. It does not grant lifecycle mutation permission.

The guarded query facade checks before and after in-flight queries, preserves
rows/rowCount and never replaces the caller's query identity. Every authority
receives the original transaction; optional Category assignment authority is
bridged as well. Captured methods and a monotonic clock, poisoned recursive or
failed admission, exactly one consumer and result identity remain mandatory. The
original candidate30-second window is narrowed to Recipe observation plus five
seconds exclusively. Final candidate observations cannot renew that window.

After consumer work the composition explicitly rereads the same original Validate
candidate under its owner; same aggregate/digests/intent are required. The owning
Recipe holder then rechecks current permission/generation, followed by Catalog's
final permission checks. A held fence by itself does not detect caller-UoW writes.
The command's original effectiveFrom is passed unchanged as activation. The
existing Recipe assessment rejects past activation; immediate/scheduler admission
timing needs its separate owning decision and cannot be repaired by replacing an
original instant with now.

Outputs expose minimal candidate identity and the Recipe subset assessment. Empty
references do not establish a unique executable Recipe. Stored Store references
are not topology facts. Store/Brand override policy, unique resolution, full V2
source/unit/demand qualification, complete publication checks, approval/release
management and ordinary HTTP/browser remain separate implementation work.

Tests exercise actual owning binders/Recipe assessment with synthetic holder
protocols. The existing isolated Product publication SQL case derives the new
target inside its physical full current candidate holder and rejects changed
expected version. That proves the Product source/target portion; it is not combined
Product+Recipe SQL, configured HTTP, UI, UAT or external release evidence.

Milestone80 adds actual joined Product/Recipe SQL acceptance using the same
original transaction, both public owning readers and the exact full Validate
command target. Controlled Published Recipe metadata and Actor/field authorities
are synthetic, as in the existing61 reader acceptance; no native publication
workflow is inferred from fixture status. An independent different-Product owning
creation arms each late refusal with actual Audit/Outbox. Full table snapshots
cover Catalog, Recipe, Audit and Eventing, including source/projection producers.
Recipe current-field denial and generation, Catalog denial and target drift,
exclusive expiry/query identity and past activation are selected. Recipe source
mutation is solely a controlled negative test, never an allowed production callback
operation. Minimal role columns cannot read Recipe yield/private preparation.
Executable results are recorded in WP-2421 and the overnight summary after running.

Actual80 acceptance passes with current owning readers, six late refusals and a
past-activation refusal. Positive observations are read-only; all negative late
probes first create the independent Product, Audit and Outbox through the native
creation store, then require exact all-table rollback. Synthetic role proof reads
are limited to Audit target and Outbox aggregate identifiers, not payloads.

The actual nested Recipe holder sanitizes foreign callback errors. The API now
retains only an explicit Catalog PermissionDenied thrown by the trusted current
candidate authority in this invocation, and restores that already established
error after inner sanitization. Consumer-manufactured permission errors cannot be
recovered this way. Failed-UoW poisoning remains mandatory. The synthetic holder
regression mirrors actual owner remapping; the isolated SQL confirms the real
late authority denial after native tentative writes. Neither change grants access
or converts Unavailable observations into eligible publication.
