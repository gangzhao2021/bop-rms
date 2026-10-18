# Provider capture reconciliation for the local pilot

## Current implementation state

The active local runtime is v14/canonical198. Batches543–548 record actual
Provider-first discovery, immutable evidence/Audit, authenticated personnel
follow-up and live HTTPS browser acceptance. The configured reconciliation CLI
now enables bounded capture review each cycle; automatic compensation remains
disabled. Earlier batch descriptions below describe their state at that time.

Batch549 adds a scoped Payment evidence-summary query: original CAD amount,
occurrence/observation timestamps, environment and recorded discovery reason.
It exposes no Provider, account, operation or employee identifiers. This remains
historical evidence, not current operation linkage or financial finality.
Batches550–551 complete authenticated API/UI composition and livev14 HTTPS
summary-read acceptance for the historical CAD22.60 capture. Viewing evidence
does not change follow-up version or close the financial exception.
No operator assertion or suspected test residue authorizes closure.

## Implementation history

WP-2402 batches506–508 found a simulator capture without an internal Payment
operation. Existing Operational checks require an internal intent, and
DailySettlement requires authoritative Business Date evidence. Neither accepts a
fabricated identifier or calendar window. Section16 settlement differences remain
exceptions; original Order and Capture facts must not be rewritten.

Payment owns the capture review and its future append-only exception history.
Provider-first discovery supplies original Provider intent/transaction references,
operation/attempt references, account, Test/Live environment, Brand/Store, CAD money,
original occurrence, observation time and evidence digest. The simulator adapter
remains InternalTest only; a domain contract accepting Live is not Live activation.

First resolve the original operation through the public Payment store. Missing is
an explicit result; an existing operation with different scope, attempt, account,
Provider intent or amount is a conflict, not an excuse to create another payment.
A linked operation only establishes identity, never terminal or settlement success.

Persistence must use stable identity from scope/account/environment/Provider
transaction, re-read owner linkage under the Payment operation fence in the same
transaction, append source evidence and Audit, and make replay idempotent. It must
retain missing Order/intent as null and project a visible open reconciliation
exception. Later linkage or an authorized operator disposition must append history;
it must not overwrite the captured journal or manufacture a completed refund.
Ordinary refund/compensation authority does not authorize refunding an unlinked
journal record. Raw identifiers and full Provider evidence remain Restricted.

Batch509 implements the evidence and binding-review boundary only. Exception
persistence, migration/access review, scheduler, workbench and operator resolution
remain required. Existing reconciliation modes and records are unchanged.

Batch510 uses the existing standalone reconciliation exception identity and its
null-link projection. A new Payment evidence table binds the original Provider
capture to that exception through a composite scope/candidate foreign key. No new
reconciliation mode is needed. Migration and atomic writer acceptance are separate
from existing database access approvals.

Batches511–512 implement and exercise the atomic writer on a fresh197 database.
Concurrent replay creates exactly one exception/evidence/Audit; real audit SQL
failure and final authorization revocation roll back all writes. A restricted
NOBYPASSRLS role cannot read other Brand/Store evidence or UPDATE records. The
trusted Provider verification port still needs actual simulator composition before
activation; this test does not establish real historical-case resolution.

Batch513 adds configured simulator journal exposure and a bounded review
composition. It re-reads journal evidence under the writer transaction and uses
stable Provider-transaction identities for replay; failed pages retain the original
cutoff and cursor. Ten focused tests pass, but joined actual database and workbench
acceptance and runtime activation remain pending.

Batch514 completes the isolated joined simulator → PostgreSQL exception/evidence/
Audit → existing exception Projection path, including reconstructed scanner and
projection replay. The real historical v13 entry has not yet been processed.

Batch516 connects the bounded capture page to the reconciliation worker before
operational reconciliation and projection, sharing the configured simulator and
its close lifecycle. The explicit providerCaptureReview option defaults false;
the active CLI does not enable it. Invalid counts or scan failure stop downstream
processing. Activation requires a canonical197 runtime, scoped evidence-table
access and a configured enabled entry point. Nine focused worker tests pass;
this is lifecycle wiring evidence, not active-runtime or operator resolution.

## Personnel follow-up and financial finality

Batch522 introduces Payment-owned strict Acknowledge/Assign follow-up transitions.
Tenant/Brand/Store/exception identity, named actor, operation reference, expected
version and monotonic UTC are explicit. Assignment can precede acknowledgment;
later acknowledgment preserves the assigned owner and original opening timestamp.
The first acknowledgment actor is retained. Neither action resolves the difference.

This pure transition does not authorize or persist a command. The transactional
service must validate current employee authority and assignee Store membership,
read original owner exception and current version under a scoped fence, enforce
idempotent replay and append history with Audit atomically. Projection may consume
only committed owner facts. Resolve requires a separate fresh verified owner
outcome; an operator assertion, supporting diagnostic case closure or suspected
historical test residue is insufficient. Financial source records remain intact.

Batch524 adds canonical198 append-only personnel follow-up history. Batch525
implements its scoped owner repository. Batch526 proves actual PostgreSQL
transaction/Audit rollback, concurrent replay, version conflict and effective
Tenant/Brand/Store isolation with a restricted role. Original financial exception
facts stay Open; these personnel operations do not establish financial finality.
Production employee/assignee authorization, HTTP command integration, projected
follow-up and rendered actions remain to be completed. Existing197 upgrade
rehearsal is historical evidence and must not be presented as a198 cutover.
