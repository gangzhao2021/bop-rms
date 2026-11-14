-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (defect found 2026-10-17; Owner standing approval 2026-10-14): DEC-PILOT-BATCH-PHASE-01
-- needs the Order to reach a terminal phase when a ready pickup is closed as not collected. Fulfillment
-- publishes its not-collected closure as the PickupNotCollected event; this append-only record keeps
-- the one outbox event of each closure, so the closure and its event commit together and a closure
-- recorded before the event existed is published exactly once (catch-up). No actor or personal data.
CREATE TABLE rms_fulfillment.pickup_not_collected_publication (
  pickup_not_collected_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  outbox_event_id platform_helpers.uuid_v7 NOT NULL,
  closed_at timestamp with time zone NOT NULL,
  published_at timestamp with time zone NOT NULL DEFAULT statement_timestamp(),
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT pickup_not_collected_publication_pkey
    PRIMARY KEY (brand_id, store_id, pickup_not_collected_id),
  CONSTRAINT pickup_not_collected_publication_record_fkey
    FOREIGN KEY (brand_id, store_id, pickup_not_collected_id)
    REFERENCES rms_fulfillment.pickup_not_collected_record (brand_id, store_id, pickup_not_collected_id),
  CONSTRAINT pickup_not_collected_publication_fulfillment_unique
    UNIQUE (brand_id, store_id, fulfillment_id),
  CONSTRAINT pickup_not_collected_publication_event_unique
    UNIQUE (brand_id, store_id, outbox_event_id),
  CONSTRAINT pickup_not_collected_publication_distinct_check CHECK (
    outbox_event_id::uuid <> pickup_not_collected_id::uuid
    AND outbox_event_id::uuid <> fulfillment_id::uuid
    AND outbox_event_id::uuid <> order_id::uuid
  )
);
CREATE TRIGGER pickup_not_collected_publication_no_update_trigger BEFORE UPDATE
  ON rms_fulfillment.pickup_not_collected_publication FOR EACH ROW
  EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE pickup_not_collected_publication_no_delete AS
  ON DELETE TO rms_fulfillment.pickup_not_collected_publication DO INSTEAD NOTHING;
ALTER TABLE rms_fulfillment.pickup_not_collected_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_not_collected_publication FORCE ROW LEVEL SECURITY;
CREATE POLICY pickup_not_collected_publication_store_scope_policy
  ON rms_fulfillment.pickup_not_collected_publication
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_fulfillment.pickup_not_collected_publication FROM PUBLIC;
