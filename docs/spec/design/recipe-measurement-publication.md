# Complete V2 direct Ingredient publication

[WP-2421](../work-packages/WP-2421.md) milestone75 connects actual complete
[V2 draft durability](./recipe-measurement-draft-durability.md),
[exact recursive demand](./recipe-measurement-recursive-demand.md) and
[owning Inventory final precision](./recipe-base-demand-assessment.md)
to the existing native Recipe Publish command. This bounded composition accepts
only direct Inventory Item ingredients. A new V2 candidate containing a pinned
SubRecipe refuses until an owning complete V2 child source is available.

`createCurrentRecipeMeasurementPublicationService` receives the original outer
transaction and trusted current Recipe authority, native authorization/review
and reference ports. It constructs the owning Inventory unit holder and Recipe
Published writer directly. The closed five-field request carries Publish,
original operation, expected aggregate version, complete Published V2 candidate
and canonical occurredAt. Full digest, Brand/Actor scope, effective period and
current permission are mandatory. Caller DTOs and synthetic reference booleans
do not grant current source authority.

For a new operation, the original transaction holds the current Recipe authority
and Inventory metadata/unit permissions. All exact Item/configuration operation
pins must be present and current. The candidate passes explicit usage conversion,
loss and theoretical demand, then exact final base-unit ledger precision with no
silent rounding. Validation covers both the current clock and proposed activation
(the later of now and effectiveFrom). The owning holder retains its full source
rereads, barriers, shortest exclusive five-second lease, original query identity
and current permissions across the native write. Recipe authority is held again
after writing and after the Inventory holder returns. Failure poisons this
transaction for this service; the outer caller must roll back the entire unit of
work. No stock movement is written.

The existing Recipe service still checks independent Cost and FoodSafety reviews,
full candidate digest binding, current reviewer permissions, author/reviewer
separation, reference/mapping/cost/allergen validation, expected version and CAS.
Its existing writer appends physical Published version, review records, operation,
Audit and Outbox. The added complete V2 content is appended and reread in the same
transaction. The Published-only factory accepts Publish via commit only; the
unchanged Draft-only public factory accepts CreateDraft/ReplaceDraft only. Neither
repository factory substitutes for the native service and current source holder.

Exact original operation recovery first holds current Recipe authority and invokes
the native service's authorization and intent checks, then compares the immutable
full V2 result. It does not requalify historical Item pins against today's units.
Changed full content or original intent refuses; revoked current permission still
refuses. Recovery appends no repeated review, Audit or Outbox. An actual local SQL
probe deactivates the owning Item, recovers the original command with zero Inventory
source calls, and intentionally rolls back only the probe transaction.

Evidence distinguishes API protocol tests with mocked holders from actual local SQL
rows and owning repositories. SQL proves direct Ingredient Published V2/core/digest,
two independent review records, original CAS/Audit/Outbox, actual current KG/Mass
ledger precision, and exact rollback of eighteen tables after late write/query,
permission and lease refusal. Fixture identities, permissions, reference validation
and review declarations are synthetic. No ordinary configured HTTP publishing,
independent review capture management, current complete V2 child graph, Product sale
eligibility, Store management, UAT or formal release is established by this milestone.
No production grants, schema changes, external evidence or real credentials are added.
