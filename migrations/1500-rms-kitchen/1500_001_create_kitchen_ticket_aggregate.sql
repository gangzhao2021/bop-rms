-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA rms_kitchen;
REVOKE ALL ON SCHEMA rms_kitchen FROM PUBLIC;

CREATE TABLE rms_kitchen.kitchen_ticket (
  kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  confirmation_id platform_helpers.uuid_v7 NOT NULL,
  consumer_name text NOT NULL CHECK (consumer_name = 'kitchen.confirmed-order:' || 'v1'),
  consumer_version integer NOT NULL CHECK (consumer_version = 1),
  source_event_id platform_helpers.uuid_v7 NOT NULL,
  source_aggregate_version bigint NOT NULL CHECK (source_aggregate_version > 0),
  source_snapshot_digest text NOT NULL
    CHECK (source_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  confirmed_at timestamp with time zone NOT NULL,
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  semantic_event_binding_digest text NOT NULL
    CHECK (semantic_event_binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_evidence_id platform_helpers.uuid_v7 NOT NULL,
  source_evidence_version integer NOT NULL CHECK (source_evidence_version > 0),
  source_evidence_digest text NOT NULL
    CHECK (source_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_evidence_captured_at timestamp with time zone NOT NULL,
  work_plan_id platform_helpers.uuid_v7 NOT NULL,
  work_plan_version integer NOT NULL CHECK (work_plan_version > 0),
  work_plan_digest text NOT NULL CHECK (work_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  work_plan_generated_at timestamp with time zone NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  status text NOT NULL CHECK (status = 'Open'),
  created_by_actor_type text NOT NULL CHECK (created_by_actor_type = 'System'),
  created_by_actor_id platform_helpers.uuid_v7,
  updated_by_actor_type text NOT NULL CHECK (
    updated_by_actor_type IN ('User', 'System', 'Service')
  ),
  updated_by_actor_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT kitchen_ticket_pkey PRIMARY KEY (brand_id, store_id, kitchen_ticket_id),
  CONSTRAINT kitchen_ticket_source_event_unique
    UNIQUE (brand_id, store_id, consumer_name, source_event_id),
  CONSTRAINT kitchen_ticket_confirmation_unique
    UNIQUE (brand_id, store_id, confirmation_id),
  CONSTRAINT kitchen_ticket_batch_unique
    UNIQUE (brand_id, store_id, order_batch_id),
  CONSTRAINT kitchen_ticket_source_evidence_unique
    UNIQUE (brand_id, store_id, source_evidence_id),
  CONSTRAINT kitchen_ticket_work_plan_unique
    UNIQUE (brand_id, store_id, work_plan_id),
  CONSTRAINT kitchen_ticket_work_item_scope_unique
    UNIQUE (
      brand_id,
      store_id,
      kitchen_ticket_id,
      order_id,
      order_batch_id,
      source_evidence_id,
      work_plan_id
    ),
  CONSTRAINT kitchen_ticket_action_scope_unique
    UNIQUE (
      brand_id,
      store_id,
      kitchen_ticket_id,
      source_event_id,
      work_plan_id,
      correlation_id
    ),
  CONSTRAINT kitchen_ticket_actor_shape_check CHECK (
    created_by_actor_id IS NULL
    AND (
      (updated_by_actor_type = 'System' AND updated_by_actor_id IS NULL)
      OR (updated_by_actor_type IN ('User', 'Service') AND updated_by_actor_id IS NOT NULL)
    )
  ),
  CONSTRAINT kitchen_ticket_time_order_check CHECK (
    source_evidence_captured_at <= confirmed_at
    AND confirmed_at <= work_plan_generated_at
    AND work_plan_generated_at <= created_at
    AND created_at <= updated_at
  )
);

CREATE TABLE rms_kitchen.kitchen_work_item (
  kitchen_work_item_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  order_item_id platform_helpers.uuid_v7 NOT NULL,
  source_evidence_id platform_helpers.uuid_v7 NOT NULL,
  work_plan_id platform_helpers.uuid_v7 NOT NULL,
  source_item_ordinal integer NOT NULL CHECK (source_item_ordinal BETWEEN 1 AND 100),
  split_ordinal integer NOT NULL CHECK (split_ordinal = 1),
  version bigint NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (
    status IN ('Queued', 'Held', 'In Progress', 'Completed', 'Cancelled')
  ),
  required_quantity integer NOT NULL CHECK (required_quantity BETWEEN 1 AND 999),
  completed_quantity integer NOT NULL CHECK (
    completed_quantity BETWEEN 0 AND required_quantity
  ),
  product_id platform_helpers.uuid_v7 NOT NULL,
  product_version_id platform_helpers.uuid_v7 NOT NULL,
  sku_id platform_helpers.uuid_v7 NOT NULL,
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  localized_display_names_json jsonb NOT NULL CHECK (
    jsonb_typeof(localized_display_names_json) = 'object'
    AND jsonb_array_length(
      jsonb_path_query_array(localized_display_names_json, '$.*')
    ) BETWEEN 1 AND 20
  ),
  selected_options_json jsonb NOT NULL CHECK (
    jsonb_typeof(selected_options_json) = 'array'
    AND jsonb_array_length(selected_options_json) <= 100
  ),
  customer_note text,
  source_line_digest text NOT NULL CHECK (source_line_digest ~ '^sha256:[0-9a-f]{64}$'),
  station_id platform_helpers.uuid_v7 NOT NULL,
  routing_rule_id platform_helpers.uuid_v7 NOT NULL,
  routing_rule_version integer NOT NULL CHECK (routing_rule_version > 0),
  routing_rule_digest text NOT NULL
    CHECK (routing_rule_digest ~ '^sha256:[0-9a-f]{64}$'),
  preparation_id platform_helpers.uuid_v7 NOT NULL,
  preparation_version integer NOT NULL CHECK (preparation_version > 0),
  preparation_digest text NOT NULL CHECK (preparation_digest ~ '^sha256:[0-9a-f]{64}$'),
  preparation_instructions_json jsonb NOT NULL CHECK (
    jsonb_typeof(preparation_instructions_json) = 'array'
    AND jsonb_array_length(preparation_instructions_json) BETWEEN 1 AND 32
  ),
  execution_snapshot_digest text NOT NULL
    CHECK (execution_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_by_actor_type text NOT NULL CHECK (created_by_actor_type = 'System'),
  created_by_actor_id platform_helpers.uuid_v7,
  updated_by_actor_type text NOT NULL CHECK (
    updated_by_actor_type IN ('User', 'System', 'Service')
  ),
  updated_by_actor_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT kitchen_work_item_pkey
    PRIMARY KEY (brand_id, store_id, kitchen_work_item_id),
  CONSTRAINT kitchen_work_item_order_item_unique
    UNIQUE (brand_id, store_id, kitchen_ticket_id, order_item_id, split_ordinal),
  CONSTRAINT kitchen_work_item_source_ordinal_unique
    UNIQUE (brand_id, store_id, kitchen_ticket_id, source_item_ordinal),
  CONSTRAINT kitchen_work_item_scope_identity_unique
    UNIQUE (brand_id, store_id, kitchen_ticket_id, kitchen_work_item_id),
  CONSTRAINT kitchen_work_item_ticket_fk
    FOREIGN KEY (
      brand_id,
      store_id,
      kitchen_ticket_id,
      order_id,
      order_batch_id,
      source_evidence_id,
      work_plan_id
    )
    REFERENCES rms_kitchen.kitchen_ticket (
      brand_id,
      store_id,
      kitchen_ticket_id,
      order_id,
      order_batch_id,
      source_evidence_id,
      work_plan_id
    ),
  CONSTRAINT kitchen_work_item_customer_note_check CHECK (
    customer_note IS NULL
    OR (
      char_length(customer_note) BETWEEN 1 AND 240
      AND customer_note = btrim(customer_note, E' \n')
      AND char_length(customer_note) - char_length(replace(customer_note, E'\n', '')) <= 3
      AND customer_note !~ U&'[\0001-\0009\000B-\001F\007F-\009F\061C\200E\200F\2028-\202E\2066-\2069]'
    )
  ),
  CONSTRAINT kitchen_work_item_actor_shape_check CHECK (
    created_by_actor_id IS NULL
    AND (
      (updated_by_actor_type = 'System' AND updated_by_actor_id IS NULL)
      OR (updated_by_actor_type IN ('User', 'Service') AND updated_by_actor_id IS NOT NULL)
    )
  ),
  CONSTRAINT kitchen_work_item_time_order_check CHECK (created_at <= updated_at)
);

CREATE TABLE rms_kitchen.kitchen_action_record (
  kitchen_action_record_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
  source_event_id platform_helpers.uuid_v7 NOT NULL,
  work_plan_id platform_helpers.uuid_v7 NOT NULL,
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  action_version integer NOT NULL CHECK (action_version = 1),
  action_code text NOT NULL CHECK (action_code = 'KITCHEN_TICKET_CREATED'),
  purpose text NOT NULL CHECK (purpose = 'CREATE_KITCHEN_TICKET'),
  reason_code text NOT NULL CHECK (reason_code = 'ORDER_CONFIRMED'),
  actor_type text NOT NULL CHECK (actor_type = 'System'),
  actor_id platform_helpers.uuid_v7,
  source_channel text NOT NULL CHECK (source_channel = 'EVENT_CONSUMER'),
  data_classification text NOT NULL CHECK (data_classification = 'Restricted'),
  work_item_count integer NOT NULL CHECK (work_item_count BETWEEN 1 AND 100),
  effect_digest text NOT NULL CHECK (effect_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT kitchen_action_record_pkey
    PRIMARY KEY (brand_id, store_id, kitchen_action_record_id),
  CONSTRAINT kitchen_action_record_ticket_action_unique
    UNIQUE (brand_id, store_id, kitchen_ticket_id, action_code),
  CONSTRAINT kitchen_action_record_ticket_fk
    FOREIGN KEY (
      brand_id,
      store_id,
      kitchen_ticket_id,
      source_event_id,
      work_plan_id,
      correlation_id
    )
    REFERENCES rms_kitchen.kitchen_ticket (
      brand_id,
      store_id,
      kitchen_ticket_id,
      source_event_id,
      work_plan_id,
      correlation_id
    ),
  CONSTRAINT kitchen_action_record_actor_shape_check CHECK (actor_id IS NULL)
);

CREATE FUNCTION rms_kitchen.enforce_kitchen_ticket_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF (
    OLD.kitchen_ticket_id IS DISTINCT FROM NEW.kitchen_ticket_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.store_id IS DISTINCT FROM NEW.store_id
    OR OLD.order_id IS DISTINCT FROM NEW.order_id
    OR OLD.order_batch_id IS DISTINCT FROM NEW.order_batch_id
    OR OLD.confirmation_id IS DISTINCT FROM NEW.confirmation_id
    OR OLD.consumer_name IS DISTINCT FROM NEW.consumer_name
    OR OLD.consumer_version IS DISTINCT FROM NEW.consumer_version
    OR OLD.source_event_id IS DISTINCT FROM NEW.source_event_id
    OR OLD.source_aggregate_version IS DISTINCT FROM NEW.source_aggregate_version
    OR OLD.source_snapshot_digest IS DISTINCT FROM NEW.source_snapshot_digest
    OR OLD.confirmed_at IS DISTINCT FROM NEW.confirmed_at
    OR OLD.correlation_id IS DISTINCT FROM NEW.correlation_id
    OR OLD.semantic_event_binding_digest IS DISTINCT FROM NEW.semantic_event_binding_digest
    OR OLD.source_evidence_id IS DISTINCT FROM NEW.source_evidence_id
    OR OLD.source_evidence_version IS DISTINCT FROM NEW.source_evidence_version
    OR OLD.source_evidence_digest IS DISTINCT FROM NEW.source_evidence_digest
    OR OLD.source_evidence_captured_at IS DISTINCT FROM NEW.source_evidence_captured_at
    OR OLD.work_plan_id IS DISTINCT FROM NEW.work_plan_id
    OR OLD.work_plan_version IS DISTINCT FROM NEW.work_plan_version
    OR OLD.work_plan_digest IS DISTINCT FROM NEW.work_plan_digest
    OR OLD.work_plan_generated_at IS DISTINCT FROM NEW.work_plan_generated_at
    OR OLD.created_by_actor_type IS DISTINCT FROM NEW.created_by_actor_type
    OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  ) THEN
    RAISE EXCEPTION 'kitchen ticket immutable fields cannot be changed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.enforce_kitchen_ticket_immutable_fields() FROM PUBLIC;
CREATE TRIGGER kitchen_ticket_immutable_fields_trigger
  BEFORE UPDATE ON rms_kitchen.kitchen_ticket
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.enforce_kitchen_ticket_immutable_fields();
CREATE RULE kitchen_ticket_no_delete AS
  ON DELETE TO rms_kitchen.kitchen_ticket DO INSTEAD NOTHING;

CREATE FUNCTION rms_kitchen.enforce_kitchen_work_item_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF (
    OLD.kitchen_work_item_id IS DISTINCT FROM NEW.kitchen_work_item_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.store_id IS DISTINCT FROM NEW.store_id
    OR OLD.kitchen_ticket_id IS DISTINCT FROM NEW.kitchen_ticket_id
    OR OLD.order_id IS DISTINCT FROM NEW.order_id
    OR OLD.order_batch_id IS DISTINCT FROM NEW.order_batch_id
    OR OLD.order_item_id IS DISTINCT FROM NEW.order_item_id
    OR OLD.source_evidence_id IS DISTINCT FROM NEW.source_evidence_id
    OR OLD.work_plan_id IS DISTINCT FROM NEW.work_plan_id
    OR OLD.source_item_ordinal IS DISTINCT FROM NEW.source_item_ordinal
    OR OLD.split_ordinal IS DISTINCT FROM NEW.split_ordinal
    OR OLD.required_quantity IS DISTINCT FROM NEW.required_quantity
    OR OLD.product_id IS DISTINCT FROM NEW.product_id
    OR OLD.product_version_id IS DISTINCT FROM NEW.product_version_id
    OR OLD.sku_id IS DISTINCT FROM NEW.sku_id
    OR OLD.menu_version_id IS DISTINCT FROM NEW.menu_version_id
    OR OLD.localized_display_names_json IS DISTINCT FROM NEW.localized_display_names_json
    OR OLD.selected_options_json IS DISTINCT FROM NEW.selected_options_json
    OR OLD.customer_note IS DISTINCT FROM NEW.customer_note
    OR OLD.source_line_digest IS DISTINCT FROM NEW.source_line_digest
    OR OLD.station_id IS DISTINCT FROM NEW.station_id
    OR OLD.routing_rule_id IS DISTINCT FROM NEW.routing_rule_id
    OR OLD.routing_rule_version IS DISTINCT FROM NEW.routing_rule_version
    OR OLD.routing_rule_digest IS DISTINCT FROM NEW.routing_rule_digest
    OR OLD.preparation_id IS DISTINCT FROM NEW.preparation_id
    OR OLD.preparation_version IS DISTINCT FROM NEW.preparation_version
    OR OLD.preparation_digest IS DISTINCT FROM NEW.preparation_digest
    OR OLD.preparation_instructions_json IS DISTINCT FROM NEW.preparation_instructions_json
    OR OLD.execution_snapshot_digest IS DISTINCT FROM NEW.execution_snapshot_digest
    OR OLD.created_by_actor_type IS DISTINCT FROM NEW.created_by_actor_type
    OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  ) THEN
    RAISE EXCEPTION 'kitchen work item immutable fields cannot be changed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.enforce_kitchen_work_item_immutable_fields() FROM PUBLIC;
CREATE TRIGGER kitchen_work_item_immutable_fields_trigger
  BEFORE UPDATE ON rms_kitchen.kitchen_work_item
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.enforce_kitchen_work_item_immutable_fields();
CREATE RULE kitchen_work_item_no_delete AS
  ON DELETE TO rms_kitchen.kitchen_work_item DO INSTEAD NOTHING;

CREATE FUNCTION rms_kitchen.reject_kitchen_action_record_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'kitchen action record is append-only'
    USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.reject_kitchen_action_record_update() FROM PUBLIC;
CREATE TRIGGER kitchen_action_record_no_update_trigger
  BEFORE UPDATE ON rms_kitchen.kitchen_action_record
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_action_record_update();
CREATE RULE kitchen_action_record_no_delete AS
  ON DELETE TO rms_kitchen.kitchen_action_record DO INSTEAD NOTHING;

CREATE INDEX kitchen_ticket_order_lookup_idx
  ON rms_kitchen.kitchen_ticket
  (brand_id, store_id, order_id, created_at DESC, kitchen_ticket_id);
CREATE INDEX kitchen_work_item_station_queue_idx
  ON rms_kitchen.kitchen_work_item
  (brand_id, store_id, station_id, status, created_at, kitchen_work_item_id);
CREATE INDEX kitchen_action_record_history_idx
  ON rms_kitchen.kitchen_action_record
  (brand_id, store_id, kitchen_ticket_id, occurred_at, kitchen_action_record_id);

ALTER TABLE rms_kitchen.kitchen_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_ticket FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_work_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_work_item FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_action_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_action_record FORCE ROW LEVEL SECURITY;

CREATE POLICY kitchen_ticket_store_scope_policy ON rms_kitchen.kitchen_ticket
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY kitchen_work_item_store_scope_policy ON rms_kitchen.kitchen_work_item
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY kitchen_action_record_store_scope_policy
  ON rms_kitchen.kitchen_action_record
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_kitchen.kitchen_ticket FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.kitchen_work_item FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.kitchen_action_record FROM PUBLIC;
