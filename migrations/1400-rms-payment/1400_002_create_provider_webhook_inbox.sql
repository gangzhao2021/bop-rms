-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.provider_webhook_record (
  webhook_receipt_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  provider text NOT NULL CHECK (provider = 'Stripe'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('Test', 'Live')),
  provider_account_id platform_helpers.uuid_v7 NOT NULL,
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^evt_[A-Za-z0-9]{8,128}$'),
  provider_event_type text NOT NULL CHECK (
    char_length(provider_event_type) <= 128
    AND provider_event_type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'
  ),
  provider_created_at timestamp with time zone NOT NULL,
  received_at timestamp with time zone NOT NULL,
  signature_timestamp timestamp with time zone NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  accepted_at timestamp with time zone NOT NULL,
  raw_evidence_expires_at timestamp with time zone NOT NULL,
  dedupe_expires_at timestamp with time zone NOT NULL,
  CONSTRAINT provider_webhook_record_scope_identity_unique
    UNIQUE (webhook_receipt_id, brand_id, store_id),
  CONSTRAINT provider_webhook_record_provider_event_unique
    UNIQUE (provider, provider_environment, provider_account_id, provider_event_id),
  CONSTRAINT provider_webhook_record_retention_check CHECK (
    accepted_at = received_at
    AND raw_evidence_expires_at = accepted_at + interval '30 days'
    AND dedupe_expires_at = accepted_at + interval '90 days'
    AND provider_created_at <= received_at
    AND signature_timestamp BETWEEN received_at - interval '5 minutes'
      AND received_at + interval '5 minutes'
  )
);

ALTER TABLE rms_payment.provider_webhook_record
  ADD CONSTRAINT provider_webhook_record_receipt_digest_expiry_unique
  UNIQUE (webhook_receipt_id, evidence_digest, raw_evidence_expires_at);

CREATE TABLE rms_payment.provider_webhook_raw_evidence (
  webhook_receipt_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  raw_evidence bytea NOT NULL CHECK (
    octet_length(raw_evidence) BETWEEN 1 AND 1048576
  ),
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT provider_webhook_raw_evidence_receipt_fk
    FOREIGN KEY (webhook_receipt_id, brand_id, store_id)
    REFERENCES rms_payment.provider_webhook_record
      (webhook_receipt_id, brand_id, store_id),
  CONSTRAINT provider_webhook_raw_evidence_receipt_unique
    UNIQUE (webhook_receipt_id, evidence_digest),
  CONSTRAINT provider_webhook_raw_evidence_retention_fk
    FOREIGN KEY (webhook_receipt_id, evidence_digest, expires_at)
    REFERENCES rms_payment.provider_webhook_record
      (webhook_receipt_id, evidence_digest, raw_evidence_expires_at)
);

CREATE TABLE rms_payment.provider_webhook_processing_record (
  webhook_receipt_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  consumer_name text NOT NULL CHECK (consumer_name = 'payment.provider-webhook.v1'),
  processed_at timestamp with time zone NOT NULL,
  result_digest text NOT NULL CHECK (result_digest ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (webhook_receipt_id, consumer_name),
  CONSTRAINT provider_webhook_processing_record_receipt_fk
    FOREIGN KEY (webhook_receipt_id, brand_id, store_id)
    REFERENCES rms_payment.provider_webhook_record
      (webhook_receipt_id, brand_id, store_id)
);

CREATE RULE provider_webhook_record_no_update AS
  ON UPDATE TO rms_payment.provider_webhook_record DO INSTEAD NOTHING;
CREATE RULE provider_webhook_record_no_delete AS
  ON DELETE TO rms_payment.provider_webhook_record DO INSTEAD NOTHING;
CREATE RULE provider_webhook_raw_evidence_no_update AS
  ON UPDATE TO rms_payment.provider_webhook_raw_evidence DO INSTEAD NOTHING;
CREATE RULE provider_webhook_raw_evidence_no_early_delete AS
  ON DELETE TO rms_payment.provider_webhook_raw_evidence
  WHERE OLD.expires_at > CURRENT_TIMESTAMP DO INSTEAD NOTHING;
CREATE RULE provider_webhook_processing_record_no_update AS
  ON UPDATE TO rms_payment.provider_webhook_processing_record DO INSTEAD NOTHING;
CREATE RULE provider_webhook_processing_record_no_delete AS
  ON DELETE TO rms_payment.provider_webhook_processing_record DO INSTEAD NOTHING;

CREATE INDEX provider_webhook_record_pending_processing_idx
  ON rms_payment.provider_webhook_record (brand_id, store_id, accepted_at, webhook_receipt_id);
CREATE INDEX provider_webhook_record_dedupe_expiry_idx
  ON rms_payment.provider_webhook_record (dedupe_expires_at, webhook_receipt_id);
CREATE INDEX provider_webhook_raw_evidence_expiry_idx
  ON rms_payment.provider_webhook_raw_evidence (expires_at, webhook_receipt_id);

ALTER TABLE rms_payment.provider_webhook_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.provider_webhook_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.provider_webhook_raw_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.provider_webhook_raw_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.provider_webhook_processing_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.provider_webhook_processing_record FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_webhook_record_store_scope_policy
  ON rms_payment.provider_webhook_record
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY provider_webhook_raw_evidence_store_scope_policy
  ON rms_payment.provider_webhook_raw_evidence
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY provider_webhook_processing_record_store_scope_policy
  ON rms_payment.provider_webhook_processing_record
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_payment.provider_webhook_record FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.provider_webhook_raw_evidence FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.provider_webhook_processing_record FROM PUBLIC;
