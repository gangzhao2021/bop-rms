-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (defect found 2026-10-17; Owner standing approval 2026-10-14): DEC-PILOT-BATCH-PHASE-01
-- merges Kitchen preparation into the Order phase. Ordering keeps its own append-only inbox record of
-- the Kitchen facts it consumed (started, ready, Batch ready, stale ticket closed as made / not made),
-- one row per fact of one published event; it never reads Kitchen tables. No actor or personal data.
CREATE TABLE rms_ordering.order_kitchen_progress_fact (
  source_event_id platform_helpers.uuid_v7 NOT NULL,
  fact_ordinal integer NOT NULL CHECK (fact_ordinal BETWEEN 0 AND 99),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  order_item_id platform_helpers.uuid_v7,
  source_event_type text NOT NULL CHECK (
    source_event_type IN ('KitchenWorkStarted','KitchenItemReady','KitchenOrderReady','KitchenTicketClosed')
  ),
  fact_kind text NOT NULL CHECK (fact_kind IN ('Started','Ready','BatchReady','Made','NotMade')),
  occurred_at timestamp with time zone NOT NULL CHECK (isfinite(occurred_at)),
  recorded_at timestamp with time zone NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (source_event_id, fact_ordinal),
  CHECK ((fact_kind = 'BatchReady') = (order_item_id IS NULL)),
  CHECK (
    (source_event_type = 'KitchenWorkStarted' AND fact_kind = 'Started')
    OR (source_event_type = 'KitchenItemReady' AND fact_kind = 'Ready')
    OR (source_event_type = 'KitchenOrderReady' AND fact_kind = 'BatchReady')
    OR (source_event_type = 'KitchenTicketClosed' AND fact_kind IN ('Made','NotMade'))
  ),
  CHECK (fact_ordinal = 0 OR source_event_type = 'KitchenTicketClosed'),
  FOREIGN KEY (order_batch_id, order_id, brand_id, store_id)
    REFERENCES rms_ordering.order_batch (order_batch_id, order_id, brand_id, store_id),
  FOREIGN KEY (order_item_id, order_batch_id, order_id, brand_id, store_id)
    REFERENCES rms_ordering.order_item (order_item_id, order_batch_id, order_id, brand_id, store_id)
);

CREATE RULE order_kitchen_progress_fact_no_update AS
  ON UPDATE TO rms_ordering.order_kitchen_progress_fact DO INSTEAD NOTHING;
CREATE RULE order_kitchen_progress_fact_no_delete AS
  ON DELETE TO rms_ordering.order_kitchen_progress_fact DO INSTEAD NOTHING;

CREATE INDEX order_kitchen_progress_fact_order_idx
  ON rms_ordering.order_kitchen_progress_fact (brand_id, store_id, order_id);

ALTER TABLE rms_ordering.order_kitchen_progress_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_kitchen_progress_fact FORCE ROW LEVEL SECURITY;
CREATE POLICY order_kitchen_progress_fact_store_scope_policy
  ON rms_ordering.order_kitchen_progress_fact
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_kitchen_progress_fact FROM PUBLIC;
