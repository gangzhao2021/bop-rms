# BOP-RMS Specification Index

## Authority

- Source document ID: `BOP-RMS-HANDOFF`.
- Accepted composite baseline: the Owner-confirmed Handoff `0.5.3` Sections `0–91`
  plus repository-accepted Sections `92–97`.
- Repository source reference: `BOP-RMS Complete Handoff Package.md` identifying
  itself as `0.5.9`, used for the scoped reconciliation recorded in
  [WP-2336](./work-packages/WP-2336.md) and [WP-2400](./work-packages/WP-2400.md).
  The Owner-authorized sync at `03ad510` is now present in this Mac checkout;
  earlier local-source availability limitations are resolved.
- Current execution coordinator: [WP-2423 — single-store pilot track](./work-packages/WP-2423.md)
  (Owner-accepted 2026-10-06). WP-2421 whole-project assembly is paused; WP-2402 remains the retained
  pilot/history owner.
- Counts and waste (2026-10-07): [DEC-INV-STOCK-COUNT / DEC-INV-WASTE](./design/stock-count-and-waste.md) — blind location counts with reviewer-explained variances and refresh of moved lines; waste posted at once with independent review of high-value records
- Recipes (2026-10-07): [DEC-RECIPE-AUTHORING](./design/recipe-authoring.md) — Brand recipe drafts, independent cost/food-safety review, kitchen instructions, SKU binding with supersession and revisions
- Brand roles (2026-10-07): [DEC-PERM-BRAND-ROLES](./design/brand-role-templates.md) — signed Brand role templates (Brand Owner, Recipe Developer, Recipe Reviewer) and Brand role assignment with independent approval
- Opening stock (2026-10-07): [DEC-INV-OPENING](./design/opening-stock-count.md) — audited one-time Store opening count posted as first ledger movements
- Migration order (2026-10-07): [DEC-MIGRATION-RELEASE-ORDER](./design/migration-release-order.md) — new migrations go into release namespaces (2000+); module namespaces are closed
- Scope direction (2026-10-06): [DEC-FOCUS-01 pilot mainline focus](./design/pilot-mainline-focus.md)
  freezes peripheral Domains and unconnected Merchant pages and pauses Product/Option/Recipe
  publication refinement. [WP-2422](./work-packages/WP-2422.md) owns the repository design remediation
  (deployable composition root, reproducible runtime ACL, WP log size, test orchestration).

The 2026-07-23 Owner decision established the composite baseline because no newer Library file was
then confirmed available. Current local availability and formal acceptance are separate facts:
a file's self-reported version does not accept a replacement complete baseline. The local file
supplies source text for bounded comparison; later accepted ADR/WP records and scoped addenda
supply the acceptance evidence. On 2026-09-22 the Owner explicitly authorized tracking and
syncing the complete Handoff source to the existing public GitHub repository for development
on another computer, superseding the earlier instruction to keep this document outside Git.
This changes source availability only, not acceptance of its entire self-reported baseline.
Never commit Library credentials, signed URLs, account identities or private access metadata.

Decision precedence follows Section 0: later numbered accepted sections supersede conflicting older text. Section 80 is the remediation baseline; Sections 86 and 87 close delegated and hardening decisions; Section 88 is authoritative for pages and functions; Sections 89–91 govern repository execution、Codex / Figma operation and GitHub Free solo governance; Sections 92–94 govern database ownership、Domain dependency enforcement and Migration Runner behavior; Section 95 is authoritative for WP-0021 foundation schema behavior；Section 96 is authoritative for WP-0022 helper objects、ownership、ACL、Tenant Context and verifier behavior；Section 97 is authoritative for WP-0024 reusable seed、fixture and parallel isolated-test-database behavior.

Accepted scoped addenda remain effective within their recorded scope:
[DEC-FOCUS-01](./design/pilot-mainline-focus.md) records the Owner's 2026-10-06 work-priority
direction; it changes no accepted Section, ownership or Section 88 contract.
[Brand configuration review validity](./design/brand-configuration-review-validity.md)
records the explicit administrator-selected finite review expiry for WP-2421
Brand submission; authorization leases do not define business review validity.
[Initial Brand administration](./design/brand-initial-administration.md) distinguishes
actual Draft Brand management from operational Active-Brand admission and retains
independently approved initial provisioning as separate unfinished software work.
[Tax publication candidate binding](./design/tax-publication-candidate-binding.md)
defines the WP-2421 frozen candidate, nonrecursive content digest and external
material composition without changing professional qualification gates or
historical Draft bytes.
[WP-2228](./work-packages/WP-2228.md) records DEC-H01/H02 product choices;
[DEC-H03](./design/capacity-source-decision.md) is the accepted capacity topology addendum.
[Product publication defaults](./design/project-delivery-decision-inputs.md#accepted-product-publication-policy)
record the Owner's 2026-10-03 selection of a seven-day backdate window and explicit
Warning confirmation for missing Pricing, Recipe, Inventory or Menu configuration.
Do not reopen them because an implementation or acceptance test remains unfinished.
[DEC-H03-DINING](./design/capacity-checkout-handoff.md#proposed-dine-in-interpretation-dec-h03-dining)
is an accepted scoped interpretation (Owner approval on 2026-09-10).
WP-2402 records original-clock and commitment implementation, multi-batch expiry and
paid-batch preservation (438–448), and the v14 Dining sale/refund/closure journey (571).
These are local InternalTest evidence; remaining pilot acceptance is tracked in the
[current acceptance table](../runbooks/single-store-pilot.md#current-acceptance-and-remaining-work).

[DEC-PILOT-INV-01](./design/inventory-pilot-persistence-decision.md) was accepted by the Owner on
2026-09-11: Inventory namespace 1900 and scoped pilot persistence are authorized.
WP-2402 now includes persisted submission flows, actual API-role Inventory cancellation
rollback/replay and reservation release (425–426), and multi-batch preservation (438–448).
Authorization, recorded implementation evidence and complete pilot acceptance remain
separate; these local scenarios do not supply real Store inventory facts.

Agents must read root `AGENTS.md`, this index and their assigned WP before editing.
If a newer source introduces a conflicting rule, establish its exact section, scope and acceptance
evidence, apply the precedence above and refresh only the affected brief before implementation.
A changed availability label alone does not supersede accepted decisions.

## Current Owner-selected deployment phase

On2026-09-22 the Owner selected the current Windows/WSL host and existing local test
employee for the immediate InternalTest demonstration, with cloud Linux migration
later. Follow the [accepted deployment and login scope](../runbooks/single-store-pilot.md#accepted-deployment-and-login-scope-2026-09-22).
Enterprise employee-directory, real Payment/Store activation and cloud host gates
remain future phase requirements, not missing prerequisites for opening the local
demo. This decision does not authorize live deployment or manufacture operator
handover evidence.

## Current repository stage

The [documentation remediation record](../runbooks/project-documentation-remediation.md), [candidate register](../runbooks/project-candidate-register.md) and [decision inputs](./design/project-delivery-decision-inputs.md) cover the whole project. Windows/WSL runtime batches below retain their original host/candidate identity; they do not describe a running installation in this macOS checkout.

The [whole-project completion review](../runbooks/project-completion-review.md)
separates the local single-Store milestone from confirmed normal-entry composition
gaps, design decisions, unverified scenarios and external evidence. It also tracks
the Owner-requested Figma Make TBD reconciliation; no overall project completion
or remote design update is implied by the pilot milestone.

[WP-2421](./work-packages/WP-2421.md) is the current whole-project implementation coordinator on
`codex/wp-2402-pilot-submission`, assembled from baseline
`03ad510c9b694a4bf994efb6703e11afa53e2fb7`. Current source checkpoints, coordinator
handoff and remaining work are recorded in WP-2421. Component implementations and
their scoped evidence do not establish an assembled pilot or whole-project completion.

Recorded Windows/WSL v14 installation, host-specific batch results and remaining operator/release gates are maintained in the [pilot acceptance table](../runbooks/single-store-pilot.md#current-acceptance-and-remaining-work). This Mac checkout contains source and retained edits, not that installation. Detailed milestone narration is [historical](./history/implementation-milestones-before-2026-09-29.md#recorded-runtime-and-checkout-milestones).

## Latest Work Package Status

Owner requested whole-project completion on 2026-09-29. [WP-2421](./work-packages/WP-2421.md) coordinates source assembly and remaining repository work. Incoming WP-2407–2420 briefs retain their historical scope; imported results are not fresh assembled evidence.

The main checkout retains [WP-2402](./work-packages/WP-2402.md), including the Owner-authorized 2026-09-29 project-documentation continuation. The [candidate register](../runbooks/project-candidate-register.md) identifies parallel owning WPs, integration targets and collisions. The [scenario evidence view](./design/business-scenario-coverage.md#current-scenario-evidence-view) owns whole-product progress; [the pilot acceptance table](../runbooks/single-store-pilot.md#current-acceptance-and-remaining-work) owns the recorded assisted Windows/WSL milestone.

Older implementation paragraphs and the original WP status summaries are preserved in [the dated milestone archive](./history/implementation-milestones-before-2026-09-29.md). They are not current runtime or exact-tree acceptance claims.

## Accepted technical floor

The accepted floor is：PostgreSQL `18.4`；application-owned business、Command、Event and Correlation IDs use UUIDv7 through `uuid 14.0.1`；a database default may call built-in PostgreSQL 18 `uuidv7()` only for migration / repair paths；the extension allowlist remains only `pg_trgm` and `unaccent`。Money facts use `amount_minor bigint` plus ISO 4217 `currency_code char(3)` and never PostgreSQL `money` or binary floating point。Instants use UTC `timestamptz`，Store zones use IANA identifiers，local operating dates use `date` and wall-clock configuration uses `time without time zone`。Brand is the primary Tenant boundary；Store-owned facts carry both required scopes；critical uniqueness and query indexes include scope；future Brand / Store tables require application authorization plus RLS defense in depth using transaction-local server-resolved context。Cross-domain private-table access remains prohibited。All mutable Aggregate Roots continue to require `version bigint not null`、conditional update by expected version and an explicit conflict instead of last-write-wins；WP-0023 supplies bounded synthetic integration evidence for that rule。WP-0024 now owns the reusable synthetic-only、parallel-safe isolated PostgreSQL lifecycle and does not create a business seed or production fact。

## WP-0022 accepted decision record

[ADR-0033](../adr/ADR-0033-database-helper-type-tenant-context-boundary.md) and
[WP-0022](./work-packages/WP-0022.md) own the current helper contract under Section 96.
The [original seven-point decision record](./history/README.md#wp-0022-accepted-decision-record)
is preserved for traceability. Archiving progress does not change the accepted helper inventory,
Money/time/Tenant boundaries, ACL, migrations or future business-table ownership.

## Verification and maintenance

The Owner-authorized [delivery execution adjustment](./work-packages/history-WP-2421-01.md#owner-authorized-execution-requirement-adjustment--2026-10-02)
uses a complete ordinary business workflow as the delivery unit. Contracts, source adapters and
internal checkpoints remain subtasks until entry, commands, persistence, refresh and recovery work
together. Follow root `AGENTS.md` for one concise workflow plan/check inventory, parallel subtasks,
evidence reuse and closeout. A chat turn or subtask ending does not itself require a new checkpoint
or duplicated documentation. Existing business invariants and acceptance evidence remain binding.

For each bounded WP, identify the acceptance questions, affected files and existing checks before
running them. Reuse valid evidence with its command, result, revision/diff and unchanged-input
rationale. A new worktree needs its own valid frozen installation. Run remaining affected checks
once on their final inputs; rerun only after a relevant change, failure or unresolved concern.

Documentation repairs need source/link/format review, not business regression. Tooling changes
need their behavioral regressions, affected consumers and applicable lint/type checks.
Shared contracts, persistence or authorization changes require reassessing integration scope.
Full `pnpm verify` and `pnpm test:integration` belong to the named complete business journey or
release/merge milestone unless a higher gate or concrete cross-module risk requires them earlier.
Mandatory CI remains binding; do not force cache bypass without a specific freshness concern.

Each affected scenario row links its current decision, evidence by layer and remaining dependency.
Every decision has one authoritative disposition record; summaries link to it and distinguish
decision acceptance, implementation progress and observed acceptance evidence.
