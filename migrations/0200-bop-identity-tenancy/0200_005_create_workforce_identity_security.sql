-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE bop_identity.workforce_invitation (
  invitation_id platform_helpers.uuid_v7 PRIMARY KEY,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  inviter_actor_id platform_helpers.uuid_v7 NOT NULL,
  membership_id platform_helpers.uuid_v7 NOT NULL,
  store_assignment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (
    cardinality(store_assignment_ids) <= 100
  ),
  email_digest bytea NOT NULL CHECK (octet_length(email_digest) = 32),
  selector_hash bytea NOT NULL UNIQUE CHECK (octet_length(selector_hash) = 32),
  status text NOT NULL CHECK (status IN ('Pending', 'Accepted', 'Revoked', 'Expired')),
  provider_evidence_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT workforce_invitation_expiry_check CHECK (
    expires_at = created_at + interval '24 hours'
  ),
  CONSTRAINT workforce_invitation_consumption_check CHECK (
    (status = 'Accepted'
      AND consumed_at IS NOT NULL
      AND consumed_at >= created_at
      AND consumed_at < expires_at)
    OR (status <> 'Accepted' AND consumed_at IS NULL)
  )
);

CREATE UNIQUE INDEX workforce_invitation_actor_membership_pending_idx
  ON bop_identity.workforce_invitation (actor_id, membership_id)
  WHERE status = 'Pending';
CREATE INDEX workforce_invitation_expiry_idx
  ON bop_identity.workforce_invitation (expires_at)
  WHERE status = 'Pending';

CREATE TABLE bop_identity.workforce_mfa_status (
  actor_id platform_helpers.uuid_v7 PRIMARY KEY,
  status text NOT NULL CHECK (
    status IN ('Required', 'EnrollmentPending', 'TotpVerified', 'ResetRequired')
  ),
  provider_evidence_id platform_helpers.uuid_v7,
  verified_at timestamp with time zone,
  reset_at timestamp with time zone,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT workforce_mfa_status_verification_check CHECK (
    (status = 'TotpVerified' AND verified_at IS NOT NULL)
    OR (status <> 'TotpVerified' AND verified_at IS NULL)
  ),
  CONSTRAINT workforce_mfa_status_reset_check CHECK (
    reset_at IS NULL OR verified_at IS NULL OR reset_at >= verified_at
  )
);

CREATE TABLE bop_identity.workforce_recovery_case (
  recovery_id platform_helpers.uuid_v7 PRIMARY KEY,
  target_actor_id platform_helpers.uuid_v7 NOT NULL,
  requested_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  approver_actor_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (
    cardinality(approver_actor_ids) <= 2
    AND NOT target_actor_id = ANY (approver_actor_ids)
    AND NOT requested_by_actor_id = ANY (approver_actor_ids)
  ),
  required_approval_count smallint NOT NULL CHECK (required_approval_count IN (1, 2)),
  purpose_code varchar(128) NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  proof_evidence_id platform_helpers.uuid_v7 NOT NULL,
  status text NOT NULL CHECK (
    status IN ('Pending', 'Approved', 'Completed', 'Denied', 'Expired')
  ),
  created_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  completed_at timestamp with time zone,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT workforce_recovery_approval_count_check CHECK (
    cardinality(approver_actor_ids) <= required_approval_count
    AND (status <> 'Approved' OR cardinality(approver_actor_ids) = required_approval_count)
    AND (status <> 'Completed' OR cardinality(approver_actor_ids) = required_approval_count)
  ),
  CONSTRAINT workforce_recovery_expiry_check CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '24 hours'
  ),
  CONSTRAINT workforce_recovery_completion_check CHECK (
    (status = 'Completed'
      AND completed_at IS NOT NULL
      AND completed_at >= created_at
      AND completed_at < expires_at)
    OR (status <> 'Completed' AND completed_at IS NULL)
  )
);

CREATE INDEX workforce_recovery_actor_status_idx
  ON bop_identity.workforce_recovery_case (target_actor_id, status, created_at);

CREATE TABLE bop_identity.session_revocation_request (
  idempotency_id platform_helpers.uuid_v7 PRIMARY KEY,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  reason text NOT NULL CHECK (
    reason IN (
      'GlobalLogout',
      'MembershipDisabled',
      'StoreAssignmentRemoved',
      'RoleRemoved',
      'CredentialReset',
      'CredentialCompromised',
      'Recovery',
      'Administrative'
    )
  ),
  purpose_code varchar(128) NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  source_evidence_id platform_helpers.uuid_v7 NOT NULL,
  cutoff_at timestamp with time zone NOT NULL,
  completed_at timestamp with time zone NOT NULL CHECK (completed_at >= cutoff_at),
  revoked_session_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (
    cardinality(revoked_session_ids) <= 100
  ),
  version integer NOT NULL CHECK (version > 0)
);

CREATE INDEX session_revocation_request_actor_cutoff_idx
  ON bop_identity.session_revocation_request (actor_id, cutoff_at DESC);

REVOKE ALL ON TABLE bop_identity.workforce_invitation FROM PUBLIC;
REVOKE ALL ON TABLE bop_identity.workforce_mfa_status FROM PUBLIC;
REVOKE ALL ON TABLE bop_identity.workforce_recovery_case FROM PUBLIC;
REVOKE ALL ON TABLE bop_identity.session_revocation_request FROM PUBLIC;
