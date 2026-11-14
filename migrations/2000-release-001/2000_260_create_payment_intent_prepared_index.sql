-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 M160: the sales reports and the day-end settlement begin at the Store's first business
-- day, and refuse when a payment of the Store was prepared before that day began (it would be in
-- no day). This index answers that check from the Store's earliest payment instead of reading
-- every payment the Store ever took on each report and settlement read.
CREATE INDEX payment_intent_store_prepared_idx
  ON rms_payment.payment_intent (brand_id, store_id, prepared_at);
