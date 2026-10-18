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
  DROP CONSTRAINT price_quote_quote_version_check,
  ADD CONSTRAINT price_quote_quote_version_check CHECK (quote_version IN (1, 2)),
  DROP CONSTRAINT price_quote_complete_snapshot_check,
  ADD CONSTRAINT price_quote_complete_snapshot_check CHECK (
    (quote_version = 1 AND complete_snapshot_text IS NULL) OR (
      complete_snapshot_text IS NOT NULL
      AND octet_length(complete_snapshot_text) BETWEEN 2 AND 16777216
      AND jsonb_typeof(complete_snapshot_text::jsonb) = 'object'
      AND complete_snapshot_text::jsonb -> 'codecVersion' = to_jsonb(quote_version)
      AND jsonb_typeof(complete_snapshot_text::jsonb -> 'snapshot') = 'object'
      AND (quote_version = 1 OR
        complete_snapshot_text::jsonb -> 'snapshot' -> 'quoteVersion' = '2'::jsonb)
    ) IS TRUE
  );
