-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (v15 sim M131): cash given back at a table is handed over in whole nickels, the way the
-- table paid it (Canada has had no pennies since 2013). The screen rounds the amount (1-2 cents
-- down, 3-4 up) and says "Hand over $X (rounded to 5¢)", and the cash refund command refuses any
-- other amount; the database holds the same rule for every new refund. NOT VALID: the two refunds
-- already recorded on v15 with an odd cent amount stay exactly as they were (history is
-- append-only). No grants.
ALTER TABLE rms_payment.dining_table_cash_refund
  ADD CONSTRAINT dining_table_cash_refund_nickel CHECK (amount_minor % 5 = 0) NOT VALID;
