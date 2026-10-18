# Held complete Published Recipe V2 graph

[WP-2421](../work-packages/WP-2421.md) milestone76 adds full immutable V2
attachments to the existing owning current Published root and exact pinned child
graph. It builds on [direct Ingredient publication](./recipe-measurement-publication.md)
and [complete measurement representation](./recipe-measurement-content-v2.md).
A decoded client snapshot or reconstructed legacy measurement is insufficient.

`createCurrentPublishedRecipeMeasurementGraphSource` constructs the actual existing
owning core source, preserving root currentness, exact historical child pins,
physical Published operation and independent review proof, graph cardinality and
cycle limits, current scope/field permission, original transaction/query identity,
Recipe advisory barrier, half-open periods, shortest five-second lease and final
core rereads. A child keeps its pinned Published version even when its current root
has a newer Draft. No current root version substitutes for the pin.

Inside that holder, additional FullBrandScope `recipe.manage` field authority must
cover complete measurement profile/content/digest, usage and target units, and
conversion provenance before reading any attachment. The public scoped immutable
reader lives in the existing owning Recipe repository path. It resolves the exact
native Published operation, compares its complete core to the held snapshot, and
requires the physical V2 attachment's full canonical digest and exact core binding.
It refuses a missing legacy attachment rather than filling in default units.
The reader alone is not a current held source.

The wrapper captures the original transaction, checks every query before/after,
rejects reentry and callback/result substitution, and poisons a refused transaction.
After consumer work it repeats measurement field authority, rereads every complete
attachment, compares the full result, holds authority again and retains the core
holder's final reads. Its output digest includes actual core source digest, exact
publication proof, pinned paths and complete V2 content. Representation is CompleteV2;
Inventory currentness, unit arithmetic, publish validation and sale eligibility are
still NotEvaluated/Incomplete. Consumers must compose those additional owning sources
in the same original unit of work and roll back on refusal.

The exact new persistence filename is admitted only under Recipe ownership of all
five prerequisite tables. Ten validator tests cover wrong owner/schema, missing
tables, driver imports and arbitrary paths. This adds no new private-table read
pattern, schema, migration, grant or external service.

Protocol tests use actual owning core source and operation decoders with synthetic
SQL rows, including full pinned child representation and late attachment/permission
changes. Actual isolated SQL reads the physical complete Published V2 created by
milestone75, rejects actual legacy publication without an attachment, and proves
eighteen-table rollback after independent marker and late authority/query/lease
refusal. The negative missing-final-row response is explicitly synthetic and never
mutates immutable physical history. Identity, authorization and review declarations
remain synthetic. Ordinary configured Product HTTP/UI, complete SubRecipe publication
composition, independent current review capture, Store management, UAT and formal
release require subsequent work.
