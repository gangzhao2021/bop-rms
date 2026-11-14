-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-DINE-IN-PAY-LATER (Owner 2026-10-26): a Store chooses when dine-in guests pay —
-- each round before it goes to the kitchen ("PayFirst", the way it worked so far) or once for the
-- whole table at the end ("PayLater"). Each change is a new version naming who changed it and
-- when; nothing is overwritten. A table keeps the way it was opened with: when a dining Session
-- starts, the Store's current choice (PayFirst when it never chose) is recorded for that Session in
-- the same transaction, so a later change only affects tables opened after it.
-- Grants: api SELECT/INSERT on the Store choice, SELECT on the Session record (written by the
-- trigger only) — Owner standing approval 2026-10-14, WP-2423.
CREATE TABLE rms_dining.store_dining_payment_timing (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
 payment_timing text NOT NULL CHECK (payment_timing IN ('PayFirst','PayLater')),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 changed_at timestamptz NOT NULL CHECK (isfinite(changed_at) AND changed_at=date_trunc('milliseconds',changed_at)),
 PRIMARY KEY (brand_id,store_id,version),
 CONSTRAINT store_dining_payment_timing_operation UNIQUE (brand_id,store_id,operation_id)
);

-- Versions follow one another without gaps, and in time.
CREATE FUNCTION rms_dining.validate_store_dining_payment_timing_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 latest rms_dining.store_dining_payment_timing%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('StoreDiningPaymentTiming:'||NEW.brand_id||':'||NEW.store_id,0));
 SELECT * INTO latest FROM rms_dining.store_dining_payment_timing
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id ORDER BY version DESC LIMIT 1;
 IF (NOT FOUND AND NEW.version<>1)
 OR (FOUND AND (NEW.version<>latest.version+1 OR NEW.changed_at<latest.changed_at OR NEW.tenant_id<>latest.tenant_id)) THEN
  RAISE EXCEPTION 'dining payment timing version out of order' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_dining.validate_store_dining_payment_timing_insert() FROM PUBLIC;
CREATE TRIGGER store_dining_payment_timing_order BEFORE INSERT ON rms_dining.store_dining_payment_timing
 FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_store_dining_payment_timing_insert();

CREATE TABLE rms_dining.dining_session_payment_timing (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 payment_timing text NOT NULL CHECK (payment_timing IN ('PayFirst','PayLater')),
 -- The Store choice it came from; null when the Store never chose (PayFirst).
 timing_version bigint CHECK (timing_version BETWEEN 1 AND 9007199254740991),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 PRIMARY KEY (brand_id,store_id,session_id),
 CONSTRAINT dining_session_payment_timing_session_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
  REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
 CONSTRAINT dining_session_payment_timing_source_fk FOREIGN KEY (brand_id,store_id,timing_version)
  REFERENCES rms_dining.store_dining_payment_timing(brand_id,store_id,version),
 CONSTRAINT dining_session_payment_timing_default CHECK (timing_version IS NOT NULL OR payment_timing='PayFirst')
);

-- The Session takes the Store's choice at the moment it starts, whoever starts it.
CREATE FUNCTION rms_dining.record_dining_session_payment_timing() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
 latest rms_dining.store_dining_payment_timing%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('StoreDiningPaymentTiming:'||NEW.brand_id||':'||NEW.store_id,0));
 SELECT * INTO latest FROM rms_dining.store_dining_payment_timing
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id ORDER BY version DESC LIMIT 1;
 INSERT INTO rms_dining.dining_session_payment_timing
  (tenant_id,brand_id,store_id,session_id,payment_timing,timing_version,recorded_at)
 VALUES (NEW.tenant_id,NEW.brand_id,NEW.store_id,NEW.session_id,
  CASE WHEN FOUND THEN latest.payment_timing ELSE 'PayFirst' END,
  CASE WHEN FOUND THEN latest.version ELSE NULL END,
  NEW.started_at);
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_dining.record_dining_session_payment_timing() FROM PUBLIC;
CREATE TRIGGER dining_session_payment_timing_capture AFTER INSERT ON rms_dining.dining_session
 FOR EACH ROW EXECUTE FUNCTION rms_dining.record_dining_session_payment_timing();

CREATE FUNCTION rms_dining.reject_dining_payment_timing_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only dining payment timing' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_dining.reject_dining_payment_timing_mutation() FROM PUBLIC;
CREATE TRIGGER store_dining_payment_timing_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.store_dining_payment_timing
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_dining_payment_timing_mutation();
CREATE TRIGGER store_dining_payment_timing_no_truncate BEFORE TRUNCATE ON rms_dining.store_dining_payment_timing
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_dining_payment_timing_mutation();
CREATE TRIGGER dining_session_payment_timing_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_session_payment_timing
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_dining_payment_timing_mutation();
CREATE TRIGGER dining_session_payment_timing_no_truncate BEFORE TRUNCATE ON rms_dining.dining_session_payment_timing
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_dining_payment_timing_mutation();

ALTER TABLE rms_dining.store_dining_payment_timing ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.store_dining_payment_timing FORCE ROW LEVEL SECURITY;
CREATE POLICY store_dining_payment_timing_scope ON rms_dining.store_dining_payment_timing
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.store_dining_payment_timing FROM PUBLIC;

ALTER TABLE rms_dining.dining_session_payment_timing ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_session_payment_timing FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_session_payment_timing_scope ON rms_dining.dining_session_payment_timing
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_session_payment_timing FROM PUBLIC;
