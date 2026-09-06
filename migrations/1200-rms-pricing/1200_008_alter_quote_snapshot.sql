-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Legacy immutable rows remain null: incomplete evidence must never be guessed.
ALTER TABLE rms_pricing.price_quote ADD COLUMN snapshot_json jsonb
  CHECK (snapshot_json IS NULL OR (
    jsonb_typeof(snapshot_json) = 'object'
    AND snapshot_json -> 'version' = '1'::jsonb
    AND jsonb_typeof(snapshot_json -> 'snapshot') = 'object'
    AND snapshot_json - 'version' - 'snapshot' = '{}'::jsonb
    AND snapshot_json -> 'snapshot' ->> 'quoteReference' = price_quote_id::text
    AND snapshot_json -> 'snapshot' ->> 'brandReference' = brand_id::text
    AND snapshot_json -> 'snapshot' ->> 'storeReference' = store_id::text
  ) IS TRUE);
