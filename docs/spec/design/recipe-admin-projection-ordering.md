# Recipe admin projection ordering proposal

Status: **Source reconciled; implementation design remains open**. WP-2402 scope: repository source
inventory and internal-reader evidence only. The Recipe List / Editor feature is assigned to WP-2105
by Handoff Section 88.25 and the Screen Registry; this note does not authorize that feature's
implementation under WP-2402.

## Recovered Authority

The Owner-authorized source sync at `03ad510` supplies the complete Handoff in this
checkout. Sections50.18 and50.20 already require source-table/Event-checkpoint
rebuild and Shadow Table / Version Switch. Section88.22 specifies Brand-scoped
Recipe/Ingredient versions plus authorized Inventory/Supplier feeds, a30second
freshness target, urgent allergen invalidation and graph rebuild. Responses must
include projection version, as-of time, scope and partial/stale indicators.

The earlier request to approve the general full-generation/atomic-switch direction
is withdrawn: it is already specified, not a new product decision. The remaining
work is technical reconciliation of the existing numeric checkpoint with actual
source coverage, followed by a compatible implementation and tests. Do not treat
uploading the source as approval of every self-reported baseline or of this proposal's
particular schema representation. Later accepted decisions retain precedence.

## Confirmed Source Mismatch

Migration `1250_001_create_recipe_management.sql` stores one active projection
generation per Brand. Generation and checkpoint both require a nonnegative
`source_event_sequence`. Recipe rows separately retain `aggregate_version`,
`recipe_version_id` and `snapshot_digest`.

The current Recipe event payload in `packages/contracts/events/catalog.ts` contains
Recipe/version references, aggregate version, lifecycle, digest and occurrence time.
The Eventing envelope contains event identity and aggregate version, but no ordered
Brand-wide source sequence. The registered `recipe.admin-projection` consumer has
no implemented producer of that sequence in the inspected apps/packages sources.
This is not evidence that a sequence can never exist in an external source.

The shared outbox migration `migrations/0000-platform/0000_010_create_outbox_event.sql`
confirms the distinction: its persisted ordering fields are per-aggregate version and
`occurred_at` / `recorded_at`; the publisher index is `(brand_id, available_at,
recorded_at, event_id)`. `recorded_at` is assigned with `statement_timestamp()` before
the transaction commits, so this schema does not expose a commit-ordered Brand-wide
watermark. Publisher availability order is not projection source order. Handoff
Section50.18 also says the event log is not the sole source for every Aggregate and
that projection rebuild prefers owner business tables plus an Event checkpoint. Do not
substitute timestamps, UUID order or the publisher index for a source checkpoint.

The existing Catalog published-menu projection is scoped to one Menu and compares
that Menu's aggregate versions. Copying that comparison to a Brand-wide Recipe
generation would be incorrect. For example, accepting Recipe A/version20 must not
discard a later received Recipe B/version2. Neither occurrence time nor UUID order
establishes transaction commit order or complete source coverage.

## Current repository source map

The normal Merchant pages still use `unavailableRecipeClient`; the source audit finds
no Recipe list/editor API route or authorized query composition. The internal admin
reader and its isolated PostgreSQL test prove access to an existing generation only.
They do not supply the projection builder or public query response.

| Required view facts                                               | Current owner evidence in this checkout                                                                                                                         | Boundary before an admin response can claim completeness                                                                                                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recipe identity, stable code, lifecycle, yield, effective version | Recipe aggregate/version snapshots and the admin row contain these bounded fields                                                                               | The row is generation-scoped and may be stale; the authenticated Brand query must calculate freshness and expose source/version coverage                                                                 |
| Ingredient quantity/loss, units, preparation, substitution graph  | Recipe snapshots and preparation-content owner records                                                                                                          | The current admin row has only yield/usage text; the reader does not reconstruct the version-pinned graph or complete editor details                                                                     |
| Inventory mapping and usage                                       | Recipe facts port validates references/mapping and returns booleans plus Recipe graph snapshots; no current Inventory/Supplier feed adapter is composed         | A boolean cannot identify the covered source/version or prove the feed is current; use an approved owner query/feed contract, never Inventory private SQL                                                |
| Cost                                                              | Recipe domain has exact minor-unit calculation; admin row stores integer `cost_minor`                                                                           | The row has no currency, valuation/source reference, or source version. Do not label it money or assume CAD; no current public cost input/coverage adapter is composed                                   |
| Allergen registry/evidence                                        | Catalog exports a pinned allergen-review facts reader used by API review composition                                                                            | It is a Catalog-owned persistence adapter for a specific review flow, not a Recipe public read contract. Recipe needs authorized source versions and urgent invalidation without querying Catalog tables |
| Product/SKU usage, supplier evidence, reviewer/history summaries  | Screen Registry and Handoff require these fields; current projection has a generic usage summary but the Recipe facts port carries none of these source records | No current builder source wiring, public coverage versions, or field-level permission-trimmed DTO is present                                                                                             |
| Freshness, partial state, Brand/Store context                     | Generation/checkpoint provide projection version, build/checkpoint times and the same numeric sequence                                                          | This does not encode covered per-object/feed versions, partial coverage, as-of authorization scope, or stale safety invalidation                                                                         |

The table reflects repository source availability, not a claim that external owner feeds
do not exist. Handoff Sections 87.11.2 and 88.22 remain binding: supplier, ingredient,
Recipe, substitution and preparation changes invalidate affected safety/effectiveness;
unknown required evidence blocks publication. The Recipe facts port currently returns
`referencesValid`, `mappingsComplete`, `allergenEvidenceVerified`,
`costEvidenceVerified` and `graphSnapshots`; those results are validation outputs, not a
read-model source manifest. An owning Application contract must provide the facts and
version bindings before a complete public view can be composed.

## Proposed Resolution

Keep per-Recipe source identity/version/digest as the stale/replay fence. Use the
existing Eventing transactional inbox for duplicate event identity; never infer
completion merely from a maximum version across unrelated Recipes.

For a complete Brand generation, explicitly record the covered Recipe source
versions and the generation's publication revision. Publication revision is a
projection-owned concurrency token, **not** a source event sequence and not proof
that the source is current. Resolve the exact schema extension and compatibility
with the existing sequence columns before implementation; do not repurpose them
silently or fill them with timestamps, arbitrary counters or synthetic zeroes.

An owning transaction must serialize publication, validate authorized source
coverage, build the complete replacement rows, then switch the checkpoint
atomically. Readers keep the previous complete generation during construction.
Failure before commit leaves the prior checkpoint unchanged. Replays must not
create contradictory source bindings or duplicate effects. Rebuild and event
consumption must share the same source-ordering rules.

Alternative: retain the current sequence contract if an accepted source provides
a durable, complete, Brand-wide monotonic sequence. Identify that source, its
transaction/authorization contract and replay semantics first. Audit chain order,
database internals and foreign private tables are not substitute public sources.

## Decision and Acceptance Boundary

### External Dependencies and Safe Views

The Owner approved the design-review corrections on 2026-09-22. A Recipe-only
version vector is insufficient. Each generation must bind the authorized Inventory,
Supplier, allergen evidence, preparation, substitution and usage feed versions as
well as Recipe versions. Section87.11.2 requires supplier/ingredient/Recipe/
substitution/preparation changes to invalidate affected verification and availability;
the ordinary30second projection target is not a grace period for known safety changes.
Source identity/version/digest comparisons are within one owning source, never
across unrelated aggregates. The current five Recipe lifecycle subscriptions do not
prove external-source coverage; resolve the actual public feed/invalidation contract
before connecting the builder. No foreign private tables may fill that gap.

Publication must compare the captured dependency versions again under the owning
publication protocol, reject changed/missing mandatory evidence and preserve the
previous complete generation on failure. A retained generation may be shown stale,
but must not retain an effective Verified safety claim after known invalidation.
Same-version/different-digest evidence is an integrity error, not a replay. Recovery
must rebuild the dependency graph and not rely solely on Recipe event delivery.

The Merchant view boundary uses a distinct version2 response shape, not a silent
change to the persisted version1 generation. It requires Tenant/Brand scope,
projection version, as-of, freshness and partial state, with explicit source coverage.
Available summaries bind a named source/version; unavailable and permission-hidden
values carry no data or source identifiers. Cost includes exact amountMinor and
currencyCode with its calculation source version. Old numeric cost rows do not
establish currency or cost evidence and must not be upgraded by assuming CAD.
Each view source version identifies an authorized coverage snapshot, not the maximum
aggregate version in that Domain. The builder must retain its per-object dependencies
behind that snapshot; the client response is not itself an Event checkpoint or proof
of complete source coverage. Persisted coverage representation and the owning
application query DTO still need implementation before an HTTP adapter is connected.
The authorized server query remains responsible for session scope, field permissions,
source classification and freshness decisions. Client parsing is defense in depth,
not authorization or a live invalidation subscriber. The normal route remains
unconnected until builder/query/API integration has independent evidence.

The recovered authority resolves the general rebuild/switch direction. Before
builder persistence work, resolve the source-checkpoint representation against that
authority and the existing schema; seek a new decision only for an actual policy or
ownership change, not ordinary implementation detail. This technical plan does not
activate Phase2, approve production deployment, supply display,
usage, cost or allergen facts, or authorize cross-domain private reads.

Required tests after resolution: interleaved updates to multiple Recipes, out-of-order
and duplicate delivery, same-version/different-digest rejection, concurrent rebuild
and event consumption, rollback before checkpoint switch, retained prior generation,
cross-Brand denial, incomplete source coverage and recovery after interruption.
Use synthetic persisted sources in the existing Recipe PostgreSQL acceptance.

The internal `createPostgresRecipeAdminQueryStore` has isolated PostgreSQL evidence
for the current schema. That proves reading and metadata consistency, not a resolved
sequence producer, complete builder or current merchant workspace.

## WP-2402 repository source inventory (2026-09-25)

Scope clarification (2026-09-27): this heading records the source audit performed during WP-2402; it
does not transfer RECIPE-LIST / RECIPE-EDITOR ownership from WP-2105. The current checkout still
mounts both normal routes with `unavailableRecipeClient`, although WP-2105 describes its local
implementation as complete. Reconcile that discrepancy in the owning WP against its acceptance
contract before wiring the route. The missing Recipe-authorized feed coverage and checkpoint-order
contract documented below are not resolved by the internal single-Recipe reader. Until the owning
WP closes them, WP-2402 must not advertise the normal Recipe pages as connected or infer Fresh,
complete allergen, cost, usage, Supplier, or Inventory data.

Selection: identify which source adapters can actually feed the version-2 Merchant view without
crossing Domain ownership. Inspect the Recipe facts port and active consumers, Inventory/Supplier/
Catalog owner exports, API composition, and Event Catalog/consumer registration. This is a bounded
source audit; no adapter, migration, permission, projection row or runtime route is changed.
Documentation-only verification: verify these exact references, Prettier and `git diff --check`.

Result: `packages/rms/recipe/src/application/ports/recipe-ports.ts` defines
`RecipePorts.facts.validate`, which returns reference/mapping/allergen/cost booleans and
`graphSnapshots`, but no source identity/version, coverage time or invalidation revision. The Recipe
admin reader remains an internal single-Recipe row reader. `packages/rms/inventory/src/index.ts`
exports `createPostgresInventoryItemStore`, but the inspected API use in
`apps/api/src/customer-submission-inventory-finalizer.ts` is for Customer Submission finalization;
it is not a Recipe-scoped, versioned feed contract. Procurement's
`packages/rms/procurement/src/application/ports/supplier-ports.ts` declares a Supplier projection
port, but no API or Recipe composition supplies its coverage/version. Catalog's
`packages/rms/catalog/src/infrastructure/persistence/allergen-review-facts-store.ts` is specifically
for Menu review and is not a Recipe feed. `packages/contracts/events/consumer-compatibility.ts`
registers Recipe lifecycle consumers, but there is no implemented `recipe.admin-projection` consumer
or producer of a commit-ordered Brand-wide source sequence. The shared outbox schema in
`migrations/0000-platform/0000_010_create_outbox_event.sql` exposes per-Aggregate versions and
recorded/availability times, which do not prove Brand-wide commit order.

This narrows the repository gap: reusable owner operations exist, but the required Recipe-authorized,
versioned Inventory/Supplier/Allergen feed contracts and their invalidation bindings do not. Wiring the
owner repositories directly would not establish freshness, source coverage, or the accepted
`recipe_admin_v1` view. The complete builder, authorized query, and normal Merchant route therefore
remain open; this is an implementation/source-contract gap, not an AI quota, Docker, or test-runner
blocker. Proceed only after the source-version and ordering contract is defined within an accepted WP;
real Supplier, Inventory, cost and professional-review facts remain separate external evidence.
