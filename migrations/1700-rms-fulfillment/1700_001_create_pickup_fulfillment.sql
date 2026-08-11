-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA rms_fulfillment;
REVOKE ALL ON SCHEMA rms_fulfillment FROM PUBLIC;

CREATE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'fulfillment record is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.reject_fulfillment_append_only_update() FROM PUBLIC;

CREATE TABLE rms_fulfillment.fulfillment (
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  confirmation_id platform_helpers.uuid_v7 NOT NULL,
  source_event_id platform_helpers.uuid_v7 NOT NULL,
  source_aggregate_version bigint NOT NULL CHECK (source_aggregate_version > 0),
  source_snapshot_digest text NOT NULL CHECK (source_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_evidence_id platform_helpers.uuid_v7 NOT NULL,
  source_evidence_version integer NOT NULL CHECK (source_evidence_version = 1),
  source_evidence_digest text NOT NULL CHECK (source_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  fulfillment_type text NOT NULL CHECK (fulfillment_type = 'Pickup'),
  canonical_phase text NOT NULL CHECK (canonical_phase = 'Pending'),
  aggregate_version bigint NOT NULL CHECK (aggregate_version = 1),
  created_at timestamp with time zone NOT NULL,
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT fulfillment_pkey PRIMARY KEY (brand_id, store_id, fulfillment_id),
  CONSTRAINT fulfillment_order_unique UNIQUE (brand_id, store_id, order_id),
  CONSTRAINT fulfillment_confirmation_unique UNIQUE (brand_id, store_id, confirmation_id),
  CONSTRAINT fulfillment_source_event_unique UNIQUE (brand_id, store_id, source_event_id)
);

CREATE TABLE rms_fulfillment.fulfillment_item (
  fulfillment_item_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  order_item_id platform_helpers.uuid_v7 NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  ordered_quantity integer NOT NULL CHECK (ordered_quantity BETWEEN 1 AND 999),
  ready_quantity integer NOT NULL CHECK (ready_quantity = 0),
  handed_over_quantity integer NOT NULL CHECK (handed_over_quantity = 0),
  item_state text NOT NULL CHECK (item_state = 'Pending'),
  source_line_digest text NOT NULL CHECK (source_line_digest ~ '^sha256:[0-9a-f]{64}$'),
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT fulfillment_item_pkey PRIMARY KEY (brand_id, store_id, fulfillment_item_id),
  CONSTRAINT fulfillment_item_parent_fkey FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT fulfillment_item_order_item_unique
    UNIQUE (brand_id, store_id, fulfillment_id, order_item_id),
  CONSTRAINT fulfillment_item_ordinal_unique
    UNIQUE (brand_id, store_id, fulfillment_id, ordinal)
);

CREATE TABLE rms_fulfillment.fulfillment_creation_operation (
  fulfillment_creation_operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  source_event_id platform_helpers.uuid_v7 NOT NULL,
  confirmation_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  source_evidence_digest text NOT NULL CHECK (source_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  semantic_binding_digest text NOT NULL CHECK (semantic_binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT fulfillment_creation_operation_pkey
    PRIMARY KEY (brand_id, store_id, fulfillment_creation_operation_id),
  CONSTRAINT fulfillment_creation_operation_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT fulfillment_creation_operation_order_unique UNIQUE (brand_id, store_id, order_id),
  CONSTRAINT fulfillment_creation_operation_confirmation_unique
    UNIQUE (brand_id, store_id, confirmation_id),
  CONSTRAINT fulfillment_creation_operation_event_unique UNIQUE (brand_id, store_id, source_event_id)
);

CREATE INDEX fulfillment_created_history_idx
  ON rms_fulfillment.fulfillment (brand_id, store_id, created_at, fulfillment_id);
CREATE INDEX fulfillment_item_parent_idx
  ON rms_fulfillment.fulfillment_item (brand_id, store_id, fulfillment_id, ordinal);
CREATE INDEX fulfillment_creation_operation_history_idx
  ON rms_fulfillment.fulfillment_creation_operation (
    brand_id, store_id, occurred_at, fulfillment_creation_operation_id
  );

CREATE TRIGGER fulfillment_no_update_trigger
  BEFORE UPDATE ON rms_fulfillment.fulfillment
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE fulfillment_no_delete AS
  ON DELETE TO rms_fulfillment.fulfillment DO INSTEAD NOTHING;
CREATE TRIGGER fulfillment_item_no_update_trigger
  BEFORE UPDATE ON rms_fulfillment.fulfillment_item
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE fulfillment_item_no_delete AS
  ON DELETE TO rms_fulfillment.fulfillment_item DO INSTEAD NOTHING;
CREATE TRIGGER fulfillment_creation_operation_no_update_trigger
  BEFORE UPDATE ON rms_fulfillment.fulfillment_creation_operation
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE fulfillment_creation_operation_no_delete AS
  ON DELETE TO rms_fulfillment.fulfillment_creation_operation DO INSTEAD NOTHING;

ALTER TABLE rms_fulfillment.fulfillment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.fulfillment FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.fulfillment_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.fulfillment_item FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.fulfillment_creation_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.fulfillment_creation_operation FORCE ROW LEVEL SECURITY;

CREATE POLICY fulfillment_store_scope_policy ON rms_fulfillment.fulfillment
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY fulfillment_item_store_scope_policy ON rms_fulfillment.fulfillment_item
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY fulfillment_creation_operation_store_scope_policy
  ON rms_fulfillment.fulfillment_creation_operation
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());

REVOKE ALL ON TABLE rms_fulfillment.fulfillment FROM PUBLIC;
REVOKE ALL ON TABLE rms_fulfillment.fulfillment_item FROM PUBLIC;
REVOKE ALL ON TABLE rms_fulfillment.fulfillment_creation_operation FROM PUBLIC;
