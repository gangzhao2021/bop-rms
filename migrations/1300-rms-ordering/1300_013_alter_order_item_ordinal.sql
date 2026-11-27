-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Legacy order rows retain unknown ordinals; never invent ordering by UUID or backfill history.
ALTER TABLE rms_ordering.order_item
  ADD COLUMN ordinal integer,
  ADD CONSTRAINT order_item_ordinal_check CHECK (ordinal IS NULL OR ordinal BETWEEN 1 AND 100),
  ADD CONSTRAINT order_item_batch_ordinal_unique
    UNIQUE (brand_id, store_id, order_batch_id, ordinal);
