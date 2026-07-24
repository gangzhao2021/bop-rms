-- bop-rms-migration: 1
-- owner: shared-infrastructure/eventing
-- schema: platform_eventing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE platform_eventing.consumer_inbox (
  consumer_name text NOT NULL,
  event_id platform_helpers.uuid_v7 NOT NULL,
  event_type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  received_at timestamp with time zone NOT NULL DEFAULT statement_timestamp(),
  processed_at timestamp with time zone,
  status text NOT NULL CHECK (status IN ('processing', 'completed')),
  attempt_count integer NOT NULL CHECK (attempt_count = 1),
  result_hash text,
  last_error_code text CHECK (last_error_code IS NULL),
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT consumer_inbox_pkey PRIMARY KEY (consumer_name, event_id),
  CONSTRAINT consumer_inbox_name_check CHECK (
    consumer_name ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*[:]v[1-9][0-9]*$'
  ),
  CONSTRAINT consumer_inbox_event_type_check CHECK (event_type ~ '^[A-Z][A-Za-z0-9]{0,127}$'),
  CONSTRAINT consumer_inbox_completion_check CHECK (
    (status = 'processing' AND processed_at IS NULL AND result_hash IS NULL)
    OR (status = 'completed' AND processed_at IS NOT NULL)
  ),
  CONSTRAINT consumer_inbox_result_hash_check CHECK (
    result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX consumer_inbox_tenant_received_idx
  ON platform_eventing.consumer_inbox (brand_id, received_at, consumer_name, event_id);

ALTER TABLE platform_eventing.consumer_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.consumer_inbox FORCE ROW LEVEL SECURITY;

CREATE POLICY consumer_inbox_tenant_scope
  ON platform_eventing.consumer_inbox
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

REVOKE ALL ON TABLE platform_eventing.consumer_inbox FROM PUBLIC;
