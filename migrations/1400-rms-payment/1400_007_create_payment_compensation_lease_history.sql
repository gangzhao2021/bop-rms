-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.payment_compensation_lease_history (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  history_sequence bigint NOT NULL CHECK (history_sequence BETWEEN 1 AND 9007199254740991),
  action text NOT NULL CHECK (action IN ('Claimed','Released')),
  fence_id platform_helpers.uuid_v7 NOT NULL,
  fence_version bigint NOT NULL CHECK (fence_version BETWEEN 1 AND 9007199254740991),
  claimed_at timestamptz NOT NULL CHECK (claimed_at = date_trunc('milliseconds',claimed_at)),
  expires_at timestamptz NOT NULL CHECK (expires_at = date_trunc('milliseconds',expires_at) AND expires_at > claimed_at),
  recorded_at timestamptz NOT NULL CHECK (recorded_at = date_trunc('milliseconds',recorded_at) AND recorded_at >= claimed_at),
  CONSTRAINT payment_compensation_lease_history_pk PRIMARY KEY (brand_id,store_id,payment_attempt_id,history_sequence),
  CONSTRAINT payment_compensation_lease_history_action_version CHECK (
    (action='Claimed' AND history_sequence=fence_version AND recorded_at=claimed_at) OR
    (action='Released' AND history_sequence>fence_version)
  )
);
CREATE UNIQUE INDEX payment_compensation_lease_history_fence_idx
  ON rms_payment.payment_compensation_lease_history (brand_id,store_id,fence_id) WHERE action='Claimed';
CREATE INDEX payment_compensation_lease_history_operation_idx
  ON rms_payment.payment_compensation_lease_history (brand_id,store_id,operation_id);
CREATE RULE payment_compensation_lease_history_no_update AS
  ON UPDATE TO rms_payment.payment_compensation_lease_history DO INSTEAD NOTHING;
CREATE RULE payment_compensation_lease_history_no_delete AS
  ON DELETE TO rms_payment.payment_compensation_lease_history DO INSTEAD NOTHING;
ALTER TABLE rms_payment.payment_compensation_lease_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_compensation_lease_history FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_compensation_lease_history_scope_policy ON rms_payment.payment_compensation_lease_history
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.payment_compensation_lease_history FROM PUBLIC;
