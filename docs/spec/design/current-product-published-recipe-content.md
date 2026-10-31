# Current complete Published Recipe content for Product validation

WP-2421 milestone64 extends the accepted Section29 whole-version Recipe binding
and current owning source rules. It continues
[current Store Recipe policy](current-store-recipe-override-policy.md) and
[current Product binding scope](current-product-recipe-binding-scope.md).
It provides one complete content input, with publishing validation still incomplete.

Recipe owns the snapshot and publication record. Its public
`createCurrentPublishedRecipeContentSource` uses the existing owning QueryStore
and publication parser; no API code queries private Recipe tables. A closed selector
contains the original Recipe source request, observation/deadline, intended activation
and unique exact Recipe/version references. Server composition fixes Tenant, Brand,
Actor, clock and full-field holder. No caller content, review DTO, graph or Ready flag
is accepted as authority. Field access is `recipe.manage`, FullBrandScope, explicitly
covering current version, aggregate revision, complete snapshot, ingredients, steps,
publication evidence and both Cost/FoodSafety review records. The actual IAM holder
must enforce all fields through the original caller UoW; missing authority refuses.

The owner loads each current root/version and validates the complete stored snapshot
using its existing parser. The published root must match the exact selected version,
aggregate revision, Brand, original observation and half-open activation period.
Immutable version metadata is bound to snapshot JSON by existing migration constraints;
an owning precision read also rejects non-millisecond created_at values.
The actual unique Publish operation must resolve through the owning parser to exactly
the same full snapshot. Both stored Cost and FoodSafety rows must precisely match
its independently approved evidence; the author and two reviewers must be distinct.
Missing/duplicate Publish records, seeded Published metadata without actual publication,
missing or inconsistent review rows, stale current roots and invalid periods refuse.

The original transaction must use read committed isolation. Brand RLS context and
the existing shared Recipe reference advisory barrier are held while reading; this
source never starts an independent transaction when composed by Product. Complete
content includes configured ingredient quantities/conversions/loss/cost/allergen
references, preparation steps and their references, yield and period. These are
confidential internal inputs; this milestone adds no HTTP response, UI, logs or
analytics carrying them. The minimal publication operation reference and canonical
evidence digest accompany the content. The resulting digest binds the complete
snapshot, original request, observation/deadline and intended activation.

Every check uses captured clock/query/holder methods, monotonic time and the earliest
exclusive deadline: original deadline, observation plus five seconds and each Recipe
expiry. Activation remains the original intended instant; an immediate activation
is not replaced by a later clock read. Current content must still be valid while
work progresses. Reentrant/swallowed admission, repeated transaction callback,
query replacement or result substitution refuses and poisons the UoW. After work,
the source reauthorizes and rereads the complete current snapshot, actual Publish
operation and both review rows, then reauthorizes again. Any change or elapsed lease
must cause the caller transaction to roll back tentative writes.

`createCurrentProductPublishedRecipeContentSource` composes this reader inside the
actual current Product/Catalog, Store topology, Recipe selection and published Brand
policy source. It deduplicates the resolved whole versions for all selected SKUs,
rejects conflicting versions of a root, keeps the original operation/intent and
shares the original transaction and all existing final source rereads. The inner
Recipe exclusive deadline and monotonic clock also bound the outer final rereads,
so a longer Brand/Store lease cannot extend Recipe freshness. This is server
composition, not a new cross-domain repository or independent sale eligibility rule.
The API protocol tests mock factories explicitly; the actual SQL acceptance covers
the owning Recipe source on an actual existing RecipeService publish fixture.

`childReferences: NotEvaluated`, `publishValidation: Incomplete` and
`eligibility: NotEvaluated` remain explicit. Complete stored content and its historical
publication do not prove current Inventory references, Subrecipe graph/cycles,
Preparation/Modifier/nutrition/cost/Kitchen facts, Store Groups, no-preparation SKU
classification or complete five-check Product admission. Those are required next
repository compositions. Real legal/Store/Provider/Future Trigger evidence remains
unavailable unless supplied by its actual owner. Ordinary editing/review/approval,
immediate/scheduled publish/reschedule/cancel/recovery, System activation and full
Store capability administration remain separate implementation work.

Verification and exact failure history are in [WP-2421](../work-packages/WP-2421.md).
Synthetic field permissions and fixture identities are not live IAM or UAT evidence;
actual isolated SQL reads, owning publish history and rollback are local evidence.
No new migration, production grant, UI, deployment or full-project completion occurs.
