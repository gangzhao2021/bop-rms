# Complete V2 recursive demand

[WP-2421](../work-packages/WP-2421.md) milestone73 extends the
[exact loss and pinned yield comparison](./recipe-measurement-amount-assessment.md).
Recipe owns theoretical consumption under29.1/29.3. Existing legacy demand and
HalfUp calculation remain unchanged; Inventory owns current conversion facts and
final ledger precision. Frozen Module dependencies remain intact.

`calculateRecipeMeasurementDemand` requires full-digest V2 root and every exact
reachable V2 child. Legacy-only content cannot supply missing usage/target units.
Root Draft/Published supports authoring and read assessment; children must be
Published and effective at current/proposed instants. Existing graph constraints,
Brand/reference association and every node's exact conversion/loss/yield comparison
must pass. Duplicate, unreachable, incomplete or malformed contents refuse.

The graph permits256 versions,4096 requirements and depth16. Output permits4096
separate consumption paths, including repeated shared-child paths: sharing a
version never deduplicates its consumption. Requested root yield scales each node
by its actual pinned batch yield. Reduced BigInt ratios carry all scaling and
loss through to final target-unit microunits. No intermediate batch or final
fraction is rounded. Each scaled amount is positive and at most10^30; bounded
rational numerator/denominator permit up to1024 digits, beyond the maximum allowed
sixteen-layer inputs. Conflicting operations for the same Inventory Item refuse.

Every leaf binds Item/current-configuration operation selectors, explicit unit
and conversion provenance and complete Recipe/version/requirement/content-digest
path. The receipt binds the entire V2 content graph digest, requested yield and
assessment/activation instants. It is pure arithmetic: Inventory precision,
source authority and selling eligibility remain NotEvaluated, publication
Incomplete. Invoke with actual owning inputs under held source barriers/current
permissions and original transaction; client/synthetic complete content is not
actual Published V2 authority. Final rational target demand still needs the
owning Inventory ledger qualifier, including aggregation when applicable.

Tests cover fractional output, root scaling, shared paths, exactly4096 outputs,
8192-path refusal, depth17 refusal, digest/pin/units/loss/lifecycle/closed-input
failures and conflicting Item operations. Actual isolated SQL acquires published
parent/child with owning held graph evidence. Synthetic complete V2 representations
derived from those actual snapshots yield1102500 target microunits; missing V2
child refusal after an independent marker rolls back11 related tables. This is
actual graph/transaction proof and synthetic V2 representation evidence, not
persisted V2 publication or Inventory precision approval. Existing assertions and
subsequent source checks remain intact.

Next implement Inventory-owned final rational precision/current holder composition,
then actual V2 review/publication/current graph and ordinary Product release/UI.
Store capability management and real IAM/Store/Provider/UAT/release gates remain
open. No component result establishes whole-project completion.
