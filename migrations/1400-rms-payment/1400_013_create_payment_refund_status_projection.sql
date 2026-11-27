-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.payment_refund_status_projection (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  refund_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=65536),
  PRIMARY KEY (brand_id,store_id,refund_id),
  FOREIGN KEY (brand_id,store_id,refund_id)
    REFERENCES rms_payment.payment_compensation_refund (brand_id,store_id,refund_id),
  CHECK (
    (record_json->>'tenantId') IS NOT DISTINCT FROM brand_id::text AND
    (record_json->>'storeId') IS NOT DISTINCT FROM store_id::text AND
    (record_json->>'eventId') IS NOT DISTINCT FROM event_id::text AND
    (record_json->'payload'->>'refundReference') IS NOT DISTINCT FROM refund_id::text AND
    (record_json->'payload'->>'orderReference') IS NOT DISTINCT FROM order_id::text AND
    (record_json->>'eventType') IS NOT DISTINCT FROM 'PaymentRefunded'
  )
);
CREATE INDEX payment_refund_status_order_idx ON rms_payment.payment_refund_status_projection (brand_id,store_id,order_id);
CREATE RULE payment_refund_status_no_update AS ON UPDATE TO rms_payment.payment_refund_status_projection DO INSTEAD NOTHING;
CREATE RULE payment_refund_status_no_delete AS ON DELETE TO rms_payment.payment_refund_status_projection DO INSTEAD NOTHING;
ALTER TABLE rms_payment.payment_refund_status_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_refund_status_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_refund_status_scope_policy ON rms_payment.payment_refund_status_projection
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.payment_refund_status_projection FROM PUBLIC;
