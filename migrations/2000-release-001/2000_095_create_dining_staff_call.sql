-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q28 (DEC-DINING-STAFF-CALL, 2026-10-25): a seated guest asks staff to come to the table
-- from their own phone, choosing a reason (no free text). Append-only: a call, and later one
-- closure of it (staff answered, or the guest withdrew it). A Session has at most one open call,
-- and at most 6 calls in any 30 minutes; the store checks both under the Session lock and the
-- trigger re-checks them. Grants: api SELECT/INSERT on both tables (Owner standing approval
-- 2026-10-14, WP-2423).
CREATE TABLE rms_dining.dining_staff_call (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 call_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 participant_id platform_helpers.uuid_v7 NOT NULL,
 reason text NOT NULL CHECK (reason IN ('Question','TableNeeds','OrderProblem')),
 intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
 called_at timestamptz NOT NULL CHECK (isfinite(called_at) AND called_at=date_trunc('milliseconds',called_at)),
 PRIMARY KEY (brand_id,store_id,call_id),
 CONSTRAINT dining_staff_call_session_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
  REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
 CONSTRAINT dining_staff_call_participant_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id,participant_id)
  REFERENCES rms_dining.dining_participant(tenant_id,brand_id,store_id,session_id,participant_id)
);
CREATE INDEX dining_staff_call_session_idx
 ON rms_dining.dining_staff_call (tenant_id,brand_id,store_id,session_id,called_at);

CREATE TABLE rms_dining.dining_staff_call_closure (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 call_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 kind text NOT NULL CHECK (kind IN ('Answered','Withdrawn')),
 actor_id platform_helpers.uuid_v7,
 participant_id platform_helpers.uuid_v7,
 intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
 closed_at timestamptz NOT NULL CHECK (isfinite(closed_at) AND closed_at=date_trunc('milliseconds',closed_at)),
 PRIMARY KEY (brand_id,store_id,call_id),
 CONSTRAINT dining_staff_call_closure_operation UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT dining_staff_call_closure_call_fk FOREIGN KEY (brand_id,store_id,call_id)
  REFERENCES rms_dining.dining_staff_call(brand_id,store_id,call_id),
 -- Staff answer (who did it is the staff member); the guest withdraws their own Session's call.
 CONSTRAINT dining_staff_call_closure_actor CHECK (
  (kind='Answered' AND actor_id IS NOT NULL AND participant_id IS NULL)
  OR (kind='Withdrawn' AND actor_id IS NULL AND participant_id IS NOT NULL)
 )
);

-- Defense in depth for what the store proves under its Table/Session/participant locks.
CREATE FUNCTION rms_dining.validate_dining_staff_call_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM rms_dining.dining_session WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id AND phase='Active')
 OR NOT EXISTS(SELECT 1 FROM rms_dining.dining_participant WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id AND participant_id=NEW.participant_id AND status='Active') THEN
  RAISE EXCEPTION 'staff call source mismatch' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM rms_dining.dining_staff_call c WHERE c.tenant_id=NEW.tenant_id AND c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.session_id=NEW.session_id
  AND NOT EXISTS(SELECT 1 FROM rms_dining.dining_staff_call_closure x WHERE x.brand_id=c.brand_id AND x.store_id=c.store_id AND x.call_id=c.call_id)) THEN
  RAISE EXCEPTION 'staff call already open' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM rms_dining.dining_staff_call WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id AND called_at>NEW.called_at-interval '30 minutes' AND called_at<=NEW.called_at)>=6 THEN
  RAISE EXCEPTION 'staff call budget exceeded' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_dining.validate_dining_staff_call_insert() FROM PUBLIC;
CREATE TRIGGER dining_staff_call_source BEFORE INSERT ON rms_dining.dining_staff_call
 FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_dining_staff_call_insert();

CREATE FUNCTION rms_dining.validate_dining_staff_call_closure_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 call rms_dining.dining_staff_call%ROWTYPE;
BEGIN
 SELECT * INTO call FROM rms_dining.dining_staff_call WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND call_id=NEW.call_id;
 IF NOT FOUND OR call.tenant_id<>NEW.tenant_id OR NEW.closed_at<call.called_at
 OR (NEW.kind='Withdrawn' AND NEW.participant_id IS DISTINCT FROM call.participant_id
  AND NOT EXISTS(SELECT 1 FROM rms_dining.dining_participant WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=call.session_id AND participant_id=NEW.participant_id AND status='Active')) THEN
  RAISE EXCEPTION 'staff call closure source mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_dining.validate_dining_staff_call_closure_insert() FROM PUBLIC;
CREATE TRIGGER dining_staff_call_closure_source BEFORE INSERT ON rms_dining.dining_staff_call_closure
 FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_dining_staff_call_closure_insert();

CREATE FUNCTION rms_dining.reject_dining_staff_call_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only staff call history' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_dining.reject_dining_staff_call_mutation() FROM PUBLIC;
CREATE TRIGGER dining_staff_call_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_staff_call
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_dining_staff_call_mutation();
CREATE TRIGGER dining_staff_call_no_truncate BEFORE TRUNCATE ON rms_dining.dining_staff_call
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_dining_staff_call_mutation();
CREATE TRIGGER dining_staff_call_closure_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_staff_call_closure
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_dining_staff_call_mutation();
CREATE TRIGGER dining_staff_call_closure_no_truncate BEFORE TRUNCATE ON rms_dining.dining_staff_call_closure
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_dining_staff_call_mutation();

ALTER TABLE rms_dining.dining_staff_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_staff_call FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_staff_call_scope ON rms_dining.dining_staff_call
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_dining.dining_staff_call_closure ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_staff_call_closure FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_staff_call_closure_scope ON rms_dining.dining_staff_call_closure
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_staff_call FROM PUBLIC;
REVOKE ALL ON TABLE rms_dining.dining_staff_call_closure FROM PUBLIC;
