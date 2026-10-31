# Local v12 refund MFA access proposal

Status: Accepted by the Owner on 2026-09-21 through the explicit v12 approval reply. Execution and evidence are tracked in WP-2402 batch355.

## Observed blocker

The v11 blocker was preserved during the batch288 data and existing-ACL transfer to v12. Fresh read-only probe ea13f0 confirms the configured API role cannot SELECT or acquire FOR SHARE on bop_identity.workforce_mfa_status, and the configured InternalTest employee has no row.

## Exact proposed change

Only local PostgreSQL at127.0.0.1:55435, database bop_rms_wp2402_pilot_v12. Verify current environment/profile/database before execution.

1. Grant SELECT on bop_identity.workforce_mfa_status to bop_rms_wp2402_v4_api.
2. Grant UPDATE(actor_id) on that table to the same role, as required by PostgreSQL for the existing FOR SHARE query. This is an actual column-update privilege, not a read-only grant; no actor_id update is planned. It applies to this table in this local database.
3. For the employee already configured in .local/pilot-v12/internal-test-merchant.json, insert a missing MFA record with status Required, null Provider evidence, null verified_at/reset_at, and initial version per the current schema. Preserve any existing row unchanged. Do not create an employee or invent a completed challenge.

Before executing, inspect the current schema and use a single guarded transaction. Capture only bounded result counts/status; do not expose employee references or credentials. Inspect post-change privileges and rerun the one affected rollback preparation case. Do not rerun unrelated suites.

## Boundaries

No real Provider call, refund dispatch, verified MFA claim, independent approval, publishing role, production access, or other grant is included. Required remains unverified. Refunds requiring independent approval and recent MFA must continue to fail until those conditions are actually established. This change does not prove refund readiness.

Earlier automatic approval review rejected the proposed MFA permission change; general autonomous development authorization has not been treated as approval to retry it. The Owner subsequently approved this exact v12 scope on 2026-09-21; the earlier rejection is retained as history, not a current approval gate.

The guarded transaction `.local/pilot-v12/prepare-internal-refund-mfa-read-access.mjs` executed successfully in WP-2402 batch355 on 2026-09-21 (e37ede). Schema inspection34f99c matched the intended columns. Before/after probes b411a2/ae1eb6 changed can_read/can_lock from false to true and the missing configured employee row to Required (one row). No verification was created. The affected real-command preparation probe111df8 returned Created and rolled back; the Provider was not called by that probe. Subsequent normal UI simulated refund acceptance is recorded in WP-2402 and the single-store runbook. This is local InternalTest evidence only.
