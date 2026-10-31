-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q5 (DEC-REFUND-ESCALATION-PILOT): a staff member re-verifies with a second factor before a
-- sensitive action (an escalated refund request or approval). Each attempt at a Store is recorded,
-- append-only: who, when, the method, verified or rejected, and for a verified code its time step
-- (so the same code cannot be used twice). No secret or code is stored. The latest verified attempt
-- is the "recent MFA" an owner policy reads; failed attempts bound further tries.
CREATE FUNCTION bop_identity.reject_workforce_mfa_step_up_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only workforce MFA step-up' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.reject_workforce_mfa_step_up_mutation() FROM PUBLIC;

CREATE TABLE bop_identity.workforce_mfa_step_up (
 step_up_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 method text NOT NULL CHECK (method IN ('InternalTestTotp')),
 purpose_code varchar(64) NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 outcome text NOT NULL CHECK (outcome IN ('Verified','Rejected')),
 rejection_reason text CHECK (rejection_reason IN ('CodeMismatch','CodeReused')),
 time_step bigint CHECK (time_step >= 0),
 attempted_at timestamptz NOT NULL CHECK (isfinite(attempted_at) AND attempted_at=date_trunc('milliseconds',attempted_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (brand_id,store_id,step_up_id),
 CONSTRAINT workforce_mfa_step_up_result_check CHECK (
  (outcome='Verified' AND time_step IS NOT NULL AND rejection_reason IS NULL)
  OR (outcome='Rejected' AND time_step IS NULL AND rejection_reason IS NOT NULL)
 )
);
-- A verified code (time step) is accepted once per person and method, at any Store.
CREATE UNIQUE INDEX workforce_mfa_step_up_single_use_idx
 ON bop_identity.workforce_mfa_step_up (actor_id,method,time_step) WHERE outcome='Verified';
CREATE INDEX workforce_mfa_step_up_actor_idx
 ON bop_identity.workforce_mfa_step_up (brand_id,store_id,actor_id,attempted_at DESC);

CREATE TRIGGER workforce_mfa_step_up_no_mutation BEFORE UPDATE OR DELETE ON bop_identity.workforce_mfa_step_up
 FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_workforce_mfa_step_up_mutation();
CREATE TRIGGER workforce_mfa_step_up_no_truncate BEFORE TRUNCATE ON bop_identity.workforce_mfa_step_up
 FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_workforce_mfa_step_up_mutation();
ALTER TABLE bop_identity.workforce_mfa_step_up ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.workforce_mfa_step_up FORCE ROW LEVEL SECURITY;
CREATE POLICY workforce_mfa_step_up_scope ON bop_identity.workforce_mfa_step_up
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_identity.workforce_mfa_step_up FROM PUBLIC;
