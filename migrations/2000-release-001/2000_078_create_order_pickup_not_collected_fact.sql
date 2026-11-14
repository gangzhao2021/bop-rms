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
-- merges a pickup closed as not collected into the Order phase as a terminal outcome. Ordering keeps
-- its own append-only inbox record of the Fulfillment PickupNotCollected event it consumed
-- (ordering.pickup-not-collected:v1), one row per Order; it never reads Fulfillment tables.
-- No actor or personal data.
CREATE TABLE rms_ordering.order_pickup_not_collected_fact (
  source_event_id platform_helpers.uuid_v7 NOT NULL PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  not_collected_id platform_helpers.uuid_v7 NOT NULL,
  closed_at timestamp with time zone NOT NULL CHECK (isfinite(closed_at)),
  recorded_at timestamp with time zone NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT order_pickup_not_collected_fact_order_unique UNIQUE (brand_id, store_id, order_id),
  FOREIGN KEY (order_id, brand_id, store_id)
    REFERENCES rms_ordering.order_header (order_id, brand_id, store_id)
);

CREATE RULE order_pickup_not_collected_fact_no_update AS
  ON UPDATE TO rms_ordering.order_pickup_not_collected_fact DO INSTEAD NOTHING;
CREATE RULE order_pickup_not_collected_fact_no_delete AS
  ON DELETE TO rms_ordering.order_pickup_not_collected_fact DO INSTEAD NOTHING;

ALTER TABLE rms_ordering.order_pickup_not_collected_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_pickup_not_collected_fact FORCE ROW LEVEL SECURITY;
CREATE POLICY order_pickup_not_collected_fact_store_scope_policy
  ON rms_ordering.order_pickup_not_collected_fact
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_pickup_not_collected_fact FROM PUBLIC;
