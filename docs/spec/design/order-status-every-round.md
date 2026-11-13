# A long table's order status, and a round sent while the Order moves on (v15 b13)

Status: accepted for the pilot (WP-2423; decided as commercial choices, recorded here; no
migration, no grant). Live finding: `.local/integ-tools/b13/order-projection-and-round-race.json`.

## What happened on v15

**Order status stopped at 20 rounds.** At DEMO Store 2 the business worker's order status update
(`ordering.order-status-projection:v1`) failed on every retry for the OrderSubmitted event of the
21st round of two dine-in tables (orders with 28 and 47 rounds, many cancelled unpaid). Read-only
SQL showed both events with `batchSequence` 21 and the stored status of each order at its 20th
round. The status snapshot, its stored copy, the read of the order's later rounds, the guest
page's decoder and the guest's kitchen progress all refused more than 20 rounds. The refusal was
reported as "dependency unavailable", so each event was retried 8 times and dead-lettered (an
outbox and a consumer dead letter each). Because events of one Order go out in order, 106 later
updates of those two Orders (rounds 22 to 47 and their cancellations) waited behind them. Only the
order status consumes these events, so the kitchen, payments and the merchant order list were not
affected; the guest's status page and the status-based reads showed the order as of round 20.

**A staff round answered 503 when the System cancelled an expired unpaid round meanwhile.** A
round is prepared against the table's Order as it was read when its checkout starts. When the
System took an expired unpaid round off (a new Order revision) between that read and the
preparation's own check, the preparation refused, nothing was recorded, and staff were told
"Nothing was sent ... Send it once more" (2 of 9 timed sends at expiry + 5 s). The b12 fix re-read
the Order only in the payment write, not in this preparation step.

## DEC-ORDER-STATUS-EVERY-ROUND

- A table's Order status holds **every round the Order holds**. The bound is the one the rest of
  Ordering already sets for one Order: **10 000 rounds** (its round, line and cancellation reads
  refuse past 10 000). A real table at a hot pot, all-you-can-eat or dim sum restaurant passes 20
  rounds in an evening, especially when staff send one dish at a time or unpaid rounds lapse and are
  ordered again; refusing the 21st round would mean refusing a normal dinner.
- Applied the same in every place the status passes: the status snapshot and its stored copy
  (`orderStatusMaximumRounds`), the read of the Order's later rounds (`LIMIT 10001`), the guest
  page's decoders (customer app), and the kitchen's per-round progress for the guest (one ticket
  a round, `LIMIT 10001`). Items per round stay at 100.
- Not chosen: refusing a table's 21st round at ordering (a normal dinner refused), or summarising
  older rounds in the status (the guest and staff must see every round they were charged for).
- An event the status truly cannot take still fails visibly as before (level 50 log, supervisor
  attention, dead letter with its reason); nothing is dropped. Trigger to revisit: any order status
  dead letter whose cause is not a dependency outage.

## DEC-ROUND-PREPARED-ON-CURRENT-ORDER

- When a round's preparation refuses and the table's Order **moved on** since the round read it
  (a newer Order version: the System took an expired unpaid round off, staff accepted, paid or
  cancelled a round), the round is prepared once more against the Order as it is now, **at most
  three times in all** (the same rule as the b12 payment write). The table's turn
  (DEC-STAFF-ROUND-ONE-AT-A-TIME) is kept throughout, and nothing is added to the quiet path: a
  round that is not overtaken runs exactly the statements it ran before (M35 guard unchanged).
- A refusal with the Order **unchanged**, or with **no open Order** any more (the table was
  closed), stands as before and is answered as before.
- A round whose last check found the Order moved after it was already prepared stands as prepared;
  its final write re-checks the Order under its fences as before.
- The same preparation serves guest phones, so a guest's round sent at that moment goes through the
  same way.

## Operating continuity

- If the worker cannot update an order's status (outage or a refusal), the kitchen and the card
  machine keep working; staff see the order and its rounds on the Orders and Tables pages, which do
  not read this status. The supervisor raises attention and platform support recovers the event with
  the runbook tools below once the cause is fixed.
- A round still refused after three tries (the Order changing without pause) is answered truthfully
  as not sent, with the order kept on Take order; staff send it again.

## Recovery of the two v15 events after the deploy

Run in the pilot container (`docker exec bop-rms-pilot-pilot-1 node --import
./tooling/environment/register-workspace-typescript.mjs tooling/environment/<tool> ...`), in this
order, after the new image is live; operator `0190fa30-0000-7000-8000-000000000900` (TEST-ONLY
platform support identity, as for the earlier v15 recoveries):

1. `dead-letter-operations.mjs list --env-file .local/pilot-runtime/migrate-v14/migrate-v15.env`:
   the two open outbox and two open consumer dead letters of the order status at DEMO Store 2.
2. With `PILOT_RUNTIME_DIRECTORY=.local/pilot-v15/stores/demo-2` (DEMO Store 2's own runtime
   directory): `outbox-recovery-operations.mjs recover --operator <operator> --dead-letter
0190fa46-1f38-7420-8daa-75caae3aced5` (order of 06:16Z, round 21), then the same with
   `--dead-letter 0190fa46-e207-7f87-8451-f673fa76c3b1` (order of 11:51Z, round 21). Each hands the
   event to the order status once; the status takes the round and the event is published, after
   which the Order's later events (rounds 22 to 47 and their cancellations) go out by themselves.
3. `dead-letter-operations.mjs resolve --env-file .local/pilot-runtime/migrate-v14/migrate-v15.env
--confirm-target local:bop_rms_pilot_v15 --operator <operator>`: closes the two consumer dead
   letters whose consumer has now completed.

The OrderConfirmed event of 2026-11-01 still exhausted at DEMO Store 2 is a separate, older item
and is not part of this recovery.
