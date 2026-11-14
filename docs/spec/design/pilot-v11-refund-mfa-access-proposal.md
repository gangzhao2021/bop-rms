# Local v11 refund MFA access proposal

Status: Awaiting explicit Owner approval. No changes executed.

## Observed blocker

WP-2402 batch280 actual rollback-only refund preparation reaches the Identity MFA query. Independent read-only probe092064 confirms the configured API role cannot SELECT or acquire FOR SHARE on bop_identity.workforce_mfa_status, and the configured InternalTest employee has no row.

## Exact proposed change

Only local PostgreSQL at127.0.0.1:55435, database bop_rms_wp2402_pilot_v11. Verify current environment/profile/database before execution.

1. Grant SELECT on bop_identity.workforce_mfa_status to bop_rms_wp2402_v4_api.
2. Grant UPDATE(actor_id) on that table to the same role, as required by PostgreSQL for the existing FOR SHARE query. This is an actual column-update privilege, not a read-only grant; no actor_id update is planned. It applies to this table in this local database.
3. For the employee already configured in .local/pilot-v11/internal-test-merchant.json, insert a missing MFA record with status Required, null Provider evidence, null verified_at/reset_at, and initial version per the current schema. Preserve any existing row unchanged. Do not create an employee or invent a completed challenge.

Before executing, inspect the current schema and use a single guarded transaction. Capture only bounded result counts/status; do not expose employee references or credentials. Inspect post-change privileges and rerun the one affected rollback preparation case. Do not rerun unrelated suites.

## Boundaries

No real Provider call, refund dispatch, verified MFA claim, independent approval, publishing role, production access, or other grant is included. Required remains unverified. Refunds requiring independent approval and recent MFA must continue to fail until those conditions are actually established. This change does not prove refund readiness.

Earlier automatic approval review rejected the proposed MFA permission change; general autonomous development authorization has not been treated as approval to retry it. This proposal requests explicit approval for the current v11 scope.
