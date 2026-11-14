# Current Product complete Recipe measurements

[WP-2421](../work-packages/WP-2421.md) milestone78 adds a distinct V2 composition to
the [existing current Product dependency source](./current-product-recipe-dependency-graph.md).
The existing Product/Store/Brand policy and exact Published Recipe selection remain
the parent. The API constructs the owning complete current-root V2 graph and current
Inventory unit holder in the original transaction, using the parent's Actor, scope,
operation, original intent, observation and intended activation. Each selected root
must match its full core and publication operation/evidence. Extra current measurement
and Inventory unit authorities must be configured; no DTO substitutes for these sources.

Recipe's additive public batch contract selects each exact reachable closure from the
complete graph, rejects missing, duplicate, legacy, non-Published, cross-Brand or orphan
contents, and calculates one independent batch for every selected root. It delegates
cycle, depth, period, child yield, loss, rational demand and per-path quantity checks to
the existing owning calculator. Bounds remain256 versions,4096 requirements, depth16
and4096 consumption paths across the entire batch result. Shared children retain every
consumption path; an independently selected child remains a separate batch. The API
adds no graph calculation rule. Combined Ingredient/SubRecipe requirements remain
bounded to1000 for current Inventory selectors.

Every reachable direct ingredient receives current Inventory base-unit/conversion
qualification at observation and activation. Each independent batch then receives
Inventory's final exact ledger-precision assessment. Fractions requiring rounding fail
closed. Results are bound by full source digests and the shortest exclusive lease;
original query/clock, callback and result guards cover all final source/field rereads.
Refusal poisons the original unit of work, whose caller must roll back tentative writes.

`unitsAndConversions` and `inventoryPrecision` can be Pass within this bounded
qualification. Product/SKU serving quantity, stock, cost/safety applicability, other
child references, publish validation and sale eligibility remain unqualified. Independent
root batches are never summed as Product/order quantities. Actual System activation
must reacquire current owning sources/permission and retain CAS, Audit/Outbox and
source barriers. Existing67 V1 source behavior/profile remain unchanged.

API protocol tests use synthetic parent/source holders and actual owning V2 digest,
unit-fact decoders, batch and final precision contracts. Isolated Recipe management
SQL composes actual physical77 parent/child Published V2 sources and current Inventory
units, checks independent parent/child batches, and tests late field/core/lease/query
failure and owning Item Deactivate with exact eighteen-table rollback after an
independent marker. Identity/field authorization and intent are synthetic. This SQL
pair does not exercise complete Product/Store/Brand composition or normal HTTP/UI.
Ordinary Product review/publishing pages, current approval/validation activation,
Store management, native Recipe revision Draft and real UAT/release remain open.
