# Inventory precision for final Recipe demand

[WP-2421](../work-packages/WP-2421.md) milestone74 connects the
[complete V2 recursive arithmetic](./recipe-measurement-recursive-demand.md) to
Inventory-owned base unit and ledger precision under Handoff29.5/72.7. This is
exact theoretical demand qualification; it does not write Inventory movements.

`assessRecipeBaseDemands` accepts explicit Recipe/version/requirement/Item/current
configuration operation, target unit/dimension, positive rational target-unit
microunits and unique path digest. All fields and arrays use strict data descriptor
inspection before digesting; accessors, extra fields, malformed or sparse inputs
refuse without executing getters. Rationals are reduced with BigInt, bounded as
in the recursive calculator. No binary floating point or silent rounding.

Up to4096 distinct consumption paths may share a selector. Every distinct selector
must exactly match the complete held current owning unit facts; the existing
source supports up to1000 unique selectors. Conflicting associations/operations,
duplicate paths, missing/extra sources, invalid full source digest, field shapes,
original five-second lease or current/proposed time refuse. The extracted internal
strict decoder preserves the existing conversion assessor's behavior; it is not
an additional source or permission grant.

Each path must match the actual current base unit and dimension. Its exact rational
quantity must be an integer multiple of the real ledger step10^(6-ledgerPrecision),
positive and at most10^30. Any precision or unit failure returns HardError and no
usable aggregate. Two fractional paths cannot cancel their precision failures
through aggregation. This conservative publication assessment preserves separate
consumption provenance; it does not change the accepted movement rounding policy.

Same-Item exact quantities sum without deduplicating shared subrecipe use. The
aggregate must also be at most10^30; overflow returns no usable aggregate. Output
binds normalized demand digest, all paths/selectors, full unit/owning source digest,
generation, original observation/lease and current/proposed assessment time, exact
Decimal quantity, Item version, ledger precision and rounding policy.

Conversion applicability still requires the separate
[owning conversion comparison](./recipe-ingredient-unit-assessment.md). Path/demand
DTOs and hashes are selectors and consistency receipts; source authority remains
NotEvaluated. Call within the original owning holder and retain its current
permissions, source barrier, query identity, final rereads and rollback boundary.
Stock, sale eligibility and complete publication admission remain unavailable.
No Recipe-to-Inventory private import or foreign SQL is introduced.

Actual isolated SQL recovers an immutable complete V2 Draft through its original
owning operation, derives final demand with the real Recipe calculator and compares
against actual owning current KG/Mass/ledgerPrecision4 within the existing holder.
A deliberately fractional synthetic demand selector after an independent marker
fails with no usable quantity and rolls back18 related tables. Existing conversion,
late permission/generation/expiry/query and immutable V2 assertions remain intact.
Role/identity fixtures remain synthetic; this is not Published V2 or normal Product
HTTP/UI evidence.

Next assemble complete V2 independent review/publication/current graph, then
ordinary Product release and Store capability management. Real Store/Provider/IAM,
Future Trigger, UAT and formal release evidence remain external gates.
