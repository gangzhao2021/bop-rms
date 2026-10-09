# Single-store Pilot Delivery

Project status navigation: [candidate register](./project-candidate-register.md), [scenario evidence](../spec/design/business-scenario-coverage.md#current-scenario-evidence-view), and [remediation results](./project-documentation-remediation.md). Windows/WSL batches and macOS source-tree checks retain separate host/revision/diff identities; subsequent changed inputs require an explicit evidence-applicability review.

Owner direction: 2026-09-10. Target: one Store, Dine-in and Pickup.
This is the active delivery sequence, not evidence of operational readiness or a promised date.
Delivery and later-phase expansion retain their existing gates.

The [current acceptance table](#current-acceptance-and-remaining-work) is the single
status summary for these milestones. It distinguishes proven local InternalTest flows
from remaining recovery, operating handover and real Store activation conditions.
Historical journey records later in this document preserve their original scope; they
do not override that table or establish live Provider readiness.

## Accepted deployment and login scope (2026-09-22)

The Owner selected the current Windows/WSL installation for the present local
InternalTest demonstration, using the existing local test employee account. Later
migration targets a cloud Linux host. Enterprise employee-directory integration,
real Store activation and real Payment remain later gates; do not block the present
local demo on a fictitious enterprise account or claim those later gates passed.

Use manual startup with the existing WSL commands below. No Windows scheduled task,
WSL boot configuration or automatic machine startup has been installed by this
choice. After a machine reboot, start Docker Desktop and Ubuntu/WSL, then run the
existing startup/readiness command from `/home/gangzhao/src/bop-rms` using the pinned
Node/pnpm toolchain. Start supervision after readiness succeeds. If maintenance is
present, follow its diagnosis rather than force a start.

When rebuilding the customer frontend for this local InternalTest installation,
use the explicit configuration below; an ordinary production build disables the
internal root-entry loader and simulated-payment UI:

```bash
VITE_BOP_INTERNAL_SIMULATED_PAYMENT=1 pnpm --filter @bop-rms/customer-pwa build
```

This flag is for the existing localhost simulation only; keep it absent for formal
production builds. After browser/test harness builds, restore this configured
artifact before continuing the local demonstration. Batch617repairs an observed
root-page fallback caused by a disabled build-time flag; no QR-token URL is needed.

Current demonstration entry points:

- [Employee workspace](https://127.0.0.1:4443/internal-test/staff): choose
  `Enter DEMO staff workspace`; no new employee password or role is required.
- [Pickup ordering](https://127.0.0.1:4443/): the supported local root entry loads
  the synthetic Pickup context through the existing protected entry endpoint.
- [Dining table selection](https://127.0.0.1:4443/internal-test/dining): select the
  table assigned in the staff workspace and use its current joining code.

Use synthetic orders and simulated payments only. The local TLS certificate and
private installation remain protected; the separately approved batch600 imported the exact localhost public certificate
into the current Windows user's Root store, with normal Windows HTTPS verification.
No LocalMachine trust was changed. See the
[certificate scope and rollback](../spec/design/pilot-windows-demo-tls-trust-proposal.md);
the certificate expires2026-10-20. Future cloud migration must preserve paired database/simulator and
installation recovery material, replace local demo identity/payment with approved
services when entering real operations, and prove host startup/recovery there.

## Windows/WSL InternalTest candidate recorded 2026-09-22

Current code/config identity recorded by616: HEAD
`a0f35440cacff1ab55be78edfb08cb4de90c1a26`, with3366current inputs summarized by
SHA256 `98ec992f549ec323145eb625474deda4e6fe8015f1ace75fd5bc4b6f6eedb1b5`.
The private `.local/pilot-v14/candidate616-inputs.json` lists per-file hashes for
apps/packages/tooling/workflows and selected root configuration. It excludes
private installation, business data and documentation; it identifies these current
inputs only, not prior test revisions or a signed release. Any covered code change
requires a new identity and assessment of affected evidence.

Use the existing ignored `.local/pilot-v14/` configuration and database
`bop_rms_wp2402_pilot_v14` (198 canonical migrations, WP-2402 batch546).
The fresh quiesced v13 snapshot and canonical upgrade preserved 8709 business rows,
354 original object ACL entries, 16 column grants, all30 installation files and
the paired simulator. The upgraded target has383 business tables; the two new
Payment tables received the separately approved SELECT/INSERT grants. All seven
services passed startup/readiness. Batches553–556 enabled and verified automatic
local simulated compensation through actual operator acknowledgement and closure.

The original v13 database/configuration and `recovery-546` remain retained. **Do not
start v13 after v14 has accepted writes without reconciling those writes.** Older
v12/v11 installations are historical recovery material. Recovery does not mean
merely restarting an older database. The historical instructions below do not
select the current runtime.

From the repository root in WSL2/Linux with the pinned Node and pnpm versions:

```bash
NODE_ENV=development node tooling/environment/pilot-start.mjs .local/pilot-v14 --require-compensation --require-batch-cancellation --require-dining-exception-projection --require-reconciliation-projection --require-daily-settlement
node tooling/environment/pilot-service.mjs health business-worker .local/pilot-v14
node tooling/environment/pilot-service.mjs health kitchen-queue-worker .local/pilot-v14
node tooling/environment/pilot-service.mjs health dining-exception-worker .local/pilot-v14
node tooling/environment/pilot-service.mjs health reconciliation-worker .local/pilot-v14
node tooling/environment/pilot-service.mjs health daily-settlement-worker .local/pilot-v14
```

For supervisor status or controlled maintenance, use:

```bash
node tooling/environment/pilot-supervisor-control.mjs status .local/pilot-v14
node tooling/environment/pilot-supervisor-control.mjs stop .local/pilot-v14
```

Stop supervision before service stop/restart or recovery. The controller waits for
its in-flight scan to drain; it verifies the Linux process start identity before
signalling. Recovery holds a maintenance lease through snapshot, restore and service
resumption. Once maintenance is complete and services are ready, enable supervision:

```bash
node tooling/environment/pilot-supervisor-control.mjs start .local/pilot-v14
```

Repeated start adopts the same supervisor. Unknown process identities and stale
leases fail closed; do not delete locks blindly. If status explicitly reports `stale`,
use the controller to remove only the verified exited-process lease, then start:

```bash
node tooling/environment/pilot-supervisor-control.mjs clear-stale .local/pilot-v14
node tooling/environment/pilot-supervisor-control.mjs start .local/pilot-v14
```

A controller error is not permission to remove the lock manually. A live process with
an unexpected identity is deliberately refused. Batch569 verifies actual child-process
exit, stale cleanup and refusal to clear or signal a live unrelated child; it does not
prove recovery after an OS reboot or clear a stale maintenance lease.
Recovery attempts are bounded to
three per service with backoff; sustained healthy process identity resets that
budget. A running process is not proof of business readiness or financial success.

Daily settlement runs in its own process (batch494), using the last fully closed Store
Business Date and durable run identity. Batch498 adds oldest-first backlog processing
from protected `daily-settlement-coverage.json`, with the first fully supported
2026-09-20 window bound to its original Store configuration evidence. Keep this file
with the installation keys/configuration during recovery. Discovery is bounded to3660
days and refuses gaps; earlier initial partial-day coverage is not claimed.
Actual v13 evidence confirms a matched run,
restart reuse and repeated background cycles without changing the persisted result.
A daily worker failure remains visible through its own health and does not terminate
the operational reconciliation/projection process. Backlog ordering and restart recovery
have focused tests; actual v13 currently reuses its one eligible completed day.
Batch561 verifies the new supervisor recovering an actual terminated daily-settlement
worker to a new process with a completed cycle. Duplicate supervisor startup and
maintenance stop are rejected while supervision is held; shutdown drains and releases
the lease. Continuous local process supervision is enabled in batch563 after actual maintenance
exclusion acceptance. Batch562 adds identity-checked start/status/stop commands;563
holds maintenance exclusion across the complete recovery operation. This does not
provide OS/WSL reboot startup or certify every failure mode. Batch495 adds at most three
backoff retries for explicitly recognized daily dependency-unavailable failures; other
workloads keep their existing failure behavior. Batch496 proves one real PostgreSQL
connection-acquisition outage in an isolated restored installation: the same process
retries successfully and persists a matched check after connectivity returns. This does
not certify all-worker recovery, database restart or external Provider resilience.

The startup command adopts matching running services without restarting them.
It requires API database readiness, completed cycles for all declared business
workloads and Kitchen, completed fresh Dining exception and reconciliation recovery cycles, and a
CA-validated HTTPS shell. Use
`https://127.0.0.1:4443/internal-test/staff` for the configured DEMO employee entry.
Detailed service commands are in [environment recovery](../../tooling/environment/README.md#existing-isolated-pilot-service-recovery-wp-2402).
These commands assume the private configuration and database already exist;
they do not install a fresh machine or approve real Store activation.

## Interrupted maintenance diagnosis

Read maintenance ownership before attempting to recover an interrupted stop or backup:

```bash
node tooling/environment/pilot-maintenance-status.mjs .local/pilot-v14
```

`OwnerActive` means the recorded boot/process-start identity is still present.
`OwnerExitedReviewRequired` and `OwnerIdentityChangedReviewRequired` retain the
lease and block new service mutations. `NoMaintenanceLease` means only that this
lock is absent; it is not a readiness result. Legacy, malformed or changing leases
produce an unavailable error rather than a cleanup instruction.

Do not apply the supervisor's clear-stale command to maintenance locks. Docker
backup/restore activity may outlive its parent. Before releasing maintenance,
inspect the interrupted operation, any remaining Docker/database work and whether
the paired database/simulator snapshot is complete. Do not start a partly restored
target or switch installations merely because the parent exited.

For an exited `Stop` owner, when all seven services have already stopped, use:

```bash
NODE_ENV=development node tooling/environment/pilot-maintenance-clear-stop.mjs .local/pilot-v14
```

The command rechecks process identity, service PID files, ingress ports, worker discovery,
and competing supervisor/restart locks before releasing the unchanged maintenance lease.
It does not signal or start services. `StoppedMaintenanceReleased` means the stop is
confirmed; run the normal startup procedure separately when ready. A surviving service,
unknown PID, active/changed owner, `Recovery`/`Unspecified` operation or concurrent cleanup
retains the maintenance lock and reports unavailable.

If the original Stop owner exited while some services remain, explicitly finish the stop:

```bash
NODE_ENV=development node tooling/environment/pilot-maintenance-clear-stop.mjs .local/pilot-v14 --finish-stop
```

This mode stops ingress first, then the five workers, using the normal service command's
PID, executable, arguments and process-start identity checks. It never force-kills an
unknown process, starts services or takes over a Recovery lease. The temporary maintenance
access permits only stopping; nested maintenance, start and restart remain blocked. Any
failed stop retains the original lease and permits another explicit attempt after the cause
is resolved. The lease is removed only after all seven independent stopped checks pass.
Successful release still leaves services stopped; follow normal startup separately.

A leftover `maintenance-clear-stop.lock` after the cleanup controller itself was interrupted
requires manual review; do not remove it while a cleanup process might still be running.
Batch582 covers actual original owner exit and surviving-process refusal;583 adds ordered
partial-stop/retry and stop-only context tests, plus real wrong-PID signalling refusal.
Batch584 additionally proves actual v14 partial-stop recovery: customer ingress stopped,
control process exited with the Stop lease retained and API still running, finish-stop
confirmed all seven services stopped, and normal full-feature startup restored them and
supervision. The private drill wrapper initially rejected the supervisor's successful
`started` response; independent status confirmed `running` and no maintenance lease,
without repeating the drill. Interrupted backup/restore recovery and OS reboot acceptance
remain unresolved; these Stop modes do not establish completed recovery from an interrupted
restore.

For new recovery runs, the private recovery folder contains durable
`dump-started.json` / `dump-completed.json` and
`restore-started.json` / `restore-completed.json` phase records. Each Started record
is flushed before Docker execution. A missing Completed record means the outcome
is unknown; it does not prove the in-container process stopped. Even all four
records do not establish a complete paired snapshot: the recovery command must
also verify PostgreSQL contents, simulator integrity and installation files before
writing its final evidence.

Batch588 changes Docker command/phase-record failure handling: the Recovery lease
is retained and source auto-resumption is suppressed. Inspect remaining Docker and
database activity and the private recovery evidence before deciding how to resume.
Neither Stop cleanup mode can release this Recovery lease. Command timeout/nonzero
exit must not be interpreted as cancellation of the in-container job. This adds
safe failure containment; interrupted-restore resolution remains an outstanding
operational requirement.

Batch591 extends failure containment to the whole recovery after stopping begins:
source/target/installation integrity failures, incomplete stop and resource-cleanup
failures also retain the Recovery lease and suppress automatic source restart.
Seven injected orchestration cases with real private maintenance locks cover these
outcomes and normal completion; no new live interruption drill was run. A retained
lease still requires interrupted-operation review before any resumption.

Batch592 writes private `source-baseline.json` before the first Docker dump command,
after services stop and the simulator is copied. It records source/target/container
binding, PostgreSQL/simulator inventories, the installation manifest digest, required
restart features and a hash of the original Recovery lease. Exclusive creation and
file/directory synchronization preserve the record; failure blocks the command.
This baseline is evidence for subsequent source comparison, not an unlock token or
proof that an interrupted restore has ended. Earlier snapshots lack this record and
must not be treated as if it had existed before their operations.

Batch593 adds a read-only review for interrupted operations that already have a
batch592 baseline. From the repository root, use the original recovery arguments:

```sh
NODE_ENV=development node --import ./tooling/environment/register-workspace-typescript.mjs tooling/environment/pilot-recovery-review.mjs <runtime-directory> <isolated-target> <container> <recovery-label>
```

The original Recovery owner must have exited. The command checks the unchanged
lease/baseline, stopped services, absence of restart/supervisor controls, container
processes, database connections, source PostgreSQL/simulator contents and installation
backup. `SourceComparisonMatchedReviewRequired` reports only that source comparison
passed; the lock remains, no service starts, and target restoration is unverified.
A remaining dump/restore/shell process, unknown process, active connection, changed
source, missing baseline or changed lease blocks comparison. Review and controlled
resumption remain required; this command is not a release mechanism. Its current
evidence is injected boundary tests plus actual Docker output-format inspection,
not an actual interrupted database recovery acceptance.

The Owner approved local v14 source resumption on2026-09-22 in the
[source-resumption proposal](../spec/design/pilot-v14-recovery-source-resume-proposal.md).
For that authorized scope, batch596 adds the explicit controller:

```sh
NODE_ENV=development node --import ./tooling/environment/register-workspace-typescript.mjs tooling/environment/pilot-recovery-resume.mjs <runtime-directory> <isolated-target> <container> <recovery-label>
```

It acquires an exclusive private resume control, performs a fresh source review,
retains the original lease during startup and records Started/Completed privately.
Only successful original-service readiness and completed recording release that
unchanged lease. Existing attempt records or a concurrent controller block startup.
Startup/record failure attempts to stop all services and retains maintenance; source
writes from a partial restart may require further review. A leftover controller or
attempt record must not be removed blindly. After `SourceResumed`, confirm no
maintenance lease, then use the existing supervisor start command above.

Batch610 records private Linux boot/process-start identity, recovery label and
original lease digest before source review. The controller rechecks its unchanged
owner record before service actions and lease release, and removes only its own
unchanged metadata during normal cleanup. Diagnose a leftover control read-only:

```sh
node tooling/environment/pilot-recovery-resume-owner.mjs .local/pilot-v14
```

The explicit successor-controller implementation is prepared under
[the takeover proposal](../spec/design/pilot-v14-resume-takeover-proposal.md).
The Owner-authorized615exercise proves actual before-start controller interruption
and explicit original-source resumption. Do not infer permission to delete a
stale control from an exited-owner diagnosis. Each successor retains prior evidence
and uses separate attempt records; missing lease or an orphaned takeover guard
requires review rather than automatic release.

`NoResumeControl` means no control directory was found. `OwnerActive` means its exact
recorded process is still present. `OwnerExitedReviewRequired` and
`OwnerIdentityChangedReviewRequired` require inspection of the original lease,
Started/Completed evidence, source state and running services; they do not authorize
retry or lock deletion. `OwnerUnrecordedReviewRequired` covers an older empty control
or interruption before metadata was recorded. Malformed, linked or public metadata
fails closed. For a confirmed exited owner, batch611also binds the attempt markers and original
lease digest. `BeforeStartupReviewRequired` has no Started/Completed marker;
`StartupInterruptedReviewRequired` has Started only;
`CompletionRecordedReviewRequired` has both, in order and bound to the same lease.
`OriginalPresent` means the current lease bytes match that attempt. An absent lease
is reported only with valid Started/Completed evidence as
`AbsentAfterCompletionRecord`; it does not prove present service health or supervisor
resumption. Conflicting, changed, linked/public or incomplete evidence fails closed.
Active owners are not classified from changing attempt files.

This command changes no files or services. Actual child-exit tests
prove identity diagnosis; resuming a crashed controller after partial startup is
still unimplemented and must not be claimed from these results.

Batch597 observes actual pg_restore, terminates only its own Docker client, waits
for container work to end and compares the original v14 source. The first resume
attempt refused before startup for an undetermined cause; a later full review of
the same baseline/lease passed and source resumption completed. All required source
services passed readiness, the unchanged lease was released and supervision
restarted. The isolated target was never promoted; no Restore Completed marker was
fabricated. This covers this client-interruption/source-resumption case, not OS
reboot or interrupted-resume-controller recovery.

Batch589 verifies the current normal recovery path against v14: the separate restored
database matches 384 PostgreSQL tables / 21,249 rows; the paired simulator matches
4 tables / 65 rows; all 30 installation files and four private phase records are
preserved. The source services and supervision were restored, and applications were
not switched to the target. This proves normal recovery with the new phase records,
not resolution of an interrupted Docker command.

Batch590 separately demonstrates actual Docker-client timeout containment in an
isolated temporary container: the container task continued and finished after the
client timed out, while the Recovery lease remained and no Completed phase record
was inferred. The temporary container was removed; the live pilot was untouched.
The private `.local/recovery590` lease is retained test evidence, not the active v14
installation. This proves failure containment, not safe release of an interrupted
restore's lease or a completed source/target recovery decision.

## Daily settlement handover

From the repository root, read existing complete-day results without executing settlement:

```bash
NODE_ENV=development node --import ./tooling/environment/register-workspace-typescript.mjs tooling/environment/pilot-daily-settlement-status-cli.mjs .local/pilot-v14
```

The output lists up to31 days from newest to oldest. `coverageScanComplete` means
this scan reached the configured first complete day; it does not mean every result
exists or matches. Check `missingDays`, `reviewDays` and each day's outcome. A failed
read emits a generic error and no partial success report. Missing results must be
investigated against the daily worker health; this command does not start work.

Batches572–573 read persisted results for2026-09-20 and2026-09-21: both Matched,
with no missing day within the configured complete-day coverage. Today, initial
partial-day history, independent exceptions and real Provider settlement remain
separate. In particular, this does not resolve the known unlinked capture exception.
Include this status plus the current exception workbench and service health in an
operator handover; a Matched day alone is not a complete handover acceptance.

## Current demo handover snapshot (2026-09-22)

Batch602 reads existing authenticated staff queries between14:40:53Z and14:41:06Z.
This is a current operational readback, not an atomic cross-domain financial
snapshot or permission to act on historical demo orders. No business command ran.

| Area                  | Observed state                                                                                            | Operator next action                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders                | 29 total:20Pickup/9Dining;12Submitted,14Fulfilled,2Accepted,1unresolved phase. Full bounded list scanned. | Review the intended order before acting. Historical Submitted rows are not automatically new work, and availability of an acceptance action is not proof that payment/capacity is fulfillable. |
| Kitchen               | 19work items, allCompleted; complete scan and Fresh projection.                                           | No unfinished work item observed in this snapshot. This does not itself prove every order was handed off or every Dining session closed.                                                       |
| Dining tables         | 3tables operationallyAvailable;2have current Dining sessions. Complete scan.                              | Available describes table operational state, not vacancy. Inspect the session before seating, closing or reusing a table.                                                                      |
| Exceptions            | 5rows:1Open/4Resolved; Fresh projection.1Assigned/4Unassigned across the whole list.                      | Review the remaining Open case and its follow-up. Do not interpret resolved/unassigned rows as unowned active work or issue another refund merely to clear the list.                           |
| Closed-day settlement | Covered2026-09-20/21 bothRecorded/Matched;0missing/0review days within configured coverage.               | Current day and initial partial-day history remain outside this completed-day statement. Matched does not dispose of independent exceptions.                                                   |
| Service control       | Supervisor running; no maintenance lease.                                                                 | Use existing startup/maintenance procedures if state changes; no restart is needed for this handover.                                                                                          |

Batch604 resolves the formerly unknown row through validated Ordering history:
all its persisted batches were cancelled; the current phase is Cancelled/version2.
The normal-TLS staff HTTP list now returns29orders with0unknown phases and this
order's acceptance unavailable. The frontend accepts this terminal state without
actionable batches; other known states still require batch membership. Refresh the
existing workspace to load the updated frontend. This is source/HTTP/client-test
and served-asset evidence, not an agent-observed browser rendering.
No automatic closure, cancellation, refund, historical-data deletion or test-data
reset was performed during this diagnosis. The602table remains the historical
snapshot;604supersedes its one unresolved-phase count only.

Private aggregate evidence is `.local/pilot-v14/handover602-summary.json`; no session
cookie, CSRF token, order identifier or personal detail is included. Future reads
may differ as the demo is used. This snapshot supports the handover procedure below;
it is not a receiving operator's acknowledgment of all responsibilities.

## Operator handover acceptance

Status: five-workspace read-only walkthrough completed by the Owner on2026-09-22 (batch608); full operational handover remains incomplete. This is a
local InternalTest handover, not permission to admit real customers or take real
payments. The current deployment is Windows/WSL with the Owner-selected existing DEMO
employee account. A receiving operator must still acknowledge any actual handover.
Trusted real employee identity is required before moving beyond the local demo;
never invent accounts or an acknowledgment.

Operating-mode choice (batch616,2026-09-22): the Owner explicitly requests continued
agent-guided operation and does not take over independent operation yet. Continue
local synthetic/Payment-simulator use under that arrangement; do not repeatedly
request the same independent handover or mark it complete. This does not create
unattended agent monitoring, permanent operational staffing or real Store authority.
An independent handover is needed only when that transition is actually requested.

Owner-observed walkthrough results:

- Orders: Cancelled/version2 is rendered with payment access and without acceptance/serving controls; fresh DEMO re-entry recovered the earlier workspace-unavailable state.
- Kitchen: page renders and all visible work is Completed, as reported by the Owner.
- Dining: three tables render; DEMO-01/03 have linked sessions, DEMO-02 has none. All are operationally Available; this does not establish vacancy.
- Exceptions: Fresh list shows one Open/Assigned difference and four Resolved cases. Owner opened follow-up (Assigned/version3) and simulated CAD22.60 capture evidence. Absence of an internal operation is historical evidence, not a current refund/closure decision.
- Pickup: Fresh current page shows two Ready/Overdue records. Including completed pickups reveals Handed over history. This does not establish a full paginated count or perform another handoff.

Agent readback accompanying the Owner walkthrough (batch608,2026-09-22):
supervision is running with no maintenance lease. All five required workers have
recent completed cycles and no latest-cycle failure, including business event,
payment-wait and Dining-expiry workloads. The configured complete Business Dates
Sep20/21 are both Recorded/Matched, with no missing/review days in that coverage.
This is a read of existing results, not a new settlement or evidence for the current
unfinished day; the independent Open payment difference remains unresolved.

The two visible overdue pickups and two linked Dining sessions remain pending
operational review; do not clear historical demo records merely to empty the
queues. The independent simulated payment difference remains assigned and open.
These observations resolve the earlier request for first-page feedback. No further
repeat screenshot tour is required unless a relevant defect or state change appears.
Service/daily status is now read back; remaining handover covers incident handling and explicit
receipt of responsibility; no acknowledgment is inferred from successful browsing.

Use the current v14 installation and approved private launch/configuration material.
The configured DEMO staff entry is `https://127.0.0.1:4443/internal-test/staff`; it is
not evidence of a production employee account or multi-employee assignment.

| Step                              | Operator action                                                                                                                                                         | Required observable result / stop condition                                                                                                                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identify the installation         | Confirm v14, the exact candidate revision plus uncommitted change identity, InternalTest payment mode and agreed scope.                                                 | Source is the active installation; no restored target or old v13 is used. Missing deployment or identity decisions remain open.                                                                                                                                                              |
| Open the shift                    | Use the existing service health and supervisor status commands above; read maintenance status before any service action.                                                | API/database ready, customer HTTPS usable, required workers have fresh completed cycles. An active/unknown lease or unhealthy workload prevents a ready claim; follow diagnosis rather than delete locks.                                                                                    |
| Receive business work             | In the authenticated merchant workspace, review pending Dining/Pickup orders, Kitchen work, served/handoff status and active Dining sessions.                           | Receiving operator can explain which work is pending and use the existing business controls. Reuse unchanged completed flow evidence; use new synthetic orders only for a separately recorded missing operator scenario. Never refund or replay a completed sample merely to repeat a check. |
| Review money and exceptions       | Run the read-only daily settlement status command above; inspect the exception workbench and existing refund/receipt state.                                             | Account for missing/review days and unresolved cases individually. Keep the unlinked CAD22.60 capture open with its assigned follow-up; do not confuse it with the completed linked compensation or infer financial resolution from Matched days.                                            |
| Demonstrate incident handling     | Explain how to stop supervision before maintenance, identify an unknown payment outcome, and diagnose an interrupted recovery.                                          | Operator locates the relevant procedure and escalates uncertainty without repeating payment/refund submission or removing a Recovery lease. Actual outage exercises need their own scoped evidence; describing the procedure is not a completed drill.                                       |
| Close and transfer responsibility | Record the fully closed Store Business Date, pending orders/sessions, exceptions, service health, remaining actions and receiving role in the approved handover record. | Every pending action has an accountable role and next action. Current/initial partial-day coverage is not reported as closed coverage. Receipt of responsibility is explicitly acknowledged; an agent must not fabricate acknowledgment.                                                     |

Record the exercise date, candidate identity, each step's observed result, unresolved
actions and a controlled evidence reference. Keep employee identity/contact details,
order identifiers, credentials, payment details and screenshots with sensitive data
out of Git. Repository records should contain only minimized status and references.
A signed handover does not replace remaining release, recovery or external readiness
gates. Until the actual run-through and receiving-role acknowledgment exist, retain
`operator handover incomplete` in the acceptance table below.

## Current acceptance and remaining work

Current local milestone (620): Windows/WSL, DEMO identity, simulated payments and
assisted use are available with complete-flow evidence below. The new Owner/agent
Pickup618–619journey completes the guided sale-to-handoff exercise;615completes its
specifically authorized recovery drill. Independent takeover remains unaccepted by
Owner choice, not a prerequisite repeatedly imposed on assisted use. Actual Store
activation and formal release are still unapproved; this milestone does not complete
the broader real-store pilot gates.

The batch references below describe the Windows/WSL InternalTest candidate and source
state recorded for that milestone. They do not automatically describe the separate
uncommitted macOS development worktree; its assembled checks are recorded in the
Current local candidate row below. These batches prove local InternalTest behavior,
not real Provider or Store readiness. An older scenario is reusable only where its
covered code, contracts, configuration and evidence remain valid; it is not a fresh
v14 run.

| Required flow                                              | Existing evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Remaining acceptance or implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pickup sale, Kitchen, handoff, receipt and ordinary refund | 415–417 actual customer/staff flow and CAD11.30 refund with Original/Refund receipts;618current v14 Owner checkout/payment and agent staff fulfillment with original Guest proof;619persisted Original/Paid receipt                                                                                                                                                                                                                                                     | Final assembled candidate review and applicable release checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Dining sale, serving, closing and ordinary refund          | 571 new v14 Guest sale, Kitchen/serving, actual employee CAD11.30 refund, originalGuest rendered Original/Refund, normal Order/Session closure and table release;438–448 multi-batch separation                                                                                                                                                                                                                                                                         | Final current-candidate scope review;571 closes the rendered refund receipt scenario without claiming retrospective395 Guest evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Unpaid cancellation and paid-batch preservation            | 424–426 and438–448 cancellation, Inventory rollback/replay and actual session/table recovery                                                                                                                                                                                                                                                                                                                                                                            | Reuse only unchanged covered inputs at final acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Late-payment compensation                                  | 554–556 new expired Pickup capture, automatic CAD22.60 refund, Kitchen blocked, Original/Refund receipts, actual employee acknowledgement and automatic Closed/Reconciled state                                                                                                                                                                                                                                                                                         | No further duplicate refund/acknowledgement required;556 fixes numeric lease ordering beyond9 records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Reconciliation discovery and employee follow-up            | 547–551 livev14 discovery, actual acknowledgement/self-assignment, persisted evidence summary and background capture scanning                                                                                                                                                                                                                                                                                                                                           | Unlinked financial exception remains open; broader employee directory deferred by598local DEMO scope.558list owner readback passes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Daily settlement                                           | 494–498 durable daily worker;572–573 actual two-day persisted match through2026-09-21 and bounded read-only operator status                                                                                                                                                                                                                                                                                                                                             | Earlier initial partial-day coverage and final operating-day/handover acceptance remain unproven                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Recovery and operation                                     | 503/589 paired restoration;504–505 connection recovery;546 canonical198 cutover;561 actual worker recovery;563 supervisor/maintenance exclusion;569 exited-process lock cleanup;584 actual partial-stop recovery and seven-service restart;596–597 reviewed original-source resumption after actual Docker-client interruption                                                                                                                                          | Cloud/fresh-machine and OS-reboot provisioning deferred by598;612takeover tests and615actual before-start controller interruption/resumption pass;608read-only walkthrough recorded; responsibility acknowledgment and final handover remain outstanding; other crash phases are not certified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Current Linux software gates / macOS pilot state           | Fresh disposable Linux run against the recorded 2026-09-26 212-path worktree passes frozen install with pinned pnpm 11.13.0, all 41 build tasks, root Vitest 110/110 files and 2,070/2,070 tests, plus all 41 workspace test tasks. The snapshot excludes `.env`, `.local`, host dependencies, caches and generated outputs; exact result is recorded in [WP-2402](../spec/work-packages/WP-2402.md#current-212-path-exact-tree-linux-software-gate-result-2026-09-26). | The fresh ordered current-tree isolated PostgreSQL section from Audit Record through Dining exits 0; all logged package/database summaries pass, including all nine Dining PostgreSQL configs. The current `customer-lab:acceptance` also passes 2/2 against isolated synthetic PostgreSQL. Exact results are recorded in [WP-2402](../spec/work-packages/WP-2402.md#current-tree-database-chain-exit-code-follow-up-selection-2026-09-26) and [Customer journey evidence](../spec/work-packages/WP-2402.md#current-customer-cross-domain-postgresql-journey-selection-2026-09-26). Darwin `pnpm verify` still stops at Linux `/proc` lifecycle tests; `.local/pilot-v14` runtime readback/final candidate identity remain open. Store/UAT, handover, external readiness, exact-head CI, release and production gates remain distinct/open |
| Formal release and real Store activation                   | Release policy and evidence validator exist; external readiness inventory records required owners and evidence                                                                                                                                                                                                                                                                                                                                                          | For the actual release image: protected source/build identity, all required security artifacts, signing and promotion evidence; real Store, Provider, devices, staffing and deployment gates remain external                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Development-worktree evidence (2026-09-23): separately from the active Windows/WSL
InternalTest source identity616 above, branch `codex/wp-2402-pilot-submission` at
`03ad510c9b694a4bf994efb6703e11afa53e2fb7` has an uncommitted assembled WP-2402
candidate. Its exact static/build/unit, Merchant/Customer browser and isolated database
results are recorded in [WP-2402](../spec/work-packages/WP-2402.md#assembled-candidate-verification-2026-09-23)
and the [Make/repository crosswalk](./project-completion-review.md#make-to-repository-acceptance-crosswalk-2026-09-23).
This candidate passed the repository typecheck/lint/format/build, all41 workspace test
tasks (the sandbox-blocked API task was rerun with approved loopback access), Merchant
67/67 and Customer 91/91 browser tests, Recipe isolated acceptance, Customer isolated
lab and the 1,087-case database-ownership check. These are local synthetic/development
results and do not update the Windows/WSL candidate616 file manifest, its active runtime,
operational handover, exact release artifact identity or any external readiness gate.
The source remains uncommitted and has no new signed candidate identity.

Historical macOS checkout snapshot (2026-09-25, reconciled 2026-09-26): branch
`codex/wp-2402-pilot-submission` remains at `03ad510c9b694a4bf994efb6703e11afa53e2fb7` with
212 changed paths in this 2026-09-26 status refresh. The recorded exact-tree Linux build and software tests
passed on that dated set of paths; the current isolated PostgreSQL/Customer journey evidence remains
separately recorded. The current-tree aggregate selection and its
exact result, including why `pnpm verify` did not exit 0, are recorded in
[WP-2402 continuation evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#current-checkout-full-verification-selection-2026-09-25).
Later Dining and Kitchen changes have their own targeted results in that same record. The fresh
Merchant typecheck now passes after the Dining E2E measurement guard; focused Dining and Kitchen
production journeys also pass. These targeted results do not rerun or upgrade the aggregate. The private
`.local/pilot-v14` installation is absent from this checkout, so no current runtime/Store readback,
new candidate manifest, or final pilot acceptance is established here.

Current Dining responsive browser refresh (2026-09-26): the focused production-fail-closed Dining
spec passes 2/2. Fresh floor and Store-switch captures at 1440/390/320 were inspected; mobile
reflows without horizontal overflow and the switched route renders only its selected synthetic
Store row. Unavailable floor fields remain disclosed. This updates the earlier Dining result in
the [dated WP-2402 selection](../spec/work-packages/WP-2402.md#dining-responsive-journey-refresh-selection-2026-09-26)
without changing the aggregate verification result or pilot gates.

Current-checkout responsive browser refresh (2026-09-25): Dining and Kitchen production-fail-closed
journeys pass 4/4, with fresh 1440/390/320 screenshots visually inspected. This confirms the current
synthetic route behavior and responsive layout only; it does not replace the missing private pilot
runtime, DEMO role/Store readback, Accepted Screen, UAT or release evidence. See the [dated WP-2402
browser record](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#current-checkout-dining-and-kitchen-browser-refresh-2026-09-25).

Current Customer PWA browser regression (2026-09-26): the existing Playwright projects pass 107/107
across `demo-desktop`, `demo-mobile` and `production-exclusion`. The configured projects cover 1440px
and 390px, and the Review journeys assert their 320px state. Payment uses intercepted synthetic
responses. This confirms repository browser composition and production demo exclusion only; it does
not prove the absent v14 runtime, a real Guest/Store context, Provider behavior, UAT or release
readiness. Full command and scope: [WP-2402](../spec/work-packages/WP-2402.md#current-customer-pwa-browser-regression-selection-2026-09-26).

Current Merchant browser regression follow-up (2026-09-26): the complete `production-fail-closed`
project passes 68/68, including the current Dining Store-switch and Kitchen journeys; the
`demo-desktop` and `demo-mobile` projects pass 28/28 across 14 synthetic showcase routes and the
keyboard workflow link. Both runs rebuilt the normal Merchant preview with its existing chunk-size
advisory. These repository browser results do not use the absent `.local/pilot-v14` runtime and do
not establish Windows/WSL DEMO identity, real Store membership/BFF/RLS, Store/UAT, operator handover,
Accepted Screen or release readiness. See the [production run](../spec/work-packages/WP-2402.md#current-merchant-production-browser-regression-after-dining-store-switch-addition-2026-09-26)
and [assisted-demo run](../spec/work-packages/WP-2402.md#current-merchant-assisted-demo-browser-regression-2026-09-26).

Release-scope clarification (batch614): Section87.7.2 requires the full artifact set
for each release image. The [release evidence policy](../security/release-evidence-policy.json)
and [deployment baseline](../security/release-deployment-pipeline-baseline.json)
retain those requirements. The existing `pnpm release-evidence-gate:check` tests the
validator; it does not run scanners, sign an image or attest the current candidate.
Local source-process operation under the accepted598scope is not image promotion.
Do not demand cloud credentials or repeat policy tests merely to reopen the local
demo, and do not infer formal release approval from local passing tests. A later
release must bind its actual evidence to its exact source and image digest.

Actual recovery drill (batch615): paired snapshot and isolated target retained;
actual resume child interrupted after durable owner recording and before service
startup; explicit takeover passed original-source comparison and required readiness,
preserved prior owner bytes and restored supervision. Final maintenance status is
NoMaintenanceLease; Windows normal-TLS staff entry returned200. The target was never
promoted. Do not repeat the exercise merely to create a newer passing record.
Partial-start source changes, orphaned takeover controls and host reboot retain
their documented review limits.

Current guided Pickup (618–619): the Owner added one DEMO Latte, obtained the
CAD11.30 server quote, saved checkout details and confirmed simulated payment.
The agent then used the current merchant session and exact order identity to accept
and complete Kitchen work. The Owner supplied the current Guest pickup proof;
normal proof verification and one handoff completed the single item. Readback shows
Completed with ordered1/handedOver1. A separate read-only Ordering owner query finds
an Original receipt, Paid state and zero refunds. No second payment/refund/handoff
was used for verification. Original-Guest receipt rendering is not claimed by this
server readback;415–417and571retain their distinct earlier browser receipt evidence.

Local flow evidence reconciliation (batch609): original571records retain
Fulfilled/Kitchen Completed, actual staff refund and original-Guest Original/Refund
receipt evidence (CAD11.30 confirmed, zero pending), then idempotent Order/Session
closure. Original554/556records retain CAD22.60 confirmed compensation, both receipts,
Kitchen exclusion and acknowledged Closed/Reconciled state.597retains actual
source-resumption evidence without target promotion. Pickup415–417completion is
supported by its recorded browser/tool runs; the private415initial order artifact
alone is not completion evidence. These are reused recorded journeys, not new runs.
The separate unlinked CAD22.60 exception reviewed by the Owner remains Open.

This reconciliation and608Owner walkthrough establish the cited local flow and
viewing evidence. Separately,615proves recovery after an actual source-resume
controller interruption before startup. These results do not create an exact-candidate
release attestation, cover every crash phase, or acknowledge an operator responsibility
transfer. Those remaining items must be reported individually, not bundled into a
request to repeat already accepted orders/refunds or the screenshot tour.

Current Windows entry evidence:600 imported the specifically approved localhost
public certificate into CurrentUser/Root and all three entry pages returned200
under normal Windows TLS validation. The Owner subsequently confirmed successful entry into the DEMO workspace in the
application browser (batch601). This is Owner-observed login acceptance; the agent
did not observe it through CUA, whose Windows sandbox failed to initialize. No
additional certificate import or repeat login test is needed for this evidence.

The unlinked CAD22.60 Provider-only capture remains an Open reconciliation exception
with original evidence and assigned follow-up. It is distinct from the linked
CAD22.60 compensation completed in554–556. No unsupported orphan refund or write-off
is authorized or inferred from compensation activation.

Use the [external readiness inventory](./pilot-integration-readiness-inventory.md)
for actual Store/Provider/operating evidence. Missing external facts must not be
invented, and passing local software scenarios does not satisfy those gates.

## Historical main-flow evidence through batch448

The following records describe their original runtime and enablement state;
current operation follows v14 above.

- Pickup: batches415–416 complete the migrated local customer/staff journey and
  ordinary refund of CAD11.30, with zero pending and Original/Refund receipts.
  Batch417 fixes merchant summary refresh while preserving unknown refund intents.
  Earlier batches353–355 remain historical evidence; the separately approved MFA
  access was executed in batch355.
- Dining: batches343–346 complete the rendered order, Kitchen, serving, Order and
  session closure journey. Batch395 completes the earlier batch340 refund request
  through actual staff preparation, simulated send and reconciliation; the public
  receipt history retains Original and Refund records. That refund has no fresh
  original-Guest rendered receipt acceptance.
- Dining exception discovery: the approved single-table SELECT was executed in
  batch393; actual API-role evidence confirms SELECT and no INSERT/UPDATE/DELETE.
  The current discovery page was empty, which does not prove a positive exception
  journey. Batch449 identifies the missing runtime creation path and adds unresolved
  closing evidence. Batches450–451 connect transaction-bound task creation and explicit
  routing; current business permissions pass, but the restricted API role lacks
  INSERT on the two task/association tables. The
  [bounded append-access proposal](../spec/design/pilot-v12-dining-task-append-access-proposal.md)
  was approved and its exact two INSERT grants executed in batch453. Prepared
  test routing was activated in batch454 after actual restricted-role creation,
  assignment, exact retry and rollback acceptance. The session-close UI now supports
  the unresolved path; a positive normal business exception journey is still pending. Do not reapply the grant merely because its approval is repeated.
- Dining exception recovery: batches400–404 connect owner evidence to append-only
  projection recovery and an independently controlled worker. Actual startup and
  completed worker cycles passed. Batch432 verifies complete current owner coverage
  in the same snapshot; its empty result is not a positive Dining exception journey.
- Reconciliation recovery: batch427 executes an empty owner-backed recovery page
  and starts the existing worker with a fresh completed cycle. No positive
  reconciliation exception is implied. Batch452 confirms this worker only recovers
  existing projections: the real reconciliation run repository and execution wiring
  remain unfinished. The service now validates complete persisted/replayed results.
  Batch432 adds complete current snapshot coverage;
  automatic compensation remains disabled. Batch428
  records one actual late simulated Pickup capture through Payment owner services.
  Batch429 fixes the expired pending-payment branch and recovers that original event
  as CapacityExpired with Kitchen blocked; exact replay passes. Batch430 executes
  its local simulated CAD22.60 compensation refund. Batches431–434 establish complete
  current configured-source coverage in one authenticated Repeatable Read transaction.
  Section88.22 permits source-checked read recovery; the initial fifteen-minute activation
  gate remains enforced, and historical first-alert timing is not certified. Batch435
  records the DEMO employee operations acknowledgment and derives Case Closed from
  actual Payment evidence, with zero further refund calls. Automatic compensation
  remains disabled. Batch436 appends the real CAD22.60 Refund receipt after the unchanged
  Original and proves exact recovery retry adds nothing. Batch440 completes a new
  original-Guest scenario using the actual thirty-minute deadline: late Test capture,
  compensation and actual rendered Original/Refund receipt, confirmedCAD11.30/pending0.
  Normal employee acknowledgment and owner closure then render Fresh/Resolved with no
  second refund. Old saved states for the earlier Case returned401 and are not evidence
  for that Case's original-Guest rendering.
- Employee exception page: the separately approved
  [Store role proposal](../spec/design/pilot-v12-exception-operator-authority-proposal.md)
  was executed in batch423. Batch435 normal employee workflow renders the same
  compensated exception as Fresh/Resolved/Completed after acknowledgment and owner
  closure. This is agent-operated local DEMO evidence, not independent live-store review.
  Incomplete or unsupported source coverage continues to keep the workbench Stale.

Batch423 executes the separately approved cancellation, compensation and
reconciliation permissions. Batches424–426 publish cancellation Workflow version2,
verify actual API-role Inventory failure rollback and exact replay, commit one
real failed/expired cancellation and activate the local worker with fresh readiness.
Automatic compensation remains disabled. Positive Dining/reconciliation exception
journeys, portable installation and final pilot release
acceptance remain incomplete. All
payment evidence above uses the local InternalTest simulator, not a real Provider.

## Historical delivery work through batch448

The Owner approved all four proposals and their permission scripts executed in
batch423. Actual employee/Brand publication rights, API table access, rendered
Stale/read-only exception workbench and empty reconciliation-source read pass.
Normal cancellation publication and activation now pass in424–426. Remaining
positive business journeys still require their own acceptance evidence.

| Path                                     | Prepared scope                                                                                           | Completion evidence still needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expired unpaid Dining batch cancellation | [Publication, table INSERT and activation](../spec/design/pilot-v12-cancellation-activation-proposal.md) | Publication, actual cancellation, Inventory rollback/replay and activation pass424–426; mixed unknown-payment preservation passes441; first-batch current-version acceptance, stale-version rejection, exact replay and rendered separation pass443; paid first-batch Kitchen completed1/1 and ready pass444; first-batch serving1/1 with table/session/paid facts preserved pass445; controlled local decline and automatic second-batch cancellation with Inventory verification pass446; current cancellation-adjusted pricing, normal Order/session closure and actual Available/unlinked table pass448; original paid and submitted facts preserved |
| Late-payment compensation                | [Six Payment table SELECT/INSERT grants](../spec/design/pilot-v12-compensation-access-proposal.md)       | Owner disposition, confirmed refund and rendered operations/Case closure pass428–435; persisted Original/Refund and no-duplicate recovery pass436; original-Guest rendered receipt/operations closure pass440; safe automatic activation remains                                                                                                                                                                                                                                                                                                                                                                                                         |
| Reconciliation exception source          | [Two-table SELECT](../spec/design/pilot-v12-reconciliation-read-access-proposal.md)                      | Restricted-role source read and positive persisted exception; empty discovery does not establish coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Employee exception workbench             | [Store-scoped employee action](../spec/design/pilot-v12-exception-operator-authority-proposal.md)        | Fresh rendered compensation review/acknowledgment and final state pass434–435; positive Dining/reconciliation episodes and historical visibility evidence remain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Installation and recovery                | Existing protected configuration and batches412–413 restore retained                                     | Restored application read-only cutover passes422; fresh-machine provisioning/key recovery and broader restored operations remain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Final pilot candidate                    | Connected main journeys and scoped evidence above                                                        | Remaining operational journeys, named release regression and applicable external Store/Provider/operator gates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

No entry above authorizes production activation. Existing accepted business
interpretations stay accepted while implementation or acceptance remains open.

## Existing runtime configuration and recovery

Batch422 additionally starts the five-service application set against the restored
421 database using separate protected `.local/pilot-restore421` configuration and
the backed-up simulator. The original customer session reads the same order over
real HTTPS: Original and Refund receipt versions retained, confirmed refund
CAD 11.30 and pending CAD 0.00. The restored services are then stopped and the
original v12 services resume with their readiness gates passed. Existing runtime
keys/passwords were copied only within the private local installation; no admin
credentials were copied, no privileges changed and no financial commands issued.
Background recovery workers ran against the restored database, so that target is
now an exercised recovery environment; preserve `recovery-421` as the original
backup. This proves local application startup/session/receipt recovery with
retained keys, not fresh-machine provisioning or a complete new transaction on
the restored system.

Batch420 adds a [repository recovery command](../../tooling/environment/README.md#repository-local-recovery-drill)
for existing protected installations. Batch421 executes that entry successfully:
382 PostgreSQL tables/7249 rows and4 SQLite tables/48 rows match in the new isolated
`bop_rms_wp2402_restore_v12_421` target and protected `recovery-421` backup. The source
is preserved and the original service set resumes with readiness gates passed.
The command stops and resumes services and creates a new isolated target, so use
an explicit maintenance window and unused target/output names. It is not a
fresh-machine installer or application cutover test.

Batch419 extends the retained restore evidence through Ordering's public receipt
store using the existing restricted API role in explicit read-only transactions:
12 restored orders decode into 17 valid receipt records, including 12 Original
and 2 Refund records. Each order's decoded record count matches its restored
stored count. This verifies current receipt codec/owner-read compatibility;
it does not verify Guest authorization, an HTTP journey or application cutover.
At batch419 the services still used the original v12 database; current services use v14.

The Dining worker now runs the repository entry point, not a generated executable
wrapper. Existing installations need a protected `dining-exception-worker.json`
in the private runtime directory (directory mode700, file mode600). Its exact
fields are `schemaVersion: 1`, `environment: "InternalTest"`, the installation's
`database`, its already configured Test `providerAccountReference`, and `scope`
containing `tenantReference`, `brandReference`, and `storeReference` matching the
existing profile binding. Use the existing installation values; do not invent IDs,
copy credentials into this file, or distribute `.local/`. The loader validates the
binding and the worker rechecks it when opening resources. This is an existing
installation recovery procedure, not a fresh-machine installer.

Batch406 also moves Kitchen startup to a repository entry with protected
`kitchen-queue-worker.json` containing the existing actor and profile scope.
The old Kitchen process was stopped before the command identity changed; the new
process completed actual queue refresh cycles. No other service was restarted and
no privileges changed. See the [Kitchen configuration instructions](../../tooling/environment/README.md#kitchen-worker-repository-entry).

Batch407 moves the active business background composition to the repository too.
All currently enabled consumers and wait/expiry loops retain their existing
configuration and owners. Fresh event, payment-wait and Dining-expiry cycles pass
after the isolated process switch. See the [business worker configuration](../../tooling/environment/README.md#business-worker-repository-entry).
Cancellation and compensation remain disabled pending their separate approval
and activation work; private configuration is still needed for the installation.

Batch409 moves API startup to a repository entry with protected customer runtime
configuration. The actual replacement process passes database readiness and
HTTP200 public-menu reads for both Pickup and Dining. This verifies API startup
and those reads. The separate HTTPS/merchant migration was completed in batch410;
batches415–416 subsequently prove the rendered Pickup/refund journey. See the [API configuration instructions](../../tooling/environment/README.md#customer-api-repository-entry).

Batch410 completes the separate HTTPS/merchant entry migration. All currently
started pilot services now use repository entries with private data configuration.
The replacement HTTPS process passes CA-validated employee-entry, merchant-shell
and both-channel menu-proxy reads (HTTP200). Existing refund role mapping and
workstation values were preserved; permissions and pending approvals did not
change. See the [HTTPS/merchant configuration](../../tooling/environment/README.md#https-and-merchant-repository-entry).
Fresh installation, remaining exception journeys and final release acceptance remain open.

Use the [coordinated maintenance stop](../../tooling/environment/README.md#coordinated-local-maintenance-stop)
before a planned recovery window. It confirms all six known service types,
including optional workers, and reports partial failure explicitly. Process
stop/start evidence does not replace a current backup and isolated restore drill.

WP-2402 batch412 adds a current local isolated data restore drill. After coordinated
stop, an exported PostgreSQL snapshot and native SQLite backup were saved under
protected `.local/pilot-v12/recovery-20260921/`. Full PostgreSQL restore into the
new isolated `bop_rms_wp2402_restore_v12_20260921` matches all382 ordinary user
tables and7023 rows by per-table content digest/count. The SQLite backup matches
all4 simulator tables/45 rows and passes integrity checking. A second source
inventory confirms the source remained unchanged during the drill.

The restored database is retained without application/worker connections; source
configuration still points to v12. No credentials or keys were exported or rotated.
This proves current local data restoration within the existing cluster/roles and
with the original protected configuration retained. It does not prove new-machine
role/key recovery, application operation against the restored target, real Provider
reconciliation, production RPO/RTO or full pilot readiness. Preserve the private
backup/evidence and isolated target; do not clean up either without exact approval.

Batch413 additionally checks the restored database through the existing restricted
API role, using explicit read-only transactions. Restored `order_header`,
`payment_intent` and `dining_session` own-scope counts/content digests match the
backup. All three retain enabled and forced RLS; wrong Brand, wrong Store and
missing tenant context expose no rows. A subsequent correct-scope read still
succeeds. The role is neither superuser nor BYPASSRLS. This is direct read-only
verification of three tables, not complete authorization or restored application
journey acceptance; running services still use the original v12 database.

The following batch-specific paragraphs retain historical evidence. Their pending
statements describe that batch; the current status above supersedes them.

WP-2402 batches329–330 additionally record actual HTTPS closure of a fulfilled
Dining order and its session. Begin/Finalize and exact retries passed; the session
is Closed and its original table was released with one version increment.
This is an existing-order completion milestone, not a fresh complete Dining
journey or rendered-browser acceptance. Batch324 also passed composed startup
for all four services after the runtime module extraction.

WP-2402 batches335–338 completed one current persisted Dining API journey:
fresh Guest entry/join/binding, authorized Host transfer, Cart/Quote/details,
simulated payment Succeeded, acceptance, Kitchen readiness, serving, original
Guest receipt read (Original version1, reported Stale), Order closure, session closure
and table release. The receipt API deliberately marks immutable history Stale:
it does not compose current financial, delivery or support sources. This is not
a failed receipt issuance or a delay resolved by refreshing payment observations.
Live receipt status integration and its acceptance remain outstanding. Exact
closure retries preserved their original results. These trusted local HTTPS
results do not constitute rendered-browser, refund/cancellation/compensation or
complete pilot release acceptance.

WP-2402 batch340 adds actual Chromium evidence through the DEMO staff login:
closed Dining serving history, captured payment details, refundable item loading,
and a CAD 11.30 refund request calculated, recorded and read back from the server.
The request is Not dispatched (confirmed refund CAD 0.00); MFA-dependent execution
remains pending. This proves the staff request flow, not completed refund or the
full customer browser journey. No network responses were mocked.

WP-2402 batch341 adds the actual customer Chromium path from Pickup entry through
menu, item configuration, server Cart, current Quote, saved synthetic contact,
explicit simulated payment confirmation, order status and Original receipt. The
same new order was accepted through the staff page (version 2, initial batch
Accepted). Batch342 continues that same order through rendered Kitchen
accept/start/complete, customer readiness, staff proof verification and explicit
simulated handoff. The same original Guest then reads Order collected. Together
341–342 prove the rendered Pickup main journey without mocked responses. The
receipt explicitly retains the unavailable live-status notice; this does not
establish completed refund, cancellation or real Provider/Store activation.

WP-2402 batches343–345 add actual Dining browser entry: staff starts DEMO-02,
the table launcher establishes a Guest, the current code joins and binds the
Guest, and the sole participant becomes Host. Shared Cart, Quote, simulated
payment, Dine in order status and Original receipt passed. A stopped business
worker initially left the status projection absent; restarting that confirmed
stopped process restored the same order without charging again. Batch346
then completes staff acceptance, Kitchen completion, simulated serving, Order
closure and session closure through real controls; DEMO-02 is released. The
original customer page subsequently returns a masked 404. Batch347 traces the
runtime to current Dining membership authorization, which rejects Closed sessions
and released table assignments; Section25.5 makes session credentials invalid
after the session ends. This is not evidence of a missing Order. The page now
explains that the link or access session may be unavailable, without revealing
order existence or relaxing access. Expiry may also produce the same response;
the individual browser request reason was not instrumented. Do not require
post-close access through an ended Dining binding or replay payment/fulfillment.
This does not establish the separate receipt-resume path or full pilot readiness.

Runtime adapters are being moved from private configuration into
`tooling/environment/pilot-*.mjs`; private compatibility modules keep the current
service imports working. Credentials, bindings and simulator state stay local.
Do not distribute `.local/` as a release package.

## Historical v3 candidate (2026-09-19)

The local candidate is the ignored directory `.local/pilot-v3/` and its
separate database `bop_rms_wp2402_pilot_v3`. All181 migrations were applied; API and
Worker database identities are restricted. The earlier v2 database remains intact.
Source now includes migration0200_019 (182 total) for immutable Brand operation
results; it passed isolated database acceptance. The v3 migration status reports
MIGRATION_OUT_OF_ORDER because0200_019 is below its applied high-water mark.
In-place application is refused; preserve v3 and create the next complete-catalog
candidate after the remaining schema work, without ordering/checksum bypass.

The existing explicitly synthetic demonstration inputs now persist in v3: Brand
and Store drafts, Menu revision2 with one Product/SKU placement, and one CAD5.00
PriceBook draft. Six audit records accompany this initialization. These are local
development inputs, not actual Store, tax, issuer or Provider facts. The price
book has no published-current pointer and the Product has no tax classification.

There is no v3 business API configuration module or running complete application
yet. Database readiness and the passing isolated HTTP journeys do not establish
a usable pilot. The PostgreSQL Brand lifecycle repository now supports atomic creation, activation,
archive and immutable recovery, with actual database acceptance. The HTTP lifecycle
command is wired with a required current administration authority port. The actual
OIDC/operator bootstrap authority source still needs configuration and integration; Tenant context
rejects the candidate Draft organization. After that, prepare scoped sale configuration
through owner workflows and assemble its persisted sources into a long-lived
API/Worker configuration. Do not turn draft rows into
published facts by direct status edits or treat synthetic sources as live approval.

Current customer integration evidence (WP-2402): the same retained HTTP server
handles checkout details, original Order and Payment, and Additional Dining Payment
creation, replay, client handoff and terminal-backed result reads. Additional session submission, tip selection, clock recovery,
Inventory and Payment history use persistent owner compositions. First-batch recovery
after the Additional intent still returns the original record; replay does not repeat
the synthetic Provider call. This remains isolated database acceptance, not a deployed
application or a complete browser journey. Entry/Cart continuity and the full
customer/merchant browser journey still need to join that server configuration.
Combined acceptance uses one explicitly synthetic Provider account for the original
and Additional payment; live Provider configuration remains an external input.

Pickup and Dining configured Quote now enter that same server before checkout details. The
real configured Quote command reads existing Catalog and Pricing owner sources,
persists its request and Cart attachment, and the same Cart proceeds through capacity,
Order and Payment. Original seed policies and Guest/Cart binding history remain
explicit synthetic starting inputs. Dining also revalidates current session binding
and participation through owner readers. This does not yet prove Entry, Cart editing
or the full browser journey.

Separately, actual Dining Entry now continues through owner join/binding, two
participants' shared Cart mutations with Inventory checks, and persisted ordinary
(no-option, v1) Quote creation and recovery. The quote belongs to the actual Cart
and current rotated Guest; the old credential cannot recover it. That actual
quote now continues into a persistent Dining checkout commitment through the
current Identity/table/participant owner composition; repeated preparation recovers
the same commitment and Order-capacity link. The current-time continuation below
consumes this commitment through CheckoutSession and Order owners. Join, binding,
Cart and Quote share one server; the earlier QR Entry server remains separate.
A separate current-time Entry scenario now uses real Publishing/Store profile and
timing owners, a synthetic operating window around the current Toronto hour, and
fresh persisted Guest/Cart/Quote facts. The actual CheckoutSession allocation store
checks the database clock and persists the submission/payment operation identities
that Dining preparation then consumes. Allocation replay retains those identities
and one Audit record. The same allocation now continues into real Dining CheckoutSession validation and
persistence: current Catalog plus Recipe/Inventory observation checks the combined
quantity in this ordinary one-SKU Cart, and the validation references the original
Dining commitment. Repeated creation returns the original session without another
validation or create Audit; the old credential is denied. CheckoutSession creation and read now use the same Dining join/Cart/Quote HTTP
server: create201, replay200 and read200 return the same safe session view;
rotated old credentials receive404 for both create and read. The actual owner
record retains the original allocation/submission/payment/commitment identities.
The same server now also reads the checkout policy/current-details views and saves
the actual Cart's InSession receipt choice through the Dining details owner.
Save201 and replay200 recover one record and one Audit; the old credential cannot
save. Required policy documents are explicitly an empty synthetic fixture, not a
real Store legal-policy decision. This current Entry path now loads actual Catalog
and original Pricing Order snapshots and resolves Business Date through the published
Store operating configuration. Actual session Order submission atomically persists
one Order with both participants' two item lines, its Dining and details links,
Inventory final validation/reservation, Audit and outbox event; replay recovers
the same Order without a second finalization or reservation. The existing Entry
Recipe and stock site are reused, with an explicit synthetic owner-persisted
Workflow. This exposed and fixed the Ordering Cart cleanup's erroneous single-row
requirement; it now checks the actual submitted line count. Order submission is
currently exercised through the session service. Its actual session now also
persists an explicit synthetic zero-tip selection and seals the Dining payment
clock: the original operation/submission remain bound, identical retry recovers
the same tip and clock, changed-tip retry is rejected, and the deadline remains
30 minutes after the original payment request. Rotated old credentials cannot
select a tip or seal/recover the clock. There is one tip record and two append-only
commitment versions (prepared and PaymentPending). The same Dining server now
creates a Payment intent over HTTP201 for that actual Entry Order; replay200
recovers its identity and amount, and the old credential receives404. Actual
Order/Capacity/Inventory/current published Workflow admission precedes durable
Payment intent/attempt/operation writes. There is one of each and one simulated
Test Provider creation call. The response is a safe CAD5650minor projection with
no-store/no-referrer headers. The explicitly synthetic Provider returns
requires_payment_method; this is not captured money or a live Provider result.
Identity revalidation inside admission uses the same transaction for current
Dining context to avoid waiting on its own table lock. The same server now
serves client handoff using that actual intent and admission chain. Valid current
credentials receive only the synthetic client secret with no-store/no-referrer;
old credentials and a disabled current confirmation policy deny without another
Provider retrieval, and durable history remains unchanged.
The same-server result reader stays Pending after an actual persisted normalized
synthetic capture observation. Only the actual Payment terminal service commit
(with Event/Audit) changes it to Succeeded; identical retry is AlreadyCommitted,
there is one terminal fact, and old credentials receive404. This verifies local
persistence and safe result semantics with simulated money, not a live capture.
That Entry-created terminal event now resolves the actual paid Order context
with both participants' original item snapshots and drives merchant acceptance,
Order confirmation, Kitchen ticket creation and work-item Accept/Start/Complete
through Ready. The existing owner chain checks duplicate acceptance/event/work
recovery and preserves per-item quantities. Merchant identity/permissions, recipe
reviewers and routing authority remain explicitly synthetic fixtures.
Dining Entry now initializes its original Recipe through actual CreateDraft and
Publish services, so Inventory and Kitchen reuse the same published version and
its operation/review/Audit/Event evidence. No replacement Recipe is introduced at
Kitchen intake. Serving, customer status/receipt/refund continuity and the
long-lived application still need assembly on this Entry path.
The existing session PaymentIntent composition internally coordinates
Order, tip and clock; a separate session-order HTTP route is not required.
The historical closing-boundary scenario remains separate.
Commercial/tax and staff/abuse authorization fixtures remain explicitly synthetic.
This ordinary Entry-to-payment-intent evidence is not yet joined to the above configured-v2
Quote-to-Payment journey or accepted as a full browser/long-lived application.

The [ordinary-refund proposal](../spec/design/pilot-ordinary-refund-policy-proposal.md)
is Owner-accepted (2026-09-13). Do not reopen RF-D01–06 because implementation or
operational acceptance remains unfinished.

## Owner inputs

Record preparation status only, never credentials or personal evidence here.
Store/operator, selected Payment Provider, test account and deployment availability were requested.
Pending response does not block independent local integration.
Use the [Pilot evidence inventory](./pilot-integration-readiness-inventory.md) for actual activation.

## Current increment

[WP-2402](../spec/work-packages/WP-2402.md) is the current work owner.
[WP-2401](../spec/work-packages/WP-2401.md) supplies prior Pickup browser Cart and persisted Quote evidence.
The Order task handed off WP-2353 at 2d1f8c6 and is no longer writing; its scoped evidence is retained.

WP-2402 current submission increment: Dining has durable original-clock and tip evidence.
Pickup now has actual persisted Identity/CSRF → Cart/Quote → shared ASAP capacity →
atomic Order/Audit/Outbox, including lost-response recovery and revoked-session denial.
Pickup original payment-clock sealing and lost-response recovery are now also verified.
Pickup explicit tip persistence, exact amounts and current held-capacity permission are verified.
WP-2402 also has actual Item/ledger reservations, final Inventory records, formal Payment preparation
and fenced current capacity/Inventory/Workflow publication checks for Dining and ASAP Pickup.
Dated-lot and NoLot PostgreSQL journeys now pass for both Dining and ASAP Pickup under explicit
synthetic expiry configuration. Store-specific timing/expiry policy, runtime activation and
operator/browser journeys remain. Catalog/Pricing/BusinessDate and Store-binding/default-policy inputs in this
bounded database acceptance are synthetic; this is not a Store readiness declaration.

Payment persistence increment: WP-2402 now implements actual PostgreSQL Intent/Attempt/
operation/Audit claim and normalized observation recovery. Service-to-store acceptance proves
commit-before-Provider and no repeated Provider call after an unknown claim acknowledgement.
The Provider remains synthetic. Current preparation/Inventory/Workflow sources now use actual
owner persistence with synthetic Store configuration in acceptance. This does not activate
the runtime or establish deployment/Store/Provider readiness. See WP-2402 for current
source-specific evidence and remaining gates; do not treat earlier missing-source notes as current status.

Store operations increment (WP-2402): real HTTPS Merchant UI now exercises
pause/resume and saved configuration draft → validation → independent approval →
publication through persistent owner sources. Publication preserves exact reviewed
content even after a clock advance; permission denial, Audit failure rollback,
idempotent replay, effective-version selection and reload have database evidence.
Current evidence is the WP-2402 browser publication milestone bc1ea4/e3b3b1 and
affected closeout839504/58dfb5/24ec78. Synthetic reference validation, Store/Gate
facts and Provider session issuance remain explicit fixture inputs.
The application server now accepts merchantRuntime, which constructs persistent
authentication, service control and configuration handlers from one persistence
context. It rejects simultaneous merchantBff and merchantRuntime configuration.
Actual HTTPS/database milestone e4fe57/4dccee uses this factory. Supplying and
enabling real scoped runtime dependencies is still required. These checks establish
the configuration workflow, not full operational readiness or deployment.

Entry Worker increment (WP-2402, run659d35): the actual current-clock Dining Entry journey now delivers its original OrderCreated and PaymentSucceeded events through the persistent Worker after payment and Kitchen Ready. Payment status persistence and one consumer inbox are verified; retained connections close. Provider and internal authorization inputs remain explicit synthetic fixtures. Event publication does not establish current customer Order status after later transitions. Same-server customer status/receipt/refund and complete long-lived browser acceptance remain outstanding.

Same-server customer status increment (WP-2402,6a3cc8): Dining Entry's retained server now exposes its actual Order and both participant items with persistent Kitchen Ready and Payment Succeeded sources after Worker delivery. Current Guest access succeeds; old cookie and invalid CSRF deny. Creation projection still needs current order/delivery evolution for complete status semantics; this is not full browser, receipt/refund or pilot readiness evidence.

Dining serving increment (WP-2402,d8cf64): same Entry Order's two participant items are served via actual Dining service/Audit persistence after Kitchen Ready. Same-server customer status reads each item's served quantity after each write; replay and excess-quantity rejection pass. Actual delivery composition derives Fulfilled after all items are served. Merchant authority is still an explicit synthetic fixture; authenticated Merchant HTTP/browser, formal closure and receipt/refund continuity remain. This does not close the shared Dining session or release its table.

Entry original receipt increment (WP-2402,9d4ec7): same Dining Entry Order now reaches actual original receipt issuance and authenticated same-server customer retrieval after serving. Amount/tip use original payment; actual refund history, published template and issuer assignments are read. Concurrent issuance/replay and read-only retrieval pass. Legal issuer/template approval remain synthetic fixtures; receipt freshness/delivery retain Stale/Unavailable. Same-order refund amendments and full runtime/browser acceptance remain outstanding.

Entry refund increment (WP-2402,633469): the same Dining Entry Order now reaches ordinary full refund using original quote allocations, capture and Store business-date publication. Real request/dispatch/observation/recovery persistence and same-server customer receipt reads pass: Original -> RefundPending -> Refunded, with earlier records unchanged. A simulated post-send outcome-write failure recovers without a second refund send. Workforce/Provider transport remain explicit synthetic Test inputs; long-lived process, authentic browser/operator and Provider readiness are still outstanding.

Unified paying Guest entry (WP-2402,c8ec22): paying Dining Guest now scans into the same API server used for join, Cart, checkout, payment and receipt/refund retrieval in the persistent journey. Initial setup/first participant retain their earlier server. This proves shared process routing for that customer journey; ignored candidate API remains health-only until concrete runtime configuration is assembled.

Customer progress presentation (WP-2402): customer heading now reflects actual Kitchen preparation and Dining partial/all-item serving sources instead of always Order submitted. All-served text covers listed items only and does not close a session or settle payment. Unit/type/build checks and existing production App browser HTTP continuity test1b5864 pass; this browser scenario uses synthetic responses and remains distinct from full persistent pilot browser acceptance.

### Receipt financial observations (WP-2402 batches351–352)

The current runtime can return Payment-owned captured, confirmed-refund and
pending-refund totals separately from immutable receipt records. The page shows
the observation time and unresolved payment warning, and hides these amounts
as current information while offline. A failed optional source returns unavailable,
not zero. Delivery/support/cancellation availability and overall receipt freshness
are not inferred from this financial observation. API2258 and HTTPS2265 loaded
the change; worker761/768 remained running. The persisted345Order source read
matched CAD11.30 captured and zero refunds/pending amounts. This is owner-source
evidence, not an authenticated Guest/browser receipt acceptance; that remains
the next verification step. Ordinary refund dispatch authorization is still pending.

WP-2402 batch353 subsequently completes the actual Guest/browser receipt check:
a fresh Pickup journey makes one DEMO CAD11.30 payment, then the same Guest
sees Original receipt1 and separate captured11.30/confirmed-refund0/pending-refund0.
The added Refresh receipt button changes the observation time without changing
history. Actual browser offline mode hides current amounts, retains the accepted
receipt and disables refresh; network was restored afterward. This supersedes
the pending happy-path browser check above. Nonzero pending/confirmed refunds
and full refund execution remain separate acceptance requirements.

WP-2402 batch354 follows that same353Order through real employee acceptance,
Kitchen completion/readiness, proof verification and explicit DEMO pickup handoff.
The original Guest sees Order collected. Staff then records one CAD11.30 ordinary
refund request through the calculation/confirmation UI. The same Guest receipt
GET and rendered page show captured11.30, pendingrefund11.30 and confirmedrefund0;
the one Original receipt remains unchanged. No refund preparation or sending was
performed. This closes the nonzero-pending display check, while actual refund
execution and the confirmed-refund receipt transition remain gated/incomplete.

WP-2402 batch355 supersedes the MFA access gate above after explicit Owner approval
on 2026-09-21. Only the proposed local v12 grants and missing Required/unverified
row were applied; no MFA verification was invented. A real-command preparation
probe succeeded and rolled back. The same353/354 request then passed actual staff
UI preparation, one local simulated send and reconciliation, producing a refund
receipt. The original Guest now sees captured CAD11.30, confirmed refunds CAD11.30
and pending refunds CAD0.00. Receipt history contains two versions: the Original
with refunded0 remains unchanged and the new snapshot records refunded11.30.
This completes the local simulated ordinary-refund happy path, not real Provider
acceptance, independent approval/MFA escalation, cancellation or pilot release.
No application rebuild, service restart or unrelated regression was needed.

WP-2402 batch356 restores the missing v12 cancellation Draft configuration only
after matching its definition, scope and operation to the migrated database.
Unpublished configuration still refuses execution. Current runtime access confirms
only cancellation-history INSERT is missing among the five inspected write tables.
The separate Brand publication-authority and local activation request is detailed
in [the v12 cancellation proposal](../spec/design/pilot-v12-cancellation-activation-proposal.md).
Historical356 state superseded: scripts ran423; publication424, actual rollback/replay425 and cancellation/activation426 now pass.

WP-2402 batch357 adds cancellation workload composition behind explicit
`enableBatchCancellation: true` in the business-worker entry. The current entry
omits this option, so cancellation remains disabled. Enabled operation uses the
existing owner dispatcher with five-second nonoverlapping polling and bounded
stop/drain, plus a separate business-batch-cancellation health report. This code
and its 21 focused checks do not establish publication or live cancellation
acceptance. Include that component in readiness when activation is authorized;
complete actual failed-batch/Inventory/replay acceptance before enabling it.

After cancellation publication, permission and actual batch acceptance are satisfied,
use `node tooling/environment/pilot-start.mjs .local/pilot-v12 --require-batch-cancellation`
for the activation readiness gate. This flag does not enable cancellation. It requires
the configured worker's separate cancellation report to match PID/process start,
show a completed running cycle, and have report/completion ages no older than35s.
Missing, failed or stale evidence leaves startup incomplete without restarting
the observed process. The current runtime enables cancellation after batch426; retain this readiness flag.
WP-2402 batch358 covers these checks; it is not actual cancellation acceptance.

WP-2402 batch359 adds read-only compensation discovery through Ordering's public
owner query. The actual v12 API role returned zero PaidWithoutFulfillableOrder
candidates with no further page. This is not a successful compensation test:
no refund ran, and automatic compensation runtime/evidence composition and a
genuine persisted failure scenario still need completion. The read binding denies
wrong Store/purpose, expired configuration and non-development execution.

WP-2402 batch360 supports compensation-refund:<actionReference> in the local
Test simulator and returns the Snapshot contract expected by Payment compensation.
It shares the ordinary-refund journal and captured balance. Isolated SQLite
acceptance covers partial ordinary plus remaining compensation, process reopen/
exact retry without duplication, conflicting intent and over-refund refusal.
Current v12 services were not restarted and no current journal was changed;
this is adapter evidence, not an executed pilot compensation case.

WP-2402 batch361 adds the compensation disposition evidence composition. It
requires an exact immutable Ordering record and successful Payment terminal
identity under the caller transaction, with current scope/authorization checks.
Its six boundary tests, API typecheck and build passed. The verifier still needs
binding into the complete compensation runtime; it does not authorize refunds
on its own or establish a positive persisted compensation journey.

WP-2402 batch362 adds the compensation Provider observation bridge. It binds
intent/attempt/action/environment, checks authorization before the call and during
observation persistence, and returns a successful Snapshot only after the Payment
owner transaction completes. A failed write or revoked authorization does not
become confirmation. Six focused tests plus API typecheck/build passed after
fixture type fixes. The running pilot has not adopted this bridge yet; complete
compensation runtime composition and persisted positive acceptance remain open.

WP-2402 batch363 adds Payment-owned verification of committed full-refund
Provider observations against the successful terminal identity and captured amount.
Eight behavior tests and eight narrowly selected ownership-registration tests pass;
types, imports and actual ownership scan pass. A read-only query against an existing
ordinary simulated refund matches its real observation and rejects a wrong digest.
That probe creates no compensation case and is not compensation acceptance.
The complete runtime still needs the case/action/result evidence bindings.

WP-2402 batch364 supplies case-open/current-source and OnlineCard claim validators
for the compensation runtime. They re-read the public Payment source in the
retained transaction after validating the original disposition, bind Order/
Transaction/Intent/Attempt and immutable digests, and reject excess claims against
current ordinary/compensation balances. Later genuine observations may advance
source versions, but opening a new case requires an exact current snapshot.
This remains callback composition; runtime execution and operations reconciliation
are not yet enabled or accepted by an end-to-end compensation scenario.

WP-2402 batch365 adds stable InternalTest compensation IDs and scoped System
Audit generation. Recreating the factory for the same payment preserves operation,
case, action, refund, event and causation references. The simulator key remains
compensation-refund:<actionReference> even if an invalid retry changes amount,
so the existing request fingerprint refuses conflicting reuse. Four focused tests
pass. Preserve identity algorithm BOP_INTERNAL_COMPENSATION_V1 once cases persist;
these factories do not authorize or execute compensation.

WP-2402 batch366 adds Payment-owned compensation operation-result evidence validation against the latest persisted Case and committed refund/operations evidence. Four focused pending/rejection/authorization tests, Payment types and database ownership validation pass. This code is not yet activated in the local worker; positive confirmed/closed compensation acceptance remains open. No additional local permission changes or simulated financial transactions occurred.

WP-2402 batch367 adds the Payment action-outcome callback needed by automatic compensation. It distinguishes unknown invocation from partial/full provider confirmation and requires persisted observation evidence for confirmation phases. Fourteen focused tests, affected types/lint and ownership validation pass. Runtime activation and positive persistent compensation acceptance are still pending; no new simulated refund or permission change occurred.

WP-2402 batch368 assembles the durable compensation service with exact disposition/payment bindings and previously implemented evidence callbacks. Required named-actor operations authorization and disjoint refund-owner balances are explicit dependencies. Four composition tests, API types/build/lint and import boundary checks pass. The running worker has not activated this service; positive persistent compensation and operations closure are not yet accepted.

WP-2402 batch369 actual v12 preflight finds no compensation candidates and missing append permissions for all six compensation owner tables (four also lack read permission). The exact local proposal is docs/spec/design/pilot-v12-compensation-access-proposal.md; its guarded script is prepared and syntax checked, not executed. Automatic compensation remains inactive, and every future confirmed refund still requires named-actor Operations reconciliation before case closure.

WP-2402 batch370 implements named-actor compensation acknowledgment command and Payment-owned confirmed-refund preparation. It uses current Workforce session, selected Store and operations.order-exception.manage, derives evidence/Audit server-side, and replays an existing exact receipt without another append. Focused Payment7/API5 plus existing ordinary send4/reconciliation11 tests, types/build and boundaries pass. HTTP and rendered operations entry remain to be connected; no runtime acknowledgment or case closure is claimed.

WP-2402 batch371 adds the protected merchant compensation acknowledgment HTTP route and InternalTest merchant composition. Targeted HTTP security/redaction/replay test, API types/build/lint and import checks pass. Existing process has not restarted, no acknowledgment was written, and the operations page still needs a current-case preparation query plus controls. Response means acknowledgment recorded, not case closed.

WP-2402 batch372 adds the authenticated compensation preparation query: current Case version/state, confirmed refund amount/time, and whether operator acknowledgment exists. Missing source never becomes zero/refunded. Four query tests plus targeted HTTP test, API types/build/lint/import pass. Existing processes have not loaded it; page controls and actual persistent scenario remain pending.

WP-2402 batch373 adds contextual compensation reconciliation controls to the existing order-exception workbench. Staff review the confirmed refund, explicitly acknowledge it, and can retry the identical request after an unknown response. Stale/offline mutation is disabled; acknowledgment is not displayed as case closure. Ten unit tests and four production-preview Playwright tests pass, with affected types/lint/build. Browser responses were intercepted synthetic fixtures; actual database/worker/operator acceptance remains open and local ACL proposal is still pending.

WP-2402 batch374 connects compensation runtime to configured InternalTest resources and the shared simulated Provider. Background code may consume exact persisted operator acknowledgment but cannot create it. Four focused binding tests pass; actual v12 service construction and owner discovery succeed with zero candidates and no execution. Automatic worker activation, required local privileges and real durable compensation acceptance are still pending.

WP-2402 batch375 connects default-off compensation scheduling, owner-backed exception projection refresh, fixed failure Audit and lifecycle health reporting. Focused service/projection8, worker13 and local lifecycle/health24 tests plus worker types/build pass. The actual business entry still leaves compensation disabled. Required-readiness aggregation and real v12 compensation/operator acceptance remain pending; no financial, ACL or runtime activation occurred.

WP-2402 batch376 adds explicit compensation readiness selection. From the repository root, `node tooling/environment/pilot-start.mjs .local/pilot-v12 --require-compensation --require-batch-cancellation` requires both optional loops to report recent completed cycles from the current worker; it does not enable either loop. Default readiness remains compatible. Seventy-two focused health/start/controller tests and lint pass. This command has not been executed against the live runtime; actual enablement and acceptance remain pending.

WP-2402 batch377 connects the persistent merchant exception list to current session/Store authorization and the public Projection reader. Twenty-two affected tests, API types/build/lint and import validation pass. Metadata intentionally remains Stale until complete owner coverage is proven. Actual v12 catalog inspection confirms the existing projection table lacks API-role schema USAGE and SELECT/INSERT; the separate exception-projection access proposal is prepared and awaiting approval. No grant, service restart or actual compensation acceptance occurred. The earlier MFA change was already authorized and executed in355; it must not be requested or applied again as a new prerequisite.

WP-2402 batch378 supersedes377 projection-permission pending status: the Owner explicitly approved the exact local grant, and the guarded transaction committed. Actual v12 API-role readback confirms schema USAGE and table SELECT/INSERT, with UPDATE/DELETE false. A read through the public Projection store succeeds and returns zero rows. No business rows were inserted. Complete owner coverage, actual employee workbench acceptance and compensation execution remain outstanding; the view must remain Stale until coverage is proven.

WP-2402 batch379 adds Payment-owned paginated compensation case discovery for projection recovery, including closed cases. Six targeted tests, Payment types/lint and database ownership validation pass. Results are references requiring authoritative single-case hydration; this does not execute refunds or establish full exception coverage. Actual database execution awaits the separate Payment access approval, and recovery-loop integration remains pending.

WP-2402 batch380 connects compensation projection recovery to the default-off compensation scheduler. Each cycle repairs up to five existing cases using public Payment state and the existing idempotent Projection writer, including closed cases. Failed pages retry without advancing; completed scans restart from the beginning. Recovery has no financial or operator-acknowledgment command, and service discovery remains read-only. Sixteen focused tests and lint pass. Actual activation awaits separate Payment-table authorization; this does not establish full exception coverage or Fresh status.

WP-2402 batch381 adds the missing public Payment reconciliation-exception database reader. Five behavior tests, five precise ownership-registration tests, Payment types and ownership scan pass. Actual v12 API-role read is unavailable: the table exists and schema USAGE is present, but SELECT is absent. No grant was made. The reader preserves unresolved Order/payment bindings as null rather than fabricating references. Runtime reconciliation production, authoritative linkage, access authorization and complete workbench coverage remain unfinished.

WP-2402 batch382 adds optional authoritative Order/payment identity enrichment to reconciliation exception reads. Only a consistent operational record can resolve through the public Payment binding; daily settlement and missing records stay unassociated, conflicts fail. Eight behavior tests, six asset-registration tests, types and ownership scan pass. Both reconciliation tables lack API SELECT; the exact read-only proposal is docs/spec/design/pilot-v12-reconciliation-read-access-proposal.md. No grant or runtime activation occurred.

WP-2402 batch383 binds reconciliation exception reads to configured InternalTest scope and the public Payment intent binding reader in one transaction. Construction does not scan, and the local service exposes an explicit read-only method. Nine affected tests and lint pass. This is composition evidence, not actual database/employee acceptance; two-table SELECT approval and reconciliation projection integration remain pending.

WP-2402 batch384 implements an explicit reconciliation projection recovery method. Linked Open exceptions map to payment-state Unknown and compensation NotRequested; the same owner page is revalidated within the write transaction. Unlinked/conflicting records fail explicitly, and failed pages do not advance. Fourteen targeted tests and lint pass. The method is not scheduled or activated; actual reads still await the two-table approval. No complete source coverage or Fresh workbench claim is made.

WP-2402 batch385 adds a separate reconciliation-worker process, because failure of a child in the main composite worker would stop financial processing. The v12 entry is prepared but has not been started. Service controller supports this isolated process and its health report. Optional `--require-reconciliation-projection` on pilot-start includes it and requires a recent completed cycle; default startup is unchanged. Eighty-two affected tool/lifecycle tests and lint pass. Read permissions, actual projection/browser acceptance and fresh-install entry generation remain outstanding; a healthy cycle alone does not establish complete coverage.

WP-2402 batch386 supersedes385 private-entry installation gap: reconciliation-worker now uses a repository-owned entry with the selected installation directory and existing configured-resource loader. No private wrapper or secret copy is needed for that process. Sixty-eight affected controller/start/lifecycle tests and lint pass. It has not been launched; permissions and complete fresh-machine/pilot acceptance remain outstanding.

WP-2402 batch387 fixes legitimate unassociated reconciliation exceptions blocking the workbench. Only PaymentReconciliationDifference may lack Order/payment references; other exception types remain strict. The UI shows unavailable Order text and does not offer order-specific compensation. Such exceptions count in unfiltered Store dashboard totals but are not attributed to a channel/order type. Reconciliation projection retains them and appends a higher version if authoritative links become available; this supersedes384/386 unlinked-failure behavior. Twenty-nine affected tests, relevant types/lint and API build pass. No runtime restart or real browser acceptance occurred; access and fullpilot gates remain pending.

WP-2402 batch388 passes one production-preview browser scenario with both an unassociated reconciliation exception and linked compensation case. The first remains visible without order-specific action; the second queries only its exact case, and refreshed association appears correctly. Fresh demo-mode preview build passes with the existing chunk-size warning. Responses were synthetic/intercepted: real persistent workbench and compensation acceptance remain pending.

WP-2402 batch389 adds bounded Dining owner discovery of immutable exception-task associations. It returns references for later current Task/financial hydration and never treats task creation as payment resolution. Twenty-nine affected tests, Dining types and ownership scan pass. Actual v12 API discovery is unavailable because dining_exception_task exists with expected columns but lacks API SELECT. No permission change or successful live discovery is claimed; Task/financial/projection integration remains pending.

WP-2402 batch390 composes current Task and immutable Dining exception association in one scoped transaction. Exact Task version, tenant/Store/session and observation time are checked; writes and callbacks after transaction completion are denied. Completed Task does not imply financial clearance. Five focused composition tests and lint pass using mocked owner ports. Actual access, financial-resolution and projection acceptance remain pending.

WP-2402 batch391 adds current financial evidence for Dining exceptions through public Ordering/Payment reads and the existing settlement rule. Matching money alone does not clear an exception: a scoped committed finality matching current Order version/checkpoint and amounts is required. Pending or confirmed refunds requiring allocation reconciliation remain indeterminate. Five focused tests, API types/build/lint and import boundaries pass. Actual Task/financial/projection integration and live exception clearance acceptance remain pending.

### Latest local exception journey (WP-2402 batches455–460)

A new normal Dining order completed simulated CAD11.30 payment, acceptance, Kitchen preparation and serving. The ordinary refund completed in batch457: confirmed CAD11.30, pending CAD0.00, Refund receipt version2. Normal session closing committed Closed/version4 and created exactly one assigned Manager Task/version2; the exception workbench renders its Open DiningUnpaidBatch record. The merchant historical serving read was corrected to support OrderOpen/SessionClosed and verified in the running application.

Batch459 completes normal financial finality and order closure after binding immutable confirmed refund allocations. The public episode is ResolvedEpisode/Final and the normal exception workbench renders Resolved. The underlying Task remains Assigned; this does not claim Task lifecycle completion. Original gross capture and receipt history remain unchanged. The original Guest credential is invalid after session closure under Section25.5; do not revive it to provide post-close access.

Worker reliability remains unfinished. The exception worker stopped during this transition; its existing recovery entry successfully projected the final source. Batch460 adds bounded failure category/time retained after shutdown, without raw error details or automatic retries. The updated business-worker PID69477 and exception-worker PID69494 completed real cycles with no recorded failure after reload; this is a point-in-time observation, not sustained reliability evidence. Customer PID68352 loads the finality changes. Recurring worker exits still need diagnosis. Do not recreate the order, repeat its capture, or treat these local simulated results as live Store activation.

### Actual operational reconciliation (WP-2402 batch468)

The Owner approved and the guarded script applied the minimal local v12 reconciliation permissions: run SELECT/INSERT and record/exception INSERT. The explicit Operational runtime then persisted27 checks against existing Test payments:25 Matched and2 Unresolved, with zero Difference, Unavailable or Healed outcomes. The two unresolved payments still require customer action; they are not failures or completed payments.

Same-run replay returns Duplicate with zero Provider queries and no appended records. Actual rollback-only acceptance covers all three table appends and preservation of an exception's first opening across two runs, with no synthetic fixture rows surviving. The exception append implementation uses scoped lookup plus plain INSERT because PostgreSQL append-only rules prohibit the previous ON CONFLICT form. No protection rule was disabled.

Batch469 activates Operational execution in the canonical reconciliation-worker CLI. Minute slots and bounded100-check pages use stable run identities; no due sources means no new empty run. The first observed automatic run at03:59 UTC persisted27 checks (25 Matched,2 Unresolved), approximately13m16s after the prior run completed. Worker PID73773 reported25 completed cycles and no failure at that observation. Restart/backlog behavior has focused tests; broad-load timing, actual healing/discrepancy journeys and DailySettlement evidence remain separate acceptance work. These local simulator results do not authorize live Store/Provider activation.

Batch470 corrects daily reconciliation totals: a refund-only business date can include refunds of earlier captures, so daily refunds need not be bounded by that day's captures. Individual Operational payments retain their capture-backed limit. Invalid calendar dates are rejected. Focused Payment tests and an isolated PostgreSQL migration/constraint acceptance pass. Migration1400_021 is prepared (catalog196); the running v12 database remains at195 migrations. DailySettlement still requires its independent Provider/balance evidence source and runtime integration; these synthetic acceptance fixtures are not actual Provider settlement evidence.

Batch471 adds a read-only simulator journal window source independent of internal Payment totals. Actual existing-journal inspection returns23 captures and6 refunds with stable repeated content digest. Completed UTC windows are explicit; they are not yet resolved Store Business Dates. Daily source comparison and scheduling remain unimplemented. The source fails explicitly above100000 scoped journal rows and is restricted to the current InternalTest installation. No actual Provider settlement or live activation is established.

Batch473 connects the published Store configuration to the last closed Business Date window using historical reads and checks at both boundaries. Actual Toronto BusinessDate2026-09-20 spans08:00Z to next08:00Z; the independent simulator journal returns6 captures and0 refunds within that exact window. Internal Payment totals and persisted DailySettlement comparison remain pending. Configuration transitions within a day fail explicitly instead of using an assumed historical policy. No Store configuration or running database migration was changed.

Batch474 reads actual Payment-owned terminal captures for the same BusinessDate2026-09-20 window:6 internal and6 simulator captures, exact capture amounts equal. This proves the capture side only. Refund daily totals remain pending: ordinary refunds preserve Provider-created time in validated observations, while compensation providerConfirmedAt records observation time and cannot be substituted for refund occurrence. Full DailySettlement completion is not established.

Batch476 connects complete ordinary-refund recovery/confirmation history to the closed-day source. Actual scan finds4 ordinary refund operations, all resolved, with0ordinary refunds in BusinessDate2026-09-20. Compensation refund dates/totals remain separate and uncompleted; full daily reconciliation is not yet established. No new refund was issued.

Batch477 confirms actual recovery of both compensation refunds' single simulator refund records via their original request bindings. Separate Provider-created time is available; original providerConfirmedAt remains observation time. Neither refund falls within the inspected2026-09-20 business day. This is read-only diagnostic evidence; canonical compensation daily source, persisted DailySettlement and scheduling remain pending. No refund was reissued.

Batch479 assembles complete actual InternalTest daily sources for BusinessDate2026-09-20. Capture and combined ordinary/compensation refund totals both match the independent simulator journal; all4ordinary operations are resolved and2compensation refunds are individually bound. The prepared source bundle is protected locally. This is a complete read-only candidate, not yet a persisted DailySettlement run or automatic daily schedule, and not real Provider settlement evidence.

Batch480 persists the first actual DailySettlement run for BusinessDate2026-09-20:1 Matched check, exact Duplicate replay and complete stored-result readback. Source evidence was prepared before the run cutoff and retained locally. The running v12 still has195 migrations: canonical runner refuses pending1400_021 as out-of-order. This day's actual amounts satisfy the old constraint; refund-only-day deployment remains incomplete until a data-preserving replacement installation applies the full196-migration catalog. No bypass or history edit was used. Automatic daily scheduling is still pending.

### Current v13 installation recovery material (WP-2402 batch501)

`.local/pilot-v13/recovery-installation501` retains30 current installation files,
including `daily-settlement-coverage.json`, current database bindings, configured
Dining table files and original protected keys/passwords. Its private manifest
maps each saved file to its original source. Copy readback and a second source
comparison passed with no changes or external export. Keep this directory private;
do not commit, print or attach its contents.

This is an installation-only snapshot. It is not paired with a new PostgreSQL and
simulator snapshot and does not replace recovery-491. Do not combine snapshots
arbitrarily or reset daily coverage to a newer configuration. Batch502 updates
`pilot-recovery.mjs` to retain installation dependencies immediately after service
stop and recheck source and copied bytes before writing successful recovery evidence.
Batch503 executes this path:382 PostgreSQL tables/8455 rows,4 simulator tables/60 rows and30 installation files are preserved; original services resume successfully. A separately rebound isolated installation using the paired backup passes the configured daily financial-source read with original API-role access and matching simulator totals. No target workers are started and no new refund is dispatched. A complete future recovery must preserve these
files at the same controlled backup boundary and verify restored application
bindings and history before cutover. No fresh-machine recovery is claimed.

Batch504 adds bounded pre-transaction database-acquisition retry to reconciliation
and Dining exception workers: at most3 retries after5/10/20seconds, using the same
recovery cursor/scheduler. Scope, transaction, permission and malformed-result
errors still stop the workload. Twenty-eight focused tests pass; both updated
processes completed actual normal cycles after reload. Batch505 also proves actual pre-transaction connection failure and same-process
recovery for both workers against the isolated503 restore, with failed cycles not
counted as successful. General crash supervision and mid-transaction interruption
remain outside this evidence.

Batch506 finds a real precoverage discrepancy: simulator capture totals exceed
internal terminal facts by CAD22.60 before the first supported full day. Seven
captures match; one simulator capture has no matching Payment operation/intent
through the public owner reader. No refund occurs in that interval. This remains
unresolved and must not be hidden by the later daily coverage start or by
internal-intent-only operational scans. Private diagnostic evidence is retained;
no journal deletion or financial history rewrite has been performed.

Batch507 traces the same unmatched capture back to the earliest retainedv4
simulator. Its amount and behavior match the independent adapter self-test
recorded in WP-2402 batch15, which intentionally created no business paid result.
Exact original run identifiers were not retained, so test-residue attribution
remains an evidence-supported explanation rather than a proven exemption. The
record is preserved and remains in journal totals;491/503 restore did not create
it. No automatic refund, deletion or fabricated Payment record is justified.

## Historical Pickup journey record (batches415–417)

Earlier rendered Pickup evidence (WP-2402 batch415, 2026-09-21): a fresh customer
session completed menu, Cart, Quote, simulated payment, merchant acceptance,
Kitchen preparation, proof verification and explicit pickup handoff using the
repository-composed runtime. The same customer session displayed **Order collected**
and **Version 1: Original** receipt: CAD 11.30 captured, CAD 0.00 confirmed/pending
refunds. This is local DEMO evidence. Manual order refresh is required; receipt
live delivery/support remains unavailable. The four local authority proposals were executed in batch423; later exception, compensation and reconciliation evidence is summarized in the current acceptance table. Full pilot acceptance remains open.

Batch416 then completed an ordinary CAD 11.30 refund of that same order through
staff request, preparation, simulated send and reconciliation. The original
customer session shows confirmed refund CAD 11.30, pending CAD 0.00, preserved
Original and appended Refund receipt versions. Batch417 fixes the observed
merchant summary staleness: request recording/recovery, execution status reads
and successful send/reconciliation refresh the independent payment summary.
Manual refresh is also available. Failed reads hide summary amounts while keeping
the existing refund intent; browser recovery tests preserve same-request retries.
Actual existing-order manual refresh shows CAD 11.30 refunded and CAD 0.00 pending.

## Daily backup and weekly restore drill (WP-2423)

`tooling/environment/pilot-backup.sh` needs only docker on the host and runs while all services
keep serving.

- `backup` takes one consistent online `pg_dump` (custom format) into a private directory (`0700`,
  files `0600`), writes `<file>.manifest.json` with its SHA-256 and the row count of every table
  counted from the dump itself, and keeps the newest `--keep` backups (default 14).
- `drill` verifies the newest (or `--backup`) dump against its manifest, restores it into a new
  database `<db>_drill_<UTC time>` in the same server, requires every table's row count to equal the
  manifest, writes `drill-<UTC time>.json` and drops the drill database (`--keep-drill` keeps it).
  A tampered or incomplete dump stops before any database is created.

```bash
tooling/environment/pilot-backup.sh backup --container <postgres container> --port <port> --database <db> --user <migration role> --password-file <private password file> --dir <private backup dir>
```

```bash
tooling/environment/pilot-backup.sh drill --container <postgres container> --port <port> --database <db> --user <migration role> --password-file <private password file> --dir <private backup dir>
```

Schedule on the pilot host (systemd timers or cron, owned by the service user): `backup` daily
after the Store closes and `drill` weekly. Alert on a non-zero exit. The local copy has the same
trust boundary as the database volume; copying backups off the host (required for P4) must use
storage that encrypts at rest with a managed key, and the off-host target is an external P4 input.
The command prints only the file name and table/row/byte counts, never credentials or row contents.

First local run (v15, 2026-10-09): backup 532 tables / 525,651 rows / 37.8 MB in 8 s with services
serving; drill restored it in 49 s and every table matched; a byte-flipped copy was refused with
`checksum mismatch` before any database was created.
