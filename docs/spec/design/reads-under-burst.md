# Reads under a burst (b12)

Status: Accepted (coordinator decisions under the Owner rules of 2026-11-06; WP-2423 pilot track).
Branch `codex/fix-reads-under-burst`, based on integ5 `295bdd4b` (batches 1–11, what v15 runs).
Findings: v15 live run of batches 10 and 11 on 2026-11-13 (three bursts of about 440 requests at
DEMO Store, 05:45–05:47Z, plus the menu-review and pickup walks).

## 1. Reads still answered after 15 s

**What happened.** The 12 s answer time of b10 bounds a read's database work only: no connection
is taken and no statement is sent after it. In the burst, 220 answers of 200 still took over 15 s
(the slowest 18 s), and phones saw 20–26 s. The remaining time was spent outside the database:

- **The process itself.** One API process answered about 440 requests at once. The guest menu read
  was the heaviest of them (see §4), so a read whose database work was done in time still waited
  for the process to build and send its answer.
- **The second hop.** A guest request passes the guest/staff entry, which may read the guest's
  Store first, and then the Store's API. Each counted its own 12 s.
- **Abandoned reads.** A phone or screen that gave up at 15 s left its read running. That read
  kept taking connections and made the rush longer.

**Decision.**

- A read (GET/HEAD) that has not started its answer by its answer time plus 1 s is answered
  "busy, try again" at once: 503, `Retry-After: 5`, `Cache-Control: no-store`, in the body each
  surface already reads as busy. A staff read (`/merchant/...`) gets `{ error: "retry_later" }`,
  the body of every other staff "busy" answer, so the workspace asks for its session again
  (Owner 2026-11-04) and staff screens read again. A guest read gets
  `{ schemaVersion: 1, error: { code: "service_busy" }, code: "SERVICE_BUSY" }`, and the phones
  read an unknown 503 with Retry-After as busy. The entry in front of the API does the same 1 s
  later, and then also drops the API request.
- The read is then **cut**: nothing more of it reaches the database while its phone or screen
  could still be waiting (15 s from its start). A later answer from its handler goes nowhere. A
  read whose client went away before its answer is cut in the same way. After those 15 s, what
  it started and still runs (a timer, set-up shared with later requests) is unbounded like any
  request's work, never starved for good.
- A read that already committed a write, an answer already under way and every command are never
  cut. A command's work is never stopped by the clock (b10 §4 stands).
- Staff reads with longer screens (reports 27 s, approvals 17 s) get their own time plus the same
  margin.

## 2. Busy cart reads logged at level 50

**Decision.** The request records when the rush itself turned it away: no connection came within
its wait while every connection the pool may open was open and out with other work, or the server
had too many connections (53300), or its answer time ran out (the statement limit was narrowed and
cut it, or nothing more could be sent). A new connection that timed out ("Connection terminated due
to connection timeout": the database host hung or cannot be reached), a connect that hangs while
the pool has room or idle connections, and a refusal are **faults**, and a request a fault met
stays a fault even if a later step of it was turned away. The pool's handed-out clients are
counted from its own `acquire`/`release` events from the moment it is made. Such a cart read answers
503 + Retry-After as before and logs `CUSTOMER_CART_READ_UNAVAILABLE` at **level 40**. It is not
read again inside the request. A real fault (a database that refuses, a broken statement, an owner
read that fails for another reason) stays at **level 50**. The completion line of a 503 the rush
caused says `HTTP_RETRY_LATER` rather than `HTTP_SERVER_ERROR`.

## 3. Why the guest-session check was the one failing

Every cart read starts with the guest's Session record (Identity's guest session store). In a rush
it is the first step to wait for a connection, so it is where the wait runs out. The store answered
the plain "unavailable" and dropped what had failed, so the log said only `GUEST_SESSION_UNAVAILABLE`
and the cart read tried again, adding to the rush.

**Decision.** The store keeps a safe code of the failure behind its plain answer (under the
non-enumerable `bop.failure.cause` key: the code and SQLSTATE only, never a message). The log now
names it, for example `TENANT_DATABASE_ACQUIRE_FAILED`, and a read with no connection to give is not
read again. As before, the phone hears "busy, try again" and keeps its cart: it is never told the
visit ended.

## 4. Menu reads under 20 at once took 1.5–2.5 s

Each guest menu read did the whole work again: the menu, each dish's offer and price, each choice's
price (one database round trip per choice), sold-out marks and stock, and then built and serialized
the answer. 20 phones reading the menu together took 1.5–2.5 s, while 20 cart reads took 0.4–0.6 s.

**Decision.** Phones asking for the same menu (same Store, channel, order type, language, search and
section) at the same moment share one read. A menu found in the last **3 s** is given again, built
and serialized once. Commercially: a dish staff mark sold out shows so on a menu opened up to 3 s
later. Adding it is refused by the cart with its usual words, as for any menu already open on a
phone. Only a found menu is given again; "busy", "not found" and a stale menu are always asked anew.
Only menus without a search term are kept (a search is one guest's typing; phones asking the same
search together still share its read), expired menus are dropped as each new one is kept, and at
most 100 are kept.
The shared read works within its own answer time, so the phone that started it going away does not
cut it for the others.

## 5. First checkout at a pay-first table: a dead Continue and no total

Right after joining, the guest's first checkout read its cart while the store was busy. The read
failed, and the page showed only a disabled "Continue to payment": no order, no total, no word of
what happened.

**Decision.** When the cart itself can't be read, Checkout says so. If the store said when to try
again, it says "The store's system is busy. Your cart is kept. It loads again by itself in N seconds."
and reads again by itself then. Otherwise it says "We couldn't load your cart. Your cart is kept and
nothing was changed." Both offer **Try again** and **Edit cart**, and never a dead button.

## 6. A freshly paid pickup missing from Orders for 30–70 s

**What the records show.** On v15 the Order exists as soon as the guest checks out, the payment is
recorded within 1 s, and the paid order waits for staff within 1 s (`order_payment_acceptance_wait`).
The Orders list lists every Order. Orders confirmed 18–65 s after payment because staff accepted
them then. Acceptance followed when staff saw them. The delay was on the screen: it read its whole
list only every 10 s. That read is the heaviest staff read (several owner reads per listed Order).
In a rush it ran long or answered busy, and the next try came 10 s later. Two busy answers in a row
make 30–70 s.

**Decision.** Orders asks every **3 s** whether anything changed among the Store's Orders. This is
one light read (`GET /merchant/orders/changes`) over each kind of Order fact (a new Order or round,
a payment waiting for staff, an acceptance, a confirmed or refused payment, a termination, a staff
cancellation, a completion, a closure): its latest recorded time and how many were recorded since
the start of the previous clock hour. Both come from the Store's own time index
(`brand_id, store_id, <time>`, migration `2000_980`; Orders already had one), so a look reads one
row from the end of each index and only the last one to two hours' rows, never the Store's whole
history. Records are append-only, so any new one raises a count, also one whose transaction
committed after a later one (v15 has such pairs). The window moving on each hour changes the mark
once an hour (one extra list read). A record committed more than an hour after its recorded time
would be seen only by the 10 s full read. It needs the same permission as the
list and names no Order: the screen gets a digest. When it changes, Orders reads its list at once.
A change seen while a list read is on its way is read once more after it. The full read every 10 s
stays, for the kitchen's progress. The look runs only while the list is on screen and signed in.

## 7. Worker part alerts (L5)

The live run showed no transient `pilot_attention_required` over 314 sweeps, and the health file
matched. b10 §6 stands unchanged. What remains is the live check that a part that really stopped is
named within one extra sweep.

## Operating continuity

None of this adds a staff step.

- **Busy.** Phones and screens are told within their wait and read again by themselves. Carts are
  kept, and nothing is charged twice.
- **Orders.** If the light look fails, the 10 s list read and its "could not be refreshed" notice
  carry on as before. Staff can always press Refresh.
- **Network or host down.** Nothing changes: the same offline and outage paths apply.

## Review of b12 (2026-11-13)

Fixed on the same branch: the change mark sorted every record the Store ever wrote (its first
probe ordered by the id's text) and could miss a record committed late (§6); staff reads cut by
the answer time got a body the staff screens did not read as busy (§1); a database that cannot
be reached was logged as the rush (§2); a cut read stayed cut after its 15 s (§1); the menu reuse
kept up to 500 menus keyed by every search (§4). Tests now cover a staff member without the Orders
permission (refused, 403), another Store's new Order (mark unchanged), an outage (503, not a
refusal) and the mark's index plan.

What only the live run can show (v15): whether the Orders delay of 30–70 s is gone in a rush (the
cause found is inferred from the records; a list read after a change can still answer busy, and
its next try is the next change or the 10 s read); how much of the 20–26 s phones saw was spent
before the request reached Node (TLS and proxy accept queue, which the answer timer does not
bound); and the process's memory while menus are reused.
