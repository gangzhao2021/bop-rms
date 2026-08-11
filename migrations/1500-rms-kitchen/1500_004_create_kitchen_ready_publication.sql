-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_kitchen.kitchen_ready_publication (
  kitchen_ready_publication_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  order_item_id platform_helpers.uuid_v7 NOT NULL,
  ready_result_id platform_helpers.uuid_v7 NOT NULL,
  ticket_version bigint NOT NULL CHECK (ticket_version > 0),
  ready_quantity integer NOT NULL CHECK (ready_quantity BETWEEN 1 AND 999),
  required_quantity integer NOT NULL CHECK (required_quantity BETWEEN 1 AND 999),
  ticket_item_count integer NOT NULL CHECK (ticket_item_count BETWEEN 1 AND 100),
  item_outbox_event_id platform_helpers.uuid_v7 NOT NULL,
  item_event_semantic_digest text NOT NULL CHECK (
    item_event_semantic_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  order_outbox_event_id platform_helpers.uuid_v7,
  order_event_semantic_digest text CHECK (
    order_event_semantic_digest IS NULL
    OR order_event_semantic_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  causation_operation_id platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  retention_policy_code text NOT NULL CHECK (retention_policy_code = 'KitchenBusinessRecord'),
  CONSTRAINT kitchen_ready_publication_pkey
    PRIMARY KEY (brand_id, store_id, kitchen_ready_publication_id),
  CONSTRAINT kitchen_ready_publication_ready_result_unique
    UNIQUE (brand_id, store_id, ready_result_id),
  CONSTRAINT kitchen_ready_publication_item_event_unique
    UNIQUE (brand_id, store_id, item_outbox_event_id),
  CONSTRAINT kitchen_ready_publication_ticket_fk
    FOREIGN KEY (brand_id, store_id, kitchen_ticket_id)
    REFERENCES rms_kitchen.kitchen_ticket (brand_id, store_id, kitchen_ticket_id),
  CONSTRAINT kitchen_ready_publication_ready_result_fk
    FOREIGN KEY (brand_id, store_id, ready_result_id)
    REFERENCES rms_kitchen.kitchen_order_item_ready_result (brand_id, store_id, ready_result_id),
  CONSTRAINT kitchen_ready_publication_causation_fk
    FOREIGN KEY (brand_id, store_id, causation_operation_id)
    REFERENCES rms_kitchen.kitchen_work_lifecycle_operation (
      brand_id,
      store_id,
      kitchen_work_lifecycle_operation_id
    ),
  CONSTRAINT kitchen_ready_publication_quantity_check CHECK (
    ready_quantity = required_quantity
  ),
  CONSTRAINT kitchen_ready_publication_order_event_shape_check CHECK (
    (order_outbox_event_id IS NULL AND order_event_semantic_digest IS NULL)
    OR (order_outbox_event_id IS NOT NULL AND order_event_semantic_digest IS NOT NULL)
  ),
  CONSTRAINT kitchen_ready_publication_reference_distinct_check CHECK (
    kitchen_ready_publication_id <> brand_id
    AND kitchen_ready_publication_id <> store_id
    AND kitchen_ready_publication_id <> kitchen_ticket_id
    AND kitchen_ready_publication_id <> order_id
    AND kitchen_ready_publication_id <> order_batch_id
    AND kitchen_ready_publication_id <> order_item_id
    AND kitchen_ready_publication_id <> ready_result_id
    AND kitchen_ready_publication_id <> item_outbox_event_id
    AND kitchen_ready_publication_id <> correlation_id
    AND kitchen_ready_publication_id <> causation_operation_id
    AND item_outbox_event_id <> ready_result_id
    AND item_outbox_event_id <> kitchen_ticket_id
    AND item_outbox_event_id <> order_id
    AND item_outbox_event_id <> order_batch_id
    AND item_outbox_event_id <> order_item_id
    AND item_outbox_event_id <> correlation_id
    AND item_outbox_event_id <> causation_operation_id
    AND (order_outbox_event_id IS NULL OR (
      order_outbox_event_id <> kitchen_ready_publication_id
      AND order_outbox_event_id <> item_outbox_event_id
      AND order_outbox_event_id <> ready_result_id
      AND order_outbox_event_id <> kitchen_ticket_id
      AND order_outbox_event_id <> order_id
      AND order_outbox_event_id <> order_batch_id
      AND order_outbox_event_id <> order_item_id
      AND order_outbox_event_id <> correlation_id
      AND order_outbox_event_id <> causation_operation_id
    ))
  )
);

CREATE UNIQUE INDEX kitchen_ready_publication_order_event_unique
  ON rms_kitchen.kitchen_ready_publication (brand_id, store_id, order_outbox_event_id)
  WHERE order_outbox_event_id IS NOT NULL;
CREATE UNIQUE INDEX kitchen_ready_publication_ticket_order_ready_unique
  ON rms_kitchen.kitchen_ready_publication (brand_id, store_id, kitchen_ticket_id)
  WHERE order_outbox_event_id IS NOT NULL;
CREATE INDEX kitchen_ready_publication_ticket_history_idx
  ON rms_kitchen.kitchen_ready_publication (
    brand_id,
    store_id,
    kitchen_ticket_id,
    occurred_at,
    kitchen_ready_publication_id
  );

CREATE TRIGGER kitchen_ready_publication_no_update_trigger
  BEFORE UPDATE ON rms_kitchen.kitchen_ready_publication
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_lifecycle_append_only_update();
CREATE RULE kitchen_ready_publication_no_delete AS
  ON DELETE TO rms_kitchen.kitchen_ready_publication DO INSTEAD NOTHING;

ALTER TABLE rms_kitchen.kitchen_ready_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_ready_publication FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_ready_publication_store_scope_policy
  ON rms_kitchen.kitchen_ready_publication
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
REVOKE ALL ON TABLE rms_kitchen.kitchen_ready_publication FROM PUBLIC;
