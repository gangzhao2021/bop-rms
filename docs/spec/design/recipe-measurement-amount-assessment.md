# Recipe quantity, loss and pinned yield comparison

[WP-2421](../work-packages/WP-2421.md) milestone72 complements
[Inventory unit comparison](./recipe-ingredient-unit-assessment.md) within the
existing Recipe29.1/29.3 boundary. It changes no immutable snapshot, historical
consumption calculator, writer, migration, permission or Domain dependency.

`assessRecipeMeasurementAmounts` requires closed
[V2 complete content and full digest](./recipe-measurement-draft-durability.md),
explicit assessment/activation instants and at most256 complete pinned child
snapshots. Existing owning graph validation rejects missing references, wrong
Recipe/version/Brand, duplicates, cycles and depth beyond16. The complete graph is bounded by4096 requirements. Unreachable extra
snapshots also reject. The function is pure: provided snapshot digests and
Published labels are not physical publication or current source authority.
Actual publication composition must acquire owning current graph/contents,
permissions, root status, barriers and shortest leases in the original UoW.

For each root Ingredient it computes exact quantity times numerator/denominator,
then multiplied by (10000+lossBasisPoints)/10000. All arithmetic uses BigInt.
Existing positive10^30 bounds apply at input and both amount stages. Fractional
microunits return ConversionRoundingRequired or LossRoundingRequired; overflow
returns QuantityOutOfRange. Failed matches expose no usable converted/loss-adjusted
amount or batch factor. The legacy two-stage HalfUp calculator remains untouched.
This conservative assessment rejects cases needing rounding instead of silently
changing historical consumption. Inventory ledger precision remains a separate
owning check on loss-adjusted demand.

Subrecipe target code/dimension must equal the exact pinned child's real batch
yield code/dimension. Positive yield, Published snapshot, original chronology and
current/proposed effective-period membership are required. Zero yield already
fails the unchanged core parser. A missing/currently unavailable child cannot
be replaced by a newer root or fixed mapping. Exact batch demand equals adjusted
use divided by pinned yield; the result is a reduced numerator/denominator, which
can be fractional and never defaults to one batch. Noninteger batches are exact
ratios; recursively scaling every nested Ingredient remains future work.

Receipts bind full V2 content digest, canonical complete pinned-snapshot digest,
root/Brand/version, explicit time, exact quantities/loss and per-edge child digest,
yield and reduced factor. Results retain inventoryPrecision, recursiveDemand,
sourceAuthority and eligibility as NotEvaluated and publishValidation Incomplete.
The comparison does not supply cost/safety reviews, current Inventory facts,
full publish admission or selling eligibility.

Focused tests cover loss boundaries, positive/max amounts, both rounding stages,
overflow, exact standard conversion and fractional batch ratio, pinned target,
lifecycle/effective time/chronology refusal, complete-digest tampering and strict
graph/content failures. Actual isolated SQL acquires owning published parent and
pinned child plus publication proof using the existing held graph. It derives a
synthetic V2 Draft authoring candidate and checks exact21/20 batches against those
actual child facts. Changed target/loss candidates remain synthetic and are not
persisted V2 Published evidence. A fractional-loss refusal after a separate Recipe
marker causes exact11-table rollback through the original holder. All retained
graph/current root/review/permission/expiry/query and subsequent checks remain.

Next compose Recipe loss-adjusted demand with Inventory ledger precision and
complete recursive V2 provenance, then implement actual V2 review/publication and
current content graph for Product. Product normal release/UI and Store capability
management remain repository work; real IAM/Store/Provider/UAT/formal release gates
are separate, and this component does not mean whole-project completion.
