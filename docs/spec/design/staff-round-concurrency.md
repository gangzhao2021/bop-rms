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
  RLS) with a lease timed by the database clock. It ends with an end record: `Placed`, written in
  the transaction that reads the placed round back (no extra round trip), or `NotSent`,
  `DishesLeftAtTable`, `Unknown` when the round is not sent. A turn whose end could not be written
  is still over once its round exists; that check finds the round by its table guest through an
  index (`order_batch_submitted_by_actor_idx`), so it never reads the Store's sent rounds.
- **Lease: two minutes**, the same window in which an unfinished attempt is answered "still being
  sent". A tablet that loses its connection mid-send never blocks the table longer. A round slower
  than that (heavy load) can overlap the next one; the cart's version checks then refuse rather than
  mix, and the answers below stay true.
- A second round for the table **waits up to 10 s** for the turn (a busy floor: the other tablet's
  round normally takes about a second), then is answered **409 `table_busy`**: "Another staff member
  is sending a round for this table right now. Nothing of this order was sent or charged, and it is
  still here: send it again in a moment." Nothing of it was recorded, so sending again is safe.
- Guest phones do not take turns: a guest's own send still meets the cart's version and checkout
  hold, as before. **Known pilot limitation:** a guest phone's checkout started while a staff round
  is in the table's cart sends that round's dishes with the guest's round, charged to whoever pays
  at that phone. Staff are told the truth (`staff_round_not_withdrawn`, their order cleared) and
  the dishes go out once, but on the guest's payment. Trigger to revisit: a store reports a guest
  charged for a staff-entered dish.

## True answers when a round fails

- "Nothing was sent" (`staff_round_unavailable`, `item_unavailable`, `item_short`,
  `order_not_priced`) is answered only when the round's own dishes are confirmed out of the cart.
- When they could not be taken out, or left the cart some other way (sent with another round, or
  taken out by someone else), the answer is **503 `staff_round_not_withdrawn`**: the round was not
  sent, but its dishes are still in the table's cart or already went out with another round. The
  screen **clears the order** (so nothing is sent twice) and reads the table's unsent dishes, where
  those dishes show marked as staff's; staff check the table's order and send only what is missing.
- From the checkout on, a failure with no round behind it (read twice, before and after taking the
  dishes back out) is answered the same way: `staff_round_not_withdrawn` when they could not be
  taken out or left the cart another way, never "still being sent".
- An add whose answer was lost (it may have committed) counts as possibly in the cart: "nothing
  was sent" stands only when the cart then holds nothing but the guests' lines as the round took
  them in. A line it can't tell from a guest's new one is never taken out.
- The same command sent again (its answer was lost) with no round behind it reads how its turns
  ended: dishes left at the table, or an attempt that ended without knowing (after the two-minute
  sending window), is answered `staff_round_not_withdrawn`, never "didn't go through, send it
  again" (`staff_round_not_finished`), which could send its dishes twice.
- A cart someone at the table changed under the round's dish (`VersionConflict` on adding it) is the
  ordinary `table_cart_has_items` refusal with the cart as it is now, after the round's own lines
  are out.

## A round overtaken by another change to the table's order

The System cancelling an expired unpaid round (or another round going in) between the moment a
staff round reads the table Order and the moment it writes moved the Order's version, and the write
refused (503). Card-machine and pay-later sends (no Provider call) now read the Order again and send
once more, at most three times, only when the Order did move. The guest's online payment send keeps
its current behaviour (it calls the Provider) and still answers unavailable when the Order moves.
Proved by unit tests only; a real System cancellation committed between the read and the write is
left to the v15 live check.

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

## A staff member signs out mid-round (v15 batch 29)

Live finding `.local/integ-tools/b25/b28live-result.json` (race-payment-and-signout, new finding 2):
signed out 450-600 ms after Send, the round was refused 403 after its checkout had started, and
its dish stayed in the table's cart, held by that checkout, shown to staff under the guests'
phones and to guests as "Added by another guest". The next staff member was refused for it, and
sending it alone answered 503 (`CART_QUOTE_INVALID`).

- **Before submission** (its checkout started, nothing submitted): the round takes its own lines
  back out with its own table guest (never the signed-out member's authority, only this round's
  lines), then answers 403 as before. Lines it can't take out are answered
  `staff_round_not_withdrawn`, as for any other failure.
- **After submission** the round exists: it is finished as this request's own round (the Store
  and staff member it took the table's turn for, every read and write limited to this entry's
  round): a pay-at-end round is sent to the kitchen and the answer is Placed. Before, it was left
  submitted but never sent to the kitchen, answered 403.
- **A quote held for another participant** (DEC-PRICE-HOLD rule 2): a staff round's table guest,
  or another phone, is answered the Quote the first phone confirmed for that Cart version, and the
  details and checkout of a table's Cart now accept it (same Quote, same Cart version, still in
  its hold). Before, they accepted only a Quote the payer attached itself, so the round was
  refused `CART_QUOTE_INVALID` (the 503). A price that ran out before the details are saved is
  answered `order_not_priced` (send again), with the round's own lines out.
- **A table this round opened** is closed again once its lines are out, as for any round refused
  before an order. Closing uses the staff member's own closing authority: after a sign-out it is
  refused. **Batch 30:** the System then closes it (Begin and Finalize recorded as the System, reason
  `STAFF_ROUND_NOT_SENT`, no cleaning step: nothing was served), in one transaction that checks it
  is still all this round's doing: the Session is Active and was started by that staff member, no
  order exists for it, its cart is empty, no call is open, nothing was merged into it, and nobody
  but this round's own table guest joined it. Otherwise it stays open for staff, as before. No
  grant or catalog change: the System reason is allowed in Dining's closing checks
  (`systemTableCloseReasons`), the writes are those staff closing already uses. Acceptance:
  `staff-round-same-table-race` case "batch 30".
- **"Not found" during the race** (v15 `quote_not_found` at 22:28:17Z, 22:28:40Z, 22:30:17Z): each
  phone quote met a staff round's table guest joining the table (join records at 22:28:17.822Z,
  22:28:40.676Z, 22:30:17.420Z), which moves the party to a new version; the quote compared party
  versions across its checks and refused. It now prices again on the table as it is now (up to
  four times), then answers a 409 conflict the phone reads the table again on; a different
  participant is still refused.
- On a pay-at-end table the staff screen never says a guest is paying: it says a guest is sending
  these dishes from their phone.
