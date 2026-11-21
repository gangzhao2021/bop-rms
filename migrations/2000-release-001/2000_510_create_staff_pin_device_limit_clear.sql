-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 M63: ten wrong PINs on one shared tablet within 15 minutes pause the tablet for
-- everyone. An owner or manager (who holds identity.staff_pin.reset at the Store) may still enter
-- their own PIN on it; their own five-try lock still applies. Each of their checks while the tablet
-- is paused is recorded here first (append-only), naming the attempt; once one of those attempts
-- is verified the tablet's count starts again from that moment, so the next cashier can sign in.
--   staff_pin_device_limit_clear  one row per PIN check made past the tablet limit by a person the
--                                 server judged may clear it; a verified one clears the limit.
CREATE TABLE bop_identity.staff_pin_device_limit_clear (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 attempt_id platform_helpers.uuid_v7 NOT NULL,
 device_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 permission_code text NOT NULL CHECK (permission_code='identity.staff_pin.reset'),
 decided_at timestamptz NOT NULL
  CHECK (isfinite(decided_at) AND decided_at=date_trunc('milliseconds',decided_at)),
 data_classification text NOT NULL CHECK (data_classification='IndirectIdentifier'),
 CONSTRAINT staff_pin_device_limit_clear_pkey PRIMARY KEY (brand_id,store_id,attempt_id),
 CONSTRAINT staff_pin_device_limit_clear_device_fkey FOREIGN KEY (brand_id,store_id,device_id)
  REFERENCES bop_identity.store_sign_in_device (brand_id,store_id,device_id)
);
CREATE INDEX staff_pin_device_limit_clear_device_idx
 ON bop_identity.staff_pin_device_limit_clear (brand_id,store_id,device_id,decided_at DESC);
CREATE TRIGGER staff_pin_device_limit_clear_no_mutation
 BEFORE UPDATE OR DELETE ON bop_identity.staff_pin_device_limit_clear
 FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_staff_pin_history_mutation();
CREATE TRIGGER staff_pin_device_limit_clear_no_truncate
 BEFORE TRUNCATE ON bop_identity.staff_pin_device_limit_clear
 FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_staff_pin_history_mutation();

-- The clear names the attempt it is for: that attempt (inserted next in the same transaction) is the
-- same person's, on the same tablet, at the same instant.
CREATE FUNCTION bop_identity.check_staff_pin_device_limit_clear() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM bop_identity.staff_pin_attempt a
  WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id AND a.attempt_id=NEW.attempt_id
   AND a.device_id=NEW.device_id AND a.actor_id=NEW.actor_id AND a.attempted_at=NEW.decided_at
 ) THEN
  RAISE EXCEPTION 'STAFF_PIN_DEVICE_LIMIT_CLEAR_UNMATCHED' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.check_staff_pin_device_limit_clear() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER staff_pin_device_limit_clear_matches_attempt
 AFTER INSERT ON bop_identity.staff_pin_device_limit_clear
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION bop_identity.check_staff_pin_device_limit_clear();

-- The tablet limit counts rejected checks since the latest verified check made past the limit,
-- and lets a check past the limit only when its clear row was recorded first.
CREATE OR REPLACE FUNCTION bop_identity.check_staff_pin_attempt() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 latest record;
 found_latest boolean;
 expected smallint;
 device_failures integer;
 cleared_at timestamptz;
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
 SELECT max(a.attempted_at) INTO cleared_at
 FROM bop_identity.staff_pin_device_limit_clear c
 JOIN bop_identity.staff_pin_attempt a
  ON a.brand_id=c.brand_id AND a.store_id=c.store_id AND a.attempt_id=c.attempt_id
 WHERE c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.device_id=NEW.device_id
  AND a.outcome='Verified';
 SELECT count(*) INTO device_failures FROM bop_identity.staff_pin_attempt a
 WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id AND a.device_id=NEW.device_id
  AND a.outcome='Rejected' AND a.attempted_at>NEW.attempted_at - interval '15 minutes'
  AND a.attempted_at>coalesce(cleared_at,'-infinity'::timestamptz);
 IF device_failures>=10 AND NOT EXISTS (
  SELECT 1 FROM bop_identity.staff_pin_device_limit_clear c
  WHERE c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.attempt_id=NEW.attempt_id
   AND c.device_id=NEW.device_id AND c.actor_id=NEW.actor_id AND c.decided_at=NEW.attempted_at
 ) THEN
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

ALTER TABLE bop_identity.staff_pin_device_limit_clear ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.staff_pin_device_limit_clear FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_pin_device_limit_clear_scope ON bop_identity.staff_pin_device_limit_clear
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_identity.staff_pin_device_limit_clear FROM PUBLIC;
