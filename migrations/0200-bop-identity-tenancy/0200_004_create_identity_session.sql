-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA bop_identity;
REVOKE ALL ON SCHEMA bop_identity FROM PUBLIC;

CREATE TABLE bop_identity.authentication_session (
  session_id platform_helpers.uuid_v7 PRIMARY KEY,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  session_selector_hash bytea NOT NULL UNIQUE CHECK (octet_length(session_selector_hash) = 32),
  csrf_selector_hash bytea NOT NULL CHECK (octet_length(csrf_selector_hash) = 32),
  policy_code text NOT NULL CHECK (
    policy_code IN ('WorkforceStandard', 'Privileged', 'NamedKdsOperator')
  ),
  status text NOT NULL CHECK (status IN ('Active', 'Revoked', 'Expired')),
  encrypted_secret bytea NOT NULL CHECK (
    octet_length(encrypted_secret) BETWEEN 29 AND 16384
  ),
  cipher_algorithm varchar(32) NOT NULL CHECK (
    cipher_algorithm IN ('SYNTHETIC_AES_256_GCM', 'KMS_AES_256_GCM')
  ),
  key_reference varchar(255) NOT NULL CHECK (length(key_reference) BETWEEN 1 AND 255),
  encryption_context varchar(512) NOT NULL CHECK (
    length(encryption_context) BETWEEN 1 AND 512
  ),
  authenticated_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL,
  last_seen_at timestamp with time zone NOT NULL,
  idle_expires_at timestamp with time zone NOT NULL,
  absolute_expires_at timestamp with time zone NOT NULL,
  rotated_from_session_id platform_helpers.uuid_v7,
  revocation_reason text CHECK (
    revocation_reason IN (
      'Logout',
      'GlobalLogout',
      'MembershipDisabled',
      'RoleRemoved',
      'StoreAssignmentRemoved',
      'CredentialReset',
      'CredentialCompromised',
      'Recovery',
      'ConcurrentLimit',
      'RiskChange',
      'Administrative'
    )
  ),
  revoked_at timestamp with time zone,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT authentication_session_rotated_from_fkey
    FOREIGN KEY (rotated_from_session_id)
    REFERENCES bop_identity.authentication_session (session_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT authentication_session_time_order_check CHECK (
    authenticated_at <= created_at
    AND created_at <= last_seen_at
    AND last_seen_at < idle_expires_at
    AND idle_expires_at <= absolute_expires_at
  ),
  CONSTRAINT authentication_session_revocation_shape_check CHECK (
    (status = 'Revoked' AND revocation_reason IS NOT NULL AND revoked_at IS NOT NULL)
    OR (status <> 'Revoked' AND revocation_reason IS NULL AND revoked_at IS NULL)
  ),
  CONSTRAINT authentication_session_revocation_time_check CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  ),
  CONSTRAINT authentication_session_rotation_check CHECK (
    rotated_from_session_id IS NULL OR rotated_from_session_id <> session_id
  )
);

CREATE INDEX authentication_session_actor_active_idx
  ON bop_identity.authentication_session (actor_id, status, created_at, session_id);
CREATE INDEX authentication_session_expiry_idx
  ON bop_identity.authentication_session (status, idle_expires_at, absolute_expires_at);

CREATE TABLE bop_identity.oidc_authorization_transaction (
  transaction_id platform_helpers.uuid_v7 PRIMARY KEY,
  state_selector_hash bytea NOT NULL UNIQUE CHECK (octet_length(state_selector_hash) = 32),
  auth_cookie_selector_hash bytea NOT NULL CHECK (
    octet_length(auth_cookie_selector_hash) = 32
  ),
  encrypted_secret bytea NOT NULL CHECK (
    octet_length(encrypted_secret) BETWEEN 29 AND 8192
  ),
  cipher_algorithm varchar(32) NOT NULL CHECK (
    cipher_algorithm IN ('SYNTHETIC_AES_256_GCM', 'KMS_AES_256_GCM')
  ),
  key_reference varchar(255) NOT NULL CHECK (length(key_reference) BETWEEN 1 AND 255),
  encryption_context varchar(512) NOT NULL CHECK (
    length(encryption_context) BETWEEN 1 AND 512
  ),
  redirect_uri varchar(2048) NOT NULL CHECK (
    redirect_uri LIKE 'https://%'
    AND position('#' IN redirect_uri) = 0
  ),
  post_login_path varchar(256) NOT NULL CHECK (
    post_login_path LIKE '/%'
    AND post_login_path NOT LIKE '//%'
    AND position('\' IN post_login_path) = 0
    AND position('%' IN post_login_path) = 0
  ),
  created_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT oidc_authorization_transaction_expiry_check CHECK (
    expires_at = created_at + interval '10 minutes'
  ),
  CONSTRAINT oidc_authorization_transaction_consumption_check CHECK (
    consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at)
  )
);

CREATE INDEX oidc_authorization_transaction_expiry_idx
  ON bop_identity.oidc_authorization_transaction (expires_at)
  WHERE consumed_at IS NULL;

REVOKE ALL ON TABLE bop_identity.authentication_session FROM PUBLIC;
REVOKE ALL ON TABLE bop_identity.oidc_authorization_transaction FROM PUBLIC;
