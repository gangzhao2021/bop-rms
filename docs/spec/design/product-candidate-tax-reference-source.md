# Current Product Draft and registered tax-reference preparation

Implemented under [WP-2421](../work-packages/history-WP-2421-01.md#current-product-candidate-and-actual-registered-tax-reference-preparation--2026-09-30-continuation). This uses the existing actual [Catalog validation candidate](./product-validation-candidate-source.md) and public Pricing Brand tax-reference source. It preserves accepted Product validation and Domain ownership; it prepares reference metadata without resolving tax applicability.

## Source and authority

The [API composition](../../../apps/api/src/current-product-candidate-tax-references.ts) captures server Tenant/Brand/User, clock and mandatory authority ports. A descriptor-safe owning User Validate command binds the actual current Product Draft root/version/body/configuration and original Validate intent. Supplied aggregates, tax snapshots or context cannot substitute for that source. Catalog current Validate and complete candidate field permissions are checked before SQL or tax acquisition.

The existing public Pricing factory reads the complete registered Store inventory from Tenant, including archived and empty Stores, plus actual tax-reference roots, retired references and version/rule metadata. Brand metadata and per-Store field/purpose/current permissions remain mandatory, with Tenant and Pricing source fences held in the same caller transaction through COMMIT. The Pricing request binds the original Validate operation and intent; it cannot use an unrelated lifecycle review intent. API contains no private SQL or business-tax calculation.

Existing public reference matching retains Draft, expired and noncurrent rules, unresolved roots and explicit/default classification distinctions. The minimal CurrentProductCandidateTaxReferencesV1 output binds candidate identity to tax-source and match digests, counts, observation and exclusive expiry. It does not transport Store identities, classification/rule IDs, rates, names, Product content or a source graph. Complete-content absence remains explicit for legacy Drafts.

The earliest candidate thirty-second or any tax/Store observation five-second deadline applies before and after consumer work and after all owning wrappers. Observation times are checked individually, without assuming ordering between independent clocks. Candidate, tax transaction, tax source and consumer callbacks must execute once; the final result must be the completed consumer result. A repeated Tenant callback that swallows the owning runner's rejection still makes the final API result unavailable. The caller awaits all checks and propagates failures before committing its outer transaction.

## Qualification boundary

CompleteExplicit means the Product has an explicit classification reference and matching enumerated metadata is complete; it does not guarantee a matching applicable rule. DefaultUnavailable does not invent a Brand or Store default. An empty reference list, a stored Published label or a Draft match does not resolve tax. Current legal/jurisdiction applicability, required order types/charges, schedule-period coverage, SKU overrides, approval/evidence and configured default resolution remain separate sources and checks.

TaxResolution is always Unavailable, publishValidation Incomplete and eligibility NotEvaluated in this profile. This output cannot replace a full twelve-check validation receipt or authorize publication, System activation or sale. Media/Option/Safety/Nutrition, current fields and ordinary Product release journeys remain in the [editor inventory](./product-editor-content-contract.md).

## Local evidence

The existing [complete-editor SQL case](../../../packages/database/test/product-publication-persistence-acceptance.test.mjs) now reads actual current root2 and actual Tenant/Pricing metadata: two registered Active/Archived Stores, one stored Draft rule, one unresolved root and one retired root. A null classification remains DefaultUnavailable. An actual temporary root3 with explicit classification matches the stored Draft rule, still reports TaxResolution Unavailable, and is intentionally rolled back. This controlled read does not permanently change the Draft or invent tax approval.

Wrong current body refuses before tax authority. Current tax denial, exact five-second expiry, shorter tax expiry during the final candidate-authority check, and a repeated Tenant callback with swallowed rejection each follow one returned actual root3 tentative write and refuse; Product root/operations/snapshots/source commits/heads/Audit/chain/Outbox and owning Draft return to the prior state. Current authority, tax/legal data and fault injection are synthetic; sources, SQL, RLS, fences and tentative writes are actual local implementations.

Twelve API refusal cases, API typecheck, selected lint, import22 plus repository scanner, and the final selected SQL1/1 pass. Initial fixture typecheck erased generic Promise<T>; its generic callback was repaired without changing production contracts. Other three SQL case bodies retain their original exact fingerprints and evidence; no full SQL suite, normal HTTP/browser, pnpm verify, real UAT or project-completion claim is made.
