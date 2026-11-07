-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 store-service-controls (v15 M46, Owner DEC-OWNER-DEFAULTS-2026-11-06 item 9): at closing,
-- staff close every ready pickup nobody came for, also one ready less than an hour ago. Such a
-- closure is recorded with the reason StoreClosing and the instant the day's service ended
-- (closing_from, read from the Store's published hours when it is recorded); it can only be
-- recorded at or after that instant. The ordinary closure keeps its one-hour hold. Old rows are
-- unchanged (reason NotCollected, no closing_from). Still append-only; no refund. No grants: the
-- api already inserts and reads this table.
ALTER TABLE rms_fulfillment.pickup_not_collected_record
  ADD COLUMN closing_from timestamp with time zone NULL
    CHECK (closing_from = date_trunc('milliseconds', closing_from));
ALTER TABLE rms_fulfillment.pickup_not_collected_record
  DROP CONSTRAINT pickup_not_collected_record_reason_check;
ALTER TABLE rms_fulfillment.pickup_not_collected_record
  ADD CONSTRAINT pickup_not_collected_record_reason_check
    CHECK (reason IN ('NotCollected', 'StoreClosing'));
ALTER TABLE rms_fulfillment.pickup_not_collected_record
  DROP CONSTRAINT pickup_not_collected_record_hold_check;
ALTER TABLE rms_fulfillment.pickup_not_collected_record
  ADD CONSTRAINT pickup_not_collected_record_hold_check CHECK (
    (reason = 'NotCollected' AND closing_from IS NULL AND closed_at >= ready_at + interval '1 hour')
    OR (reason = 'StoreClosing' AND closing_from IS NOT NULL AND closed_at >= closing_from)
  );
