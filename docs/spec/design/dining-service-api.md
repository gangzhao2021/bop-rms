# DEC-DINING-SERVICE-API: guest dish progress, a stale serve, a stopped phone payment, tea at a paid table

Status: accepted for the pilot (2026-11-11, v15 batch-5 live findings; WP-2423 M41, M89, M91,
M147, M29). Internal test stage; no migration, grant, catalog or role change.

## Decisions

1. **The guest's table page carries what the read already knows.** `GET /api/v1/dine-in/session`
   now serializes each dish's `progress` (Waiting / Making / Ready / Served) and a round's
   `awaitingStore` (paid, not yet accepted). Both stay absent, never guessed, when the read has no
   value (a cancelled dish, a charge such as tea). The serializer stays an explicit list of public
   fields.

2. **A serve that lost to another screen is "changed", certain, not "could not confirm".** The
   serving store reads the dish's serving history under the dish's own lock. If its last serving
   version is not the one the screen read, or the tap asks for more than is left, it refuses with
   `DINING_ITEM_SERVICE_CHANGED`; the same applies when the party moved, merged, left or the table
   is checked out under it. Nothing is written in those cases, so the route answers 409 and the
   screen rereads the dish list and the page around it (the close section and order status), with
   "Already served on another screen…". Only a fault where the outcome is unknown stays 503 with the
   same-request retry. A guest-started table's System close keeps using the same store and sees the
   same refusal.

3. **A phone payment stop is judged by the record, not by the last reply.** Staff stop every open
   phone payment of the table one by one. If a step fails (the Provider's reply is lost, or the
   guest's phone recorded the cancel first), the stop rereads the table's payments: when every
   payment that was open now has an outcome (cancelled by staff, by the guest's phone or by the
   Provider, or paid meanwhile), staff are told "Phone payment stopped" and the bill is read again.
   If the reread fails or one is still open, it is still "try again" (503); a payment still being
   processed stays "the guest is paying". This never treats an outage as stopped.

4. **A paid table's guest count may still be corrected; its bill does not follow.** The count is a
   fact of the day (guest numbers). Once the table has paid or was written off, the per-head charge
   stays as paid and staff see "This table has paid, so Tea on the bill stays at 2. If a guest
   should get money back, a manager refunds it on the order." The line shows both numbers. Money is
   only given back through the recorded refund path, never by silently changing a paid bill.

## Operating continuity

- Network or cloud down while serving: the tap keeps its request and offers "Try again" (same
  operation, nothing served twice). A tap that lost to another screen needs no retry.
- Provider down while stopping a phone payment: "try again" until the Provider answers; staff may
  also wait for the guest's phone to record the cancel, after which the stop answers "stopped".
