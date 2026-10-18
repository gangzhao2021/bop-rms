-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.checkout_details_record (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  details_id platform_helpers.uuid_v7 NOT NULL,
  details_version integer NOT NULL CHECK (details_version > 0),
  operation_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (brand_id, store_id, details_id, details_version),
  UNIQUE (brand_id, store_id, operation_id),
  UNIQUE (brand_id, store_id, cart_id, guest_session_id, details_version),
  FOREIGN KEY (cart_id, brand_id, store_id) REFERENCES rms_ordering.cart (cart_id, brand_id, store_id),
  CHECK (snapshot_json->>'brandReference' = brand_id::text),
  CHECK (snapshot_json->>'storeReference' = store_id::text),
  CHECK (snapshot_json->>'detailsReference' = details_id::text),
  CHECK (snapshot_json->>'detailsVersion' = details_version::text),
  CHECK (snapshot_json->>'guestSessionReference' = guest_session_id::text),
  CHECK (snapshot_json->>'cartReference' = cart_id::text),
  CHECK (snapshot_json ?& ARRAY['brandReference','storeReference','detailsReference','detailsVersion','guestSessionReference','cartReference','recordedAt']),
  CHECK (isfinite(recorded_at) AND recorded_at = date_trunc('milliseconds', recorded_at))
);
CREATE RULE checkout_details_no_update AS ON UPDATE TO rms_ordering.checkout_details_record DO INSTEAD NOTHING;
CREATE RULE checkout_details_no_delete AS ON DELETE TO rms_ordering.checkout_details_record DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.checkout_details_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.checkout_details_record FORCE ROW LEVEL SECURITY;
CREATE POLICY checkout_details_scope ON rms_ordering.checkout_details_record
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.checkout_details_record FROM PUBLIC;
