# Later rounds: current checks before the write (rush-connection-hold)

Status: Accepted (coordinator decision under the Owner rules of 2026-11-06; WP-2423 pilot track).
Branch `integ5`, based on `7b374f05` (batches 1–16 and the platform-support fallout fixes).
Follows the opening-round fix `71e7899fa` (the same kind of nested connection).

## What happened

Since batch 16 (`cad878b59`, packages/database connection-hold and transaction runner) work that
holds a pool connection and asks for a second one is answered busy at once when none is free,
instead of waiting. Every later round on a table (rounds 2 and on: a staff round, a guest's
additional round, pay first or pay later) ran its whole current check inside the round's write
transaction (`tooling/environment/pilot-additional-submission.mjs` `validateCurrent`). Each menu,
availability and stock read there opens its own read-only REPEATABLE READ snapshot (about eleven
per dish), each on a second connection while the write transaction holds its own. In a rush the
second connection is refused and the round fails (`ADDITIONAL_DINING_BATCH_STORE_UNAVAILABLE`,
staff see "couldn't send"). Running those reads on the write transaction itself is refused by
their owner: Catalog's selection facts require a coherent read-only snapshot
(`current-selection-facts-store.ts` `assertCoherentReadOnly`).

## Decision

The round's checks are split by what can fence them.

1. **Before the write transaction** (`prepareCurrent`, a new optional port of
   `createCustomerAdditionalDiningSubmissionRuntime`, run on every attempt before
   `transactions.run`): the full current check, exactly the one that ran inside before. The
   checkout validation service reads the menu, the dish, its choices, availability, kill switch,
   stock coverage and prices, each read in its own snapshot or short transaction (the guest's
   access, its session and the Cart in transactions of their own, as the opening round does since
   `71e7899fa`). It also checks the capacity link against the round's checkout (Store, Cart and
   its version, quote, window). Any refusal here starts no write. What it found current is kept
   for this attempt only: the submission, the capacity link, the window end, the menu version and
   the dishes of each line.
2. **Inside the write transaction** (`validateCurrent`), only what that transaction can fence:
   - the attempt's pre-check ran and is for this submission and this capacity link;
   - the Order is the one selected, the guest's access is current (row locks on this connection);
   - the Cart is the one checked, at the version checked (the batch store has locked it);
   - the capacity link and the checkout window have not lapsed, and the round's time is not ahead
     of the server's;
   - Catalog's new owner re-check `confirmCatalogSaleStillCurrent`, on this connection: the menu
     release in effect now is the one the pre-check read, every dish's Store availability is
     Available, and none of the chosen choices is off now. It reads only owner tables through the
     owner's existing stores (menu release, availability rules, choice sold-out marks), takes a
     handful of statements per round whatever the number of dishes, and sets the Store scope back
     on the transaction whatever it answers.
   - Stock is not read again: the round's stock reservation (`customer-submission-inventory-
finalizer.ts`) in the same transaction locks the stock ledger and refuses a dish its stock can
     no longer make (`STOCK_RESERVATION_INSUFFICIENT` → `ORDER_CREATE_STOCK_SHORT`).
     Idempotency, the table's one-round-at-a-time turn, money to the cent, the append-only batch,
     Audit and event, the Order's disposition fence and the tenant/Store scope are unchanged: they
     were already fenced in the write transaction and stay there.

## A round sent again (idempotency)

A round already written is never checked again. The written round emptied the table's Cart and
moved its version on, so a fresh current check of the same checkout refuses it (the Cart version
moved on), although it is only a retry. Two real cases send it again: a guest's reply lost after
the round committed, and a pay-first later round whose payment start (payment clock or Provider)
failed after the round was written; refused, the first could not be recovered and the second sat
written and unpaid until the System cancelled it.

The guest path finds the submission already recorded before any write (the history reader, in
`apps/api/src/customer-additional-dining-session-submission.ts`) and replays it through the runtime's
`submitRecorded`: the same write transaction (disposition fence, guest access, saved tip choice,
the batch store's own record lookup) without `prepareCurrent`. The batch store answers `Existing`
from the record and never calls `finalize`, so `validateCurrent` is not reached. The runtime refuses
anything but `Existing` on that path (the transaction rolls back), so a replay can never write a
round that skipped the pre-check. A staff round's retry is answered earlier by the staff round's
own retry lookup.

## A dish that sells out between the pre-check and the write

It is never ordered. The write transaction is READ COMMITTED and takes its instant (`now()`) inside
the transaction, after the pre-check:

- A staff sold-out mark, or "stop offering", for a dish or a choice committed before that instant
  is seen by Catalog's re-check: the round is refused as a dish that ran out
  (`ORDER_CREATE_STOCK_SHORT`). The guest reads "a dish ran out", staff read "can't be sold now";
  the round's dishes leave the table's Cart and nothing is ordered or charged. A mark made after
  that instant is a later event than the round, as at the counter: the round was taken first.
- Stock taken by another table after the pre-check is refused by the reservation in the same
  transaction, with the same answer.
- A new listing of the menu since the pre-check prices the cart again
  (`CHECKOUT_REQUOTE_REQUIRED`, "the menu changed"), as a changed price already did.

## Operating continuity

In a rush a later round no longer holds two connections, so it is answered like the opening
round: placed, or a plain refusal staff can act on (send again, remove the dish). If the database
cannot answer the pre-check, nothing was written and the round can be sent again; the paper-slip
outage path is unchanged.

## Cost

Measured by the staff-round-speed acceptance (twelve one-dish rounds on one table, this machine):
a later round ran 2,184 statements before and 2,191 after (7 more: Catalog's re-check and the
guest session read in a transaction of its own), 1.04–1.11 s a round before and after; the opening
round is unchanged (2,230). The 2,250 guard is not changed. The reads that moved out of the write
transaction are the same reads.

## Checks

- `staff-round-speed` acceptance, "three staff rounds on one table are sent on a pool of one
  connection": failed before (round 2, `ADDITIONAL_DINING_BATCH_STORE_UNAVAILABLE`), passes after.
- `staff-round-speed` acceptance, "a dish sold out or run out between a later round's pre-check
  and its write is refused, never ordered": the sold-out mark and another table's hold on the last
  stock land inside the round's write transaction before its own checks; both refused, no batch,
  no stock held, and no read-only snapshot opened by that write. With Catalog's re-check switched
  off the sold-out dish was ordered (the re-check is what catches it).
- `staff-round-speed` acceptance, "a guest's later round sent again is answered from its record":
  a second phone's later round at a pay-first table is prepared again with the same checkout and
  tip choice through the pilot's guest composition, on a pool of one connection. Failed before
  (`CHECKOUT_CART_VERSION_CONFLICT` from the pre-check); passes after: the same preparation, no
  second batch record, batch, Audit or event.
- Unit: `tooling/environment/pilot-additional-submission.test.mjs`,
  `apps/api/src/customer-additional-dining-submission-runtime.test.ts` (a recorded replay skips
  the pre-check; a replay that finds no record rolls back),
  `apps/api/src/customer-additional-dining-session-submission.test.ts`.

## Not changed here

The opening round (the table's first Order, `CapacityLinkedOrderCreation`) validates before its
write and fences stock in the write, but does not re-check a sold-out mark made in between:
listed in WP-2423 as open.
