# Current published Recipe dependency graph

[WP-2421](../work-packages/WP-2421.md) milestone66 implements accepted Section29.3
using the [complete owning Recipe publication source](current-product-published-recipe-content.md).
Current root selectors are original server-derived Recipe/version references. Every
Subrecipe edge comes from an actual complete stored snapshot, never a caller graph.

The source reads current owning roots and physical exact version snapshots under
`recipe.manage`, FullBrandScope, complete Recipe/Ingredient/Step/publication/review
and pinned-version/yield fields. It uses the existing Recipe shared source barrier,
read committed isolation, original caller transaction, Tenant/Brand/Actor/purpose/
operation/intent, observation and intended activation. Each exact version must have
one actual owning Publish operation and matching independent Cost/FoodSafety stored
review rows. A seeded Published label alone cannot supply this evidence.

Selected roots must remain their exact current Published version. A pinned child
may refer to an older Published version; a newer current child root never replaces
that pin. Current root version/aggregate/lifecycle are retained as a receipt and
reread. An Archived or Invalidated current child root refuses conservatively.
The existing lifecycle writer cannot create a new Draft from a Published root;
the synthetic historical-child protocol test establishes reader semantics, not
an observed supported writer transition or normal editing flow. That lifecycle
continuation remains repository implementation work.

The graph is bounded to256 versions,4096 requirements and depth16. Every edge
must match its exact Recipe/version and Brand, reference a Published version with
positive batch yield and a compatible yield dimension, and be acyclic. Roots can
share the same child. Whole snapshots, publication/review evidence and current
root receipts are reread after work. Any missing proof, expiry, permission loss,
changed root, graph, query, callback identity or poisoned recursive invocation
refuses and requires rollback. The original exclusive five-second lease may be
shortened by a child effective end and is never renewed by graph traversal.

`PassForPinnedPublishedSubrecipes` is topology and pinned publication evidence.
Inventory references, units/conversions and full publishing validation remain
separate and unavailable. This source does not assess physical stock, cost or
allergen correctness, Preparation/Modifier/Kitchen capability, real Store entitlement
or future activation. The owning System must rerun current sources and permissions
at actual activation.

## Recipe measurement provenance gap

Accepted Section29.4 requires explicit compatible conversion rules. Existing
`IngredientRequirement` stores quantityMicrounits, unitDimension and numerical
conversion numerator/denominator, but no usage unit code or exact versioned
Inventory conversion reference. A ratio of1 cannot prove an Inventory base unit;
a dimension map or an Option-shaped DTO cannot supply that missing authority.

We own the software design and implementation of explicit usage unit/conversion
provenance for a new Recipe content version. Existing immutable snapshots and
historical consumption must remain readable and unchanged; legacy unproven
measurements cannot become current publishing qualification. A future bounded
milestone must specify the new versioned representation, owning read/write and
review bindings, preserved history, current effective conversion checks and
consumer/migration acceptance before enabling units. This is a repository design
and implementation gap, not missing user Figma/rules or real external facts.

Only internal scoped content enters this source. No new HTTP route, log, analytics,
production permission or persisted sensitive capture is added. Protocol tests use
synthetic snapshots. Actual isolated SQL creates and publishes a parent and child
through the owning RecipeService with stored independent reviews and Audit/Outbox.
Review history mutation is physically prevented by the existing owning DO INSTEAD
NOTHING rule; its zero-row update and unchanged digest are checked, followed by
intentional refusal and rollback. This is append-only protection, not an observed
late review-content mutation. Actual selected results remain recorded in the WP.
Neither establishes complete normal Product release, live IAM, UAT or production.
