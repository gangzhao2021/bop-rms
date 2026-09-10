# Single-store Pilot Delivery

Owner direction: 2026-09-10. Target: one Store, Dine-in and Pickup.
This is the active delivery sequence, not evidence of operational readiness or a promised date.
Delivery and later-phase expansion retain their existing gates.

| Milestone                       | Completion condition                                                                                            | Current evidence / remaining work                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Customer entry to current Quote | Desktop/mobile entry, Cart and repricing use actual scoped stores                                               | Dining Cart has WP-2327 evidence; WP-2401 now has actual desktop/mobile Pickup/Quote browser and PostgreSQL evidence   |
| Durable Order to Payment        | Current Guest, capacity, Inventory, Quote and Payment clock compose; duplicate/lost-response recovery converges | WP-2352 atomic writer; WP-2353 repository composition committed at 2d1f8c6; owner facts and payment composition remain |
| Merchant to Kitchen and Pickup  | Same persisted Order can be accepted, prepared, handed over and receipted; retries do not duplicate effects     | Existing owner modules; connected operator journey remains                                                             |
| Necessary daily operations      | Ordinary refund, cancellation, opening/closing and handover have accepted rules and usable workflows            | RF-D01–06, DEC-H04/H05, Dining capacity interpretation and operating-day boundaries remain decisions                   |
| Pilot candidate acceptance      | Cross-journey browser/DB, isolation/security, compatible release, restore and scoped workload evidence          | Run full regression at the connected transaction and release milestones; no fresh result yet                           |
| Real Store activation           | Scoped Store/Provider/operator/environment evidence accepted and deployment authorized                          | Owning external inventory remains controlling; no external facts supplied by this plan                                 |

Each milestone requires both the usable flow and its evidence. A completed module or WP is not
automatically a completed milestone. Keep one current work owner and reuse valid verification.

## Owner inputs

Record preparation status only, never credentials or personal evidence here.
Store/operator, selected Payment Provider, test account and deployment availability were requested.
Pending response does not block independent local integration.
Use the [Pilot evidence inventory](./pilot-integration-readiness-inventory.md) for actual activation.

## Current increment

[WP-2401](../spec/work-packages/WP-2401.md): Pickup browser Cart and persisted Quote integration.
The Order task handed off WP-2353 at 2d1f8c6 and is no longer writing; its scoped evidence is retained.
