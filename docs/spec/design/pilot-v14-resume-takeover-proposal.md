# v14 interrupted source-resume takeover

Status: Owner explicitly authorized the recovery exercise on 2026-09-22 (reply: 授权).
Implementation and isolated tests are recorded in WP-2402 batch612; actual execution
and its outcome are recorded separately in batch615.

## Scope and reason

The accepted [source-resumption proposal](pilot-v14-recovery-source-resume-proposal.md)
permits cleanup of the executing controller's own directory. This extension permits
an explicit successor to adopt a departed controller's existing directory while
preserving its owner metadata and original Started/Completed records. It does not
change accepted business rules or claim the running installation is interrupted.

The exact local scope remains `.local/pilot-v14`, database
`bop_rms_wp2402_pilot_v14` at `127.0.0.1:55435`, container
`bop-rms-wp2402-pilot-v4-postgres-1`. No grants or schema changes are required.

## Prepared behavior

The existing `pilot-recovery-resume.mjs` accepts one explicit extra argument,
`--resume-interrupted`, after runtime, isolated target, container and recovery label.
Without that flag, the existing exclusive-create behavior remains in force.

1. Require a recorded, definitively exited owner, original Recovery maintenance
   lease still present, and original source/target/installation binding. Refuse an
   active, unidentified or reused process identity, missing lease, changed baseline,
   supervisor control, or competing takeover controller.
2. Retain the existing resume directory continuously. Archive its unchanged owner
   inode to a new private `resume-attempt-<uuid>/prior-owner.json`; write the new
   controller identity and separate attempt records. Preserve all previous markers.
3. Through existing identity-aware service commands, attempt to stop all seven
   original services. Perform the full original PostgreSQL, simulator, installation
   and process comparison before any startup. Never reconstruct the baseline.
4. Start original services with baseline feature gates. Only after readiness and
   durable completion remove the unchanged original maintenance lease and the
   now-owned resume control. Restore supervision separately after success.
5. Retain maintenance, current attempt evidence and adopted control on failure.
   Source changes caused by interrupted workers require review; this mechanism does
   not force them through the original comparison. No restore target is promoted.

File and directory identity checks cover the takeover guard, original control,
original baseline and lease, and the selected attempt directory before service
operations and phase writes. A crash between archival and new-owner recording,
remaining takeover guard, or completion with an already absent lease requires
manual review; those states are deliberately not automatically cleaned up.

## Requested local acceptance authorization

Authorize one bounded local exercise: stop the existing supervisor, create a new
paired recovery snapshot and isolated restore target under the existing naming
rules, interrupt only the specifically spawned source-resume controller after its
durable owner record and before service startup, confirm that exact child exited,
then invoke the prepared explicit takeover command. Compare against the original
snapshot, restore original services and supervisor only on success. Preserve the
isolated target, snapshot, failed attempt and new attempt evidence.

This causes temporary unavailability of the local demonstration. The exercise must
not overlap operator writes. If service identity or original data comparison fails,
keep maintenance and report the actual state; do not force release. It does not
include host reboot, OS startup registration, target promotion, real payment,
financial exception closure, external deployment, credentials or Git publication.

## Evidence and remaining limits

Batch612 run233345: scoped format/lint and 51 tests pass. Service/database effects
in the takeover tests are injected boundaries; private directories, owner records,
lease bytes and archival behavior are real fixtures. The unchanged full reviewer
has 14 directly rerun tests. These results do not prove a live interruption exercise.
The existing batch597 actual recovery evidence remains limited to its original
controller path. No business journey or full-repository suite was repeated.

## Actual local exercise (batch615, 2026-09-22)

Owner-authorized exercise completed. A new recovery-615 paired snapshot and isolated
restore target were retained. The real restore command exited successfully, while
the exact-command wrapper deliberately returned failure to preserve Recovery
maintenance. This is injected command failure, not an actual failed database restore.
The actual source-resume child was interrupted only after durable owner-directory
sync, before Started/service startup. Its PID/start identity was checked before
signalling; exited-owner diagnosis reported BeforeStartupReviewRequired.

The explicit takeover then passed original-source comparison and required service
startup/readiness, archived prior owner bytes unchanged, recorded its own attempt,
and released maintenance. Readback0684fb confirms SourceResumed, NoMaintenanceLease
and supervisor running. Windows normal-TLS employee entry returned200 (812992).
Target promotion remained false. Private records are in the ignored v14 directory.

This proves the before-start controller interruption path. It does not establish
partial-start data-change recovery, host reboot, automatic orphan-guard removal,
restore-target application validation, or formal release/real Store readiness.
