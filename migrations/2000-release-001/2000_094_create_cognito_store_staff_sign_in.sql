-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (DEC-COGNITO-STORE-STAFF, Owner 2026-10-20 "先把接口都做好"): Store staff sign in with
-- their own Amazon Cognito account.
--   store_staff_invitation  an Owner or manager (organization.staff.manage) invites a person to
--                           this Store by work email (or an operator invites the first Owner, or
--                           gives an existing member their own sign-in when a Store switches over).
--                           Cognito creates the account and sends the email; this row keeps only
--                           a keyed digest of the email and a masked hint for the staff screen.
--                           Pending until the person's first sign-in, then Accepted, or Revoked.
--                           A Pending invitation expires 7 days after it was last sent (derived,
--                           no row change); resending moves the expiry. Never deleted.
--   store_staff_account     the Cognito account (keyed digest of its subject) a person signed in
--                           with when they accepted their invitation. Append-only; one account per
--                           person and Cognito pool, one person per account.
-- The MFA step-up record also accepts a Cognito re-authentication (sign-in with the
-- authenticator again), whose single-use step is the Cognito authentication time in seconds.
CREATE FUNCTION bop_identity.reject_store_staff_history_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only store staff sign-in history' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.reject_store_staff_history_mutation() FROM PUBLIC;

CREATE TABLE bop_identity.store_staff_invitation (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 invitation_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 membership_id platform_helpers.uuid_v7 NOT NULL,
 store_assignment_id platform_helpers.uuid_v7 NOT NULL,
 invited_by_actor_id platform_helpers.uuid_v7 NOT NULL,
 invitation_kind text NOT NULL CHECK (invitation_kind IN ('Staff','FirstOwner','ExistingMember')),
 environment text NOT NULL CHECK (environment ~ '^[a-z][a-z0-9-]{0,63}$'),
 issuer text NOT NULL CHECK (
  issuer ~ '^https://cognito-idp\.ca-central-1\.amazonaws\.com/ca-central-1_[A-Za-z0-9]{1,42}$'
 ),
 client_id text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9]{1,128}$'),
 intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[a-f0-9]{64}$'),
 email_digest text NOT NULL CHECK (email_digest ~ '^[a-f0-9]{64}$'),
 email_hint varchar(80) NOT NULL CHECK (
  email_hint=btrim(email_hint) AND char_length(email_hint) BETWEEN 3 AND 80
  AND email_hint !~ '[[:cntrl:]]'
 ),
 status text NOT NULL CHECK (status IN ('Pending','Accepted','Revoked')),
 delivery text NOT NULL CHECK (delivery IN ('Sending','Sent','Unknown')),
 send_count integer NOT NULL CHECK (send_count BETWEEN 1 AND 20),
 created_at timestamptz NOT NULL
  CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
 last_sent_at timestamptz NOT NULL
  CHECK (isfinite(last_sent_at) AND last_sent_at=date_trunc('milliseconds',last_sent_at)),
 expires_at timestamptz NOT NULL,
 accepted_at timestamptz
  CHECK (accepted_at IS NULL OR (isfinite(accepted_at) AND accepted_at=date_trunc('milliseconds',accepted_at))),
 revoked_at timestamptz
  CHECK (revoked_at IS NULL OR (isfinite(revoked_at) AND revoked_at=date_trunc('milliseconds',revoked_at))),
 revoked_by_actor_id platform_helpers.uuid_v7,
 version integer NOT NULL CHECK (version>0),
 updated_at timestamptz NOT NULL,
 data_classification text NOT NULL CHECK (data_classification='PersonalData'),
 CONSTRAINT store_staff_invitation_pkey PRIMARY KEY (brand_id,store_id,invitation_id),
 CONSTRAINT store_staff_invitation_reference_unique UNIQUE (invitation_id),
 CONSTRAINT store_staff_invitation_not_self CHECK (invited_by_actor_id<>actor_id),
 CONSTRAINT store_staff_invitation_expiry_check CHECK (
  last_sent_at>=created_at AND expires_at=last_sent_at + interval '7 days'
  AND updated_at>=last_sent_at
 ),
 CONSTRAINT store_staff_invitation_state_check CHECK (
  (status='Pending' AND accepted_at IS NULL AND revoked_at IS NULL AND revoked_by_actor_id IS NULL)
  OR (status='Accepted' AND accepted_at IS NOT NULL AND accepted_at>=created_at
      AND accepted_at<expires_at AND revoked_at IS NULL AND revoked_by_actor_id IS NULL)
  OR (status='Revoked' AND revoked_at IS NOT NULL AND revoked_at>=created_at
      AND revoked_by_actor_id IS NOT NULL AND accepted_at IS NULL)
 )
);
-- One open invitation per person; a person has at most one accepted invitation per Cognito pool.
CREATE UNIQUE INDEX store_staff_invitation_pending_actor_idx
 ON bop_identity.store_staff_invitation (actor_id) WHERE status='Pending';
CREATE UNIQUE INDEX store_staff_invitation_accepted_actor_idx
 ON bop_identity.store_staff_invitation (environment,issuer,actor_id) WHERE status='Accepted';
CREATE INDEX store_staff_invitation_store_idx
 ON bop_identity.store_staff_invitation (brand_id,store_id,status,created_at);

-- Identity and email never change; a Pending invitation is resent or its delivery recorded, or it
-- ends once (Accepted after the account was bound, or Revoked). Ended invitations never change.
CREATE FUNCTION bop_identity.guard_store_staff_invitation_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF OLD.status<>'Pending' OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
  OR (NEW.brand_id,NEW.store_id,NEW.invitation_id,NEW.actor_id,NEW.membership_id,
      NEW.store_assignment_id,NEW.invited_by_actor_id,NEW.invitation_kind,NEW.environment,
      NEW.issuer,NEW.client_id,NEW.intent_digest,NEW.email_digest,NEW.email_hint,NEW.created_at,
      NEW.data_classification)
   IS DISTINCT FROM
     (OLD.brand_id,OLD.store_id,OLD.invitation_id,OLD.actor_id,OLD.membership_id,
      OLD.store_assignment_id,OLD.invited_by_actor_id,OLD.invitation_kind,OLD.environment,
      OLD.issuer,OLD.client_id,OLD.intent_digest,OLD.email_digest,OLD.email_hint,OLD.created_at,
      OLD.data_classification)
 THEN
  RAISE EXCEPTION 'a store staff invitation only changes while pending' USING ERRCODE='55000';
 END IF;
 IF NEW.status='Pending' AND NOT (
  (NEW.send_count=OLD.send_count AND NEW.last_sent_at=OLD.last_sent_at AND OLD.delivery='Sending'
   AND NEW.delivery IN ('Sent','Unknown'))
  OR (NEW.send_count=OLD.send_count+1 AND NEW.last_sent_at>=OLD.last_sent_at AND NEW.delivery='Sending')
 ) THEN
  RAISE EXCEPTION 'a pending invitation records one delivery per send' USING ERRCODE='55000';
 END IF;
 IF NEW.status<>'Pending' AND (NEW.send_count<>OLD.send_count OR NEW.last_sent_at<>OLD.last_sent_at
  OR NEW.delivery<>OLD.delivery) THEN
  RAISE EXCEPTION 'an ending invitation keeps its last delivery' USING ERRCODE='55000';
 END IF;
 IF NEW.status='Accepted' AND NOT EXISTS (
  SELECT 1 FROM bop_identity.store_staff_account a
  WHERE a.invitation_id=NEW.invitation_id AND a.actor_id=NEW.actor_id
   AND a.environment=NEW.environment AND a.issuer=NEW.issuer AND a.bound_at=NEW.accepted_at
 ) THEN
  RAISE EXCEPTION 'STORE_STAFF_INVITATION_ACCOUNT_MISSING' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.guard_store_staff_invitation_update() FROM PUBLIC;
CREATE TRIGGER store_staff_invitation_update_guard BEFORE UPDATE ON bop_identity.store_staff_invitation
 FOR EACH ROW EXECUTE FUNCTION bop_identity.guard_store_staff_invitation_update();
CREATE TRIGGER store_staff_invitation_no_delete BEFORE DELETE ON bop_identity.store_staff_invitation
 FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_store_staff_history_mutation();
CREATE TRIGGER store_staff_invitation_no_truncate BEFORE TRUNCATE ON bop_identity.store_staff_invitation
 FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_store_staff_history_mutation();

CREATE TABLE bop_identity.store_staff_account (
 environment text NOT NULL CHECK (environment ~ '^[a-z][a-z0-9-]{0,63}$'),
 issuer text NOT NULL CHECK (
  issuer ~ '^https://cognito-idp\.ca-central-1\.amazonaws\.com/ca-central-1_[A-Za-z0-9]{1,42}$'
 ),
 subject_hash text NOT NULL CHECK (subject_hash ~ '^[a-f0-9]{64}$'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 invitation_id platform_helpers.uuid_v7 NOT NULL,
 bound_at timestamptz NOT NULL
  CHECK (isfinite(bound_at) AND bound_at=date_trunc('milliseconds',bound_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 data_classification text NOT NULL CHECK (data_classification='RestrictedSecurity'),
 CONSTRAINT store_staff_account_pkey PRIMARY KEY (environment,issuer,subject_hash),
 CONSTRAINT store_staff_account_actor_unique UNIQUE (environment,issuer,actor_id),
 CONSTRAINT store_staff_account_invitation_unique UNIQUE (invitation_id),
 CONSTRAINT store_staff_account_audit_unique UNIQUE (audit_id),
 CONSTRAINT store_staff_account_invitation_fkey FOREIGN KEY (brand_id,store_id,invitation_id)
  REFERENCES bop_identity.store_staff_invitation (brand_id,store_id,invitation_id)
);
-- An account binds only to the person's own pending, unexpired invitation in the same pool.
CREATE FUNCTION bop_identity.check_store_staff_account() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM bop_identity.store_staff_invitation i
  WHERE i.brand_id=NEW.brand_id AND i.store_id=NEW.store_id AND i.invitation_id=NEW.invitation_id
   AND i.actor_id=NEW.actor_id AND i.environment=NEW.environment AND i.issuer=NEW.issuer
   AND i.status='Pending' AND NEW.bound_at>=i.created_at AND NEW.bound_at<i.expires_at
 ) THEN
  RAISE EXCEPTION 'STORE_STAFF_ACCOUNT_UNINVITED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.check_store_staff_account() FROM PUBLIC;
CREATE TRIGGER store_staff_account_check BEFORE INSERT ON bop_identity.store_staff_account
 FOR EACH ROW EXECUTE FUNCTION bop_identity.check_store_staff_account();
CREATE TRIGGER store_staff_account_no_mutation BEFORE UPDATE OR DELETE ON bop_identity.store_staff_account
 FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_store_staff_history_mutation();
CREATE TRIGGER store_staff_account_no_truncate BEFORE TRUNCATE ON bop_identity.store_staff_account
 FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_store_staff_history_mutation();

ALTER TABLE bop_identity.store_staff_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.store_staff_invitation FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.store_staff_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.store_staff_account FORCE ROW LEVEL SECURITY;
-- The selected Store manages its invitations. At sign-in, before any Store is selected, the
-- person named by the signed Cognito username may read and accept only their own invitation.
CREATE POLICY store_staff_invitation_scope ON bop_identity.store_staff_invitation
 USING (
  (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  OR actor_id=NULLIF(pg_catalog.current_setting('bop.store_staff_actor_id', true), '')::uuid
 )
 WITH CHECK (
  (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  OR actor_id=NULLIF(pg_catalog.current_setting('bop.store_staff_actor_id', true), '')::uuid
 );
-- A sign-in finds the account by the keyed subject digest; a session re-reads it by person.
CREATE POLICY store_staff_account_scope ON bop_identity.store_staff_account
 USING (
  subject_hash=NULLIF(pg_catalog.current_setting('bop.store_staff_subject_hash', true), '')
  OR actor_id=NULLIF(pg_catalog.current_setting('bop.store_staff_actor_id', true), '')::uuid
  OR (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 )
 WITH CHECK (
  subject_hash=NULLIF(pg_catalog.current_setting('bop.store_staff_subject_hash', true), '')
  AND actor_id=NULLIF(pg_catalog.current_setting('bop.store_staff_actor_id', true), '')::uuid
 );
REVOKE ALL ON TABLE bop_identity.store_staff_invitation FROM PUBLIC;
REVOKE ALL ON TABLE bop_identity.store_staff_account FROM PUBLIC;

ALTER TABLE bop_identity.workforce_mfa_step_up
 DROP CONSTRAINT workforce_mfa_step_up_method_check;
ALTER TABLE bop_identity.workforce_mfa_step_up
 ADD CONSTRAINT workforce_mfa_step_up_method_check
  CHECK (method IN ('InternalTestTotp','CognitoReauthentication'));
