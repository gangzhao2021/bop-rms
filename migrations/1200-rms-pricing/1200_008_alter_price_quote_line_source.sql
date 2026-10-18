-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_pricing.price_quote_line
  ADD COLUMN source_cart_line_id platform_helpers.uuid_v7;

ALTER TABLE rms_pricing.price_quote_line
  ADD CONSTRAINT price_quote_line_source_unique
  UNIQUE (price_quote_id, brand_id, store_id, source_cart_line_id);
