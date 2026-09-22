# v12 Dining exception task append access

Status: Owner approved and executed. WP-2402 batches451/453.

Actual current restricted-role check dbf94b finds employee task.create,
task.assign and dining.session.close allowed, but INSERT unavailable for both
bop_task.task_version and rms_dining.dining_exception_task. SELECT already exists.
Earlier exception approval covered SELECT, not these new writes.

## Exact change

Only local PostgreSQL 127.0.0.1:55435, database bop_rms_wp2402_pilot_v12,
existing role bop_rms_wp2402_v4_api:

```sql
GRANT INSERT ON bop_task.task_version, rms_dining.dining_exception_task
TO bop_rms_wp2402_v4_api;
```

No UPDATE, DELETE, TRUNCATE, role membership, BYPASSRLS or schema ownership change.
The script adds privileges only; it creates no business tasks or history.
Public Task/Dining owners retain current permissions, scope, version checks,
append-only records, audit and one transaction with session closing.

## Prepared execution and acceptance

Private script: .local/pilot-v12/prepare-task451-append-access.mjs. It verifies
exact database/host/port/environment and non-superuser/non-BYPASSRLS target,
uses a transaction and verifies INSERT before commit. Executed after Owner approval;10716f confirms both INSERT privileges before commit.
Batch454 passes restricted-role creation/assignment, exact replay and failure/outer
rollback checks. The positive normal closing/workbench journey remains pending. No direct insertion of fabricated source facts.

Explicit InternalTest routing will use the existing protected queue, a one-hour
synthetic test deadline (as in batch131), and newly identified test policy records.
These do not claim a production Manager organization, escalation service or SLA.
