-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 M10/M14 (DEC-OWNER-DEFAULTS-2026-11-06 item 2, default recorded in WP-2423): whoever may
-- accept an order may also decline one that is paid and not accepted yet ("Can't make it"): the
-- guest is refunded in full and the kitchen never gets it, in their name with permission
-- ordering.order.accept. A batch a person accepted stays with a manager (ordering.order.cancel); an
-- automatically accepted one keeps its existing rule. The general validator still requires, for a
-- batch never accepted, no acceptance, no payment disposition and exactly the recorded payment
-- wait, so a batch the acceptance deadline (or an outage hold's refund) already closed can never be
-- declined again: one batch is compensated once. History is unchanged.
CREATE OR REPLACE FUNCTION rms_ordering.validate_order_staff_cancellation_cant_make() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NEW.previous_phase='Submitted' THEN
  IF EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=NEW.brand_id
   AND a.store_id=NEW.store_id AND a.order_id=NEW.order_id AND a.order_batch_id=NEW.order_batch_id)
  THEN RAISE EXCEPTION 'only a batch not accepted yet' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.previous_phase<>'Accepted'
  OR NOT EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=NEW.brand_id
   AND a.store_id=NEW.store_id AND a.order_id=NEW.order_id AND a.order_batch_id=NEW.order_batch_id
   AND a.actor_type='System' AND a.reason_code='STORE_AUTO_ACCEPT_PAID')
 THEN RAISE EXCEPTION 'only an automatically accepted batch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_staff_cancellation_cant_make() FROM PUBLIC;
