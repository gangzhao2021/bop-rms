# Local v13 automatic compensation activation

Status: Superseded by [current v14 activation proposal](pilot-v14-compensation-activation-proposal.md); activation unexecuted. Do not activate retained v13. Automatic approval review rejected the generic approval as insufficient for automatic refund execution; an explicit scoped confirmation is pending.

## Exact scope

WP-2402 batch500 proposes enabling the existing compensation workload only for
InternalTest in `.local/pilot-v13`, database `bop_rms_wp2402_pilot_v13` on
127.0.0.1:55435. Change only `business-worker.json` →
`workloads.compensation` from false to true and restart the business worker.
Keep existing cancellation and other workload settings. The configured Provider
is the local SQLite simulator; no live Provider, external account or deployment.
No new grants, schema changes, credentials or fabricated business facts.

The worker discovers genuine Ordering dispositions and executes Payment's
existing fenced, idempotent compensation workflow. It may append compensation,
audit, projection and receipt records and perform simulated refunds for eligible
existing and future dispositions while enabled. Discovery is not itself authority
to refund: the owner evidence, original payment, ordinary refunds and prior
compensation remain checked on execution. Named employee reconciliation
acknowledgment remains a separate operator action; no System acknowledgment.

## Current evidence and authorization boundary

Batch500 read-only preflight on 2026-09-22 found the switch false and two Ordering
candidates. Candidate count does not mean two new refunds: discovery may include
already processed dispositions. No dispatch was performed. Batch499 read both
existing confirmed compensation orders and proved full original order/tip refund
allocation with no pending or unallocated amount, without issuing refunds.

The earlier [v12 access proposal](pilot-v12-compensation-access-proposal.md)
explicitly says automatic worker enablement is outside that request. The user's
six-table access approval therefore remains valid but is not recorded here as
approval of this separate activation. Confirm this concrete scope before running
the prepared activation script.

## Prepared execution

Protected `.local/pilot-v13/compensation500-flag.mjs enable` guards development,
exact installation database/local endpoint and a disabled flag, saves exact
original bytes exclusively, then changes only the compensation boolean through
an atomic private-file replacement. It does not restart or dispatch by itself.
Use the repository `pilot-service.mjs restart business-worker .local/pilot-v13`
entry after the switch. Observe current-process `business-compensation` cycles,
retained event/cancellation/expiry health and persisted owner results. A healthy
empty or duplicate cycle is not positive new-refund acceptance.

Reuse unchanged workload and batch499 consumer tests. Actual activation needs
fresh current-process health and owner readback; no full regression solely for
this configuration toggle. Record any failure and keep the overall pilot open.

## Stop and rollback

Stop the business worker through `pilot-service.mjs stop business-worker
.local/pilot-v13`; wait for its normal drain. Run the prepared flag script with
`rollback`, which restores original bytes only if current configuration still
matches the prepared enabled form, then start the worker and verify remaining
workloads. A configuration rollback stops future automatic attempts; it does not
reverse already recorded refunds or erase append-only evidence. Reconcile an
in-flight or uncertain outcome through existing owner recovery before retrying.
