# Local v12 Dining exception read access proposal

Status: Owner explicitly approved and executed on 2026-09-21 (WP-2402 batch393).

WP-2402 batch393 uses the actual configured API role to confirm the exact v12
database and role, existing USAGE on rms_dining and bop_task, and existing SELECT
on bop_task.task_version. SELECT on rms_dining.dining_exception_task is absent.

## Exact change

Only database bop_rms_wp2402_pilot_v12 at 127.0.0.1:55435, existing API role
bop_rms_wp2402_v4_api: grant SELECT on rms_dining.dining_exception_task.

No schema privilege, INSERT, UPDATE, DELETE, ownership or BYPASSRLS change.
No business rows or service activation. Existing tenant/Brand/Store isolation
and development binding expiry remain required. Task history already has read
access, so this proposal grants it nothing additional.

Prepared script: .local/pilot-v12/prepare-dining-exception-read-access.mjs.
It checks the exact local environment, host, port, database and existing target
role without superuser/BYPASSRLS; grants the one SELECT atomically, verifies it
before commit, and rolls back on failure. It embeds and prints no credentials.
After approval, verify the configured API role through the public Dining reader.
An empty page proves only read access, not a positive operational journey.

This approval is independent of the already executed MFA/projection access and
pending cancellation, compensation and reconciliation proposals. It enables
Dining discovery and Task association hydration only; financial dependencies,
projection lifecycle and complete pilot acceptance remain separate requirements.

## Execution evidence

Owner approved this exact single-table SELECT in the current task. Run 4e3a2a
committed the guarded grant. Run fc5915 used the actual configured API role and
confirmed the exact database and role, SELECT true and INSERT/UPDATE/DELETE false.
The public Dining discovery/current-Task reader succeeded with zero items and no
next page. This establishes live read access only; no positive exception Task or
financial resolution was available to validate. No business rows were inserted,
services restarted, or other outstanding proposals executed.
