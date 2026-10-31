# v14 interrupted Recovery source resumption proposal

Status: accepted by the Owner on 2026-09-22 (explicit reply: 授权), following the specific source-resumption request. WP-2402 local v14 scope only. Implementation and actual acceptance remain separate.

## Problem and current state

Batches588–593 retain Recovery maintenance after uncertain Docker execution or
integrity/cleanup failure, persist the original baseline, and provide read-only
source comparison. At proposal time there was no approved controller to release an interrupted
Recovery lease and start the original installation. Batches596–597 now implement
the approved controller and record actual client-interruption/source-resumption
acceptance; broader recovery and deployment gates remain separate. The normal v14
installation is not being declared interrupted by this proposal.

Automatic approval review rejected the attempted controller code write before
execution: starting services and deleting the Recovery maintenance lock require
specific authorization. No controller implementation or lock release resulted.

## Exact requested authorization

Authorize implementation and isolated tests of the source-resumption controller,
then its local acceptance exercise within `.local/pilot-v14`, database
`bop_rms_wp2402_pilot_v14` on `127.0.0.1:55435`, and existing container
`bop-rms-wp2402-pilot-v4-postgres-1`. Exercise a new isolated recovery target under
the existing `bop_rms_*_restore_*` naming guard; never promote it or connect the
application to it. Preserve existing recovery targets and evidence.

Authorize these specific effects only when all conditions below are met:

1. Start the original v14 services under an exclusive recovery-resume controller,
   retaining the original Recovery lease until startup/readiness succeeds.
2. Remove only that unchanged original `maintenance.lock` after durable successful
   source-resume recording. Preserve the original lease identity/hash in private
   recovery evidence. Remove only the control directory created by this controller.
3. Restore the existing supervisor after source readiness and successful lease
   release. No OS startup registration or host reboot is included.

## Preconditions

- The original Recovery owner has exited; it is not merely slow or unobservable.
- A private pre-operation baseline from batch592 exists and matches this precise
  lease, runtime directory, original source, isolated target and container binding.
  Do not reconstruct a missing pre-operation baseline from current data.
- All seven services are stopped. No supervisor, restart or other maintenance
  controller is active. A private exclusive resume control prevents two resumptions.
- Actual container inspection finds no dump, restore, shell or unknown process;
  source/target database connections are absent except the review connection.
- Original PostgreSQL and simulator inventories match the baseline, simulator
  integrity passes, and installation files/backup match their manifest digest.
- Recheck original lease, baseline and controller identity before starting and
  before releasing exclusion. Reuse baseline-required feature readiness gates.

## Failure behavior and residual risk

Keep the original Recovery lease on failed comparison, uncertain process state,
startup failure, evidence-write failure or identity drift. If this controller
started some services, attempt to stop each through the existing service interface;
never kill an unidentified process. Report incomplete stopping exactly.

Starting workers can resume legitimate pending business operations before every
service reaches readiness. A failed partial restart can therefore change source
contents; do not claim the old baseline still matches, force a retry or overwrite
history. Retain exclusion and require a new review of actual state.

A controller crash can leave its private control directory and Started record.
Do not blindly delete those or infer success. A Completed record does not alone
prove the lease was removed or supervision resumed. Record and inspect each state.

This operation does not prove that the restore target is complete, does not alter
or promote that target, does not resolve financial exceptions and does not make
real Store/Provider activation ready. No database grants, external deployment,
credential changes, commit/push/merge or business-history rewrites are included.

## Implementation and acceptance plan

Use the existing read-only reviewer, service startup/readiness and maintenance
interfaces. Add a narrow start/stop-only maintenance context and durable private
Started/Completed evidence. Prevent nested maintenance and concurrent controllers.

Run only affected recovery/maintenance/start tests and scoped lint/format. Cover
review refusal, successful order and exclusion, duplicate record, concurrent
controller, changed lease, partial startup and evidence failure. Then perform one
bounded local interrupted-recovery exercise with the source preserved and a new
isolated target; verify actual source recovery and supervisor restoration. Keep
failed evidence and report any unproved stage. Existing unrelated business checks
remain reusable under WP-2402 rules.
