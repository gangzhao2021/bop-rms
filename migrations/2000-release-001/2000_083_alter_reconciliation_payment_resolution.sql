-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (2026-10-17): a single payment's reconciliation difference (Operational check) is
-- resolved like a business day's (2000_053): when a later check of the same payment finds the
-- Payment records and the Provider agree again (outcome Matched), one append-only resolution row
-- names that check, written with its audit record in the same transaction as the run. A payment
-- whose later check still differs keeps its difference open.
-- A payment can differ again after its difference was resolved (for example a refund made directly
-- at the Provider after the match). That must open a new, visible difference instead of being
-- folded into the resolved one, so a difference's identity is now (candidate, reason, generation):
-- generation counts the earlier resolved differences of the same candidate and reason and is set
-- here, never by the caller. A new difference is refused while an earlier one of the same
-- candidate and reason is still open (the same stable unique constraint name as before).
-- Existing rows are generation 0 and are not changed. No new table or grant (api already has
-- SELECT/INSERT on payment_reconciliation_resolution and payment_reconciliation_exception).
ALTER TABLE rms_payment.payment_reconciliation_exception
 ADD COLUMN generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation < 1000000);
ALTER TABLE rms_payment.payment_reconciliation_exception
 DROP CONSTRAINT payment_reconciliation_exception_stable_unique;
ALTER TABLE rms_payment.payment_reconciliation_exception
 ADD CONSTRAINT payment_reconciliation_exception_stable_unique
 UNIQUE (brand_id, store_id, candidate_id, reason, generation);

CREATE FUNCTION rms_payment.assign_payment_reconciliation_exception_generation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 -- Earlier differences of this candidate and reason that a later matching check resolved; an
 -- open earlier one gives the same generation and the stable unique constraint refuses the row.
 SELECT count(*)::integer INTO NEW.generation
  FROM rms_payment.payment_reconciliation_exception e
  JOIN rms_payment.payment_reconciliation_resolution s
   ON s.brand_id=e.brand_id AND s.store_id=e.store_id
   AND s.reconciliation_exception_id=e.reconciliation_exception_id
  WHERE e.brand_id=NEW.brand_id AND e.store_id=NEW.store_id
   AND e.candidate_id=NEW.candidate_id AND e.reason=NEW.reason;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.assign_payment_reconciliation_exception_generation() FROM PUBLIC;
CREATE TRIGGER payment_reconciliation_exception_generation BEFORE INSERT ON rms_payment.payment_reconciliation_exception
 FOR EACH ROW EXECUTE FUNCTION rms_payment.assign_payment_reconciliation_exception_generation();

-- The resolving check must be a later matching check of the same candidate: a business day's
-- settlement check (DailySettlement) or a single payment's check (Operational).
CREATE OR REPLACE FUNCTION rms_payment.check_payment_reconciliation_resolution() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE matched rms_payment.payment_reconciliation_record%ROWTYPE;
DECLARE opened timestamptz;
BEGIN
 SELECT * INTO matched FROM rms_payment.payment_reconciliation_record
  WHERE reconciliation_check_id=NEW.reconciliation_check_id;
 SELECT opened_at INTO opened FROM rms_payment.payment_reconciliation_exception
  WHERE reconciliation_exception_id=NEW.reconciliation_exception_id
   AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND candidate_id=NEW.candidate_id;
 IF NOT FOUND OR matched.reconciliation_check_id IS NULL
  OR matched.brand_id<>NEW.brand_id OR matched.store_id<>NEW.store_id
  OR matched.candidate_id<>NEW.candidate_id
  OR matched.reconciliation_run_id<>NEW.reconciliation_run_id
  OR matched.mode NOT IN ('DailySettlement','Operational') OR matched.outcome<>'Matched'
  OR matched.checked_at<opened OR NEW.resolved_at<>matched.checked_at THEN
  RAISE EXCEPTION 'reconciliation resolution needs a later matching check of the same candidate' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_payment_reconciliation_resolution() FROM PUBLIC;
