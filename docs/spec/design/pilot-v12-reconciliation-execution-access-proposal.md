# Local v12 reconciliation execution access

Status: Owner approved and executed in WP-2402 batch468 (2026-09-22 UTC). Guarded execution7d8ce0 verified all three tables have the required read/append privileges; business rows written0.

## Exact scope

- Host: `127.0.0.1:55435`.
- Database: `bop_rms_wp2402_pilot_v12` only.
- Existing role: `bop_rms_wp2402_v4_api` (must remain non-superuser and non-BYPASSRLS).
- Add `SELECT, INSERT` on `rms_payment.payment_reconciliation_run`.
- Add `INSERT` on `rms_payment.payment_reconciliation_record` and `rms_payment.payment_reconciliation_exception`.
- Existing SELECT on record/exception is retained. No UPDATE, DELETE, role creation, RLS bypass, schema change or external service access.

## Purpose and prepared implementation

The running pilot previously had read-only exception projection access. WP-2402 batches461–467 implement complete run readback, atomic append/replay, authoritative terminal occurrence, actual candidate discovery/hydration and dedicated-connection execution locking. The runtime is `tooling/environment/pilot-reconciliation-runtime.mjs`; this permission change does not activate a scheduler or create a business record by itself.

Actual read-only preflight462 confirms all four requested privilege additions are missing. Source discovery/hydration found27 bound local Test payments, including6 with confirmed refunds. Those are existing simulator facts, not live Provider evidence.

Prepared script: `.local/pilot-v12/prepare-reconciliation-execution-access.mjs`. It validates local environment, exact host/port/database and existing restricted role, grants only the listed rights in one transaction and verifies readback before commit. It performs no business INSERT itself.

## Subsequent acceptance

After explicit approval, execute the guarded grant and the composed Operational run against existing local Test payments; retain the run identity for repeat execution. Verify stored complete run/check/exception consistency, exact replay without repeat Provider work and rollback for failed append using an isolated rollback-only scenario. Refresh existing exception projection and inspect any actual differences. Daily settlement, live Provider activation and recurring scheduling remain separate unfinished gates.

## Execution result

WP-2402 batch468 fulfilled this approval. The first actual Operational run persisted27 checks (25 Matched,2 Unresolved). Exact replay performs no Provider queries or extra appends; actual three-table rollback and stable exception-history scenarios passed with no test rows retained. Recurring scheduling and DailySettlement remain unfinished.
