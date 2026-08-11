-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_fulfillment.fulfillment_item_ready_result (
  fulfillment_item_ready_result_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_item_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  order_item_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_ready_result_id platform_helpers.uuid_v7 NOT NULL,
  source_event_id platform_helpers.uuid_v7 NOT NULL,
  ready_quantity integer NOT NULL CHECK (ready_quantity BETWEEN 1 AND 999),
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT fulfillment_item_ready_result_pkey
    PRIMARY KEY (brand_id, store_id, fulfillment_item_ready_result_id),
  CONSTRAINT fulfillment_item_ready_result_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT fulfillment_item_ready_result_item_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_item_id)
    REFERENCES rms_fulfillment.fulfillment_item (brand_id, store_id, fulfillment_item_id),
  CONSTRAINT fulfillment_item_ready_result_item_unique
    UNIQUE (brand_id, store_id, fulfillment_id, fulfillment_item_id),
  CONSTRAINT fulfillment_item_ready_result_order_item_unique
    UNIQUE (brand_id, store_id, fulfillment_id, order_item_id),
  CONSTRAINT fulfillment_item_ready_result_kitchen_unique
    UNIQUE (brand_id, store_id, kitchen_ready_result_id),
  CONSTRAINT fulfillment_item_ready_result_event_unique
    UNIQUE (brand_id, store_id, source_event_id),
  CONSTRAINT fulfillment_item_ready_result_distinct_check CHECK (
    fulfillment_item_ready_result_id <> fulfillment_id
    AND fulfillment_item_ready_result_id <> fulfillment_item_id
    AND fulfillment_item_ready_result_id <> kitchen_ticket_id
    AND fulfillment_item_ready_result_id <> kitchen_ready_result_id
    AND fulfillment_item_ready_result_id <> source_event_id
    AND kitchen_ready_result_id <> source_event_id
  )
);

CREATE TABLE rms_fulfillment.fulfillment_ready_operation (
  fulfillment_ready_operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_item_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_item_ready_result_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_ready_result_id platform_helpers.uuid_v7 NOT NULL,
  source_event_id platform_helpers.uuid_v7 NOT NULL,
  aggregate_version_before bigint NOT NULL CHECK (aggregate_version_before > 0),
  aggregate_version_after bigint NOT NULL CHECK (
    aggregate_version_after = aggregate_version_before + 1
  ),
  phase_before text NOT NULL CHECK (phase_before IN ('Pending', 'Ready')),
  phase_after text NOT NULL CHECK (phase_after IN ('Pending', 'Ready')),
  semantic_binding_digest text NOT NULL CHECK (
    semantic_binding_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT fulfillment_ready_operation_pkey
    PRIMARY KEY (brand_id, store_id, fulfillment_ready_operation_id),
  CONSTRAINT fulfillment_ready_operation_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT fulfillment_ready_operation_item_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_item_id)
    REFERENCES rms_fulfillment.fulfillment_item (brand_id, store_id, fulfillment_item_id),
  CONSTRAINT fulfillment_ready_operation_result_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_item_ready_result_id)
    REFERENCES rms_fulfillment.fulfillment_item_ready_result (
      brand_id,
      store_id,
      fulfillment_item_ready_result_id
    ),
  CONSTRAINT fulfillment_ready_operation_result_unique
    UNIQUE (brand_id, store_id, fulfillment_item_ready_result_id),
  CONSTRAINT fulfillment_ready_operation_kitchen_unique
    UNIQUE (brand_id, store_id, kitchen_ready_result_id),
  CONSTRAINT fulfillment_ready_operation_event_unique
    UNIQUE (brand_id, store_id, source_event_id),
  CONSTRAINT fulfillment_ready_operation_version_unique
    UNIQUE (brand_id, store_id, fulfillment_id, aggregate_version_after)
);

CREATE INDEX fulfillment_item_ready_result_history_idx
  ON rms_fulfillment.fulfillment_item_ready_result (
    brand_id,
    store_id,
    fulfillment_id,
    occurred_at,
    fulfillment_item_ready_result_id
  );
CREATE INDEX fulfillment_ready_operation_history_idx
  ON rms_fulfillment.fulfillment_ready_operation (
    brand_id,
    store_id,
    fulfillment_id,
    aggregate_version_after
  );

CREATE TRIGGER fulfillment_item_ready_result_no_update_trigger
  BEFORE UPDATE ON rms_fulfillment.fulfillment_item_ready_result
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE fulfillment_item_ready_result_no_delete AS
  ON DELETE TO rms_fulfillment.fulfillment_item_ready_result DO INSTEAD NOTHING;
CREATE TRIGGER fulfillment_ready_operation_no_update_trigger
  BEFORE UPDATE ON rms_fulfillment.fulfillment_ready_operation
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE fulfillment_ready_operation_no_delete AS
  ON DELETE TO rms_fulfillment.fulfillment_ready_operation DO INSTEAD NOTHING;

ALTER TABLE rms_fulfillment.fulfillment_item_ready_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.fulfillment_item_ready_result FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.fulfillment_ready_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.fulfillment_ready_operation FORCE ROW LEVEL SECURITY;

CREATE POLICY fulfillment_item_ready_result_store_scope_policy
  ON rms_fulfillment.fulfillment_item_ready_result
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY fulfillment_ready_operation_store_scope_policy
  ON rms_fulfillment.fulfillment_ready_operation
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_fulfillment.fulfillment_item_ready_result FROM PUBLIC;
REVOKE ALL ON TABLE rms_fulfillment.fulfillment_ready_operation FROM PUBLIC;
