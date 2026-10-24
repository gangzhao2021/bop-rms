# Current Store Recipe override authorization

WP-2421 milestone63 implements the repository composition required by accepted
Handoff Section29.6. It uses the existing [Store resolver](./current-store-recipe-resolution.md)
and the owning current Brand configuration and Publishing release contracts.
This is one bounded Product validation input; complete publication and selling
eligibility remain unevaluated.

`RECIPE.VERSION` is the software field code for replacement of a whole Recipe
version at a Store. The current Brand configuration must explicitly include it
in `overrideAllowedFieldCodes`; a current hard requirement prevents override.
A field code, static module map, stored Published row or caller DTO alone cannot
grant permission. Recipe retains exact Store precedence and unique binding
selection. An applicable denied override never falls back to the Brand default.
This implements our software rule binding, without assuming real Brand policy,
legal approval, Store setup, Provider results or Future Trigger evidence.

The API composition accepts only the original Product request, original finite
observation window, intended activation, selected Store, exact Brand configuration
version selector and expected Brand revision. Tenant/Brand/Actor, clocks and
full-field authority holders are fixed server composition inputs. It constructs
actual owning Catalog, Tenant Store, Recipe and Tenant Brand sources itself;
the existing Brand composition queries owning Publishing for both original and
current release provenance. It accepts no graph, policy body, approval flag or
Ready status. Missing current configuration/release or mismatched revision refuses.

All reads use the original caller transaction and captured query facade. Catalog
and Recipe source barriers, Tenant Store generation/current authority, Brand row
`FOR SHARE` and Publishing table SHARE fence are held through the caller UoW.
Current metadata is immutable and its digest binds the published snapshot;
independent approved Actor and evidence references must agree with the recorded
release. Both observation and activation must lie in the policy's half-open
interval. The original exclusive deadline is narrowed by every source's five
second freshness window and the configuration's expiry; it can never be extended.

After the caller callback, the composition re-reads the same owning Brand content
and current Publishing release using the original selector and window, comparing
the entire minimal current content. This catches same-UoW Brand revision or
publication changes that locks against competing transactions cannot prevent.
The existing final Catalog reread and Tenant/Recipe generation/current permission
checks still run. Captured clock/query/holders, monotonic time, callback/result
identity and recursive admission poisoning prevent substitution or recovery under
a new intent. Failure is bounded `CATALOG_DEPENDENCY_UNAVAILABLE`; tentative writes
must roll back in the caller transaction.

The result is `CurrentProductStoreRecipePolicyV1`, with current direct Store
resolution and minimal Brand configuration/current publication provenance. It
contains no locale prose, credentials, health facts or external business evidence.
Store Groups, preparation classification, full Ingredient/Subrecipe content,
health/nutrition/cost/Kitchen impacts, all five publishing checks, ordinary editing
and release/recovery UI remain separate required repository work.

The focused protocol tests use synthetic source records and holders. The selected
isolated PostgreSQL case uses immutable synthetic Tenant metadata and actual
owning Publishing CreateDraft, SubmitReview, distinct-Actor Approve, Publish and
Archive operations with actual Audit writes. Recipe/Store facts and permissions
are synthetic; SQL, current readers, fences, RLS, generation checks and transaction
rollback are actual local behavior. Results and failures are recorded in
[WP-2421](../work-packages/WP-2421.md); no test result implies live IAM, UAT, deployment
or formal release.
