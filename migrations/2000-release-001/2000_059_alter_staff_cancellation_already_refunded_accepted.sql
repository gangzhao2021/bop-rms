-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 table closure (DEC-TABLE-CLOSE-GUESTS-LEFT, v15 2026-10-15): a round the kitchen accepted
-- but had not started can also have been refunded in full before it is cancelled (item by item,
-- online or on the Store's card machine). Cancelling it owes nothing more: no compensation is opened
-- and no 0.00 card-machine refund is left to record (card_machine_refund requires amount > 0), so
-- such a round no longer keeps the table open. refund_disposition 'AlreadyRefunded' is therefore
-- allowed for an accepted round too; the application still proves it from Payment under the Order
-- fence. Append-only: existing rows are unchanged; no new table or grant.
ALTER TABLE rms_ordering.order_staff_cancellation
 DROP CONSTRAINT order_staff_cancellation_refund_disposition_phase;
