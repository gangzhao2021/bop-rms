-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA rms_payment;
REVOKE ALL ON SCHEMA rms_payment FROM PUBLIC;

CREATE TABLE rms_payment.payment_intent (
  payment_intent_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  payment_operation_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  submission_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  source_cart_id platform_helpers.uuid_v7 NOT NULL,
  source_cart_version integer NOT NULL CHECK (source_cart_version > 0),
  quote_id platform_helpers.uuid_v7 NOT NULL,
  preparation_id platform_helpers.uuid_v7 NOT NULL,
  capacity_allocation_id platform_helpers.uuid_v7 NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  preparation_source_digest text NOT NULL
    CHECK (preparation_source_digest ~ '^sha256:[0-9a-f]{64}$'),
  order_allocation_minor bigint NOT NULL CHECK (order_allocation_minor > 0),
  tip_minor bigint NOT NULL CHECK (tip_minor >= 0),
  total_minor bigint NOT NULL CHECK (
    total_minor > 0 AND total_minor = order_allocation_minor + tip_minor
  ),
  currency_code text NOT NULL CHECK (currency_code = 'CAD'),
  payment_method text NOT NULL CHECK (payment_method = 'OnlineCard'),
  capture_mode text NOT NULL CHECK (capture_mode = 'Automatic'),
  aggregate_version integer NOT NULL CHECK (aggregate_version = 1),
  creation_status text NOT NULL CHECK (creation_status = 'ProviderCreatePending'),
  prepared_at timestamp with time zone NOT NULL,
  capacity_expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL CHECK (
    prepared_at <= created_at
    AND capacity_expires_at = created_at + interval '30 minutes'
  ),
  CONSTRAINT payment_intent_scope_identity_unique
    UNIQUE (payment_intent_id, brand_id, store_id),
  CONSTRAINT payment_intent_operation_unique
    UNIQUE (payment_operation_id, brand_id, store_id),
  CONSTRAINT payment_intent_preparation_unique
    UNIQUE (preparation_id, brand_id, store_id)
);

CREATE TABLE rms_payment.payment_attempt (
  payment_attempt_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  payment_intent_id platform_helpers.uuid_v7 NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number = 1),
  provider text NOT NULL CHECK (provider = 'Stripe'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('Test', 'Live')),
  provider_idempotency_digest text NOT NULL
    CHECK (provider_idempotency_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT payment_attempt_scope_identity_unique
    UNIQUE (payment_attempt_id, payment_intent_id, brand_id, store_id),
  CONSTRAINT payment_attempt_number_unique UNIQUE (payment_intent_id, attempt_number),
  CONSTRAINT payment_attempt_intent_fk
    FOREIGN KEY (payment_intent_id, brand_id, store_id)
    REFERENCES rms_payment.payment_intent (payment_intent_id, brand_id, store_id)
);

CREATE TABLE rms_payment.payment_intent_operation_record (
  payment_operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  payment_intent_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT payment_intent_operation_scope_unique
    UNIQUE (payment_operation_id, payment_intent_id, brand_id, store_id),
  CONSTRAINT payment_intent_operation_intent_unique UNIQUE (payment_intent_id),
  CONSTRAINT payment_intent_operation_intent_fk
    FOREIGN KEY (payment_intent_id, brand_id, store_id)
    REFERENCES rms_payment.payment_intent (payment_intent_id, brand_id, store_id)
);

CREATE TABLE rms_payment.payment_provider_observation (
  provider_observation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  payment_intent_id platform_helpers.uuid_v7 NOT NULL,
  payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
  observation_kind text NOT NULL CHECK (observation_kind IN ('Snapshot', 'Failure')),
  normalized_status text CHECK (normalized_status IN (
    'RequiresCustomerAction', 'Pending', 'Authorized', 'Captured', 'Cancelled', 'Failed', 'Unknown'
  )),
  provider_intent_reference text CHECK (
    provider_intent_reference ~ '^[A-Za-z0-9][A-Za-z0-9_-]{6,126}[A-Za-z0-9]$'
  ),
  provider_transaction_reference text CHECK (
    provider_transaction_reference ~ '^[A-Za-z0-9][A-Za-z0-9_-]{6,126}[A-Za-z0-9]$'
  ),
  requested_minor bigint,
  authorized_minor bigint,
  captured_minor bigint,
  refunded_minor bigint,
  currency_code text CHECK (currency_code = 'CAD'),
  evidence_digest text CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  failure_code text CHECK (failure_code IN (
    'Declined', 'AuthenticationRequired', 'InvalidRequest', 'Conflict', 'RateLimited',
    'Unavailable', 'Unknown'
  )),
  retry_disposition text CHECK (retry_disposition IN (
    'Never', 'SameOperation', 'NewOperation', 'Unknown'
  )),
  safe_reason_code text CHECK (
    char_length(safe_reason_code) <= 64
    AND safe_reason_code ~ '^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$'
  ),
  provider_observed_at timestamp with time zone,
  recorded_at timestamp with time zone NOT NULL,
  CONSTRAINT payment_provider_observation_scope_identity_unique
    UNIQUE (provider_observation_id, payment_attempt_id, payment_intent_id, brand_id, store_id),
  CONSTRAINT payment_provider_observation_attempt_fk
    FOREIGN KEY (payment_attempt_id, payment_intent_id, brand_id, store_id)
    REFERENCES rms_payment.payment_attempt
      (payment_attempt_id, payment_intent_id, brand_id, store_id),
  CONSTRAINT payment_provider_observation_shape_check CHECK (
    (
      observation_kind = 'Snapshot'
      AND normalized_status IS NOT NULL
      AND provider_intent_reference IS NOT NULL
      AND requested_minor > 0
      AND authorized_minor >= 0
      AND captured_minor >= 0
      AND refunded_minor >= 0
      AND authorized_minor <= requested_minor
      AND captured_minor <= authorized_minor
      AND refunded_minor <= captured_minor
      AND currency_code = 'CAD'
      AND evidence_digest IS NOT NULL
      AND failure_code IS NULL
      AND retry_disposition IS NULL
      AND safe_reason_code IS NULL
      AND provider_observed_at IS NOT NULL
    ) OR (
      observation_kind = 'Failure'
      AND normalized_status IS NULL
      AND provider_intent_reference IS NULL
      AND provider_transaction_reference IS NULL
      AND requested_minor IS NULL
      AND authorized_minor IS NULL
      AND captured_minor IS NULL
      AND refunded_minor IS NULL
      AND currency_code IS NULL
      AND evidence_digest IS NULL
      AND failure_code IS NOT NULL
      AND retry_disposition IS NOT NULL
      AND safe_reason_code IS NOT NULL
      AND provider_observed_at IS NULL
    )
  )
);

CREATE RULE payment_intent_identity_no_update AS
  ON UPDATE TO rms_payment.payment_intent
  WHERE (
    OLD.payment_intent_id IS DISTINCT FROM NEW.payment_intent_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.store_id IS DISTINCT FROM NEW.store_id
    OR OLD.payment_operation_id IS DISTINCT FROM NEW.payment_operation_id
    OR OLD.order_id IS DISTINCT FROM NEW.order_id
    OR OLD.order_batch_id IS DISTINCT FROM NEW.order_batch_id
    OR OLD.submission_id IS DISTINCT FROM NEW.submission_id
    OR OLD.guest_session_id IS DISTINCT FROM NEW.guest_session_id
    OR OLD.source_cart_id IS DISTINCT FROM NEW.source_cart_id
    OR OLD.source_cart_version IS DISTINCT FROM NEW.source_cart_version
    OR OLD.quote_id IS DISTINCT FROM NEW.quote_id
    OR OLD.preparation_id IS DISTINCT FROM NEW.preparation_id
    OR OLD.capacity_allocation_id IS DISTINCT FROM NEW.capacity_allocation_id
    OR OLD.intent_digest IS DISTINCT FROM NEW.intent_digest
    OR OLD.preparation_source_digest IS DISTINCT FROM NEW.preparation_source_digest
    OR OLD.order_allocation_minor IS DISTINCT FROM NEW.order_allocation_minor
    OR OLD.tip_minor IS DISTINCT FROM NEW.tip_minor
    OR OLD.total_minor IS DISTINCT FROM NEW.total_minor
    OR OLD.currency_code IS DISTINCT FROM NEW.currency_code
    OR OLD.payment_method IS DISTINCT FROM NEW.payment_method
    OR OLD.capture_mode IS DISTINCT FROM NEW.capture_mode
    OR OLD.prepared_at IS DISTINCT FROM NEW.prepared_at
    OR OLD.capacity_expires_at IS DISTINCT FROM NEW.capacity_expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  ) DO INSTEAD NOTHING;
CREATE RULE payment_intent_no_delete AS
  ON DELETE TO rms_payment.payment_intent DO INSTEAD NOTHING;
CREATE RULE payment_attempt_no_update AS
  ON UPDATE TO rms_payment.payment_attempt DO INSTEAD NOTHING;
CREATE RULE payment_attempt_no_delete AS
  ON DELETE TO rms_payment.payment_attempt DO INSTEAD NOTHING;
CREATE RULE payment_intent_operation_record_no_update AS
  ON UPDATE TO rms_payment.payment_intent_operation_record DO INSTEAD NOTHING;
CREATE RULE payment_intent_operation_record_no_delete AS
  ON DELETE TO rms_payment.payment_intent_operation_record DO INSTEAD NOTHING;
CREATE RULE payment_provider_observation_no_update AS
  ON UPDATE TO rms_payment.payment_provider_observation DO INSTEAD NOTHING;
CREATE RULE payment_provider_observation_no_delete AS
  ON DELETE TO rms_payment.payment_provider_observation DO INSTEAD NOTHING;

CREATE INDEX payment_intent_order_idx
  ON rms_payment.payment_intent (brand_id, store_id, order_id, created_at DESC);
CREATE INDEX payment_intent_capacity_expiry_idx
  ON rms_payment.payment_intent (brand_id, store_id, capacity_expires_at)
  WHERE creation_status = 'ProviderCreatePending';
CREATE INDEX payment_provider_observation_attempt_idx
  ON rms_payment.payment_provider_observation
  (brand_id, store_id, payment_attempt_id, recorded_at DESC);

ALTER TABLE rms_payment.payment_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_intent FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_attempt FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_intent_operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_intent_operation_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_provider_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_provider_observation FORCE ROW LEVEL SECURITY;

CREATE POLICY payment_intent_store_scope_policy ON rms_payment.payment_intent
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY payment_attempt_store_scope_policy ON rms_payment.payment_attempt
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY payment_intent_operation_record_store_scope_policy
  ON rms_payment.payment_intent_operation_record
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY payment_provider_observation_store_scope_policy
  ON rms_payment.payment_provider_observation
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_payment.payment_intent FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.payment_attempt FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.payment_intent_operation_record FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.payment_provider_observation FROM PUBLIC;
