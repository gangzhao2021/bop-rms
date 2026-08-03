-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_payment.provider_webhook_record
  ADD CONSTRAINT provider_webhook_record_terminal_scope_unique
  UNIQUE (
    webhook_receipt_id,
    brand_id,
    store_id,
    provider_account_id,
    provider_event_id
  );

CREATE TABLE rms_payment.payment_terminal_fact (
  payment_transaction_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  payment_intent_id platform_helpers.uuid_v7 NOT NULL,
  payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  webhook_receipt_id platform_helpers.uuid_v7 NOT NULL,
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^evt_[A-Za-z0-9]{8,128}$'),
  provider_account_id platform_helpers.uuid_v7 NOT NULL,
  provider_environment text NOT NULL CHECK (provider_environment IN ('Test', 'Live')),
  provider_intent_reference text NOT NULL CHECK (
    provider_intent_reference ~ '^[A-Za-z0-9][A-Za-z0-9_-]{6,126}[A-Za-z0-9]$'
  ),
  provider_observation_id platform_helpers.uuid_v7 NOT NULL,
  authoritative_source text NOT NULL CHECK (
    authoritative_source IN ('VerifiedWebhook', 'ProviderRetrieval')
  ),
  terminal_outcome text NOT NULL CHECK (terminal_outcome IN ('Succeeded', 'Failed')),
  amount_minor bigint,
  currency_code text,
  failure_reason text CHECK (
    failure_reason IN ('Declined', 'AuthenticationRequired', 'Cancelled', 'ProviderRejected')
  ),
  retry_disposition text CHECK (
    retry_disposition IN ('Never', 'SameOperation', 'NewOperation', 'Unknown')
  ),
  occurred_at timestamp with time zone NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  event_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT payment_terminal_fact_intent_terminal_unique UNIQUE (payment_intent_id),
  CONSTRAINT payment_terminal_fact_attempt_terminal_unique UNIQUE (payment_attempt_id),
  CONSTRAINT payment_terminal_fact_observation_unique UNIQUE (provider_observation_id),
  CONSTRAINT payment_terminal_fact_receipt_unique UNIQUE (webhook_receipt_id),
  CONSTRAINT payment_terminal_fact_event_unique UNIQUE (event_id),
  CONSTRAINT payment_terminal_fact_scope_identity_unique
    UNIQUE (payment_transaction_id, payment_intent_id, payment_attempt_id, brand_id, store_id),
  CONSTRAINT payment_terminal_fact_attempt_fk
    FOREIGN KEY (payment_attempt_id, payment_intent_id, brand_id, store_id)
    REFERENCES rms_payment.payment_attempt
      (payment_attempt_id, payment_intent_id, brand_id, store_id),
  CONSTRAINT payment_terminal_fact_observation_fk
    FOREIGN KEY (
      provider_observation_id,
      payment_attempt_id,
      payment_intent_id,
      brand_id,
      store_id
    )
    REFERENCES rms_payment.payment_provider_observation
      (provider_observation_id, payment_attempt_id, payment_intent_id, brand_id, store_id),
  CONSTRAINT payment_terminal_fact_receipt_fk
    FOREIGN KEY (
      webhook_receipt_id,
      brand_id,
      store_id,
      provider_account_id,
      provider_event_id
    )
    REFERENCES rms_payment.provider_webhook_record
      (webhook_receipt_id, brand_id, store_id, provider_account_id, provider_event_id),
  CONSTRAINT payment_terminal_fact_shape_check CHECK (
    (
      terminal_outcome = 'Succeeded'
      AND amount_minor > 0
      AND currency_code = 'CAD'
      AND failure_reason IS NULL
      AND retry_disposition IS NULL
    ) OR (
      terminal_outcome = 'Failed'
      AND amount_minor IS NULL
      AND currency_code IS NULL
      AND failure_reason IS NOT NULL
      AND retry_disposition IS NOT NULL
    )
  ),
  CONSTRAINT payment_terminal_fact_time_check CHECK (occurred_at <= recorded_at)
);

CREATE RULE payment_terminal_fact_no_update AS
  ON UPDATE TO rms_payment.payment_terminal_fact DO INSTEAD NOTHING;
CREATE RULE payment_terminal_fact_no_delete AS
  ON DELETE TO rms_payment.payment_terminal_fact DO INSTEAD NOTHING;

CREATE INDEX payment_terminal_fact_order_idx
  ON rms_payment.payment_terminal_fact (brand_id, store_id, order_id, occurred_at DESC);
CREATE INDEX payment_terminal_fact_provider_event_idx
  ON rms_payment.payment_terminal_fact
    (provider_account_id, provider_event_id, payment_transaction_id);

ALTER TABLE rms_payment.payment_terminal_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_terminal_fact FORCE ROW LEVEL SECURITY;

CREATE POLICY payment_terminal_fact_store_scope_policy
  ON rms_payment.payment_terminal_fact
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_payment.payment_terminal_fact FROM PUBLIC;
