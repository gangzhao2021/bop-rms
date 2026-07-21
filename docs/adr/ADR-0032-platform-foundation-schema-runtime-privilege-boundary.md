# ADR-0032 — Platform Foundation Schema and Runtime Privilege Boundary

- Status: `Accepted`
- Owner: BOP-RMS Owner
- Decision date: `2026-07-20`
- Effective version: `BOP-RMS-HANDOFF 0.5.7 / architecture baseline v1.0`
- Affected modules: shared database infrastructure and future Eventing、Audit、Job、Idempotency and Projection owners
- Related Work Package: `WP-0021`
- Source: Canonical Handoff Section 95
- Implementation decision: `IDR-0045 — Foundation Schema Bootstrap, ACL and Verification`
- Supersedes: `None`
- Superseded by: `None`

## Context

WP-0020 created only `platform_core.migration_history` and reserved the remaining foundation work for WP-0021。Older Database Blueprint examples list functional Outbox、Inbox、Audit、Job and Idempotency tables，but their behavior、retention、runtime authority and integration evidence belong to later owning Work Packages。Creating them in WP-0021 would collapse ownership gates and weaken WP-0013 staged fail-closed enforcement。

## Decision

WP-0021 is schema-only。It hardens the existing `platform_core` schema ACL and creates empty `platform_eventing`、`platform_audit` and `platform_jobs` schemas。It creates zero new functional tables；`platform_core.migration_history` remains the only existing table。`platform_projection` is an explicit non-goal。

All four schemas are owned by the externally established dedicated migration role that executes the migrations。WP-0021 creates no PostgreSQL role、login or membership。`PUBLIC` has no `USAGE` or `CREATE` on the schemas and no dangerous default privileges。Application、worker、reporting and projection runtimes receive no advance schema or object grant；each later owning WP grants least privilege per object after accepted ownership and permission evidence。

Future Brand / Store-owned tables continue to require RLS defense in depth，but WP-0021 creates no tenant-owned table and therefore no RLS policy。Outbox is owned by WP-0030；Inbox / Consumer Idempotency by WP-0032；Job / Retry / Dead-letter by WP-0033；Audit Record by WP-0042；Audit integrity / archive by WP-0046；Projection persistence by a future explicitly authorized Projection WP。`platform_core.idempotency_record` is a Future Trigger that must close before the first API Command Idempotency implementation。

The ordered future migrations are exactly `0000_002_alter_platform_core.sql`、`0000_003_create_platform_eventing.sql`、`0000_004_create_platform_audit.sql` and `0000_005_create_platform_jobs.sql`。They preserve the WP-0020 runner、catalog、checksum、transaction、advisory lock、diagnostic and exit contracts。

## Alternatives and decision drivers

Rejected alternatives were creating all Blueprint example tables now、creating runtime roles in migrations、granting schema-wide runtime access、creating `platform_projection` preemptively、placing objects in `public` and extending the Migration Runner with a mutating foundation command。The accepted design preserves single ownership、least privilege、reviewable ordering and the smallest safe persistence increment。

## Consequences

Later object-owning WPs must supply their own DDL、classification、runtime grants、RLS where applicable、retention、append-only / replay and integration evidence。WP-0013 may recognize only the exact four root platform migrations when implementation is authorized；Module persistence remains fail closed。No Domain fact、Tenant / Store record、Provider、PII、API、UI or production resource is created by this decision。

## Validation and rollback

Validation uses synthetic temporary roots and unique isolated PostgreSQL databases。It proves exact schemas、owners、PUBLIC denial、safe default privileges、zero functional objects、absence of `platform_projection`、repeat no-op、transaction rollback、deterministic read-only verifier diagnostics and unchanged WP-0010–0020 gates。

Applied migrations are immutable。Recovery uses a new reviewed forward-fix migration or an independently approved restore；down、repair、baseline、mark-applied、force and applied-file edits are prohibited。An unintegrated implementation may be removed by normal reviewed Git revert。

## Revisit trigger

Revisit only when an owning later WP has accepted evidence requiring a changed schema owner / privilege model，or PostgreSQL evidence shows the default-deny contract cannot support the approved runtime boundary。Implementation convenience or a desire for broad grants is not a trigger。
