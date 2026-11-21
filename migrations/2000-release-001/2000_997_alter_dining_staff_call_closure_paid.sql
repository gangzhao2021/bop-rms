-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 b39 (v15 b38 dinner sweep): a guest's "ready to pay" call closes by itself once the
-- table is paid, so staff no longer see it and need not tap "Handled". The closure is recorded like
-- any other (append-only, never deleted): kind 'Paid', in the transaction of the payment that
-- completed the bill, with that payment's operation as its operation. Who: the staff member who
-- took the payment, or nobody (the System) when the guest paid on their phone. Only a ReadyToPay
-- call closes this way.
ALTER TABLE rms_dining.dining_staff_call_closure DROP CONSTRAINT dining_staff_call_closure_kind_check;
ALTER TABLE rms_dining.dining_staff_call_closure ADD CONSTRAINT dining_staff_call_closure_kind_check
 CHECK (kind IN ('Answered','Withdrawn','Paid'));
ALTER TABLE rms_dining.dining_staff_call_closure DROP CONSTRAINT dining_staff_call_closure_actor;
ALTER TABLE rms_dining.dining_staff_call_closure ADD CONSTRAINT dining_staff_call_closure_actor CHECK (
 (kind='Answered' AND actor_id IS NOT NULL AND participant_id IS NULL)
 OR (kind='Withdrawn' AND actor_id IS NULL AND participant_id IS NOT NULL)
 OR (kind='Paid' AND participant_id IS NULL)
);

CREATE OR REPLACE FUNCTION rms_dining.validate_dining_staff_call_closure_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 call rms_dining.dining_staff_call%ROWTYPE;
BEGIN
 SELECT * INTO call FROM rms_dining.dining_staff_call WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND call_id=NEW.call_id;
 IF NOT FOUND OR call.tenant_id<>NEW.tenant_id OR NEW.closed_at<call.called_at
 OR (NEW.kind='Paid' AND call.reason<>'ReadyToPay')
 OR (NEW.kind='Withdrawn' AND NEW.participant_id IS DISTINCT FROM call.participant_id
  AND NOT EXISTS(SELECT 1 FROM rms_dining.dining_participant WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=call.session_id AND participant_id=NEW.participant_id AND status='Active')) THEN
  RAISE EXCEPTION 'staff call closure source mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_dining.validate_dining_staff_call_closure_insert() FROM PUBLIC;
