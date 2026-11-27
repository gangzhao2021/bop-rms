-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423: a ready pickup order that nobody collected within the pickup hold (one hour after it was
-- ready, with no valid pickup code) is closed by an authorized staff member as not collected. The
-- closure is a single append-only fact per fulfillment naming the staff member; it removes the order
-- from the pickup queue and refuses any later handoff or code. It does not refund: a refund, when the
-- Store grants one, goes through the ordinary refund workflow.
CREATE TABLE rms_fulfillment.pickup_not_collected_record (
  pickup_not_collected_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  reason text NOT NULL CHECK (reason = 'NotCollected'),
  ready_at timestamp with time zone NOT NULL,
  closed_at timestamp with time zone NOT NULL
    CHECK (closed_at = date_trunc('milliseconds', closed_at)),
  idempotency_id platform_helpers.uuid_v7 NOT NULL,
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  aggregate_version_before bigint NOT NULL CHECK (aggregate_version_before > 0),
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT pickup_not_collected_record_pkey
    PRIMARY KEY (brand_id, store_id, pickup_not_collected_id),
  CONSTRAINT pickup_not_collected_record_fulfillment_unique
    UNIQUE (brand_id, store_id, fulfillment_id),
  CONSTRAINT pickup_not_collected_record_idempotency_unique
    UNIQUE (brand_id, store_id, idempotency_id),
  CONSTRAINT pickup_not_collected_record_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT pickup_not_collected_record_hold_check
    CHECK (closed_at >= ready_at + interval '1 hour'),
  CONSTRAINT pickup_not_collected_record_distinct_check CHECK (
    pickup_not_collected_id::uuid <> idempotency_id::uuid
    AND pickup_not_collected_id::uuid <> correlation_id::uuid
    AND idempotency_id::uuid <> correlation_id::uuid
  )
);
CREATE TRIGGER pickup_not_collected_record_no_update_trigger BEFORE UPDATE
  ON rms_fulfillment.pickup_not_collected_record FOR EACH ROW
  EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE pickup_not_collected_record_no_delete AS
  ON DELETE TO rms_fulfillment.pickup_not_collected_record DO INSTEAD NOTHING;
ALTER TABLE rms_fulfillment.pickup_not_collected_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_not_collected_record FORCE ROW LEVEL SECURITY;
CREATE POLICY pickup_not_collected_record_store_scope_policy
  ON rms_fulfillment.pickup_not_collected_record
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_fulfillment.pickup_not_collected_record FROM PUBLIC;
