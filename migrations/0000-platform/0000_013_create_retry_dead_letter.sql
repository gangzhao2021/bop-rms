-- bop-rms-migration: 1
-- owner: shared-infrastructure/eventing
-- schema: platform_eventing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE platform_eventing.delivery_attempt (
  attempt_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  scope_store_key text GENERATED ALWAYS AS (COALESCE(store_id::text, 'brand')) STORED,
  delivery_path text NOT NULL CHECK (delivery_path IN ('outbox', 'consumer')),
  event_id platform_helpers.uuid_v7 NOT NULL,
  consumer_name text,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 0 AND 8),
  failure_class text NOT NULL CHECK (
    failure_class IN (
      'retryable',
      'non_retryable',
      'commit_unknown',
      'ordering_gap',
      'exhausted',
      'operator_held'
    )
  ),
  safe_code text NOT NULL CHECK (safe_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  policy_name text NOT NULL CHECK (policy_name = 'eventing_default'),
  policy_version integer NOT NULL CHECK (policy_version = 1),
  decision text NOT NULL CHECK (
    decision IN ('retry_scheduled', 'dead_lettered', 'reconciliation_required')
  ),
  next_available_at timestamp with time zone,
  deadline_at timestamp with time zone NOT NULL,
  idempotency_key platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT delivery_attempt_consumer_shape_check CHECK (
    (delivery_path = 'outbox' AND consumer_name IS NULL)
    OR (
      delivery_path = 'consumer'
      AND consumer_name ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*[:]v[1-9][0-9]*$'
    )
  ),
  CONSTRAINT delivery_attempt_schedule_shape_check CHECK (
    (decision = 'retry_scheduled' AND next_available_at IS NOT NULL)
    OR (decision <> 'retry_scheduled' AND next_available_at IS NULL)
  ),
  CONSTRAINT delivery_attempt_time_check CHECK (
    (
      decision = 'retry_scheduled'
      AND deadline_at >= recorded_at
      AND next_available_at <= deadline_at
    )
    OR (decision <> 'retry_scheduled' AND next_available_at IS NULL)
  ),
  CONSTRAINT delivery_attempt_idempotency_unique
    UNIQUE NULLS NOT DISTINCT (
      brand_id,
      store_id,
      delivery_path,
      event_id,
      consumer_name,
      idempotency_key
    ),
  CONSTRAINT delivery_attempt_scoped_reference_unique
    UNIQUE NULLS NOT DISTINCT (
      attempt_id,
      brand_id,
      scope_store_key,
      event_id,
      consumer_name
    )
);

CREATE INDEX delivery_attempt_scope_schedule_idx
  ON platform_eventing.delivery_attempt (
    brand_id,
    store_id,
    next_available_at,
    recorded_at,
    attempt_id
  )
  WHERE decision = 'retry_scheduled';

CREATE TABLE platform_eventing.consumer_retry_schedule (
  schedule_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  scope_store_key text GENERATED ALWAYS AS (COALESCE(store_id::text, 'brand')) STORED,
  event_id platform_helpers.uuid_v7 NOT NULL,
  consumer_name text NOT NULL CHECK (
    consumer_name ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*[:]v[1-9][0-9]*$'
  ),
  source_attempt_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 1 AND 8),
  available_at timestamp with time zone NOT NULL,
  deadline_at timestamp with time zone NOT NULL,
  state text NOT NULL CHECK (
    state IN ('scheduled', 'claimed', 'completed', 'dead_lettered')
  ),
  lease_token platform_helpers.uuid_v7,
  lease_owner text,
  lease_expires_at timestamp with time zone,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  CONSTRAINT consumer_retry_schedule_identity_unique
    UNIQUE NULLS NOT DISTINCT (brand_id, store_id, consumer_name, event_id),
  CONSTRAINT consumer_retry_schedule_attempt_scope_fkey
    FOREIGN KEY (
      source_attempt_id,
      brand_id,
      scope_store_key,
      event_id,
      consumer_name
    )
    REFERENCES platform_eventing.delivery_attempt (
      attempt_id,
      brand_id,
      scope_store_key,
      event_id,
      consumer_name
    ),
  CONSTRAINT consumer_retry_schedule_time_check CHECK (
    available_at <= deadline_at
  ),
  CONSTRAINT consumer_retry_schedule_lease_shape_check CHECK (
    (
      state <> 'claimed'
      AND lease_token IS NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
    OR (
      state = 'claimed'
      AND lease_token IS NOT NULL
      AND lease_owner ~ '^[a-z][a-z0-9_-]{0,63}$'
      AND lease_expires_at IS NOT NULL
    )
  )
);

CREATE INDEX consumer_retry_schedule_claim_idx
  ON platform_eventing.consumer_retry_schedule (
    brand_id,
    store_id,
    available_at,
    schedule_id
  )
  WHERE state = 'scheduled';

CREATE TABLE platform_eventing.dead_letter_item (
  dead_letter_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  scope_store_key text GENERATED ALWAYS AS (COALESCE(store_id::text, 'brand')) STORED,
  delivery_path text NOT NULL CHECK (delivery_path IN ('outbox', 'consumer')),
  event_id platform_helpers.uuid_v7 NOT NULL,
  consumer_name text,
  failure_class text NOT NULL CHECK (
    failure_class IN ('non_retryable', 'exhausted', 'operator_held')
  ),
  safe_code text NOT NULL CHECK (safe_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 0 AND 8),
  policy_name text NOT NULL CHECK (policy_name = 'eventing_default'),
  policy_version integer NOT NULL CHECK (policy_version = 1),
  status text NOT NULL CHECK (
    status IN ('open', 'retry_scheduled', 'discarded', 'resolved')
  ),
  resolution_kind text CHECK (
    resolution_kind IN ('retry_completed', 'discard_released')
  ),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  opened_at timestamp with time zone NOT NULL DEFAULT statement_timestamp(),
  resolved_at timestamp with time zone,
  CONSTRAINT dead_letter_item_consumer_shape_check CHECK (
    (delivery_path = 'outbox' AND consumer_name IS NULL)
    OR (
      delivery_path = 'consumer'
      AND consumer_name ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*[:]v[1-9][0-9]*$'
    )
  ),
  CONSTRAINT dead_letter_item_lifecycle_check CHECK (
    (status <> 'resolved' AND resolution_kind IS NULL AND resolved_at IS NULL)
    OR (status = 'resolved' AND resolution_kind IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT dead_letter_item_identity_unique
    UNIQUE NULLS NOT DISTINCT (
      brand_id,
      store_id,
      delivery_path,
      event_id,
      consumer_name
    ),
  CONSTRAINT dead_letter_item_scoped_reference_unique
    UNIQUE (dead_letter_id, brand_id, scope_store_key)
);

CREATE INDEX dead_letter_item_scope_status_idx
  ON platform_eventing.dead_letter_item (
    brand_id,
    store_id,
    status,
    opened_at,
    dead_letter_id
  );

CREATE TABLE platform_eventing.dead_letter_action (
  action_id platform_helpers.uuid_v7 PRIMARY KEY,
  dead_letter_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  scope_store_key text GENERATED ALWAYS AS (COALESCE(store_id::text, 'brand')) STORED,
  action text NOT NULL CHECK (
    action IN ('retry', 'discard', 'release', 'resolve_retry')
  ),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  permission_code text NOT NULL CHECK (
    permission_code IN (
      'EVENTING_DEAD_LETTER_RETRY',
      'EVENTING_DEAD_LETTER_DISCARD'
    )
  ),
  purpose_code text NOT NULL CHECK (purpose_code = 'RELIABILITY_RECOVERY'),
  reason_code text NOT NULL CHECK (
    reason_code IN (
      'TRANSIENT_RECOVERED',
      'DEPENDENCY_RECOVERED',
      'AUTHORIZED_DISCARD',
      'ORDERING_RELEASE'
    )
  ),
  expected_version bigint NOT NULL CHECK (expected_version >= 0),
  idempotency_key platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT dead_letter_action_idempotency_unique
    UNIQUE NULLS NOT DISTINCT (brand_id, store_id, idempotency_key),
  CONSTRAINT dead_letter_action_item_scope_fkey
    FOREIGN KEY (dead_letter_id, brand_id, scope_store_key)
    REFERENCES platform_eventing.dead_letter_item (
      dead_letter_id,
      brand_id,
      scope_store_key
    )
);

ALTER TABLE platform_eventing.delivery_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.delivery_attempt FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.consumer_retry_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.consumer_retry_schedule FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.dead_letter_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.dead_letter_item FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.dead_letter_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.dead_letter_action FORCE ROW LEVEL SECURITY;

CREATE POLICY delivery_attempt_tenant_scope
  ON platform_eventing.delivery_attempt
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND (
      (store_id IS NULL AND platform_helpers.current_store_id() IS NULL)
      OR store_id = platform_helpers.current_store_id()
    )
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND (
      (store_id IS NULL AND platform_helpers.current_store_id() IS NULL)
      OR store_id = platform_helpers.current_store_id()
    )
  );

CREATE POLICY consumer_retry_schedule_tenant_scope
  ON platform_eventing.consumer_retry_schedule
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND (
      (store_id IS NULL AND platform_helpers.current_store_id() IS NULL)
      OR store_id = platform_helpers.current_store_id()
    )
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND (
      (store_id IS NULL AND platform_helpers.current_store_id() IS NULL)
      OR store_id = platform_helpers.current_store_id()
    )
  );

CREATE POLICY dead_letter_item_tenant_scope
  ON platform_eventing.dead_letter_item
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND (
      (store_id IS NULL AND platform_helpers.current_store_id() IS NULL)
      OR store_id = platform_helpers.current_store_id()
    )
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND (
      (store_id IS NULL AND platform_helpers.current_store_id() IS NULL)
      OR store_id = platform_helpers.current_store_id()
    )
  );

CREATE POLICY dead_letter_action_tenant_scope
  ON platform_eventing.dead_letter_action
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND (
      (store_id IS NULL AND platform_helpers.current_store_id() IS NULL)
      OR store_id = platform_helpers.current_store_id()
    )
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND (
      (store_id IS NULL AND platform_helpers.current_store_id() IS NULL)
      OR store_id = platform_helpers.current_store_id()
    )
  );

REVOKE ALL ON TABLE
  platform_eventing.delivery_attempt,
  platform_eventing.consumer_retry_schedule,
  platform_eventing.dead_letter_item,
  platform_eventing.dead_letter_action
FROM PUBLIC;

ALTER TABLE platform_eventing.outbox_event
  ADD COLUMN ordering_released_at timestamp with time zone;
