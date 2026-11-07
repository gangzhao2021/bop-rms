-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_cancellation_request_version (
  request_id platform_helpers.uuid_v7 NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version BETWEEN 1 AND 3),
  operation_id platform_helpers.uuid_v7 NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  expected_order_version integer NOT NULL CHECK (expected_order_version > 0),
  requested_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  requested_by_actor_type text NOT NULL CHECK (requested_by_actor_type IN ('GuestSession','User')),
  request_reason_code text NOT NULL CHECK (request_reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  requested_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('Requested','Approved','Rejected','Executed')),
  decided_by_actor_id platform_helpers.uuid_v7,
  decision_reason_code text CHECK (decision_reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  execution_id platform_helpers.uuid_v7,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (request_id,aggregate_version),
  UNIQUE (brand_id,store_id,operation_id),
  FOREIGN KEY (order_id,brand_id,store_id) REFERENCES rms_ordering.order_header(order_id,brand_id,store_id),
  FOREIGN KEY (execution_id) REFERENCES rms_ordering.order_termination_record(termination_id),
  CHECK (occurred_at >= requested_at),
  CHECK (isfinite(requested_at) AND requested_at=date_trunc('milliseconds',requested_at)),
  CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
  CHECK ((status='Requested' AND aggregate_version=1 AND occurred_at=requested_at
    AND decided_by_actor_id IS NULL AND decision_reason_code IS NULL)
    OR (status<>'Requested' AND aggregate_version>1 AND decided_by_actor_id IS NOT NULL AND decision_reason_code IS NOT NULL)),
  CHECK ((status='Executed')=(execution_id IS NOT NULL))
);
CREATE INDEX order_cancellation_request_order_idx ON rms_ordering.order_cancellation_request_version
  (brand_id,store_id,order_id,request_id,aggregate_version DESC);
CREATE FUNCTION rms_ordering.validate_order_cancellation_request_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous rms_ordering.order_cancellation_request_version%ROWTYPE;
BEGIN
  -- Shared parent lock serializes requests with closure readers and FK-bound writes.
  PERFORM order_id FROM rms_ordering.order_header WHERE order_id=NEW.order_id
    AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND created_at<=NEW.requested_at FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid cancellation order' USING ERRCODE='23514'; END IF;
  SELECT * INTO previous FROM rms_ordering.order_cancellation_request_version
    WHERE request_id=NEW.request_id ORDER BY aggregate_version DESC LIMIT 1;
  IF previous.request_id IS NULL THEN
    IF NEW.aggregate_version<>1 OR NEW.status<>'Requested' OR EXISTS (
      SELECT 1 FROM (SELECT DISTINCT ON (request_id) status
        FROM rms_ordering.order_cancellation_request_version
        WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id
        ORDER BY request_id,aggregate_version DESC) current_requests
      WHERE status IN ('Requested','Approved')
    ) THEN RAISE EXCEPTION 'invalid cancellation request' USING ERRCODE='23514'; END IF;
  ELSE
    IF NEW.aggregate_version<>previous.aggregate_version+1
      OR ROW(NEW.request_id,NEW.tenant_id,NEW.brand_id,NEW.store_id,NEW.order_id,
        NEW.requested_by_actor_id,NEW.requested_by_actor_type,NEW.request_reason_code,NEW.requested_at)
        IS DISTINCT FROM ROW(previous.request_id,previous.tenant_id,previous.brand_id,previous.store_id,previous.order_id,
        previous.requested_by_actor_id,previous.requested_by_actor_type,previous.request_reason_code,previous.requested_at)
      OR NEW.occurred_at<previous.occurred_at OR NEW.expected_order_version<previous.expected_order_version
      OR NOT ((previous.status='Requested' AND NEW.status IN ('Approved','Rejected'))
        OR (previous.status='Approved' AND NEW.status='Executed'))
    THEN RAISE EXCEPTION 'invalid cancellation transition' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.status='Executed' AND NOT EXISTS (
    SELECT 1 FROM rms_ordering.order_termination_record WHERE termination_id=NEW.execution_id
      AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id
      AND phase='Cancelled' AND expected_order_version=NEW.expected_order_version
      AND terminated_at>=NEW.requested_at AND terminated_at<=NEW.occurred_at
  ) THEN RAISE EXCEPTION 'missing cancellation execution' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_cancellation_request_version() FROM PUBLIC;
CREATE TRIGGER order_cancellation_request_validate BEFORE INSERT
  ON rms_ordering.order_cancellation_request_version FOR EACH ROW
  EXECUTE FUNCTION rms_ordering.validate_order_cancellation_request_version();
CREATE FUNCTION rms_ordering.reject_order_cancellation_request_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'append-only cancellation history' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_cancellation_request_mutation() FROM PUBLIC;
CREATE TRIGGER order_cancellation_request_no_mutation BEFORE UPDATE OR DELETE
  ON rms_ordering.order_cancellation_request_version FOR EACH ROW
  EXECUTE FUNCTION rms_ordering.reject_order_cancellation_request_mutation();
CREATE TRIGGER order_cancellation_request_no_truncate BEFORE TRUNCATE
  ON rms_ordering.order_cancellation_request_version FOR EACH STATEMENT
  EXECUTE FUNCTION rms_ordering.reject_order_cancellation_request_mutation();
ALTER TABLE rms_ordering.order_cancellation_request_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_cancellation_request_version FORCE ROW LEVEL SECURITY;
CREATE POLICY order_cancellation_request_scope ON rms_ordering.order_cancellation_request_version
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_cancellation_request_version FROM PUBLIC;
