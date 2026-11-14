# Current Recipe Ingredient unit facts

[WP-2421](../work-packages/WP-2421.md) milestone70 supplies owning Inventory unit
facts needed by [V2 Recipe content](./recipe-measurement-content-v2.md) and
[draft durability](./recipe-measurement-draft-durability.md). It preserves the
accepted configuration-reference and Option unit sources. No Recipe private
Inventory queries or invented Option identities are introduced.

A closed selector contains Recipe, Recipe version, requirement, Inventory Item
and exact owning Item configuration operation references. Those labels select
facts and do not prove Recipe ownership or Product applicability. Recipe content
must come from its owning source when composed for publication. At most1000
selectors are accepted, with one Item operation per Item and no duplicate
Recipe-version/requirement association. Distinct requirements may share the same
exact Item configuration.

`createPostgresInventoryRecipeIngredientUnitSource` constructs the existing
owning complete configuration holder on the original transaction, captures its
query and clock, and joins selected physical Item version/operation rows. Tenant,
Brand, Actor, original purpose and intent remain explicit. Current Item/history
permissions and the entire base-unit/conversion field set are held before and
after reads and consumer work, including ledger precision, rounding, multiplier,
rule status/effective time and reason code. No supplied unit DTO is authority.

The decoder requires the current Active Item, exact operation and numeric
configuration version, precise immutable row identity/time and original owning
observation. Missing rows, historical operations, inactive Items, extra data,
accessors, conflicting selectors or malformed conversions fail closed. The
source returns the complete current base unit and recorded conversion array;
future and retired rules are retained as facts. It does not choose a conversion,
calculate Recipe quantities, decide applicability, stock or selling eligibility.
That distinction permits later explicit current/activation checks without
silently treating a stored rule as usable now.

The result contains the original metadata digest/generation/observation,
canonical complete unit-fact digest and exclusive five-second lease. Original
query identity, clock monotonicity, callback/result/reentry guards and transaction
poisoning protect the consumer boundary. After work the source reauthorizes and
rereads complete unit fields; its nested owning metadata source rechecks current
configuration and generation under its existing source barrier. Any refusal
requires rollback of the caller's original transaction. No normal callback may
mutate Inventory configuration.

New public exports and exact owning read declarations cover only existing Item
version/operation assets. No migrations, production grants, Inventory write
commands, Recipe synchronous dependency or existing source behavior change.
Unit records and selectors are internal configuration references, with no
credentials, customer health facts or public logging.

Focused tests use synthetic metadata/driver rows and permission holders for
malformed selectors and late full-field, conversion, generation, expiry, query,
callback/result and swallowed reentry refusal. The existing isolated Recipe SQL
entry point additionally derives selectors through actual V2 draft recovery,
reads the actual owning current Item base unit (KG, Mass, ledger precision4) and
empty conversion array, and checks late supported Deactivate with physical
Audit, generation, permission, expiry/query refusal and exact18-table rollback.
Its scope/identity/permission evidence remains synthetic. A positive configured
conversion is protocol evidence only in this milestone; no recorded conversion
writer or actual configured-conversion SQL success is claimed.

Next implement the Recipe-owned comparison of explicit V2 usage/target units,
exact rational quantities and loss against these held facts and pinned child
yields. Inventory recorded rules must match the exact pin, current and proposed
activation, status and base unit. Standard unit arithmetic cannot invent current
Item base units. Then bind full V2 publication/reviews/current graph and normal
Product publishing. This source alone is not completed Product admission, UI,
Store capability management, UAT or release.
