-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN (Owner 2026-10-28 decisions 1 and 17): while a table is
-- open its QR code joins a guest directly. Each such join is the Session's next one-time join
-- capability, issued for the guest scanning the table (this append-only record, never the code)
-- and consumed by the existing join in the next step, so the join records and their checks are
-- unchanged. Staff may pause QR joining for the table (then a code from staff or the host is
-- needed) and resume it, and take a phone off the table (the participant leaves; recorded here).
-- The database refuses a QR issue while paused, for a Session that is not Active, and beyond 12
-- per Session in any 10 minutes. Append-only, Store RLS.
-- Grants: api SELECT/INSERT on the three tables, api UPDATE on dining_participant's status,
-- version and snapshot for the leave transition (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_dining.dining_qr_join_issue (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,
 capability_id platform_helpers.uuid_v7 NOT NULL,
 intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,store_id,operation_id),
 CONSTRAINT dining_qr_join_issue_capability UNIQUE (capability_id),
 CONSTRAINT dining_qr_join_issue_session_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
  REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
 CONSTRAINT dining_qr_join_issue_capability_fk FOREIGN KEY (capability_id)
  REFERENCES rms_dining.dining_join_capability(capability_id)
);
CREATE INDEX dining_qr_join_issue_window_idx
 ON rms_dining.dining_qr_join_issue (tenant_id,brand_id,store_id,session_id,occurred_at);

CREATE TABLE rms_dining.dining_qr_join_control (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 state text NOT NULL CHECK (state IN ('Paused','Open')),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,store_id,operation_id),
 CONSTRAINT dining_qr_join_control_session_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
  REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id)
);
CREATE INDEX dining_qr_join_control_session_idx
 ON rms_dining.dining_qr_join_control (tenant_id,brand_id,store_id,session_id,occurred_at);

CREATE TABLE rms_dining.dining_participant_removal (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 participant_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,store_id,operation_id),
 CONSTRAINT dining_participant_removal_once UNIQUE (tenant_id,brand_id,store_id,session_id,participant_id),
 CONSTRAINT dining_participant_removal_participant_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id,participant_id)
  REFERENCES rms_dining.dining_participant(tenant_id,brand_id,store_id,session_id,participant_id)
);

-- A QR issue only for an Active Session whose QR joining is not paused, within its budget; the
-- recorded capability is the Session's (checked under the Session's lock).
CREATE FUNCTION rms_dining.validate_qr_join_issue() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningQrJoin:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.session_id,0));
 IF NOT EXISTS (SELECT 1 FROM rms_dining.dining_session s WHERE s.tenant_id=NEW.tenant_id
   AND s.brand_id=NEW.brand_id AND s.store_id=NEW.store_id AND s.session_id=NEW.session_id AND s.phase='Active') THEN
  RAISE EXCEPTION 'the table is not open for joining' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM rms_dining.dining_join_capability c WHERE c.capability_id=NEW.capability_id
   AND c.tenant_id=NEW.tenant_id AND c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id
   AND c.session_id=NEW.session_id AND c.status='Active') THEN
  RAISE EXCEPTION 'QR join capability does not match' USING ERRCODE='23514';
 END IF;
 IF coalesce((SELECT c.state FROM rms_dining.dining_qr_join_control c WHERE c.tenant_id=NEW.tenant_id
   AND c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.session_id=NEW.session_id
   ORDER BY c.occurred_at DESC, c.operation_id DESC LIMIT 1),'Open') = 'Paused' THEN
  RAISE EXCEPTION 'QR joining is paused for the table' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM rms_dining.dining_qr_join_issue i WHERE i.tenant_id=NEW.tenant_id
   AND i.brand_id=NEW.brand_id AND i.store_id=NEW.store_id AND i.session_id=NEW.session_id
   AND i.occurred_at > NEW.occurred_at - interval '10 minutes') >= 12 THEN
  RAISE EXCEPTION 'too many joins for the table' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_qr_join_issue_validate BEFORE INSERT ON rms_dining.dining_qr_join_issue
 FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_qr_join_issue();

-- Pause and resume alternate (the first is a pause), for an Active or Closing Session.
CREATE FUNCTION rms_dining.validate_qr_join_control() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 latest text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('DiningQrJoin:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.session_id,0));
 SELECT c.state INTO latest FROM rms_dining.dining_qr_join_control c WHERE c.tenant_id=NEW.tenant_id
  AND c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.session_id=NEW.session_id
  ORDER BY c.occurred_at DESC, c.operation_id DESC LIMIT 1;
 IF coalesce(latest,'Open') = NEW.state THEN
  RAISE EXCEPTION 'QR joining is already %', lower(NEW.state) USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM rms_dining.dining_session s WHERE s.tenant_id=NEW.tenant_id
   AND s.brand_id=NEW.brand_id AND s.store_id=NEW.store_id AND s.session_id=NEW.session_id
   AND s.phase IN ('Active','Closing')) THEN
  RAISE EXCEPTION 'the table is not open' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_qr_join_control_validate BEFORE INSERT ON rms_dining.dining_qr_join_control
 FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_qr_join_control();

-- A removal is of an Active participant of an Active or Closing Session, who leaves with it.
CREATE FUNCTION rms_dining.validate_participant_removal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_dining.dining_session s WHERE s.tenant_id=NEW.tenant_id
   AND s.brand_id=NEW.brand_id AND s.store_id=NEW.store_id AND s.session_id=NEW.session_id
   AND s.phase IN ('Active','Closing')) THEN
  RAISE EXCEPTION 'the table is not open' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_participant_removal_validate BEFORE INSERT ON rms_dining.dining_participant_removal
 FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_participant_removal();
CREATE FUNCTION rms_dining.check_participant_removal_left() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_dining.dining_participant p WHERE p.tenant_id=NEW.tenant_id
   AND p.brand_id=NEW.brand_id AND p.store_id=NEW.store_id AND p.session_id=NEW.session_id
   AND p.participant_id=NEW.participant_id AND p.status='Left') THEN
  RAISE EXCEPTION 'a removed participant must have left' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER dining_participant_removal_left AFTER INSERT ON rms_dining.dining_participant_removal
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_dining.check_participant_removal_left();

CREATE FUNCTION rms_dining.reject_qr_join_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only QR join record' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER dining_qr_join_issue_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_qr_join_issue
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_qr_join_mutation();
CREATE TRIGGER dining_qr_join_issue_no_truncate BEFORE TRUNCATE ON rms_dining.dining_qr_join_issue
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_qr_join_mutation();
CREATE TRIGGER dining_qr_join_control_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_qr_join_control
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_qr_join_mutation();
CREATE TRIGGER dining_qr_join_control_no_truncate BEFORE TRUNCATE ON rms_dining.dining_qr_join_control
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_qr_join_mutation();
CREATE TRIGGER dining_participant_removal_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_participant_removal
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_qr_join_mutation();
CREATE TRIGGER dining_participant_removal_no_truncate BEFORE TRUNCATE ON rms_dining.dining_participant_removal
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_qr_join_mutation();

ALTER TABLE rms_dining.dining_qr_join_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_qr_join_issue FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_qr_join_issue_scope ON rms_dining.dining_qr_join_issue
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_dining.dining_qr_join_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_qr_join_control FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_qr_join_control_scope ON rms_dining.dining_qr_join_control
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_dining.dining_participant_removal ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_participant_removal FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_participant_removal_scope ON rms_dining.dining_participant_removal
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_qr_join_issue FROM PUBLIC;
REVOKE ALL ON TABLE rms_dining.dining_qr_join_control FROM PUBLIC;
REVOKE ALL ON TABLE rms_dining.dining_participant_removal FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.validate_qr_join_issue() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.validate_qr_join_control() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.validate_participant_removal() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.check_participant_removal_left() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.reject_qr_join_mutation() FROM PUBLIC;
