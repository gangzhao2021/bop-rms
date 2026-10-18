-- bop-rms-migration: 1
-- owner: shared-infrastructure/eventing
-- schema: platform_eventing
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (2026-10-18; Owner standing approval 2026-10-14): once the cause of a consumer failure
-- is fixed, platform support can bring retries still waiting out their backoff forward to now
-- (tooling/environment/consumer-retry-operations.mjs retry-now) instead of leaving the monitor's
-- "Some order updates are being retried" alert up for up to half an hour. Each retry brought
-- forward gets one append-only record of who did it, under which permission, purpose and reason,
-- and the time it was due before; the retry itself keeps its event, attempt count, deadline and
-- state. A repeated request with the same idempotency key is recognised and changes nothing.
-- New table only: no existing row is changed, no grant is added (the tool runs as the migration
-- role; no runtime role reads or writes this table).
CREATE TABLE platform_eventing.consumer_retry_expedite_action (
  action_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  scope_store_key text GENERATED ALWAYS AS (COALESCE(store_id::text, 'brand')) STORED,
  schedule_id platform_helpers.uuid_v7 NOT NULL,
  event_id platform_helpers.uuid_v7 NOT NULL,
  consumer_name text NOT NULL CHECK (
    consumer_name ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*[:]v[1-9][0-9]*$'
  ),
  -- The consumer the request named; NULL when it covered every consumer of the scope.
  requested_consumer_name text CHECK (
    requested_consumer_name ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*[:]v[1-9][0-9]*$'
  ),
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 1 AND 8),
  previous_available_at timestamp with time zone NOT NULL,
  expedited_available_at timestamp with time zone NOT NULL,
  deadline_at timestamp with time zone NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  permission_code text NOT NULL CHECK (permission_code = 'EVENTING_DEAD_LETTER_RETRY'),
  purpose_code text NOT NULL CHECK (purpose_code = 'RELIABILITY_RECOVERY'),
  reason_code text NOT NULL CHECK (reason_code = 'DEPENDENCY_RECOVERED'),
  idempotency_key platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT consumer_retry_expedite_action_request_check CHECK (
    requested_consumer_name IS NULL OR requested_consumer_name = consumer_name
  ),
  CONSTRAINT consumer_retry_expedite_action_time_check CHECK (
    expedited_available_at < previous_available_at
    AND previous_available_at <= deadline_at
  ),
  CONSTRAINT consumer_retry_expedite_action_idempotency_unique
    UNIQUE NULLS NOT DISTINCT (brand_id, store_id, idempotency_key, schedule_id),
  CONSTRAINT consumer_retry_expedite_action_schedule_fkey
    FOREIGN KEY (schedule_id)
    REFERENCES platform_eventing.consumer_retry_schedule (schedule_id)
);

CREATE RULE consumer_retry_expedite_action_no_update AS
  ON UPDATE TO platform_eventing.consumer_retry_expedite_action DO INSTEAD NOTHING;
CREATE RULE consumer_retry_expedite_action_no_delete AS
  ON DELETE TO platform_eventing.consumer_retry_expedite_action DO INSTEAD NOTHING;

ALTER TABLE platform_eventing.consumer_retry_expedite_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_eventing.consumer_retry_expedite_action FORCE ROW LEVEL SECURITY;

CREATE POLICY consumer_retry_expedite_action_tenant_scope
  ON platform_eventing.consumer_retry_expedite_action
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

REVOKE ALL ON TABLE platform_eventing.consumer_retry_expedite_action FROM PUBLIC;
