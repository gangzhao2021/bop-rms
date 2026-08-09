-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_kitchen.kitchen_work_queue_projection_generation (
  projection_generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  projection_name text NOT NULL CHECK (projection_name = 'kitchen_work_queue_v1'),
  projection_version integer NOT NULL CHECK (projection_version = 1),
  generation_status text NOT NULL CHECK (
    generation_status IN ('Building', 'Active', 'Retired')
  ),
  source_checkpoint_reference platform_helpers.uuid_v7 NOT NULL,
  source_event_binding_digest text NOT NULL CHECK (
    source_event_binding_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  queue_snapshot_digest text NOT NULL CHECK (
    queue_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  ticket_count integer NOT NULL CHECK (ticket_count >= 0),
  work_item_count integer NOT NULL CHECK (work_item_count >= 0),
  initialized_empty boolean NOT NULL,
  as_of_utc timestamp with time zone NOT NULL,
  projected_at timestamp with time zone NOT NULL,
  last_rebuilt_at timestamp with time zone,
  freshness_status text NOT NULL CHECK (freshness_status IN ('Fresh', 'Stale')),
  rebuild_reference platform_helpers.uuid_v7,
  rebuild_request_digest text CHECK (
    rebuild_request_digest IS NULL
    OR rebuild_request_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  rebuild_requested_at timestamp with time zone,
  expected_prior_generation_id platform_helpers.uuid_v7,
  CONSTRAINT kitchen_work_queue_generation_pkey
    PRIMARY KEY (brand_id, store_id, projection_generation_id),
  CONSTRAINT kitchen_work_queue_generation_empty_shape_check CHECK (
    (
      initialized_empty
      AND ticket_count = 0
      AND work_item_count = 0
    )
    OR (
      NOT initialized_empty
      AND ticket_count > 0
      AND work_item_count >= ticket_count
    )
  ),
  CONSTRAINT kitchen_work_queue_generation_freshness_check CHECK (
    projected_at >= as_of_utc
    AND (last_rebuilt_at IS NULL OR last_rebuilt_at <= projected_at)
    AND (rebuild_requested_at IS NULL OR rebuild_requested_at <= projected_at)
    AND (
      (freshness_status = 'Fresh' AND projected_at <= as_of_utc + interval '2 seconds')
      OR (freshness_status = 'Stale' AND projected_at > as_of_utc + interval '2 seconds')
    )
  ),
  CONSTRAINT kitchen_work_queue_generation_rebuild_shape_check CHECK (
    (
      rebuild_reference IS NULL
      AND rebuild_request_digest IS NULL
      AND rebuild_requested_at IS NULL
      AND expected_prior_generation_id IS NULL
    )
    OR (
      rebuild_reference IS NOT NULL
      AND rebuild_request_digest IS NOT NULL
      AND rebuild_requested_at IS NOT NULL
    )
  ),
  CONSTRAINT kitchen_work_queue_generation_expected_prior_fk
    FOREIGN KEY (brand_id, store_id, expected_prior_generation_id)
    REFERENCES rms_kitchen.kitchen_work_queue_projection_generation (
      brand_id,
      store_id,
      projection_generation_id
    )
);

CREATE UNIQUE INDEX kitchen_work_queue_generation_one_active_unique
  ON rms_kitchen.kitchen_work_queue_projection_generation (
    brand_id,
    store_id,
    projection_name,
    projection_version
  )
  WHERE generation_status = 'Active';
CREATE UNIQUE INDEX kitchen_work_queue_generation_rebuild_reference_unique
  ON rms_kitchen.kitchen_work_queue_projection_generation (
    brand_id,
    store_id,
    rebuild_reference
  )
  WHERE rebuild_reference IS NOT NULL;
CREATE INDEX kitchen_work_queue_generation_history_idx
  ON rms_kitchen.kitchen_work_queue_projection_generation (
    brand_id,
    store_id,
    projection_name,
    projection_version,
    projected_at DESC,
    projection_generation_id
  );

CREATE TABLE rms_kitchen.kitchen_work_queue_projection (
  projection_generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_work_item_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  order_item_id platform_helpers.uuid_v7 NOT NULL,
  source_item_ordinal integer NOT NULL CHECK (source_item_ordinal BETWEEN 1 AND 100),
  ticket_aggregate_version bigint NOT NULL CHECK (ticket_aggregate_version > 0),
  work_item_version bigint NOT NULL CHECK (work_item_version > 0),
  status text NOT NULL CHECK (
    status IN ('Queued', 'Held', 'In Progress', 'Completed', 'Cancelled')
  ),
  required_quantity integer NOT NULL CHECK (required_quantity BETWEEN 1 AND 999),
  completed_quantity integer NOT NULL CHECK (
    completed_quantity BETWEEN 0 AND required_quantity
  ),
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
  station_id platform_helpers.uuid_v7 NOT NULL,
  original_source_event_id platform_helpers.uuid_v7 NOT NULL,
  source_event_semantic_digest text NOT NULL CHECK (
    source_event_semantic_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  source_event_occurred_at timestamp with time zone NOT NULL,
  work_item_created_at timestamp with time zone NOT NULL,
  CONSTRAINT kitchen_work_queue_projection_pkey
    PRIMARY KEY (
      brand_id,
      store_id,
      projection_generation_id,
      kitchen_work_item_id
    ),
  CONSTRAINT kitchen_work_queue_projection_source_ordinal_unique
    UNIQUE (
      brand_id,
      store_id,
      projection_generation_id,
      kitchen_ticket_id,
      source_item_ordinal
    ),
  CONSTRAINT kitchen_work_queue_projection_generation_fk
    FOREIGN KEY (brand_id, store_id, projection_generation_id)
    REFERENCES rms_kitchen.kitchen_work_queue_projection_generation (
      brand_id,
      store_id,
      projection_generation_id
    ),
  CONSTRAINT kitchen_work_queue_projection_work_item_fk
    FOREIGN KEY (brand_id, store_id, kitchen_ticket_id, kitchen_work_item_id)
    REFERENCES rms_kitchen.kitchen_work_item (
      brand_id,
      store_id,
      kitchen_ticket_id,
      kitchen_work_item_id
    ),
  CONSTRAINT kitchen_work_queue_projection_time_order_check CHECK (
    source_event_occurred_at = work_item_created_at
  )
);

CREATE INDEX kitchen_work_queue_projection_station_queue_idx
  ON rms_kitchen.kitchen_work_queue_projection (
    brand_id,
    store_id,
    projection_generation_id,
    station_id,
    work_item_created_at,
    kitchen_work_item_id
  );
CREATE INDEX kitchen_work_queue_projection_status_queue_idx
  ON rms_kitchen.kitchen_work_queue_projection (
    brand_id,
    store_id,
    projection_generation_id,
    status,
    work_item_created_at,
    kitchen_work_item_id
  );
CREATE INDEX kitchen_work_queue_projection_order_lookup_idx
  ON rms_kitchen.kitchen_work_queue_projection (
    brand_id,
    store_id,
    projection_generation_id,
    order_id,
    work_item_created_at,
    kitchen_work_item_id
  );
CREATE INDEX kitchen_work_queue_projection_ticket_lookup_idx
  ON rms_kitchen.kitchen_work_queue_projection (
    brand_id,
    store_id,
    projection_generation_id,
    kitchen_ticket_id,
    work_item_created_at,
    kitchen_work_item_id
  );
CREATE INDEX kitchen_work_queue_projection_queue_order_idx
  ON rms_kitchen.kitchen_work_queue_projection (
    brand_id,
    store_id,
    projection_generation_id,
    work_item_created_at,
    kitchen_work_item_id
  );
CREATE INDEX kitchen_work_queue_projection_source_event_lookup_idx
  ON rms_kitchen.kitchen_work_queue_projection (
    brand_id,
    store_id,
    projection_generation_id,
    original_source_event_id,
    kitchen_ticket_id
  );

CREATE FUNCTION rms_kitchen.enforce_kitchen_work_queue_generation_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF (
    OLD.projection_generation_id IS DISTINCT FROM NEW.projection_generation_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.store_id IS DISTINCT FROM NEW.store_id
    OR OLD.projection_name IS DISTINCT FROM NEW.projection_name
    OR OLD.projection_version IS DISTINCT FROM NEW.projection_version
    OR OLD.source_checkpoint_reference IS DISTINCT FROM NEW.source_checkpoint_reference
    OR OLD.source_event_binding_digest IS DISTINCT FROM NEW.source_event_binding_digest
    OR OLD.queue_snapshot_digest IS DISTINCT FROM NEW.queue_snapshot_digest
    OR OLD.ticket_count IS DISTINCT FROM NEW.ticket_count
    OR OLD.work_item_count IS DISTINCT FROM NEW.work_item_count
    OR OLD.initialized_empty IS DISTINCT FROM NEW.initialized_empty
    OR OLD.as_of_utc IS DISTINCT FROM NEW.as_of_utc
    OR OLD.projected_at IS DISTINCT FROM NEW.projected_at
    OR OLD.last_rebuilt_at IS DISTINCT FROM NEW.last_rebuilt_at
    OR OLD.freshness_status IS DISTINCT FROM NEW.freshness_status
    OR OLD.rebuild_reference IS DISTINCT FROM NEW.rebuild_reference
    OR OLD.rebuild_request_digest IS DISTINCT FROM NEW.rebuild_request_digest
    OR OLD.rebuild_requested_at IS DISTINCT FROM NEW.rebuild_requested_at
    OR OLD.expected_prior_generation_id IS DISTINCT FROM NEW.expected_prior_generation_id
    OR NOT (
      (OLD.generation_status = 'Building' AND NEW.generation_status = 'Active')
      OR (OLD.generation_status = 'Active' AND NEW.generation_status = 'Retired')
    )
  ) THEN
    RAISE EXCEPTION 'kitchen work queue generation permits only immutable Building to Active to Retired transitions'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.enforce_kitchen_work_queue_generation_transition()
  FROM PUBLIC;
CREATE TRIGGER kitchen_work_queue_generation_transition_trigger
  BEFORE UPDATE ON rms_kitchen.kitchen_work_queue_projection_generation
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.enforce_kitchen_work_queue_generation_transition();
CREATE RULE kitchen_work_queue_generation_no_delete AS
  ON DELETE TO rms_kitchen.kitchen_work_queue_projection_generation DO INSTEAD NOTHING;

CREATE FUNCTION rms_kitchen.reject_kitchen_work_queue_projection_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'kitchen work queue projection row is immutable'
    USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.reject_kitchen_work_queue_projection_update() FROM PUBLIC;
CREATE TRIGGER kitchen_work_queue_projection_no_update_trigger
  BEFORE UPDATE ON rms_kitchen.kitchen_work_queue_projection
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_queue_projection_update();
CREATE RULE kitchen_work_queue_projection_no_delete AS
  ON DELETE TO rms_kitchen.kitchen_work_queue_projection DO INSTEAD NOTHING;

ALTER TABLE rms_kitchen.kitchen_work_queue_projection_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_work_queue_projection_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_work_queue_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_work_queue_projection FORCE ROW LEVEL SECURITY;

CREATE POLICY kitchen_work_queue_generation_store_scope_policy
  ON rms_kitchen.kitchen_work_queue_projection_generation
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY kitchen_work_queue_projection_store_scope_policy
  ON rms_kitchen.kitchen_work_queue_projection
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_kitchen.kitchen_work_queue_projection_generation FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.kitchen_work_queue_projection FROM PUBLIC;
