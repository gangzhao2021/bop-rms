# Current Store and base Recipe version selection

WP-2421 milestone62 implements accepted Handoff29.2/29.6 for the direct Brand/Store
bindings represented by existing public sources. Recipe owns selection semantics;
Tenant owns registered Store identity, lifecycle, revision and complete generation.
Catalog owns the current Product Draft SKU graph. Source coverage and current
operational capability remain distinct.

The owning [resolver](../../../packages/rms/recipe/src/contracts/current-store-recipe-resolution.ts)
selects a whole version for one Store and each selected current SKU at an explicit
UTC activation instant. A base binding has no Option Binding reference. Option
modifiers are evaluated separately and cannot stand in for a base Recipe. Applicable
Store bindings precede Brand defaults. The binding interval is half-open. Another
Store's binding or a binding outside the intended interval does not participate.
An applicable denied, stale or unpublished Store candidate blocks selection: the
resolver does not discard it and fall back to Brand. Exactly one binding at the
selected precedence is required, including when duplicated bindings name the same
version. Its owning Recipe must point to that Published version and the version
must cover activation. Duplicate records require an owning correction, not an
arbitrary sorting tie-breaker. Selection never edits published ingredients.

Unknown or non-Active Store/Brand, missing base Recipe, ambiguous binding,
unpublished/stale version or inactive version period produces `HardError` with a
bounded reason and no selected version. Missing Recipe is not interpreted as a
no-preparation SKU; that classification needs its owning Catalog content decision.
An empty SKU selection also fails. Results retain source digests, generations,
original intent, Store revision and intended time. Their digest is consistency
metadata, not authorization evidence.

A minimal `CurrentRecipeStoreOverridePolicyV1` projection is defined for subsequent
composition of the existing current Brand Configuration/Publishing release reader.
It binds the Brand configuration content and current publication references,
original intent, observation/validity and effective interval. The Boolean permission
must derive from the held current owning configuration, not client input, a fixed
map or a Published row alone. Pure rule tests use explicitly synthetic policy
metadata; they are not actual current-policy acquisition evidence. Absent policy is
`Unavailable` and any applicable Store override fails closed.

The [API composition](../../../apps/api/src/current-product-store-recipe-resolution.ts)
constructs the existing owning Catalog Draft source, complete Tenant Store source
and Recipe metadata source directly on the caller's original transaction. Intent
contains only the existing closed Product selector, Store selector, original finite
window and intended activation. No client graph, policy or Ready field is accepted.
Captured authority methods and the original query facade prevent late replacement.
Tenant authority must cover the actual server Tenant, session, Actor, Brand, purpose
and the complete unmasked registry through COMMIT; its old public metadata contract
is Brand-scoped and is not Tenant permission evidence by itself.

Lock acquisition is Catalog then Tenant then Recipe. Original observation and
minimum five-second source deadline are exclusive; the clock is monotonic and each
callback executes once. Reentry poisons the transaction even if caught. Result
identity is checked, Catalog rereads its exact current graph after work, and the
Tenant/Recipe owners recheck current permission and generation after work. Owning
fences remain transaction-scoped. Caller rollback is mandatory on failure. All
three owners continue to own their private SQL; this composition introduces no
foreign-table query or writer. Current Store identity cannot promise future Store
activation; the actual System activation path must reacquire sources.

This step supplies unavailable policy in the API. Actual current Brand permission
composition is the next repository task. The API therefore proves Brand-default
selection and refuses Store overrides without claiming current authorization.
The current Tenant/Recipe profiles contain no Store Group membership or group
binding family. Group resolution remains `NotSupportedBySource`, an explicit
repository design/composition gap. Direct selection is not a proof across possible
unrepresented groups. Preparation classification, complete ingredient/Subrecipe
validation, Allergen/Nutrition/cost/Kitchen impact checks, Option modifiers,
operational eligibility and full five-check publication admission remain separate.
No result grants sale eligibility or enables modules.

[Rule tests](../../../packages/rms/recipe/src/tests/current-store-recipe-resolution.test.ts)
cover topology, precedence, ambiguity, half-open periods, failed override fallback,
source substitution and safe policy parsing. [API protocol tests](../../../apps/api/src/current-product-store-recipe-resolution.test.ts)
cover synthetic owners/holders, original UoW, current checks, lease/query replacement,
callback/result identity and recursion. The additive consumer in the existing
[actual SQL case](../../../packages/database/test/product-category-classification-acceptance.test.mjs)
uses isolated synthetic Brand/Store/Recipe metadata and holder facts. Owning SQL,
projection/generation/fences, source reads and whole-transaction rollback are actual
local evidence. Controlled probe writes are fixtures, not owning lifecycle Commands
or publication Audit evidence. Existing Category browser assertions retain their
prior scope; no new normal release UI or real IAM/Store/UAT evidence is claimed.
