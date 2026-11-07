-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_ordering.cart_quote_attachment
  DROP CONSTRAINT cart_quote_attachment_quote_version_check,
  ADD CONSTRAINT cart_quote_attachment_quote_version_check CHECK (quote_version IN (1, 2));
