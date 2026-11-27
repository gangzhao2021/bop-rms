---
name: restricted-role-acceptance
description: How to write and run bop-rms PostgreSQL acceptance tests (packages/database/test/*-acceptance.test.mjs) so they prove the pilot really works — code under test runs as a restricted NOBYPASSRLS role holding exactly the rendered pilot ACL, and the test is shown to fail against the defective code first. Use whenever a change adds or alters persistence, a store/command that writes or reads tables, RLS policies, grants, append-only tables, concurrency/locking, or when a v15 live test fails with UNAVAILABLE/DENIED although database tests passed.
---

# Restricted-role database acceptance

**Why this exists.** The owner client bypasses row-level security and holds every grant. A test
that runs the code as owner can pass while v15 fails (2026-10-07: Brand-level audit rows were
refused live because the Store GUC was still set; a missing GRANT surfaced seven layers deep as
`*_UNAVAILABLE`). So: setup as owner, everything under test as the pilot API/worker role.

## Pattern

Copy the setup from an existing test rather than inventing one —
`packages/database/test/store-hours-setup-draft-acceptance.test.mjs` is a current example.

1. `withIsolatedDatabase({ caseId }, async (context) => { ... })` from
   `packages/database/test-support/isolated-database.mjs` (fresh migrated database).
2. Create per-run roles: `CREATE ROLE <api> NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`
   (and `<worker>`), names suffixed with `context.runId`.
3. Grant exactly the pilot ACL:
   `renderPilotAclSql([pilot-acl-matrix.json, pilot-acl-additions.json], { api, worker })` from
   `tooling/environment/pilot-acl-render.mjs`, reading both files from `docs/spec/`. Never add
   ad-hoc GRANTs in the test — if the code needs a privilege, the pilot needs it too, so add it to
   `pilot-acl-additions.json` with approval text (standing Owner approval 2026-10-14 + WP item).
4. Each unit of work under test: own client, `BEGIN`, `SET LOCAL ROLE <api>`,
   `SET LOCAL statement_timeout`, then the real store/command (import from `apps/api/dist/...`
   when the composition lives there — rebuild it first).
5. Seeds and fixtures stay on the owner client. When a fixture inserts operation/authoring rows,
   set the Brand (and Store/Tenant where the guard asks) scope at session level first; WP-2423
   append-only tables cannot be mutated by fixtures.

## What to assert

- The ordinary flow end to end, including audit/event rows and expected-version increments.
- Tenant/Store isolation: a second store's role or GUC sees and changes nothing.
- Concurrency where two staff can act at once: use deterministic lock barriers (poll `pg_locks`
  for a waiter, as the example does) instead of sleeps; the loser gets 409 "changed, refresh",
  never 503 or 403.
- Money in integer minor units/decimal strings; time as UTC instants with explicit Business Date.

## Prove the test bites

Before trusting it, run it against the defective code (stash the fix or revert the line) and
see it fail for the right reason, then pass with the fix. Record both in the WP line.

## Run

Each test has its own config `packages/database/vitest.<name>.config.ts`; add one for a new test
and append it to the `test:database` chain in the root `package.json`.

```bash
source .local/activate.sh
TMPDIR=/private/tmp vitest run --config packages/database/vitest.<name>.config.ts
```

If an error is only `*_UNAVAILABLE`, the nested reference sources rewrote the real cause:
temporarily log every `catch` and print errors whose `code` is not
UNAVAILABLE/DENIED/CONFLICT/CHANGED — usually a missing GRANT or RLS policy mismatch.
