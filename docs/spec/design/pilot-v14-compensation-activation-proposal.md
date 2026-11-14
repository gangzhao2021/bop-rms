# Local v14 automatic compensation activation

Status: Owner authorized and activated (2026-09-22), batch553. Only the compensation flag changed; business worker restarted successfully. Fresh matching-process health and existing compensation financial readback passed. Batch554 proves a new positive late Pickup automatic refund (CAD22.60) with blocked Kitchen release and persisted Original/Refund receipts. Batches555–556 prove actual workbench acknowledgement and automatic Closed/Reconciled status with unchanged refund and receipts, after fixing numeric lease-history ordering. Supersedes the pending v13 activation request;
this is the same outstanding capability on the active runtime, not a new refund rule.

## Exact change

Only on `127.0.0.1:55435`, database `bop_rms_wp2402_pilot_v14`, change
`.local/pilot-v14/business-worker.json` -> `workloads.compensation` from false to
true, retain every other setting, then restart only the business worker.

The existing Payment compensation workload may perform **local simulated refunds**
for current and future eligible Ordering dispositions. Every execution still
requires existing owner disposition, original linked Payment, refundable balance,
scoped authority, stable idempotency and append-only Audit/receipt evidence.
Candidate presence alone is not permission or evidence of a new refund.

No live Provider, external account, new database grant/schema/credentials or
production deployment. The CAD22.60 Provider-only capture with no internal
operation is not an eligible linked Order disposition and is not resolved or
refunded by this switch. Personnel follow-up remains independent.

## Concrete preparation and rollback

Private `compensation552-preflight.mjs` reads public Ordering candidates only.
`compensation552-flag.mjs enable` validates development, exact installation/endpoint,
private regular config file and currently false flag; preserves original bytes
exclusively and atomically replaces only the boolean. It does not restart by itself.

After approval, use existing `pilot-service.mjs restart business-worker
.local/pilot-v14`. Observe the new process's compensation and existing workload
health; verify owner results and a positive eligible compensation journey.
An empty or duplicate healthy cycle is not positive new-refund acceptance.

To disable, stop/drain the business worker, run `compensation552-flag.mjs rollback`
only if config still exactly matches this prepared enabled state, then restart.
Rollback prevents future attempts; it never erases or reverses committed refunds.
Unknown outcomes must be reconciled before another operation.

## Authorization history

Earlier compensation table-access approval explicitly excluded automatic execution.
Automatic approval review previously rejected activation without specific approval
of simulated refund execution. The recent two-table approval covers capture evidence
and follow-up history only. This question replaces the old v13 activation question;
one explicit reply approving this v14 scope is sufficient.

Owner has now explicitly authorized the pending v14 activation. The earlier rejection is resolved for this exact local simulated-compensation scope; no additional approval is required to execute it.
