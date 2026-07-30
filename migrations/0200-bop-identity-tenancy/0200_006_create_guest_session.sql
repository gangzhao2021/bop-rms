-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE bop_identity.guest_session (
  guest_session_id platform_helpers.uuid_v7 PRIMARY KEY,
  session_selector_hash bytea NOT NULL UNIQUE CHECK (octet_length(session_selector_hash) = 32),
  csrf_selector_hash bytea NOT NULL UNIQUE CHECK (octet_length(csrf_selector_hash) = 32),
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  operation_intent_hash bytea NOT NULL CHECK (octet_length(operation_intent_hash) = 32),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  public_store_id platform_helpers.uuid_v7 NOT NULL,
  public_table_id platform_helpers.uuid_v7,
  channel text NOT NULL CHECK (channel IN ('DineIn', 'Pickup')),
  locale text NOT NULL CHECK (
    locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|[0-9]{3})?$'
  ),
  qr_id platform_helpers.uuid_v7 NOT NULL,
  qr_revocation_version integer NOT NULL CHECK (qr_revocation_version > 0),
  dining_state text NOT NULL CHECK (dining_state = 'ContextOnly'),
  status text NOT NULL CHECK (status IN ('Active', 'Revoked', 'Expired')),
  created_at timestamp with time zone NOT NULL,
  last_seen_at timestamp with time zone NOT NULL,
  idle_expires_at timestamp with time zone NOT NULL,
  absolute_expires_at timestamp with time zone NOT NULL,
  order_closed_at timestamp with time zone,
  closure_expires_at timestamp with time zone,
  rotated_from_guest_session_id platform_helpers.uuid_v7
    REFERENCES bop_identity.guest_session (guest_session_id),
  revocation_reason text CHECK (
    revocation_reason IN (
      'Rotated',
      'BindingChanged',
      'Logout',
      'StoreUnavailable',
      'QrRevoked',
      'OrderClosed',
      'DiningSessionClosed',
      'RiskChanged',
      'Administrative'
    )
  ),
  revoked_at timestamp with time zone,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT guest_session_channel_table_check CHECK (
    (channel = 'DineIn' AND public_table_id IS NOT NULL)
    OR (channel = 'Pickup' AND public_table_id IS NULL)
  ),
  CONSTRAINT guest_session_idle_check CHECK (
    last_seen_at >= created_at AND idle_expires_at = last_seen_at + interval '4 hours'
  ),
  CONSTRAINT guest_session_absolute_check CHECK (
    absolute_expires_at = created_at + interval '24 hours'
  ),
  CONSTRAINT guest_session_closure_check CHECK (
    (order_closed_at IS NULL AND closure_expires_at IS NULL)
    OR (
      order_closed_at IS NOT NULL
      AND closure_expires_at = order_closed_at + interval '2 hours'
    )
  ),
  CONSTRAINT guest_session_terminal_check CHECK (
    (status = 'Revoked'
      AND revocation_reason IS NOT NULL
      AND revoked_at IS NOT NULL
      AND revoked_at >= created_at)
    OR (status IN ('Active', 'Expired') AND revocation_reason IS NULL AND revoked_at IS NULL)
  )
);

CREATE INDEX guest_session_scope_active_idx
  ON bop_identity.guest_session (brand_id, store_id, status, absolute_expires_at);
CREATE INDEX guest_session_expiry_idx
  ON bop_identity.guest_session (idle_expires_at, absolute_expires_at)
  WHERE status = 'Active';

ALTER TABLE bop_identity.guest_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.guest_session FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_session_scope_policy ON bop_identity.guest_session
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE bop_identity.guest_session FROM PUBLIC;
