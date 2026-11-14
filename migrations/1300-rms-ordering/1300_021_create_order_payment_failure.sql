-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_payment_failure_record (
  failure_record_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  payment_transaction_id platform_helpers.uuid_v7 NOT NULL,
  payment_intent_id platform_helpers.uuid_v7 NOT NULL,
  payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
  payment_event_id platform_helpers.uuid_v7 NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'Declined', 'AuthenticationRequired', 'Cancelled', 'ProviderRejected'
  )),
  retry_disposition text NOT NULL CHECK (retry_disposition IN (
    'Never', 'SameOperation', 'NewOperation', 'Unknown'
  )),
  terminal_occurred_at timestamptz NOT NULL,
  event_digest text NOT NULL CHECK (event_digest ~ '^sha256:[0-9a-f]{64}$'),
  UNIQUE (brand_id, store_id, payment_event_id),
  UNIQUE (brand_id, store_id, payment_transaction_id),
  FOREIGN KEY (order_id, brand_id, store_id)
    REFERENCES rms_ordering.order_header(order_id, brand_id, store_id),
  CHECK (isfinite(terminal_occurred_at)
    AND terminal_occurred_at=date_trunc('milliseconds', terminal_occurred_at))
);
CREATE RULE order_payment_failure_record_no_update AS
  ON UPDATE TO rms_ordering.order_payment_failure_record DO INSTEAD NOTHING;
CREATE RULE order_payment_failure_record_no_delete AS
  ON DELETE TO rms_ordering.order_payment_failure_record DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.order_payment_failure_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_payment_failure_record FORCE ROW LEVEL SECURITY;
CREATE POLICY order_payment_failure_record_scope ON rms_ordering.order_payment_failure_record
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_payment_failure_record FROM PUBLIC;
