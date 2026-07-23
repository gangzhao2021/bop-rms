-- bop-rms-migration: 1
-- owner: shared-infrastructure/eventing
-- schema: platform_eventing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE platform_eventing.outbox_event (
  event_id platform_helpers.uuid_v7 PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type ~ '^[A-Z][A-Za-z0-9]*$'),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  producer_module text NOT NULL CHECK (producer_module ~ '^@(bop|rms)/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$'),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[A-Z][A-Za-z0-9]*$'),
  aggregate_id platform_helpers.uuid_v7 NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  causation_id platform_helpers.uuid_v7,
  actor_type text NOT NULL CHECK (actor_type IN ('Actor', 'System')),
  actor_id platform_helpers.uuid_v7,
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  redaction_classification text NOT NULL CHECK (
    redaction_classification IN (
      'none',
      'indirect_identifier',
      'personal',
      'sensitive_personal',
      'payment',
      'health',
      'credential'
    )
  ),
  replay_metadata_json jsonb NOT NULL CHECK (jsonb_typeof(replay_metadata_json) = 'object'),
  occurred_at timestamp with time zone NOT NULL,
  recorded_at timestamp with time zone NOT NULL DEFAULT statement_timestamp(),
  available_at timestamp with time zone NOT NULL,
  published_at timestamp with time zone,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  CONSTRAINT outbox_event_actor_shape_check CHECK (
    (actor_type = 'System' AND actor_id IS NULL)
    OR (actor_type = 'Actor' AND actor_id IS NOT NULL)
  ),
  CONSTRAINT outbox_event_published_time_check CHECK (
    published_at IS NULL OR published_at >= recorded_at
  ),
  CONSTRAINT outbox_event_last_error_code_shape_check CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,127}$'
  )
);

CREATE INDEX outbox_event_publishable_idx
  ON platform_eventing.outbox_event (brand_id, available_at, recorded_at, event_id)
  WHERE published_at IS NULL;

CREATE INDEX outbox_event_aggregate_order_idx
  ON platform_eventing.outbox_event (
    brand_id,
    aggregate_type,
    aggregate_id,
    aggregate_version,
    event_id
  );

CREATE INDEX outbox_event_correlation_idx
  ON platform_eventing.outbox_event (brand_id, correlation_id, recorded_at, event_id);

ALTER TABLE platform_eventing.outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.outbox_event FORCE ROW LEVEL SECURITY;

CREATE POLICY outbox_event_tenant_scope
  ON platform_eventing.outbox_event
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id())
  );

REVOKE ALL ON TABLE platform_eventing.outbox_event FROM PUBLIC;
