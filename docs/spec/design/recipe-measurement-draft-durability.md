# Recipe V2 draft durability

[WP-2421](../work-packages/WP-2421.md) milestone69 extends the
[measurement representation](./recipe-measurement-content-v2.md) with owning
append-only draft persistence. Recipe remains the write owner. This is a bounded
software implementation; current conversion/yield admission and ordinary Product
publishing still require the next implementation milestones.

The canonical full-content digest includes the profile, every parsed core field
except the digest itself, and all canonically sorted explicit measurements.
Changing a unit, conversion pin, rational, cost, scope, time, version or lifecycle
changes the digest. Existing independent Cost/FoodSafety review grammar binds to
that digest. The pure review matcher is not proof of current permission or
persisted publication approval.

`createRecipeMeasurementDraftService` accepts CreateDraft and ReplaceDraft only.
It delegates to the existing owning Recipe service for Brand/Actor permission,
original intent, expected version, lifecycle, CAS, Audit and Outbox. Recovery
checks the original immutable full content and operation intent, including after
another draft version has been saved. Revoked authority still rejects recovery.
The factory does not qualify supplied reference booleans as current conversion
facts. Publish, Invalidate and Archive through this V2 draft contract refuse.
Existing legacy commands and immutable history retain their accepted semantics;
legacy Published rows without complete proven V2 content cannot supply V2 units
qualification.

The additive `1250_010` migration creates `rms_recipe.recipe_measurement_content`.
Its exact version/Recipe/Brand key references the immutable owning Recipe version.
The JSON core and digest must match that physical version on insertion under the
same RecipeCatalogReferenceV1 advisory barrier. Brand RLS is enabled and forced,
PUBLIC access revoked, updates/deletes are immutable no-ops, and truncation is
rejected. There is no backfill or history update. The SQL trigger checks physical
core binding; full measurement grammar and canonical digest validation belong to
the owning writer and reader. A structurally stored invalid attachment therefore
still refuses owning recovery. This is not a current publication read source.

`createPostgresRecipeMeasurementDraftStore` captures the original transaction and
query, delegates to the existing owning repository, then appends and rereads V2
content in the same write transaction. It does not rewrite SQL or copy the old
writer. It bounds raw storage errors, guards reentry/callback/result/query
substitution and poisons the captured transaction after refusal. The supplied
transaction runner must honor rollback; the isolated SQL entry point proves
rollback using the actual outer transaction. Production transaction composition
must retain that same contract.

The new table contains internal versioned Recipe configuration and existing
operational source/evidence references. It receives no credentials, Provider
facts, customer health data or public identifiers. The owning access manifest
permits only its repository read/insert. The isolated synthetic role receives
only SELECT/INSERT for this new asset; no production grants are added.

Acceptance uses focused owner behavior/type checks, affected consumers, existing
migration catalog/ownership tests and the existing Recipe management isolated SQL
entry point. Actual SQL covers draft create/replace, physical core/full content,
Audit/Outbox, original replay, altered intent, permission refusal, expected
version, post-append failures, late owning CAS, immutable rules, wrong Brand,
missing/corrupt content and exact full-table rollback. Synthetic identities,
reference facts and authorization fixtures are explicitly separate from actual
local Commands, repositories, DDL and physical transaction evidence. No live DDL,
normal Product HTTP/UI, complete publication admission or external release is
claimed.
