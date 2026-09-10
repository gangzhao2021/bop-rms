# BOP-RMS Specification Index

## Authority

- Source document ID: `BOP-RMS-HANDOFF`.
- Accepted composite baseline: the Owner-confirmed Handoff `0.5.3` Sections `0–91`
  plus repository-accepted Sections `92–97`.
- Locally readable source: an untracked `BOP-RMS Complete Handoff Package.md` identifying
  itself as `0.5.9`, used for the scoped reconciliation recorded in
  [WP-2336](./work-packages/WP-2336.md) and [WP-2400](./work-packages/WP-2400.md).
- Current discussion node: `WP-2353 - Order Repository Composition`.

The 2026-07-23 Owner decision established the composite baseline because no newer Library file was
then confirmed available. Current local availability and formal acceptance are separate facts:
a file's self-reported version does not accept a replacement complete baseline. The local file
supplies source text for bounded comparison; later accepted ADR/WP records and scoped addenda
supply the acceptance evidence. Keep the complete Handoff untracked and outside Git. Never commit
Library credentials, signed URLs, account identities or private access metadata.

Decision precedence follows Section 0: later numbered accepted sections supersede conflicting older text. Section 80 is the remediation baseline; Sections 86 and 87 close delegated and hardening decisions; Section 88 is authoritative for pages and functions; Sections 89–91 govern repository execution、Codex / Figma operation and GitHub Free solo governance; Sections 92–94 govern database ownership、Domain dependency enforcement and Migration Runner behavior; Section 95 is authoritative for WP-0021 foundation schema behavior；Section 96 is authoritative for WP-0022 helper objects、ownership、ACL、Tenant Context and verifier behavior；Section 97 is authoritative for WP-0024 reusable seed、fixture and parallel isolated-test-database behavior.

Accepted scoped addenda remain effective within their recorded scope:
[WP-2228](./work-packages/WP-2228.md) records DEC-H01/H02 product choices;
[DEC-H03](./design/capacity-source-decision.md) is the accepted capacity topology addendum.
Do not reopen them because an implementation or acceptance test remains unfinished.
[DEC-H03-DINING](./design/capacity-checkout-handoff.md#proposed-dine-in-interpretation-dec-h03-dining)
remains a distinct proposal.

Agents must read root `AGENTS.md`, this index and their assigned WP before editing.
If a newer source introduces a conflicting rule, establish its exact section, scope and acceptance
evidence, apply the precedence above and refresh only the affected brief before implementation.
A changed availability label alone does not supersede accepted decisions.

## Current repository stage

[WP-2352](./work-packages/WP-2352.md) is committed at `4c3f9be52db676641a2cddc7d1f894424875f879`.
Its Ordering adapter atomically writes original Order/Batch/Item history, number allocation,
Audit and Outbox under current Cart/deadline fences, with scoped PostgreSQL evidence.
[WP-2351](./work-packages/WP-2351.md) supplied the Checkout write fence.
[WP-2353](./work-packages/WP-2353.md) composes this writer and original-history reader with
the application service: concurrent Existing results recover the original Order after current
Guest reauthorization. Current authority/capacity/Inventory/Payment clock composition remains
before the complete submission-to-Payment journey is ready.

[WP-2400](./work-packages/WP-2400.md) is integrated locally with the Screen Registry repairs,
current design/evidence views and explicit verification selection/stop rules in root AGENTS.md.
The history archive retains its original WP-2350 snapshot. Local integration does not establish
remote PR/main, release or production readiness.

Read the [design decision register](./design/README.md#current-decision-implementation-and-evidence-state)
for accepted versus pending decisions, the [business scenario evidence view](./design/business-scenario-coverage.md)
for service/API/database/browser progress, and the
[Pilot readiness inventory](../runbooks/pilot-integration-readiness-inventory.md) for external gates.

## Latest Work Package Status

- [WP-2353](./work-packages/WP-2353.md): scoped service/repository composition, with 135/135
  focused tests and actual PostgreSQL application creation/replay/race evidence.
  The brief owns verification details and remaining activation gates.

- [WP-2352](./work-packages/WP-2352.md): committed atomic Order writer.
  Its recorded Ordering 1014/1014, ownership 230/230 and actual PostgreSQL rollback/concurrency/
  recovery passes remain the owning evidence; they were not rerun by this merge.
- [WP-2351](./work-packages/WP-2351.md): committed Checkout evidence/write-fence prerequisite.
  Its original Ordering 998/998 and HTTP/service e2e evidence retains its stated scope.
  The downstream owner writer is now recorded in WP-2352.

- [WP-2400](./work-packages/WP-2400.md): locally integrated design consistency and Screen contract repair.
  Its brief owns the fresh check results and any remaining limitations.
- [WP-2350](./work-packages/WP-2350.md): baseline scoped immutable Order recovery.
  Its recorded Ordering 979/979, ownership 219/219 and actual PostgreSQL recovery evidence is
  historical; none is rerun or relabeled by this documentation/tooling task.
- [WP-2336](./work-packages/WP-2336.md): accepted DEC-H03 topology.
  Producer clocks, durable composition and race/compensation evidence are implementation
  requirements, not pending topology approval.

Older progress and original evidence remain in the
[historical index snapshot](./history/README.md) and individual [work packages](./work-packages/).
Keep this section bounded to the active WP and relevant baseline; update the scenario evidence
view for affected journeys instead of copying every past result into this index.

## Accepted technical floor

The accepted floor is：PostgreSQL `18.4`；application-owned business、Command、Event and Correlation IDs use UUIDv7 through `uuid 14.0.1`；a database default may call built-in PostgreSQL 18 `uuidv7()` only for migration / repair paths；the extension allowlist remains only `pg_trgm` and `unaccent`。Money facts use `amount_minor bigint` plus ISO 4217 `currency_code char(3)` and never PostgreSQL `money` or binary floating point。Instants use UTC `timestamptz`，Store zones use IANA identifiers，local operating dates use `date` and wall-clock configuration uses `time without time zone`。Brand is the primary Tenant boundary；Store-owned facts carry both required scopes；critical uniqueness and query indexes include scope；future Brand / Store tables require application authorization plus RLS defense in depth using transaction-local server-resolved context。Cross-domain private-table access remains prohibited。All mutable Aggregate Roots continue to require `version bigint not null`、conditional update by expected version and an explicit conflict instead of last-write-wins；WP-0023 supplies bounded synthetic integration evidence for that rule。WP-0024 now owns the reusable synthetic-only、parallel-safe isolated PostgreSQL lifecycle and does not create a business seed or production fact。

## WP-0022 accepted decision record

[ADR-0033](../adr/ADR-0033-database-helper-type-tenant-context-boundary.md) and
[WP-0022](./work-packages/WP-0022.md) own the current helper contract under Section 96.
The [original seven-point decision record](./history/README.md#wp-0022-accepted-decision-record)
is preserved for traceability. Archiving progress does not change the accepted helper inventory,
Money/time/Tenant boundaries, ACL, migrations or future business-table ownership.

## Verification and maintenance

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
