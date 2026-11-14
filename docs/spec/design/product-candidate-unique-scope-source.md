# Current Draft and UniqueScope preparation

WP-2421 composes the existing [current validation candidate](./product-validation-candidate-source.md) and [UniqueScope source](./product-unique-scope-source.md) for accepted Sections68.9 and73.5. This is an internal API composition; no ordinary DTO, permission grant, schema or new Domain rule is added.

## Current owners and original intent

`createCurrentProductCandidateUniqueScopeSource` first acquires the actual owning Catalog current Draft under complete current field/purpose/Validate authority. Missing Draft, wrong current root/version/body/configuration or foreign server Actor context refuses before history, roster or policy acquisition. A supplied aggregate, candidate, validation, approval or source record is not accepted.

The subsequent UniqueScope acquisition uses actual Catalog publication history, Tenant registered Store identities and current typed Publishing Product policy through their existing public factories. All owners use the caller's exact outer transaction. Current source fences remain held through that transaction's COMMIT. Original canonical command intent, Product/version/root, Tenant and Brand must match both observations.

The result contains minimal candidate fingerprints and observation bounds alongside the single scope check, scope findings and policy/publication identity. It carries the original scope-assessment digest separately, with a new digest covering the joined binding. It contains no aggregate, complete text, current author identity or client source rows. Legacy complete-content absence remains `Unavailable`; complete publish validation remains `Incomplete`, and eligibility remains `NotEvaluated`.

## Time, authority and rollback

Each owner's observation is independently valid; no extra ordering of the two observations or Node/PostgreSQL wall clocks is imposed. The minimum candidate, scope and policy expiration bounds the callback and final return. Current complete candidate authority and current Validate/history/roster/policy authority are retained by their original owners. The composition requires exactly one completed consumer callback and the same completed return value; expiration after the last candidate authority check still refuses.

The composition prepares one scope check. It cannot generate a twelve-check Pass, establish operational Store/Provider eligibility, resolve missing Region/StoreGroup topology, authorize a Warning override or replace owning System's actual frozen-version activation validation. Unknown current owners fail closed.

## Evidence and remaining work

Actual isolated SQL binds current Draft651/root16 and its content/configuration fingerprints. Unknown version, changed body/configuration and stale/future root refuse before any scope-history authority call or consumer work. The existing actual owning Validate consumer now uses this composition. Four failures after an observed real root17/HardError write—late current authority, scope expiry, expiry during final action authority and repeated roster callback—roll back root, revisions, operations, snapshots, source commits/heads, Audit, Audit-chain and Outbox. Original replay acquires no new sources; current base authority still governs recovery.

This SQL scenario intentionally uses a legacy Draft without complete editor content. UniqueScope and its matching HardErrorsCleared summary derive from actual sources; the other ten individual checks remain explicit doubles. Actor/field/reference holders, Product/Store data and policy governance validation inputs are synthetic. This is genuine local SQL composition/rollback evidence, not a complete validation receipt, ordinary HTTP/browser workflow, real approval/UAT or release evidence.

Full current Brand field/reference/twelve-check preparation, precise equal-rank disposition and normal editor/publishing runtime/pages remain open. Store administration follows the Product repository loop. Commands, initial portable-type failure and repair, evidence reuse and exact fingerprints are recorded in [WP-2421](../work-packages/history-WP-2421-01.md#overnight-actual-draftuniquescope-preparation--2026-09-30-continuation).

## Ordinary Validate integration (WP-2421 milestone115)

Optional server `currentUniqueScope` captures mandatory current candidate, publication-history, Tenant roster and typed Publishing policy authority; remaining full facts remain mandatory. It binds the original authenticated User, Tenant, Brand, Product, command and transaction. Native `catalog.manage`, `catalog.product.validate`, `catalog.product.read`, `catalog.sku.read` and `catalog.product.history.read` surround source work and final commit. The original exclusive five-second monotonic bound, shorter owning expiry and failure latch apply; final guards reassert original held fields instead of rereading mutated Draft or renewing evidence. Current registered identities do not establish module, Provider, operational topology or sale eligibility.

Catalog owns the validation merge. The actual current bound `UniqueScope` replaces only its mandatory Pass wire placeholder; a supplied conflicting Warning or HardError refuses. `HardErrorsCleared` is recomputed from all eleven individual outcomes. Other ten checks, warning acknowledgement and evidence identity remain unchanged, and the earlier remaining/source deadline bounds the result. No default full qualification or source fallback is added. Missing Region or StoreGroup operational topology remains a conservative hard error.

Original replay checks current ordinary write authority and complete-content Read fields without acquiring new candidate, history, roster, policy or remaining validation. History read permission is required for new Validate source acquisition, not inferred for original replay. Owning System frozen-version activation validation, CAS, Audit/Outbox and barriers remain unchanged. The isolated HTTP/SQL evidence and separately synthetic remaining ten checks/independent fields/initial governance are recorded in [WP-2421](../work-packages/WP-2421.md). Full validation producers, timing approval, ordinary complete runtime/browser and Store administration remain incomplete.

## Held policy consistency (milestone116)

The ordinary source consumer retains the actual current typed Publishing policy acquired by UniqueScope, with no second policy SQL acquisition. Before writer work it checks parsed Tenant/Brand/reference/version, current release identity, policy content digest, original observation and earlier expiry against the actual scope proof and full validation. The independent validation's approval requirement must match the actual current policy. A Required policy accompanied by supplied NotRequired facts refuses; valid actual NotRequired is accepted only with agreeing full validation. Malformed, ineffective, expired or missing callback data refuses.

This is a consistency barrier. Section68.9 item11 requires required independent approval to have passed, so current policy presence never creates an ApprovalPolicy Pass or approval receipt. All ten other outcomes remain mandatory independent facts. Current field/native rights, original source lease/failure latch and final COMMIT rechecks stay in place; original replay acquires no fresh policy. Complete current validation and approval preparation, normal runtime/browser and Store administration remain pending.

## Warning policy binding (WP-2421 milestone117)

The same actual policy callback now also binds complete validation to Catalog's [Warning override policy rule](./product-validation-policy-binding.md). Acknowledgement cannot bypass current warningOverrideAllowed=false; other outcome checks and owning approval remain mandatory. No second policy acquisition or replay acquisition is added.
