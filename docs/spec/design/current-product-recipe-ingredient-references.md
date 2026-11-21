# Current direct Recipe Ingredient Inventory references

WP-2421 milestone65 continues [complete current Recipe content](current-product-published-recipe-content.md)
and accepted Section29 ingredient/dependency rules. This is one current reference
input; full publishing validation and sale eligibility remain incomplete.

Recipe owns its complete published snapshot and exact requirement pins. Inventory
owns Item roots, numeric versions, lifecycle and UUID operation associations. The
new pure `assessCurrentRecipeIngredientInventoryReferences` accepts a closed minimal
projection of exact Recipe/version/requirement and Item/operation references plus
an already parsed owning Inventory configuration snapshot. A pure assessment supplies
no authority itself. Only server composition acquires current owning sources and
holds all required scopes/fields in the original caller UoW.

For each direct InventoryItem requirement, the operation UUID must be recorded for
that exact Item, resolve to its exact numeric configuration version, match the
current root's operation/version and have Active lifecycle. Missing Item/operation,
wrong Item association, historical configuration or Inactive/Archived lifecycle is
a hard error; no historical or default fallback is permitted. Targets are closed,
bounded to1000 and unique by Recipe version plus requirement. Distinct requirements
may use the same current Item configuration. The digest binds targets, minimal
resolved versions, original request/intent, owning source digest/generation and
observation/assessment/intended activation. An empty direct set is explicitly
NotApplicableForDirectIngredients and cannot become whole-child readiness.

`createCurrentProductRecipeIngredientReferenceSource` constructs the actual complete
current Product/Store/Brand/Recipe content source and existing owning Inventory
configuration source. It derives targets only inside the held current Recipe
callback; clients supply only the original Product selector. Fixed Tenant, Brand,
Actor, captured clocks/query/holders and original operation/intent are retained.
Inventory's existing `inventory.item.read` and `inventory.item.history.read`,
FullBrandScope and exact metadata fields must be held through the original UoW.
The wrapper translates facade authorization back to that original transaction;
there is no cross-domain private SQL in API code and no new route or production grant.

The existing Inventory source holds its shared configuration reference advisory
barrier, uses read committed isolation and checks current generation/permissions
at the end. Complete Recipe and all Catalog/Store/Brand policy final rereads still
execute on the same transaction. The earliest exclusive original/Recipe/Inventory
five-second lease bounds every inner callback and the outer final rereads. Future
source observation, backwards clock, expired deadline, query replacement, swallowed
reentry, repeated callback or substituted result refuses; tentative writes must
roll back. The wrapper can never refresh the original intent or extend its lease.

This returns current Item configuration association only. `unitsAndConversions`,
stock and eligibility remain NotEvaluated; Subrecipe reference count is explicit,
Subrecipes NotEvaluated, childReferences and publishValidation Incomplete. Current
Active status does not prove future lifecycle, physical stock, compatible quantity
or unit conversions, cost/allergen/nutrition facts, Preparation/Modifier/Kitchen
availability, Store Groups or sale entitlement. The owning System must revalidate
current dependencies and permissions at actual activation. Those remaining
repository compositions and ordinary Product publishing/recovery UI are separate
work; actual legal/Store/Provider/Future Trigger facts remain gated.

Confidential complete Recipe content stays internal inside existing full-field
permissions. This milestone adds no logs, HTTP payload, analytics or persisted
capture of health/cost/prose fields. The reference assessment itself contains only
scoped configuration metadata and canonical digests.

Focused owner/protocol tests use explicit synthetic snapshots/factories. Existing
isolated Recipe management SQL keeps the actual RecipeService Publish fixture,
uses actual Inventory Create/Activate/Deactivate with Audit, then reads both actual
owning sources. Negative and late probes demonstrate exact rollback including
source generations, immutable operation/version history, Audit and Outbox. The
SQL pair is not the full combined Product API/normal HTTP release journey; fixture
permissions/identity remain synthetic and cannot establish live IAM or UAT.
Exact results/failures/check inventory remain in [WP-2421](../work-packages/WP-2421.md).
