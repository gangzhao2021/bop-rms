-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_kitchen.kitchen_work_item
  ADD CONSTRAINT kitchen_work_item_lifecycle_quantity_check CHECK (
    (status = 'Queued' AND completed_quantity = 0)
    OR (status = 'In Progress' AND completed_quantity < required_quantity)
    OR (status = 'Completed' AND completed_quantity = required_quantity)
    OR (status IN ('Held', 'Cancelled'))
  ),
  ADD CONSTRAINT kitchen_work_item_lifecycle_target_unique UNIQUE (
    brand_id,
    store_id,
    kitchen_ticket_id,
    kitchen_work_item_id,
    order_item_id
  );

ALTER TABLE rms_kitchen.kitchen_work_queue_projection_generation
  ADD COLUMN snapshot_binding_version smallint DEFAULT 1;
ALTER TABLE rms_kitchen.kitchen_work_queue_projection_generation
  ALTER COLUMN snapshot_binding_version SET NOT NULL;
ALTER TABLE rms_kitchen.kitchen_work_queue_projection_generation
  ADD CONSTRAINT kitchen_work_queue_generation_snapshot_binding_version_check
    CHECK (snapshot_binding_version IN (1, 2));
ALTER TABLE rms_kitchen.kitchen_work_queue_projection_generation
  ALTER COLUMN snapshot_binding_version DROP DEFAULT;

ALTER TABLE rms_kitchen.kitchen_work_queue_projection
  ADD COLUMN accepted_at timestamp with time zone,
  ADD COLUMN order_item_ready_at timestamp with time zone,
  ADD CONSTRAINT kitchen_work_queue_projection_lifecycle_quantity_check CHECK (
    (status = 'Queued' AND completed_quantity = 0)
    OR (status = 'In Progress' AND completed_quantity < required_quantity)
    OR (status = 'Completed' AND completed_quantity = required_quantity)
    OR (status IN ('Held', 'Cancelled'))
  ),
  ADD CONSTRAINT kitchen_work_queue_projection_lifecycle_time_check CHECK (
    (accepted_at IS NULL OR accepted_at >= work_item_created_at)
    AND (
      order_item_ready_at IS NULL
      OR (
        accepted_at IS NOT NULL
        AND order_item_ready_at >= accepted_at
        AND order_item_ready_at >= work_item_created_at
        AND status = 'Completed'
        AND completed_quantity = required_quantity
      )
    )
  );

DROP TRIGGER kitchen_work_queue_generation_transition_trigger
  ON rms_kitchen.kitchen_work_queue_projection_generation;
DROP FUNCTION rms_kitchen.enforce_kitchen_work_queue_generation_transition();
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
    OR OLD.snapshot_binding_version IS DISTINCT FROM NEW.snapshot_binding_version
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

CREATE TABLE rms_kitchen.kitchen_work_lifecycle_operation (
  kitchen_work_lifecycle_operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_work_item_id platform_helpers.uuid_v7,
  order_item_id platform_helpers.uuid_v7 NOT NULL,
  idempotency_key text,
  action_code text NOT NULL CHECK (
    action_code IN (
      'KITCHEN_WORK_ITEM_ACCEPTED',
      'KITCHEN_WORK_ITEM_STARTED',
      'KITCHEN_WORK_ITEM_COMPLETION_RECORDED',
      'KITCHEN_ORDER_ITEM_READY'
    )
  ),
  purpose text NOT NULL CHECK (purpose IN ('KitchenWorkExecution', 'KitchenExpoCoordination')),
  reason_code text NOT NULL CHECK (
    reason_code IN (
      'WORK_ITEM_ACCEPTED',
      'WORK_ITEM_STARTED',
      'COMPLETION_QUANTITY_RECORDED',
      'EXPO_MARKED_READY',
      'ALL_WORK_ITEMS_COMPLETED'
    )
  ),
  outcome text NOT NULL CHECK (
    outcome IN (
      'Accepted',
      'Started',
      'ProgressRecorded',
      'Completed',
      'CompletedAndOrderItemReady',
      'OrderItemReady'
    )
  ),
  actor_type text NOT NULL CHECK (actor_type IN ('User', 'System')),
  actor_id platform_helpers.uuid_v7,
  source_channel text NOT NULL CHECK (source_channel IN ('KDS_COMMAND', 'KITCHEN_AUTOMATION')),
  data_classification text NOT NULL CHECK (data_classification = 'Confidential'),
  intent_digest text CHECK (intent_digest IS NULL OR intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  effect_digest text NOT NULL CHECK (effect_digest ~ '^sha256:[0-9a-f]{64}$'),
  expected_ticket_version bigint CHECK (expected_ticket_version > 0),
  result_ticket_version bigint NOT NULL CHECK (result_ticket_version > 0),
  expected_work_item_version bigint CHECK (expected_work_item_version > 0),
  result_work_item_version bigint CHECK (result_work_item_version > 0),
  before_work_item_status text CHECK (
    before_work_item_status IS NULL
    OR before_work_item_status IN ('Queued', 'Held', 'In Progress', 'Completed', 'Cancelled')
  ),
  after_work_item_status text CHECK (
    after_work_item_status IS NULL
    OR after_work_item_status IN ('Queued', 'Held', 'In Progress', 'Completed', 'Cancelled')
  ),
  quantity_delta integer CHECK (quantity_delta > 0),
  completed_quantity integer CHECK (completed_quantity >= 0),
  required_quantity integer CHECK (required_quantity BETWEEN 1 AND 999),
  accepted_operation_id platform_helpers.uuid_v7,
  started_operation_id platform_helpers.uuid_v7,
  automatic_child_operation_id platform_helpers.uuid_v7,
  admission_decision_id platform_helpers.uuid_v7,
  admission_decision_version integer CHECK (admission_decision_version > 0),
  admission_decision_digest text CHECK (
    admission_decision_digest IS NULL
    OR admission_decision_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  admission_producer_contract_version integer CHECK (admission_producer_contract_version = 1),
  admission_outcome text CHECK (admission_outcome = 'Allowed'),
  admission_evaluated_at timestamp with time zone,
  admission_valid_until timestamp with time zone,
  expo_source_operation_id platform_helpers.uuid_v7,
  expo_source_action_code text CHECK (
    expo_source_action_code = 'KITCHEN_WORK_ITEM_COMPLETION_RECORDED'
  ),
  expo_source_expected_ticket_version bigint CHECK (expo_source_expected_ticket_version > 0),
  expo_source_result_ticket_version bigint CHECK (expo_source_result_ticket_version > 0),
  expo_source_expected_work_item_version bigint CHECK (
    expo_source_expected_work_item_version > 0
  ),
  expo_source_result_work_item_version bigint CHECK (expo_source_result_work_item_version > 0),
  expo_source_before_status text CHECK (expo_source_before_status = 'In Progress'),
  expo_source_after_status text CHECK (expo_source_after_status = 'Completed'),
  expo_source_completed_quantity integer CHECK (expo_source_completed_quantity > 0),
  expo_source_required_quantity integer CHECK (
    expo_source_required_quantity BETWEEN 1 AND 999
  ),
  expo_source_outcome text CHECK (
    expo_source_outcome IN ('Completed', 'CompletedAndOrderItemReady')
  ),
  expo_source_occurred_at timestamp with time zone,
  captured_expo_binding_digest text CHECK (
    captured_expo_binding_digest IS NULL
    OR captured_expo_binding_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  expo_decision_id platform_helpers.uuid_v7,
  expo_decision_version integer CHECK (expo_decision_version > 0),
  expo_decision_digest text CHECK (
    expo_decision_digest IS NULL OR expo_decision_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  expo_producer_contract_version integer CHECK (expo_producer_contract_version = 1),
  expo_decision_purpose text CHECK (expo_decision_purpose = 'KitchenReadiness'),
  expo_mode text CHECK (expo_mode IN ('Enabled', 'Disabled')),
  expo_evaluated_at timestamp with time zone,
  expo_valid_until timestamp with time zone,
  ready_result_id platform_helpers.uuid_v7,
  audit_id platform_helpers.uuid_v7 NOT NULL,
  audit_semantic_digest text NOT NULL CHECK (
    audit_semantic_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  outbox_event_id platform_helpers.uuid_v7,
  event_semantic_digest text CHECK (
    event_semantic_digest IS NULL OR event_semantic_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  causation_operation_id platform_helpers.uuid_v7,
  occurred_at timestamp with time zone NOT NULL,
  replay_expires_at timestamp with time zone,
  CONSTRAINT kitchen_work_lifecycle_operation_pkey
    PRIMARY KEY (brand_id, store_id, kitchen_work_lifecycle_operation_id),
  CONSTRAINT kitchen_work_lifecycle_operation_target_identity_unique
    UNIQUE (
      brand_id,
      store_id,
      kitchen_ticket_id,
      order_item_id,
      kitchen_work_lifecycle_operation_id
    ),
  CONSTRAINT kitchen_work_lifecycle_operation_work_item_target_identity_unique
    UNIQUE (
      brand_id,
      store_id,
      kitchen_ticket_id,
      kitchen_work_item_id,
      order_item_id,
      kitchen_work_lifecycle_operation_id
    ),
  CONSTRAINT kitchen_work_lifecycle_operation_causation_version_unique
    UNIQUE (
      brand_id,
      store_id,
      kitchen_ticket_id,
      order_item_id,
      kitchen_work_lifecycle_operation_id,
      result_ticket_version
    ),
  CONSTRAINT kitchen_work_lifecycle_operation_ticket_fk
    FOREIGN KEY (brand_id, store_id, kitchen_ticket_id)
    REFERENCES rms_kitchen.kitchen_ticket (brand_id, store_id, kitchen_ticket_id),
  CONSTRAINT kitchen_work_lifecycle_operation_work_item_fk
    FOREIGN KEY (
      brand_id,
      store_id,
      kitchen_ticket_id,
      kitchen_work_item_id,
      order_item_id
    )
    REFERENCES rms_kitchen.kitchen_work_item (
      brand_id,
      store_id,
      kitchen_ticket_id,
      kitchen_work_item_id,
      order_item_id
    ),
  CONSTRAINT kitchen_work_lifecycle_operation_accepted_fk
    FOREIGN KEY (
      brand_id,
      store_id,
      kitchen_ticket_id,
      kitchen_work_item_id,
      order_item_id,
      accepted_operation_id
    )
    REFERENCES rms_kitchen.kitchen_work_lifecycle_operation (
      brand_id,
      store_id,
      kitchen_ticket_id,
      kitchen_work_item_id,
      order_item_id,
      kitchen_work_lifecycle_operation_id
    ),
  CONSTRAINT kitchen_work_lifecycle_operation_started_fk
    FOREIGN KEY (
      brand_id,
      store_id,
      kitchen_ticket_id,
      kitchen_work_item_id,
      order_item_id,
      started_operation_id
    )
    REFERENCES rms_kitchen.kitchen_work_lifecycle_operation (
      brand_id,
      store_id,
      kitchen_ticket_id,
      kitchen_work_item_id,
      order_item_id,
      kitchen_work_lifecycle_operation_id
    ),
  CONSTRAINT kitchen_work_lifecycle_operation_causation_fk
    FOREIGN KEY (
      brand_id,
      store_id,
      kitchen_ticket_id,
      order_item_id,
      causation_operation_id,
      result_ticket_version
    )
    REFERENCES rms_kitchen.kitchen_work_lifecycle_operation (
      brand_id,
      store_id,
      kitchen_ticket_id,
      order_item_id,
      kitchen_work_lifecycle_operation_id,
      result_ticket_version
    ),
  CONSTRAINT kitchen_work_lifecycle_operation_expo_source_fk
    FOREIGN KEY (
      brand_id,
      store_id,
      kitchen_ticket_id,
      order_item_id,
      expo_source_operation_id
    )
    REFERENCES rms_kitchen.kitchen_work_lifecycle_operation (
      brand_id,
      store_id,
      kitchen_ticket_id,
      order_item_id,
      kitchen_work_lifecycle_operation_id
    ),
  CONSTRAINT kitchen_work_lifecycle_operation_actor_shape_check CHECK (
    (actor_type = 'User' AND actor_id IS NOT NULL AND source_channel = 'KDS_COMMAND')
    OR (actor_type = 'System' AND actor_id IS NULL AND source_channel = 'KITCHEN_AUTOMATION')
  ),
  CONSTRAINT kitchen_work_lifecycle_operation_idempotency_shape_check CHECK (
    (
      actor_type = 'User'
      AND idempotency_key IS NOT NULL
      AND char_length(idempotency_key) BETWEEN 16 AND 200
      AND idempotency_key ~ '^[A-Za-z0-9](?:[A-Za-z0-9:_-]{14,198}[A-Za-z0-9])$'
      AND intent_digest IS NOT NULL
      AND expected_ticket_version IS NOT NULL
      AND replay_expires_at IS NOT NULL
      AND replay_expires_at = occurred_at + interval '30 days'
    )
    OR (
      actor_type = 'System'
      AND idempotency_key IS NULL
      AND intent_digest IS NULL
      AND expected_ticket_version IS NULL
      AND replay_expires_at IS NULL
    )
  ),
  CONSTRAINT kitchen_work_lifecycle_operation_quantity_shape_check CHECK (
    (
      actor_type = 'User'
      AND completed_quantity IS NOT NULL
      AND required_quantity IS NOT NULL
      AND completed_quantity BETWEEN 0 AND required_quantity
    )
    OR (
      actor_type = 'System'
      AND completed_quantity IS NULL
      AND required_quantity IS NULL
      AND quantity_delta IS NULL
    )
  ),
  CONSTRAINT kitchen_work_lifecycle_operation_admission_shape_check CHECK (
    (
      action_code = 'KITCHEN_WORK_ITEM_STARTED'
      AND admission_decision_id IS NOT NULL
      AND admission_decision_version IS NOT NULL
      AND admission_decision_digest IS NOT NULL
      AND admission_producer_contract_version IS NOT NULL
      AND admission_producer_contract_version = 1
      AND admission_outcome IS NOT NULL
      AND admission_outcome = 'Allowed'
      AND admission_evaluated_at IS NOT NULL
      AND admission_valid_until IS NOT NULL
      AND admission_evaluated_at <= occurred_at
      AND occurred_at < admission_valid_until
    )
    OR (
      action_code <> 'KITCHEN_WORK_ITEM_STARTED'
      AND admission_decision_id IS NULL
      AND admission_decision_version IS NULL
      AND admission_decision_digest IS NULL
      AND admission_producer_contract_version IS NULL
      AND admission_outcome IS NULL
      AND admission_evaluated_at IS NULL
      AND admission_valid_until IS NULL
    )
  ),
  CONSTRAINT kitchen_work_lifecycle_operation_expo_shape_check CHECK (
    (
      expo_source_operation_id IS NOT NULL
      AND expo_source_action_code IS NOT NULL
      AND expo_source_action_code = 'KITCHEN_WORK_ITEM_COMPLETION_RECORDED'
      AND expo_source_expected_ticket_version IS NOT NULL
      AND expo_source_result_ticket_version IS NOT NULL
      AND expo_source_result_ticket_version = expo_source_expected_ticket_version + 1
      AND expo_source_expected_work_item_version IS NOT NULL
      AND expo_source_result_work_item_version IS NOT NULL
      AND expo_source_result_work_item_version = expo_source_expected_work_item_version + 1
      AND expo_source_before_status IS NOT NULL
      AND expo_source_before_status = 'In Progress'
      AND expo_source_after_status IS NOT NULL
      AND expo_source_after_status = 'Completed'
      AND expo_source_completed_quantity IS NOT NULL
      AND expo_source_required_quantity IS NOT NULL
      AND expo_source_completed_quantity = expo_source_required_quantity
      AND expo_source_outcome IS NOT NULL
      AND expo_source_outcome IN ('Completed', 'CompletedAndOrderItemReady')
      AND expo_source_occurred_at IS NOT NULL
      AND captured_expo_binding_digest IS NOT NULL
      AND expo_decision_id IS NOT NULL
      AND expo_decision_version IS NOT NULL
      AND expo_decision_digest IS NOT NULL
      AND expo_producer_contract_version IS NOT NULL
      AND expo_producer_contract_version = 1
      AND expo_decision_purpose IS NOT NULL
      AND expo_decision_purpose = 'KitchenReadiness'
      AND expo_mode IS NOT NULL
      AND expo_mode IN ('Enabled', 'Disabled')
      AND expo_evaluated_at IS NOT NULL
      AND expo_valid_until IS NOT NULL
      AND expo_evaluated_at <= expo_source_occurred_at
      AND expo_source_occurred_at < expo_valid_until
      AND (
        (expo_mode = 'Enabled' AND expo_source_outcome = 'Completed')
        OR (
          expo_mode = 'Disabled'
          AND expo_source_outcome = 'CompletedAndOrderItemReady'
        )
      )
    )
    OR (
      expo_source_operation_id IS NULL
      AND expo_source_action_code IS NULL
      AND expo_source_expected_ticket_version IS NULL
      AND expo_source_result_ticket_version IS NULL
      AND expo_source_expected_work_item_version IS NULL
      AND expo_source_result_work_item_version IS NULL
      AND expo_source_before_status IS NULL
      AND expo_source_after_status IS NULL
      AND expo_source_completed_quantity IS NULL
      AND expo_source_required_quantity IS NULL
      AND expo_source_outcome IS NULL
      AND expo_source_occurred_at IS NULL
      AND captured_expo_binding_digest IS NULL
      AND expo_decision_id IS NULL
      AND expo_decision_version IS NULL
      AND expo_decision_digest IS NULL
      AND expo_producer_contract_version IS NULL
      AND expo_decision_purpose IS NULL
      AND expo_mode IS NULL
      AND expo_evaluated_at IS NULL
      AND expo_valid_until IS NULL
    )
  ),
  CONSTRAINT kitchen_work_lifecycle_operation_event_shape_check CHECK (
    (
      action_code IN (
        'KITCHEN_WORK_ITEM_ACCEPTED',
        'KITCHEN_WORK_ITEM_STARTED',
        'KITCHEN_WORK_ITEM_COMPLETION_RECORDED'
      )
      AND outbox_event_id IS NOT NULL
      AND event_semantic_digest IS NOT NULL
    )
    OR (
      action_code = 'KITCHEN_ORDER_ITEM_READY'
      AND outbox_event_id IS NULL
      AND event_semantic_digest IS NULL
    )
  ),
  CONSTRAINT kitchen_work_lifecycle_operation_action_shape_check CHECK (
    (
      action_code = 'KITCHEN_WORK_ITEM_ACCEPTED'
      AND purpose = 'KitchenWorkExecution'
      AND reason_code = 'WORK_ITEM_ACCEPTED'
      AND outcome = 'Accepted'
      AND actor_type = 'User'
      AND kitchen_work_item_id IS NOT NULL
      AND expected_ticket_version IS NOT NULL
      AND result_ticket_version = expected_ticket_version + 1
      AND expected_work_item_version IS NOT NULL
      AND result_work_item_version IS NOT NULL
      AND result_work_item_version = expected_work_item_version + 1
      AND before_work_item_status IS NOT NULL
      AND after_work_item_status IS NOT NULL
      AND before_work_item_status = 'Queued'
      AND after_work_item_status = 'Queued'
      AND quantity_delta IS NULL
      AND completed_quantity = 0
      AND accepted_operation_id IS NULL
      AND started_operation_id IS NULL
      AND automatic_child_operation_id IS NULL
      AND ready_result_id IS NULL
      AND causation_operation_id IS NULL
      AND expo_source_operation_id IS NULL
    )
    OR (
      action_code = 'KITCHEN_WORK_ITEM_STARTED'
      AND purpose = 'KitchenWorkExecution'
      AND reason_code = 'WORK_ITEM_STARTED'
      AND outcome = 'Started'
      AND actor_type = 'User'
      AND kitchen_work_item_id IS NOT NULL
      AND expected_ticket_version IS NOT NULL
      AND result_ticket_version = expected_ticket_version + 1
      AND expected_work_item_version IS NOT NULL
      AND result_work_item_version IS NOT NULL
      AND result_work_item_version = expected_work_item_version + 1
      AND before_work_item_status IS NOT NULL
      AND after_work_item_status IS NOT NULL
      AND before_work_item_status = 'Queued'
      AND after_work_item_status = 'In Progress'
      AND quantity_delta IS NULL
      AND completed_quantity = 0
      AND accepted_operation_id IS NOT NULL
      AND started_operation_id IS NULL
      AND automatic_child_operation_id IS NULL
      AND ready_result_id IS NULL
      AND causation_operation_id IS NULL
      AND expo_source_operation_id IS NULL
    )
    OR (
      action_code = 'KITCHEN_WORK_ITEM_COMPLETION_RECORDED'
      AND purpose = 'KitchenWorkExecution'
      AND reason_code = 'COMPLETION_QUANTITY_RECORDED'
      AND actor_type = 'User'
      AND kitchen_work_item_id IS NOT NULL
      AND expected_ticket_version IS NOT NULL
      AND result_ticket_version = expected_ticket_version + 1
      AND expected_work_item_version IS NOT NULL
      AND result_work_item_version IS NOT NULL
      AND result_work_item_version = expected_work_item_version + 1
      AND before_work_item_status IS NOT NULL
      AND after_work_item_status IS NOT NULL
      AND before_work_item_status = 'In Progress'
      AND quantity_delta IS NOT NULL
      AND quantity_delta <= completed_quantity
      AND completed_quantity > 0
      AND accepted_operation_id IS NOT NULL
      AND started_operation_id IS NOT NULL
      AND causation_operation_id IS NULL
      AND (
        (
          outcome = 'ProgressRecorded'
          AND after_work_item_status = 'In Progress'
          AND completed_quantity < required_quantity
          AND automatic_child_operation_id IS NULL
          AND ready_result_id IS NULL
          AND expo_source_operation_id IS NULL
        )
        OR (
          outcome = 'Completed'
          AND after_work_item_status = 'Completed'
          AND completed_quantity = required_quantity
          AND automatic_child_operation_id IS NULL
          AND ready_result_id IS NULL
          AND expo_source_operation_id IS NOT NULL
          AND expo_mode IS NOT NULL
          AND expo_mode = 'Enabled'
          AND expo_source_operation_id = kitchen_work_lifecycle_operation_id
          AND expo_source_occurred_at = occurred_at
        )
        OR (
          outcome = 'CompletedAndOrderItemReady'
          AND after_work_item_status = 'Completed'
          AND completed_quantity = required_quantity
          AND automatic_child_operation_id IS NOT NULL
          AND ready_result_id IS NOT NULL
          AND expo_source_operation_id IS NOT NULL
          AND expo_mode IS NOT NULL
          AND expo_mode = 'Disabled'
          AND expo_source_operation_id = kitchen_work_lifecycle_operation_id
          AND expo_source_occurred_at = occurred_at
        )
      )
    )
    OR (
      action_code = 'KITCHEN_ORDER_ITEM_READY'
      AND purpose = 'KitchenExpoCoordination'
      AND outcome = 'OrderItemReady'
      AND ready_result_id IS NOT NULL
      AND automatic_child_operation_id IS NULL
      AND outbox_event_id IS NULL
      AND event_semantic_digest IS NULL
      AND (
        (
          reason_code = 'EXPO_MARKED_READY'
          AND actor_type = 'User'
          AND kitchen_work_item_id IS NULL
          AND expected_ticket_version IS NOT NULL
          AND result_ticket_version = expected_ticket_version + 1
          AND expected_work_item_version IS NOT NULL
          AND result_work_item_version IS NOT NULL
          AND result_work_item_version = expected_work_item_version
          AND before_work_item_status IS NOT NULL
          AND after_work_item_status IS NOT NULL
          AND before_work_item_status = 'Completed'
          AND after_work_item_status = 'Completed'
          AND quantity_delta IS NULL
          AND completed_quantity = required_quantity
          AND accepted_operation_id IS NULL
          AND started_operation_id IS NULL
          AND causation_operation_id IS NULL
          AND expo_source_operation_id IS NOT NULL
          AND expo_mode IS NOT NULL
          AND expo_mode = 'Enabled'
          AND expo_source_operation_id <> kitchen_work_lifecycle_operation_id
        )
        OR (
          reason_code = 'ALL_WORK_ITEMS_COMPLETED'
          AND actor_type = 'System'
          AND kitchen_work_item_id IS NULL
          AND expected_ticket_version IS NULL
          AND expected_work_item_version IS NULL
          AND result_work_item_version IS NULL
          AND before_work_item_status IS NULL
          AND after_work_item_status IS NULL
          AND quantity_delta IS NULL
          AND accepted_operation_id IS NULL
          AND started_operation_id IS NULL
          AND causation_operation_id IS NOT NULL
          AND expo_source_operation_id IS NULL
        )
      )
    )
  ),
  CONSTRAINT kitchen_work_lifecycle_operation_reference_distinct_check CHECK (
    kitchen_work_lifecycle_operation_id <> brand_id
    AND kitchen_work_lifecycle_operation_id <> store_id
    AND kitchen_work_lifecycle_operation_id <> kitchen_ticket_id
    AND kitchen_work_lifecycle_operation_id <> order_item_id
    AND (kitchen_work_item_id IS NULL OR kitchen_work_lifecycle_operation_id <> kitchen_work_item_id)
    AND (actor_id IS NULL OR kitchen_work_lifecycle_operation_id <> actor_id)
    AND kitchen_work_lifecycle_operation_id <> audit_id
    AND kitchen_work_lifecycle_operation_id <> correlation_id
    AND (outbox_event_id IS NULL OR kitchen_work_lifecycle_operation_id <> outbox_event_id)
    AND (outbox_event_id IS NULL OR correlation_id <> outbox_event_id)
    AND (
      idempotency_key IS NULL
      OR (
        idempotency_key <> kitchen_work_lifecycle_operation_id::text
        AND idempotency_key <> correlation_id::text
        AND (outbox_event_id IS NULL OR idempotency_key <> outbox_event_id::text)
      )
    )
    AND (accepted_operation_id IS NULL OR kitchen_work_lifecycle_operation_id <> accepted_operation_id)
    AND (started_operation_id IS NULL OR kitchen_work_lifecycle_operation_id <> started_operation_id)
    AND (
      automatic_child_operation_id IS NULL
      OR kitchen_work_lifecycle_operation_id <> automatic_child_operation_id
    )
    AND (ready_result_id IS NULL OR kitchen_work_lifecycle_operation_id <> ready_result_id)
    AND (causation_operation_id IS NULL OR kitchen_work_lifecycle_operation_id <> causation_operation_id)
    AND (admission_decision_id IS NULL OR kitchen_work_lifecycle_operation_id <> admission_decision_id)
    AND (expo_decision_id IS NULL OR kitchen_work_lifecycle_operation_id <> expo_decision_id)
  )
);

CREATE UNIQUE INDEX kitchen_work_lifecycle_operation_idempotency_unique
  ON rms_kitchen.kitchen_work_lifecycle_operation (brand_id, store_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX kitchen_work_lifecycle_operation_accept_unique
  ON rms_kitchen.kitchen_work_lifecycle_operation (
    brand_id,
    store_id,
    kitchen_ticket_id,
    kitchen_work_item_id
  )
  WHERE action_code = 'KITCHEN_WORK_ITEM_ACCEPTED';
CREATE UNIQUE INDEX kitchen_work_lifecycle_operation_start_unique
  ON rms_kitchen.kitchen_work_lifecycle_operation (
    brand_id,
    store_id,
    kitchen_ticket_id,
    kitchen_work_item_id
  )
  WHERE action_code = 'KITCHEN_WORK_ITEM_STARTED';
CREATE UNIQUE INDEX kitchen_work_lifecycle_operation_completion_version_unique
  ON rms_kitchen.kitchen_work_lifecycle_operation (
    brand_id,
    store_id,
    kitchen_ticket_id,
    kitchen_work_item_id,
    result_work_item_version
  )
  WHERE action_code = 'KITCHEN_WORK_ITEM_COMPLETION_RECORDED';
CREATE INDEX kitchen_work_lifecycle_operation_ticket_history_idx
  ON rms_kitchen.kitchen_work_lifecycle_operation (
    brand_id,
    store_id,
    kitchen_ticket_id,
    result_ticket_version,
    kitchen_work_lifecycle_operation_id
  );
CREATE INDEX kitchen_work_lifecycle_operation_ready_lookup_idx
  ON rms_kitchen.kitchen_work_lifecycle_operation (
    brand_id,
    store_id,
    kitchen_ticket_id,
    order_item_id,
    ready_result_id
  );

CREATE TABLE rms_kitchen.kitchen_order_item_ready_result (
  ready_result_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
  order_item_id platform_helpers.uuid_v7 NOT NULL,
  causal_operation_id platform_helpers.uuid_v7 NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('User', 'System')),
  actor_id platform_helpers.uuid_v7,
  work_items_json jsonb NOT NULL,
  work_items_digest text NOT NULL CHECK (work_items_digest ~ '^sha256:[0-9a-f]{64}$'),
  ready_quantity integer NOT NULL CHECK (ready_quantity BETWEEN 1 AND 999),
  required_quantity integer NOT NULL CHECK (required_quantity BETWEEN 1 AND 999),
  expo_source_operation_id platform_helpers.uuid_v7 NOT NULL,
  expo_source_action_code text NOT NULL CHECK (
    expo_source_action_code = 'KITCHEN_WORK_ITEM_COMPLETION_RECORDED'
  ),
  expo_source_expected_ticket_version bigint NOT NULL CHECK (
    expo_source_expected_ticket_version > 0
  ),
  expo_source_result_ticket_version bigint NOT NULL CHECK (expo_source_result_ticket_version > 0),
  expo_source_expected_work_item_version bigint NOT NULL CHECK (
    expo_source_expected_work_item_version > 0
  ),
  expo_source_result_work_item_version bigint NOT NULL CHECK (
    expo_source_result_work_item_version > 0
  ),
  expo_source_before_status text NOT NULL CHECK (expo_source_before_status = 'In Progress'),
  expo_source_after_status text NOT NULL CHECK (expo_source_after_status = 'Completed'),
  expo_source_completed_quantity integer NOT NULL CHECK (expo_source_completed_quantity > 0),
  expo_source_required_quantity integer NOT NULL CHECK (
    expo_source_required_quantity BETWEEN 1 AND 999
  ),
  expo_source_outcome text NOT NULL CHECK (
    expo_source_outcome IN ('Completed', 'CompletedAndOrderItemReady')
  ),
  expo_source_occurred_at timestamp with time zone NOT NULL,
  captured_expo_binding_digest text NOT NULL CHECK (
    captured_expo_binding_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  expo_decision_id platform_helpers.uuid_v7 NOT NULL,
  expo_decision_version integer NOT NULL CHECK (expo_decision_version > 0),
  expo_decision_digest text NOT NULL CHECK (expo_decision_digest ~ '^sha256:[0-9a-f]{64}$'),
  expo_producer_contract_version integer NOT NULL CHECK (expo_producer_contract_version = 1),
  expo_decision_purpose text NOT NULL CHECK (expo_decision_purpose = 'KitchenReadiness'),
  expo_mode text NOT NULL CHECK (expo_mode IN ('Enabled', 'Disabled')),
  expo_evaluated_at timestamp with time zone NOT NULL,
  expo_valid_until timestamp with time zone NOT NULL,
  ready_at timestamp with time zone NOT NULL,
  CONSTRAINT kitchen_order_item_ready_result_pkey
    PRIMARY KEY (brand_id, store_id, ready_result_id),
  CONSTRAINT kitchen_order_item_ready_result_order_item_unique
    UNIQUE (brand_id, store_id, kitchen_ticket_id, order_item_id),
  CONSTRAINT kitchen_order_item_ready_result_ticket_fk
    FOREIGN KEY (brand_id, store_id, kitchen_ticket_id)
    REFERENCES rms_kitchen.kitchen_ticket (brand_id, store_id, kitchen_ticket_id),
  CONSTRAINT kitchen_order_item_ready_result_causal_operation_fk
    FOREIGN KEY (
      brand_id,
      store_id,
      kitchen_ticket_id,
      order_item_id,
      causal_operation_id
    )
    REFERENCES rms_kitchen.kitchen_work_lifecycle_operation (
      brand_id,
      store_id,
      kitchen_ticket_id,
      order_item_id,
      kitchen_work_lifecycle_operation_id
    ),
  CONSTRAINT kitchen_order_item_ready_result_expo_source_fk
    FOREIGN KEY (
      brand_id,
      store_id,
      kitchen_ticket_id,
      order_item_id,
      expo_source_operation_id
    )
    REFERENCES rms_kitchen.kitchen_work_lifecycle_operation (
      brand_id,
      store_id,
      kitchen_ticket_id,
      order_item_id,
      kitchen_work_lifecycle_operation_id
    ),
  CONSTRAINT kitchen_order_item_ready_result_actor_shape_check CHECK (
    (actor_type = 'User' AND actor_id IS NOT NULL AND expo_mode = 'Enabled')
    OR (actor_type = 'System' AND actor_id IS NULL AND expo_mode = 'Disabled')
  ),
  CONSTRAINT kitchen_order_item_ready_result_work_items_shape_check CHECK (
    jsonb_typeof(work_items_json) = 'array'
    AND jsonb_array_length(work_items_json) = 1
    AND jsonb_typeof(work_items_json -> 0) = 'object'
    AND (work_items_json -> 0) ?& ARRAY['workItemReference', 'workItemVersion']
    AND jsonb_array_length(jsonb_path_query_array(work_items_json -> 0, '$.*')) = 2
    AND jsonb_typeof(work_items_json -> 0 -> 'workItemReference') = 'string'
    AND jsonb_typeof(work_items_json -> 0 -> 'workItemVersion') = 'string'
    AND work_items_json -> 0 ->> 'workItemReference'
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND work_items_json -> 0 ->> 'workItemVersion' ~ '^[1-9][0-9]*$'
    AND (
      char_length(work_items_json -> 0 ->> 'workItemVersion') < 19
      OR (
        char_length(work_items_json -> 0 ->> 'workItemVersion') = 19
        AND work_items_json -> 0 ->> 'workItemVersion' <= '9223372036854775807'
      )
    )
  ),
  CONSTRAINT kitchen_order_item_ready_result_quantity_check CHECK (
    ready_quantity = required_quantity
    AND expo_source_completed_quantity = expo_source_required_quantity
    AND ready_quantity = expo_source_required_quantity
  ),
  CONSTRAINT kitchen_order_item_ready_result_expo_shape_check CHECK (
    expo_source_result_ticket_version = expo_source_expected_ticket_version + 1
    AND expo_source_result_work_item_version = expo_source_expected_work_item_version + 1
    AND expo_evaluated_at <= expo_source_occurred_at
    AND expo_source_occurred_at < expo_valid_until
    AND expo_source_occurred_at <= ready_at
    AND (
      (expo_mode = 'Enabled' AND expo_source_outcome = 'Completed')
      OR (expo_mode = 'Disabled' AND expo_source_outcome = 'CompletedAndOrderItemReady')
    )
  ),
  CONSTRAINT kitchen_order_item_ready_result_reference_distinct_check CHECK (
    ready_result_id <> brand_id
    AND ready_result_id <> store_id
    AND ready_result_id <> kitchen_ticket_id
    AND ready_result_id <> order_item_id
    AND ready_result_id <> causal_operation_id
    AND ready_result_id <> expo_source_operation_id
    AND causal_operation_id <> expo_source_operation_id
    AND (actor_id IS NULL OR ready_result_id <> actor_id)
    AND ready_result_id <> expo_decision_id
    AND ready_result_id <> (work_items_json -> 0 ->> 'workItemReference')::uuid
  )
);

CREATE INDEX kitchen_order_item_ready_result_history_idx
  ON rms_kitchen.kitchen_order_item_ready_result (
    brand_id,
    store_id,
    kitchen_ticket_id,
    ready_at,
    ready_result_id
  );

CREATE FUNCTION rms_kitchen.reject_kitchen_work_lifecycle_append_only_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'kitchen work lifecycle evidence is append-only'
    USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION rms_kitchen.reject_kitchen_work_lifecycle_append_only_update()
  FROM PUBLIC;
CREATE TRIGGER kitchen_work_lifecycle_operation_no_update_trigger
  BEFORE UPDATE ON rms_kitchen.kitchen_work_lifecycle_operation
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_lifecycle_append_only_update();
CREATE TRIGGER kitchen_order_item_ready_result_no_update_trigger
  BEFORE UPDATE ON rms_kitchen.kitchen_order_item_ready_result
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_lifecycle_append_only_update();
CREATE RULE kitchen_work_lifecycle_operation_no_delete AS
  ON DELETE TO rms_kitchen.kitchen_work_lifecycle_operation DO INSTEAD NOTHING;
CREATE RULE kitchen_order_item_ready_result_no_delete AS
  ON DELETE TO rms_kitchen.kitchen_order_item_ready_result DO INSTEAD NOTHING;

ALTER TABLE rms_kitchen.kitchen_work_lifecycle_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_work_lifecycle_operation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_order_item_ready_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_order_item_ready_result FORCE ROW LEVEL SECURITY;

CREATE POLICY kitchen_work_lifecycle_operation_store_scope_policy
  ON rms_kitchen.kitchen_work_lifecycle_operation
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY kitchen_order_item_ready_result_store_scope_policy
  ON rms_kitchen.kitchen_order_item_ready_result
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_kitchen.kitchen_work_lifecycle_operation FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.kitchen_order_item_ready_result FROM PUBLIC;
