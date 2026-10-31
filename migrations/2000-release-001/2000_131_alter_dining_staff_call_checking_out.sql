-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- DEC-DINING-STAFF-CALL (coordinator 2026-10-30, Owner-authorized): a table checking out (its
-- session Closing) still calls staff — that is when guests most need someone ("ready to pay",
-- "the bill is wrong", "we'll pay separately"); only a closed table, or a phone removed from it,
-- can't. Checking out never closes an open call. Calls may now say "ReadyToPay".
ALTER TABLE rms_dining.dining_staff_call DROP CONSTRAINT dining_staff_call_reason_check;
ALTER TABLE rms_dining.dining_staff_call ADD CONSTRAINT dining_staff_call_reason_check
 CHECK (reason IN ('Question','TableNeeds','OrderProblem','ReadyToPay'));

CREATE OR REPLACE FUNCTION rms_dining.validate_dining_staff_call_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM rms_dining.dining_session WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id AND phase IN ('Active','Closing'))
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
