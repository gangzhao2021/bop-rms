-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.payment_status_projection (
  projection_generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  payment_intent_id platform_helpers.uuid_v7 NOT NULL,
  payment_transaction_id platform_helpers.uuid_v7 NOT NULL,
  payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  terminal_status text NOT NULL CHECK (terminal_status IN ('Succeeded', 'Failed')),
  amount_minor bigint,
  currency_code text,
  failure_reason text CHECK (
    failure_reason IN ('Declined', 'AuthenticationRequired', 'Cancelled', 'ProviderRejected')
  ),
  retry_disposition text CHECK (
    retry_disposition IN ('Never', 'SameOperation', 'NewOperation', 'Unknown')
  ),
  terminal_occurred_at timestamp with time zone NOT NULL,
  source_event_id platform_helpers.uuid_v7 NOT NULL,
  source_aggregate_version bigint NOT NULL CHECK (source_aggregate_version = 2),
  projection_name text NOT NULL CHECK (projection_name = 'payment_status_v1'),
  projection_version integer NOT NULL CHECK (projection_version = 1),
  projected_at timestamp with time zone NOT NULL,
  last_rebuilt_at timestamp with time zone,
  freshness_status text NOT NULL CHECK (
    freshness_status IN ('Fresh', 'Stale', 'Rebuilding', 'Failed')
  ),
  is_active boolean NOT NULL DEFAULT false,
  PRIMARY KEY (projection_generation_id, payment_intent_id),
  CONSTRAINT payment_status_projection_source_generation_unique
    UNIQUE (projection_generation_id, source_event_id),
  CONSTRAINT payment_status_projection_source_fk
    FOREIGN KEY (source_event_id)
    REFERENCES rms_payment.payment_terminal_fact (event_id),
  CONSTRAINT payment_status_projection_shape_check CHECK (
    (
      terminal_status = 'Succeeded'
      AND amount_minor > 0
      AND currency_code = 'CAD'
      AND failure_reason IS NULL
      AND retry_disposition IS NULL
    ) OR (
      terminal_status = 'Failed'
      AND amount_minor IS NULL
      AND currency_code IS NULL
      AND failure_reason IS NOT NULL
      AND retry_disposition IS NOT NULL
    )
  ),
  CONSTRAINT payment_status_projection_time_check CHECK (
    terminal_occurred_at <= projected_at
    AND (last_rebuilt_at IS NULL OR terminal_occurred_at <= last_rebuilt_at)
  )
);

CREATE UNIQUE INDEX payment_status_projection_active_intent_unique
  ON rms_payment.payment_status_projection (brand_id, store_id, payment_intent_id)
  WHERE is_active;
CREATE INDEX payment_status_projection_store_status_idx
  ON rms_payment.payment_status_projection
    (brand_id, store_id, terminal_status, terminal_occurred_at DESC, payment_intent_id)
  WHERE is_active;
CREATE INDEX payment_status_projection_order_idx
  ON rms_payment.payment_status_projection
    (brand_id, store_id, order_id, terminal_occurred_at DESC, payment_intent_id)
  WHERE is_active;

CREATE FUNCTION rms_payment.enforce_payment_status_projection_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.projection_generation_id, NEW.brand_id, NEW.store_id, NEW.payment_intent_id,
    NEW.payment_transaction_id, NEW.payment_attempt_id, NEW.order_id, NEW.terminal_status,
    NEW.amount_minor, NEW.currency_code, NEW.failure_reason, NEW.retry_disposition,
    NEW.terminal_occurred_at, NEW.source_event_id, NEW.source_aggregate_version,
    NEW.projection_name, NEW.projection_version, NEW.projected_at, NEW.last_rebuilt_at
  ) IS DISTINCT FROM ROW(
    OLD.projection_generation_id, OLD.brand_id, OLD.store_id, OLD.payment_intent_id,
    OLD.payment_transaction_id, OLD.payment_attempt_id, OLD.order_id, OLD.terminal_status,
    OLD.amount_minor, OLD.currency_code, OLD.failure_reason, OLD.retry_disposition,
    OLD.terminal_occurred_at, OLD.source_event_id, OLD.source_aggregate_version,
    OLD.projection_name, OLD.projection_version, OLD.projected_at, OLD.last_rebuilt_at
  ) THEN
    RAISE EXCEPTION 'payment status projection snapshot is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_status_projection_update_guard
BEFORE UPDATE ON rms_payment.payment_status_projection
FOR EACH ROW EXECUTE FUNCTION rms_payment.enforce_payment_status_projection_update();

ALTER TABLE rms_payment.payment_status_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_status_projection FORCE ROW LEVEL SECURITY;

CREATE POLICY payment_status_projection_store_scope_policy
  ON rms_payment.payment_status_projection
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_payment.payment_status_projection FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_payment.enforce_payment_status_projection_update() FROM PUBLIC;
