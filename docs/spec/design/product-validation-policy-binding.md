# Product validation binding to current policy

WP-2421 milestone117 implements the Warning override rule accepted in Section68.9: a Policy may allow Warning publication only with the override Actor and Reason. The actual typed Publishing Product publication policy owns `warningOverrideAllowed`. Catalog owns the full validation contract and binds it to that policy through its public `bindCatalogProductValidationToPolicy` helper.

## Ownership and admission

The helper parses the complete twelve-check validation and complete typed policy, then verifies the closed Tenant/Brand context, policy reference, version and approval requirement. An acknowledged Warning with `warningOverrideAllowed=false` refuses as `CATALOG_DEPENDENCY_UNAVAILABLE`. The helper is a pure supplied-source binding, not an authorization or current-source receipt. Consumers must acquire and hold the actual current policy with their original transaction, purpose, Actor and independent field authority.

An unacknowledged Warning can still be recorded by Validate. Existing Catalog lifecycle validation blocks release without acknowledgement, binds its Actor to the command or original submitter, and requires exact Warning codes and Reason. HardError is never cleared by allowing Warning override. All twelve outcomes, evidence identity, fingerprints, observation/expiry and acknowledgement remain unchanged; required approval must still actually pass its own check and original receipt constraints. Policy presence does not produce ApprovalPolicy Pass.

## Ordinary source composition

The [native Validate adapter](./product-candidate-unique-scope-source.md) uses the exact policy already held for current candidate UniqueScope, with no new SQL query. Its policy release/content digest/observation/expiry binding remains mandatory. Catalog applies the policy binding before merging the sole actual UniqueScope outcome, preserving the other ten independent checks and earliest expiration.

The [ordinary current-approval adapter](./product-approval-policy-composition.md) applies the same Catalog helper within the existing current-policy callback, before Required original-approval or NotRequired publication consumer work. The owning current-approval source must actually visit that policy callback once. Missing or repeated policy callbacks refuse; client facts cannot substitute another policy or acknowledged Warning. Current native permissions, independent approval/policy fields, original five-second observation, shorter receipt/source expiry, failure latch and final COMMIT holds remain in force.

Original idempotent recovery returns the existing immutable result with current ordinary receipt admission, without new policy acquisition or historical lease renewal. Cancel and approval-decision source composition are unchanged. Owning System activation must still revalidate the frozen publication and current sources/permissions at actual activation; this bounded change does not supply the remaining activation producers.

## Evidence boundaries and remaining work

Unit tests cover allowed and forbidden Warning acknowledgement for Required and NotRequired policies, unacknowledged Warning, unchanged HardError/approval outcomes, full twelve-check retention, scope/policy mismatch, malformed and accessor inputs, and absence of the current-policy callback. Allowed override policy is a synthetic unit fixture, not an actual governance publication or permission grant.

The existing isolated native HTTP/SQL acceptance adds rejection before writer for current Required Validate, Required immediate Publish/future Schedule and NotRequired Publish under actual stored policies that forbid override. All discovered Catalog/Publishing/Tenant/Permission/Audit/Outbox table digests must remain unchanged, and prior source expiry, permission withdrawal, tentative rollback and original recovery assertions remain intact. Exact commands, outcomes and final hashes are recorded in [WP-2421](../work-packages/WP-2421.md#milestone117--bind-warning-acknowledgement-to-actual-current-policy-planned-before-implementation).

Actual current owning SQL, synthetic native IAM sessions and local HTTP are separate from synthetic complete validation/background governance/field authority. Remaining actual validation producers, timing review, full ordinary publishing pages and Store administration remain in progress. This is not full `pnpm verify`, real Store/Provider qualification, source IAM, UAT, sale or formal release evidence.
