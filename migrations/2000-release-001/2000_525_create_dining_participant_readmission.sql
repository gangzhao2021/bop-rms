-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 shared-table-checkout (b), lost cookie (DEC-DINING-CHECKOUT-SCOPE): Dining's own record
-- that a participant's phone came back on a new Guest Session (Identity's continuity rotation,
-- 2000_523). Written only while the participant is Active in a session still open at its table;
-- from then on the earlier Guest Session is no longer this participant's phone (the guest binding
-- check refuses it), the later one is. Append-only, Store RLS; one row per later session, and a
-- session is replaced at most once.
-- Grants: api SELECT, INSERT (Owner standing approval 2026-10-14 「我都批准，之后不需要问我」;
-- WP-2423 shared-table-checkout).
CREATE TABLE rms_dining.dining_participant_readmission (
 readmission_id platform_helpers.uuid_v7 NOT NULL,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 participant_id platform_helpers.uuid_v7 NOT NULL,
 from_guest_session_id platform_helpers.uuid_v7 NOT NULL,
 to_guest_session_id platform_helpers.uuid_v7 NOT NULL CHECK (to_guest_session_id <> from_guest_session_id),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 PRIMARY KEY (tenant_id,brand_id,store_id,readmission_id),
 CONSTRAINT dining_participant_readmission_id_unique UNIQUE (readmission_id),
 CONSTRAINT dining_participant_readmission_to_once UNIQUE (to_guest_session_id),
 CONSTRAINT dining_participant_readmission_from_once UNIQUE (from_guest_session_id),
 CONSTRAINT dining_participant_readmission_operation_unique UNIQUE (tenant_id,brand_id,store_id,operation_id),
 CONSTRAINT dining_participant_readmission_participant_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id,participant_id)
  REFERENCES rms_dining.dining_participant (tenant_id,brand_id,store_id,session_id,participant_id)
);
CREATE INDEX dining_participant_readmission_participant_idx
 ON rms_dining.dining_participant_readmission (brand_id,store_id,participant_id,occurred_at);

CREATE FUNCTION rms_dining.validate_dining_participant_readmission() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_dining.dining_participant p
   JOIN rms_dining.dining_session s ON s.tenant_id=p.tenant_id AND s.brand_id=p.brand_id
    AND s.store_id=p.store_id AND s.session_id=p.session_id
   WHERE p.tenant_id=NEW.tenant_id AND p.brand_id=NEW.brand_id AND p.store_id=NEW.store_id
    AND p.session_id=NEW.session_id AND p.participant_id=NEW.participant_id
    AND p.status='Active' AND s.phase IN ('Active','Closing')) THEN
  RAISE EXCEPTION 'only a participant still at an open table comes back on a new phone session' USING ERRCODE='23514';
 END IF;
 -- The phone being replaced is the participant's current one: its first session, or the latest
 -- later one; never a session already replaced.
 IF EXISTS (SELECT 1 FROM rms_dining.dining_participant_readmission r
   WHERE r.brand_id=NEW.brand_id AND r.store_id=NEW.store_id AND r.participant_id=NEW.participant_id
    AND r.to_guest_session_id<>NEW.from_guest_session_id
    AND NOT EXISTS (SELECT 1 FROM rms_dining.dining_participant_readmission later
     WHERE later.brand_id=r.brand_id AND later.store_id=r.store_id AND later.from_guest_session_id=r.to_guest_session_id)) THEN
  RAISE EXCEPTION 'only the participant''s current phone session is replaced' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_participant_readmission_validate BEFORE INSERT ON rms_dining.dining_participant_readmission
 FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_dining_participant_readmission();
CREATE FUNCTION rms_dining.reject_dining_participant_readmission_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only participant readmission' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER dining_participant_readmission_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_participant_readmission
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_dining_participant_readmission_mutation();
CREATE TRIGGER dining_participant_readmission_no_truncate BEFORE TRUNCATE ON rms_dining.dining_participant_readmission
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_dining_participant_readmission_mutation();
ALTER TABLE rms_dining.dining_participant_readmission ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_participant_readmission FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_participant_readmission_scope ON rms_dining.dining_participant_readmission
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_participant_readmission FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.validate_dining_participant_readmission() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.reject_dining_participant_readmission_mutation() FROM PUBLIC;
