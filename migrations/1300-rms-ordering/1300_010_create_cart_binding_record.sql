-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.cart_binding_record (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  revision integer NOT NULL CHECK (revision IN (1, 2)),
  prior_revision integer GENERATED ALWAYS AS (NULLIF(revision - 1, 0)) STORED,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  predecessor_session_id platform_helpers.uuid_v7 NOT NULL,
  acknowledged_at timestamp with time zone NOT NULL,
  prepared_at timestamp with time zone NOT NULL,
  valid_until timestamp with time zone NOT NULL,
  activated_at timestamp with time zone,
  PRIMARY KEY (operation_id, revision),
  CONSTRAINT cart_binding_cart_fk FOREIGN KEY (cart_id, brand_id, store_id)
    REFERENCES rms_ordering.cart (cart_id, brand_id, store_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT cart_binding_lineage_unique UNIQUE
    (operation_id, revision, brand_id, store_id, cart_id, guest_session_id,
     predecessor_session_id, acknowledged_at, prepared_at, valid_until),
  CONSTRAINT cart_binding_prior_fk FOREIGN KEY
    (operation_id, prior_revision, brand_id, store_id, cart_id, guest_session_id,
     predecessor_session_id, acknowledged_at, prepared_at, valid_until)
    REFERENCES rms_ordering.cart_binding_record
    (operation_id, revision, brand_id, store_id, cart_id, guest_session_id,
     predecessor_session_id, acknowledged_at, prepared_at, valid_until),
  CONSTRAINT cart_binding_time_check CHECK (
    guest_session_id <> predecessor_session_id
    AND acknowledged_at <= prepared_at AND prepared_at < valid_until
    AND valid_until <= acknowledged_at + interval '15 minutes'
    AND ((revision = 1 AND activated_at IS NULL)
      OR (revision = 2 AND activated_at IS NOT NULL
        AND activated_at >= prepared_at AND activated_at < valid_until))
  )
);

CREATE UNIQUE INDEX cart_binding_target_unique ON rms_ordering.cart_binding_record (cart_id)
  WHERE revision = 1;
CREATE UNIQUE INDEX cart_binding_candidate_unique
  ON rms_ordering.cart_binding_record (guest_session_id) WHERE revision = 1;
CREATE UNIQUE INDEX cart_binding_active_predecessor_unique
  ON rms_ordering.cart_binding_record (predecessor_session_id) WHERE revision = 2;
CREATE INDEX cart_binding_current_idx
  ON rms_ordering.cart_binding_record (brand_id, store_id, guest_session_id) WHERE revision = 2;

CREATE FUNCTION rms_ordering.reject_cart_binding_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'append-only binding history' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_cart_binding_mutation() FROM PUBLIC;
CREATE TRIGGER cart_binding_no_mutation BEFORE UPDATE OR DELETE
  ON rms_ordering.cart_binding_record FOR EACH ROW
  EXECUTE FUNCTION rms_ordering.reject_cart_binding_mutation();
CREATE TRIGGER cart_binding_no_truncate BEFORE TRUNCATE
  ON rms_ordering.cart_binding_record FOR EACH STATEMENT
  EXECUTE FUNCTION rms_ordering.reject_cart_binding_mutation();
ALTER TABLE rms_ordering.cart_binding_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart_binding_record FORCE ROW LEVEL SECURITY;
CREATE POLICY cart_binding_scope_policy ON rms_ordering.cart_binding_record
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.cart_binding_record FROM PUBLIC;
