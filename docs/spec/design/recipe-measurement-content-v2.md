# Recipe measurement content V2

[WP-2421](../work-packages/WP-2421.md) milestone68 implements the missing explicit
content representation identified by the [pinned Recipe graph](./current-published-recipe-dependency-graph.md).
Accepted Section29.4 permits standard same-dimensional conversions and requires
versioned Inventory Item rules for item-specific/cross-dimensional conversions.
This remains Recipe and Inventory ownership; no generic Measurement Domain is introduced.

`RecipeMeasurementContentV2` is a closed envelope with exactly `profile`, `snapshot`
and `measurements`. The complete legacy RecipeSnapshot remains unchanged. Every
Ingredient requirement has exactly one measurement row, bound by its exact
requirementReference within that exact Recipe/version. Rows explicitly contain
usageUnitCode, usageDimension, targetUnitCode, targetDimension, conversionKind and
nullable conversionReference. Quantity, rational numerator/denominator, loss and
cost stay in the versioned core. Usage dimension must match the existing Ingredient
unitDimension. Canonical parsed measurement order is by exact requirement reference.

The conversion choices are explicit:

- InventoryBaseUnitIdentity requires an InventoryItem requirement, identical unit
  codes/dimensions, rational1 and no conversionReference. Current owning Inventory
  must subsequently prove that target is the actual base unit of the exact current
  Item configuration selected through its operation UUID.
- InventoryRecordedConversion requires an InventoryItem requirement, distinct usage
  and target codes and an exact conversion UUID. It may cross dimensions. The owning
  Inventory source must subsequently prove current Item operation/version, actual
  base unit, that exact Active conversion's endpoints/multiplier, effective observation
  and intended activation, uniqueness and generation/permission freshness.
- PinnedSubrecipeYieldIdentity requires a SubRecipe requirement, identical codes/
  dimensions, rational1 and no conversionReference. The complete owning pinned graph
  must subsequently bind target code/dimension to the exact child's batch yield.
- StandardDimensionConversion supports explicit G/KG Mass and ML/L Volume endpoints,
  exact1000 or1/1000 ratios and no item conversionReference. Equivalent rational
  fractions are accepted using BigInt cross multiplication. The actual Inventory base
  unit or pinned child yield target must still be resolved; this stable mathematical
  rule cannot invent a target unit, Item lifecycle, child snapshot or source authority.

Codes use the existing Recipe uppercase code grammar; no legacy unit is inferred
from a dimension or ratio. Positive quantities and ratio components preserve the
existing<=10^30 bound; calculations never use binary floating point. Missing,
extra or duplicate requirement rows, incompatible source kind/dimensions, identity
ambiguity, missing recorded pins, nonstandard/incompatible standard conversions,
unknown keys/profiles/kinds, accessors/prototypes/sparse measurement arrays and
numeric overflow fail with the existing bounded RECIPE_INPUT_INVALID error.
The parser freezes the complete parsed core, row objects and sorted list.

This milestone implements syntax and explicit provenance representation. It does
not write/read persisted V2 contents, verify real conversion records, admit Recipe
publication or change runtime defaults. Existing services reject the envelope as a
legacy snapshot, and existing stored history/public readers remain unchanged.
A caller-supplied V2 envelope is never a current owning source. The46 focused tests
include42 new representation cases and four unchanged legacy domain cases. They
prove grammar, exact arithmetic, closed-input handling and legacy compatibility,
not persisted provenance, SQL, normal editing/release, IAM, Store, UAT or deployment.

## Next owning persistence and publication milestone

The next bounded implementation must preserve `recipe_version.snapshot_json` and
append-only historical bytes. Add a version-local nullable owning measurement column
or separate version-keyed owning asset through a new migration; null old versions
remain readable but have unavailable measurement qualification. New V2 writes must
atomically store the complete envelope bound to the same physical Recipe/version/
Brand and unchanged legacy core, with exact operation intent, expected-version CAS,
Audit/Outbox and rollback. Do not backfill unit guesses or mutate Published history.

Define the canonical complete-content digest over profile, complete core excluding
its digest field, and parsed sorted measurements. The published core's snapshotDigest
and independent Cost/FoodSafety reviews must bind that complete digest. Idempotency
must include the complete content, including conversion pins; changing a measurement
cannot recover an unrelated original operation. A stored Published label or V2 parser
result cannot replace actual owning Publish operation and physical independent reviews.

A full owning V2 reader must reacquire exact complete content, actual publication/
review proof and current root receipt under the existing source barrier/full-field
permission/shortest original lease. It must reread all complete content and sources
after work. The existing Product graph/Inventory combination can consume it only
through that owning public source, then check current effective units/conversions for
all reachable exact children. Add actual writer/read/review/idempotency/CAS/Audit/
Outbox/RLS/rollback SQL acceptance and affected shared contracts/consumer/projection
checks before enabling it. Ordinary editing and complete Product release/five-check
admission and Store capability management remain subsequent repository implementation.
