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

The customer payment mode now comes from the runtime file `payment.json` in the
pilot runtime directory, served at `/bff/customer/payment-configuration`
(internal simulation and the local root entry for InternalTest when the file is
absent; Stripe when it is present), so rebuilding the customer frontend uses a
normal `pnpm --filter @bop-rms/customer-pwa build` with no build-time payment flag.
No QR-token URL is needed for the local root entry. Switching the installation to
Stripe test mode (and the later live-mode gate) follows
[Switching the pilot to Stripe](./pilot-stripe-switch.md).

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
the certificate expires2026-10-20; renew it beforehand with the `renew` mode of
`pilot-provision-tls.mjs`, restart the services and replace the trusted certificate on each
device ([renewal steps](../../tooling/environment/README.md#renewing-the-local-pilot-certificate)). Future cloud migration must preserve paired database/simulator and
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

## Table QR codes (WP-2423 Q11)

Store Managers and Owners manage table codes on **Table QR codes** (`/app/operations/tables`,
permission `dining.table.qr.manage`); see
[DEC-TABLE-QR-ISSUANCE](../spec/design/table-qr-issuance-pilot.md).

- **First setup**: Create code for each table, then Print all codes. Print the downloaded page at
  100% scale (each code 6 cm); cut and place each code on its table.
- **Damaged sticker**: Print that table again. The code does not change.
- **Lost, stolen or copied code**: Replace that table's code at once, then print it. The old code
  stops admitting guests immediately; other tables are unaffected. If guests are seated, their phones
  must scan the new code and enter the table's joining code again; their orders and bill stay.
- **Table out of service**: Turn off its code. Guests who scan it are asked to see staff.
- **Before codes end** (180 days): the Table QR codes page and the Tables board warn 30 days ahead.
  Replace and print before the date under each code.
- **Network, server or printer down**: codes already on the tables keep working once service
  returns. Take orders at the counter or on paper meanwhile
  ([outage procedure](#store-outage-procedure-wp-2423-q9)). The downloaded print
  page works offline and can be printed from any computer or saved as PDF.
- **TEST-ONLY until the Secrets and Tls gates close**: codes are signed with the local internal-test
  key and point at `https://127.0.0.1:4443`, so phones cannot scan them. After the managed QR key and
  the public customer domain arrive, replace and reprint every code. The same applies to any later
  change of `customerOrigin` or a compromised QR key
  ([hosting](#hosting-customer-domain-certificate-and-managed-secrets-wp-2423)).

## Opening and closing the store (WP-2423)

Added after the 2026-10-17 store-day rehearsal (WP-2423 `3cd0f8dd` M6). Home shows the same lists
as an **Opening and closing** card, each line with what the store's records say now ("Done", "3
left") and a link to the screen where it is done; lines for screens a staff member does not have
are left out. The card reads the same sources as **Right now** (orders, pickups, tables,
exceptions) and the last closed day's settlement.

**TEST-ONLY store hours.** The DEMO store's published hours are **12:00 AM–11:59 PM every day**, a
test value so the internal-test store is always "Open" whenever someone tests it. Guests see these
hours (for example on the "isn't taking orders right now" page while ordering is paused). They are
not the store's real hours. Before real customers, the Owner sets the real opening hours in
`Store setup` → hours and publishes them; until then, whether guests can order is controlled only
with `Hours & ordering` → `Pause service` / `Resume`.

### When you open

1. Sign in on the counter tablet and open **Home**. The **Store system** card (Owner, Store
   Manager) must say "Everything is working"; if not, see
   [What each alert means and what to do](#what-each-alert-means-and-what-to-do) or the
   [outage procedure](#store-outage-procedure-wp-2423-q9).
2. If online ordering was paused at closing: `Hours & ordering` → `Resume`.
3. **Settlement for the last closed day** (Owner, Store Manager): Home shows "Matches the payment
   provider", "N payments to look at" or "Not checked yet". Anything but a match: open
   `Settlement` for that day and follow its "What to do".
4. **Pickups from earlier days**: Home shows them apart from today's. On `Pickup` → "From earlier
   days — check and close": hand over any the customer is collecting now; a manager marks the rest
   `Mark not collected`.
5. **Tables still open from before**: on `Tables`, a manager or the owner closes each table whose
   guests have left.
6. Open `Orders` and `Kitchen` (kitchen display) and leave them on for the day; the Orders screen
   must stay open whenever the store is open (paid pickups have 30 minutes to be accepted).

### Before you close

1. **Stop new orders**: when you stop taking orders, `Hours & ordering` → `Pause service` → `All
services` for the hours until opening. Guests who scan then see "isn't taking orders right now".
   Tables already seated can still order on their phones: tell them it is last orders.
2. **Every order made and served or handed over**: `Orders` shows nothing left open. A paid pickup
   still waiting at the end of the day: call the customer if the order shows contact details; if it
   was not collected, a manager presses `Mark not collected`.
3. **Tables closed once the guests have left**: only the Owner or a Store Manager closes a table
   (cashiers see "A manager or the owner closes the table"). Home shows how many open tables are
   served and waiting to be closed.
4. **Exceptions handled or noted for tomorrow**: Home "Open exceptions" → `View exceptions`.
5. **Settlement**: today's online payments are checked against the payment provider automatically
   after the business day ends; look at the result when you open (step 3 above). Compare
   `Settlement` "Store card machine" with the card machine's own batch report for the day.
6. Leave the counter tablet charging. Signing out is not required; a staff screen signs itself out
   after 30 minutes without use.

## Chinese TEST demo menu (WP-2423 item 8 ③)

The pilot's internal-test menu for a Cantonese and Sichuan restaurant is
[`docs/pilot/demo-menu-chinese-test.json`](../pilot/demo-menu-chinese-test.json): 22 dishes in six
sections, each with an English and a Chinese name, the four choice groups (spice level, portion,
add rice, hot or iced), allergens and TEST prices (checked by
`tooling/environment/pilot-demo-menu.test.mjs`). Prices are for testing only; keep "TEST" in the
menu or section name while it is on the pilot.

To put it on the pilot, a manager enters it on the back office's catalog pages, in this order:
choice groups and their options with prices; each dish with its English and Chinese name,
description, allergens, tax class, price and the choice groups listed for it; the sections in the
order of the file; then publish the menu. Guests see each name in their phone's language; the
kitchen shows the Chinese name first with the English one under it. Check one dish of each
section on a phone in both languages and on the kitchen screen before testing with staff.

## Store outage procedure (WP-2423 Q9)

What staff do when the store network, the pilot host, the payment Provider, the card machine or a
store tablet fails. Authority: IDR-0039 (Handoff Package §87.11.1: no printer, no offline command
queue; continuity pauses new orders and payments; staff fulfil only already-paid work from evidence
they can see; never write down card numbers, key a card by hand, take cash or invent a success
state; card-machine receipts taken during an outage go on an incident sheet and are entered after
recovery with reference, reason and a duplicate check) and
[DEC-COUNTER-PAYMENT-RECORD](../spec/design/counter-payment-record.md) (store card machine, no
cash, "Recorded after outage" within 72 hours). Every step below names a screen that exists today;
where the product cannot do what a real store needs, the step says so and the gap is listed at the
end. Staff-facing names are the on-screen English labels.

**Status**: procedure written 2026-10-14; **not rehearsed**. The rehearsal below is an external
gate (it needs the Owner's staff, the store's devices and network, and the card machine).

**Several Stores on one installation** (DEC-BRAND-MULTI-STORE-ONE-INSTALLATION): when the
installation serves more than one Store of the brand, the pilot host is one failure point for all
of them. If the host is down, **every Store runs this procedure on its own**: its own incident
lead, its own paper slips and incident sheet (write the Store's name at the top of each), its own
card machine, and its own back-entry after recovery, signed in to that Store (Home shows the Store
name; switch Store before entering anything). Never enter one Store's slips or card-machine
receipts while signed in to another Store. A failure confined to one Store (its network, its
tablet, its card machine) is handled by that Store alone; the other Stores keep trading normally.
An Area Manager covering several Stores is the incident lead only for the Store they are in.

### Roles during an outage

- **Incident lead**: the Store Manager or Owner on shift. Only they can pause online ordering
  (`Hours & ordering`, permission `operations.ordering.pause`), record card-machine refunds and see
  `Settlement` and `Exceptions`.
- **Counter**: Front of House. Takes paper orders and card-machine payments; after recovery enters
  pickup slips in `Counter order` and dine-in slips on their table in `Tables` →
  `Take order for table …` (Front of House, Store Manager and Owner have both).
- **Kitchen**: works from paper tickets while the Kitchen board is down.
- **Pilot operator**: the person who runs the pilot host (today the Owner's machine; P4 cloud host
  later). Restarts services; not on the shop floor.

### Who to call (Owner input, not yet provided)

Fill in before UAT and keep a printed copy at the counter. Do not commit real numbers to Git.

| Need                           | Contact (Owner fills in) | Notes                                             |
| ------------------------------ | ------------------------ | ------------------------------------------------- |
| Incident lead / Owner          | _OWNER INPUT_            | Decides pause, closing early, customer goodwill   |
| Pilot operator (host restart)  | _OWNER INPUT_            | Alerts reach them once channels are set up (Q13)  |
| Internet provider              | _OWNER INPUT_            | Account number kept off Git                       |
| Card machine provider support  | _OWNER INPUT_            | Ask whether the machine has its own mobile data   |
| Payment Provider (online card) | _OWNER INPUT_            | Stripe account is an external gate (P2); none yet |

### Kit to keep at the counter (Owner input)

- A backup internet path that does not depend on the store line: a phone hotspot or a mobile router,
  charged, with its name and password on a card in the drawer. _OWNER INPUT: device and plan._
- One backup device able to show the Kitchen board (any tablet or phone with a current Chrome or
  Edge; the board works at phone width), charged, with its charger.
- Printed copies of this section's checklist, 30 paper order slips, the incident sheet and a sign:
  "Online ordering is paused — please order at the counter."
- Confirm with the card machine provider whether the machine keeps working when the store internet
  is down (built-in mobile data) and write the answer here: _OWNER INPUT_. If it cannot approve
  cards, the store cannot take payment (no cash, no card numbers on paper, no "pay later" IOUs).

### 1. Detect: what staff see

Check from a phone on mobile data (Wi-Fi off) to tell a store-network fault from a host fault: if the
customer menu or `Orders` loads on mobile data, the host is up and only the store network is down.

| Failure                       | What staff see                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | What customers see                                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store network down            | `Orders`: "Orders could not be refreshed. Showing the last update; retrying automatically." (the last list stays). Kitchen board: the last tickets stay on screen, read-only: "Read-only until reconnected — Offline — showing the last update from HH:MM. Actions are paused until the connection returns. Trying again automatically." Accept/Start/Complete/Mark ready are disabled; the board retries by itself (5 s, then up to every 30 s) and returns to normal on its own. `Pickup` and `Tables` keep their last list the same way with handoff and table actions paused. | Guests on mobile data **can still order and pay online**; the store cannot see those orders. Guests on store Wi-Fi see "You are offline. Transaction and identity actions are unavailable."                                   |
| Pilot host down               | Same as above on every device, including on mobile data; Kitchen shows the same read-only board, worded "Connection lost — showing the last update from HH:MM …". `Exceptions`: "Data may be out of date".                                                                                                                                                                                                                                                                                                                                                                        | Pages fail to load or show "Try again"; scanning a table code cannot start a visit. A guest whose payment was in progress may see "Payment confirmation pending. Do not submit another payment." or "Payment result unknown". |
| Payment Provider down         | Store screens work; new online orders stop arriving as paid ("Awaiting payment").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Online payment fails. Pilot today uses simulated online payments; the real Provider behaviour is an external gate (P2/Q22).                                                                                                   |
| Card machine down             | Nothing in the product.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Counter and paper orders cannot be paid.                                                                                                                                                                                      |
| Kitchen tablet dead or frozen | Only that device. `Orders` on the counter tablet still works.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Nothing, unless orders stop being made.                                                                                                                                                                                       |

### 2. Immediate actions (first 5 minutes)

1. **Counter**: tell the incident lead; note the start time on the incident sheet.
2. **Store network down**: join every store tablet to the backup hotspot. The Kitchen board recovers
   on its own once connected (press `Refresh` to try at once) and reopen `Orders`. While the board
   says "Read-only until reconnected", the tickets shown are as of the time given and new orders do
   not appear on it; its action buttons are paused and nothing is queued for later. If they recover
   within a few minutes, carry on normally and go to step 5 (check what arrived meanwhile).
3. **Pause online ordering** if the network does not recover within 5 minutes, the host is down,
   or the kitchen cannot see orders. Incident lead, from any device that has a connection (their
   phone on mobile data is fine): `Hours & ordering` → `Pause service` → Service `All services`,
   `Pause duration (minutes)` long enough to cover the outage (it can be resumed early). New scans
   then show "<Store> isn't taking orders right now … order with a staff member." If the host is down
   the pause cannot be set, and nothing can be ordered online anyway.
   - Pause does **not** stop guests already seated at a table from adding rounds and paying on their
     phones. Tell each seated table: "Please order with us at the counter for now." Their paid rounds
     are not lost; they wait in `Orders` until accepted (dine-in rounds do not expire).
4. Put the sign at the door and on the counter. Switch to paper (section 3).
5. **Paid pickup orders you cannot see are held, not refunded.** A paid online pickup order must
   normally be accepted within 30 minutes of payment ("Accept within N min" in `Orders`). The system
   knows the store is offline when no signed-in staff screen (`Orders`, `Kitchen`, `Counter order`)
   has reached it for more than 5 minutes. If an order's 30 minutes end while the store is offline
   (store network down, or host down), it is **not** closed or refunded: it waits as "Paid during an
   outage · decide", and the customer's order page says "The store hasn't confirmed your order yet.
   Please wait or contact the store." Once staff screens are back, the store has **15 minutes** to
   accept or refund each held order; after that an order nobody accepted is refunded automatically
   as before. Keep at least one `Orders` screen open whenever the store is open: an order whose 30
   minutes end while a staff screen is open is refunded as usual if nobody accepts it. In the last 5
   minutes every signed-in staff screen (Home, `Orders`, `Kitchen`, `Tables` and the rest) shows "Order
   N will be refunded automatically in N min unless someone accepts it." and chimes at 2 minutes and
   30 seconds (sound starts once someone has touched that screen); the kitchen display says to ask
   the counter, since kitchen staff cannot accept. A screen that lost its connection keeps counting
   down from the last deadline it read. Still pause
   online ordering so no new online orders arrive. See section 5 step 1 for the decision.
6. **Kitchen tablet failure only**: sign in on the backup device as the kitchen staff member
   (today the internal-test staff page, "Start kitchen display as …"; real staff accounts wait for the
   Cognito gate), open `Kitchen`, set the device never to sleep. The board shows the current tickets
   again; nothing was lost. No paper needed unless no device is available. A device signed in with
   the ordinary staff sign-in ("Enter as …", for the counter or office) shows `Kitchen` as
   "View only on this screen"; press "Start kitchen display here" (it signs that staff member out)
   and choose "Start kitchen display as …" so Accept, Start and Mark ready work on that device.
7. **Host down**: call the pilot operator. Operator restarts the pilot (v15:
   `PILOT_UID=… PILOT_GID=… PILOT_RUNTIME_DIRECTORY=.local/pilot-v15 PILOT_OFFSITE_DIR=<off-site folder> docker compose -f compose.pilot.yaml up -d pilot`,
   then confirm `/ready` returns 200; details in
   [Existing runtime configuration and recovery](#existing-runtime-configuration-and-recovery), which
   still describes the v14 WSL host).

### 3. Taking orders on paper

- Write one slip per order (template below). Use the menu prices on the printed or on-screen menu;
  the amount charged must be the menu total **including tax** and the tip the customer chooses, so
  that the back-entry later shows the same "To charge" (the system recomputes it; see gap G4).
- **Payment**: on the store card machine only, before the order goes to the kitchen. Write the
  slip's approval/reference code and the time. Never write a card number, expiry or CVV; never key a
  card by hand; no cash; no "pay later".
- If the card machine cannot approve, do not take the order.
- Pickup: give the customer the slip number (P-01, P-02, …) and call it when ready.
- Dine-in: write the table number; one slip per round. After recovery each slip is entered on that
  table, so it joins the table's order (section 5 step 5). Seated guests who already paid a round
  online keep their phone's order number: write it on the incident sheet as "paid online, order N".
- A customer who says they paid online but you cannot see it: ask for the phone's screen. If it
  shows "Payment confirmed" (or the order status shows "Payment received") with an order number,
  write the order number on the incident sheet, make the order and treat it as paid; do **not**
  charge on the card machine. If it shows "Payment confirmation pending" or "Payment result unknown",
  **do not take a second payment**: write the order number and the customer's first name on the
  incident sheet, and ask them to wait or return; settle it once the system is back (section 5).
  If they will not wait and want the food now, the incident lead decides; if the card machine is
  used, mark the incident-sheet line "possible duplicate" so it is checked and refunded after
  recovery.

#### Paper order slip (print and cut)

```text
+---------------------------------------------+
| PAPER ORDER    Slip no. ______  (P-01...)   |
| [ ] Pickup  name: ____________              |
| [ ] Dine-in table: ______  round: ___       |
| Taken at (time): ____:____  by: _________   |
|---------------------------------------------|
| Qty | Item               | Options / note   |
|  _  | __________________ | ________________ |
|  _  | __________________ | ________________ |
|  _  | __________________ | ________________ |
|  _  | __________________ | ________________ |
| Allergy asked? [ ] yes -> see manager       |
|---------------------------------------------|
| Total incl. tax $______  Tip $______        |
| Card machine total $______                  |
| Paid at (time): ____:____                   |
| Slip ref / approval code: __________        |
|   (NO card number, NO cash)                 |
|---------------------------------------------|
| Kitchen: made [ ]  handed/served [ ] ____   |
| After recovery: entered as order no. ______ |
|   by ______ at ____:____                    |
+---------------------------------------------+
```

Allergy requests are not taken on paper beyond "ask the manager": the Kitchen board's allergen cues
are not available on paper, so the manager checks the recipe before the item is made (IDR-0041).

#### Incident sheet

```text
INCIDENT SHEET    Date ________  Lead ____________
Started ____:____  Paused online ____:____  Resumed ____:____  Ended ____:____
Cause: [ ] store network [ ] host [ ] Provider [ ] card machine [ ] tablet
| Time | Slip no. / online order no. | What happened | Paid how (card machine ref / online) | Checked after recovery |
|      |                             |               |                                      |                        |
Notes (possible duplicates, refunds, goodwill given):
```

### 3a. Tables that pay at the end (pay later) during an outage

Added 2026-10-27 (WP-2423 item 8 ①, [DEC-TABLES-SERVER-MAIN](../spec/design/tables-server-main-screen.md);
[DEC-DINE-IN-PAY-LATER](../spec/design/dine-in-pay-later.md)). A table that pays at the end has no
payment per round, so section 3's "card machine before cooking" does not apply to it. The `Tables`
page shows the same steps under "While the connection is down" while it cannot reach the store
system (staff cannot open this document offline).

- **New rounds**: one paper slip per round with the table and round number; no payment now. Pass it
  to the kitchen as in section 4. Guests on mobile data may still send rounds from their phones,
  which the store cannot see: the incident lead pauses online ordering (section 2) and staff tell
  seated tables to order with them for now.
- **Serving**: tick each dish on its slip when it is served.
- **Comps and discounts**: only the incident lead (a manager) decides. Write on the slip which dish,
  comp / percent off / amount off, the reason and the manager's name. Never just leave a dish off the
  bill (AGENTS.md: no sales suppression); it is recorded in recovery step 5 before the payment.
- **Guests and tea** (WP-2423 item 8 ⑦, when the store asks for the party size and has a tea
  charge): write the number of guests on the table's first slip and add the tea by hand, one per
  guest at the menu's tea price (fewer only where staff agreed, for example a child not charged:
  write why and who agreed). It is never left off the bill. When screens come back, record the
  number of guests on the table (the tea then follows it) or, if the tea was charged differently,
  change the tea count on the table with the reason.
- **Moving a table** (WP-2423 item 8 ⑧): on the table's first slip write "moved from table A to
  table B" and the time, and carry the slips to table B. When screens come back, open table A on
  `Tables` and use `Move to…` to record it (table A is then marked for cleaning); guests scan
  table B's code and tap `Join this table` to keep ordering (any phone can; no host is needed,
  and their order and bill are there). If the host's phone rejoined and needs to be host again,
  use `Dining host transfer` on the table. A table with a party can't be joined to another yet.
- **Setting up the tea item** (owner, once): on `Menu`, press `New dish`, enter its name and
  price, and under its allergens choose `A charge, no stock ingredients (such as tea)`; save, mark
  it `Not prepared by the kitchen`, and press `List it`. Do not hide it: guests never see the tea item on their menu, and a
  hidden item can't be added by staff. Then on `Store features` choose it under `Tea charge`
  (only listed, priced items shown here can be chosen; one hidden from this store says so).
- **The bill**: the last bill seen on `Tables` (if it was open) plus the paper rounds, at the menu
  prices including tax. The guests choose the tip (none is chosen for them).
- **Payment**: on the store card machine as usual, or in cash (rounded to 5 cents, change given).
  On the incident sheet write the table, total, tip, time and the card slip's reference code, or
  for cash the amount received and the change. Never write a card number, expiry or CVV.
- **Payment provider down only** (screens work): guests cannot pay on their phones; take the table's
  payment on the card machine or in cash from `Tables`. If a guest's phone payment stays "in
  progress", press `Stop the phone payment` first (a payment the guest did finish is kept).
- **Guests leave without paying**: the incident lead writes it on the incident sheet; it is recorded
  in recovery step 5 as "Guests left without paying" (manager), never left open or deleted.
- **A tablet fails**: carry on from another store tablet or a phone signed in to the merchant
  workspace (PIN switch on shared tablets); nothing is stored only on the failed device.

### 4. Kitchen without the Kitchen board

- The counter passes each paid paper slip to the kitchen; the kitchen keeps slips in time order on a
  rail and ticks "made" on the slip. There is no printer (IDR-0039).
- Tickets already on the board when it went down disappear from the screen. Before switching to
  paper, the counter reads the last `Orders` list (it stays on screen) and writes a slip for each
  accepted, unfinished order, marked "online order N".
- When the board returns, older online orders are still there; the kitchen marks them `Mark ready`
  as it finishes them as usual. Do not remake an online order that a paper slip already covers.
- **Merging tables** (WP-2423 item 8 ⑨): to seat one party with another, open the first table on
  `Tables` and use `Merge into…` to choose the other table (both must pay at the end, still be
  ordering, and have nothing paid or split yet; a table that hasn't ordered can only be merged
  into one that has). Its rounds, bill and guests join the other table, the tea follows the
  guests, and the first table waits for cleaning; its phones scan the other table's code to join
  (no host needed). If the guests have dishes in their cart they haven't sent, ask them to send
  or clear them first. There is no un-merge: if tables were merged by mistake, split the bill with
  `Each pays own rounds` when paying. Without screens, write "table A merged into table B" and the
  time on table A's first slip, carry the slips to table B, and record it with `Merge into…` when
  screens come back.
- **Kitchen sections** (WP-2423 item 8 ⑧): the owner names the sections once on `Store features`
  under `Kitchen sections`, and gives each dish its section on `Menu` (a dish with none shows under
  `No section`). The board can then show one section on a screen, chosen on that screen and kept
  on that device; it counts the orders waiting in the other sections. Without the
  board, the counter writes the section beside each dish on the slip and hands the slip to that
  section first. A screen left on one section shows only that section: switch it back to
  `All sections` if one screen has to cover the whole kitchen.

### 5. Recovery (when screens load again)

Do these in order, before resuming online ordering.

1. **Decide orders paid during the outage first** (within 15 minutes of screens coming back): `Orders`
   shows "Paid during an outage — decide" with the number of held orders; press `Show these orders`
   (or filter Order status "Paid during an outage — decide"). Each shows "decide within N min". For
   each one: if the kitchen made it from a paper slip or can make it now, press `Accept` (then mark
   it ready in Kitchen and handed over in Pickup if it was already handed over); if it cannot be
   made or the customer is gone, a manager or owner presses `Refund instead` → `Refund order`. The
   customer is refunded in full to their original payment method and their order page says "The
   store couldn't accept your order, so your payment was refunded to your original payment method."
   An order not decided within the 15 minutes is refunded automatically. If the screens drop again
   before the 15 minutes end, the order is held again and the 15 minutes restart when they return.
2. **Accept what is waiting**: `Orders` shows "N orders are waiting to be accepted" and each paid
   pickup order's "Accept within N min"; accept every paid order you can make or have made, most
   urgent first. Dine-in rounds paid during the outage appear here too (Order status `Submitted`).
3. **Check customers who paid online during the outage** (incident sheet "paid online, order N" and
   "pending" lines): open each order in `Orders`. Paid and still open → make or confirm it, then
   hand over / serve. "Awaiting payment" or not found → the online payment did not complete; take
   payment on the card machine through `Counter order` as a normal counter order (for a dine-in
   round, through `Tables` → `Take order for table …` as in step 5, without "Recorded after an
   outage"). Never charge both.
4. **Enter paper pickup orders** in `Counter order`, one per paid slip, by the counter staff who
   took them or the lead (dine-in slips: step 5):
   - tick "Recorded after an outage (taken on paper)", enter "Paid at (store time, from the paper
     order)" from the slip (within the last 3 days), add the same items, options and tip;
   - check "To charge" equals the card machine total on the slip; if it differs, stop and give the
     slip to the incident lead (gap G4);
   - `Send order`, then enter the slip reference and press `Paid on card machine`. The page says
     "Recorded after the outage and accepted. If it was already made and handed over, mark it ready
     in Kitchen and handed over in Pickup." Do that for each one (gap G5);
   - write the order number on the paper slip ("entered as order no.").
   - Pressing `Send order` again with the same screen never creates a second order; if the screen
     reports that it did not go through, nothing was charged and it can be sent again.
5. **Enter paper dine-in rounds** on their table, one per paid slip, in slip time order
   ([DEC-STAFF-DINE-IN-ROUND](../spec/design/staff-dine-in-round.md)). Do this before closing the
   table (step 8): the round joins that table's order, so the card-machine payment, tax, tip, sales
   and stock are recorded as dine-in for that table, and the guests' own phones show it as
   "Entered by staff". Do not enter dine-in slips in `Counter order`.
   - `Tables` → select the slip's table → `Take order for table …`;
   - tick "Recorded after an outage (taken on paper)", enter "Paid at (store time, from the paper
     order)" from the slip (within the last 3 days), add the same items, options, kitchen notes and
     tip. This works even after the store has closed for the day;
   - check "To charge" equals the card machine total on the slip; if it differs, stop and give the
     slip to the incident lead (gap G4);
   - `Send order`, then enter the slip reference and press `Paid on card machine`. The page says
     "Recorded after the outage and added to the table's order. If it was already made and served,
     mark it ready in Kitchen and served on the order." Do that for each one (gap G5);
   - write the order number on the paper slip ("entered as order no.").
   - If the page says guests at this table have items in their shared cart that haven't been sent,
     ask them to send or remove those items on their phone first; if a guest is paying on their
     phone right now, wait a minute and send again. If the table is marked unavailable, mark it
     available in `Tables` first. Sending gives the table a new table code: a code handed out and
     not yet used stops working; guests already at the table stay joined. If the table's session
     was already closed, the entry opens a new one for it; close it again in step 8.
   - **Tables that pay at the end** (section 3a), one table at a time, in this order — a comp
     can't be added once the table's payment is recorded:
     1. enter the table's paper rounds as in step 5 (`Tables` → `Take order for table …`, "Recorded
        after an outage (taken on paper)");
     2. mark the dishes served (`Serve all` on the table, or `Served` per dish);
     3. the manager records each comp or discount written on the slips (`Comp or discount` on the
        table: the dishes, how much and the reason; on a shared tablet the manager signs in);
     4. `Start checkout` if it was not started; check the bill matches the paper total; choose the tip
        the guests paid; tick "Paid while the system was down (enter it from paper now)" with the time
        from the incident sheet (within 3 days); choose card machine (slip reference) or cash (amount
        received); confirm the amounts shown, then record it. If the bill differs from the paper, stop
        and give the slip to the incident lead;
     5. guests who left without paying: the manager records `Guests left without paying`;
     6. `Close table …`, then `Cleaned` once it is cleaned.
6. **Expired online pickup orders** (rare since G1 is handled: only orders whose 30 minutes ended
   while a staff screen was still online, or held orders not decided within the 15 minutes): in
   `Orders` filter "Expired · refunded" for the outage period. For each one the kitchen actually made
   and handed over from paper: the customer has already been refunded automatically to their card;
   the order cannot be re-charged online. The
   incident lead contacts the customer if the order shows contact details, explains, and with their
   agreement takes payment on the card machine and enters it as a `Counter order` "Recorded after
   outage" (same items); if they decline or cannot be reached, record it on the incident sheet as a
   loss. Do not charge without the customer's agreement.
7. **Possible duplicates**: for every incident-sheet line marked "possible duplicate", open the
   online order. If it shows paid, the card-machine charge is the duplicate: refund it on the card
   machine at once, do **not** enter that paper slip in `Counter order`, and write "refunded on
   machine, ref …" on the incident sheet (the machine batch then shows the charge and its refund).
   If the online order is not paid, enter the slip as in step 4. If a duplicate was already entered
   as a counter order, the Store Manager or Owner cancels that counter order in `Orders` (recorded as
   refunded on card machine, `Record card-machine refund`) after refunding on the machine. Online
   refunds over CAD 100 or after 24 hours need the approval step (Q5).
8. **Close stale tables**: `Tables` lists "Open a long time" under "Needs action". For each table
   whose guests have left, select it and press `Close table …`: the system checks dishes, payments
   and exceptions before releasing the table, and says what is still open if it can't.
9. **Resume online ordering**: `Hours & ordering` → `Resume …`. Remove the signs.
10. **Exceptions** (Store Manager/Owner): Home "Open exceptions" → `View exceptions`. Look for
    "Paid without a fulfillable order" and "Payment reconciliation difference" created during the
    outage and resolve them as usual.

### 5b. Closing up during or after an outage (WP-2423 item 8 ②)

`Reports` → `Tonight` is the closing summary (sales, what each payment method took, the tables
still open, tonight's cancellations). If it can't reach the store system it keeps the last figures
with their time ("Can't reach the store system · showing the figures from …"); card and cash taken
since then are not in them. At closing:

1. Run the card machine's batch (settlement) and compare its total with "Card machine … taken" less
   card refunds, plus the card-machine slips on the incident sheet taken after that time.
2. Count the table cash: "Table cash that should be in the drawer" plus the cash on the incident
   sheet. The drawer also holds cash from the merchant's own register; count it separately.
3. Write any difference on the incident sheet. Once the paper slips are entered (step 5), refresh
   `Tonight`: it and the next day's settlement include them.

### 6. Day-end reconciliation after an outage day

- `Settlement` for the day:
  - **Store card machine**: "Taken on card machine" (count and tips), "Refunded on card machine",
    "Card machine net", and "N payments were recorded after outage". Compare with the card machine's
    own batch/settlement report for the same day. Count of paper slips with a reference = count of
    card-machine payments on the machine. Any difference goes on the incident sheet with the slip.
  - **Online**: Captured, Refunded, Net. Online and card machine totals are separate and must not be
    added to each other to match either source.
- **Cash for tables** (pay at the end): "Cash taken" and "Cash refunded" on `Settlement`; compare with
  the drawer count of table cash. "Comps and discounts by a manager" lists what managers took off
  bills that day (not money taken).
- A paper slip paid on the machine and not yet entered can still be entered for 72 hours; after that
  the system refuses it, and the incident lead records it on the incident sheet for the Owner.
- The pilot operator reads the daily settlement result for the day (see
  [Daily settlement handover](#daily-settlement-handover)) on the next day.
- Keep the incident sheet and paper slips with the day's card machine batch report.

### 7. Refunds and item cancellations while the Provider or network is down

Added after the 2026-10-17 store-day rehearsal (WP-2423 `3cd0f8dd` M8). What the product does today:

- **Online payment, refund asked for by the customer** (`Orders` → order → `Payment` → refund
  request): the request is recorded first, then sent to the payment provider. If the provider or
  the internet is down, the page says it is not confirmed the provider received it and that the
  refund stays recorded as not sent. Nothing is lost and it is never sent twice. When the provider
  is back, open the order again: the refund shows "Recorded, not sent yet" or "Not sent yet" with
  the send button; send it then. Nothing sends it automatically, so write the order number on the
  incident sheet ("refund to send") and do it in recovery.
- **Online payment, cancelling items** (`Cancel item and refund`): the items are cancelled at once
  (the kitchen stops them) and the refund stays "refund pending". When the provider is back, a
  manager or the owner presses `Check refund` on the cancelled item; it sends the refund then (never
  twice). Write the order number on the incident sheet.
- **Online payment, cancelling a whole order or round**: the refund is retried automatically by the
  store system until the provider answers; check the order shows "refunded in full" after recovery.
- **Card-machine payment** (counter orders and staff-entered table rounds): refund on the store card
  machine when it works, then record it on the order (`Record card-machine refund` or the refund
  request's card-machine step) with the machine's reference. If the card machine is down too, write
  the order number, amount and reason on the incident sheet, tell the customer the refund will be
  made on their card as soon as the machine works, and do it then.
- **Never** refund an online payment in cash or on the card machine, and never refund the same thing
  twice by two routes. If the store network is down but a phone on mobile data can reach the store
  system, a manager may send pending refunds from that phone.

### One-page checklist (print)

```text
STORE OUTAGE CHECKLIST                       keep at the counter
[ ] 1  Tell the lead. Write start time on the incident sheet.
[ ] 2  Phone on mobile data: does the menu / Orders load?  yes = store network, no = host.
[ ] 3  Store network: tablets onto backup hotspot. Refresh Kitchen, reopen Orders.
[ ] 4  Not back in 5 min, or host down: lead pauses online ordering
       (Hours & ordering > Pause service > All services). Sign on door.
[ ] 5  Tell seated tables: order at the counter for now.
[ ] 6  Host down: call the pilot operator.     Tablet dead: sign in on backup device.
[ ] 7  Paper slips. Card machine only, before cooking. Write slip ref + time.
       NO card numbers. NO cash. NO second payment for "pending" online payments.
[ ] 8  Kitchen works from slips on the rail; tick "made".
--- when screens are back ---
[ ] 9  Orders: "Paid during an outage — decide": Accept (made/can make) or
       Refund instead, each within 15 min of screens returning.
       Then accept everything else paid and waiting.
[ ] 10 Check every "paid online / pending" line on the incident sheet.
[ ] 11 Pickup slips: Counter order. Dine-in slips: Tables > Take order for
       table (same table), before closing it. Tick "Recorded after an outage",
       paid-at time from slip, same items + tip; To charge = slip total.
       Then Mark ready (Kitchen) and hand over (Pickup) / served (on the order).
[ ] 12 Orders: "Expired · refunded" in the outage period -> lead follows up.
[ ] 13 Refund any duplicate on the card machine, then record it.
[ ] 11a Pay-at-the-end tables, one at a time: paper rounds -> Serve all ->
       manager: Comp or discount from the slips -> Start checkout -> tick
       "Paid while the system was down", time, card ref or cash -> Close table.
[ ] 14 Tables: close sessions of guests who left.
[ ] 15 Resume online ordering. Remove signs.
[ ] 16 Refunds "not sent yet" / item refunds "pending" on the incident sheet:
       send them (order > Payment, or Check refund on the item).
[ ] 17 Day end: Settlement "Store card machine" = card machine batch.
```

### Rehearsal before UAT (external gate: not done)

Run once with the Owner's real staff, devices, network and card machine, on the internal-test
installation (online payments simulated; TEST-ONLY). Real cards are charged only on the store card
machine: use one small real charge on the Owner's own card and refund it on the machine, which also
rehearses the refund record.

- **Roles**: incident lead (Store Manager), counter (Front of House), kitchen, pilot operator,
  observer (Owner or delegate, keeps time and fills the record sheet; does not help).
- **Script** (about 60 minutes, during a quiet hour or before opening):
  1. Normal service: two pickup orders and one dine-in round paid online, accepted, on the board.
  2. Store network down: unplug the store router. One observer phone on mobile data places and pays
     a pickup order. Staff detect, switch to hotspot, decide pause; take one paper pickup order and
     one paper dine-in round paid on the card machine (one real small charge, others with the
     machine's training mode if it has one, otherwise real and refunded).
  3. Kitchen tablet failure: power off the kitchen tablet; sign in on the backup device; board
     shows the same tickets.
  4. Host down: the operator stops the pilot (`docker compose -f compose.pilot.yaml stop pilot`) for
     15 minutes while a customer is on the payment page; staff run paper service; the operator
     restarts it.
  5. Recovery: steps 5.1–5.9 including entering both paper orders, the observer's online order,
     closing the table, resuming ordering.
  6. Day-end check: `Settlement` card machine section against the machine's report.
- **Pass criteria**: every paid order is either made and recorded once, or refunded with a record;
  no customer is charged twice; no card number or cash appears anywhere; online ordering is paused
  within 5 minutes of the decision and resumed after recovery; the backup kitchen device shows the
  board within 5 minutes; every paper slip has an order number after recovery; `Settlement` "Store
  card machine" matches the machine's batch; no stale table session remains; staff could follow the
  checklist without developer help.
- **Record sheet** (fill in, keep with WP-2423 evidence; no customer data, no card data):

```text
Date / time: ________  Installation and version: ________  Observer: ________
Participants (roles only): ________________________________
| Step | Started | Done | Result (pass/fail) | Problem seen | Follow-up (WP item) |
|  1   |         |      |                    |              |                     |
|  2   |         |      |                    |              |                     |
|  3   |         |      |                    |              |                     |
|  4   |         |      |                    |              |                     |
|  5   |         |      |                    |              |                     |
|  6   |         |      |                    |              |                     |
Card machine batch total ______  Settlement card machine net ______  Match [ ]
Overall: [ ] pass  [ ] fail      Owner sign-off: ________
```

### Product gaps found while writing this procedure

| #   | Gap                                                                                                                                                                                                                                                                                                              | Belongs to                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| G1  | Handled (DEC-OUTAGE-ACCEPTANCE-HOLD): orders whose deadline passes while the store is offline are held and decided within 15 minutes of staff returning (section 5 step 1). Remaining: no link from a paper slip to an online order; an accepted order already served from paper still reaches the kitchen board | Q1 remainder                |
| G2  | Handled 2026-10-14: a failed read keeps the last tickets as an explicit stale read-only board, actions off, retrying with backoff (IDR-0039); Pickup and Tables likewise                                                                                                                                         | Q9 follow-up (Q2 board)     |
| G3  | Handled 2026-10-15 (DEC-STAFF-DINE-IN-ROUND): paper dine-in rounds are entered on their table in `Tables` → `Take order for table …` (section 5 step 5) and report as dine-in                                                                                                                                    | Q7 slice 2                  |
| G4  | Back-entry charges the current server total; a paper charge that differs (price changed, mistake) cannot be recorded at its real amount, so the card machine section will not match the batch                                                                                                                    | Q7 (follow-up)              |
| G5  | Back-entered orders go onto the Kitchen board and Pickup and must be marked ready and handed over one by one                                                                                                                                                                                                     | Q7 (kitchen quick close)    |
| G6  | Card-machine payments have no partial refund; only whole-order cancellation with "refunded on card machine"                                                                                                                                                                                                      | Q5                          |
| G7  | Handled 2026-10-15 (DEC-PILOT-ALERTS-BACKUP): the ops monitor alerts on the Home and, once the Owner sets up email/phone accounts, outbound; a whole-host outage needs the external heartbeat service (external gate)                                                                                            | Q13                         |
| G8  | No way to notify pickup customers of a delay or an expired order; only contact details shown on the order                                                                                                                                                                                                        | Q10 (notification Provider) |
| G9  | Staff on a backup device sign in through the internal-test staff page; real named accounts wait for the Cognito gate                                                                                                                                                                                             | Step 9 (external)           |
| G10 | Real Provider behaviour for payments approved while the host was down (late webhook, capture discovery) is unproven; pilot uses simulated payments                                                                                                                                                               | P2/B5, Q22 (external)       |
| G11 | "Existing runtime configuration and recovery" still describes the v14 WSL host, not the v15 container commands                                                                                                                                                                                                   | P4 (runbook drift)          |
| G12 | Backup network, backup device, card machine connectivity and contacts are not yet provided                                                                                                                                                                                                                       | Owner inputs (external)     |

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

## Opening a TEST second Store on the internal test installation

**InternalTest only; a test-environment-only shortcut** (DEC-BRAND-MULTI-STORE-ONE-INSTALLATION,
coordinator 2026-10-30). Not before the coordinator says so. With two Stores the Brand Owner (a
person holding Brand Owner authority) still lists menu changes directly; anyone else's menu
changes wait for the Brand Owner (segment 9, coordinator 2026-10-31). A real Store is opened
through its governed opening (B2), never this way.

1. **Open the Store in the product.** The Brand's Owner, on the Stores page
   (`/app/organization/stores`, "Open a store"): name `DEMO Store 2 – not production`, a code
   (`DEMO_02`), its time zone and language. Note the new Store's reference (the Stores page
   result, or the `STORE_OPENED` audit record).
2. **Store roles.** As for any Store: `tooling/environment/store-role-provisioning.mjs`
   prepare → sign → apply for the new Store with `--templates
owner,store-manager,area-manager,front-of-house,kitchen,inventory-manager` (the opener is
   already a member there, so they may be named the Owner).
3. **Its first configuration and launch gate** (dry run first, then without `--dry-run`), in the
   container, with the paths the container sees (`/app/.local/...`):

   ```bash
   PILOT_UID=$(id -u) PILOT_GID=$(id -g) PILOT_RUNTIME_DIRECTORY=.local/pilot-v15 \
     docker compose -f compose.pilot.yaml run --rm --no-deps -T -e NODE_ENV=development pilot \
     node --import ./tooling/environment/register-workspace-typescript.mjs \
     tooling/environment/pilot-internal-test-store-open.mjs setup \
     /app/.local/pilot-v15 --database bop_rms_pilot_v15 \
     --migration-env .local/migrate-v14/migrate-v15.env \
     --store <new Store reference> --approver <another staff member's actor reference> \
     --reason "Multi-store live check" --approved-by "Owner" --approval "<the approval wording>" \
     --dry-run
   ```

   It copies the installation Store's published hours into the new Store (its own time zone),
   publishes them with a `SYNTHETIC-STORE-LIVE-GATE`, audits every step with the approval, and
   commits only if the services' api role reads the new Store's operating status. A refusal
   prints `PILOT_INTERNAL_TEST_STORE_OPEN_UNAVAILABLE (<reason>)` and changes nothing.

4. **Its stock site, then its runtime directory.** Signed in at the new Store, its Owner
   creates its stock site under Supply → Locations. Read its reference (read-only):
   `SELECT stock_site_id FROM rms_inventory.stock_site WHERE store_id='<new Store reference>' AND is_default`.
   Then the same command with `directory /app/.local/pilot-v15 --store <new Store reference>
--name demo-2 --stock-site <its stock site reference>` writes `stores/demo-2/` (owner-only)
   and lists it in `stores.json`. It holds only what the Store's services read: its own
   configuration (its own identities, the same on every run), the keys and passwords those
   services use (copied as they are) and an empty payment simulator — never the installation's
   pids, locks, health files, logs, evidence or migration credentials. A Store directory that
   cannot be loaded never stops the others: the services log `PILOT_HTTPS_STORE_UNAVAILABLE`,
   `PILOT_CUSTOMER_STORE_UNAVAILABLE` or `PILOT_API_STORE_UNAVAILABLE` with its code and
   `stores/<name>`, and serve the other Stores; the supervisor shows attention for that Store's
   workers only. To redo it: set `stores.json` aside, delete `stores/<name>/`, rerun this step.
5. **Restart** in a planned update window. Only the Owner (Store Owner or Brand Owner) adds
   someone from another Store to this one (Staff, "Your staff at other stores"): moving staff
   between Stores changes who can act there. A Store Manager or Area Manager who needs someone
   asks the Owner. Staff assigned to the new Store see it on the Stores
   page and switch to it; there they set its address, tax and payment in Store setup and add its
   tables (segment 3c). If the installation is down, each Store follows the outage procedure on
   its own (see "Several Stores on one installation" above).
6. **Its menu and prices.** After its tax is set, the Brand Owner switches to the new Store, opens
   Menu and chooses "Serve the menu here", then "List it": guests there see the Brand's dishes at
   the Brand prices, and every later Brand listing reaches both Stores. Each Store's manager changes
   that Store's own prices, sold out and hidden items under Item availability (a price change
   confirms the old and the new price and is recorded with who made it). Offline, nothing changes:
   the Store keeps charging the price shown, and the manager confirms again once back online.
7. **Its day-end settlement**, once its first business day has closed: the same command with
   `settlement /app/.local/pilot-v15/stores/demo-2 --database bop_rms_pilot_v15
--migration-env .local/migrate-v14/migrate-v15.env` records that day; its settlement worker
   starts at the next restart.
8. **Renewal:** after renewing the installation itself (next section), renew the TEST Store with
   the same `--until`: `renew /app/.local/pilot-v15/stores/demo-2 --database bop_rms_pilot_v15
--migration-env .local/migrate-v14/migrate-v15.env --until <the same instant> --reason "…"
--approved-by "Owner" --approval "<the approval wording>"` (dry run first with `--dry-run`).
   It moves the Store's synthetic launch gate (audited) and its files' common expiry; the
   Store's staff and roles have no end.

## Renewing the internal test installation

**InternalTest only, Owner-approved action.** The internal test installation is valid for a fixed
window (v15: until `2026-10-20T02:26:31.598Z`). After it, staff lose every permission (their DEMO
memberships end), the launch gate and the DEMO tax evidence lapse, so the Store cannot take
orders, and the DEMO tables and customer quote stop working. Renewal moves that window forward by
at most 30 days at a time and needs the Owner's explicit approval; record the Owner's own words
with `--approval`. Run it **before** the old expiry: the business worker's Pickup capacity
schedule stops once `binding.validUntil` has passed. Never use it for a Pilot or real Store: it
refuses any file that is not `InternalTest`, carries another database, lacks the DEMO/synthetic
labels, names a real-looking (non-fixture) Store or staff identity, or declares a
non-`SYNTHETIC_*` launch gate requirement, and any database row with the same expiry that is
not labelled synthetic.

What it renews, database first (one transaction, through each owning domain, each change in the
platform audit with the approval wording; it commits only when the product read paths accept the
renewed facts one hour after the old expiry, checked as the services' api role):

- Membership: the DEMO staff memberships and Store assignments (fixture identities only), version
  +1, only `effective_until`.
- Permission: the DEMO roles (`synthetic_…`, `internal_pilot_…`), their assignments and grants,
  version +1, only `effective_until`; the Brand permission policy version advances once. Real
  roles (no end) are untouched.
- Publishing: a new version of the `SYNTHETIC-…` launch gate (append-only), identical except the
  `SYNTHETIC_STORE_READY` requirement's `valid_until`.
- Pricing: a new Published version of the `DEMO_…` tax configuration (append-only), identical
  rules, rates and evidence references; only the registration and professional evidence
  `valid_until` move. Its identity and digest come from the internal pricing policy. If the
  database lacks the Brand tax reference projection for that configuration (v15 does), the
  renewal restores exactly the rows the tax triggers would have written.

The database changes run as a dedicated NOLOGIN NOBYPASSRLS role
`<database>_internal_test_renewal` that the command creates (or re-restricts) with only the
privileges listed in `tooling/environment/pilot-internal-test-renew-database.mjs`.

Then the files (validity only): `internal-test-profile.json` `binding.validUntil` and
`taxConfigurationVersion` (the renewed tax version), every `actors[].validUntil` in
`internal-test-merchant.json`, `validUntil` in each `internal-test-dining-table*.json`, and
`effectiveUntil` plus `exceptionTaskPolicy.effectiveUntil` in `internal-test-task-queue.json`.
Every value must equal the profile's current expiry (or already equal `--until` after an
interrupted run); nothing else in any file changes. Historical copies (`*.v1-backup.json`,
`*.before-*.json`) stay untouched.

It deliberately leaves alone: the Pickup capacity slots (the business worker's
`pickupCapacitySchedule` loop creates them after deploy; it needs the api INSERT grants on
`rms_fulfillment.capacity_slot` and `capacity_slot_configuration`) and the superseded
`InternalTestBatchCancellation` workflow (the released `UnpaidDineInBatchCancellation` workflow
has no end).

Because the running services still hold the old profile, their quotes refuse the renewed tax
version until they restart: run the renewal inside a planned update window.

1. Get the Owner's approval for the new end date and the reason, in writing (2026-10-18:
   "批准，续到 11 月 14 日（推荐）").
2. Preview, from the repository root on the host, in a one-off pilot container (the way the
   pilot runs: as the runtime owner's uid, with the runtime and migration environment paths the
   container sees under `/app/.local`; the host paths do not work because the environment
   file's password path is relative to the container's `/app`). The dry run performs the
   database part in a transaction and rolls it back, so it shows exactly what would change and
   the before/after checks; nothing is written:

   ```bash
   PILOT_UID=$(id -u) PILOT_GID=$(id -g) PILOT_RUNTIME_DIRECTORY=.local/pilot-v15 \
     PILOT_OFFSITE_DIR=$HOME/bop-rms-pilot-offsite \
     docker compose -f compose.pilot.yaml run --rm --no-deps -T -e NODE_ENV=development pilot \
     node --import ./tooling/environment/register-workspace-typescript.mjs \
     tooling/environment/pilot-internal-test-renew.mjs \
     /app/.local/pilot-v15 --database bop_rms_pilot_v15 \
     --migration-env .local/migrate-v14/migrate-v15.env \
     --until 2026-11-14T02:26:31.598Z \
     --reason "Continue internal testing until 14 November" --approved-by "Owner" \
     --approval "批准，续到 11 月 14 日（推荐）" --dry-run
   ```

   The image must contain the renewal tooling of the deployed revision (an image built before
   the `uid:<n>` operator fallback stops with `unexpected-error ERR_SYSTEM_ERROR`). The
   container has no account name for the host uid, so the record names the operator `uid:<n>`.

   `--migration-env` is the migration environment file of the database (it must name
   `--database`). It lists each database change (row, old → new end, version), the checks one
   hour after the old expiry (before: no staff authority, launch gate and tax refused; after:
   the same staff authority as now, both accepted), then each file, field, old → new value and
   the before/after SHA-256. A refusal prints a fixed code, e.g.
   `PILOT_INTERNAL_TEST_RENEWAL_UNAVAILABLE (internal-test-permission-not-synthetic)`, and
   changes nothing.

3. Start the planned update window: `maintenance start` with `--reason "internal test renewal"`
   (see Planned updates).
4. Run the same command without `--dry-run`. The database part commits first; then it keeps the
   previous files (hard links) and a `renewal.json` record (operator account, approver, approval
   wording, reason, from → to, hashes, the database changes and checks) in a new owner-only
   `internal-test-renewal-<time>/` directory, replaces each file atomically (the profile last)
   and appends one line to `internal-test-renewal-log.jsonl`. If it stops part way, run the same
   command again; the database part reports `AlreadyRenewed` and the remaining files are
   finished.
5. `docker compose -f compose.pilot.yaml restart pilot`, wait until the pages load, then
   `maintenance end`. The services read the profile at start.
6. Reload open screens. The internal DEMO Pickup and table entries sign their codes from the
   profile at start, so they follow the new window after the restart; table codes issued from
   Table QR codes keep their own expiry and need no reprint.

To undo the files, copy them back from the `internal-test-renewal-<time>/` directory and
restart; the database changes are history (versions and audit) and are only moved forward by a
later renewal. The record and log line stay as history.

For a real Store none of this applies: staff validity changes through staff administration
(member and role screens), the launch gate through the Publishing review flow, and tax evidence
by publishing a new tax version through the tax publication flow with real registration and
professional review evidence.

## Daily backup and weekly restore drill (WP-2423)

`tooling/environment/pilot-backup.sh` needs only docker on the host and runs while all services
keep serving.

- `backup` takes one consistent online `pg_dump` (custom format) into a private directory (`0700`,
  files `0600`), writes `<file>.manifest.json` with its SHA-256 and the row count of every table
  counted from the dump itself, and keeps the newest `--keep` backups (default 14). With
  `--media <runtime>/media/product-images` it also writes `<file>.media.tar` with every product
  photo file published menus show, and records its SHA-256, file count and how many photos the
  dump references that the folder lacks (`mediaMissing`). A store without photos yet (no folder)
  gets an empty photo archive. Missing referenced photos do not stop the database backup; the
  drill fails with `media missing` instead.
- `drill` verifies the newest (or `--backup`) dump against its manifest, restores it into a new
  database `<db>_drill_<UTC time>` in the same server, requires every table's row count to equal the
  manifest, writes `drill-<UTC time>.json` and drops the drill database (`--keep-drill` keeps it).
  A tampered or incomplete dump stops before any database is created. When the manifest names a
  photo archive, the drill also checks its SHA-256, extracts it into a scratch folder, requires each
  file's SHA-256 to equal its name, the count to match and every photo the dump references to be
  present (`media checksum mismatch`, `media differs`, `media missing`).

```bash
tooling/environment/pilot-backup.sh backup --container <postgres container> --port <port> --database <db> --user <migration role> --password-file <private password file> --dir <private backup dir>
```

```bash
tooling/environment/pilot-backup.sh drill --container <postgres container> --port <port> --database <db> --user <migration role> --password-file <private password file> --dir <private backup dir>
```

Since WP-2423 Q13 the `ops` service schedules `backup` and a restore check (`drill`) daily and
alerts on failure; see "Alerts and scheduled backups (WP-2423 Q13)" below. The commands above remain
for a manual run. The local copy has the same
trust boundary as the database volume; copying backups off the host (required for P4) must use
storage that encrypts at rest with a managed key, and the off-host target is an external P4 input.
The command prints only the file name and table/row/byte counts, never credentials or row contents.

First local run (v15, 2026-10-09): backup 532 tables / 525,651 rows / 37.8 MB in 8 s with services
serving; drill restored it in 49 s and every table matched; a byte-flipped copy was refused with
`checksum mismatch` before any database was created.

## Hosting: customer domain, certificate and managed secrets (WP-2423)

Decision: [pilot hosting integrations](../spec/design/pilot-hosting-integrations.md)
(DEC-PILOT-SECRETS, DEC-PILOT-OFFSITE-S3, DEC-PILOT-MAINTENANCE-PAGE). Everything the hosting
provides is named in `<runtime>/hosting.json` (0600, pilot operator, no secret values). Without the
file the installation is the local internal test entry, exactly as v15 runs today; InternalTest may
not name a public domain or a secrets folder (its DEMO staff login and simulated payments never go
on the internet).

```json
{
  "schemaVersion": 1,
  "environment": "Pilot",
  "customerOrigin": "https://order.<store domain>",
  "secretsDirectory": "/run/secrets/bop-rms",
  "tls": {
    "mode": "front",
    "certificateFile": "/run/tls/fullchain.pem",
    "keyFile": "/run/tls/privkey.pem"
  }
}
```

- `customerOrigin`: the address printed on table QR codes and the only Origin/Host the pages and
  API accept. **Changing it means Replace and print for every table code.**
- `secretsDirectory`: the managed secret files; the list, rotation and QR key switch are in
  [key and secret rotation](key-secret-rotation.md#pilot-secret-files-wp-2423-dec-pilot-secrets).
- `tls.mode`: `front` when the hosting gives certificate files (the `front` service presents them
  and reloads renewed files within a minute); `proxy` when a TLS-terminating load balancer or reverse
  proxy in front of port 4443 holds the certificate (it may present the local certificate to that
  proxy).

Mount the hosting's folders read-only with a compose override next to `compose.pilot.yaml`
(`docker compose -f compose.pilot.yaml -f compose.pilot.hosting.yaml …`), for example:

```yaml
services:
  pilot:
    environment: { NODE_ENV: production, BOP_PILOT_ENVIRONMENT: Pilot }
    volumes: ["/etc/bop-rms/secrets:/run/secrets/bop-rms:ro"]
  ops:
    environment: { NODE_ENV: production, BOP_PILOT_ENVIRONMENT: Pilot }
  front:
    environment: { NODE_ENV: production, BOP_PILOT_ENVIRONMENT: Pilot }
    volumes: ["/etc/bop-rms/tls:/run/tls:ro"]
  postgres:
    ports: ["0.0.0.0:443:14443"]
```

Before starting: `node tooling/environment/pilot-secrets.mjs check <runtime>` must print
`PILOT_SECRETS_COMPLETE`. A Pilot start checks the secrets and the certificate first: the supervisor
prints one `PILOT_NOT_READY Secrets: …` / `PILOT_NOT_READY Tls: <reason>` line per problem (file
names and fixed reasons only) and refuses. `Tls` is met only with a public name and a certificate
that phones trust for it (`certificate-not-trusted`, `certificate-wrong-host`, `certificate-expired`,
`certificate-key-mismatch`, `certificate-unreadable`, `proxy-unreachable`, `customer-origin-not-public`
name what to fix). Payment provider, staff login (Cognito) and reviewed currency/tax configuration
remain separate gaps.

The monitor's probes follow `customerOrigin` (Host and, with `front`, the public trust store for
that name) and its certificate-expiry alert reads the hosted certificate. The internal test
certificate expires **2026-11-14T05:15:40Z**; renew it (with the internal test installation, Owner
approval) before then while the store still runs InternalTest.

## Switching a Store to Pilot (DEC-PILOT-RUNTIME-ENVIRONMENT)

Decisions: [Pilot runtime environment](../spec/design/pilot-runtime-environment.md) and
[Pilot installation](../spec/design/pilot-installation.md) (DEC-PILOT-INSTALLATION). A Pilot Store is
a **new installation**: its own database and runtime directory with the real Store's facts. Never
relabel, copy or edit an InternalTest runtime directory (v15) into a Pilot one: every file there is
TEST data, and the installer refuses a directory holding any InternalTest-only file. v15 keeps running
InternalTest unchanged.

**Still blocked:** the start check refuses with `PILOT_CAPABILITY_MISSING:PricingCurrencyMetadata`
until the Store's reviewed currency and tax configuration exists (P5, external). Everything below can
be done before that; the Store cannot take orders until it is resolved.

Every repository command runs from the repository root of the deployed revision, with the pinned Node
and `node --import ./tooling/environment/register-workspace-typescript.mjs` (written `node --import …`
below), as the pilot operator account. Installation commands run as a Pilot process:
`NODE_ENV=production BOP_PILOT_ENVIRONMENT=Pilot`. `<runtime>` is the absolute runtime directory
(`0700`, owned by the pilot operator); `<migration env>` is the database's migration authority file
(inside the repository, password file under `.local`, the role may create roles); `<target>` is
`<environment>:<database>` from that file. Two Platform people are involved: the **operator** runs
the tools, an independent **approver** signs; neither is the Store's Owner. Record each step's printed
result (references, digests, statuses; never secrets) in WP-2423.

### 1. Accounts (Owner, external)

Before anything is installed the Owner has: the Stripe account in live mode (PILOT-PAY-01/02), the AWS
account for Cognito, SES/SNS and the S3 off-site target, the hosting (host, public customer domain,
certificate), and the real Store facts (legal name, address, tax registration). Each has its own
runbook: [Stripe](./pilot-stripe-switch.md), [Cognito](./cognito-store-staff.md),
[notifications](./notification-deliverability.md), [hosting](#hosting-customer-domain-certificate-and-managed-secrets-wp-2423).

### 2. Managed secrets

`node tooling/environment/pilot-secrets.mjs generate <new private folder>` creates every managed value
(including `order-recovery-pepper-v1` and `order-recovery-abuse-key` for one-time order links) and a
table QR key; upload each file to the hosting's secret store
([key and secret rotation](key-secret-rotation.md#pilot-secret-files-wp-2423-dec-pilot-secrets)) and add
the Cognito client secret as `cognito-client-secret`. Delete the local folder.

### 3. Hosting

Create `<runtime>` (`mkdir -m 0700`), write `hosting.json` and the compose override as in
[Hosting](#hosting-customer-domain-certificate-and-managed-secrets-wp-2423), then
`node tooling/environment/pilot-secrets.mjs check <runtime>` must print `PILOT_SECRETS_COMPLETE`. Issue
the local entry certificate the `front` service re-encrypts to (after step 5, it reads the profile):
`node --import … tooling/environment/pilot-provision-tls.mjs issue <runtime> <database>`; it is valid for
30 days, renew it with `renew` in a planned update window.

### 4. Database

1. Start the Pilot database (its own volume and port; never the InternalTest one).
2. Migrations: `pnpm db:migrate -- apply --env-file <migration env> --confirm-target <target>`.
3. Permission catalog: `node --import … tooling/environment/permission-catalog-install.mjs --env-file <migration env> --confirm-target <target> --operator <operator> --approved-by <approver> --approval-evidence <uuid>`.
4. Brand and Store records: the governed Brand/Store opening (B2, external identity and approval).
5. Store roles: `store-role-provisioning.mjs` `keygen` (approver, once; publish the key with purpose
   `STORE_ROLE_PROVISIONING`), `prepare --templates owner,store-manager,area-manager,front-of-house,kitchen,inventory-manager …`,
   `sign`, `apply` (no Owner yet; the first Owner comes in step 7).
6. In the product, the Owner (with the Platform operator for the first sign-in, step 7) publishes
   Store setup with its approved go-live check, the menu, and the stock site **at least one full
   business day before step 5 of this procedure**: the first day-end settlement window is the last
   closed business day, so the installer refuses (`no-closed-business-day`) until one exists.

### 5. Installation files (`pilot-installation-issue`)

1. Approver, once: `node --import … tooling/environment/pilot-installation-issue.mjs keygen --private-key <approver key>`;
   publish the printed key in the trust file with purpose `PILOT_INSTALLATION` (same trust format as
   Store roles: `StoreRoleProvisioningTrustV1`).
2. Owner approves the validity window in writing (at most 92 days; the installation stops serving at
   its end). Operator prepares:

   ```bash
   NODE_ENV=production BOP_PILOT_ENVIRONMENT=Pilot node --import ./tooling/environment/register-workspace-typescript.mjs \
     tooling/environment/pilot-installation-issue.mjs prepare --env-file <migration env> --directory <runtime> \
     --environment <environment uuid> --operator <operator> --tenant <tenant> --brand <brand> --store <store> \
     --valid-until <ISO instant> --api-role <api role> --worker-role <worker role> --database-port <port> \
     --owner-approved-by "<Owner name>" --owner-approval "<Owner's words>" --reason "<why>" --out <plan.json>
   ```

   It reads the facts in a transaction it rolls back and prints the plan digest, the window and each
   file's SHA-256. A refusal prints `PILOT_INSTALLATION_ISSUE_UNAVAILABLE (<reason>)`, e.g.
   `store-roles-not-provisioned`, `store-configuration-not-published`, `launch-gate-synthetic`,
   `menu-ambiguous` (add `--menu <uuid>`), `stock-site-ambiguous` (add `--stock-site <uuid>`).

3. Approver reviews the plan file and signs: `sign --plan <plan.json> --private-key <approver key> --approved-by <approver> --approval-evidence <uuid> --key <key uuid> --valid-hours <1..72> --out <approval.json>`.
4. Operator dry run: `apply --env-file <migration env> --plan <plan.json> --approval <approval.json> --trust <trust.json>`
   prints `DryRun`, the roles it would create and the files; nothing is written.
5. Operator apply: the same command with `--confirm-target <target>`. It creates the services' database
   roles (`LOGIN NOSUPERUSER NOBYPASSRLS`; their passwords only in `<runtime>/api-password` and
   `worker-password`), applies the rendered pilot ACL, records the Platform audit, then writes every
   file (`0600`, the profile last), a `pilot-installation-install-<time>/record.json` and one line in
   `pilot-installation-log.jsonl`. Rerun the same command after an interruption; it reports
   `AlreadyApplied` once complete.

### 6. Workflows (`workflow-release-install`)

For each release, with a fresh operation reference from
`node --import … tooling/environment/workflow-release-install.mjs new-operation` (keep it to replay):

| `--workflow`                      | `--output`                                                |
| --------------------------------- | --------------------------------------------------------- |
| `OrderFulfillmentPickup`          | `<runtime>/internal-test-workflow-Pickup.json`            |
| `OrderFulfillmentDineIn`          | `<runtime>/internal-test-workflow-DineIn.json`            |
| `OrderFulfillmentAdditionalRound` | `<runtime>/internal-test-workflow-AdditionalRelease.json` |
| `UnpaidDineInBatchCancellation`   | `<runtime>/cancellation-workflow-draft-result.json`       |

```bash
node --import ./tooling/environment/register-workspace-typescript.mjs tooling/environment/workflow-release-install.mjs \
  --env-file <migration env> --confirm-target <target> --workflow <release> --runtime-environment Pilot \
  --tenant <tenant> --brand <brand> --store <store> --operator <operator> --approved-by <approver> \
  --approval-evidence <uuid> --operation <operation> --output <file>
```

A directory whose profile names another environment, database or Store is refused
(`WORKFLOW_RELEASE_PROFILE_MISMATCH`) before anything is released.

### 7. Staff

`staff-sign-in.json` in Cognito mode (Pilot form: no `staffPin`, no `clientSecretFile`), then the first
Owner: [Cognito store staff](./cognito-store-staff.md) section 6 (`store-staff-sign-in.mjs invite-first-owner`,
the Owner's first sign-in, Platform approval of the Owner role with `store-role-provisioning`
`prepare-assignment`/`sign-assignment`/`apply-assignment`). The Owner invites the other staff in the app.

### 8. Stripe

`payment.json` in live mode with the live key files: [Stripe switch](./pilot-stripe-switch.md) B steps 1–3
(`pilot-stripe-operations.mjs check` reads live keys and a live-mode webhook endpoint).

### 9. Notifications and alerts

`notification.json` ([notifications](./notification-deliverability.md) section 4) and `ops.json` alert
channels ([Alerts](#alerts-and-scheduled-backups-wp-2423-q13)); send a test alert.

### 10. Start and first live checks

1. Start with the compose override of the Hosting section (`NODE_ENV=production`,
   `BOP_PILOT_ENVIRONMENT=Pilot` for `pilot`, `ops` and `front`). The supervisor prints one
   `PILOT_NOT_READY …` line per problem (hosting, `Installation: missing <file>` /
   `invalid <file>` / `internal-test-file-present <file>` / `validity-window-not-in-force`) and refuses
   with `PILOT_CAPABILITY_MISSING:<codes>` while anything is missing; fix what it names and start again.
   Until the tax review exists the only code left is `PricingCurrencyMetadata`.
2. In the Store: print the pickup poster as a QR code of the customer address itself
   (`https://order.<store domain>/` opens pickup ordering; it never needs reprinting when keys rotate),
   create and print every table code on **Table QR codes** ([Table QR codes](#table-qr-codes-wp-2423-q11)),
   and staff sign in at `/operations/sign-in`. Nothing simulated (test payment buttons, DEMO staff list,
   table launcher) exists in a Pilot Store.
3. First live checks (one WP-2423 line each): Stripe B.4 (one real paid pickup order, full refund,
   day-end matches Stripe), Cognito section 8, notification section 5, the Home "Store system" card shows
   "Everything is working" and the next scheduled backup and restore check succeed.

### 11. Launch approval

The Owner approves go-live in writing after the staff UAT business day and the outage rehearsal
(see [Store outage procedure](#store-outage-procedure-wp-2423-q9)); record the words in WP-2423.

**Rollback:** stop the Pilot services; the InternalTest installation is separate and unaffected.
Payments already taken stay in Stripe live and in the Pilot database.

### Renewing a Pilot installation (DEC-PILOT-INSTALLATION)

The installation serves until `binding.validUntil`. From 14 days before it, the Home "Store system"
card and the alert channels show "The store's ordering setup expires soon" (Urgent in the last 3
days). Renew in a planned update window:

1. Owner approves the new end date in writing (at most 92 days from now, later than the current end).
2. Operator: `pilot-installation-issue.mjs prepare-renewal --env-file <migration env> --directory <runtime> --environment <uuid> --operator <operator> --valid-until <ISO> --owner-approved-by "<Owner>" --owner-approval "<Owner's words>" --reason "<why>" --out <renew-plan.json>`.
   It re-reads the Store's published facts; `launch-gate-changed` means the Owner's go-live check
   changed and the installation must be re-issued instead.
3. Approver: `sign` the renewal plan (as in step 5.3).
4. Operator: `apply … --confirm-target <target>` inside `maintenance start`/`maintenance end`, then
   restart the services (they read the profile at start). Only the profile window and the task queue
   windows change; the previous files stay in `pilot-installation-renew-<time>/` with `record.json`
   (Owner's words, approver, from → to) and one log line.

An installation that already expired is renewed the same way (guests could not order meanwhile). The
InternalTest renewal tool refuses a Pilot directory.

## Alerts and scheduled backups (WP-2423 Q13)

Decision: [DEC-PILOT-ALERTS-BACKUP](../spec/design/pilot-alerts-backup.md). The compose service
`ops` (same image as `pilot`, its own container) runs `tooling/environment/pilot-ops.mjs` every
minute. It works while the supervisor, API or database is down, which is when it matters.

What it checks: the API `/ready`, the customer page and the staff app through the same published
ports staff and guests use; the supervisor's report (`supervisor.health.json`, written every 5 s);
stuck order or payment updates (dead-lettered events); open payment reconciliation differences;
day-end settlement days with differences or still missing 6 hours after close; the scheduled
backup, its restore check and its off-site copy; no successful backup in 26 hours; the HTTPS
certificate expiring within 7 days; free space of the pilot data folder, the backup folder, the
database volume and the off-site folder; and whether its own outbound alerts are being delivered.

Where alerts appear:

- **Home, "Store system" card** (Owner and Store Manager; the same permission as Exceptions):
  every open problem with "Urgent" or "Today", what to do and since when, recently resolved
  problems, the last backup time and whether email or phone alerts are set up. If the monitor
  stops, the card says "The alert monitor stopped reporting" instead of "Everything is working".
- **Log**: `<runtime>/ops/alerts.log` (JSON lines: alert key, severity, delivery result).
- **Email and phone/message alerts**: only after the Owner provides accounts (external gate).

Noise control: a failed entry probe must last 2 minutes before it alerts; each problem is sent once,
again only if it gets worse or after a reminder interval (urgent 3 hours, today 24 hours), and
"Resolved" is sent after 2 quiet minutes. Each channel sends at most 6 messages an hour; anything
waiting is merged into the next message. Payment signals (stuck updates, open payment differences)
are read every minute; the day-end settlement scan every minute while it shows a problem and every
5 minutes while every day is settled. A payment or settlement problem staff resolve therefore leaves
the Home within about 3 minutes (the next read plus the 2 quiet minutes); a new day-end settlement
problem appears within about 5 minutes. Alert state is kept in `<runtime>/ops/alert-state.json`,
so a restart does not resend. Messages contain only fixed text, counts and times: never names,
phone numbers, emails, order details, tokens or passwords.

### Configuration (`<runtime>/ops.json`, 0600, pilot operator)

Without the file the monitor runs with the Home card and log only, and reports "No recent backup"
until backups are configured. Secrets go in separate 0600 files in the runtime directory; the
values below are placeholders.

```json
{
  "schemaVersion": 1,
  "siteLabel": "<short store name for message subjects>",
  "runbookUrl": "https://<where the Owner can open this runbook>",
  "homeUrl": "https://<store host>/app",
  "email": {
    "host": "<smtp host>",
    "port": 587,
    "security": "starttls",
    "username": "<smtp user>",
    "passwordFile": "ops-smtp-password",
    "from": "<sender address>",
    "to": ["<owner address>"]
  },
  "webhooks": [
    { "format": "pushover", "tokenFile": "ops-pushover-token", "userKeyFile": "ops-pushover-user" }
  ],
  "heartbeat": { "urlFile": "ops-heartbeat-url", "everyMinutes": 5 },
  "backup": {
    "role": "<migration admin role>",
    "passwordFile": "migration-admin-password",
    "timeZone": "<the Store's IANA time zone, e.g. America/Toronto>",
    "localTime": "04:30",
    "keep": 14,
    "restoreCheck": true,
    "offsite": {
      "kind": "directory",
      "path": "/offsite",
      "keyFile": "offsite-backup-key",
      "keep": 30
    }
  }
}
```

- `email.security` is `starttls` (port 587) or `tls` (port 465); plaintext SMTP is refused.
- `webhooks[].format`: `json` (`urlFile`; body `{severity, subject, text}`), `slack` (`urlFile`,
  an incoming-webhook URL), `pushover` (`tokenFile`, `userKeyFile`) or `twilio-sms`
  (`accountSid`, `authTokenFile`, `from`, `to`: E.164 numbers). URLs are secrets and live in files.
- `heartbeat` is a dead man's switch: an HTTPS URL of an external uptime service (for example a
  healthchecks-style "ping" URL) pinged every few minutes. If the whole host or its internet is
  down, nothing on the host can send an alert; the external service notices the missing pings and
  alerts the Owner. Set the service's grace period to 10 minutes.
- **External gate (Owner)**: the SMTP account, Pushover/Twilio/Slack account, uptime service account
  and the hosted runbook URL. None exist yet; nothing is sent outbound until they are configured.
  Do not commit any of these values or files.

Operator commands (inside the `ops` container, from `/app`):

```bash
docker compose -f compose.pilot.yaml exec ops node tooling/environment/pilot-ops.mjs test-alert "$PILOT_RUNTIME_DIRECTORY"
docker compose -f compose.pilot.yaml exec ops node tooling/environment/pilot-ops.mjs status "$PILOT_RUNTIME_DIRECTORY"
docker compose -f compose.pilot.yaml exec ops node tooling/environment/pilot-ops.mjs backup-now "$PILOT_RUNTIME_DIRECTORY"
```

`test-alert` sends one "test alert" message to every configured channel and prints `Delivered` or
`Failed` with a fixed code per channel. Run it after any channel change and monthly.

### Planned updates (deploys and planned restarts, 2026-10-18)

Recreating the `pilot` container stops the customer page, staff screens and supervisor for a few
minutes. Without a planned-update window that raises "Customer ordering page is not loading"
(urgent) on the Home and on every outbound channel. Every deploy or planned restart therefore
opens a window first and closes it once the pages load:

1. **Build first, while the old version keeps serving** (a build can take over 10 minutes and the
   window is at most 15): `docker compose -f compose.pilot.yaml build pilot`.
   The build shares CPU and memory with the running store, so never build on a busy store host. On
   a store's own host, build outside opening hours, or build on another machine and copy the image
   over (`docker save bop-rms-pilot:local | ssh <store host> docker load`). On 2026-10-29 two
   builds on the internal-test machine starved the running pilot (load 53–63 on 10 cores):
   services missed their health checks and restarted, guests got "Ordering is paused" outside any
   window (once for about 8 minutes), and the monitor on the same host stalled too, so it never
   raised "Customer ordering page is not loading". The image now builds two packages at a time
   (build argument `PILOT_BUILD_CONCURRENCY`, default 2); still check that nothing else heavy is
   running first (`uptime`, `docker stats --no-stream`). After every build, look for pauses
   outside the window: `docker compose -f compose.pilot.yaml logs -t front | grep DOWN`.
2. **Start the window** (uses the freshly built image, so it also works the first time):
   `docker compose -f compose.pilot.yaml run --rm --no-deps ops node tooling/environment/pilot-ops.mjs maintenance start "$PILOT_RUNTIME_DIRECTORY" --reason "deploy <revision>"`.
   Optional `--minutes 1-15` (default 15) and `--by <name>`. Starting again replaces the window.
3. Apply migrations or grants if the change needs them, then recreate:
   `docker compose -f compose.pilot.yaml up -d pilot ops`.
4. **Wait until the API and customer page answer**, then **end the window**:
   `docker compose -f compose.pilot.yaml exec ops node tooling/environment/pilot-ops.mjs maintenance end "$PILOT_RUNTIME_DIRECTORY"`.
   `status` shows the window as `plannedUpdate` (with `inForce`).

During the window the Home "Store system" card shows "System update in progress — ordering may
pause for a few minutes", with when it started and when it ends, and nothing is sent outbound for
the store pages, the supervisor or supervised services. Payment, settlement, backup, certificate and
disk alerts are never held, and a problem raised before the window stays on the Home. The window
ends by itself after at most 15 minutes, so a forgotten `end` cannot hide an outage; a failure that
is still there when the window ends (or is ended) is raised **at once**, because its 2 minutes have
already passed. Do not end the window before the pages load: that raises the urgent alert. Guests
who open the menu during the window meet the existing "couldn't load / try again" messages; staff
taking orders at that moment use the store outage procedure until the pages load. An unplanned
restart (outage recovery) does not open a window: those alerts are real.

**Update page (DEC-PILOT-MAINTENANCE-PAGE, [decision](../spec/design/pilot-hosting-integrations.md)).**
The compose service `front` owns the published HTTPS port and stays up while `pilot` is recreated
(`up -d pilot ops` does not touch it). Whenever the entry cannot be reached, guests and staff get a
plain page instead of a connection reset: "Ordering is paused for a moment" (or, inside a planned
window, "We're updating"), "This page will try again by itself", and "At a table? A staff member can
take your order in the meantime." (staff pages: keep taking orders at the counter or on paper). It
reloads itself every 20 seconds; French browsers get the French text. Pages already open meet their
existing "try again" messages, which now succeed as soon as the entry is back. The monitor still
reports the entry as down (the page answers 503), so real outages alert as before.

First deployment of `front` (once; replaces the `proxy` relay of port 14443, a few seconds without
the HTTPS port):

1. `docker compose -f compose.pilot.yaml build pilot` (the image carries `pilot-front.mjs`).
2. Open a planned window as in step 2 above.
3. `docker compose -f compose.pilot.yaml up -d proxy front`, then `up -d pilot ops` as usual.
4. Check: `docker compose -f compose.pilot.yaml logs front` shows `PILOT_FRONT_LISTENING 0.0.0.0:14443 → 127.0.0.1:4443 (relay)`;
   the customer page and `/app` load at `https://127.0.0.1:4443` with the same certificate as before;
   end the window.

To roll back, restore the previous `compose.pilot.yaml` (proxy relaying 14443) and run
`up -d --remove-orphans proxy`.

### Scheduled backups

Daily at `backup.localTime` in the Store's time zone (after the business day closes; 04:30 by
default), the monitor runs `pilot-backup.sh backup` with the image's PostgreSQL 18.4 client
(`--client local`) including the runtime's product photos (`<runtime>/media/product-images`), then
`drill` (restore into a scratch database `<db>_drill_<time>`, every table's row count compared, the
photo archive restored and checked, scratch database dropped), then the encrypted off-site copy of
the dump, its manifest and its photo archive, keeping `keep`
local backups and `offsite.keep` off-site copies. A failed dump is retried after 30 minutes, up to 3
tries a Store day. If the host was off at that time, the backup runs at the next start (online, while
serving). Backups live in `<runtime>-backups` (a sibling of the runtime directory).

A failed restore check records a reason in `ops/backup-status.json` (`restoreCheck.reason`) and
`ops/alerts.log`: `restore exit=<pg_restore status> class=<error class> sqlstate=<code>
item=<archive item kind> table=<schema.table>`, or `rows differ table=<schema.table>`. It never
contains data values. pg_restore's full messages are kept beside the backups in
`drill-<time>.restore-errors.txt` (0600, same protection as the dumps) for the operator.

Off-site copies are AES-256-GCM encrypted on this host before they are written, so the target may
be any folder that leaves the host: an external drive, or a folder a cloud sync client uploads.
Mount it with `PILOT_OFFSITE_DIR=<host folder>` (create it first, owned by the pilot user). Compose
refuses to start without it (and without `PILOT_RUNTIME_DIRECTORY`): a silent local default once sent
off-site copies to `.local/pilot-offsite` on the same disk after redeploys (2026-10-17).

**S3 bucket (DEC-PILOT-OFFSITE-S3, [decision](../spec/design/pilot-hosting-integrations.md))**: replace
`offsite` with

```json
"offsite": {
  "kind": "s3",
  "bucket": "<bucket>",
  "region": "<region, e.g. ca-central-1>",
  "prefix": "<store>/",
  "keyFile": "offsite-backup-key",
  "keep": 30,
  "sseKmsKeyId": "<optional KMS key ARN or alias/...>"
}
```

Copies are still AES-256-GCM encrypted on this host; each upload carries its SHA-256 and is then
read back from the bucket and compared before the copy counts as "Copied" (otherwise the off-site
alert). Only names under `prefix` are listed and pruned. Credentials: the host's AWS role by
default (on EC2 set the instance metadata hop limit to 2 so containers can reach it), or name two
0600 runtime files `accessKeyIdFile`/`secretAccessKeyFile` for an access key limited to
`s3:PutObject`, `s3:GetObject`, `s3:ListBucket` and `s3:DeleteObject` on that prefix (plus
`kms:GenerateDataKey`/`kms:Decrypt` on the key when `sseKmsKeyId` is set). An S3-compatible store
adds `"endpoint": "https://…"` (and `"forcePathStyle": true` if it needs it). Recommended bucket
settings: block public access, versioning with a noncurrent-version expiry (e.g. 30 days) so a
pruned or overwritten copy can still be recovered for a while. `PILOT_OFFSITE_DIR` is still required
by compose; point it at an empty folder when the target is a bucket. External gate: the bucket,
role or access key and (optional) KMS key.

Key custody: create the key once with `pilot-ops.mjs generate-offsite-key <runtime>`. **Copy the
key file's content into the Owner's password manager now.** Without it the off-site copies cannot be
read when the host is lost. Restore from an off-site copy:

```bash
node tooling/environment/pilot-ops.mjs decrypt-backup <runtime> <copy>.dump.enc <dir>/<name>.dump
node tooling/environment/pilot-ops.mjs decrypt-backup <runtime> <copy>.dump.manifest.json.enc <dir>/<name>.dump.manifest.json
node tooling/environment/pilot-ops.mjs decrypt-backup <runtime> <copy>.dump.media.tar.enc <dir>/<name>.dump.media.tar
tooling/environment/pilot-backup.sh drill --container <postgres container> --port <port> --database <db> --user <migration role> --password-file <file> --dir <dir> --keep-drill
```

From a bucket (or the configured folder), fetch and decrypt in one step instead:

```bash
node tooling/environment/pilot-ops.mjs list-offsite <runtime>
node tooling/environment/pilot-ops.mjs restore-offsite <runtime> <name>.dump.enc <dir>/<name>.dump
```

(likewise for `.dump.manifest.json.enc` and `.dump.media.tar.enc`, then `drill` as above). On a
replacement host this needs the same `ops.json` offsite block, the off-site key from the Owner's
password manager in the runtime directory, and access to the bucket.

A tampered or wrong-key copy is refused and nothing is written. `--keep-drill` keeps the restored
database for inspection or cut-over (a cut-over is a maintenance step with the Owner's approval).
A cut-over also restores the product photos the drill checked:
`tar -xf <dir>/<name>.dump.media.tar -C <runtime>/media/product-images` (create the folder first).

### What each alert means and what to do

"Urgent" means act now (store service or data at risk); "Today" means fix before the next day.
Staff on the floor follow the [Store outage procedure](#store-outage-procedure-wp-2423-q9) for
anything that stops ordering; the pilot operator fixes the cause.

| Alert (Home title)                                                                   | Means                                                                                                                                                                                                                                                       | Staff / Owner                                                                                                                                                                                                                                                                                                                | Pilot operator                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| <a id="alert-store-system-down"></a>Store system is not responding                   | API `/ready` failing for 2+ minutes                                                                                                                                                                                                                         | Outage procedure: pause online ordering if possible, paper orders, card machine only                                                                                                                                                                                                                                         | `docker compose ps`; `docker compose logs pilot`; restart `pilot`; check the database container                                                                                                                                                                                                                                                              |
| <a id="alert-customer-entry-down"></a>Customer ordering page is not loading          | The customer HTTPS page fails for 2+ minutes                                                                                                                                                                                                                | If staff screens work: pause online ordering in `Hours & ordering`; tell seated guests to order at the counter                                                                                                                                                                                                               | Customer service log; certificate; restart `pilot`                                                                                                                                                                                                                                                                                                           |
| <a id="alert-merchant-entry-down"></a>Staff screens are not loading                  | The staff app `/app` fails for 2+ minutes                                                                                                                                                                                                                   | Outage procedure                                                                                                                                                                                                                                                                                                             | As above                                                                                                                                                                                                                                                                                                                                                     |
| <a id="alert-supervisor-silent"></a>Background services are not being watched        | No supervisor report for 2+ minutes (not during maintenance)                                                                                                                                                                                                | Watch Orders and Kitchen for orders that stop moving                                                                                                                                                                                                                                                                         | `docker compose logs pilot`; restart `pilot`                                                                                                                                                                                                                                                                                                                 |
| <a id="alert-service-attention"></a>A background service needs a person              | The supervisor gave up restarting a service, or a workload keeps failing (named)                                                                                                                                                                            | Check Orders and Exceptions for waiting work                                                                                                                                                                                                                                                                                 | Read that service's log in the runtime directory (`<service>.log`, `workload_cycle_failed` lines); fix, then restart                                                                                                                                                                                                                                         |
| <a id="alert-payment-updates"></a>Order or payment updates are stuck                 | Events failed after automatic retries (dead letters)                                                                                                                                                                                                        | Never take a second payment from a guest who says they paid; check Exceptions                                                                                                                                                                                                                                                | `dead-letter-operations.mjs list`; fix the cause; retry per "Interrupted maintenance diagnosis"                                                                                                                                                                                                                                                              |
| <a id="alert-updates-retrying"></a>Some order updates are being retried              | An order, kitchen or payment update has failed 4 times or kept failing for 10+ minutes and is still being retried (urgent after 30 minutes); clears 2 minutes after it is processed                                                                         | Hand ready orders over in person (order number plus name or phone, Pickup "Hand over"); compare the kitchen board with Orders; never take a second payment                                                                                                                                                                   | Read `business-worker.log` (and the other worker logs) in the runtime directory for the failing update's safe code; fix the cause while retries continue; once fixed, [retry now](#retrying-waiting-updates-now-wp-2423) (`consumer-retry-operations.mjs retry-now`, `--dry-run` first); if it becomes "Order or payment updates are stuck", follow that row |
| <a id="alert-receipts-template"></a>Receipts are not being issued                    | The receipt template the Store's published settings name cannot be proven as published (or those settings cannot be read) for 2+ minutes; paid orders get no receipt until it is fixed (urgent); clears 2 minutes after a receipt could be issued again     | Tell guests who ask that the receipt will appear on their order page; take payment and hand over orders as usual. Owner: Store setup step 5, choose a published receipt template, then send, approve and publish at step 8                                                                                                   | Read `business-worker.log` for `DIGITAL_RECEIPT_TEMPLATE_UNAVAILABLE`; check that the template named by the published Store configuration has a current Publishing release; once fixed, retry any receipt updates that were dead-lettered                                                                                                                    |
| <a id="alert-pricing-tax-configuration"></a>Orders cannot be priced                  | The tax configuration the Store's published settings name is not the one the pilot files carry test evidence for (or those settings cannot be read) for 2+ minutes; no new order is priced online or at the counter (urgent)                                | Take new orders on paper and payment on the card machine, enter them once it clears. Owner: Store setup step 8, "Use the live Store's settings" for tax, then send, approve and publish                                                                                                                                      | Read `api.log`/`customer.log` for `INTERNAL_QUOTE_TAX_CONFIGURATION_UNAVAILABLE` (code: mismatch or unreadable); compare the published configuration's tax reference with the pricing policy's                                                                                                                                                               |
| <a id="alert-orders-held-stock"></a>Orders from earlier days are still holding stock | An Order of an earlier business day still has ingredients set aside (accepted but never made or handed over, or ended without its stock being returned), so items made from them can show sold out to guests (warning); clears 2 minutes after none is left | Open Orders: these orders are listed first with today's. Make and hand over one the guest still wants, or cancel it (the guest is refunded, the ingredients return). For a finished order choose "Release held ingredients"; one the kitchen started: mark it done on the kitchen board. Review this before closing each day | Nothing to run: staff resolve it in Orders (every release is audited). If it persists after staff acted, read `api.log` for `ENDED_ORDER_STOCK_*` / `ORDER_CANCELLATION_*` refusals                                                                                                                                                                          |
| <a id="alert-pickup-capacity-horizon"></a>Pickup times are running out               | Pickup times (laid 14 days ahead from the published hours) reach under 24 hours ahead (warning) or under 1 hour or none (urgent: no pickup order online or at the counter); clears 2 minutes after 24 hours again                                           | Warning: nothing changes for guests. Urgent: take pickup orders on paper (items, name, time) and payment on the card machine, enter them once it clears; dine-in is not affected                                                                                                                                             | `business-worker.log`: `pickup_capacity_schedule_applied` and the cycle failure code (`PICKUP_CAPACITY_POLICY_UNAVAILABLE`, `PICKUP_CAPACITY_CONFIGURATION_ENDED`: publish Store hours without either); the next run fills from now                                                                                                                          |
| <a id="alert-reconciliation-differences"></a>Payment differences need checking       | Open differences between store records and the payment provider, for one payment or a business day's totals (urgent after 24 hours)                                                                                                                         | Store Manager: `Exceptions` for each difference; for a day's totals, `Settlement` for that day, which explains it and what to do                                                                                                                                                                                             | Only if a difference is a system fault                                                                                                                                                                                                                                                                                                                       |
| <a id="alert-settlement-exceptions"></a>Day-end settlement has open problems         | A closed day has a difference, or no settlement 6 hours after close                                                                                                                                                                                         | Store Manager: `Settlement` for that day                                                                                                                                                                                                                                                                                     | If days are missing: `daily-settlement-worker.log` `daily_settlement_day_failed` lines name the day and safe code; that day is retried on its own (1 minute, doubling to 30) while later days settle; fix the cause, no restart needed                                                                                                                       |
| <a id="alert-backup-failed"></a>Last night's backup failed                           | The dump failed; retries follow (3 a day)                                                                                                                                                                                                                   | Nothing in store; service is unaffected                                                                                                                                                                                                                                                                                      | `ops/alerts.log` reason; free space; database reachable; `backup-now`                                                                                                                                                                                                                                                                                        |
| <a id="alert-backup-stale"></a>No recent backup                                      | No successful backup for 26 hours, or none configured yet                                                                                                                                                                                                   | Owner: ask for a backup today                                                                                                                                                                                                                                                                                                | Configure `backup` in `ops.json`, or find why the schedule did not run; `backup-now`                                                                                                                                                                                                                                                                         |
| <a id="alert-backup-restore-check"></a>The newest backup could not be restored       | The scratch restore, row comparison or photo check failed (`media missing`: photos the menu uses are not in the photo folder)                                                                                                                               | Nothing in store                                                                                                                                                                                                                                                                                                             | Keep older backups; run `drill` by hand on the newest and on the previous one; take a new backup                                                                                                                                                                                                                                                             |
| <a id="alert-backup-offsite"></a>Off-site backup copy failed                         | The encrypted copy could not be written (drive missing, full, key missing)                                                                                                                                                                                  | Owner: reconnect the drive or check the sync folder                                                                                                                                                                                                                                                                          | Check the `/offsite` mount, free space and the key file                                                                                                                                                                                                                                                                                                      |
| <a id="alert-certificate-expiring"></a>Secure connection certificate expires soon    | Within 7 days ("Urgent" within 2 days or expired)                                                                                                                                                                                                           | Plan the renewal before it expires                                                                                                                                                                                                                                                                                           | `pilot-provision-tls.mjs renew` (see its README), restart, re-trust on staff devices                                                                                                                                                                                                                                                                         |
| <a id="alert-installation-validity"></a>The store's ordering setup expires soon      | The installation's validity window (`binding.validUntil`) ends within 14 days ("Urgent" within 3 days or ended)                                                                                                                                             | Owner: approve a new end date in writing                                                                                                                                                                                                                                                                                     | Pilot: `pilot-installation-issue prepare-renewal` → `sign` → `apply` in a planned update window ([Renewing a Pilot installation](#renewing-a-pilot-installation-dec-pilot-installation)); InternalTest: [Renewing the internal test installation](#renewing-the-internal-test-installation)                                                                  |
| <a id="alert-disk-low"></a>Disk space is running low                                 | Under 15% or 5 GB free ("Urgent" under 5% or 1 GB) on a named folder or the database disk                                                                                                                                                                   | Nothing in store until it is full                                                                                                                                                                                                                                                                                            | Remove old logs and old local backups beyond `keep`; `docker system df` for the database volume; add storage                                                                                                                                                                                                                                                 |
| <a id="alert-monitor-source"></a>Some checks could not run                           | A source could not be read for 5+ minutes (for example the database for payment checks)                                                                                                                                                                     | Treat the named checks as unknown                                                                                                                                                                                                                                                                                            | `ops/alerts.log`; database and runtime directory permissions                                                                                                                                                                                                                                                                                                 |
| <a id="alert-channel-delivery"></a>Alert messages are not being delivered            | An email or phone channel has failed for 30+ minutes                                                                                                                                                                                                        | Owner: watch the Home card; check the account                                                                                                                                                                                                                                                                                | `ops/alerts.log` code; fix the account file; `test-alert`                                                                                                                                                                                                                                                                                                    |

The first five alerts (store system, customer page, staff screens, supervisor, background service)
wait during a [planned update](#planned-updates-deploys-and-planned-restarts-2026-10-18) window and
are raised at once if the problem is still there when it ends.

"Some order updates are being retried" after its cause is fixed and deployed: updates already
waiting keep their backoff (one step can be 15–30 minutes), so without action the alert can stay up
for about 30 minutes while they go through one by one (v15 2026-10-18: 10:00 to 10:24). Staff keep
handing orders over as the row says; the pilot operator brings the waiting updates forward as below.
Never edit retry or outbox rows by hand to speed them up.

#### Retrying waiting updates now (WP-2423)

Once the cause is fixed and deployed, the pilot operator runs `consumer-retry-operations.mjs` in the
pilot image (the env file is the migration connection file, never printed):

```bash
node --import ./tooling/environment/register-workspace-typescript.mjs tooling/environment/consumer-retry-operations.mjs list --env-file <migration env>
node --import ./tooling/environment/register-workspace-typescript.mjs tooling/environment/consumer-retry-operations.mjs retry-now --env-file <migration env> --confirm-target <environment>:<database> --operator <uuid> --consumer <name> --dry-run
```

`list` shows the waiting and in-progress updates (consumer, event type, attempts, next try,
deadline; never the update's content). `retry-now` (`--consumer <name>` or `--all`) moves only
updates waiting out a backoff to now, so the background worker takes them on its next pass; an
update being processed, finished or dead-lettered is left alone, and the update's content, attempt
count and deadline never change. `--dry-run` lists what would move and writes nothing; run it first,
then the same command without `--dry-run`. Each update moved is recorded in
`platform_eventing.consumer_retry_expedite_action` with the operator, permission, purpose and
reason. The alert clears 2 minutes after the updates are processed; if an update fails again it
returns to its normal backoff.

If the Home card says "The alert monitor is not running" or "stopped reporting": nothing above is
being checked. The pilot operator runs `docker compose -f compose.pilot.yaml up -d ops` and reads
`docker compose logs ops`.
