-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_payment_acceptance_wait (
  wait_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  submission_id platform_helpers.uuid_v7 NOT NULL,
  payment_event_id platform_helpers.uuid_v7 NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  evaluated_at timestamptz NOT NULL,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object'),
  UNIQUE (brand_id,store_id,payment_event_id),
  FOREIGN KEY (order_batch_id,order_id,brand_id,store_id)
    REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id),
  FOREIGN KEY (submission_id,brand_id,store_id,order_id)
    REFERENCES rms_ordering.order_submission_record(submission_id,brand_id,store_id,order_id),
  CHECK (isfinite(evaluated_at) AND evaluated_at=date_trunc('milliseconds',evaluated_at))
);
CREATE RULE order_payment_acceptance_wait_no_update AS
  ON UPDATE TO rms_ordering.order_payment_acceptance_wait DO INSTEAD NOTHING;
CREATE RULE order_payment_acceptance_wait_no_delete AS
  ON DELETE TO rms_ordering.order_payment_acceptance_wait DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.order_payment_acceptance_wait ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_payment_acceptance_wait FORCE ROW LEVEL SECURITY;
CREATE POLICY order_payment_acceptance_wait_scope ON rms_ordering.order_payment_acceptance_wait
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_payment_acceptance_wait FROM PUBLIC;
