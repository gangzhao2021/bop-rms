# Staff rounds on one table: one at a time, and true answers (v15 b12)

Status: accepted for the pilot (WP-2423, Owner standing approval 2026-10-14 for the migration and
grants; decided as commercial choices, recorded here). Live finding:
`.local/integ-tools/b12/staff-round-concurrency.json`.

## What happened on v15

Two staff sent a round for the same table at the same moment (one rice each). A staff round puts
its dishes in the table's shared cart and then sends that cart. One tablet was answered 503 "Nothing
was sent to the kitchen or charged" while its rice stayed in the cart; the other tablet then showed
that rice as an unsent dish and sent it, and the first tablet's retry added its rice again: three
rice charged for two ordered. The 503 came from the command's outer catch, which answered "nothing
was sent" whether or not the round's own dish could be taken back out of the cart.

## DEC-STAFF-ROUND-ONE-AT-A-TIME

- A staff round takes the table's **turn** before it touches the table's cart, in the same
  transaction that checks the command was not sent before (no extra round trip on the quiet path:
  about five more statements, M35's statement guard still passes, 2,185 a later round).
- The turn is an append-only record (`rms_ordering.staff_dining_round_table_turn`, 2000_950, Store
  RLS) with a lease timed by the database clock. It ends when the round is placed (derived from the
  round itself, nothing written), or with an end record when the round is not sent
  (`NotSent`, `DishesLeftAtTable`, `Unknown`).
- **Lease: two minutes**, the same window in which an unfinished attempt is answered "still being
  sent". A tablet that loses its connection mid-send never blocks the table longer. A round slower
  than that (heavy load) can overlap the next one; the cart's version checks then refuse rather than
  mix, and the answers below stay true.
- A second round for the table **waits up to 10 s** for the turn (a busy floor: the other tablet's
  round normally takes about a second), then is answered **409 `table_busy`**: "Another staff member
  is sending a round for this table right now. Nothing of this order was sent or charged, and it is
  still here: send it again in a moment." Nothing of it was recorded, so sending again is safe.
- Guest phones do not take turns: a guest's own send still meets the cart's version and checkout
  hold, as before.

## True answers when a round fails

- "Nothing was sent" (`staff_round_unavailable`, `item_unavailable`, `item_short`,
  `order_not_priced`) is answered only when the round's own dishes are confirmed out of the cart.
- When they could not be taken out, or left the cart some other way (sent with another round, or
  taken out by someone else), the answer is **503 `staff_round_not_withdrawn`**: the round was not
  sent, but its dishes are still in the table's cart or already went out with another round. The
  screen **clears the order** (so nothing is sent twice) and reads the table's unsent dishes, where
  those dishes show marked as staff's; staff check the table's order and send only what is missing.
- A cart someone at the table changed under the round's dish (`VersionConflict` on adding it) is the
  ordinary `table_cart_has_items` refusal with the cart as it is now, after the round's own lines
  are out.

## A round overtaken by another change to the table's order

The System cancelling an expired unpaid round (or another round going in) between the moment a
staff round reads the table Order and the moment it writes moved the Order's version, and the write
refused (503). Card-machine and pay-later sends (no Provider call) now read the Order again and send
once more, at most three times, only when the Order did move. The guest's online payment send keeps
its current behaviour (it calls the Provider).

## Lock order

A later round of a table's order now locks its stock (inventory finalisation) before it appends to
the Store's audit chain, as the first round and stock commands do. The other order deadlocked
against a stock command on v15 (2026-11-13 05:47:41Z). Rule: in one transaction, audit appends come
after the row locks of the business write.

## Also in this change

- Unexpected-failure log lines carry `level` 50 and `time` (merchant requests are served by the
  customer server, `customer.log`), and guest pipeline failures name the owner's answer as a cause
  code (`VersionConflict`, `RetryLater`), never message text.
- Switching the language on Take order keeps the order being taken (this tab, within a minute of the
  switch, dishes and choices named in the new language, for the same party).
- Chinese staff text sets a table's own name or a number off with spaces where it meets a Chinese
  character (为 B10 SRS Q (TEST) 点单, 员工录入的 5 轮).
