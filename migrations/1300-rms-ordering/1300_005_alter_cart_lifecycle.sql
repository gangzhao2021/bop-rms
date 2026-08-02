-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_ordering.cart
  ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'Legacy',
  ADD COLUMN lifecycle_policy_version_id platform_helpers.uuid_v7,
  ADD COLUMN lifecycle_policy_digest text,
  ADD COLUMN idle_timeout_seconds integer,
  ADD COLUMN absolute_timeout_seconds integer,
  ADD COLUMN idle_expires_at timestamp with time zone,
  ADD COLUMN absolute_expires_at timestamp with time zone,
  ADD COLUMN terminal_at timestamp with time zone,
  ADD COLUMN terminal_reason text,
  ADD CONSTRAINT cart_lifecycle_check CHECK (
    (
      lifecycle_status = 'Legacy'
      AND lifecycle_policy_version_id IS NULL
      AND lifecycle_policy_digest IS NULL
      AND idle_timeout_seconds IS NULL
      AND absolute_timeout_seconds IS NULL
      AND idle_expires_at IS NULL
      AND absolute_expires_at IS NULL
      AND terminal_at IS NULL
      AND terminal_reason IS NULL
    )
    OR (
      lifecycle_status IN ('Active', 'Abandoned', 'Expired')
      AND lifecycle_policy_version_id IS NOT NULL
      AND lifecycle_policy_digest ~ '^sha256:[0-9a-f]{64}$'
      AND idle_timeout_seconds BETWEEN 1 AND 31536000
      AND absolute_timeout_seconds BETWEEN idle_timeout_seconds AND 31536000
      AND idle_expires_at > created_at
      AND absolute_expires_at >= idle_expires_at
      AND (
        (
          lifecycle_status = 'Active'
          AND terminal_at IS NULL
          AND terminal_reason IS NULL
          AND updated_at < idle_expires_at
          AND updated_at < absolute_expires_at
        )
        OR (
          lifecycle_status = 'Abandoned'
          AND terminal_at = updated_at
          AND terminal_reason = 'CUSTOMER_ABANDONED'
          AND terminal_at < idle_expires_at
          AND terminal_at < absolute_expires_at
        )
        OR (
          lifecycle_status = 'Expired'
          AND terminal_at = updated_at
          AND (
            (terminal_reason = 'IDLE_TIMEOUT' AND terminal_at >= idle_expires_at)
            OR (terminal_reason = 'ABSOLUTE_TIMEOUT' AND terminal_at >= absolute_expires_at)
          )
        )
      )
    )
  );

CREATE RULE cart_lifecycle_policy_no_update AS
  ON UPDATE TO rms_ordering.cart
  WHERE (
    OLD.lifecycle_status <> 'Legacy'
    AND (
      OLD.lifecycle_policy_version_id IS DISTINCT FROM NEW.lifecycle_policy_version_id
      OR OLD.lifecycle_policy_digest IS DISTINCT FROM NEW.lifecycle_policy_digest
      OR OLD.idle_timeout_seconds IS DISTINCT FROM NEW.idle_timeout_seconds
      OR OLD.absolute_timeout_seconds IS DISTINCT FROM NEW.absolute_timeout_seconds
      OR OLD.absolute_expires_at IS DISTINCT FROM NEW.absolute_expires_at
    )
  )
  DO INSTEAD NOTHING;

CREATE RULE cart_lifecycle_terminal_no_update AS
  ON UPDATE TO rms_ordering.cart
  WHERE (
    OLD.lifecycle_status IN ('Abandoned', 'Expired')
    AND (
      OLD.lifecycle_status IS DISTINCT FROM NEW.lifecycle_status
      OR OLD.idle_expires_at IS DISTINCT FROM NEW.idle_expires_at
      OR OLD.terminal_at IS DISTINCT FROM NEW.terminal_at
      OR OLD.terminal_reason IS DISTINCT FROM NEW.terminal_reason
      OR OLD.aggregate_version IS DISTINCT FROM NEW.aggregate_version
      OR OLD.updated_at IS DISTINCT FROM NEW.updated_at
    )
  )
  DO INSTEAD NOTHING;

CREATE RULE cart_no_delete AS
  ON DELETE TO rms_ordering.cart DO INSTEAD NOTHING;

CREATE TABLE rms_ordering.cart_lifecycle_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7,
  action_code text NOT NULL CHECK (action_code IN ('Abandon', 'Expire')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 1),
  result_cart_snapshot_json jsonb NOT NULL CHECK (
    jsonb_typeof(result_cart_snapshot_json) = 'object'
  ),
  occurred_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT cart_lifecycle_operation_cart_fk
    FOREIGN KEY (cart_id, brand_id, store_id)
    REFERENCES rms_ordering.cart (cart_id, brand_id, store_id),
  CONSTRAINT cart_lifecycle_operation_actor_check CHECK (
    (action_code = 'Abandon' AND guest_session_id IS NOT NULL)
    OR (action_code = 'Expire' AND guest_session_id IS NULL)
  ),
  CONSTRAINT cart_lifecycle_operation_retention_check
    CHECK (expires_at = occurred_at + interval '24 hours')
);

CREATE RULE cart_lifecycle_operation_no_update AS
  ON UPDATE TO rms_ordering.cart_lifecycle_operation_record DO INSTEAD NOTHING;
CREATE RULE cart_lifecycle_operation_no_delete AS
  ON DELETE TO rms_ordering.cart_lifecycle_operation_record DO INSTEAD NOTHING;

CREATE INDEX cart_lifecycle_due_idx
  ON rms_ordering.cart
  (brand_id, store_id, lifecycle_status, idle_expires_at, absolute_expires_at)
  WHERE lifecycle_status = 'Active';
CREATE INDEX cart_lifecycle_operation_expiry_idx
  ON rms_ordering.cart_lifecycle_operation_record (brand_id, store_id, expires_at);

ALTER TABLE rms_ordering.cart_lifecycle_operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart_lifecycle_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY cart_lifecycle_operation_store_scope_policy
  ON rms_ordering.cart_lifecycle_operation_record
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_ordering.cart_lifecycle_operation_record FROM PUBLIC;
