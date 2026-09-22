# Exhausted Outbox recovery for the single-store pilot

WP-2402 implementation design, within the accepted WP-0033 manual recovery boundary.

## Problem and authority

Order2's retained version4 OrderConfirmed exhausted eight automatic delivery attempts.
Later aggregate versions remain blocked, including the paid third batch created after Cart
replacement. WP-0033 Dead-letter lifecycle permits an authorized retry to create a new
bounded schedule and requires append-only action evidence. Its Ordering and release rules
retain the same Event/Aggregate identity. Existing applyDeadLetterCommand instead rejects
Outbox rows at attempt_count8. The automatic eight-handoff policy remains unchanged.

This design supplies the missing manual recovery path; it does not authorize discard,
ordering release, count reset, business fact reconstruction or an arbitrary success flag.

## Bounded operation

A current operator with eventing.dead-letter.retry, RELIABILITY_RECOVERY purpose and a
DEPENDENCY_RECOVERED or TRANSIENT_RECOVERED reason requests one exact dead-letter version.
Brand/Store, Actor, event identity, registry revision and operation identity are server bound.
Only an open exhausted Outbox item with eight recorded automatic attempts, no publication,
no lease, no ordering release, and no unpublished earlier aggregate event is eligible.
Missing or inconsistent facts deny scheduling. Retryable transport failure is required;
invalid envelope, rejected transport and unknown commit are not this operation's inputs.

One accepted operation grants exactly one manual transport invocation, within a fixed
five-minute start window and a bounded lease/adapter timeout. It does not change automatic
claim predicates or reset any counter. A different operation requires a fresh operator
request and current expected version. The original action and all attempts remain retained.

## Persistence and execution requirements

An Eventing-owned forward migration must add immutable scoped recovery intent and attempt
records, plus mutable fenced execution state. Records contain technical references and safe
codes only. Forced Brand/Store RLS, uniqueness for operation identity and one active recovery
per event, and append-only protections are required. Intent includes expected dead-letter
version, registry revision, original attempt count, deadline and actor/purpose/reason.

Scheduling locks the exact dead-letter and Outbox row, checks earlier aggregate events and
current authorization, then appends intent/action atomically. It does not clear the old error.

Execution claims the intent under a unique lease and commits the start record before calling
the existing transport with the original Event identity and complete registered consumers.
Each consumer retains its original Inbox idempotency identity. No payload is copied into
recovery metadata. Claiming never increments or resets the old automatic budget.

Acknowledgement must cover every registered applicable consumer. Existing completed Inbox
results are valid duplicates; a validated non-applicable consumer completes its normal Inbox
record. A failed or unknown consumer cannot count as acknowledged. Consumer registry drift,
lease loss or deadline expiry denies completion until explicit reconciliation.

A fenced owner completion transaction records the actual outcome. Only a proven full
acknowledgement may publish the original event and resolve the dead-letter with append-only
action evidence. Failure retains the aggregate block. Crash/unknown outcome never grants
another invocation from the same operation; reconciliation inspects actual persisted consumer
outcomes before a separate authorized retry can be considered. This mechanism must not
claim atomic business rollback across independently committed consumers.

## Required acceptance

- Scope, permission, purpose, version, retry reason and registry binding rejection.
- Duplicate intent replay versus changed-intent conflict, including concurrent operators.
- One invocation per operation, timeout/crash recovery and stale lease denial.
- Full consumer acknowledgement, partial failure and committed duplicate handling.
- Immutable original Event, original eight attempts and append-only manual evidence.
- Real PostgreSQL rollback, tenant isolation and aggregate ordering before/after recovery.
- Actual Order2 version4 recovery followed by normal version5/6 processing, Kitchen work,
  Customer status, serving and corrected receipt; no downstream manual reconstruction.

Current delivery status: eligibility policy and forward schema are implemented; schema
constraints have rollback-only PostgreSQL evidence. The live runtime still has no recovery
tables. Atomic scheduling has rollback-only PostgreSQL evidence. Worker single-invocation orchestration has bounded timeout/late-result tests. Durable claim has rollback-only PostgreSQL evidence; the complete-consumer Inbox verifier is implemented. Fenced completion has rollback-only PostgreSQL evidence for complete receipt gating, publication, resolution and failure rollback. Operator composition, application-role/concurrent execution acceptance
and actual recovery remain incomplete and must precede enabling it.
