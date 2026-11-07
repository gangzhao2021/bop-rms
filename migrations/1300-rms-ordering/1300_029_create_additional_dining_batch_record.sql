-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Preserve order_submission_order_unique until complete submission composition.
CREATE TABLE rms_ordering.additional_dining_batch_record (
  submission_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  batch_sequence integer NOT NULL CHECK (batch_sequence >= 2),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object'),
  UNIQUE (order_id,brand_id,store_id,batch_sequence),
  UNIQUE (order_batch_id,order_id,brand_id,store_id),
  FOREIGN KEY (submission_id,brand_id,store_id,order_id)
    REFERENCES rms_ordering.order_submission_record(submission_id,brand_id,store_id,order_id),
  FOREIGN KEY (order_batch_id,order_id,brand_id,store_id)
    REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id),
  FOREIGN KEY (submission_id) REFERENCES rms_ordering.order_revision(revision_id)
);
CREATE RULE additional_dining_batch_no_update AS ON UPDATE TO rms_ordering.additional_dining_batch_record DO INSTEAD NOTHING;
CREATE RULE additional_dining_batch_no_delete AS ON DELETE TO rms_ordering.additional_dining_batch_record DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.additional_dining_batch_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.additional_dining_batch_record FORCE ROW LEVEL SECURITY;
CREATE POLICY additional_dining_batch_scope ON rms_ordering.additional_dining_batch_record
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.additional_dining_batch_record FROM PUBLIC;
