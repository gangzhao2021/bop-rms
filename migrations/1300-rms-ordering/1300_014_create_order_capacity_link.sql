-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_capacity_link (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 submission_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 commitment_id platform_helpers.uuid_v7 NOT NULL,
 payment_operation_id platform_helpers.uuid_v7 NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at)),
 link_json jsonb NOT NULL,
 CONSTRAINT order_capacity_link_pk PRIMARY KEY (brand_id,store_id,submission_id),
 CONSTRAINT order_capacity_link_commitment_once UNIQUE (brand_id,store_id,commitment_id),
 CONSTRAINT order_capacity_link_payment_once UNIQUE (brand_id,store_id,payment_operation_id),
 CONSTRAINT order_capacity_link_submission_fk FOREIGN KEY (submission_id,brand_id,store_id,order_id)
 REFERENCES rms_ordering.order_submission_record(submission_id,brand_id,store_id,order_id),
 CONSTRAINT order_capacity_link_batch_fk FOREIGN KEY (order_batch_id,order_id,brand_id,store_id)
 REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id),
 CONSTRAINT order_capacity_link_shape CHECK ((
  jsonb_typeof(link_json)='object' AND octet_length(link_json::text)<=16384
  AND link_json ?& ARRAY['commitmentReference','ownerContextReference','brandReference','storeReference','orderReference','orderBatchReference','submissionReference','cartReference','quoteReference','guestSessionReference','paymentOperationReference','owner','commitmentVersion','cartVersion','ownerIntentDigest','ownerSnapshotDigest','preparedAt','validUntil']
  AND link_json - ARRAY['commitmentReference','ownerContextReference','brandReference','storeReference','orderReference','orderBatchReference','submissionReference','cartReference','quoteReference','guestSessionReference','paymentOperationReference','owner','commitmentVersion','cartVersion','ownerIntentDigest','ownerSnapshotDigest','preparedAt','validUntil']='{}'::jsonb
  AND link_json->>'commitmentReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'ownerContextReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'brandReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'storeReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'orderReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'orderBatchReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'submissionReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'cartReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'quoteReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'guestSessionReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'paymentOperationReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND link_json->>'brandReference'=brand_id::text
  AND link_json->>'storeReference'=store_id::text
  AND link_json->>'submissionReference'=submission_id::text
  AND link_json->>'orderReference'=order_id::text
  AND link_json->>'orderBatchReference'=order_batch_id::text
  AND link_json->>'commitmentReference'=commitment_id::text
  AND link_json->>'paymentOperationReference'=payment_operation_id::text
  AND link_json->>'owner'='Dining' AND link_json->'commitmentVersion'='1'::jsonb
  AND jsonb_typeof(link_json->'cartVersion')='number'
  AND (link_json->>'cartVersion')::numeric BETWEEN 1 AND 9007199254740991
  AND (link_json->>'cartVersion')::numeric=trunc((link_json->>'cartVersion')::numeric)
  AND link_json->>'ownerIntentDigest' ~ '^sha256:[0-9a-f]{64}$'
  AND link_json->>'ownerSnapshotDigest' ~ '^sha256:[0-9a-f]{64}$'
  AND link_json->>'preparedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND link_json->>'validUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND (link_json->>'preparedAt')::timestamptz <= created_at
  AND created_at < (link_json->>'validUntil')::timestamptz
 ) IS TRUE)
);
CREATE RULE order_capacity_link_no_update AS ON UPDATE TO rms_ordering.order_capacity_link DO INSTEAD NOTHING;
CREATE RULE order_capacity_link_no_delete AS ON DELETE TO rms_ordering.order_capacity_link DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.order_capacity_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_capacity_link FORCE ROW LEVEL SECURITY;
CREATE POLICY order_capacity_link_scope_policy ON rms_ordering.order_capacity_link
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_capacity_link FROM PUBLIC;
