-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 600000
-- recovery: forward-fix
-- WP-2423 (reads-under-burst, docs/spec/design/reads-under-burst.md §6): the Orders screen asks
-- every 3 s whether anything changed among the Store's Orders. For each kind of Order record it
-- reads the latest recorded time and the count recorded since the previous clock hour. These
-- indexes lead with the Store and end with that time, so each part reads one row from the end of
-- the index or only the last hour's rows, never every record the Store ever wrote.
-- order_header already has order_header_store_created_idx (brand_id, store_id, created_at DESC).
-- Index only: no row is changed or removed, no grant changes (Owner standing approval
-- 2026-10-14, WP-2423).
CREATE INDEX order_batch_store_submitted_idx
  ON rms_ordering.order_batch (brand_id, store_id, submitted_at);
CREATE INDEX order_payment_acceptance_wait_store_evaluated_idx
  ON rms_ordering.order_payment_acceptance_wait (brand_id, store_id, evaluated_at);
CREATE INDEX order_acceptance_record_store_accepted_idx
  ON rms_ordering.order_acceptance_record (brand_id, store_id, accepted_at);
CREATE INDEX order_payment_disposition_record_store_evaluated_idx
  ON rms_ordering.order_payment_disposition_record (brand_id, store_id, evaluated_at);
CREATE INDEX order_termination_record_store_terminated_idx
  ON rms_ordering.order_termination_record (brand_id, store_id, terminated_at);
CREATE INDEX order_staff_cancellation_store_cancelled_idx
  ON rms_ordering.order_staff_cancellation (brand_id, store_id, cancelled_at);
CREATE INDEX order_fulfillment_completion_record_store_recorded_idx
  ON rms_ordering.order_fulfillment_completion_record (brand_id, store_id, recorded_at);
CREATE INDEX order_closure_version_store_occurred_idx
  ON rms_ordering.order_closure_version (brand_id, store_id, occurred_at);
