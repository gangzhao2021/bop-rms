-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q18 (DEC-STAFF-SESSION-CONTINUITY section 5, Owner 2026-10-14 option A): staff switch
-- on a shared Store tablet with a device-bound six-digit PIN.
--   store_sign_in_device  a tablet a manager registered for this Store (signed in fully). Only a
--                         keyed hash of the tablet's secret is stored; the secret lives in an
--                         HttpOnly cookie. Registered once, revoked once, never deleted.
--   staff_pin_credential  each staff member's current PIN at this Store (Argon2id hash, salt and
--                         KDF parameters, never the PIN). Versioned: setting a PIN or a manager
--                         reset writes the next version; a reset erases the hash.
--   staff_pin_attempt     every PIN check on a tablet, append-only (who, which tablet, verified or
--                         rejected, the consecutive failure number). Five consecutive failures lock
--                         that person's PIN for 15 minutes; ten rejected checks on one tablet within
--                         15 minutes pause that tablet. The insert trigger enforces both.
--   staff_pin_session     the ordinary WorkforceStandard session a verified check issued, so
--                         sensitive actions can still require a full sign-in or a recent MFA
--                         step-up in that session. Append-only; one session per verified check.
CREATE FUNCTION bop_identity.reject_staff_pin_history_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only staff PIN history' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.reject_staff_pin_history_mutation() FROM PUBLIC;

CREATE TABLE bop_identity.store_sign_in_device (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 device_id platform_helpers.uuid_v7 NOT NULL,
 device_selector_hash bytea NOT NULL CHECK (octet_length(device_selector_hash)=32),
 label varchar(40) NOT NULL CHECK (
  label=btrim(label) AND char_length(label) BETWEEN 1 AND 40 AND label !~ '[[:cntrl:]]'
 ),
 status text NOT NULL CHECK (status IN ('Active','Revoked')),
 registered_by_actor_id platform_helpers.uuid_v7 NOT NULL,
 registered_by_session_id platform_helpers.uuid_v7 NOT NULL,
 registered_at timestamptz NOT NULL
  CHECK (isfinite(registered_at) AND registered_at=date_trunc('milliseconds',registered_at)),
 revoked_by_actor_id platform_helpers.uuid_v7,
 revoked_at timestamptz
  CHECK (revoked_at IS NULL OR (isfinite(revoked_at) AND revoked_at=date_trunc('milliseconds',revoked_at))),
 version integer NOT NULL,
 data_classification text NOT NULL CHECK (data_classification='RestrictedCredential'),
 CONSTRAINT store_sign_in_device_pkey PRIMARY KEY (brand_id,store_id,device_id),
 CONSTRAINT store_sign_in_device_selector_unique UNIQUE (device_selector_hash),
 CONSTRAINT store_sign_in_device_state_check CHECK (
  (status='Active' AND version=1 AND revoked_by_actor_id IS NULL AND revoked_at IS NULL)
  OR (status='Revoked' AND version=2 AND revoked_by_actor_id IS NOT NULL
      AND revoked_at IS NOT NULL AND revoked_at>=registered_at)
 )
);
CREATE INDEX store_sign_in_device_store_idx
 ON bop_identity.store_sign_in_device (brand_id,store_id,status,registered_at);

-- The only change a registration ever takes is its one revocation.
CREATE FUNCTION bop_identity.guard_store_sign_in_device_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF OLD.status<>'Active' OR NEW.status<>'Revoked' OR NEW.version<>OLD.version+1
  OR (NEW.brand_id,NEW.store_id,NEW.device_id,NEW.device_selector_hash,NEW.label,
      NEW.registered_by_actor_id,NEW.registered_by_session_id,NEW.registered_at,NEW.data_classification)
   IS DISTINCT FROM
     (OLD.brand_id,OLD.store_id,OLD.device_id,OLD.device_selector_hash,OLD.label,
      OLD.registered_by_actor_id,OLD.registered_by_session_id,OLD.registered_at,OLD.data_classification)
 THEN
  RAISE EXCEPTION 'a store device registration is only ever revoked once' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.guard_store_sign_in_device_update() FROM PUBLIC;
CREATE TRIGGER store_sign_in_device_update_guard BEFORE UPDATE ON bop_identity.store_sign_in_device
 FOR EACH ROW EXECUTE FUNCTION bop_identity.guard_store_sign_in_device_update();
CREATE TRIGGER store_sign_in_device_no_delete BEFORE DELETE ON bop_identity.store_sign_in_device
 FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_staff_pin_history_mutation();
CREATE TRIGGER store_sign_in_device_no_truncate BEFORE TRUNCATE ON bop_identity.store_sign_in_device
 FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_staff_pin_history_mutation();

CREATE TABLE bop_identity.staff_pin_credential (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 credential_version integer NOT NULL CHECK (credential_version>0),
 status text NOT NULL CHECK (status IN ('Active','Reset')),
 kdf_algorithm text CHECK (kdf_algorithm='argon2id'),
 kdf_memory_kib integer CHECK (kdf_memory_kib BETWEEN 19456 AND 1048576),
 kdf_passes integer CHECK (kdf_passes BETWEEN 2 AND 16),
 kdf_parallelism integer CHECK (kdf_parallelism BETWEEN 1 AND 8),
 pepper_version integer CHECK (pepper_version>0),
 pin_salt bytea CHECK (octet_length(pin_salt)=16),
 pin_hash bytea CHECK (octet_length(pin_hash)=32),
 changed_by_actor_id platform_helpers.uuid_v7 NOT NULL,
 changed_at timestamptz NOT NULL
  CHECK (isfinite(changed_at) AND changed_at=date_trunc('milliseconds',changed_at)),
 data_classification text NOT NULL CHECK (data_classification='RestrictedCredential'),
 CONSTRAINT staff_pin_credential_pkey PRIMARY KEY (brand_id,store_id,actor_id),
 -- A PIN is only ever set by its own staff member; a reset erases the hash and its parameters.
 CONSTRAINT staff_pin_credential_state_check CHECK (
  (status='Active' AND changed_by_actor_id=actor_id AND kdf_algorithm IS NOT NULL
   AND kdf_memory_kib IS NOT NULL AND kdf_passes IS NOT NULL AND kdf_parallelism IS NOT NULL
   AND pepper_version IS NOT NULL AND pin_salt IS NOT NULL AND pin_hash IS NOT NULL)
  OR (status='Reset' AND kdf_algorithm IS NULL AND kdf_memory_kib IS NULL AND kdf_passes IS NULL
   AND kdf_parallelism IS NULL AND pepper_version IS NULL AND pin_salt IS NULL AND pin_hash IS NULL)
 )
);
CREATE FUNCTION bop_identity.guard_staff_pin_credential_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF (NEW.brand_id,NEW.store_id,NEW.actor_id,NEW.data_classification)
     IS DISTINCT FROM (OLD.brand_id,OLD.store_id,OLD.actor_id,OLD.data_classification)
  OR NEW.credential_version<>OLD.credential_version+1
  OR NEW.changed_at<OLD.changed_at
 THEN
  RAISE EXCEPTION 'a staff PIN changes only to its next version' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.guard_staff_pin_credential_update() FROM PUBLIC;
CREATE TRIGGER staff_pin_credential_update_guard BEFORE UPDATE ON bop_identity.staff_pin_credential
 FOR EACH ROW EXECUTE FUNCTION bop_identity.guard_staff_pin_credential_update();
CREATE TRIGGER staff_pin_credential_no_delete BEFORE DELETE ON bop_identity.staff_pin_credential
 FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_staff_pin_history_mutation();
CREATE TRIGGER staff_pin_credential_no_truncate BEFORE TRUNCATE ON bop_identity.staff_pin_credential
 FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_staff_pin_history_mutation();

CREATE TABLE bop_identity.staff_pin_attempt (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 attempt_id platform_helpers.uuid_v7 NOT NULL,
 device_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 credential_version integer CHECK (credential_version>0),
 outcome text NOT NULL CHECK (outcome IN ('Verified','Rejected')),
 rejection_reason text CHECK (rejection_reason IN ('PinMismatch','NoActivePin')),
 failure_number smallint CHECK (failure_number BETWEEN 1 AND 5),
 attempted_at timestamptz NOT NULL
  CHECK (isfinite(attempted_at) AND attempted_at=date_trunc('milliseconds',attempted_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 data_classification text NOT NULL CHECK (data_classification='IndirectIdentifier'),
 CONSTRAINT staff_pin_attempt_pkey PRIMARY KEY (brand_id,store_id,attempt_id),
 CONSTRAINT staff_pin_attempt_audit_unique UNIQUE (audit_id),
 CONSTRAINT staff_pin_attempt_device_fkey FOREIGN KEY (brand_id,store_id,device_id)
  REFERENCES bop_identity.store_sign_in_device (brand_id,store_id,device_id),
 CONSTRAINT staff_pin_attempt_result_check CHECK (
  (outcome='Verified' AND credential_version IS NOT NULL AND rejection_reason IS NULL
   AND failure_number IS NULL)
  OR (outcome='Rejected' AND rejection_reason='PinMismatch' AND credential_version IS NOT NULL
   AND failure_number IS NOT NULL)
  OR (outcome='Rejected' AND rejection_reason='NoActivePin' AND credential_version IS NULL
   AND failure_number IS NULL)
 )
);
CREATE INDEX staff_pin_attempt_actor_idx
 ON bop_identity.staff_pin_attempt (brand_id,store_id,actor_id,attempted_at DESC);
CREATE INDEX staff_pin_attempt_device_idx
 ON bop_identity.staff_pin_attempt (brand_id,store_id,device_id,attempted_at DESC);

-- Checks are serialised per staff member and recorded in time order. A check needs an active
-- tablet of this Store; ten rejected checks on one tablet in 15 minutes pause it; a PIN check
-- names the current active PIN version, is refused while five consecutive failures (each within
-- 15 minutes of the previous) are less than 15 minutes old, and numbers its failure exactly.
CREATE FUNCTION bop_identity.check_staff_pin_attempt() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 latest record;
 found_latest boolean;
 expected smallint;
 device_failures integer;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  'StaffPinAttempt:' || NEW.brand_id::text || ':' || NEW.store_id::text || ':' || NEW.actor_id::text, 0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  'StaffPinDevice:' || NEW.brand_id::text || ':' || NEW.store_id::text || ':' || NEW.device_id::text, 0));
 IF NOT EXISTS (
  SELECT 1 FROM bop_identity.store_sign_in_device d
  WHERE d.brand_id=NEW.brand_id AND d.store_id=NEW.store_id AND d.device_id=NEW.device_id
   AND d.status='Active'
 ) THEN
  RAISE EXCEPTION 'STAFF_PIN_DEVICE_INACTIVE' USING ERRCODE='23514';
 END IF;
 IF EXISTS (
  SELECT 1 FROM bop_identity.staff_pin_attempt a
  WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id AND a.actor_id=NEW.actor_id
   AND a.attempted_at>NEW.attempted_at
 ) THEN
  RAISE EXCEPTION 'STAFF_PIN_ATTEMPT_OUT_OF_ORDER' USING ERRCODE='23514';
 END IF;
 SELECT count(*) INTO device_failures FROM bop_identity.staff_pin_attempt a
 WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id AND a.device_id=NEW.device_id
  AND a.outcome='Rejected' AND a.attempted_at>NEW.attempted_at - interval '15 minutes';
 IF device_failures>=10 THEN
  RAISE EXCEPTION 'STAFF_PIN_DEVICE_THROTTLED' USING ERRCODE='23514';
 END IF;
 IF NEW.credential_version IS NULL THEN
  RETURN NEW;
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM bop_identity.staff_pin_credential c
  WHERE c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.actor_id=NEW.actor_id
   AND c.credential_version=NEW.credential_version AND c.status='Active'
 ) THEN
  RAISE EXCEPTION 'STAFF_PIN_CREDENTIAL_NOT_CURRENT' USING ERRCODE='23514';
 END IF;
 SELECT a.outcome,a.failure_number,a.attempted_at INTO latest FROM bop_identity.staff_pin_attempt a
 WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id AND a.actor_id=NEW.actor_id
  AND a.credential_version=NEW.credential_version
 ORDER BY a.attempted_at DESC,a.attempt_id DESC LIMIT 1;
 found_latest := FOUND;
 IF found_latest AND latest.failure_number=5
  AND latest.attempted_at>NEW.attempted_at - interval '15 minutes' THEN
  RAISE EXCEPTION 'STAFF_PIN_LOCKED' USING ERRCODE='23514';
 END IF;
 IF NEW.outcome='Rejected' THEN
  expected := CASE
   WHEN found_latest AND latest.outcome='Rejected' AND latest.failure_number<5
    AND latest.attempted_at>NEW.attempted_at - interval '15 minutes'
   THEN latest.failure_number+1 ELSE 1 END;
  IF NEW.failure_number<>expected THEN
   RAISE EXCEPTION 'STAFF_PIN_FAILURE_NUMBER' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.check_staff_pin_attempt() FROM PUBLIC;
CREATE TRIGGER staff_pin_attempt_check BEFORE INSERT ON bop_identity.staff_pin_attempt
 FOR EACH ROW EXECUTE FUNCTION bop_identity.check_staff_pin_attempt();
CREATE TRIGGER staff_pin_attempt_no_mutation BEFORE UPDATE OR DELETE ON bop_identity.staff_pin_attempt
 FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_staff_pin_history_mutation();
CREATE TRIGGER staff_pin_attempt_no_truncate BEFORE TRUNCATE ON bop_identity.staff_pin_attempt
 FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_staff_pin_history_mutation();

CREATE TABLE bop_identity.staff_pin_session (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 attempt_id platform_helpers.uuid_v7 NOT NULL,
 device_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 issued_at timestamptz NOT NULL
  CHECK (isfinite(issued_at) AND issued_at=date_trunc('milliseconds',issued_at)),
 data_classification text NOT NULL CHECK (data_classification='IndirectIdentifier'),
 CONSTRAINT staff_pin_session_pkey PRIMARY KEY (brand_id,store_id,session_id),
 CONSTRAINT staff_pin_session_session_unique UNIQUE (session_id),
 CONSTRAINT staff_pin_session_attempt_unique UNIQUE (brand_id,store_id,attempt_id),
 CONSTRAINT staff_pin_session_attempt_fkey FOREIGN KEY (brand_id,store_id,attempt_id)
  REFERENCES bop_identity.staff_pin_attempt (brand_id,store_id,attempt_id),
 CONSTRAINT staff_pin_session_device_fkey FOREIGN KEY (brand_id,store_id,device_id)
  REFERENCES bop_identity.store_sign_in_device (brand_id,store_id,device_id),
 CONSTRAINT staff_pin_session_authentication_fkey FOREIGN KEY (session_id)
  REFERENCES bop_identity.authentication_session (session_id)
);
CREATE INDEX staff_pin_session_device_idx
 ON bop_identity.staff_pin_session (brand_id,store_id,device_id,issued_at DESC);
CREATE INDEX staff_pin_session_actor_idx
 ON bop_identity.staff_pin_session (brand_id,store_id,actor_id,issued_at DESC);

-- A PIN session exists only for a verified check of the same person on the same active tablet,
-- issued within two minutes of it, as that person's new active WorkforceStandard session.
CREATE FUNCTION bop_identity.check_staff_pin_session() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM bop_identity.staff_pin_attempt a
  JOIN bop_identity.store_sign_in_device d
   ON d.brand_id=a.brand_id AND d.store_id=a.store_id AND d.device_id=a.device_id
  WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id AND a.attempt_id=NEW.attempt_id
   AND a.outcome='Verified' AND a.actor_id=NEW.actor_id AND a.device_id=NEW.device_id
   AND d.status='Active'
   AND NEW.issued_at>=a.attempted_at AND NEW.issued_at<=a.attempted_at + interval '2 minutes'
 ) OR NOT EXISTS (
  SELECT 1 FROM bop_identity.authentication_session s
  WHERE s.session_id=NEW.session_id AND s.actor_id=NEW.actor_id AND s.status='Active'
   AND s.policy_code='WorkforceStandard' AND s.created_at=NEW.issued_at
 ) THEN
  RAISE EXCEPTION 'STAFF_PIN_SESSION_UNVERIFIED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.check_staff_pin_session() FROM PUBLIC;
CREATE TRIGGER staff_pin_session_check BEFORE INSERT ON bop_identity.staff_pin_session
 FOR EACH ROW EXECUTE FUNCTION bop_identity.check_staff_pin_session();
CREATE TRIGGER staff_pin_session_no_mutation BEFORE UPDATE OR DELETE ON bop_identity.staff_pin_session
 FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_staff_pin_history_mutation();
CREATE TRIGGER staff_pin_session_no_truncate BEFORE TRUNCATE ON bop_identity.staff_pin_session
 FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_staff_pin_history_mutation();

ALTER TABLE bop_identity.store_sign_in_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.store_sign_in_device FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.staff_pin_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.staff_pin_credential FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.staff_pin_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.staff_pin_attempt FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.staff_pin_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.staff_pin_session FORCE ROW LEVEL SECURITY;
-- A tablet that presents its own secret (before any Store is known) may read its own row only.
CREATE POLICY store_sign_in_device_scope ON bop_identity.store_sign_in_device
 USING (
  (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  OR device_selector_hash=pg_catalog.decode(
   NULLIF(pg_catalog.current_setting('bop.identity_device_selector', true), ''), 'hex')
 )
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY staff_pin_credential_scope ON bop_identity.staff_pin_credential
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY staff_pin_attempt_scope ON bop_identity.staff_pin_attempt
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
-- A session may learn whether it was issued by a PIN (whatever Store is selected now).
CREATE POLICY staff_pin_session_scope ON bop_identity.staff_pin_session
 USING (
  (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  OR session_id=NULLIF(pg_catalog.current_setting('bop.identity_session_id', true), '')::uuid
 )
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_identity.store_sign_in_device FROM PUBLIC;
REVOKE ALL ON TABLE bop_identity.staff_pin_credential FROM PUBLIC;
REVOKE ALL ON TABLE bop_identity.staff_pin_attempt FROM PUBLIC;
REVOKE ALL ON TABLE bop_identity.staff_pin_session FROM PUBLIC;
