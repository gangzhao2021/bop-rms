# Guest table open and busy reads (b10)

Status: Accepted (coordinator decisions under the Owner rules of 2026-11-06; WP-2423 pilot track).
Branch `codex/fix-guest-table-open-and-busy-reads`, based on integ5 `10124d70` (batches 1–9 and the
batch-cancellation hotfix). Findings: v15 live run after batch 8 (L1, L2, L3, L5 and the
price-hold-dish-changes table walk).

## 1. "This table isn't open yet" after staff opened PH 1 (TEST)

**What actually happened.** The v15 records show the session at PH 1 (TEST) was Active from
00:00:58Z to 00:43:47Z, and the server's open check reads exactly that row. The test driver fetched
the guest's link with `tableLinkAny`. That helper reads the Tables list's rows before they have
loaded. `driver.log` shows `row-match n:0` for PH 1 at both fetches, so `findIndex` returned -1 and
`nth(-1)` clicked **Print on the last row**: the driver scanned another table's card, and that table
was free. For DSA 1 and Table 4 the row was found (`n:1`), and those scans worked. The product
answered correctly for the card that was scanned. The defect was in the test driver, which picked
the wrong row.

**Commercial gap it shows.** A real restaurant has the same failure mode. Cards get moved between
tables, and a guest can scan the card from the neighbouring table. The page said "This table at
<Store> isn't open yet" without naming the table, so neither the guest nor staff could see that the
card was the wrong one.

**Decision.**

- The "not open yet" answer now carries the table name printed on the card. The name is read from
  the Dining table under the pilot API role, and no new grant is needed. Only a Published table's
  name is sent, and never an id.
- The page now says "Table 3 at <Store> isn't open yet" (zh-Hans: "<Store> 的桌号 3 还没开台").
  It adds "Not sitting at table 3? Tell staff, so they can give you this table's code." (zh-Hans:
  "您坐的不是桌号 3？请告诉店员，换成您这桌的二维码。").
- A table name that can't be read, or can't be shown safely, is left out. The answer stays "not open
  yet" as before. Phones keep checking again by themselves, as before.

## 2. A busy menu read answered 404 "menu not found"

The public store read gave the "busy" answer only for a lock conflict. Under load, no connection
became free within the request's 10 s (`ACQUIRE_FAILED`), and a cut-off statement gave
`TRANSACTION_FAILED`. Both were read as "Store unavailable", which the menu shows as "this menu does
not exist".

**Decision.** Every `TENANT_DATABASE_*` failure except `SCOPE_INVALID` now means busy. Within
5 minutes the reader gives the last answer it had. After that it answers busy, so the guest sees
503 + Retry-After. A missing or closed Store is still "not found".

## 3. A cart read answered 401 "your visit ended" in a rush

The pilot's Guest Session check (`pilot-customer-entry.mjs`) runs all its reads in one transaction.
When that transaction could not get a connection, the failure was read as "Unavailable", and the
guest was told the visit had ended. That happened after exactly the 10 s budget, with nothing
logged, and the phone dropped its cart credential.

**Decision.**

- A check that could not run is a passing fault: the guest gets 503 + Retry-After and keeps the cart.
- Only what the records say is an answer. A code that doesn't fit the phone stays "scan again".

This is the whole fix for the cart's 401 in a rush (`a27ace15`). Cart reads and cart commands
check the visit without renewing it, so no renewal race can reach them.

**A related entry fix (not a cart 401 cause).** A renewal happens only when a guest opens the table
link (the guest entry request). When the same phone opened the link twice at once, for example a
double tap or a reload while the first answer was still coming, the slower renewal found the visit
already renewed and did not go on with it. Now the visit as it stands answers, provided it is the
same visit and still usable (`7e6b75c3`; its commit subject wrongly names the cart read and the
next Add). A visit that was really ended meanwhile is still treated as ended.

## 4. Busy answers took 17–23 s, past the 15 s clients wait

The batch-8 budget bounded only the time spent waiting for connections. A read could wait 10 s and
then work for another 7–13 s.

**Decision.** A read (GET/HEAD) does all its database work within **12 s** (`requestReadAnswerMs`)
and then answers busy. That leaves 3 s for the answer to reach the phone or screen.

- After 12 s, no further connection is taken. A connection wait ends when the 12 s run out.
- After 12 s, no further statement is sent. Near the end, PostgreSQL's statement limit is narrowed
  to the time left.
- The result is the ordinary 503 + Retry-After. The read is idempotent, so the phone's own retry is
  safe.
- **A command (POST/PUT/PATCH/DELETE) has no answer time.** As before, only its waiting is bounded,
  and only until its first committed write. The clock never cuts its work, so it never stops half
  done.
- Staff list reads wait 15 s on their screens, like phones, so 12 s fits them too. A read that
  takes longer used to run on after the screen gave up. Now it says "busy" while the screen still
  listens.
- **Some staff screens wait longer, and their reads get their own time.** Reports, Tonight and the
  CSV export wait 30 s, because a month reads every payment and refund in it. The single-person
  approval, step-up and refund approval screens wait 20 s. These reads get their screen's wait less
  the same 3 s: 27 s for `/merchant/reports` and everything under it, and 17 s for
  `/merchant/organization/sole-operator`, `/merchant/identity/step-up` and
  `/merchant/payments/refunds/approvals` (`requestReadAnswerWithinMs`). Without this, a long report
  on a quiet database would always answer busy, and every retry would fail the same way. A screen
  that changes its wait must change this list too.

## 5. The guest's cart read showed 503 while staff moved or merged the guest's table

Adds kept working. Only the cart read failed, once in each move, and it worked again on the next
read. What the read met mid-change is not yet known. It is not a renewal race, because cart reads
never renew the visit (§3).

**Decision.**

- A cart read that fails with a passing fault is read once more, 200 ms later, before the guest is
  told "busy".
- There is no second read when the database had no connection to give, because that would add to a
  rush.
- There is no second read when less than 3 s of the read's answer time is left.
- There is no second read for a refusal such as `CART_INPUT_INVALID`, which answers the same every
  time. Only `CART_DEPENDENCY_UNAVAILABLE` or a database fault under it is read again.
- Only a read that fails twice writes the level-50 line. The first failure is still written, at
  level 40 as `CUSTOMER_CART_READ_RETRIED`, with its cause codes only. Live runs can then find out
  what the first read met, even when the second read worked.

## 6. Transient level-50 pilot_attention_required for healthy worker parts

When a running worker's health report for a part was a moment late (host load, an image being
built), one sweep named that part, and the next sweep 5 s later cleared it. The pilot learned to
ignore these alerts.

**Decision.**

- A part of a running worker is named only when two sweeps in a row (5 s apart) find it missing or
  stale.
- The alert line and the operations monitor's file both use the confirmed list. The supervisor's
  full snapshot line still shows the raw state.
- A whole service that is down, not started or refused is named at once, as before. A part that
  really stopped is named after 5 s, as `batchCancellation` was on 2026-11-12.

## Operating continuity

None of these changes adds a staff step.

- **Busy.** Phones retry by themselves after the Retry-After time and keep their carts.
- **Wrong table card.** The guest sees the table name and tells staff. Staff open the guest's real
  table, or hand them the right card from Tables → Table QR codes → Print.
- **Real worker outage.** It still raises the alert within one more sweep.
