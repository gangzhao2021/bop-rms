-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_status_projection_generation (
  generation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  projection_name text NOT NULL CHECK (projection_name = 'ordering_order_status_v1'),
  projection_version integer NOT NULL CHECK (projection_version = 1),
  source_version integer NOT NULL CHECK (source_version > 0),
  source_checkpoint platform_helpers.uuid_v7 NOT NULL,
  projected_at timestamp with time zone NOT NULL,
  freshness_status text NOT NULL CHECK (freshness_status IN ('Fresh','Stale','Rebuilding','Failed')),
  customer_guest_session_id platform_helpers.uuid_v7 NOT NULL,
  order_number text NOT NULL CHECK (order_number ~ '^[1-9][0-9]{0,18}$'),
  submitted_at timestamp with time zone NOT NULL,
  projection_snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(projection_snapshot_json) = 'object'),
  CONSTRAINT order_status_generation_scope_identity_unique
    UNIQUE (generation_id, order_id, brand_id, store_id),
  CONSTRAINT order_status_generation_complete_identity_unique
    UNIQUE (generation_id, order_id, brand_id, store_id, source_version, source_checkpoint),
  CONSTRAINT order_status_generation_source_unique
    UNIQUE (order_id, brand_id, store_id, source_version),
  CONSTRAINT order_status_generation_checkpoint_unique
    UNIQUE (order_id, brand_id, store_id, source_checkpoint),
  CONSTRAINT order_status_generation_source_fk
    FOREIGN KEY (order_id, brand_id, store_id)
    REFERENCES rms_ordering.order_header (order_id, brand_id, store_id)
);

CREATE TABLE rms_ordering.order_status_projection (
  order_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  generation_id platform_helpers.uuid_v7 NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  source_checkpoint platform_helpers.uuid_v7 NOT NULL,
  projected_at timestamp with time zone NOT NULL,
  CONSTRAINT order_status_projection_scope_identity_unique UNIQUE (order_id, brand_id, store_id),
  CONSTRAINT order_status_projection_generation_fk
    FOREIGN KEY (generation_id, order_id, brand_id, store_id, source_version, source_checkpoint)
    REFERENCES rms_ordering.order_status_projection_generation
      (generation_id, order_id, brand_id, store_id, source_version, source_checkpoint)
);

CREATE RULE order_status_generation_no_update AS
  ON UPDATE TO rms_ordering.order_status_projection_generation DO INSTEAD NOTHING;
CREATE RULE order_status_generation_no_delete AS
  ON DELETE TO rms_ordering.order_status_projection_generation DO INSTEAD NOTHING;

CREATE FUNCTION rms_ordering.enforce_order_status_projection_advance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
     OR NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.source_version <= OLD.source_version THEN
    RAISE EXCEPTION 'order status projection must advance monotonically'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION rms_ordering.enforce_order_status_projection_advance() FROM PUBLIC;

CREATE TRIGGER enforce_order_status_projection_advance
BEFORE UPDATE ON rms_ordering.order_status_projection
FOR EACH ROW EXECUTE FUNCTION rms_ordering.enforce_order_status_projection_advance();

CREATE INDEX order_status_projection_store_submitted_idx
  ON rms_ordering.order_status_projection_generation
    (brand_id, store_id, submitted_at DESC, order_id);
CREATE INDEX order_status_projection_store_number_idx
  ON rms_ordering.order_status_projection_generation
    (brand_id, store_id, order_number);
CREATE INDEX order_status_projection_guest_idx
  ON rms_ordering.order_status_projection_generation
    (brand_id, store_id, customer_guest_session_id, order_id);

ALTER TABLE rms_ordering.order_status_projection_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_status_projection_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_status_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_status_projection FORCE ROW LEVEL SECURITY;

CREATE POLICY order_status_projection_generation_store_scope_policy
  ON rms_ordering.order_status_projection_generation
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY order_status_projection_store_scope_policy
  ON rms_ordering.order_status_projection
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());

REVOKE ALL ON TABLE rms_ordering.order_status_projection_generation FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.order_status_projection FROM PUBLIC;
