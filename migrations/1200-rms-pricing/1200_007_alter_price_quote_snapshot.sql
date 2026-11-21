-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_pricing.price_quote
  ADD COLUMN complete_snapshot_text text;

ALTER TABLE rms_pricing.price_quote
  ADD CONSTRAINT price_quote_complete_snapshot_check CHECK (
    complete_snapshot_text IS NULL OR (
      octet_length(complete_snapshot_text) BETWEEN 2 AND 16777216
      AND jsonb_typeof(complete_snapshot_text::jsonb) = 'object'
      AND complete_snapshot_text::jsonb -> 'codecVersion' = '1'::jsonb
      AND jsonb_typeof(complete_snapshot_text::jsonb -> 'snapshot') = 'object'
    ) IS TRUE
  );
