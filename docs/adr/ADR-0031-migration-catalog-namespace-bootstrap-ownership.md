# ADR-0031 — Migration Catalog, Namespace, and Bootstrap Ownership

- Status: `Accepted`
- Owner: BOP-RMS Owner
- Decision date: `2026-07-17`
- Effective version: `BOP-RMS-HANDOFF 0.5.6 / architecture baseline v1.0`
- Affected modules: shared database infrastructure and all future persistence-owning Modules
- Related Work Package: `WP-0020`
- Source: Canonical Handoff Section 94
- Implementation decision: `IDR-0044 — Migration Execution, Integrity and Diagnostics`
- Supersedes: `None`
- Superseded by: `None`

## Context

Sections 50 and 56 establish a root migration layout、global ordering、forward migration and schema ownership principles。Section 92 makes Module Manifests and the platform registry authoritative and deliberately blocks real persistence until WP-0020。The repository now needs one executable migration contract without turning `packages/database`、a namespace directory or SQL metadata into a second business-ownership source。

## Decision

The only executable catalog is the root `migrations/` directory。Its version-`1` namespace registry materializes the fourteen accepted Section 50 bands，but grants no schema、table or write authority。Platform migrations must match the Section 92 shared-infrastructure registry；business migrations must match the exact owning Module Manifest and database evidence。Module-local migrations remain prohibited。

`packages/database` owns only common connection and migration mechanics。The sole WP-0020 DDL exception is the first migration：it creates the `platform_core` shell and append-only `platform_core.migration_history` control table，then records itself in the same transaction。WP-0021 retains every other Core / Eventing / Audit / Job schema and table。

Migration files have deterministic directory、filename、metadata、encoding and one-schema ownership contracts。Global order is numeric namespace then sequence。Applied files are immutable and use byte-exact SHA-256；duplicate order、case collision、path escape、symlink、checksum mismatch、orphan history and out-of-order insertion fail closed。

## Consequences

Empty databases can bootstrap without unmanaged imperative DDL，and repeated execution is a safe no-op。The minimal `platform_core` exception is deliberately narrow and creates no business fact、Tenant / Store record、Outbox、Audit、Job、Projection、seed or reusable fixture framework。

WP-0013 staged enforcement remains active：only the root catalog、the runner-owned bootstrap migration and `packages/database` use of the accepted PostgreSQL driver are exempted。A later persistence WP must add its own ownership、runtime permission and migration evidence before a business asset becomes legal。

## Alternatives and decision drivers

Rejected alternatives were Module-local migration directories、directory-derived ownership、`public` migration tables、an untracked imperative bootstrap、automatic adoption / baseline of existing schemas and treating `packages/database` as the owner of all data。They introduce divergent ordering、ownership escape、undetectable bootstrap drift or unsafe adoption。

The accepted design optimizes for one global order、explicit ownership、reviewable immutable history、fail-closed drift and the smallest possible WP-0020 / WP-0021 overlap。

## Validation and rollback

Validation covers catalog grammar、ownership、empty bootstrap、repeat no-op、byte mutation、rename / deletion / orphan / out-of-order、unmanaged schema refusal、transaction rollback、concurrent runners and unchanged WP-0010–0014 checks。Static fixtures use temporary roots；runtime fixtures use uniquely named isolated test databases only。

An unintegrated implementation is removed by a normal reviewed Git revert。An applied migration is never deleted or rewritten；it is corrected by a new forward migration or an independently approved restore / compensation procedure。Changing this ownership decision requires accepted Canonical、ADR and IDR supersession。

## Revisit trigger

Revisit only when a real authorized migration cannot fit an accepted namespace or one-schema ownership rule，or when evidence proves the minimal history control plane is insufficient。Implementation convenience、legacy unmanaged state or a desire for down migrations is not a trigger。
