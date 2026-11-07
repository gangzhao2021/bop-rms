-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 2, coordinator 2026-10-29): staff
-- charge tea for fewer (or more) guests than sit at the table, for example a child not charged,
-- with the reason, who and when. The count holds for the party size it was set at; when the party
-- size changes, the tea follows the guests again. Each change is the table's next version;
-- append-only, Store RLS, only while the table is open or checking out.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_dining.dining_session_tea_override (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 -- The party size version this count was set for (a later party size makes tea follow it again).
 party_size_version integer NOT NULL CHECK (party_size_version BETWEEN 1 AND 1000),
 tea_quantity integer NOT NULL CHECK (tea_quantity BETWEEN 0 AND 99),
 reason_code text NOT NULL CHECK (reason_code IN ('ChildNotCharged','GuestDeclined','Other')),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 PRIMARY KEY (brand_id,store_id,session_id,version),
 CONSTRAINT dining_session_tea_override_operation UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT dining_session_tea_override_session FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
  REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id)
);

-- Versions follow one another per table session, only while the table is open or checking out.
CREATE FUNCTION rms_dining.validate_dining_session_tea_override() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE latest integer; session_phase text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningTeaOverride:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.session_id,0));
 SELECT s.phase INTO session_phase FROM rms_dining.dining_session s
  WHERE s.tenant_id=NEW.tenant_id AND s.brand_id=NEW.brand_id AND s.store_id=NEW.store_id AND s.session_id=NEW.session_id;
 IF session_phase IS NULL OR session_phase NOT IN ('Active','Closing') THEN
  RAISE EXCEPTION 'tea count only for an open table' USING ERRCODE='23514';
 END IF;
 SELECT max(version) INTO latest FROM rms_dining.dining_session_tea_override
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id;
 IF NEW.version<>coalesce(latest,0)+1 THEN
  RAISE EXCEPTION 'tea override version out of order' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_session_tea_override_order BEFORE INSERT ON rms_dining.dining_session_tea_override
 FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_dining_session_tea_override();

CREATE FUNCTION rms_dining.reject_dining_session_tea_override_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only tea override' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER dining_session_tea_override_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_session_tea_override
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_dining_session_tea_override_mutation();
CREATE TRIGGER dining_session_tea_override_no_truncate BEFORE TRUNCATE ON rms_dining.dining_session_tea_override
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_dining_session_tea_override_mutation();

ALTER TABLE rms_dining.dining_session_tea_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_session_tea_override FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_session_tea_override_scope ON rms_dining.dining_session_tea_override
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_session_tea_override FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.validate_dining_session_tea_override() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.reject_dining_session_tea_override_mutation() FROM PUBLIC;
