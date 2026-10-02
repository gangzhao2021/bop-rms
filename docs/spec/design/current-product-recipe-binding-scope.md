# Current Product Recipe Binding and SKU scope checks

[WP-2421](../work-packages/WP-2421.md) milestone61 implements current
stored membership and period checks under accepted Handoff29.1,29.2 and29.6.
It extends the existing owning Recipe history-aware matching without changing
that earlier public contract or treating history as current eligibility.

## Owning semantics

Catalog supplies its actual current Product Draft SKU/Binding graph through
`createPostgresProductPricingBindingSourceStore`. Recipe supplies complete stored
metadata through `createPostgresRecipeReferenceSourceStore`. The API transports
only the validated individual current graph to Recipe's public assessment;
caller selectors and lifecycle intent do not supply graph data or authority.

Recipe checks exact current Published version, SKU inclusion/exclusion and
Binding membership, enabled Options and both current and intended activation
half-open periods. Binding and version periods must cover both instants. Current
modifier candidates are the latest owning rule revisions; an old Published
revision cannot hide a newer Archived/Draft rule. Complete history remains in
the source fingerprint. Unresolved Binding/Option/SKU relationships are explicit
gaps; stale/unpublished/inactive references remain visible as review outcomes.

`PassForStoredMembershipAndPeriods` covers this mechanical assessment only.
Empty relevant references do not resolve an executable Recipe. A stored Store
ID does not establish Store existence, current scope, override authorization or
precedence. Store topology, unique Store+SKU+time Recipe resolution, ingredients,
current quantity rules and final eligibility are explicitly `NotEvaluated`.
The existing unavailable history-match profile is preserved. No static mapping,
caller Product DTO or fixed Store fact is a source of selling qualification.

## Original transaction and time

The API fixes server Tenant/Brand/User and captures clock and authority methods.
A closed request contains lifecycle review intent, original observation,
exclusive original deadline (at most30 seconds) and intended activation. It
constructs both public owning stores on a captured facade of the original caller
transaction. Each authority receives the original transaction identity. Source
fields and permissions are checked by the actual owners, including empty graphs.

The effective deadline is the minimum original deadline and each owning source
observation plus5 seconds. Every sample is monotonic and before the exclusive
deadline. There is one assessment callback and exact result identity. Changed
transaction query, callback failure or caught recursion poisons that transaction
identity; the caller must roll back its UoW. Physical pooled clients cannot be
reused as fresh UoW identities without request-specific facades.

Catalog acquires its source fence before Recipe. After the caller's work, the
API re-reads the same current Catalog source while that earlier acquired fence
remains held; exact digest/revision and earliest deadline must remain unchanged.
Recipe performs its existing final generation/permission rechecks. A held barrier
alone cannot hide the caller's own tentative source changes. The wrapper result
has a separate profile/digest covering assessment, Tenant, original observation
and deadline. It writes no Product or Recipe facts and exposes no new HTTP route.

## Evidence and remaining assembly

New owning Recipe tests cover current exact version, half-open periods, SKU
inclusion/exclusion, enabled Option gaps, latest modifier history, unknown Store
and empty source boundaries. Synthetic public-owner API protocol tests cover
actual factory composition, original UoW authority forwarding, final current
read, expiry/backward time, query substitution, exact callback/result, closed
inputs and caught recursion. These tests do not supply production authority.

The existing selected Product category SQL scenario is extended only at its end.
It uses the actual owning Product creation and current SKU graph, minimal actual
Recipe metadata SQL/projection/generation and explicit synthetic Published
Recipe/permission holders. Read permissions exclude yield, Ingredient, prose,
allergen and preparation fields. Controlled tentative root/SKU writes are
rollback probes, not owning Product/Recipe publishing Commands. Existing browser
checks in that scenario remain their original Category evidence; this milestone
adds no ordinary Recipe/Product release UI story.

The final selected actual SQL case passes1/1 (14.06s/15.84s), following a
14.08s/15.88s pass. Separate actual Catalog and Recipe acquisitions precede the
combined current graph assessment. Seven individually armed field/time/Recipe
generation/current target revision/current target graph probes perform a
controlled different-Product tentative write and intended changes before late
refusal; every20-table snapshot restores exactly, including Audit/Outbox. The
first combined acquisition refusal remains recorded without an established
cause; the additions are not described as a diagnosed production fix. Recurrence
requires isolation, not weaker source guards. Full owning Store topology/override/unique resolution,
Recipe Ingredient/Subrecipe/Media/Published child qualification and complete
Product publication admission remain repository implementation work. Ordinary
Product edit/validate/review/immediate/scheduled release/recovery and full Store
capability management still require their normal entry and browser evidence.
No full `pnpm verify`, production IAM, real Store/Provider, UAT or release claim.
