-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 2): opening a table asks no
-- party size unless the owner turns "ask how many guests when opening a table" on (a Dining
-- service switch, off by default; existing versions read as off). With it on, staff record how
-- many guests sit at the table; each change (more guests arrive, some leave) is the table's next
-- version, with who and when. Append-only, Store RLS. A table that closed or was cancelled takes
-- no new party size.
-- Grants: api SELECT/INSERT on dining_session_party_size (Owner standing approval 2026-10-14,
-- WP-2423); dining_service_setting keeps its grants.
ALTER TABLE rms_dining.dining_service_setting
 ADD COLUMN ask_party_size boolean NOT NULL DEFAULT false;

CREATE TABLE rms_dining.dining_session_party_size (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 99),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 PRIMARY KEY (brand_id,store_id,session_id,version),
 CONSTRAINT dining_session_party_size_operation UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT dining_session_party_size_session FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
  REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id)
);

-- Versions follow one another per table session, only while the table is open or checking out.
CREATE FUNCTION rms_dining.validate_dining_session_party_size() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE latest integer; session_phase text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningPartySize:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.session_id,0));
 SELECT s.phase INTO session_phase FROM rms_dining.dining_session s
  WHERE s.tenant_id=NEW.tenant_id AND s.brand_id=NEW.brand_id AND s.store_id=NEW.store_id AND s.session_id=NEW.session_id;
 IF session_phase IS NULL OR session_phase NOT IN ('Active','Closing') THEN
  RAISE EXCEPTION 'party size only for an open table' USING ERRCODE='23514';
 END IF;
 SELECT max(version) INTO latest FROM rms_dining.dining_session_party_size
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id;
 IF NEW.version<>coalesce(latest,0)+1 THEN
  RAISE EXCEPTION 'party size version out of order' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_session_party_size_order BEFORE INSERT ON rms_dining.dining_session_party_size
 FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_dining_session_party_size();

CREATE FUNCTION rms_dining.reject_dining_session_party_size_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only party size' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER dining_session_party_size_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_session_party_size
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_dining_session_party_size_mutation();
CREATE TRIGGER dining_session_party_size_no_truncate BEFORE TRUNCATE ON rms_dining.dining_session_party_size
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_dining_session_party_size_mutation();

ALTER TABLE rms_dining.dining_session_party_size ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_session_party_size FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_session_party_size_scope ON rms_dining.dining_session_party_size
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_session_party_size FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.validate_dining_session_party_size() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.reject_dining_session_party_size_mutation() FROM PUBLIC;
