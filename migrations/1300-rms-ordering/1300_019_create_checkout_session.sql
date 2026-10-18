-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.checkout_session_record (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  checkout_session_id platform_helpers.uuid_v7 NOT NULL,
  create_operation_id platform_helpers.uuid_v7 NOT NULL,
  submission_id platform_helpers.uuid_v7 NOT NULL,
  payment_operation_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (brand_id, store_id, checkout_session_id),
  UNIQUE (brand_id, store_id, create_operation_id),
  UNIQUE (brand_id, store_id, submission_id),
  UNIQUE (brand_id, store_id, payment_operation_id),
  FOREIGN KEY (cart_id, brand_id, store_id)
    REFERENCES rms_ordering.cart (cart_id, brand_id, store_id),
  CHECK (checkout_session_id <> create_operation_id AND checkout_session_id <> submission_id
    AND checkout_session_id <> payment_operation_id AND create_operation_id <> submission_id
    AND create_operation_id <> payment_operation_id AND submission_id <> payment_operation_id),
  CHECK ((snapshot_json->>'schemaVersion') IS NOT DISTINCT FROM '1'),
  CHECK ((snapshot_json->>'checkoutSessionReference') IS NOT DISTINCT FROM checkout_session_id::text),
  CHECK ((snapshot_json->>'createOperationReference') IS NOT DISTINCT FROM create_operation_id::text),
  CHECK ((snapshot_json->>'submissionReference') IS NOT DISTINCT FROM submission_id::text),
  CHECK ((snapshot_json->>'paymentOperationReference') IS NOT DISTINCT FROM payment_operation_id::text),
  CHECK ((snapshot_json#>>'{validation,brandReference}') IS NOT DISTINCT FROM brand_id::text),
  CHECK ((snapshot_json#>>'{validation,storeReference}') IS NOT DISTINCT FROM store_id::text),
  CHECK ((snapshot_json#>>'{validation,guestSessionReference}') IS NOT DISTINCT FROM guest_session_id::text),
  CHECK ((snapshot_json#>>'{validation,cartReference}') IS NOT DISTINCT FROM cart_id::text),
  CHECK ((snapshot_json->>'createdAt') IS NOT DISTINCT FROM
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  CHECK (isfinite(created_at) AND created_at = date_trunc('milliseconds',created_at))
);
CREATE RULE checkout_session_no_update AS ON UPDATE TO rms_ordering.checkout_session_record DO INSTEAD NOTHING;
CREATE RULE checkout_session_no_delete AS ON DELETE TO rms_ordering.checkout_session_record DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.checkout_session_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.checkout_session_record FORCE ROW LEVEL SECURITY;
CREATE POLICY checkout_session_scope ON rms_ordering.checkout_session_record
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.checkout_session_record FROM PUBLIC;
