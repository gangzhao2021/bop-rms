# BOP-RMS Specification Index

## Authority

- Canonical Library file: `BOP-RMS Complete Handoff Package.md`
- Source document ID: `BOP-RMS-HANDOFF`
- Source document version: `0.5.8`
- Architecture baseline: `v1.0`
- Current discussion node: `Closed — Section 96`

The complete Handoff Package remains outside this repository and is not duplicated here. Resolve it through the approved Library context using the exact canonical filename. Never store Library credentials, signed URLs, account identities, or private access metadata in Git.

Decision precedence follows Section 0: later numbered accepted sections supersede conflicting older text. Section 80 is the remediation baseline; Sections 86 and 87 close delegated and hardening decisions; Section 88 is authoritative for pages and functions; Sections 89–91 govern repository execution、Codex / Figma operation and GitHub Free solo governance; Sections 92–94 govern database ownership、Domain dependency enforcement and Migration Runner behavior; Section 95 is authoritative for WP-0021 foundation schema behavior；Section 96 is authoritative for WP-0022 helper objects、ownership、ACL、Tenant Context and verifier behavior.

## Active Work Package

- None。WP-0022 is integrated and closed；the next Work Package requires a fresh authorized brief and must not be inferred from sequence alone。

WP-0001 through WP-0022 are integrated into `main` at implementation integration baseline `2f87018d40f67f9717f0aeaab84ef2b815d02298`。WP-0022 documentation、bounded implementation、isolated PostgreSQL verification and final Architecture / Data / Security review passed；PR #16、its owning CI and the post-merge main push CI passed，and the authorized squash merge produced that exact implementation head。This closeout records that evidence without redefining the implementation baseline。Deployment remains gated。

Agents must read the root `AGENTS.md`, this index, and the active Work Package brief before editing. If this index or brief cites an older Handoff version than the current canonical Library file, stop, review the superseding sections, and refresh the bounded brief before implementation. A refresh records the new document version and only the authoritative sections needed by the active Work Package.

## Current repository stage

WP-0021 and WP-0022 are integrated and closed without changing their accepted designs。The Owner accepted Canonical `0.5.8` Section 96、ADR-0033 and IDR-0046 on `2026-07-21`，closing the WP-0022 exact object、ownership、ACL、migration、verification and non-goal decisions。WP-0022 local implementation、complete repository verification、isolated PostgreSQL acceptance、PR #16 owning CI、authorized squash merge and post-merge main CI pass at implementation integration baseline `main@2f87018d40f67f9717f0aeaab84ef2b815d02298`。External Evidence remains gated and unclaimed；no subsequent Work Package is active or implied。

The current accepted floor is：PostgreSQL `18.4`；application-owned business、Command、Event and Correlation IDs use UUIDv7 through `uuid 14.0.1`；a database default may call built-in PostgreSQL 18 `uuidv7()` only for migration / repair paths；the extension allowlist remains only `pg_trgm` and `unaccent`。Money facts use `amount_minor bigint` plus ISO 4217 `currency_code char(3)` and never PostgreSQL `money` or binary floating point。Instants use UTC `timestamptz`，Store zones use IANA identifiers，local operating dates use `date` and wall-clock configuration uses `time without time zone`。Brand is the primary Tenant boundary；Store-owned facts carry both required scopes；critical uniqueness and query indexes include scope；future Brand / Store tables require application authorization plus RLS defense in depth using transaction-local server-resolved context。Cross-domain private-table access remains prohibited。

## WP-0022 accepted decision record

The Owner accepted the following implementation-significant choices in Canonical Section 96 / ADR-0033 / IDR-0046：

1. **Helper inventory and ownership** — accept the exact database objects，signatures and owning schema。Recommended：keep pure technical helpers in a migration-owner-owned shared-infrastructure schema distinct from Module facts，enumerate every object and prohibit tables / business facts。Impact：chooses the long-lived public database contract and WP-0013 ownership evidence。
2. **UUID boundary** — decide whether WP-0022 creates any UUID function/default at all，which columns may use it，and validation behavior for supplied IDs。Recommended：no extension and no universal default；use PostgreSQL 18 built-in `uuidv7()` only in the already accepted migration / repair boundary，leaving ordinary ID generation application-owned。Impact：avoids silently moving Domain identity ownership into PostgreSQL。
3. **Money and decimal contract** — accept exact `numeric(precision, scale)` pairs for rates / percentages / divisible quantities，valid currency-code normalization / validation，business bounds and each rounding mode / allocation remainder rule。Recommended：retain `amount_minor bigint + char(3)` for Money and place calculation / rounding in the Domain unless a narrowly enumerated database constraint helper is proven necessary。Impact：prevents inconsistent tax、quote、payment and reporting results；the accepted text does not supply these missing numbers or algorithms。
4. **Time contract** — enumerate any validation/conversion helpers and decide whether Business Date resolution is excluded for WP-1223 or partially implemented now。Recommended：WP-0022 only enforces storage/type and IANA-zone validation contracts；keep versioned Business Day Start、DST gap / overlap resolution and order-number boundary in WP-1223。Impact：avoids two competing Business Date authorities。
5. **Tenant scope contract** — accept exact identifiers / column compatibility，constraint and index templates，RLS metadata boundary，GUC validation behavior and whether WP-0022 creates reusable policy functions without any Tenant table。Recommended：metadata / validation helpers only；actual FK、index and RLS policies remain with each owning-table WP and must follow Section 87.7.5。Impact：prevents a generic helper from becoming an authorization bypass or cross-domain coupling point。
6. **Privilege contract** — accept owner，`SECURITY INVOKER` versus narrowly justified `SECURITY DEFINER`，fixed `search_path`，PUBLIC revocation，function `EXECUTE` defaults，runtime principals and per-object grants。Recommended：default deny、no PUBLIC execute、no advance runtime grant and invoker rights unless an individually threat-modeled definer function is indispensable。Impact：this is a Security / Architecture decision and cannot be inferred from WP-0021 schema ACLs。
7. **Migration and verification contract** — accept exact ordered filenames after `0000_005`，one-schema-per-migration grouping，diagnostic codes / exits，catalog assertions，failure injection and forward-fix behavior。Recommended：immutable ordered forward migrations under Section 94，read-only verification，transaction rollback per migration and no down / repair / baseline behavior。Impact：turns the object decisions into deterministic acceptance evidence without changing the runner。

Dependencies remain：WP-0020 owns catalog / runner behavior；WP-0021 owns the existing foundation schemas / ACL；WP-0023 owns optimistic-concurrency integration；WP-0024 owns reusable seed / fixture / isolated-test database infrastructure。Future business-table WPs own their facts、constraints、indexes、RLS policies and least-privilege grants。WP-0022 must not create business tables、Tenant / Brand / Store facts、roles / logins、seed data、ORM / Repository code、Outbox / Inbox / Audit / Job / Projection objects or application Money / Business Date logic。

External Evidence remains gated and unclaimed：PostgreSQL 18.4 / Amazon RDS compatibility for every selected built-in or extension，actual migration and runtime roles / memberships，production ACL and RLS matrix，IANA tzdata lifecycle，ISO 4217 update source，query-plan / index evidence，backup / restore，staging migration and production approval。No dependency / lockfile、Provider or external-service change was made；the only database connection was the authorized synthetic isolated acceptance suite。
