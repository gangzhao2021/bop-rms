# Rush reads and the Orders change check (b13)

Status: Accepted (coordinator decisions under the Owner rules of 2026-11-06; WP-2423 pilot track).
Branch `codex/fix-rush-reads-and-orders-changes`, based on `ed787e9c` (batches 1–12, what v15
runs). Findings: v15 live run of batch 12 on 2026-11-13 (bursts of about 440 requests at Test
Merchant 2 and DEMO Store, plus the split-bill and paper-slip walks).

## 1. A pickup checkout in a rush said "Your session ended"

**What happened.** A pickup guest reloaded the cart during a burst. The page asks the Store for
its visit (`GET /api/v1/customer/session/csrf`) before it shows anything, and waits 5 s. Two
places read "the Store could not answer" as "there is no visit":

- **The server.** The restore answered every `GUEST_SESSION_UNAVAILABLE` as an ended visit (an
  empty 204), including the one Identity marks `dependencyFailure` (the Session or the table
  records could not be read: no free connection, a statement cut at the answer time). The moved,
  settled and ended-visit reads behind it turned any failure into "nothing to restore" too.
- **The page.** A 503, a 5xx, a timeout or a network failure of that read left the page without
  its credential, exactly like a 204. The cart itself is read with the cookie alone, so it
  loaded; the checkout then had no credential and said "Your session ended. Scan the location QR
  code again" with Continue to payment disabled. A guest at home has no code to scan.

**Decision.**

- The server answers a restore it could not read 503 with `Retry-After: 5` (body
  `session_unavailable`), never 204. Only what the records say (no visit, an ended visit, a moved
  or settled table) is an answer.
- The page keeps one more fact in memory: the Store did not answer its restore. While that holds
  and it has no credential, nothing says the session ended. The checkout shows the busy notice it
  already has ("The store's system is busy · Your cart is kept. It loads again by itself in 5
  seconds", Try again), and an add or a price says "Nothing was changed. Try again in 5 seconds".
  The page asks for the visit again (one request at a time, waiting up to 14 s) before the
  checkout loads, when an add or a price needs it, and when the cart is read. A real answer
  settles it either way: the visit comes back, or the Store says there is none (then the old
  "session ended" text is true and stays).
- The page header does not ask the guest to scan a QR code while the visit is unknown.

## 2. The Orders change check was not wired in the pilot

`tooling/environment/pilot-merchant.mjs` built the merchant routes with `orderQueue` but not
`orderChanges` (`apps/api/src/merchant-runtime.ts` builds both), so `GET /merchant/orders/changes`
answered 503 on every 3 s poll and logged a level-50 fault from every open Orders screen. It is now
built beside `orderQueue`.

**Guard.** `tooling/environment/pilot-merchant-wiring.test.mjs` reads every port of
`MerchantBffRouterOptions` that a merchant route uses and fails when the pilot composition neither
builds it nor names it in a short "not in the pilot" list with its reason. The list holds the 19
earlier authoring ports (product publication v1/v2, menu drafts, price books, brand topology,
reconciliation assignment) that existed before batch 10 and were never in this composition; the
test also fails when a listed port is built after all or no longer read, so the list stays true.
Of the ports added in batches 10–12, only `orderChanges` was missing.

## 3. Rush waits logged as faults

**What happened.** Burst cart reads that found no connection still logged level 50
(`TENANT_DATABASE_ACQUIRE_FAILED` in their causes) and HTTP_SERVER_ERROR. The b12 rule counted a
failed wait as the rush only when the pool was at its limit with every client handed out. In a
rush slots are freed and reopened all the time: a new connection's handshake to a database busy
with 57 others ran out ("Connection terminated due to connection timeout"), or the request's wait
ended while a slot was still opening, so the pool was not "full of work" at that moment. This is
the most likely cause, read from the code and the log shape; it was not reproduced live.

**Decision.** A wait that ran out (the pool's queue wait, a new connection's handshake, or the
request's own wait with an attempt still pending) is the rush when the pool was full of work, or
when another client of the pool is out with work and a client came back from its work without an
error within the last 5 s: the database is busy but answering. With nothing answered for 5 s (a
database that hangs or cannot be reached), or a refusal (28P01, 3D000), it stays a fault. 53300 is
the rush as before.

Staff requests the rush turned away now log level 40 with `resultCode: HTTP_RETRY_LATER`, in the
merchant request reporter and in the composition's own wrappers; a request that met a real fault
first stays level 50.

## 4. Staff answers after 16–18 s

**What happened.** Staff (merchant BFF) requests are answered by the guest and staff entry (the
HTTPS process behind the front's TCP relay), not by the API, so the API's completion lines
(≤ 11 s) said nothing about them, and the entry wrote no line for staff requests. The entry's own
busy answer was due at 12 s + 2 s, counted from when the request reached its route: the TLS
handshake and the time a request sat in the busy entry came on top. Every staff screen gives up at
15 s, so those late answers were lost to the screens.

**Decision.**

- A request's answer time counts from when its connection arrived, for the first request on the
  connection, at most 5 s before it reached its route (a preconnected connection may sit idle).
- Staff reads answered by the entry work 2 s less (10 s, or their screen's longer time less 2 s)
  and answer busy 1 s after that (they have no second hop). Guest reads keep 12 s + 2 s.
- Every staff request writes one `merchant_request_completed` line: route template, status,
  result, time in all, time before the route, and the longest stall of the process since the
  previous line, so the live run can see where the time goes.

What is still outside these bounds: time in the macOS port forward and the relay, and an event
loop stalled past the busy timer. The live check compares client times with these lines.

## 5. A counter send that took 35 s

The send finished by itself with no duplicate; the host load was about 5. But nothing bounded the
wait: the counter Send, a staff table round and a card-machine payment record sent their POST with
no time limit, while the page said "Still working; the system is busy. No need to tap again, this
finishes by itself." A connection that never answered would have said that for ever.

**Decision.** These requests wait at most 40 s for the answer to begin (above the 35 s seen under
heavy load). Then the page says "No answer from the system. Send again — the same order is never
created twice." Sending again sends the same operation, so the system answers with what it did
(or that it is still being sent). An answer that began is always read in full, so a definite
answer is never taken for none. The server never cuts a command.
